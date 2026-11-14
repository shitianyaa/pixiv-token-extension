import { createController } from './controller.js';
import { AuthError } from './oauth.js';
import { createSilentAuth, readWebSession } from './web-session.js';

const PAGE_URL = chrome.runtime.getURL('page.html');
const ALARM = 'auth-deadline';
const silent = createSilentAuth({ extensionOrigin: `chrome-extension://${chrome.runtime.id}` });
const controller = createController({
  load: async () => (await chrome.storage.session.get('auth')).auth,
  save: (state) => chrome.storage.session.set({ auth: state }),
  session: () => readWebSession(chrome.cookies),
  authorize: () => silent.authorize(),
  arm: (when) => chrome.alarms.create(ALARM, { when }),
  disarm: () => chrome.alarms.clear(ALARM),
});

function trusted(sender) {
  return sender.id === chrome.runtime.id && sender.url === PAGE_URL;
}

const commands = {
  snapshot: () => controller.snapshot(),
  display: () => controller.display(),
  login: () => controller.startLogin(),
  refresh: () => controller.refresh(),
  cancel: async () => { const state = await controller.cancel(); silent.cancel(); return state; },
  clear: async () => { const state = await controller.clear(); silent.cancel(); return state; },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender) || !message || !Object.hasOwn(commands, message.command)) return false;
  Promise.resolve().then(() => commands[message.command](message)).then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: error instanceof AuthError ? error.message : '操作失败，请重试。' }),
  );
  return true;
});

const callbackFilter = { urls: ['https://app-api.pixiv.net/*', 'https://accounts.pixiv.net/*'], types: ['xmlhttprequest'] };
chrome.webRequest.onBeforeRequest.addListener(silent.beforeRequest, callbackFilter);
chrome.webRequest.onBeforeRedirect.addListener(silent.beforeRedirect, callbackFilter);
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.name === 'PHPSESSID' && /(^|\.)pixiv\.net$/.test(cookie.domain.replace(/^\./, ''))) {
    controller.snapshot().catch(() => {});
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) controller.expire().catch(() => {});
});
