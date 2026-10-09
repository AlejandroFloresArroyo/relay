// Lab extension for the usual browser. It talks to exactly one native host (the local adapter to
// the Puente), only touches tabs the person shared, and only runs the bounded actions.
import { perform, prepare, validateAction } from './actions.js';

const HOST = 'com.relay.lab';
/** tabId -> { createdByRelay }. Lost if the worker restarts: production keeps it in chrome.storage.session. */
const shared = new Map();
const attached = new Set();
let port = null;

function post(message) {
  port?.postMessage(message);
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onRequest);
  port.onDisconnect.addListener(() => {
    port = null;
    void releaseAll();
    // ponytail: plain timer, enough while the worker lives; production retries from chrome.alarms.
    setTimeout(connect, 500);
  });
  post({ event: 'hello', extensionId: chrome.runtime.id, userAgent: navigator.userAgent });
}

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  await prepare((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
}

async function release(tabId) {
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function releaseAll() {
  await Promise.all([...attached].map(release));
}

async function handle(msg) {
  switch (msg.op) {
    case 'listTabs': {
      const out = [];
      for (const [tabId, info] of shared) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) out.push({ tabId, title: tab.title, url: tab.url, createdByRelay: info.createdByRelay });
      }
      return out;
    }
    case 'openTab': {
      const { url } = validateAction({ type: 'navigate', url: msg.url });
      const tab = await chrome.tabs.create({ url });
      shared.set(tab.id, { createdByRelay: true });
      return tab.id;
    }
    case 'act': {
      const action = validateAction(msg.action);
      if (!shared.has(msg.tabId)) throw new Error('tab not shared');
      await attach(msg.tabId);
      return perform(action, (method, params) => chrome.debugger.sendCommand({ tabId: msg.tabId }, method, params));
    }
    case 'release':
      await releaseAll();
      return {};
    default:
      throw new Error('invalid op');
  }
}

async function onRequest(msg) {
  try {
    post({ id: msg.id, ok: true, result: await handle(msg) });
  } catch (error) {
    post({ id: msg.id, ok: false, error: String(error?.message ?? error) });
  }
}

/** The person's choice. Bound to the toolbar button; the lab calls it directly to stand in for the click. */
globalThis.relayShareTab = (tabId) => {
  shared.set(tabId, { createdByRelay: false });
  post({ event: 'shared', tabId });
  return true;
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!shared.has(tab.id)) return globalThis.relayShareTab(tab.id);
  shared.delete(tab.id);
  await release(tab.id);
  post({ event: 'unshared', tabId: tab.id });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  shared.delete(tabId);
  attached.delete(tabId);
});

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  post({ event: 'detached', tabId, reason });
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    post({ event: 'dialog', tabId, dialogType: params.type, message: params.message });
  } else if (method === 'Page.fileChooserOpened') {
    post({ event: 'fileChooser', tabId, backendNodeId: params.backendNodeId, mode: params.mode });
  }
});

// chrome.downloads has no tabId: attribute a download to a shared tab by its referrer, never report the rest.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'complete') return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  const urls = await Promise.all([...shared.keys()].map((id) => chrome.tabs.get(id).then((t) => t.url, () => null)));
  if (item && urls.includes(item.referrer)) post({ event: 'download', state: 'complete', filename: item.filename });
});

// Lab only, evaluated by the test through its own CDP pipe; never reachable from the native host.
globalThis.relayAttached = () => [...attached].sort((a, b) => a - b);
globalThis.relayTabIdOf = async (targetId) => (await chrome.debugger.getTargets()).find((t) => t.id === targetId)?.tabId;
globalThis.relayCatalogue = async (tabId) => {
  const target = { tabId };
  const probes = [
    ['Page.captureScreenshot', { format: 'jpeg', quality: 30 }],
    ['Page.startScreencast', { format: 'jpeg', maxWidth: 200 }],
    ['Page.stopScreencast', {}],
    ['Page.getNavigationHistory', {}],
    ['Page.handleJavaScriptDialog', { accept: true }],
    ['Page.setInterceptFileChooserDialog', { enabled: true }],
    ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }],
    ['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 1 }] }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift' }],
    ['Input.insertText', { text: '' }],
    ['DOM.getDocument', {}],
    ['DOM.setFileInputFiles', { files: [], nodeId: 0 }],
    ['Runtime.evaluate', { expression: '1 + 1' }],
    ['Emulation.setDeviceMetricsOverride', { width: 400, height: 700, deviceScaleFactor: 1, mobile: true }],
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Fetch.enable', {}],
    ['Fetch.disable', {}],
    ['Network.getCookies', {}],
    ['Storage.getCookies', {}],
    ['Target.getTargets', {}],
    ['Target.createTarget', { url: 'about:blank' }],
    ['Browser.getVersion', {}],
    ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
    ['SystemInfo.getInfo', {}],
    // Last: it starts a navigation, and commands sent mid-navigation fail with "Not attached".
    ['Page.reload', {}],
  ];
  const results = {};
  await chrome.debugger.attach(target, '1.3');
  try {
    for (const [method, params] of probes) {
      const timeout = new Promise((resolve) => setTimeout(resolve, 5000, 'no reply in 5 s'));
      results[method] = await Promise.race([
        chrome.debugger.sendCommand(target, method, params).then(
          () => 'ok',
          (e) => String(e?.message ?? e),
        ),
        timeout,
      ]);
    }
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
  return results;
};

connect();
