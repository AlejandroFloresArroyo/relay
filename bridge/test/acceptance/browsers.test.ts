// Acceptance, scenario 5 of docs/relay-v3.md §7: control pages of a dedicated Chrome/Chromium and of
// the habitual one, without copying sessions; local coexistence, visible disconnection and the dialogs
// Relay cannot answer identified. Plus scenario 2's clause for the browser: revoking ends the device's
// own browser and keeps the habitual one with every tab, also those Relay opened. Everything real
// (support/acceptance_lab.ts): the supervisor process with a real browser in a systemd scope, the
// Puente over HTTP as the app speaks to it, and, opt-in like habitualBrowserReal.test.ts
// (RELAY_LAB_BROWSER=cft|chrome, labs/v3-cdp), the Relay extension and its native host in a test
// browser with a throwaway profile. Pages are synthetic, on 127.0.0.1 with an ephemeral port.
// Details stay with the narrower suites: remoteBrowser.test.ts (bounds, ownership, limits),
// browserSystemd.test.ts (scope, pipe, profile across launches), habitualBrowserReal.test.ts (host loss,
// Puente restart, the person's own chooser) and the app's Browser.component.test.tsx.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BROWSER as LAB_BROWSER, attachPage, launch, type Page } from '../../../labs/v3-cdp/lib/browser.ts';
import type { BrowserStreamEvent, BrowserTab } from '../../../protocol/remoteBrowser.ts';
import { EXTENSION_DIRECTORY, listenExtension, NATIVE_HOST_BROWSERS, RELAY_EXTENSION_ID, registerNativeHost } from '../../src/remote/habitualBrowser.ts';
import { acceptanceLab, assertLogsClean, labBrowser, PHONE, SKIP, TABLET, until, type Device, type OutputStream } from '../../support/acceptance_lab.ts';

type Closers = (() => Promise<void> | void)[];
/** The lab Puente's `browser` request: `/v1/remote/browsers/<route>` with `browser/1`. */
type BrowserCall = (device: Device, method: string, route: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
type Frame = Extract<BrowserStreamEvent, { type: 'frame' }>;
const ofType = <T extends BrowserStreamEvent['type']>(stream: OutputStream, type: T) =>
  stream.events.filter((event): event is Extract<BrowserStreamEvent, { type: T }> => event.type === type);
const lastTabs = (stream: OutputStream) => ofType(stream, 'tabs').at(-1)?.tabs ?? [];
const secret = (name: string) => `${name}-${randomBytes(6).toString('hex')}`;

/** The pages: controls at fixed places (taps in CSS pixels), each reporting to the server what it received. */
async function site(closers: Closers) {
  /** `<path> <v>` of every request: what the page received. */
  const seen: string[] = [];
  /** Cookie headers of the isolation probe, by the browser that loaded it (`?by=`). */
  const cookies = new Map<string, string[]>();
  const download = { name: `${secret('informe')}.txt`, body: secret('contenido-descargado') };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    seen.push(`${url.pathname} ${url.searchParams.get('v') ?? ''}`);
    const by = url.searchParams.get('by');
    if (by) cookies.set(by, [...cookies.get(by) ?? [], req.headers.cookie ?? '']);
    const cookie = url.searchParams.get('cookie');
    const html = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...cookie ? { 'Set-Cookie': `${cookie}; Max-Age=3600; Path=/` } : {} });
      res.end(`<!doctype html><meta charset=utf-8>${body}`);
    };
    switch (url.pathname) {
      case '/':
        return html(`<title>Principal</title><style>body{margin:0;height:5000px}.c{position:fixed;left:0;width:200px;height:40px;margin:0}</style>
<input class=c id=t style=top:0 oninput="fetch('/typed?v='+encodeURIComponent(this.value))">
<a class=c id=dl style=top:50px href=/file download>bajar</a>
<button class=c style=top:100px onclick="fetch('/answer?v='+confirm('¿Seguro?'))">confirmar</button>
<button class=c style=top:150px onclick="alert('aviso');fetch('/alerted')">avisar</button>
<button class=c style=top:200px onclick="fetch('/prompted?v='+encodeURIComponent(prompt('¿Nombre?','nadie')))">preguntar</button>
<input class=c type=file id=f style=top:250px onchange="fetch('/picked?v='+encodeURIComponent(this.files[0].name))">
<button class=c style=top:300px onmousedown="alert('pulsado');fetch('/pressed')">pulsar</button>
<script>addEventListener('scroll',()=>fetch('/scrolled?v='+Math.round(scrollY)));fetch('/ready')</script>`);
      case '/two': return html('<title>Dos</title>dos');
      // A login of the site, as each browser carries it; the image proves the cookie is stored, and sent
      // on a subresource too.
      case '/iso': return html(`<title>Iso</title><img src="/iso-probe?by=${by}">`);
      case '/file':
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${download.name}"` });
        return res.end(download.body);
      // A native dialog of the browser itself (HTTP authentication), never a JavaScript one.
      case '/auth':
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="relay-acc"', 'Content-Type': 'text/html' });
        return res.end('<title>Sin acceso</title>401');
      default: res.writeHead(204); return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, cookies, download, saw: (entry: string) => seen.includes(entry) };
}

