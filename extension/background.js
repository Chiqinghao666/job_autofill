import { LOCAL_API, buildApiRequest } from './protocol.js';

const TOKEN_KEY = 'jobAutofillAccessToken';
const REVIEW_KEY = 'jobAutofillPendingReview';
const TARGET_KEY = 'jobAutofillManualTarget';

function extensionOrigin() {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

async function token() {
  return (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY] || '';
}

async function request(path, options = {}, allowPairing = true) {
  const currentToken = await token();
  const config = buildApiRequest(path, options, currentToken);
  let response = await fetch(`${LOCAL_API}${path}`, config);
  if (response.status === 401 && allowPairing) {
    await chrome.storage.local.remove(TOKEN_KEY);
    await pair();
    response = await fetch(`${LOCAL_API}${path}`, buildApiRequest(path, options, await token()));
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {detail: text}; }
  if (!response.ok) throw new Error(body.detail || `本地服务返回 ${response.status}`);
  return body;
}

async function pair() {
  const existing = await token();
  if (existing) return existing;
  const response = await fetch(`${LOCAL_API}/api/pairing/request`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({extension_origin: extensionOrigin()}),
  });
  const pending = await response.json();
  if (!response.ok) throw new Error(pending.detail || '无法发起本地配对');
  await chrome.tabs.create({url: pending.confirm_url, active: true});
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 700));
    const claim = await fetch(`${LOCAL_API}/api/pairing/claim`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({pairing_code: pending.pairing_code, extension_origin: extensionOrigin()}),
    });
    if (claim.status === 409) continue;
    const body = await claim.json();
    if (!claim.ok) throw new Error(body.detail || '本地配对失败');
    await chrome.storage.local.set({[TOKEN_KEY]: body.access_token});
    return body.access_token;
  }
  throw new Error('等待本机配对确认超时');
}

async function sendToFrame(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, frameId === 0 ? undefined : {frameId});
}

async function runAcrossFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({tabId});
  const results = await Promise.all(frames.map(async frame => {
    try { return await sendToFrame(tabId, frame.frameId, {type: 'JOB_AUTOFILL_RUN'}); }
    catch (_) { return null; }
  }));
  return results.filter(Boolean);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'JOB_AUTOFILL_API') {
      sendResponse({ok: true, data: await request(message.path, message.options || {})});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_CONNECT') {
      await chrome.storage.local.remove(TOKEN_KEY);
      await pair();
      sendResponse({ok: true, data: await request('/api/status', {}, false)});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_RUN_TAB') {
      sendResponse({ok: true, results: await runAcrossFrames(message.tabId)});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_OPEN_PANEL') {
      await chrome.sidePanel.open({tabId: message.tabId});
      sendResponse({ok: true});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_REVIEW') {
      const key = `${sender.tab?.id}:${sender.frameId || 0}`;
      await chrome.storage.session.set({[REVIEW_KEY]: {...message.review, tabId: sender.tab?.id, frameId: sender.frameId || 0, key}});
      if (sender.tab?.id) await chrome.sidePanel.open({tabId: sender.tab.id});
      sendResponse({ok: true});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_GET_REVIEW') {
      sendResponse({ok: true, review: (await chrome.storage.session.get(REVIEW_KEY))[REVIEW_KEY] || null});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_CONFIRM_REVIEW') {
      const review = (await chrome.storage.session.get(REVIEW_KEY))[REVIEW_KEY];
      if (!review) throw new Error('没有待确认字段');
      await request('/api/mappings/confirm', {method: 'POST', body: JSON.stringify({
        page_url: review.pageUrl, form_signature: review.formSignature, mappings: message.mappings,
      })});
      await sendToFrame(review.tabId, review.frameId, {type: 'JOB_AUTOFILL_APPLY_CONFIRMED'});
      await chrome.storage.session.remove(REVIEW_KEY);
      sendResponse({ok: true});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_TARGET_CHANGED') {
      await chrome.storage.session.set({[TARGET_KEY]: {tabId: sender.tab?.id, frameId: sender.frameId || 0}});
      sendResponse({ok: true});
      return;
    }
    if (message?.type === 'JOB_AUTOFILL_MANUAL_VALUE') {
      const target = (await chrome.storage.session.get(TARGET_KEY))[TARGET_KEY];
      if (!target?.tabId) throw new Error('请先点击网页上的目标字段');
      await sendToFrame(target.tabId, target.frameId, {type: 'JOB_AUTOFILL_MANUAL_VALUE', value: message.value});
      sendResponse({ok: true});
      return;
    }
    throw new Error('未知扩展消息');
  })().catch(error => sendResponse({ok: false, error: error.message || String(error)}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.get([REVIEW_KEY, TARGET_KEY]).then(state => {
  const removals = Object.entries(state).filter(([, value]) => value?.tabId === tabId).map(([key]) => key);
  if (removals.length) return chrome.storage.session.remove(removals);
}));
