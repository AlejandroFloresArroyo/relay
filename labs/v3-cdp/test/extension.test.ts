// Usual browser: a test browser already open with its own (synthetic) tabs, the lab extension and
// the native messaging adapter. The lab Puente only reaches the browser through the adapter; the
// test reads browser state through a separate CDP pipe (the oracle) that production does not have.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER, sleep, until } from '../lib/browser.ts';
import { serveFixtures, type Fixtures } from '../lib/fixtures.ts';
import { launchUsual, type Usual } from '../lib/usual.ts';

let site: Fixtures;
before(async () => {
  site = await serveFixtures();
});
after(() => site.close());

async function withUsual(args: string[], fn: (u: Usual) => Promise<void>) {
  const u = await launchUsual({ args });
  try {
    await fn(u);
  } finally {
    await u.close();
  }
}

test(`[${BROWSER.name}] the extension loads and its native host connects to the Puente`, async (t) => {
  await withUsual([], async (u) => {
    const hello = await u.puente.hello;
    t.diagnostic(`extension ${hello.extensionId} host argv origin ${hello.origin} ua ${hello.userAgent}`);
    assert.equal(hello.origin, `chrome-extension://${u.extensionId}/`);
  });
});

test(`[${BROWSER.name}] only tabs the user shared are visible or controllable`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const other = await u.localTab(`${site.url}/form?who=local-b`);
    const mine = await u.localTab(`${site.url}/form?who=local-a`);
    assert.deepEqual(await conn.request({ op: 'listTabs' }), []);
    await assert.rejects(conn.request({ op: 'act', tabId: other, action: { type: 'frame' } }), /not shared/);

    await u.userShares(mine);
    const tabs = await conn.request({ op: 'listTabs' });
    assert.deepEqual(tabs.map((x: { tabId: number }) => x.tabId), [mine]);
    await assert.rejects(conn.request({ op: 'act', tabId: other, action: { type: 'frame' } }), /not shared/);
    const frame = await conn.request({ op: 'act', tabId: mine, action: { type: 'frame', maxWidth: 640 } });
    assert.equal(Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  });
});

test(`[${BROWSER.name}] a shared tab in the background is captured without activating it`, async (t) => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const shared = await u.localTab(`${site.url}/form?who=shared`);
    await u.localTab(`${site.url}/form?who=in-front`);
    await u.userShares(shared);
    t.diagnostic(`page viewport seen from the page: ${await u.evalInTab(shared, 'JSON.stringify([innerWidth, innerHeight, document.visibilityState])')}`);
    const frame = await conn.request({ op: 'act', tabId: shared, action: { type: 'frame', maxWidth: 320 } });
    assert.ok(frame.width > 0);
    assert.equal(await u.inWorker(`chrome.tabs.get(${shared}).then((t) => t.active)`), false, 'still in the background');
  });
});

test(`[${BROWSER.name}] the adapter refuses raw CDP and oversized requests before Chrome sees them`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const tab = await u.localTab(`${site.url}/form`);
    await u.userShares(tab);
    for (const bad of [
      { op: 'act', tabId: tab, action: { type: 'cdp', method: 'Browser.close' } },
      { op: 'sendCommand', tabId: tab, method: 'Runtime.evaluate', params: { expression: '1' } },
      { op: 'act', tabId: tab, action: { type: 'navigate', url: 'chrome://settings' } },
    ]) {
      await assert.rejects(conn.request(bad), /invalid/, JSON.stringify(bad));
    }
    await assert.rejects(conn.request({ op: 'act', tabId: tab, action: { type: 'text', text: 'x'.repeat(1_100_000) } }), /too large/);
    // The channel survives the refusals.
    assert.equal((await conn.request({ op: 'listTabs' })).length, 1);
  });
});