/**
 * The person's own browser on the account's default profile (`~/.config/<browser>` of the lab's home,
 * the account the supervisor runs as): it opens `url`, waits for `loaded`, and quits as a person quits
 * it, so the profile is written. A signal right after the load lost the cookie in this lab: the test's
 * pipe asks `Browser.close`. Chrome refuses that pipe on what it takes for its default directory, so this
 * one process gets another XDG_CONFIG_HOME; the profile is still where the account's default one lives.
 */
async function personBrowser(closers: Closers, home: string, binary: string, profile: string, url: string, loaded: () => boolean) {
  const child = spawn(binary, ['--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', url], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.person-config'), XDG_CACHE_HOME: path.join(home, '.cache'), DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
  });
  // Its pipe resets when it quits: nothing to read from it.
  for (const end of [child.stdio[3], child.stdio[4]]) end!.on('error', () => {});
  (child.stdio[4] as Readable).resume();
  const exited = once(child, 'exit');
  const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
  closers.push(kill);
  try {
    await until(loaded, 'the person\'s browser loaded the page', 30_000);
  } finally {
    (child.stdio[3] as Writable).write(`${JSON.stringify({ id: 1, method: 'Browser.close' })}\0`);
    if (await Promise.race([exited.then(() => true), sleep(20_000, false, { ref: false })]) === false) kill();
  }
}

