import test from 'node:test';
import assert from 'node:assert/strict';
import { createSilentAuth, extractTt, readWebSession } from '../extension/web-session.js';
import { CALLBACK_URL } from '../extension/oauth.js';

test('session fingerprint does not store raw cookie and rejects logged-out cookie', async () => {
  const session = await readWebSession({ get: async () => ({ value: '123_test-secret-cookie' }) });
  assert.equal(session.uid, '123'); assert.match(session.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(session).includes('secret-cookie'));
  assert.equal(await readWebSession({ get: async () => null }), null);
});
test('tt parsing supports actual serialized format and rejects missing field', () => {
  assert.equal(extractTt('{"pixivAccount.tt":"test_tt-1"}'), 'test_tt-1');
  assert.equal(extractTt('{"tt":"test-token"}'), 'test-token');
  assert.throws(() => extractTt('login form'), /网页登录已失效/);
});
test('silent auth follows exact own request, ignores foreign traffic and uses existing cookies', async () => {
  const origin = 'chrome-extension://test'; let api, count = 0;
  api = createSilentAuth({ extensionOrigin: origin, pkce: async () => ({ verifier: 'test-verifier', challenge: 'test-challenge' }), fetcher: async (url, options) => {
    count++; assert.equal(options.credentials, 'include');
    if (count === 1) return { ok: true, text: async () => '{"pixivAccount.tt":"test-tt"}' };
    if (count === 2) { assert.equal(options.body.get('tt'), 'test-tt'); return { type: 'opaqueredirect' }; }
    assert.equal(options.redirect, 'follow');
    const details = { url, requestId: 'own', method: 'POST', type: 'xmlhttprequest', initiator: origin };
    api.beforeRequest({ ...details, initiator: 'https://www.pixiv.net' });
    api.beforeRedirect({ requestId: 'foreign', redirectUrl: `${CALLBACK_URL}?code=foreign` });
    api.beforeRequest(details);
    api.beforeRedirect({ requestId: 'foreign', redirectUrl: `${CALLBACK_URL}?code=foreign` });
    api.beforeRedirect({ requestId: 'own', redirectUrl: 'https://evil.test/?code=evil' });
    api.beforeRedirect({ requestId: 'own', redirectUrl: `${CALLBACK_URL}?code=correct` });
    return { type: 'opaqueredirect' };
  } });
  const result = await api.authorize();
  assert.equal(result.code, 'correct'); assert.equal(result.code_verifier, 'test-verifier'); assert.equal(count, 3);
});
test('silent auth times out safely if callback is unavailable', async () => {
  let count = 0;
  const api = createSilentAuth({ extensionOrigin: 'chrome-extension://test', timeout: 10, pkce: async () => ({ verifier: 'v', challenge: 'c' }), fetcher: async () => ++count === 1 ? { ok: true, text: async () => '{"tt":"test"}' } : { type: 'opaqueredirect' } });
  await assert.rejects(api.authorize(), (error) => error.kind === 'timeout');
});
