// The habitual browser end to end (#93): the real Puente, the registration, the native messaging host
// and bridge/extension in a test browser with an ephemeral HOME and profile, never a personal one.
// Opt-in, like the lab it reuses (labs/v3-cdp, docs/research/v3-cdp.md):
//   cd labs/v3-cdp && npm ci && npm run browsers
//   RELAY_LAB_BROWSER=cft node --test test/habitualBrowserReal.test.ts           # Chrome for Testing 154
//   RELAY_LAB_BROWSER=chrome node --test test/habitualBrowserReal.test.ts        # Google Chrome, Extensions.loadUnpacked
// The test drives the person at the computer through its own CDP pipe (the oracle), which production
// does not have, and stands in for the toolbar click with the extension's own toggle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BROWSER, attachPage, launch, type Browser, type Page } from '../../labs/v3-cdp/lib/browser.ts';
import { serveFixtures } from '../../labs/v3-cdp/lib/fixtures.ts';
import { EXTENSION_DIRECTORY, listenExtension, NATIVE_HOST_BROWSERS, RELAY_EXTENSION_ID, registerNativeHost } from '../src/remote/habitualBrowser.ts';
import type { BrowserStreamEvent } from '../../protocol/remoteBrowser.ts';
import { habitualPuente, PHONE, TABLET, type Device } from '../support/habitual_lab.ts';

const skip = process.env.RELAY_LAB_BROWSER ? false : 'needs a test browser: RELAY_LAB_BROWSER=cft|chrome (labs/v3-cdp)';
/** The lab's browser name as registerNativeHost names it. */
const REGISTERED: Record<string, string> = { cft: 'chrome-for-testing', chrome: 'google-chrome', chromium: 'chromium' };
const EXTENSION = fileURLToPath(EXTENSION_DIRECTORY);
const TIMEOUT = 90_000;

async function until(check: () => unknown, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(50);
  }
}