test(`[${BROWSER.name}] tap, text, keys and navigation work through the extension`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const tab = await u.localTab(`${site.url}/a`);
    await u.userShares(tab);
    const act = (action: unknown) => conn.request({ op: 'act', tabId: tab, action });
    await act({ type: 'navigate', url: `${site.url}/form` });
    await until(async () => (await u.evalInTab(tab, 'document.title')) === 'Form');
    const field = await u.evalInTab(tab, `(() => { const r = document.querySelector('#t').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await act({ type: 'tap', ...field });
    await act({ type: 'text', text: 'desde Relay' });
    await act({ type: 'key', key: 'Enter' });
    assert.equal(await u.evalInTab(tab, 'window.submitted'), 'desde Relay');
    assert.deepEqual(await act({ type: 'back' }), { moved: true });
    await until(async () => (await u.evalInTab(tab, 'document.title')) === 'A');
    const loads = await u.evalInTab(tab, 'window.loads');
    await act({ type: 'reload' });
    await until(async () => (await u.evalInTab(tab, 'window.loads').catch(() => 0)) === loads + 1);
  });
});

test(`[${BROWSER.name}] chrome.debugger method catalogue`, async (t) => {
  await withUsual([], async (u) => {
    const tab = await u.localTab(`${site.url}/form`);
    const results: Record<string, string> = await u.inWorker(`relayCatalogue(${tab})`);
    for (const [method, outcome] of Object.entries(results)) t.diagnostic(`${method}: ${outcome}`);
    for (const method of [
      'Page.captureScreenshot',
      'Page.getNavigationHistory',
      'Page.reload',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'Page.setInterceptFileChooserDialog',
    ]) {
      assert.equal(results[method], 'ok', method);
    }
    // Browser-level commands are unreachable from chrome.debugger; the design must not assume them.
    for (const method of ['Browser.getVersion', 'Browser.setDownloadBehavior', 'Page.setDownloadBehavior']) {
      assert.match(results[method], /not allowed|wasn't found|browser-level/i, method);
    }
  });
});

test(`[${BROWSER.name}] dialogs, file chooser and downloads through the extension`, async (t) => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const tab = await u.localTab(`${site.url}/form`);
    await u.userShares(tab);
    const act = (action: unknown) => conn.request({ op: 'act', tabId: tab, action });
    const center = (sel: string) =>
      u.evalInTab(tab, `(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await act({ type: 'frame', maxWidth: 320 }); // attaches

    void u.evalInTab(tab, `setTimeout(() => window.ask('confirm'), 0), 0`);
    const dialog = await conn.event((e) => e.event === 'dialog');
    assert.equal(dialog.dialogType, 'confirm');
    await act({ type: 'dialog', accept: true });
    await until(async () => (await u.evalInTab(tab, 'window.answer')) === 'confirm:true');

    await act({ type: 'tap', ...(await center('#f')) });
    const chooser = await conn.event((e) => e.event === 'fileChooser');
    const filled = await act({ type: 'files', backendNodeId: chooser.backendNodeId, paths: [site.uploadPath] }).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    t.diagnostic(`DOM.setFileInputFiles from the extension: ${filled}`);
    assert.equal(filled, 'ok');
    assert.equal(await u.evalInTab(tab, 'window.picked'), 'upload.txt');

    await act({ type: 'tap', ...(await center('#dl')) });
    const download = await conn.event((e) => e.event === 'download' && e.state === 'complete');
    t.diagnostic(`download complete: ${download.filename}`);
    assert.ok(download.filename.startsWith(u.home), 'download stays on the Server');
  });
});

test(`[${BROWSER.name}] control is shared with the person at the computer`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const tab = await u.localTab(`${site.url}/form`);
    await u.userShares(tab);
    await u.evalInTab(tab, `document.querySelector('#t').focus()`);
    await conn.request({ op: 'act', tabId: tab, action: { type: 'text', text: 'relay ' } });
    await u.localTypes(tab, 'local');
    await conn.request({ op: 'act', tabId: tab, action: { type: 'text', text: ' relay' } });
    assert.equal(await u.evalInTab(tab, `document.querySelector('#t').value`), 'relay local relay');
  });
});

