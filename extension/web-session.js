import { AuthError, createPkce, extractCallbackCode, loginUrl, CALLBACK_URL } from './oauth.js';

const START_URL = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/start';
const SELECT_URL = 'https://accounts.pixiv.net/account-selected';

export async function readWebSession(cookies) {
  const cookie = await cookies.get({ url: 'https://www.pixiv.net/', name: 'PHPSESSID' });
  const uid = cookie?.value?.match(/^(\d+)_/)?.[1];
  if (!uid) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cookie.value));
  return { uid, fingerprint: Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('') };
}

export function extractTt(html) {
  const match = html.match(/(?:pixivAccount\.tt|"tt")\s*["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/);
  if (!match || match[1].length > 1024) throw new AuthError('login', '网页登录已失效或 Pixiv 需要验证。请在网站确认登录后点击「重新获取」。');
  return match[1];
}

// Bind the callback to this extension's exact PKCE start request, never to arbitrary Pixiv traffic.
export function createSilentAuth({ extensionOrigin, fetcher = fetch, pkce = createPkce, timeout = 25000 }) {
  let pending = null;
  function beforeRequest(details) {
    if (!pending || details.initiator !== extensionOrigin || details.type !== 'xmlhttprequest') return;
    if (details.method === 'POST' && details.url === pending.url && pending.requestId === null) pending.requestId = details.requestId;
    if (details.requestId === pending.requestId) {
      const code = extractCallbackCode(details.url);
      if (code) pending.resolve(code);
    }
  }
  function beforeRedirect(details) {
    if (!pending || details.requestId !== pending.requestId) return;
    const code = extractCallbackCode(details.redirectUrl);
    if (code) pending.resolve(code);
  }
  async function authorize() {
    if (pending) throw new AuthError('busy', '已有获取请求进行中，请稍候。');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    let current;
    try {
      const { verifier, challenge } = await pkce();
      const options = { credentials: 'include', cache: 'no-store', signal: abort.signal };
      const login = await fetcher(loginUrl(challenge), options);
      if (!login.ok) throw new AuthError('login', '无法读取 Pixiv 登录会话，请检查网络和网站登录状态。');
      const tt = extractTt(await login.text());
      const start = new URL(START_URL);
      start.search = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', client: 'pixiv-android', via: 'login' });
      const selected = await fetcher(SELECT_URL, {
        ...options, method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ return_to: start.href, tt }),
      });
      if (selected.type !== 'opaqueredirect' && !selected.ok) throw new AuthError('login', 'Pixiv 不接受当前网页登录会话。请在网站完成登录或验证后重试。');
      const codePromise = new Promise((resolve, reject) => {
        current = { url: start.href, requestId: null, resolve, reject };
        pending = current;
      });
      const onAbort = () => current.reject(new AuthError('timeout', '后台获取超时。请检查浏览器代理和 Pixiv 登录状态后重试。'));
      abort.signal.addEventListener('abort', onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
      fetcher(start.href, { ...options, method: 'POST', redirect: 'follow' }).then(
        () => {},
        // The final pixiv:// navigation makes fetch reject even after authorization succeeds.
        // Wait for the correlated webRequest event or the bounded timeout instead.
        () => {},
      );
      const code = await codePromise;
      return { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK_URL };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('network', '无法获取网页登录授权，请检查网络后重试。');
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (pending === current) pending = null;
    }
  }
  return { authorize, beforeRequest, beforeRedirect, cancel() { pending?.reject(new AuthError('cancelled', '获取已取消。')); } };
}