async function evaluate(page: Page, expression: string): Promise<unknown> {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function habitual(t: TestContext) {
  const site = await serveFixtures();
  t.after(() => site.close());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-habitual-real-'));
  const state = path.join(root, 'state');
  const config = path.join(root, 'config');
  await fs.mkdir(state, { mode: 0o700 });
  const puente = await habitualPuente(t, { stateDirectory: state, requestTimeoutMs: 20_000 });
  const registered = REGISTERED[BROWSER.name]!;
  await registerNativeHost({ stateDirectory: state, configHome: config, browser: registered, nodePath: process.execPath });
  // The profile is the browser's own directory under that XDG_CONFIG_HOME, as the habitual one would be.
  const profile = path.join(config, NATIVE_HOST_BROWSERS[registered]!);
  const loadByCdp = BROWSER.name === 'chrome';
  const browser: Browser = await launch({
    transport: 'pipe', mode: 'headful', profile,
    args: loadByCdp ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${EXTENSION}`, `--disable-extensions-except=${EXTENSION}`],
  });
  t.after(async () => { await browser.close(); await fs.rm(root, { recursive: true, force: true }); });
  if (loadByCdp) assert.equal((await browser.cdp.send('Extensions.loadUnpacked', { path: EXTENSION })).id, RELAY_EXTENSION_ID);
  try {
    await until(async () => (await puente.link.availability()).state === 'available', 'the extension reached the Puente through its host');
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${browser.stderr().slice(-2000)}`);
  }
  t.diagnostic(`${BROWSER.name} ${BROWSER.version}, extension ${RELAY_EXTENSION_ID}`);

  const cdp = browser.cdp;
  let worker: Page | null = null;
  /** Evaluated in the extension's own worker: what the person's toolbar click and the browser's state are. */
  async function inWorker(expression: string): Promise<unknown> {
    if (!worker) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const target = targetInfos.find((candidate: { type: string; url: string }) => candidate.type === 'service_worker' && candidate.url === `chrome-extension://${RELAY_EXTENSION_ID}/background.js`);
      worker = await attachPage(cdp, target.targetId);
    }
    return evaluate(worker, expression);
  }
  const targetOf = async (tabId: number) => await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${tabId})?.id)`) as string;
  const pages = new Map<number, Page>();
  /** The oracle's own session on a tab; never opened on a tab whose debugger state is asserted. */
  async function page(tabId: number): Promise<Page> {
    if (!pages.has(tabId)) pages.set(tabId, await attachPage(cdp, await targetOf(tabId)));
    return pages.get(tabId)!;
  }
  /**
   * One frame of the tab through the stream, as the app gets it: the view, then the first frame. A view
   * Relay refuses (a tab not shared, a limitation) answers its error instead.
   */
  async function capture(device: Device, id: string, tab: number, width = 320) {
    const stream = await puente.frames(device, id);
    try {
      if (stream.status !== 200) return { status: stream.status, json: stream.json! };
      await until(() => stream.channel() !== '', 'stream open');
      const view = await puente.call(device, 'POST', `/v1/remote/browsers/${id}/view`, { channel: stream.channel(), tab: String(tab), width, height: 400 });
      if (view.status !== 200) return view;
      let frame: Extract<BrowserStreamEvent, { type: 'frame' }> | undefined;
      await until(() => (frame = stream.events.find((event) => event.type === 'frame')), 'a frame');
      return { status: 200, json: frame! };
    } finally {
      stream.close();
    }
  }
  return {
    puente, site, browser, inWorker, capture,
    /** The person opens a tab; its chrome.tabs id, once loaded. */
    async localTab(url: string): Promise<number> {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      let tabId: number | undefined;
      await until(async () => (tabId = await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.id === ${JSON.stringify(targetId)})?.tabId)`) as number | undefined), 'tab id');
      await until(async () => (await inWorker(`chrome.tabs.get(${tabId}).then((t) => t.status)`)) === 'complete', 'tab loaded');
      return tabId!;
    },
    share: (tabId: number) => inWorker(`relayToggle(${tabId})`),
    evalInTab: async (tabId: number, expression: string) => evaluate(await page(tabId), expression),
    /** The person clicks an element at the computer: a user gesture, as a real click would be. */
    personClicks: async (tabId: number, selector: string) => (await page(tabId)).send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).click()`, userGesture: true }),
    /** The person types an address: pages themselves cannot open the browser's internal ones. */
    localNavigates: async (tabId: number, url: string) => (await page(tabId)).send('Page.navigate', { url }),
    /** Whether any debugger is attached to the tab: the extension's, when the oracle never attached to it. */
    attached: async (tabId: number) => await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${tabId})?.attached ?? false)`) as boolean,
    tabIds: async () => await inWorker('chrome.tabs.query({}).then((ts) => ts.map((t) => t.id).sort((a, b) => a - b))') as number[],
    activate: async (tabId: number) => cdp.send('Target.activateTarget', { targetId: await targetOf(tabId) }),
    alive: () => browser.proc.exitCode === null && browser.proc.signalCode === null,
  };
}