test(`[${BROWSER.name}] losing the adapter detaches but keeps the browser and Relay's new tabs`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const local = await u.localTab(`${site.url}/a`);
    await u.userShares(local);
    const created = await conn.request({ op: 'openTab', url: `${site.url}/b` });
    await conn.request({ op: 'act', tabId: created, action: { type: 'frame', maxWidth: 320 } });
    // Attaching without capturing: background capture has its own test.
    await conn.request({ op: 'act', tabId: local, action: { type: 'back' } });
    assert.deepEqual(await u.inWorker('relayAttached()'), [local, created].sort((a, b) => a - b));

    const next = u.puente.nextConnection();
    conn.drop();
    await until(async () => (await u.inWorker('relayAttached()')).length === 0);
    assert.equal(u.alive(), true, 'the usual browser keeps running');
    const urls = await u.tabUrls();
    assert.ok(urls.includes(`${site.url}/a`) && urls.includes(`${site.url}/b`), urls.join(' '));

    // The extension reconnects by itself; selection survives, control starts detached.
    const again = await next;
    const tabs = await again.request({ op: 'listTabs' });
    assert.deepEqual(tabs.map((x: { tabId: number }) => x.tabId).sort(), [local, created].sort());
  });
});

// Opening DevTools may cut chrome.debugger. Either control goes on, or the detach reaches the Puente.
async function frameOrDetach(u: Usual, tabId: number) {
  const conn = await u.puente.connection;
  const outcome = await conn
    .request({ op: 'act', tabId, action: { type: 'frame', maxWidth: 320 } })
    .then(() => 'ok', (e: Error) => e.message);
  const detached = await conn.event((e) => e.event === 'detached' && e.tabId === tabId, 1000).catch(() => null);
  return { outcome, detached };
}

test(`[${BROWSER.name}] DevTools already open on the tab: control goes on or the detach is reported`, async (t) => {
  await withUsual(['--auto-open-devtools-for-tabs'], async (u) => {
    const tab = await u.localTab(`${site.url}/form`);
    t.diagnostic(`DevTools windows open before attaching: ${await u.devtoolsCount()}`);
    await u.userShares(tab);
    const r = await frameOrDetach(u, tab);
    t.diagnostic(`act: ${r.outcome}; detached event: ${JSON.stringify(r.detached)}`);
    assert.ok(r.outcome === 'ok' || r.detached);
  });
});

test(`[${BROWSER.name}] DevTools opened on an attached tab: control goes on or the detach is reported`, async (t) => {
  await withUsual([], async (u) => {
    const tab = await u.localTab(`${site.url}/form`);
    await u.userShares(tab);
    assert.equal((await frameOrDetach(u, tab)).outcome, 'ok');
    await u.localOpensDevtools(tab);
    await until(async () => (await u.devtoolsCount()) === 1);
    const r = await frameOrDetach(u, tab);
    t.diagnostic(`act after DevTools opened: ${r.outcome}; detached event: ${JSON.stringify(r.detached)}`);
    assert.ok(r.outcome === 'ok' || r.detached);
  });
});

test(`[${BROWSER.name}] detaching is reported (internal page, tab closed)`, async (t) => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    const relay = await conn.request({ op: 'openTab', url: `${site.url}/a` });
    await conn.request({ op: 'act', tabId: relay, action: { type: 'frame', maxWidth: 320 } });
    const toInternal = conn.event((e) => e.event === 'detached' && e.tabId === relay);
    await u.localNavigates(relay, 'chrome://version');
    t.diagnostic(`internal page: ${JSON.stringify(await toInternal)}`);
    const internal = await u.inWorker(
      `chrome.debugger.attach({ tabId: ${relay} }, '1.3').then(() => 'attached', (e) => e.message)`,
    );
    t.diagnostic(`attach to chrome://version: ${internal}`);
    assert.notEqual(internal, 'attached');

    const other = await conn.request({ op: 'openTab', url: `${site.url}/b` });
    await conn.request({ op: 'act', tabId: other, action: { type: 'frame', maxWidth: 320 } });
    const closed = conn.event((e) => e.event === 'detached' && e.tabId === other);
    await u.localCloses(other);
    assert.equal((await closed).reason, 'target_closed');
  });
});

test(`[${BROWSER.name}] the open native port keeps the extension worker alive past the 30 s idle limit`, async () => {
  await withUsual([], async (u) => {
    const conn = await u.puente.connection;
    let reconnected = false;
    void u.puente.nextConnection().then(() => (reconnected = true));
    // Deliberate wall-clock wait: the claim is about Chrome's own 30 s idle timer for extension
    // workers, which no fake clock reaches. Nothing attaches to the worker meanwhile.
    await sleep(40_000);
    assert.deepEqual(await conn.request({ op: 'listTabs' }), []);
    assert.equal(reconnected, false, 'the same host connection is still serving');
  });
});
