// Dedicated Server browser over CDP: its own non-default profile, driven only through the bounded
// actions. Runs against the browser named by RELAY_LAB_BROWSER (cft, chromium, chrome).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BROWSER, launch, sleep, until, type Browser, type Page } from '../lib/browser.ts';
import { serveFixtures, type Fixtures } from '../lib/fixtures.ts';
import { perform, prepare, validateAction } from '../extension/actions.js';

let site: Fixtures;
before(async () => {
  site = await serveFixtures();
});
after(() => site.close());

const act = (page: Page, action: unknown) => perform(validateAction(action), page.send);

async function center(page: Page, selector: string) {
  const { result } = await page.send('Runtime.evaluate', {
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    returnByValue: true,
  });
  return result.value as { x: number; y: number };
}

async function read(page: Page, expression: string) {
  const { result } = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

async function withBrowser(opts: Parameters<typeof launch>[0], fn: (b: Browser) => Promise<void>) {
  const b = await launch(opts);
  try {
    await fn(b);
  } finally {
    await b.close();
  }
}

test(`[${BROWSER.name}] the default profile refuses remote debugging`, async (t) => {
  await withBrowser({ transport: 'port', profile: 'default', mode: 'headful' }, async (b) => {
    t.diagnostic(`stderr: ${b.stderr().split('\n').find((l) => /DevTools/.test(l)) ?? '(no DevTools line)'}`);
    t.diagnostic(`profile dirs created under the synthetic HOME: ${readdirSync(join(b.home, '.config')).join(', ')}`);
    assert.equal(b.wsUrl, null, 'CDP must not listen on the default profile');
  });
});

test(`[${BROWSER.name}] a dedicated profile reports its exact version`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const v = await b.cdp.send('Browser.getVersion');
    t.diagnostic(`product=${v.product} protocol=${v.protocolVersion} jsVersion=${v.jsVersion}`);
    assert.match(v.product, new RegExp(`/${BROWSER.version.replaceAll('.', '\\.')}$`));
  });
});

test(`[${BROWSER.name}] frame, tap, text and keys reach the page`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/form`);
    await prepare(page.send);
    const frame = await act(page, { type: 'frame', maxWidth: 800, quality: 60 });
    t.diagnostic(`frame ${frame.width}x${frame.height} jpeg ${frame.bytes} bytes`);
    assert.equal(Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    assert.ok(frame.width <= 800);

    const field = await center(page, '#t');
    await act(page, { type: 'tap', ...field });
    await act(page, { type: 'text', text: 'hola ñ' });
    await act(page, { type: 'key', key: 'Backspace' });
    await act(page, { type: 'text', text: 'ñ ✓' });
    await act(page, { type: 'key', key: 'Enter' });
    assert.equal(await read(page, 'window.submitted'), 'hola ñ ✓');
    assert.equal(await read(page, 'window.clicks'), 1);

    // Raw touch input exists too, for the catalogue; the protocol maps taps to the mouse.
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [field] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await read(page, 'window.touches'), 1);

    const before = await read(page, 'scrollY');
    await act(page, { type: 'scroll', x: 10, y: 10, dx: 0, dy: 400 });
    await until(async () => (await read(page, 'scrollY')) > before);
  });
});

test(`[${BROWSER.name}] tabs can be listed, opened, activated and closed`, async () => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const a = await b.cdp.send('Target.createTarget', { url: `${site.url}/a` });
    const c = await b.cdp.send('Target.createTarget', { url: `${site.url}/b` });
    const pageIds = async () =>
      (await b.cdp.send('Target.getTargets')).targetInfos
        .filter((x: { type: string }) => x.type === 'page')
        .map((x: { targetId: string }) => x.targetId);
    const ids = await pageIds();
    assert.ok(ids.includes(a.targetId) && ids.includes(c.targetId));
    await b.cdp.send('Target.activateTarget', { targetId: a.targetId });
    await b.cdp.send('Target.closeTarget', { targetId: c.targetId });
    await until(async () => !(await pageIds()).includes(c.targetId));
  });
});

test(`[${BROWSER.name}] navigate, back, forward and reload`, async () => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/a`);
    await prepare(page.send);
    const title = (want: string) => until(async () => (await read(page, 'document.title')) === want);
    await act(page, { type: 'navigate', url: `${site.url}/b` });
    await title('B');
    assert.deepEqual(await act(page, { type: 'back' }), { moved: true });
    await title('A');
    await act(page, { type: 'forward' });
    await title('B');
    const n = await read(page, 'window.loads');
    await act(page, { type: 'reload' });
    await until(async () => (await read(page, 'window.loads').catch(() => 0)) === n + 1);
  });
});

test(`[${BROWSER.name}] reconnecting over the port finds the same tabs alive`, async () => {
  await withBrowser({ transport: 'port' }, async (b) => {
    assert.ok(b.wsUrl);
    const { targetId } = await b.cdp.send('Target.createTarget', { url: `${site.url}/a` });
    b.cdp.close();
    await until(async () => b.cdp.closed);
    const again = await b.reconnect();
    const { targetInfos } = await again.send('Target.getTargets');
    assert.ok(targetInfos.some((x: { targetId: string }) => x.targetId === targetId));
  });
});

