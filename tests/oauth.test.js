import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, CALLBACK_URL, createPkce, extractCallbackCode, loginUrl, normalizeToken, requestToken } from '../extension/oauth.js';

const response = (overrides = {}) => ({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, user: { id: 123, name: 'Test', account: 'test' }, ...overrides });

test('PKCE uses a fresh RFC7636 S256 challenge', async () => {
  const a = await createPkce();
  const b = await createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.verifier))).toString('base64url');
  assert.equal(a.challenge, expected);
  const url = new URL(loginUrl(a.challenge));
  assert.equal(url.searchParams.get('code_challenge'), expected);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('callback parser allows exact HTTPS callback and exact Pixiv deep link only', () => {
  assert.equal(extractCallbackCode(`${CALLBACK_URL}?state=s&code=abc`), 'abc');
  assert.equal(extractCallbackCode('pixiv://account/login?code=abc'), 'abc');
  for (const raw of [
    'https://evil.test/callback?code=abc',
    'https://app-api.pixiv.net.evil.test/web/v1/users/auth/pixiv/callback?code=abc',
    'http://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?code=abc',
    `${CALLBACK_URL}/extra?code=abc`,
    `${CALLBACK_URL}?code=a&code=b`,
    `${CALLBACK_URL}?code=`,
    `${CALLBACK_URL}?code=a%20b`,
    'pixiv://other/login?code=a',
    'not-a-url',
  ]) assert.equal(extractCallbackCode(raw), null);
});

test('normalize computes expiry and accepts legacy response wrapper', () => {
  const token = normalizeToken({ response: response() }, null, 1000);
  assert.equal(token.expiresAt, 3601000);
  assert.deepEqual(token.user, { id: '123', name: 'Test', account: 'test' });
});

test('refresh keeps missing refresh token and user; rotates when supplied', () => {
  const previous = normalizeToken(response(), null, 0);
  const next = normalizeToken({ access_token: 'new-access', expires_in: 1200 }, previous, 5000);
  assert.equal(next.refreshToken, 'test-refresh');
  assert.deepEqual(next.user, previous.user);
  assert.equal(next.expiresAt, 1205000);
  assert.equal(normalizeToken(response({ refresh_token: 'rotated' }), previous).refreshToken, 'rotated');
});

test('reject incomplete tokens, invalid expiry and different refresh account', () => {
  const previous = normalizeToken(response());
  for (const raw of [response({ access_token: '' }), response({ refresh_token: '' }), response({ expires_in: 0 }), response({ expires_in: Infinity }), response({ user: {} })]) {
    assert.throws(() => normalizeToken(raw), AuthError);
  }
  assert.throws(() => normalizeToken(response({ user: { id: 456 } }), previous), /不同账号/);
});

test('token exchange has no cookies, follows no redirect and returns no raw error', async () => {
  let options;
  const raw = response();
  const result = await requestToken({ grant_type: 'refresh_token', refresh_token: 'test-only' }, async (url, request) => {
    assert.equal(url, 'https://oauth.secure.pixiv.net/auth/token');
    options = request;
    return { ok: true, json: async () => raw };
  });
  assert.equal(result, raw);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.body.get('refresh_token'), 'test-only');
  const marker = 'DO_NOT_LEAK_SECRET';
  await assert.rejects(requestToken({}, async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', detail: marker }) })), (error) => error.kind === 'invalid' && !error.message.includes(marker));
  await assert.rejects(requestToken({}, async () => { throw new TypeError(marker); }), (error) => error.kind === 'network' && !error.message.includes(marker));
  await assert.rejects(requestToken({}, async () => ({ ok: false, status: 503, json: async () => ({}) })), /HTTP 503/);
});
