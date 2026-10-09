// Relay extension for the habitual browser (#93). The person shares a tab with the toolbar button; Relay
// sees and controls only shared tabs and those it opened. Its only input is the native messaging host
// (bridge/src/remote/browserHost.ts), the local adapter to the Puente: no externally_connectable, no
// content scripts, no messages from pages. It never closes a tab: releasing only detaches the debugger.
// A shared tab's finished download is reported by its path, where the browser saved it, for the
// Puente's files transfer (#87); no other download of the browser is.
import { EXTENSION_PROTOCOL, Failure, LIMITS, httpUrl, limitationOf, perform, validateAction } from './actions.js';

const HOST = 'com.relay.browser';
const RETRY_MAX_MS = 30000;

/** tabId -> { createdByRelay, limitation }. In chrome.storage.session: survives the worker, not the browser. */
const shared = new Map();
/** tabId -> { type, message } of the open JavaScript dialog. */
const dialogs = new Map();
/** tabId -> { multiple, backendNodeId } of the file chooser Relay's own tap opened. */
const choosers = new Map();
/** tabId -> Set of resolvers of Relay's input in flight: the input that opens a JavaScript dialog is answered when it opens. */
const inputs = new Map();
/** Finished downloads of shared tabs the Puente has not asked for yet: { name, path }. */
const downloads = [];
const attached = new Set();
let port = null;
let retryMs = 1000;
let retryTimer = null;

const loaded = chrome.storage.session.get('shared').then(({ shared: saved }) => {
  for (const [tabId, info] of Object.entries(saved ?? {})) shared.set(Number(tabId), info);
});

function save() {
  return chrome.storage.session.set({ shared: Object.fromEntries(shared) });
}

async function badge(tabId, on) {
  await chrome.action.setBadgeText({ tabId, text: on ? 'R' : '' }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: on ? 'Compartida con Relay. Pulsa para dejar de compartirla.' : 'Compartir esta pestaña con Relay' }).catch(() => {});
}

function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    // Without the Puente nobody controls anything: let every tab go, keep the person's choice.
    void releaseAll();
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  });
  port.postMessage({ type: 'hello', extensionProtocol: EXTENSION_PROTOCOL });
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  // Page events carry the JavaScript dialogs. The file chooser is intercepted only around Relay's own
  // tap (handle, `act`): intercepting it while attached would take it from the person at the computer (#78).
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
}

async function release(tabId) {
  if (!attached.delete(tabId)) return;
  dialogs.delete(tabId);
  choosers.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

function releaseAll() {
  return Promise.all([...attached].map(release));
}

async function setLimitation(tabId, limitation) {
  const info = shared.get(tabId);
  if (!info || info.limitation === limitation) return;
  info.limitation = limitation;
  await save();
}

async function describe(tab) {
  const info = shared.get(tab.id);
  const url = tab.url || tab.pendingUrl || '';
  return {
    tabId: tab.id,
    title: (tab.title ?? '').slice(0, LIMITS.titleChars),
    url: url.slice(0, LIMITS.urlChars),
    createdByRelay: info.createdByRelay,
    // A page outside http(s) is the browser's own (chrome://, the Web Store, a PDF viewer…).
    limitation: info.limitation ?? (httpUrl(url) || url === '' ? null : 'internal_page'),
    dialog: dialogs.get(tab.id) ?? null,
    fileChooser: choosers.has(tab.id) ? { multiple: choosers.get(tab.id).multiple } : null,
  };
}

const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const exact = (v, keys) => keys.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => keys.includes(k));