test(`[${BROWSER.name}] closing the CDP pipe keeps the browser and its tabs alive`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    await b.cdp.send('Target.createTarget', { url: `${site.url}/a` });
    b.cdp.close();
    // Deliberate wall-clock wait: the claim is "still alive some time after the pipe closed",
    // and the browser emits nothing observable that would let the test wait on it instead.
    await sleep(3000);
    t.diagnostic(`exitCode after pipe close: ${b.proc.exitCode} signal: ${b.proc.signalCode}`);
    assert.equal(b.proc.exitCode, null, 'browser must survive the Puente losing its pipe');
  });
});

test(`[${BROWSER.name}] the dedicated profile keeps its data across restarts`, async () => {
  let dir = '';
  await withBrowser({ transport: 'pipe', keepProfile: true }, async (b) => {
    dir = b.profileDir;
    const page = await b.newPage(`${site.url}/a`);
    await read(page, `localStorage.setItem('relay', 'kept'), document.cookie = 'c=1; max-age=3600'`);
    await b.cdp.send('Browser.close');
    await b.exited;
  });
  await withBrowser({ transport: 'pipe', profile: dir }, async (b) => {
    const page = await b.newPage(`${site.url}/a`);
    assert.equal(await read(page, `localStorage.getItem('relay')`), 'kept');
    assert.equal(await read(page, 'document.cookie'), 'c=1');
  });
  rmSync(dirname(dir), { recursive: true, force: true });
});

test(`[${BROWSER.name}] JavaScript dialogs are reported and answered`, async () => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/form`);
    await prepare(page.send);
    for (const [kind, action, expected] of [
      ['alert', { type: 'dialog', accept: true }, 'alert:undefined'],
      ['confirm', { type: 'dialog', accept: false }, 'confirm:false'],
      ['prompt', { type: 'dialog', accept: true, text: 'sí' }, 'prompt:sí'],
    ] as const) {
      const opened = page.waitEvent('Page.javascriptDialogOpening');
      // Fire without waiting: the evaluation blocks until the dialog is answered.
      void page.send('Runtime.evaluate', { expression: `setTimeout(() => window.ask('${kind}'), 0)` });
      const ev = await opened;
      assert.equal(ev.type, kind);
      await act(page, action);
      await until(async () => (await read(page, 'window.answer')) === expected);
    }
  });
});

test(`[${BROWSER.name}] file choosers are intercepted and filled with Server files`, async () => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/form`);
    await prepare(page.send);
    const chooser = page.waitEvent('Page.fileChooserOpened');
    await act(page, { type: 'tap', ...(await center(page, '#f')) });
    const ev = await chooser;
    await act(page, { type: 'files', backendNodeId: ev.backendNodeId, paths: [site.uploadPath] });
    assert.equal(await read(page, 'window.picked'), 'upload.txt');
  });
});

test(`[${BROWSER.name}] downloads stay on the Server in a known folder`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const folder = join(b.profileDir, '..', 'downloads');
    await b.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder, eventsEnabled: true });
    const page = await b.newPage(`${site.url}/form`);
    await prepare(page.send);
    const begin = b.cdp.waitEvent('Browser.downloadWillBegin');
    const done = b.cdp.waitEvent('Browser.downloadProgress', (e) => e.state === 'completed');
    await act(page, { type: 'tap', ...(await center(page, '#dl')) });
    const { suggestedFilename } = await begin;
    const { receivedBytes } = await done;
    t.diagnostic(`downloaded ${suggestedFilename} ${receivedBytes} bytes`);
    assert.ok(existsSync(join(folder, suggestedFilename)));
    assert.equal(readFileSync(join(folder, suggestedFilename), 'utf8'), site.downloadBody);
  });
});

test(`[${BROWSER.name}] a native <select> is operated with keys, not by its popup`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/form`);
    await prepare(page.send);
    const closed = await act(page, { type: 'frame', maxWidth: 400, quality: 50 });
    await act(page, { type: 'tap', ...(await center(page, '#s')) });
    // Deliberate wait: give a native popup time to paint before the second frame; nothing signals it.
    await sleep(300);
    const open = await act(page, { type: 'frame', maxWidth: 400, quality: 50 });
    t.diagnostic(`frame with popup requested is ${open.data === closed.data ? 'identical' : 'different'} to closed frame`);
    await act(page, { type: 'key', key: 'ArrowDown' });
    await act(page, { type: 'key', key: 'Enter' });
    assert.equal(await read(page, 'document.querySelector("#s").value'), 'dos');
  });
});

test(`[${BROWSER.name}] screencast frames need an ack each (flow control)`, async (t) => {
  await withBrowser({ transport: 'pipe' }, async (b) => {
    const page = await b.newPage(`${site.url}/anim`);
    let frames = 0;
    let bytes = 0;
    let ack = false;
    let last = 0;
    page.on('Page.screencastFrame', (e) => {
      frames++;
      bytes += e.data.length;
      last = e.sessionId;
      if (ack) void page.send('Page.screencastFrameAck', { sessionId: e.sessionId });
    });
    await page.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 800, maxHeight: 800 });
    // Deliberate wall-clock windows: the measurement is a frame rate over real time.
    await sleep(1500);
    const unacked = frames;
    t.diagnostic(`frames without ack in 1.5 s: ${unacked}`);
    assert.ok(unacked >= 1 && unacked <= 3, 'without ack the browser must stop sending');
    ack = true;
    await page.send('Page.screencastFrameAck', { sessionId: last });
    await sleep(1500);
    await page.send('Page.stopScreencast');
    const acked = frames - unacked;
    t.diagnostic(`frames with ack in 1.5 s: ${acked}, mean ${Math.round((bytes * 3) / 4 / frames)} bytes`);
    assert.ok(acked > unacked);
  });
});
