const status = document.getElementById('status');
const reviewBox = document.getElementById('review');
const profileBox = document.getElementById('profile');
const search = document.getElementById('search');
let profileItems = [];
let review = null;

async function message(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应');
  return response;
}
async function api(path, options = {}) { return (await message({type: 'JOB_AUTOFILL_API', path, options})).data; }
function getByPath(data, path) {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((value, part) => value?.[part], data);
}
function flatten(value, prefix = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, `${prefix}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key));
  return value == null || value === '' ? [] : [{key: prefix, value: String(value)}];
}
function labelForKey(key) { return key.replace(/\[\d+\]/g, '').split('.').at(-1); }

function renderProfile() {
  const q = search.value.trim().toLowerCase();
  profileBox.innerHTML = '';
  for (const item of profileItems.filter(item => !q || `${item.key} ${item.value}`.toLowerCase().includes(q))) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<strong>${labelForKey(item.key)}</strong><small>${item.key}</small><div>${item.value}</div>`;
    const fill = document.createElement('button'); fill.textContent = '填入当前字段';
    fill.addEventListener('click', async () => {
      try { await message({type: 'JOB_AUTOFILL_MANUAL_VALUE', value: item.value}); status.textContent = `已尝试填入：${labelForKey(item.key)}`; }
      catch (error) { status.textContent = `填写失败：${error.message}`; }
    });
    row.append(fill); profileBox.append(row);
  }
  if (!profileBox.children.length) profileBox.textContent = '没有匹配的本地资料。';
}

function renderReview() {
  reviewBox.innerHTML = '';
  if (!review?.pending?.length) return;
  const card = document.createElement('section'); card.className = 'card';
  card.innerHTML = '<strong>确认新字段映射</strong><p class="hint">确认后仅在当前网站的相同表单自动复用；不确定可选择“始终忽略”。</p>';
  const selections = [];
  for (const {field, match} of review.pending) {
    const row = document.createElement('div'); row.className = 'row';
    const candidates = profileItems.filter(item => item.key === match.profile_key || item.key.startsWith('basic.') || item.key.startsWith('education[0]')).slice(0, 40);
    const select = document.createElement('select');
    select.innerHTML = `<option value="">本次跳过</option><option value="__ignore__">始终忽略</option>${candidates.map(item => `<option value="${item.key}" ${item.key === match.profile_key ? 'selected' : ''}>${item.key}：${item.value}</option>`).join('')}`;
    row.innerHTML = `<strong>${field.label || field.name || '未命名字段'}</strong><small>${match.reason || '本地规则建议'} · ${Math.round((match.confidence || 0) * 100)}%</small>`;
    row.append(select); card.append(row); selections.push({field, select});
  }
  const confirm = document.createElement('button'); confirm.className = 'primary'; confirm.textContent = '保存确认并填写';
  confirm.addEventListener('click', async () => {
    const mappings = selections.map(({field, select}) => ({field_fingerprint: field.fingerprint, profile_key: select.value, ignored: select.value === '__ignore__'})).filter(item => item.profile_key);
    try { await message({type: 'JOB_AUTOFILL_CONFIRM_REVIEW', mappings}); review = null; renderReview(); status.textContent = '映射已保存，网页将重新填写。'; }
    catch (error) { status.textContent = `保存失败：${error.message}`; }
  });
  card.append(confirm); reviewBox.append(card);
}

async function refresh() {
  try {
    const data = await api('/api/profile');
    profileItems = flatten(data.profile);
    status.textContent = '本机服务已连接';
    review = (await message({type: 'JOB_AUTOFILL_GET_REVIEW'})).review;
    renderProfile(); renderReview();
  } catch (error) { status.textContent = `请先从插件弹窗完成配对：${error.message}`; }
}

document.getElementById('refresh').addEventListener('click', refresh);
search.addEventListener('input', renderProfile);
document.getElementById('clearDomain').addEventListener('click', async () => {
  if (!review?.pageUrl) return status.textContent = '当前没有待确认的网站映射。';
  try { await api(`/api/mappings?page_url=${encodeURIComponent(review.pageUrl)}`, {method: 'DELETE'}); status.textContent = '已清空当前网站映射。'; }
  catch (error) { status.textContent = `清空失败：${error.message}`; }
});
refresh();