test(`[${BROWSER.name}] only the tabs the person chose are listed and controlled, alongside the person at the computer`, { skip, timeout: TIMEOUT }, async (t) => {
  const h = await habitual(t);
  const other = await h.localTab(`${h.site.url}/form?who=other`);
  const mine = await h.localTab(`${h.site.url}/form?who=mine`);
  const id = (await h.puente.connect(PHONE)).json.id as string;
  assert.deepEqual((await h.puente.tabs(PHONE, id)).json, { tabs: [] }, 'nothing until the person shares a tab');
  assert.equal((await h.capture(PHONE, id, other)).json.error.code, 'remote_not_found');

  await h.share(mine);
  const listed = (await h.puente.tabs(PHONE, id)).json.tabs;
  assert.deepEqual(listed, [{ id: String(mine), title: 'Form', url: `${h.site.url}/form?who=mine`, createdByRelay: false, limitation: null, dialog: null, fileChooser: null }]);
  assert.equal((await h.puente.act(PHONE, id, other, { type: 'reload' })).json.error.code, 'remote_not_found', 'an unshared tab stays out of reach');
  assert.equal(await h.attached(other), false);

  // A frame of the shared tab while another one is in front, through the stream: captured without activating it.
  await h.activate(other);
  const frame = await h.capture(PHONE, id, mine, 640);
  assert.equal(frame.status, 200, JSON.stringify(frame.json));
  assert.equal(Buffer.from(frame.json.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  // The viewport in CSS pixels, the coordinates a tap uses.
  assert.deepEqual(frame.json.viewport, JSON.parse(await h.evalInTab(mine, 'JSON.stringify({ width: Math.round(visualViewport.width), height: Math.round(visualViewport.height) })') as string));
  assert.equal(await h.inWorker(`chrome.tabs.get(${mine}).then((t) => t.active)`), false, 'still in the background');
  // The page has no way to the extension: no externally_connectable, no content script.
  assert.equal(await h.evalInTab(mine, 'typeof globalThis.chrome?.runtime?.sendMessage'), 'undefined');

  // Shared control: Relay and the person type into the same field, in turn.
  const box = await h.evalInTab(mine, `JSON.stringify(document.querySelector('#t').getBoundingClientRect())`) as string;
  const { x, y, width, height } = JSON.parse(box);
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'tap', x: x + width / 2, y: y + height / 2 })).status, 200);
  await h.puente.act(PHONE, id, mine, { type: 'text', text: 'relay ñ ' });
  await (await h.evalInTab(mine, `document.querySelector('#t').value += 'local'`));
  await h.puente.act(PHONE, id, mine, { type: 'key', key: 'End' });
  await h.puente.act(PHONE, id, mine, { type: 'text', text: ' relay' });
  assert.equal(await h.evalInTab(mine, `document.querySelector('#t').value`), 'relay ñ local relay');
  await h.puente.act(PHONE, id, mine, { type: 'key', key: 'Enter' });
  assert.equal(await h.evalInTab(mine, 'window.submitted'), 'relay ñ local relay');

  // The person switches tabs at the computer: Relay keeps controlling its tab and never moves theirs.
  await h.activate(mine);
  await h.activate(other);
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'navigate', url: `${h.site.url}/a` })).status, 200);
  await until(async () => (await h.puente.tabs(PHONE, id)).json.tabs[0]?.title === 'A', 'navigated');
  assert.deepEqual((await h.puente.act(PHONE, id, mine, { type: 'back' })).json, { moved: true });
  assert.equal(await h.inWorker(`chrome.tabs.get(${other}).then((t) => t.active)`), true);
});

