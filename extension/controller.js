import { AuthError, normalizeToken, requestToken } from './oauth.js';

const EMPTY = () => ({ token: null, operation: null, error: null, refreshInvalid: false, webSession: null });
const REQUEST_TIMEOUT = 60000;

export function publicState(state, now = Date.now()) {
  return {
    account: state.token?.user ?? null,
    webUid: state.webSession?.uid ?? null,
    issuedAt: state.token?.issuedAt ?? null,
    expiresAt: state.token?.expiresAt ?? null,
    expired: state.token ? now >= state.token.expiresAt : false,
    operation: state.operation ? { kind: state.operation.kind, deadline: state.operation.deadline } : null,
    error: state.error,
    refreshInvalid: state.refreshInvalid,
  };
}

export function createController({ load, save, arm, disarm, session, authorize, exchange = requestToken, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  async function read() {
    let state = (await load()) ?? EMPTY();
    const current = await session();
    if (state.webSession?.fingerprint !== current?.fingerprint || state.webSession?.uid !== current?.uid ||
        (state.token && (!current || state.token.user.id !== current.uid))) {
      state = { ...EMPTY(), webSession: current };
      await save(state);
      await disarm();
    }
    if (state.operation && state.operation.deadline <= now()) {
      state.operation = null;
      state.error = { kind: 'timeout', message: '请求未完成，请重新获取。原凭据未被覆盖。' };
      await save(state);
      await disarm();
    }
    return state;
  }
  const safeError = (error) => ({
    kind: error instanceof AuthError ? error.kind : 'internal',
    message: error instanceof AuthError ? error.message : '操作未完成，请重试。原凭据未被覆盖。',
  });

  async function start(kind) {
    return serialized(async () => {
      const state = await read();
      if (state.operation) throw new AuthError('busy', '已有操作进行中，请先取消或等待完成。');
      if (!state.webSession) throw new AuthError('login', '请先在当前浏览器登录 Pixiv，再点击「重新获取」。');
      if (kind === 'refresh' && (!state.token || state.refreshInvalid)) throw new AuthError('invalid', '没有可用的刷新凭据，请重新获取。');
      state.operation = { id: uuid(), kind, deadline: now() + REQUEST_TIMEOUT };
      state.error = null;
      await save(state);
      await arm(state.operation.deadline);
      return { id: state.operation.id, session: state.webSession, previous: kind === 'refresh' ? state.token : null };
    });
  }

  async function execute(kind) {
    const job = await start(kind);
    let token;
    let error;
    try {
      const payload = kind === 'refresh' ? { grant_type: 'refresh_token', refresh_token: job.previous.refreshToken } : await authorize();
      const stillCurrent = await serialized(async () => (await read()).operation?.id === job.id);
      if (!stillCurrent) return serialized(async () => publicState(await read(), now()));
      token = normalizeToken(await exchange(payload), job.previous, now());
      if (token.user.id !== job.session.uid) throw new AuthError('account', '授权账号与当前网页登录账号不一致，已拒绝显示。请在 Pixiv 网站确认账号后重新获取。');
    } catch (cause) { error = safeError(cause); }
    return serialized(async () => {
      const state = await read();
      // Session changes, clear, cancel and deadlines all invalidate an in-flight response.
      if (state.operation?.id !== job.id) return publicState(state, now());
      if (error) {
        state.error = error;
        if (job.previous && error.kind === 'invalid') state.refreshInvalid = true;
      } else {
        state.token = token;
        state.error = null;
        state.refreshInvalid = false;
      }
      state.operation = null;
      await save(state);
      await disarm();
      return publicState(state, now());
    });
  }

  return {
    snapshot: () => serialized(async () => publicState(await read(), now())),
    display: () => serialized(async () => {
      const state = await read();
      return { ...publicState(state, now()), accessToken: state.token?.accessToken ?? '', refreshToken: state.token?.refreshToken ?? '' };
    }),
    expire: () => serialized(read),
    startLogin: () => execute('login'),
    refresh: () => execute('refresh'),
    cancel: () => serialized(async () => {
      const state = await read();
      state.operation = null;
      state.error = null;
      await save(state);
      await disarm();
      return publicState(state, now());
    }),
    clear: () => serialized(async () => {
      const state = { ...EMPTY(), webSession: await session() };
      await save(state);
      await disarm();
      return publicState(state, now());
    }),
  };
}
