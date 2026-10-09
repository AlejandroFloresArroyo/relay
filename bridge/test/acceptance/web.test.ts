// Acceptance, scenario 4 of docs/relay-v3.md §7: a fake web app opened inside Relay and outside it,
// with navigation, a form, an upload, a download and its SSE and WebSocket dev channel; the external
// authorization lasts one hour on the Server's clock, is never renewed by use nor lengthened by a
// wall clock set back, opens neither the control API nor another app, and its open streams are cut
// when it expires, is cancelled or its device is revoked; a Puente restart ends it.
// Real: the Puente (createApp as main.ts), discovery from /proc/net/tcp, the per-app listeners, two
// apps in their own processes (support/acceptance_web.ts). Simulated, and recorded as a limitation:
// the Tailscale Service publisher (real Services and their HTTPS are pending in the tailnet console)
// and therefore the `Host` and `X-Forwarded-Proto: https` that Serve would send, set here by hand
// (support/fake_web.ts). The Server's clocks are driven by the test. Edge cases (suspension, pending
// cap, races, malformed input) are bridge/test/remoteWeb.test.ts; the app's viewer is #91's suites.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WEB_ACCESS_CODE_PATTERN, WEB_ENTRY_PATH, WEB_PENDING_COOKIE, WEB_SESSION_COOKIE } from '../../../protocol/remoteWeb.ts';
import { acceptanceLab, assertLogsClean, PHONE, SKIP, TABLET, until, type Device } from '../../support/acceptance_lab.ts';
import { nextData, stream, upgrade, web, type WebResponse } from '../../support/fake_web.ts';
import { createLinuxSockets } from '../../src/remote/linuxSockets.ts';

const APP = fileURLToPath(new URL('../../support/acceptance_web.ts', import.meta.url));
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document', accept: 'text/html' };
const own = (origin: string, cookie: string) => ({ origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie });
const CODE = new RegExp(WEB_ACCESS_CODE_PATTERN.slice(1, -1));
/** docs/relay-v3.md §2: one hour from the grant, written out so a change of WEB_LIMITS goes red here. */
const HOUR = 60 * 60 * 1000;
const NOTE = 'nota-secreta ñandú €';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const cookieOf = (response: WebResponse, name: string) => ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((line) => line.startsWith(`${name}=`));

interface WebApp { id: string; name: string; address: string; port: number; origin: string }
/** A fake app process: its folder, its port, and what it printed (`hit`, `closed sse`, `closed ws`). */
interface LocalApp { dir: string; port: number; hits(): number; closed(kind: 'sse' | 'ws'): number }
/** An open SSE response and HMR socket through a listener: both still open, or both seen cut (the socket closing, no data). */
interface DevChannel { open(): boolean; cut(): boolean }

