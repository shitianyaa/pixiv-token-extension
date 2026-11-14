import test from 'node:test';
import assert from 'node:assert/strict';
import { createSilentAuth } from '../extension/web-session.js';
import { CALLBACK_URL } from '../extension/oauth.js';

test('final protocol fetch rejection cannot beat correlated HTTPS authorization callback', async () => {
  let api, count = 0;
  const origin = 'chrome-extension://fixture';
  api = createSilentAuth({ extensionOrigin: origin, pkce: async () => ({ verifier: 'test', challenge: 'test' }), fetcher: async (url) => {
    if (++count === 1) return { ok: true, text: async () => '{"tt":"test"}' };
    if (count === 2) return { type: 'opaqueredirect' };
    api.beforeRequest({ url, method: 'POST', initiator: origin, type: 'xmlhttprequest', requestId: 'own' });
    setImmediate(() => api.beforeRequest({ url: `${CALLBACK_URL}?code=test-code`, method: 'GET', initiator: origin, type: 'xmlhttprequest', requestId: 'own' }));
    throw new TypeError('final protocol unsupported');
  } });
  assert.equal((await api.authorize()).code, 'test-code');
});
