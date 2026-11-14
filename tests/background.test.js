import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const listeners = {};
const event = (name) => ({ addListener(fn, filter) { listeners[name] = { fn, filter }; } });
const id = 'test-extension-id';
const pageUrl = `chrome-extension://${id}/page.html`;
const auth = {
  token: { accessToken: 'private-test-access', refreshToken: 'private-test-refresh', user: { id: '123', name: 'Test', account: 'test' }, issuedAt: 1000, expiresAt: Date.now() + 3600000 },
  operation: null, error: null, refreshInvalid: false,
  webSession: null,
};
globalThis.chrome = {
  runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}`, onMessage: event('message') },
  storage: { session: { get: async () => ({ auth: structuredClone(auth) }), set: async () => {} } },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
  cookies: { get: async () => null, onChanged: event('cookie') },
  webRequest: { onBeforeRequest: event('request'), onBeforeRedirect: event('redirect') },
  action: { onClicked: event('action') },
};
await import('../extension/background.js');

test('only this extension operation page may ask for credentials', () => {
  for (const sender of [
    { id, url: 'https://www.pixiv.net/' },
    { id: 'another-extension', url: pageUrl },
    { id, url: `${pageUrl}?untrusted` },
    {},
  ]) {
    let answered = false;
    assert.equal(listeners.message.fn({ command: 'display' }, sender, () => { answered = true; }), false);
    assert.equal(answered, false);
  }
});

test('unknown and prototype command names are rejected', () => {
  for (const message of [{ command: 'constructor' }, { command: '__proto__' }, { command: 'missing' }, null]) {
    assert.equal(listeners.message.fn(message, { id, url: pageUrl }, () => {}), false);
  }
});

test('trusted snapshot omits secrets; logged-out display clears credentials', async () => {
  const invoke = (message) => new Promise((resolve) => {
    assert.equal(listeners.message.fn(message, { id, url: pageUrl }, resolve), true);
  });
  const state = await invoke({ command: 'snapshot' });
  assert.equal(state.ok, true);
  assert.ok(!JSON.stringify(state).includes('private-test'));
  assert.equal((await invoke({ command: 'display' })).value.accessToken, '');
});

test('MV3 listeners are installed at startup and limited to authentication background requests', () => {
  assert.deepEqual(listeners.request.filter, {
    urls: ['https://app-api.pixiv.net/*', 'https://accounts.pixiv.net/*'], types: ['xmlhttprequest'],
  });
  assert.deepEqual(listeners.redirect.filter, listeners.request.filter);
  assert.ok(listeners.alarm && listeners.cookie);
  assert.equal(listeners.action, undefined);
});

test('manifest uses a popup and limited cookie permissions without content scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'webRequest', 'alarms', 'cookies']);
  assert.equal(manifest.action.default_popup, 'page.html');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.ok(manifest.host_permissions.every((host) => host.startsWith('https://') && !host.includes('<all_urls>')));
});