test('scenario 4: a web app inside and outside Relay; one hour, never renewed, scoped to its app, cut on expiry, cancel and revocation', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);

  /** A dev server the person started in a folder of theirs: its own process, an ephemeral loopback port. */
  async function startApp(name: string): Promise<LocalApp> {
    const dir = path.join(lab.dirs.home, name);
    await fs.mkdir(dir);
    const child = spawn(process.execPath, [APP, name], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    lab.closers.push(async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    });
    const lines: string[] = [];
    const port = Promise.withResolvers<number>();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => {
      for (const line of text.split('\n').filter(Boolean)) {
        lines.push(line);
        if (line.startsWith('listening ')) port.resolve(Number(line.split(' ')[1]));
      }
    });
    child.once('exit', (code) => port.reject(new Error(`${name} exited with ${code}`)));
    const count = (line: string) => lines.filter((seen) => seen === line).length;
    return { dir, port: await port.promise, hits: () => count('hit'), closed: (kind: 'sse' | 'ws') => count(`closed ${kind}`) };
  }
  const appA = await startApp('app-a');
  const appB = await startApp('app-b');

  // The Server's clocks: monotonic for deadlines and the timers on it, and wall time (remoteWeb.test.ts).
  const clock = { monotonic: 0, wall: Date.now() };
  const timers = new Set<{ at: number; run: () => void }>();
  const timer = (ms: number, run: () => void) => {
    const entry = { at: clock.monotonic + ms, run };
    timers.add(entry);
    return () => { timers.delete(entry); };
  };
  const advance = (ms: number) => {
    clock.monotonic += ms;
    clock.wall += ms;
    for (const entry of [...timers]) if (entry.at <= clock.monotonic && timers.delete(entry)) entry.run();
  };
  const clocks = { now: () => clock.wall, monotonic: () => clock.monotonic, timer };
  let puente = await lab.puente(clocks);
  const control = (method: string, route: string, body?: unknown, device: Device = PHONE) => puente.call(device, method, route, body, 'web/1');
  const listener = (app: WebApp) => lab.publisher.services.get(new URL(app.origin).hostname.split('.')[0]!)!;

  // ---- 1. Discovery from the real socket table: both apps, never a control service nor the Puente.
  const candidates = (await control('GET', '/v1/remote/web/candidates')).json.candidates as { address: string; port: number; process: { name: string; directory: string } }[];
  for (const app of [appA, appB]) {
    const found = candidates.find((candidate) => candidate.port === app.port);
    assert.deepEqual(found && [found.address, found.process.directory], ['127.0.0.1', app.dir], JSON.stringify(candidates));
  }
  const puentePort = Number(new URL(puente.base).port);
  // Hermes API, Hermes dashboard and the Puente (docs/v3-install.md «Registro de aplicaciones»), written
  // out here: reading the product's own list would follow a mutation of it.
  const controlPorts = [8642, 9119, 8650, puentePort];
  assert.deepEqual(candidates.filter((candidate) => controlPorts.includes(candidate.port)), []);
  // What this machine really has listening there, read as discovery reads it: the exclusion is not vacuous.
  const observed = (await createLinuxSockets().listening()).filter((socket) => controlPorts.includes(socket.port));
  t.diagnostic(`control sockets of this account seen in /proc/net/tcp: ${observed.map((socket) => `${socket.address}:${socket.port}`).join(', ')}`);
  assert.ok(observed.some((socket) => socket.port === puentePort), 'the lab Puente is in the socket table and still not offered');
  assert.equal(appA.hits() + appB.hits(), 0, 'discovery never connects to a port');
  for (const port of controlPorts) {
    const refused = await control('POST', '/v1/remote/web/apps', { requestId: `acc-web-ctl-${port}`, name: 'Control', address: '127.0.0.1', port });
    assert.equal(refused.status, 404, `port ${port} is never registrable`);
  }
  const register = async (name: string, port: number) => {
    const registered = await control('POST', '/v1/remote/web/apps', { requestId: `acc-web-${port}`, name, address: '127.0.0.1', port });
    assert.equal(registered.status, 200, JSON.stringify(registered.json));
    return registered.json as WebApp;
  };
  const a = await register('App A', appA.port);
  const b = await register('App B', appB.port);
  assert.notEqual(a.origin, b.origin);
  assert.ok(![listener(a), listener(b)].includes(appA.port) && listener(a) !== listener(b), 'each app has its own listener, never the app\'s port');
  const again = (await control('GET', '/v1/remote/web/candidates')).json.candidates as { port: number }[];
  assert.ok(!again.some((candidate) => [listener(a), listener(b)].includes(candidate.port)), 'listeners are never candidates');

  // ---- 2. Inside Relay: the viewer posts the single-use ticket to the entry path of the app's origin.
  const opened = await control('POST', `/v1/remote/web/apps/${a.id}/open`, { path: '/docs/guia?seccion=2' });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.deepEqual([opened.json.origin, opened.json.entryPath], [a.origin, WEB_ENTRY_PATH]);
  const ticketBody = `ticket=${opened.json.ticket}`;
  const entryHeaders = { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' };
  const entered = await web(listener(a), a.origin, 'POST', WEB_ENTRY_PATH, entryHeaders, ticketBody);
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.location, '/docs/guia?seccion=2');
  const relayLine = cookieOf(entered, WEB_SESSION_COOKIE)!;
  assert.match(relayLine, /^__Host-RelayWeb=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  const relay = relayLine.split(';')[0]!;
  assert.equal((await web(listener(a), a.origin, 'POST', WEB_ENTRY_PATH, entryHeaders, ticketBody)).status, 401, 'a ticket is single use');
  // Host and scheme must be the app's own Service.
  assert.equal((await web(listener(a), b.origin, 'GET', '/', { ...NAV, cookie: relay })).status, 421);
  // Navigate: the deep path, the home page (its own cookie passes), a redirect to its loopback port.
  const guide = await web(listener(a), a.origin, 'GET', '/docs/guia?seccion=2', { ...NAV, cookie: relay });
  assert.equal(guide.status, 200);
  assert.match(guide.text, /Guía \?seccion=2/);
  const home = await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: relay });
  assert.equal(home.status, 200);
  assert.match(home.text, /<h1>app-a<\/h1>/);
  assert.equal(cookieOf(home, 'app_sesion'), 'app_sesion=propia; Path=/; HttpOnly');
  const back = await web(listener(a), a.origin, 'GET', '/volver', { ...NAV, cookie: relay });
  assert.deepEqual([back.status, back.headers.location], [302, `${a.origin}/docs/guia`]);
  // A form: the exact own Origin is required, the body arrives as typed, Relay's cookie does not.
  const relayAndApp = `${relay}; app_sesion=propia`;
  const formBody = `nota=${encodeURIComponent(NOTE)}`;
  const formHeaders = { ...own(a.origin, relayAndApp), 'content-type': 'application/x-www-form-urlencoded' };
  const form = await web(listener(a), a.origin, 'POST', '/form', formHeaders, formBody);
  assert.equal(form.status, 200);
  const formSeen = JSON.parse(form.text);
  assert.equal(new URLSearchParams(formSeen.form).get('nota'), NOTE);
  assert.equal(formSeen.headers.cookie, 'app_sesion=propia', 'Relay\'s cookie never reaches the app');
  assert.equal((await web(listener(a), a.origin, 'POST', '/form', { ...formHeaders, origin: b.origin }, formBody)).status, 403, 'a sibling app cannot post');
  // An upload (multipart, 1 MiB) and a download, byte for byte.
  const file = randomBytes(1024 * 1024);
  const boundary = `relay${randomBytes(8).toString('hex')}`;
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archivo"; filename="subida.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploaded = await web(listener(a), a.origin, 'POST', '/upload', { ...own(a.origin, relay), 'content-type': `multipart/form-data; boundary=${boundary}` }, multipart);
  assert.equal(uploaded.status, 200);
  assert.deepEqual([JSON.parse(uploaded.text).bytes, JSON.parse(uploaded.text).sha256], [multipart.length, sha256(multipart)]);
  const downloaded = await web(listener(a), a.origin, 'GET', '/download', { ...NAV, cookie: relay });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['content-disposition'], 'attachment; filename="informe.bin"');
  assert.equal(sha256(downloaded.body), sha256(Buffer.alloc(512 * 1024, 'informe-')));

  /** The dev channel: SSE events and a WebSocket-like HMR socket, both live and both observed ending. */
  async function devChannel(origin: string, port: number, cookie: string): Promise<DevChannel> {
    const events = await stream(port, origin, '/sse', own(origin, cookie));
    assert.equal(events.headers['content-type'], 'text/event-stream');
    assert.match(await events.first, /^data: app-[ab]-conectado\n\n$/);
    let eventsOpen = true;
    void events.ended.then(() => { eventsOpen = false; });
    // With the app's own cookie beside Relay's: only the app's crosses.
    const hmr = await upgrade(port, origin, '/hmr', own(origin, `${cookie}; app_sesion=propia`));
    assert.equal(hmr.status, 101);
    const echo = nextData(hmr.socket!);
    hmr.socket!.write('ping');
    assert.equal(await echo, 'eco:ping');
    const cookieSeen = nextData(hmr.socket!);
    hmr.socket!.write('cookie?');
    assert.equal(await cookieSeen, 'cookie:app_sesion=propia', 'the upgrade does not carry Relay\'s cookies either');
    let socketEnd: string | null | undefined;
    void nextData(hmr.socket!).then((data) => { socketEnd = data; });
    return { open: () => eventsOpen && socketEnd === undefined, cut: () => !eventsOpen && socketEnd === null };
  }
  /** Both client ends cut, and the app saw both of its ends close. */
  async function cut(channel: DevChannel, app: LocalApp, before: { sse: number; ws: number }) {
    await until(() => channel.cut(), 'the client ends of SSE and WebSocket were cut', 15_000);
    await until(() => app.closed('sse') > before.sse && app.closed('ws') > before.ws, 'the app\'s ends of SSE and WebSocket closed', 15_000);
  }
  const ends = (app: LocalApp) => ({ sse: app.closed('sse'), ws: app.closed('ws') });
  const inRelay = await devChannel(a.origin, listener(a), relay);

  // ---- 3. Outside Relay: the phone's own browser, its cookie jar is what the test passes along.
  async function visit(app: WebApp, cookie?: string) {
    const page = await web(listener(app), app.origin, 'GET', '/', cookie ? { ...NAV, cookie } : NAV);
    assert.equal(page.status, 401);
    const code = CODE.exec(page.text)?.[0];
    assert.ok(code, 'the access page shows a code');
    return { code, pending: cookieOf(page, WEB_PENDING_COOKIE)?.split(';')[0] ?? cookie ?? '' };
  }
  const authorizations = (app: WebApp, device: Device = PHONE) => control('GET', `/v1/remote/web/apps/${app.id}/authorizations`, undefined, device);
  async function grant(app: WebApp, code: string, device: Device = PHONE) {
    const request = (await authorizations(app, device)).json.requests.find((candidate: { code: string }) => candidate.code === code);
    assert.ok(request, `request ${code} is listed`);
    return { request: request.id as string, granted: await control('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code }, device) };
  }
  const secrets: string[] = [PHONE.key, TABLET.key, opened.json.ticket, relay.split('=')[1]!, NOTE, encodeURIComponent(NOTE), formBody, appA.dir, appB.dir,
    new URL(a.origin).host, new URL(b.origin).host, 'docs/guia', 'seccion', 'informe', 'subida', 'app_sesion', boundary];
  /** The whole handoff: access page, the person compares the code and grants, that browser reloads once. */
  async function authorize(app: WebApp, device: Device = PHONE) {
    const asked = await visit(app);
    const { request, granted } = await grant(app, asked.code, device);
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    const redeemed = await web(listener(app), app.origin, 'GET', '/', { ...NAV, cookie: asked.pending });
    assert.equal(redeemed.status, 303);
    const line = cookieOf(redeemed, WEB_SESSION_COOKIE)!;
    const session = line.split(';')[0]!;
    secrets.push(asked.code, asked.pending.split('=')[1]!, session.split('=')[1]!, request);
    return { asked, request, granted: granted.json, redeemed, line, session };
  }

  const first = await authorize(a);
  assert.equal(first.granted.expiresAt - first.granted.grantedAt, HOUR);
  assert.equal(first.granted.redeemed, false);
  assert.match(first.line, new RegExp(`; Max-Age=${HOUR / 1000}$`));
  assert.equal(cookieOf(first.redeemed, WEB_PENDING_COOKIE), `${WEB_PENDING_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  assert.equal((await control('POST', `/v1/remote/web/apps/${a.id}/authorizations`, { request: first.request, code: first.asked.code })).status, 404, 'granted once');
  // Single use: the spent secret is a new request with a new code, never a second session.
  const replay = await visit(a, first.asked.pending);
  assert.notEqual(replay.code, first.asked.code);
  secrets.push(replay.code, replay.pending.split('=')[1]!);
  // Another browser that only read the public code gets its own access page.
  assert.notEqual((await visit(a)).code, first.asked.code);
  const external = first.session;
  assert.equal((await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: external })).status, 200);
  const extForm = await web(listener(a), a.origin, 'POST', '/form', { ...own(a.origin, `${external}; ${first.asked.pending}; app_sesion=propia`), 'content-type': 'application/x-www-form-urlencoded' }, formBody);
  assert.equal(extForm.status, 200);
  assert.equal(JSON.parse(extForm.text).headers.cookie, 'app_sesion=propia', 'neither Relay cookie reaches the app');

  // No access to another app: B's listener does not know A's session and asks for its own authorization.
  assert.equal((await web(listener(b), b.origin, 'GET', '/', own(b.origin, external))).status, 401);
  assert.equal((await upgrade(listener(b), b.origin, '/hmr', own(b.origin, external))).status, 401);
  secrets.push((await visit(b, external)).code);
  assert.equal(appB.hits(), 0, 'nothing reached app B');
  // No access to the control API: neither the cookie nor its value as a key opens it.
  for (const extra of [{ Cookie: external }, { Authorization: `Bearer ${external.split('=')[1]}` }] as Record<string, string>[]) {
    for (const route of ['/v1/remote/web/apps', `/v1/remote/web/apps/${a.id}/authorizations`, '/v1/remote/environments']) {
      const response = await fetch(puente.base + route, { headers: { 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'web/1', ...extra } });
      assert.equal(response.status, 401, route);
      // A key that works resets the per-address failure count (auth.ts): six refusals in a row would rate-limit the lab.
      assert.equal((await control('GET', '/v1/remote/web/apps')).status, 200);
    }
  }
  // And a /v1 path on the app's origin is the app's own, never the Puente's.
  const v1 = JSON.parse((await web(listener(a), a.origin, 'GET', '/v1/remote/web/apps', own(a.origin, external))).text);
  assert.deepEqual([v1.app, v1.url], ['app-a', '/v1/remote/web/apps']);

  // The hour: SSE and WebSocket open, the wall clock set back a day, used all along, never renewed.
  let base = ends(appA);
  const hour = await devChannel(a.origin, listener(a), external);
  clock.wall -= 24 * 60 * 60_000;
  advance(HOUR / 2);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: external })).status, 200);
  advance(HOUR / 2 - 1);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: external })).status, 200, 'the last millisecond of the hour');
  assert.ok(hour.open(), 'open streams stay open within the hour');
  const listedLate = (await authorizations(a)).json.authorizations;
  assert.deepEqual(listedLate.map((entry: { id: string; expiresAt: number; redeemed: boolean }) => [entry.id, entry.expiresAt, entry.redeemed]),
    [[first.request, first.granted.expiresAt, true]], 'use did not move the end');
  advance(1);
  await cut(hour, appA, base);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', own(a.origin, external))).status, 401);
  assert.equal((await upgrade(listener(a), a.origin, '/hmr', own(a.origin, external))).status, 401);
  secrets.push((await visit(a, external)).code); // asked again, visibly
  assert.deepEqual((await authorizations(a)).json.authorizations, []);
  await until(async () => (await lab.changes()).some((change) => change.action === 'remote.web.expired'), 'the expiry is recorded', 15_000);
  assert.ok(inRelay.open(), 'the in-Relay session is not the external hour');

  // Cancelling from Relay cuts what is open at once.
  const second = await authorize(a);
  base = ends(appA);
  const cancelled = await devChannel(a.origin, listener(a), second.session);
  assert.deepEqual((await control('POST', `/v1/remote/web/apps/${a.id}/authorizations/${second.request}/cancel`)).json, { ok: true });
  await cut(cancelled, appA, base);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', own(a.origin, second.session))).status, 401);

  // Revoking the tablet cuts its external authorization (of B) and its in-Relay session (of A); the phone's stay.
  const tabletExternal = await authorize(b, TABLET);
  const baseB = ends(appB);
  const tabletB = await devChannel(b.origin, listener(b), tabletExternal.session);
  const tabletTicket = (await control('POST', `/v1/remote/web/apps/${a.id}/open`, { path: '/' }, TABLET)).json.ticket as string;
  secrets.push(tabletTicket);
  const tabletEntry = await web(listener(a), a.origin, 'POST', WEB_ENTRY_PATH, entryHeaders, `ticket=${tabletTicket}`);
  const tabletRelay = cookieOf(tabletEntry, WEB_SESSION_COOKIE)!.split(';')[0]!;
  secrets.push(tabletRelay.split('=')[1]!);
  base = ends(appA);
  const tabletA = await devChannel(a.origin, listener(a), tabletRelay);
  await lab.revoke(TABLET);
  await cut(tabletB, appB, baseB);
  await cut(tabletA, appA, base);
  assert.equal((await web(listener(b), b.origin, 'GET', '/', own(b.origin, tabletExternal.session))).status, 401);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', own(a.origin, tabletRelay))).status, 401);
  assert.equal((await control('GET', '/v1/remote/web/apps', undefined, TABLET)).status, 403, 'device_revoked');
  assert.ok(inRelay.open(), 'the phone\'s session and streams stay');
  assert.equal((await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: relay })).status, 200);

  // ---- A Puente restart: sessions and authorizations lived in memory; the registry and its origins stay.
  const third = await authorize(a);
  base = ends(appA);
  puente.close();
  await cut(inRelay, appA, base);
  puente = await lab.puente(clocks);
  assert.deepEqual((await control('GET', '/v1/remote/web/apps')).json.apps.map((app: WebApp) => [app.id, app.origin]).sort(), [[a.id, a.origin], [b.id, b.origin]].sort());
  assert.equal((await web(listener(a), a.origin, 'GET', '/', own(a.origin, third.session))).status, 401);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', own(a.origin, relay))).status, 401);
  const asked = await visit(a, third.session);
  secrets.push(asked.code);
  assert.deepEqual((await authorizations(a)).json.authorizations, [], 'nothing survives the restart');
  const fourth = await authorize(a);
  assert.equal((await web(listener(a), a.origin, 'GET', '/', { ...NAV, cookie: fourth.session })).status, 200, 're-authorized');

  t.diagnostic('limitation: Tailscale Services are simulated (support/fake_web.ts); Host and X-Forwarded-Proto are set as Serve would send them, not observed from Serve');
  // Nothing of the above in the Puente's lines: web listener lines carry the app ID, method and status only.
  assertLogsClean(lab.logs, secrets);
  assert.ok(lab.logs.some((line) => /^web app_[A-Za-z0-9_-]+ POST 303$/.test(line)), lab.logs.join('\n'));
  assert.ok(lab.logs.some((line) => line.startsWith('POST /v1/remote/web/apps/:id/authorizations 200')), lab.logs.join('\n'));
  for (const line of lab.supervisorOutput) for (const secret of secrets) assert.ok(!line.includes(secret), line);
});
