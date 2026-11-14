import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/controller.js';
import { AuthError, normalizeToken } from '../extension/oauth.js';
const raw = (access = 'initial-access', refresh = 'initial-refresh', id = 123) => ({ access_token: access, refresh_token: refresh, expires_in: 3600, user: { id, name: 'Test' } });
const web = { uid: '123', fingerprint: 'test-session-a' };
const initial = () => ({ token: normalizeToken(raw(), null, 1000), operation: null, error: null, refreshInvalid: false, webSession: web });
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture({ state = initial(), exchange = async () => raw('fresh-access', 'fresh-refresh'), authorize = async () => ({ code: 'test-code', code_verifier: 'test-verifier' }) } = {}) {
  let clock = 2000, sequence = 0, stored = structuredClone(state), current = structuredClone(web);
  const controller = createController({ load: async () => structuredClone(stored), save: async (s) => { stored = structuredClone(s); }, arm: async () => {}, disarm: async () => {}, session: async () => current, authorize, exchange, now: () => clock, uuid: () => `op-${++sequence}` });
  return { controller, stored: () => structuredClone(stored), advance: (ms) => { clock += ms; }, changeSession: (s) => { current = s; } };
}
test('snapshot omits credentials but trusted display returns both plaintext tokens', async () => {
  const f = fixture();
  assert.ok(!JSON.stringify(await f.controller.snapshot()).includes('initial-access'));
  assert.equal((await f.controller.display()).accessToken, 'initial-access');
});
test('refresh rotates tokens and preserves account', async () => {
  const f = fixture(); const s = await f.controller.refresh();
  assert.equal(f.stored().token.refreshToken, 'fresh-refresh');
  assert.equal(s.account.id, '123'); assert.equal(s.operation, null); assert.equal(s.error, null);
});
test('network refresh failure preserves tokens and permits retry', async () => {
  const f = fixture({ exchange: async () => { throw new AuthError('network', 'unavailable'); } });
  const before = f.stored().token; const s = await f.controller.refresh();
  assert.deepEqual(f.stored().token, before); assert.equal(s.error.kind, 'network'); assert.equal(s.refreshInvalid, false);
});
test('invalid refresh blocks refresh without deleting tokens', async () => {
  const f = fixture({ exchange: async () => { throw new AuthError('invalid', 'expired'); } });
  assert.equal((await f.controller.refresh()).refreshInvalid, true);
  assert.equal((await f.controller.display()).refreshToken, 'initial-refresh');
  await assert.rejects(f.controller.refresh(), /重新获取/);
});
test('different account is refused during both refresh and web authorization', async () => {
  const f = fixture({ exchange: async () => raw('other', 'other-refresh', 456) });
  assert.equal((await f.controller.refresh()).error.kind, 'account');
  assert.equal((await f.controller.startLogin()).error.kind, 'account');
  assert.equal(f.stored().token.user.id, '123');
});
test('duplicate refresh is refused and clear rejects late response', async () => {
  const pending = deferred(), started = deferred();
  const f = fixture({ exchange: async () => { started.resolve(); return pending.promise; } });
  const job = f.controller.refresh(); await started.promise;
  await assert.rejects(f.controller.refresh(), /已有操作/); await f.controller.clear();
  pending.resolve(raw('late', 'late-refresh')); await job;
  assert.equal(f.stored().token, null); assert.equal(f.stored().operation, null);
});
test('cancel and new authorization make old response obsolete', async () => {
  const pending = deferred(), started = deferred(); let count = 0;
  const f = fixture({ exchange: async () => { if (++count === 1) { started.resolve(); return pending.promise; } return raw('new', 'new-refresh'); } });
  const job = f.controller.refresh(); await started.promise; await f.controller.cancel();
  await f.controller.startLogin(); pending.resolve(raw('late', 'late-refresh')); await job;
  assert.equal(f.stored().token.accessToken, 'new');
});
test('login uses injected silent authorization without tabs', async () => {
  const f = fixture({ exchange: async (p) => { assert.equal(p.code, 'test-code'); assert.equal(p.code_verifier, 'test-verifier'); return raw('silent', 'silent-refresh'); } });
  assert.equal((await f.controller.startLogin()).error, null);
  assert.equal(f.stored().token.accessToken, 'silent');
});
test('logged-out and changed cookie clear credentials before display', async () => {
  const f = fixture(); f.changeSession({ uid: '456', fingerprint: 'new-cookie' });
  const s = await f.controller.display(); assert.equal(s.accessToken, ''); assert.equal(s.webUid, '456');
  f.changeSession(null); assert.equal((await f.controller.display()).refreshToken, '');
  await assert.rejects(f.controller.startLogin(), /先在当前浏览器登录/);
});
test('same UID but rotated session clears old credentials', async () => {
  const f = fixture(); f.changeSession({ uid: '123', fingerprint: 'changed' });
  assert.equal((await f.controller.display()).accessToken, '');
});
test('session change during token request rejects late token', async () => {
  const pending = deferred(), started = deferred();
  const f = fixture({ exchange: async () => { started.resolve(); return pending.promise; } });
  const job = f.controller.refresh(); await started.promise;
  f.changeSession({ uid: '456', fingerprint: 'other' }); pending.resolve(raw('late', 'late-refresh')); await job;
  assert.equal(f.stored().token, null);
});
test('session changes before token exchange do not issue exchange request', async () => {
  const pending = deferred(), started = deferred(); let requests = 0;
  const f = fixture({ authorize: async () => { started.resolve(); return pending.promise; }, exchange: async () => { requests++; return raw(); } });
  const job = f.controller.startLogin(); await started.promise; f.changeSession(null); pending.resolve({ code: 'test-code' }); await job;
  assert.equal(requests, 0); assert.equal(f.stored().token, null);
});
test('late request cannot commit after deadline without alarm', async () => {
  const pending = deferred(), started = deferred();
  const f = fixture({ exchange: async () => { started.resolve(); return pending.promise; } });
  const job = f.controller.refresh(); await started.promise; f.advance(60001);
  pending.resolve(raw('late', 'late-refresh')); await job;
  assert.equal(f.stored().token.accessToken, 'initial-access'); assert.equal(f.stored().error.kind, 'timeout');
});
test('recreated worker can display credentials and expires abandoned operations', async () => {
  const s = initial(); s.operation = { id: 'abandoned', kind: 'login', deadline: 5000 };
  const f = fixture({ state: s }); f.advance(5000);
  assert.equal((await f.controller.display()).accessToken, 'initial-access'); assert.equal(f.stored().operation, null);
});