/** The view the app asks for and the frames it acks, as BrowserTool does. */
function viewer(browser: BrowserCall, device: Device, id: string, stream: OutputStream) {
  let acked = 0;
  const ack = async () => {
    const last = ofType(stream, 'frame').at(-1);
    if (last && last.seq > acked) {
      acked = last.seq;
      await browser(device, 'POST', `${id}/ack`, { channel: stream.channel(), seq: acked });
    }
  };
  return {
    ack,
    /** A view of `tab`, then its next frame, acking as frames come. */
    async show(tab: string): Promise<Frame> {
      const before = ofType(stream, 'frame').length;
      const view = await browser(device, 'POST', `${id}/view`, { channel: stream.channel(), tab, width: 400, height: 600 });
      assert.equal(view.status, 200, JSON.stringify(view.json));
      let frame: Frame | undefined;
      // 45 s: a habitual capture that hangs is retried after the link's 20 s request timeout.
      await until(async () => { await ack(); return Boolean(frame = ofType(stream, 'frame').slice(before).find((each) => each.tab === tab)); }, 'a frame of the tab in view', 45_000);
      assert.equal(Buffer.from(frame!.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG');
      return frame!;
    },
  };
}

const DEDICATED = [
  { binary: '/usr/bin/chromium', profile: 'chromium' },
  { binary: '/usr/bin/google-chrome-stable', profile: 'google-chrome' },
].map((each) => {
  let version: string | null = null;
  try { version = execFileSync(each.binary, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* missing */ }
  return { ...each, version, skip: SKIP || (version ? false : `${each.binary} is not installed`) };
});

for (const { binary, profile, version, skip } of DEDICATED) {
  test(`scenario 5, dedicated [${version ?? binary}]: pages controlled through frames and bounded actions, dialogs answered, limits identified, files through the Server, no session copied; disconnecting keeps it, terminating empties its scope`, { skip, timeout: 180_000 }, async (t) => {
    t.diagnostic(`dedicated browser: ${version}`);
    const lab = await acceptanceLab(t, { browser: binary });
    const pages = await site(lab.closers);
    const puente = await lab.puente();

    // The person's own login, in the account's default profile of this browser, before Relay opens anything.
    const personProfile = path.join(lab.dirs.home, '.config', profile);
    const personCookie = secret('person_session');
    await personBrowser(lab.closers, lab.dirs.home, binary, personProfile, `${pages.url}/iso?by=person-login&cookie=${personCookie}=1`, () => (pages.cookies.get('person-login')?.length ?? 0) >= 2);
    // Control: the person's profile does carry it, so its absence below means something.
    await personBrowser(lab.closers, lab.dirs.home, binary, personProfile, `${pages.url}/iso?by=person`, () => (pages.cookies.get('person')?.length ?? 0) >= 2);
    assert.ok(pages.cookies.get('person')!.every((header) => header.includes(personCookie)), JSON.stringify(pages.cookies.get('person')));

    // The app opens the dedicated browser: own, running, available.
    const status = await puente.call(PHONE, 'GET', '/v1/remote/status', undefined, 'browser/1');
    assert.deepEqual(status.json.browser.dedicated, { state: 'available' });
    const created = await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'acc-browser-dedicated', kind: 'browser_dedicated' });
    assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.json));
    const id = created.json.id as string;
    assert.deepEqual((await puente.list(PHONE)).map((each) => [each.id, each.kind, each.ownership, each.state]), [[id, 'browser_dedicated', 'own', 'running']]);

    // Its profile lives in the supervisor's state, never in the person's: every process of its scope says so.
    const pids = await lab.scopeProcs(id);
    assert.ok(pids.length > 1, 'the browser runs in its environment scope');
    const cmdlines = await Promise.all(pids.map((pid) => fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then((text) => text.replaceAll('\0', ' '), () => '')));
    const ownProfile = path.join(lab.dirs.state, 'browsers', PHONE.id, 'profile');
    const mainPid = pids[cmdlines.findIndex((line) => line.includes(`--user-data-dir=${ownProfile} `) && !line.includes('--type='))]!;
    assert.ok(mainPid, cmdlines.join('\n'));
    assert.ok(cmdlines.every((line) => !line.includes(personProfile)), 'nothing runs on the person\'s profile');

    // No session copied: the dedicated browser's requests to the same site carry none of the person's cookies.
    const isolation = await puente.browser(PHONE, 'POST', `${id}/tabs`, { url: `${pages.url}/iso?by=dedicated` });
    assert.equal(isolation.status, 200, JSON.stringify(isolation.json));
    await until(() => (pages.cookies.get('dedicated')?.length ?? 0) >= 2, 'the dedicated browser loaded the probe', 30_000);
    assert.ok(pages.cookies.get('dedicated')!.every((header) => !header.includes(personCookie)), JSON.stringify(pages.cookies.get('dedicated')));
    assert.deepEqual((await puente.browser(PHONE, 'DELETE', `${id}/tabs/${isolation.json.id}`)).json, { ok: true });

    // A tab of Relay's own on the page.
    const opened = await puente.browser(PHONE, 'POST', `${id}/tabs`, { url: `${pages.url}/` });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    const tab = opened.json.id as string;
    assert.equal(opened.json.createdByRelay, true);
    const tabsNow = async () => (await puente.browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[];
    /** Loads of the main page that ran its script: the page is there to take input. */
    const ready = () => pages.seen.filter((entry) => entry === '/ready ').length;
    await until(() => ready() === 1, 'the page loaded', 30_000);
    await until(async () => !(await tabsNow()).some((each) => each.id === isolation.json.id), 'the probe tab closed', 30_000);
    assert.deepEqual((await tabsNow()).map((each) => [each.url, each.limitation, each.createdByRelay]), [['about:blank', null, false], [`${pages.url}/`, null, true]]);
    // The tab carries the page's title, not its host and port.
    await until(async () => (await tabsNow()).find((each) => each.id === tab)?.title === 'Principal', 'the tab took the page title', 10_000);

    // The frames stream: tab state first, then JPEG frames of the tab in view, at its size in CSS pixels.
    let stream = await puente.frames(PHONE, id);
    assert.equal(stream.status, 200);
    await until(() => stream.channel() !== '' && ofType(stream, 'tabs').length > 0, 'open and tabs', 30_000);
    let view = viewer(puente.browser, PHONE, id, stream);
    assert.deepEqual((await view.show(tab)).viewport, { width: 400, height: 600 });

    const act = (action: unknown) => puente.browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, action);
    const listed = async () => ((await puente.browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[]).find((each) => each.id === tab)!;
    const typed = secret('hola ñ✓');
    // Tap the field, type (IME text, accents), press a key of the bar.
    assert.deepEqual((await act({ type: 'tap', x: 100, y: 20 })).json, {});
    assert.deepEqual((await act({ type: 'text', text: typed })).json, {});
    await until(() => pages.saw(`/typed ${typed}`), 'the page received the text', 20_000);
    assert.deepEqual((await act({ type: 'key', key: 'Backspace' })).json, {});
    await until(() => pages.saw(`/typed ${typed.slice(0, -1)}`), 'the page received Backspace', 20_000);
    // Scroll: the page moves under the finger.
    assert.deepEqual((await act({ type: 'scroll', x: 300, y: 400, dx: 0, dy: 600 })).json, {});
    await until(() => pages.seen.some((entry) => entry.startsWith('/scrolled ') && Number(entry.split(' ')[1]) > 0), 'the page scrolled', 20_000);

    // JavaScript dialogs: listed on the stream, everything else waits, answered with Relay's controls.
    // The tap that opens one answers at once (Input.dispatchMouseEvent alone would wait on the dialog).
    const dialogOf = async () => (await listed()).dialog;
    /** A tap that opens a dialog: answered well before the supervisor's 15 s CDP deadline. */
    const dialogTap = async (y: number) => {
      const started = Date.now();
      assert.deepEqual((await act({ type: 'tap', x: 100, y })).json, {});
      assert.ok(Date.now() - started < 10_000, `the tap answered in ${Date.now() - started} ms`);
    };
    await dialogTap(120);
    await until(() => lastTabs(stream).some((each) => each.id === tab && each.dialog?.type === 'confirm'), 'the confirm is on the stream', 20_000);
    assert.deepEqual(await dialogOf(), { type: 'confirm', message: '¿Seguro?', defaultPrompt: '' });
    assert.equal((await act({ type: 'tap', x: 1, y: 1 })).json.error.code, 'remote_conflict', 'nothing else while a dialog waits');
    assert.deepEqual((await act({ type: 'dialog', accept: false })).json, {});
    await until(() => pages.saw('/answer false'), 'the page got the answer', 20_000);
    await dialogTap(170);
    await until(async () => (await dialogOf())?.type === 'alert', 'alert listed', 20_000);
    assert.deepEqual((await act({ type: 'dialog', accept: true })).json, {});
    await until(() => pages.saw('/alerted '), 'the alert was closed', 20_000);
    await dialogTap(220);
    await until(async () => (await dialogOf())?.type === 'prompt', 'prompt listed', 20_000);
    assert.deepEqual(await dialogOf(), { type: 'prompt', message: '¿Nombre?', defaultPrompt: 'nadie' });
    const answer = secret('Ale');
    assert.deepEqual((await act({ type: 'dialog', accept: true, text: answer })).json, {});
    await until(() => pages.saw(`/prompted ${answer}`), 'the prompt was answered', 20_000);
    assert.equal(await dialogOf(), null);
    // A dialog on the press: the rest of the tap is let go instead of waiting on it.
    await dialogTap(320);
    await until(async () => (await dialogOf())?.message === 'pulsado', 'the press dialog listed', 20_000);
    assert.deepEqual((await act({ type: 'dialog', accept: true })).json, {});
    await until(() => pages.saw('/pressed '), 'the press dialog was closed', 20_000);
    assert.deepEqual((await act({ type: 'tap', x: 100, y: 20 })).json, {}, 'the page takes taps again');

    // A file of the phone: uploaded to the Server by the files transfer, then it fills the page's chooser.
    const photoName = `${secret('foto')}.txt`;
    const uploaded = await puente.upload(PHONE, lab.dirs.home, photoName, Buffer.from(secret('del-telefono')));
    assert.deepEqual((await act({ type: 'tap', x: 100, y: 270 })).json, {});
    await until(async () => (await listed()).fileChooser !== null, 'the chooser is listed', 20_000);
    assert.deepEqual((await listed()).fileChooser, { multiple: false });
    assert.deepEqual((await act({ type: 'files', paths: [uploaded] })).json, {});
    await until(() => pages.saw(`/picked ${photoName}`), 'the page got the phone\'s file', 20_000);

    // A download stays on the Server; the stream names it and the phone brings it by the files transfer.
    assert.deepEqual((await act({ type: 'tap', x: 100, y: 70 })).json, {});
    await until(() => ofType(stream, 'download').length > 0, 'the download is on the stream', 30_000);
    const [download] = ofType(stream, 'download');
    assert.deepEqual(download, { type: 'download', name: pages.download.name, path: path.join(lab.dirs.downloads, pages.download.name) });
    assert.equal((await puente.download(PHONE, download!.path)).toString(), pages.download.body);

    // Navigation: another page, back, reload.
    assert.deepEqual((await act({ type: 'navigate', url: `${pages.url}/two` })).json, {});
    await until(async () => (await listed()).url === `${pages.url}/two`, 'navigated', 20_000);
    await until(() => lastTabs(stream).some((each) => each.id === tab && each.title === 'Dos'), 'the new title is on the stream', 10_000);
    assert.deepEqual((await act({ type: 'back' })).json, { moved: true });
    await until(async () => (await listed()).url === `${pages.url}/`, 'went back', 20_000);
    const loads = ready();
    assert.deepEqual((await act({ type: 'reload' })).json, {});
    await until(() => ready() > loads, 'the page reloaded', 20_000);

    // Relay never takes the dedicated browser to a page it cannot control: other schemes are refused before
    // reaching it. Chromium keeps pages from going to chrome:, file: or data:, and a blob: page the page
    // itself opened never loaded here, so the dedicated limitation is left to remoteBrowser.test.ts (double);
    // the habitual part below reaches a real internal page.
    for (const url of ['chrome://settings/', 'file:///etc/hostname', 'javascript:alert(1)']) {
      assert.equal((await act({ type: 'navigate', url })).json.error.code, 'remote_invalid_request', url);
      assert.equal((await puente.browser(PHONE, 'POST', `${id}/tabs`, { url })).json.error.code, 'remote_invalid_request', url);
    }

    // A native dialog of the browser (HTTP authentication) is no JavaScript dialog: headless, the dedicated
    // browser shows the error page, lists no dialog and keeps taking actions (ADR 0006 «Límites conocidos»).
    assert.deepEqual((await act({ type: 'navigate', url: `${pages.url}/auth` })).json, {});
    await until(async () => pages.saw('/auth ') && (await listed()).url.endsWith('/auth'), 'the authentication page', 20_000);
    assert.deepEqual([(await listed()).dialog, (await listed()).limitation], [null, null]);
    assert.deepEqual((await act({ type: 'back' })).json, { moved: true });
    await until(async () => (await listed()).url === `${pages.url}/`, 'back from the authentication page', 20_000);

    // Disconnecting (the stream closes: screen locked, app hidden) keeps the browser and its tabs.
    stream.close();
    await stream.ended;
    await until(() => lab.logs.some((line) => line.startsWith('GET /v1/remote/browsers/:id/frames 200')), 'the stream ended', 20_000);
    assert.deepEqual((await puente.list(PHONE)).map((each) => [each.id, each.state]), [[id, 'running']]);
    assert.ok((await lab.scopeProcs(id)).includes(mainPid), 'the same browser process');
    stream = await puente.frames(PHONE, id);
    await until(() => ofType(stream, 'tabs').length > 0, 'reopened with its tabs', 30_000);
    assert.ok(lastTabs(stream).some((each) => each.id === tab && each.url === `${pages.url}/` && each.createdByRelay));
    view = viewer(puente.browser, PHONE, id, stream);
    await view.show(tab);

    // Terminating (confirmed) ends the browser: the stream says so and its scope is empty.
    const ended = await puente.terminate(PHONE, id);
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    await stream.ended;
    assert.deepEqual(stream.events.at(-1), { type: 'closed', reason: 'exited' });
    await until(async () => (await lab.scopeProcs(id)).length === 0, 'the scope is empty', 30_000);
    await fs.access(ownProfile);

    const secrets = [PHONE.key, pages.url, typed, typed.slice(0, -1), answer, personCookie, photoName, uploaded, pages.download.name, pages.download.body, lab.dirs.home, id, tab, isolation.json.id];
    assertLogsClean(lab.logs, secrets);
    for (const line of lab.supervisorOutput) for (const each of secrets) assert.ok(!line.includes(each), line);
  });
}