test(`[${BROWSER.name}] a tab Relay opens is shared, and disconnecting, revoking or losing the host keep the browser and every tab`, { skip, timeout: TIMEOUT }, async (t) => {
  const h = await habitual(t);
  const mine = await h.localTab(`${h.site.url}/a`);
  await h.share(mine);
  const phone = (await h.puente.connect(PHONE)).json.id as string;
  const opened = await h.puente.open(PHONE, phone, `${h.site.url}/b`);
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.createdByRelay, true);
  assert.match(opened.json.id, /^[1-9][0-9]*$/);
  const relayTab = Number(opened.json.id);
  await until(async () => (await h.puente.tabs(PHONE, phone)).json.tabs.find((tab: { id: string }) => tab.id === String(relayTab))?.title === 'B', 'the new tab loads');
  assert.equal(await h.inWorker(`chrome.tabs.get(${relayTab}).then((t) => t.active)`), false, 'opened behind the person\'s tab');
  const all = await h.tabIds();

  for (const tab of [mine, relayTab]) assert.equal((await h.capture(PHONE, phone, tab)).status, 200);
  assert.deepEqual([await h.attached(mine), await h.attached(relayTab)], [true, true]);
  assert.equal((await h.puente.terminate(PHONE, phone)).json.state, 'exited');
  await until(async () => !(await h.attached(mine)) && !(await h.attached(relayTab)), 'disconnecting detaches');
  assert.deepEqual(await h.tabIds(), all, 'disconnecting closes nothing');

  const again = (await h.puente.connect(PHONE, 'habitual-again')).json.id as string;
  assert.equal((await h.capture(PHONE, again, relayTab)).status, 200);
  await h.puente.revoke(PHONE);
  await until(async () => !(await h.attached(relayTab)), 'revoking detaches');
  assert.deepEqual(await h.tabIds(), all, 'revoking closes nothing, not even the tab Relay opened');
  assert.equal((await h.puente.tabs(PHONE, again)).json.error.code, 'device_revoked');

  // The native host dies: the extension lets go, comes back by itself and still holds the choice.
  const tablet = (await h.puente.connect(TABLET)).json.id as string;
  assert.equal((await h.capture(TABLET, tablet, mine)).status, 200);
  execFileSync('pkill', ['-KILL', '-f', h.puente.link.socketPath]);
  await until(async () => !(await h.attached(mine)), 'losing the host detaches');
  await until(async () => (await h.puente.link.availability()).state === 'available', 'the extension reconnects', 20_000);
  assert.deepEqual((await h.puente.tabs(TABLET, tablet)).json.tabs.map((tab: { id: string }) => Number(tab.id)).sort(), [mine, relayTab].sort());
  assert.deepEqual(await h.tabIds(), all);

  // The Puente restarts: its socket goes away and comes back, and the extension finds it on its own.
  await h.puente.link.close();
  await until(async () => !(await h.attached(mine)), 'losing the Puente detaches');
  const restarted = await listenExtension({ stateDirectory: h.puente.directory });
  t.after(() => restarted.close());
  await until(async () => (await restarted.availability()).state === 'available', 'the extension finds the restarted Puente', 40_000);
  assert.deepEqual((await restarted.tabs()).map((tab) => Number(tab.id)).sort(), [mine, relayTab].sort());
  assert.deepEqual(await h.tabIds(), all);
  assert.ok(h.alive());
});

