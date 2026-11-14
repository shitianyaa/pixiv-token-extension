import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/page.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/page.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../extension/page.css', import.meta.url), 'utf8');
const example = () => ({ webUid: '123', account: { id: '123', name: 'Test' }, accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, operation: null, error: null, refreshInvalid: false });
async function fixture(initial) {
  let current = initial;
  let copied;
  let readError;
  let storageListener;
  const commands = [];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, dataset: {}, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(id);
  };
  const copies = ['access', 'refresh'].map((kind) => Object.assign(element(`copy-${kind}`), { dataset: { kind } }));
  const context = {
    document: { getElementById: element, querySelectorAll: () => copies },
    chrome: {
      runtime: { sendMessage: async ({ command }) => { commands.push(command); if (readError && command === 'display') return { ok: false, error: readError }; if (command === 'login') current = example(); return { ok: true, value: current }; } },
      storage: { onChanged: { addListener: (fn) => { storageListener = fn; } } },
    },
    navigator: { clipboard: { writeText: async (text) => { copied = text; } } },
    Date, setInterval: () => {},
  };
  await vm.runInNewContext(`(async () => { ${source} })()`, context);
  const refresh = async () => { storageListener({ auth: {} }, 'session'); await new Promise((r) => setImmediate(r)); };
  return { element, copies, commands, copied: () => copied, change: async (s) => { current = s; await refresh(); }, failRead: async (message) => { readError = message; await refresh(); } };
}

test('popup has plain selectable token text and only two action buttons', () => {
  assert.doesNotMatch(html, /<(input|textarea|footer)\b/);
  assert.doesNotMatch(html, /id="(clear|cancel|status)"/);
  assert.equal((html.match(/class="copy"/g) ?? []).length, 2);
  assert.match(html, /id="login"[^>]*>重新获取/);
  assert.match(html, /id="refresh"[^>]*>刷新</);
  assert.match(css, /user-select:text/);
  assert.match(css, /overflow-wrap:anywhere/);
});
test('popup renders plaintext and copies exact token without editable controls', async () => {
  const f = await fixture(example());
  assert.equal(f.element('access-token').textContent, 'test-access');
  assert.equal(f.element('refresh-token').textContent, 'test-refresh');
  assert.equal(f.element('message').textContent, '已获取');
  await f.copies[1].listeners.click();
  assert.equal(f.copied(), 'test-refresh');
  assert.equal(f.element('message').textContent, 'refresh_token 已复制。');
});
test('failed session read removes old credentials and blocks copy and refresh', async () => {
  const f = await fixture(example());
  await f.failRead('会话读取失败');
  assert.equal(f.element('access-token').textContent, '—');
  assert.equal(f.element('refresh-token').textContent, '—');
  assert.equal(f.element('expires-at').textContent, '—');
  assert.equal(f.element('login').disabled, true);
  assert.equal(f.element('refresh').disabled, true);
  for (const button of f.copies) {
    assert.equal(button.disabled, true);
    await button.listeners.click();
  }
  assert.equal(f.copied(), undefined);
  assert.equal(f.element('message').textContent, '会话读取失败');
  // The handler also refuses an absent token even if the disabled flag is cleared.
  f.copies[1].disabled = false;
  await f.copies[1].listeners.click();
  assert.equal(f.copied(), undefined);
});

test('opening popup without tokens obtains current logged-in account automatically', async () => {
  const f = await fixture({ ...example(), account: null, accessToken: '', refreshToken: '' });
  assert.deepEqual(f.commands, ['display', 'login', 'display']);
  assert.equal(f.element('access-token').textContent, 'test-access');
});
test('logged-out popup never authorizes and removes plaintext after account change', async () => {
  const f = await fixture(example());
  await f.change({ webUid: null, account: null, accessToken: '', refreshToken: '', operation: null });
  assert.equal(f.element('access-token').textContent, '—');
  assert.equal(f.element('refresh-token').textContent, '—');
  assert.equal(f.element('login').disabled, true);
  assert.equal(f.copies[0].disabled, true);
  assert.equal(f.element('message').textContent, '未登录 Pixiv');
  const loggedOut = await fixture({ webUid: null, account: null, operation: null });
  assert.deepEqual(loggedOut.commands, ['display']);
});
