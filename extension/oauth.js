export const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
export const CALLBACK_URL = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
export const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token';
// Pixiv's mobile client identifiers are public compatibility values, not user credentials.
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';

export class AuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function createPkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function loginUrl(challenge) {
  const url = new URL(LOGIN_URL);
  url.search = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', client: 'pixiv-android' });
  return url.href;
}

export function extractCallbackCode(raw) {
  try {
    const url = new URL(raw);
    const trusted = url.origin === new URL(CALLBACK_URL).origin && url.pathname === new URL(CALLBACK_URL).pathname;
    const deepLink = url.protocol === 'pixiv:' && url.hostname === 'account' && url.pathname === '/login';
    if (!trusted && !deepLink) return null;
    const codes = url.searchParams.getAll('code');
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096 || /\s/.test(codes[0])) return null;
    return codes[0];
  } catch {
    return null;
  }
}

export function normalizeToken(raw, previous = null, now = Date.now()) {
  const body = raw?.response ?? raw;
  const access = body?.access_token;
  const refresh = body?.refresh_token ?? previous?.refreshToken;
  const expiresIn = Number(body?.expires_in);
  const id = body?.user?.id ?? previous?.user.id;
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh ||
      !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31536000 ||
      id === undefined || !/^\d+$/.test(String(id))) {
    throw new AuthError('response', 'Pixiv 返回的凭据不完整；原凭据未被覆盖，请重新授权。');
  }
  if (previous && String(id) !== previous.user.id) {
    throw new AuthError('account', '刷新返回了不同账号，已拒绝覆盖。请重新授权。');
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    issuedAt: now,
    expiresAt: now + expiresIn * 1000,
    user: {
      id: String(id),
      name: typeof body.user?.name === 'string' ? body.user.name : previous?.user.name ?? '',
      account: typeof body.user?.account === 'string' ? body.user.account : previous?.user.account ?? '',
    },
  };
}

export async function requestToken(payload, fetcher = fetch) {
  let response;
  let body;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'App-OS': 'ios', 'App-OS-Version': '14.6' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, include_policy: 'true', ...payload }),
      signal: AbortSignal.timeout(25000),
    });
    body = await response.json();
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AuthError('network', '令牌请求超时。请检查浏览器代理后重试；原凭据未被覆盖。');
    }
    throw new AuthError('network', '令牌请求失败或响应无法解析。请检查网络后重试；原凭据未被覆盖。');
  }
  // Never expose the raw OAuth response: error bodies can contain credentials.
  const invalidGrant = body?.error === 'invalid_grant' || body?.errors?.system?.code === 1508;
  if (!response.ok || body?.error || body?.errors) {
    if (invalidGrant) throw new AuthError('invalid', '授权码或刷新凭据已失效，请重新授权。');
    throw new AuthError('server', `Pixiv 拒绝了令牌请求（HTTP ${response.status}）。可重试或重新授权。`);
  }
  return body;
}
