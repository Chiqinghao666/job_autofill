const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const scanBtn = document.getElementById('scanBtn');
const pickBtn = document.getElementById('pickBtn');
const connectBtn = document.getElementById('connectBtn');
const resultBox = document.getElementById('resultBox');
const profileForm = document.getElementById('profileForm');
const profileMsg = document.getElementById('profileMsg');
const importSummary = document.getElementById('importSummary');
const hiddenProfileSummary = document.getElementById('hiddenProfileSummary');

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
}

async function message(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应');
  return response;
}

async function api(path, options = {}) {
  return (await message({type: 'JOB_AUTOFILL_API', path, options})).data;
}

function setByPath(obj, path, value) {
  const tokens = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map(m => m[1] ?? Number(m[2]));
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i];
    const next = tokens[i + 1];
    if (cur[current] == null) cur[current] = typeof next === 'number' ? [] : {};
    cur = cur[current];
  }
  cur[tokens.at(-1)] = value;
}

function getByPath(obj, path) {
  let cur = obj;
  for (const token of [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map(m => m[1] ?? Number(m[2]))) {
    if (cur == null) return '';
    cur = cur[token];
  }
  return cur ?? '';
}

function profileCounts(profile) {
  return {
    education: profile.education?.length || 0, internships: profile.internships?.length || 0,
    activities: profile.student_activities?.length || 0, awards: profile.awards?.length || 0,
    family: profile.family?.members?.length || 0,
  };
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    statusDot.className = 'dot ok';
    statusText.textContent = `本地服务已配对${status.profile_name ? ` · 档案 ${status.profile_name}` : ''}`;
    connectBtn.hidden = true;
    scanBtn.disabled = false;
    pickBtn.disabled = false;
    await loadProfile();
  } catch (_) {
    statusDot.className = 'dot bad';
    statusText.textContent = '请先连接本机服务并在打开的页面确认配对';
    connectBtn.hidden = false;
    scanBtn.disabled = true;
    pickBtn.disabled = true;
  }
}

async function loadProfile() {
  const profile = (await api('/api/profile')).profile || {};
  for (const input of profileForm.querySelectorAll('[name]')) {
    const value = getByPath(profile, input.name);
    input.value = Array.isArray(value) ? value.join(', ') : value;
  }
  const count = profileCounts(profile);
  importSummary.innerHTML = `<strong>${getByPath(profile, 'basic.name_cn') || '未命名档案'}</strong><br>已保存 ${count.education} 条教育、${count.internships} 条实习、${count.awards} 条荣誉。`;
  hiddenProfileSummary.textContent = `另有 ${count.activities} 条社团经历和 ${count.family} 位家庭成员；完整资料和字段映射可在右侧面板管理。`;
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  statusText.textContent = '请在自动打开的本机页面点击“允许此扩展”…';
  try { await message({type: 'JOB_AUTOFILL_CONNECT'}); await refreshStatus(); }
  catch (error) { statusText.textContent = `连接失败：${error.message}`; }
  finally { connectBtn.disabled = false; }
});

profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  profileMsg.textContent = '保存中…';
  try {
    const profile = (await api('/api/profile')).profile || {};
    for (const input of profileForm.querySelectorAll('[name]')) {
      let value = input.value.trim();
      if (['job_preferences.cities', 'job_preferences.job_types'].includes(input.name)) value = value ? value.split(/[,，]/).map(x => x.trim()).filter(Boolean) : [];
      if (input.name === 'personality.words') value = value ? value.split(/[,，、\s]+/).filter(Boolean) : [];
      setByPath(profile, input.name, value);
    }
    await api('/api/profile', {method: 'PUT', body: JSON.stringify({profile})});
    profileMsg.textContent = '已安全保存到本机。';
    await loadProfile();
  } catch (error) { profileMsg.textContent = `保存失败：${error.message}`; }
});

pickBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    await message({type: 'JOB_AUTOFILL_OPEN_PANEL', tabId: tab.id});
    window.close();
  } catch (error) { resultBox.textContent = `打开右侧面板失败：${error.message}`; }
});

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  resultBox.textContent = '正在扫描当前页及其内嵌表单…';
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const results = (await message({type: 'JOB_AUTOFILL_RUN_TAB', tabId: tab.id})).results;
    const stats = results.reduce((total, item) => ({
      total: total.total + (item.stats?.total || 0), filled: total.filled + (item.stats?.filled || 0),
      pending: total.pending + (item.stats?.pending || 0),
    }), {total: 0, filled: 0, pending: 0});
    resultBox.textContent = `检测 ${stats.total} 个字段，已填写 ${stats.filled} 个；${stats.pending} 个新映射待在右侧面板确认。`;
  } catch (error) { resultBox.textContent = `填写失败：${error.message}`; }
  finally { scanBtn.disabled = false; }
});

refreshStatus();