/** The lab's browser name as registerNativeHost names it. */
const REGISTERED: Record<string, string> = { cft: 'chrome-for-testing', chrome: 'google-chrome', chromium: 'chromium' };
const HABITUAL_SKIP = SKIP || (process.env.RELAY_LAB_BROWSER ? false : 'needs a test browser: RELAY_LAB_BROWSER=cft|chrome (labs/v3-cdp)');

test(`scenario 5, habitual [${process.env.RELAY_LAB_BROWSER ? `${LAB_BROWSER.name} ${LAB_BROWSER.version}` : 'none'}] and scenario 2: only the shared tab, alongside the person; visible limits; revoking keeps the browser and every tab and ends the own one`, { skip: HABITUAL_SKIP, timeout: 180_000 }, async (t) => {
  const lab = await acceptanceLab(t, { browser: await labBrowser() });
  const pages = await site(lab.closers);
  const state = path.join(lab.dirs.root, 'habitual');
  const config = path.join(lab.dirs.root, 'config');
  await fs.mkdir(state, { mode: 0o700 });
  /** The extension socket's own lines. */
  const linkLogs: string[] = [];
  const link = await listenExtension({ stateDirectory: state, log: (line) => linkLogs.push(line), requestTimeoutMs: 20_000 });
  lab.closers.push(() => link.close());
  const puente = await lab.puente({ habitual: link });
  const registered = REGISTERED[LAB_BROWSER.name]!;
  await registerNativeHost({ stateDirectory: state, configHome: config, browser: registered, nodePath: process.execPath });
  const extension = fileURLToPath(EXTENSION_DIRECTORY);
  const loadByCdp = LAB_BROWSER.name === 'chrome';
  const browser = await launch({
    transport: 'pipe', mode: 'headful', profile: path.join(config, NATIVE_HOST_BROWSERS[registered]!),
    args: loadByCdp ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`],
  });
  lab.closers.push(() => browser.close());
  if (loadByCdp) assert.equal((await browser.cdp.send('Extensions.loadUnpacked', { path: extension })).id, RELAY_EXTENSION_ID);
  t.diagnostic(`habitual browser: ${LAB_BROWSER.name} ${LAB_BROWSER.version}`);
  await until(async () => (await puente.call(PHONE, 'GET', '/v1/remote/status', undefined, 'browser/1')).json.browser.habitual.state === 'available', 'the extension reached the Puente through its host', 30_000);

  // The person at the computer, through the test's own CDP pipe (the oracle production does not have).
  const cdp = browser.cdp;
  let worker: Page | null = null;
  const inWorker = async (expression: string): Promise<unknown> => {
    if (!worker) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      worker = await attachPage(cdp, targetInfos.find((each: { type: string; url: string }) => each.type === 'service_worker' && each.url === `chrome-extension://${RELAY_EXTENSION_ID}/background.js`).targetId);
    }
    const { result, exceptionDetails } = await worker.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const targetOf = async (tabId: number) => await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${tabId})?.id)`) as string;
  const sessions = new Map<number, Page>();
  const person = async (tabId: number) => {
    if (!sessions.has(tabId)) sessions.set(tabId, await attachPage(cdp, await targetOf(tabId)));
    return sessions.get(tabId)!;
  };
  const evalIn = async (tabId: number, expression: string) => (await (await person(tabId)).send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const localTab = async (url: string) => {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    let tabId: number | undefined;
    await until(async () => Boolean(tabId = await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.id === ${JSON.stringify(targetId)})?.tabId)`) as number | undefined), 'tab id', 20_000);
    await until(async () => (await inWorker(`chrome.tabs.get(${tabId}).then((t) => t.status)`)) === 'complete', 'tab loaded', 20_000);
    return tabId!;
  };
  const active = (tabId: number) => inWorker(`chrome.tabs.get(${tabId}).then((t) => t.active)`);
  const attached = async (tabId: number) => await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${tabId})?.attached ?? false)`) as boolean;
  const tabIds = async () => await inWorker('chrome.tabs.query({}).then((ts) => ts.map((t) => t.id).sort((a, b) => a - b))') as number[];

  // The person's login on the site, in the habitual profile, set by the tab they will share.
  const habitualCookie = secret('habitual_session');
  const shared = await localTab(`${pages.url}/?cookie=${habitualCookie}=1`);
  const own = await localTab(`${pages.url}/`);
  await cdp.send('Target.activateTarget', { targetId: await targetOf(own) });
  await inWorker(`relayToggle(${shared})`);

  const habitual = await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'acc-browser-habitual', kind: 'browser_habitual' });
  assert.ok(habitual.status === 200 || habitual.status === 201, JSON.stringify(habitual.json));
  const id = habitual.json.id as string;
  assert.deepEqual((await puente.list(PHONE)).map((each) => [each.id, each.kind, each.ownership, each.state]), [[id, 'browser_habitual', 'shared', 'running']]);
  // Only the tab the person chose is listed and reachable.
  assert.deepEqual(((await puente.browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[]).map((each) => [each.id, each.createdByRelay, each.limitation]), [[String(shared), false, null]]);
  assert.equal((await puente.browser(PHONE, 'POST', `${id}/tabs/${own}/action`, { type: 'reload' })).json.error.code, 'remote_not_found');

  const stream = await puente.frames(PHONE, id);
  assert.equal(stream.status, 200);
  await until(() => stream.channel() !== '', 'stream open', 30_000);
  const view = viewer(puente.browser, PHONE, id, stream);
  await view.show(String(shared));
  const act = (tab: number, action: unknown) => puente.browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, action);

  // Coexistence: Relay types into its tab in the background while the person types into the one in front.
  const relayText = secret('relay-escribe ñ');
  const personText = secret('persona');
  assert.deepEqual((await act(shared, { type: 'tap', x: 100, y: 20 })).json, {});
  assert.deepEqual((await act(shared, { type: 'text', text: relayText })).json, {});
  await evalIn(own, `document.querySelector('#t').focus()`);
  await (await person(own)).send('Input.insertText', { text: personText });
  await until(() => pages.saw(`/typed ${relayText}`) && pages.saw(`/typed ${personText}`), 'both pages received their own text', 20_000);
  assert.equal(await evalIn(shared, `document.querySelector('#t').value`), relayText);
  assert.equal(await evalIn(own, `document.querySelector('#t').value`), personText);
  assert.deepEqual([await active(own), await active(shared)], [true, false], 'the person\'s tab stays in front');

  // A JavaScript dialog on the shared tab, in the background: listed and answered from Relay. As in the
  // dedicated browser, the tap that opens it answers at once.
  const started = Date.now();
  assert.deepEqual((await act(shared, { type: 'tap', x: 100, y: 120 })).json, {});
  assert.ok(Date.now() - started < 10_000, `the tap answered in ${Date.now() - started} ms`);
  await until(async () => { await view.ack(); return lastTabs(stream).some((each) => each.id === String(shared) && each.dialog?.type === 'confirm'); }, 'the confirm is on the stream', 20_000);
  assert.deepEqual((await act(shared, { type: 'dialog', accept: true })).json, {});
  await until(() => pages.saw('/answer true'), 'the page got the answer', 20_000);

  // Relay opens a tab: behind the person's, marked as Relay's, with the habitual profile's own login.
  const opened = await puente.browser(PHONE, 'POST', `${id}/tabs`, { url: `${pages.url}/iso?by=habitual` });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.createdByRelay, true);
  const relayTab = Number(opened.json.id);
  await until(() => (pages.cookies.get('habitual')?.length ?? 0) >= 2, 'the new tab loaded', 20_000);
  assert.ok(pages.cookies.get('habitual')!.every((header) => header.includes(habitualCookie)), 'the habitual browser is the person\'s own session');
  assert.deepEqual([await active(relayTab), await active(own)], [false, true], 'opened in the background');
  await view.show(String(relayTab));

  // What this mode cannot do is said, never a silent no-op: Relay closes no tab of the person's browser.
  const close = await puente.browser(PHONE, 'DELETE', `${id}/tabs/${relayTab}`);
  assert.deepEqual([close.status, close.json.error.code], [422, 'remote_unsupported']);
  const blank = await puente.browser(PHONE, 'POST', `${id}/tabs`, {});
  assert.deepEqual([blank.status, blank.json.error.code], [422, 'remote_unsupported']);

  // DevTools at the computer on the shared tab does not take it (#78, ADR 0006 «Lo que fijó #93»).
  await cdp.send('Target.openDevTools', { targetId: await targetOf(shared) });
  await view.show(String(shared));
  // The person goes to a page of the browser itself: Relay loses the tab, and the stream says why.
  await (await person(shared)).send('Page.navigate', { url: 'chrome://version' });
  await until(async () => { await view.ack(); return lastTabs(stream).some((each) => each.id === String(shared) && each.limitation === 'internal_page'); }, 'the limitation is on the stream', 30_000);
  const limited = await act(shared, { type: 'tap', x: 1, y: 1 });
  assert.deepEqual([limited.status, limited.json.error.code], [409, 'remote_browser_limited']);

  // The phone's own dedicated browser, beside it: none of the habitual profile's sessions in it.
  const dedicated = (await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'acc-browser-own', kind: 'browser_dedicated' })).json.id as string;
  assert.equal((await puente.browser(PHONE, 'POST', `${dedicated}/tabs`, { url: `${pages.url}/iso?by=dedicated` })).status, 200);
  await until(() => (pages.cookies.get('dedicated')?.length ?? 0) >= 2, 'the dedicated browser loaded the probe', 30_000);
  assert.ok(pages.cookies.get('dedicated')!.every((header) => !header.includes(habitualCookie)), JSON.stringify(pages.cookies.get('dedicated')));
  const dedicatedStream = await puente.frames(PHONE, dedicated);
  await until(() => dedicatedStream.channel() !== '', 'the dedicated stream open', 30_000);
  assert.ok((await lab.scopeProcs(dedicated)).length > 0);

  // Revoking the phone, with both streams open and Relay's tab in view: every channel is cut, its own
  // browser ends, and the habitual browser keeps every tab, also the one Relay opened.
  await view.show(String(relayTab));
  const all = await tabIds();
  assert.equal(await attached(relayTab), true);
  const cut = new Set<OutputStream>();
  for (const each of [stream, dedicatedStream]) void each.ended.then(() => cut.add(each));
  await lab.revoke(PHONE);
  // Cut at once by the Puente (ADR 0006 «Revocación»): the connection ends, with no `closed` event first.
  await until(() => cut.size === 2, 'both streams of the revoked device were cut', 20_000);
  for (const environment of [id, dedicated]) assert.equal((await puente.frames(PHONE, environment)).status, 403, 'no new channel for the revoked device');
  await until(async () => !(await attached(relayTab)), 'revoking let go of Relay\'s tab', 20_000);
  assert.deepEqual(await tabIds(), all, 'revoking closes nothing, not even the tab Relay opened');
  assert.ok(browser.proc.exitCode === null && browser.proc.signalCode === null, 'the habitual browser is still running');
  await until(async () => (await lab.scopeProcs(dedicated)).length === 0, 'the own browser ended', 30_000);
  assert.equal((await puente.browser(PHONE, 'GET', `${id}/tabs`)).json.error.code, 'device_revoked');
  assert.ok((await lab.changes()).some((change) => change.action === 'remote.browser.disconnected' && change.actor.kind === 'server' && change.target.id === id));
  // The person's choice stays: another device connects and finds the shared tab and Relay's.
  const tablet = (await puente.call(TABLET, 'POST', '/v1/remote/environments', { requestId: 'acc-browser-tablet', kind: 'browser_habitual' })).json.id as string;
  assert.deepEqual(((await puente.browser(TABLET, 'GET', `${tablet}/tabs`)).json.tabs as BrowserTab[]).map((each) => [each.id, each.createdByRelay]).sort(),
    [[String(shared), false], [String(relayTab), true]].sort());

  const secrets = [PHONE.key, TABLET.key, pages.url, relayText, personText, habitualCookie, 'chrome://version', id, dedicated, tablet];
  assertLogsClean(lab.logs, secrets);
  assert.ok(linkLogs.includes('Browser extension connected.'), linkLogs.join('\n'));
  for (const line of [...linkLogs, ...lab.supervisorOutput]) for (const each of secrets) assert.ok(!line.includes(each), line);
});