async function handle(msg) {
  await loaded;
  switch (msg.op) {
    case 'tabs': {
      if (!exact(msg, ['id', 'op'])) throw new Failure('invalid');
      const out = [];
      for (const tabId of shared.keys()) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) out.push(await describe(tab));
        else shared.delete(tabId);
      }
      return out.slice(0, LIMITS.tabs);
    }
    case 'open': {
      if (!exact(msg, ['id', 'op', 'url']) || !httpUrl(msg.url)) throw new Failure('invalid');
      // In the background: the person at the computer keeps the tab they are looking at.
      const tab = await chrome.tabs.create({ url: msg.url, active: false });
      shared.set(tab.id, { createdByRelay: true, limitation: null });
      await save();
      await badge(tab.id, true);
      return describe(tab);
    }
    case 'act': {
      const action = exact(msg, ['id', 'op', 'tabId', 'action']) && integer(msg.tabId) ? validateAction(msg.action) : null;
      if (!action) throw new Failure('invalid');
      const info = shared.get(msg.tabId);
      const tab = info ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
      if (!tab) throw new Failure('not_shared');
      if (info.limitation === 'canceled_by_user') throw new Failure('limited');
      const url = tab.url || tab.pendingUrl || '';
      if (url !== '' && !httpUrl(url)) throw new Failure('limited');
      // The browser answers input that opens a JavaScript dialog only once the dialog is answered: the
      // dialog opening is its answer, and it shows as the tab's state.
      const send = (method, params) => {
        const command = chrome.debugger.sendCommand({ tabId: msg.tabId }, method, params);
        if (!method.startsWith('Input.')) return command;
        const waiting = inputs.get(msg.tabId) ?? new Set();
        inputs.set(msg.tabId, waiting);
        return new Promise((resolve, reject) => {
          const opened = () => resolve({});
          waiting.add(opened);
          command.then(resolve, reject).finally(() => waiting.delete(opened));
        });
      };
      // Only a chooser Relay's tap opens is Relay's: interception lasts as long as that tap.
      const intercept = action.type === 'tap';
      try {
        await attach(msg.tabId);
        if (intercept) await send('Page.setInterceptFileChooserDialog', { enabled: true });
        let result;
        try {
          result = await perform(action, send, choosers.get(msg.tabId) ?? null);
        } finally {
          // Under a JavaScript dialog the browser answers it only once the dialog is answered; it still goes first.
          const off = intercept ? send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {}) : null;
          if (!dialogs.has(msg.tabId)) await off;
        }
        if (action.type === 'files') choosers.delete(msg.tabId);
        if (info.limitation) await setLimitation(msg.tabId, null);
        return result;
      } catch (error) {
        if (error instanceof Failure) throw error;
        const limitation = limitationOf(String(error?.message ?? error));
        if (!limitation) throw new Failure('failed');
        if (limitation !== 'internal_page') await setLimitation(msg.tabId, limitation);
        throw new Failure('limited');
      }
    }
    case 'release':
      if (!exact(msg, ['id', 'op'])) throw new Failure('invalid');
      await releaseAll();
      return {};
    case 'downloads':
      if (!exact(msg, ['id', 'op'])) throw new Failure('invalid');
      return downloads.splice(0);
    default:
      throw new Failure('invalid');
  }
}

async function onRequest(msg) {
  retryMs = 1000;
  const id = Number.isSafeInteger(msg?.id) ? msg.id : null;
  try {
    const result = await handle(msg ?? {});
    port?.postMessage({ type: 'response', id, ok: true, result });
  } catch (error) {
    port?.postMessage({ type: 'response', id, ok: false, code: error instanceof Failure ? error.code : 'failed' });
  }
}

/** The person's choice at the computer: the toolbar button shares the tab or stops sharing it. */
async function toggle(tabId) {
  await loaded;
  if (shared.has(tabId) && shared.get(tabId).limitation !== 'canceled_by_user') {
    shared.delete(tabId);
    await release(tabId);
    await save();
    await badge(tabId, false);
    return false;
  }
  // Sharing again also lifts a cancellation done from the "debugging this browser" bar.
  shared.set(tabId, { createdByRelay: shared.get(tabId)?.createdByRelay ?? false, limitation: null });
  await save();
  await badge(tabId, true);
  return true;
}
chrome.action.onClicked.addListener((tab) => { void toggle(tab.id); });
// The toolbar click in tests: a real click needs a screen. Reachable only from the extension itself.
globalThis.relayToggle = toggle;

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  dialogs.delete(tabId);
  choosers.delete(tabId);
  if (shared.delete(tabId)) void save();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete' && shared.has(tabId)) void badge(tabId, true);
});

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  dialogs.delete(tabId);
  choosers.delete(tabId);
  // The person pressed Cancel on the "debugging this browser" bar: no control until they share again.
  if (reason === 'canceled_by_user') void setLimitation(tabId, 'canceled_by_user');
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    dialogs.set(tabId, {
      type: params.type, message: String(params.message ?? '').slice(0, LIMITS.textChars).toWellFormed(),
      defaultPrompt: String(params.defaultPrompt ?? '').slice(0, LIMITS.textChars).toWellFormed(),
    });
    for (const opened of inputs.get(tabId) ?? []) opened();
    inputs.delete(tabId);
  } else if (method === 'Page.javascriptDialogClosed') {
    dialogs.delete(tabId);
  } else if (method === 'Page.fileChooserOpened' && Number.isSafeInteger(params.backendNodeId)) {
    // Only while Relay's tap intercepts: the person's own choosers never reach here.
    choosers.set(tabId, { multiple: params.mode === 'selectMultiple', backendNodeId: params.backendNodeId });
  }
});

// chrome.downloads names no tab: a download belongs to a shared tab when its referrer is that tab's
// page (#78). Any other download of the person's browser is never reported.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'complete') return;
  await loaded;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item?.filename?.startsWith('/') || !item.referrer) return;
  const urls = await Promise.all([...shared.keys()].map((tabId) => chrome.tabs.get(tabId).then((tab) => tab.url, () => null)));
  if (!urls.includes(item.referrer)) return;
  downloads.push({ name: item.filename.slice(item.filename.lastIndexOf('/') + 1), path: item.filename });
  if (downloads.length > LIMITS.downloads) downloads.shift();
});

// The open port keeps the worker alive; while it is down, the alarm wakes it to try again.
chrome.alarms.create('relay-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
connect();
