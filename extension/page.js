const $ = (id) => document.getElementById(id);
let state;
let version = 0;
let copiedAt = 0;

async function rpc(command) {
  const reply = await chrome.runtime.sendMessage({ command });
  if (!reply?.ok) throw new Error(reply?.error ?? '扩展后台没有响应，请重新打开弹窗。');
  return reply.value;
}

function render(next) {
  state = next;
  const busy = Boolean(state.operation);
  $('account-name').textContent = state.account?.name || (state.webUid ? '已登录 Pixiv' : '未登录 Pixiv');
  $('account-id').textContent = state.account ? `UID ${state.account.id}` : state.webUid ? `UID ${state.webUid}` : '';
  $('access-token').textContent = state.accessToken || '—';
  $('refresh-token').textContent = state.refreshToken || '—';
  $('expires-at').textContent = state.expiresAt ? new Date(state.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  $('login').disabled = busy || !state.webUid;
  $('refresh').disabled = busy || !state.account || state.refreshInvalid;
  for (const button of document.querySelectorAll('.copy')) button.disabled = !state[`${button.dataset.kind}Token`];
  status();
}

function status() {
  if (!state) return;
  const expired = state.expiresAt && Date.now() >= state.expiresAt;
  const labels = { login: '正在获取', refresh: '正在刷新' };
  if (Date.now() - copiedAt < 2500) return;
  $('message').className = state.error ? 'error' : '';
  const message = state.error?.message || labels[state.operation?.kind] || (!state.webUid ? '未登录 Pixiv' : expired ? '访问令牌已过期' : state.account ? '已获取' : '已登录，等待获取');
  $('message').textContent = message;
  $('message').title = message;
}

async function snapshot() {
  const current = ++version;
  try {
    const next = await rpc('display');
    if (version === current) render(next);
  } catch (error) {
    if (version !== current) return;
    copiedAt = 0;
    render({ account: null, webUid: null, accessToken: '', refreshToken: '', operation: null, error: { message: error.message } });
  }
}

async function action(command) {
  copiedAt = 0;
  try {
    // The background owns the operation; closing the popup does not cancel it.
    await rpc(command);
  } catch (error) {
    $('message').textContent = error.message;
    $('message').className = 'error';
    return;
  }
  await snapshot();
}
$('login').addEventListener('click', () => action('login'));
$('refresh').addEventListener('click', () => action('refresh'));
for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const token = state?.[`${button.dataset.kind}Token`];
    if (button.disabled || !token) return;
    try {
      await navigator.clipboard.writeText(token);
      copiedAt = Date.now();
      $('message').className = '';
      $('message').textContent = `${button.dataset.kind}_token 已复制。`;
    } catch {
      copiedAt = Date.now();
      $('message').textContent = '复制失败，请选中文本后手动复制。';
    }
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.auth) { copiedAt = 0; snapshot(); }
});
setInterval(() => { status(); }, 1000);
await snapshot();
if (state?.webUid && !state.account && !state.operation && !state.error) await action('login');