test(`[${BROWSER.name}] pages Relay cannot control and open dialogs are visible states; DevTools does not take the tab`, { skip, timeout: TIMEOUT }, async (t) => {
  const h = await habitual(t);
  const mine = await h.localTab(`${h.site.url}/form`);
  await h.share(mine);
  const id = (await h.puente.connect(PHONE)).json.id as string;
  assert.equal((await h.capture(PHONE, id, mine)).status, 200);

  // A JavaScript dialog opened by the page: listed, answered from Relay.
  void h.evalInTab(mine, `setTimeout(() => window.ask('confirm'), 0), 0`);
  await until(async () => (await h.puente.tabs(PHONE, id)).json.tabs[0].dialog?.type === 'confirm', 'dialog listed');
  assert.deepEqual((await h.puente.tabs(PHONE, id)).json.tabs[0].dialog, { type: 'confirm', message: 'c', defaultPrompt: '' });
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'dialog', accept: true })).status, 200);
  await until(async () => (await h.evalInTab(mine, 'window.answer')) === 'confirm:true', 'answered');
  assert.equal((await h.puente.tabs(PHONE, id)).json.tabs[0].dialog, null);

  // DevTools opened at the computer on the controlled tab: control goes on (#78).
  await h.browser.cdp.send('Target.openDevTools', { targetId: await h.inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${mine})?.id)`) });
  assert.equal((await h.capture(PHONE, id, mine)).status, 200);

  // The person goes to a page of the browser itself: a limitation, not a failure.
  await h.localNavigates(mine, 'chrome://version');
  await until(async () => (await h.puente.tabs(PHONE, id)).json.tabs[0]?.limitation === 'internal_page', 'internal page listed');
  const refused = await h.capture(PHONE, id, mine);
  assert.deepEqual([refused.status, refused.json.error.code], [409, 'remote_browser_limited']);
  assert.ok(h.alive());
});

test(`[${BROWSER.name}] Relay's tap opens a chooser Relay fills with a file of the Server, the person's own stays theirs, and a shared tab's download is announced with its path`, { skip, timeout: TIMEOUT }, async (t) => {
  const h = await habitual(t);
  const mine = await h.localTab(`${h.site.url}/form`);
  const other = await h.localTab(`${h.site.url}/form?who=other`);
  await h.share(mine);
  const id = (await h.puente.connect(PHONE)).json.id as string;
  const stream = await h.puente.frames(PHONE, id);
  await until(() => stream.channel() !== '', 'stream open');
  assert.equal((await h.puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/view`, { channel: stream.channel(), tab: String(mine), width: 640, height: 400 })).status, 200);
  // The app acks every frame it shows: that keeps the stream, and with it the downloads, going.
  let acked = 0;
  const ack = async () => {
    const last = stream.events.findLast((event) => event.type === 'frame') as Extract<BrowserStreamEvent, { type: 'frame' }> | undefined;
    if (last && last.seq > acked) { acked = last.seq; await h.puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/ack`, { channel: stream.channel(), seq: acked }); }
  };
  const listed = async () => (await h.puente.tabs(PHONE, id)).json.tabs[0];
  const center = async (selector: string) => {
    const { x, y, width, height } = JSON.parse(await h.evalInTab(mine, `JSON.stringify(document.querySelector('${selector}').getBoundingClientRect())`) as string);
    return { x: x + width / 2, y: y + height / 2 };
  };

  // No chooser of Relay's yet: nothing to fill.
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'files', paths: [h.site.uploadPath] })).json.error.code, 'remote_conflict');

  // Relay's tap opens one: listed, then filled with a file of the Server.
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'tap', ...await center('#f') })).status, 200);
  await until(async () => (await listed()).fileChooser !== null, 'the chooser Relay opened is listed');
  assert.deepEqual((await listed()).fileChooser, { multiple: false });
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'files', paths: [path.join(h.site.uploadPath, 'missing')] })).json.error.code, 'remote_not_found');
  assert.deepEqual((await h.puente.act(PHONE, id, mine, { type: 'files', paths: [h.site.uploadPath] })).json, {});
  await until(async () => (await h.evalInTab(mine, 'window.picked')) === path.basename(h.site.uploadPath), 'the page received the file');
  assert.equal((await listed()).fileChooser, null);

  // Then the person opens the chooser at the computer, on the same tab Relay controls: it stays theirs.
  await h.personClicks(mine, '#f');
  // Nothing to wait for when nothing happens: give the browser a moment to deliver a chooser event it should not.
  await sleep(500);
  assert.equal((await listed()).fileChooser, null, 'the person\'s own chooser is not intercepted');

  // A download of a tab the person did not share is never reported; one of the shared tab stays on the
  // Server and its path comes through the stream.
  await h.personClicks(other, '#dl');
  await until(async () => (await h.inWorker(`chrome.downloads.search({ state: 'complete' }).then((items) => items.length)`)) === 1, 'the unshared download finished');
  assert.equal((await h.puente.act(PHONE, id, mine, { type: 'tap', ...await center('#dl') })).status, 200);
  const downloads = () => stream.events.filter((event): event is Extract<BrowserStreamEvent, { type: 'download' }> => event.type === 'download');
  await until(async () => { await ack(); return downloads().length > 0; }, 'download announced', 20_000);
  const [download] = downloads();
  assert.equal(downloads().length, 1, 'only the shared tab\'s download');
  assert.equal(download!.name, path.basename(download!.path));
  assert.match(download!.name, /^relay-lab.*\.txt$/);
  assert.equal(await fs.readFile(download!.path, 'utf8'), h.site.downloadBody);
  stream.close();
  assert.ok(h.alive());
});
