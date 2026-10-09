// The web tool through the Puente: discovery, the registry of chosen apps, and the per-app listener
// that serves an app inside Relay (ADR 0006, docs/research/v3-proxy.md). Sockets and Services are
// doubles; the apps are fake servers on ephemeral loopback ports; everything else is real.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { WEB_ACCESS_CODE_PATTERN, WEB_ENTRY_PATH, WEB_LIMITS, WEB_PENDING_COOKIE, WEB_SESSION_COOKIE } from '../../protocol/remoteWeb.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import type { AppRegistry, ListeningSocket, ServicePublisher } from '../src/remote/ports.ts';
import { createWebApps, WALL_CHECK_MS } from '../src/remote/web.ts';
import { startWebListener } from '../src/remote/webListener.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { fakeSockets, nextData, raw, simulatedPublisher, socket, startFakeApp, stream, TAILNET, upgrade, web } from '../support/fake_web.ts';

const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const TABLET_KEY = `rly1_${Buffer.alloc(32, 8).toString('base64url')}`;
const DEVICE = '00000000-0000-4000-8000-000000000001';
const TABLET = '00000000-0000-4000-8000-000000000002';
const NOW = 1_700_000_000_000;
const CONTROL_PORT = 18650;
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document', accept: 'text/html' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' };

interface App { id: string; name: string; address: string; port: number; origin: string | null; createdAt: number }

async function start(t: TestContext, options: { directory?: string; registry?: AppRegistry & { sockets: ListeningSocket[] }; publisher?: ServicePublisher & { services: Map<string, number> } } = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  if (!options.directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory, now: () => NOW });
  if (!store.snapshot().devices.length) {
    await store.mutate((state) => {
      state.devices.push({ id: DEVICE, name: 'phone', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') });
      state.devices.push({ id: TABLET, name: 'tablet', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(TABLET_KEY).toString('hex') });
    });
  }
  const registry = options.registry ?? fakeSockets();
  const publisher = options.publisher ?? simulatedPublisher();
  // The Server's clocks: monotonic for deadlines and the timers on it, and wall time. `advance` moves
  // both and fires what falls due; a test moves one alone to simulate a suspension or a clock jump.
  const clock = { monotonic: 0, wall: NOW };
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
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const logs: string[] = [];
  const server = createApp({
    config: { corsOrigins: [], port: CONTROL_PORT },
    store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null },
    hostname: 'arch', version: '9.9.9', now: () => clock.wall, monotonic: () => clock.monotonic, timer, log: (line) => logs.push(line),
    remote: { web: { capability: { version: 1, minAppVersion: 1 }, port: { apps: registry, publisher } } },
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    runs.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);

  async function call(method: string, route: string, body?: unknown, key = KEY, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'web/1', ...extra };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }
  async function register(address: string, port: number, name = 'App A', requestId = randomBytes(12).toString('base64url')): Promise<App> {
    const response = await call('POST', '/v1/remote/web/apps', { requestId, name, address, port });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return response.json;
  }
  const listenerPort = (app: App) => publisher.services.get(new URL(app.origin!).hostname.split('.')[0]!)!;
  async function ticket(app: App, at = '/', key = KEY): Promise<string> {
    const opened = await call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: at }, key);
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.equal(opened.json.origin, app.origin);
    assert.equal(opened.json.entryPath, WEB_ENTRY_PATH);
    return opened.json.ticket;
  }
  const redeem = (app: App, value: string, port = listenerPort(app), origin = app.origin!) => web(port, origin, 'POST', WEB_ENTRY_PATH, FORM, `ticket=${value}`);
  /** Relay opens the app and its viewer enters: the session cookie. */
  async function enter(app: App, key = KEY): Promise<string> {
    const entered = await redeem(app, await ticket(app, '/', key));
    assert.equal(entered.status, 303);
    const line = ([] as string[]).concat(entered.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${WEB_SESSION_COOKIE}=`))!;
    return line.split(';')[0]!;
  }
  const own = (app: App, cookie: string) => ({ origin: app.origin!, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie });
  const revoke = (id = DEVICE) => store.mutate((state) => { state.devices.find((d) => d.id === id)!.revokedAt = NOW; });
  // External authorization: a browser of its own, its cookie jar is what the test passes along.
  const cookieOf = (response: { headers: { 'set-cookie'?: string[] } }, name: string) => ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  /** A browser navigates without a session: the access page, its pending cookie and the public code. */
  async function visit(app: App, at = '/', cookie?: string) {
    const page = await web(listenerPort(app), app.origin!, 'GET', at, cookie ? { ...NAV, cookie } : NAV);
    const code = new RegExp(WEB_ACCESS_CODE_PATTERN.slice(1, -1)).exec(page.text)?.[0] ?? null;
    const line = cookieOf(page, WEB_PENDING_COOKIE);
    return { page, code, line, pending: line?.split(';')[0] ?? cookie ?? '' };
  }
  const accessList = (app: App, key = KEY) => call('GET', `/v1/remote/web/apps/${app.id}/authorizations`, undefined, key);
  async function grant(app: App, code: string, key = KEY) {
    const listed = await accessList(app, key);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const request = listed.json.requests.find((r: { code: string }) => r.code === code);
    assert.ok(request, `request ${code} is listed`);
    return call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code }, key);
  }
  /** The whole handoff: access page, grant from Relay, redemption by that browser. */
  async function authorize(app: App, at = '/', key = KEY) {
    const asked = await visit(app, at);
    const granted = await grant(app, asked.code!, key);
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    const redeemed = await web(listenerPort(app), app.origin!, 'GET', at, { ...NAV, cookie: asked.pending });
    assert.equal(redeemed.status, 303);
    return { session: cookieOf(redeemed, WEB_SESSION_COOKIE)!.split(';')[0]!, granted: granted.json, redeemed, asked };
  }
  return { call, register, ticket, redeem, enter, own, listenerPort, revoke, registry, publisher, clock, advance, logs, directory, close, base, visit, accessList, grant, authorize, cookieOf };
}

const changes = async (directory: string) => (await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

// ---- Discovery and registry ----------------------------------------------------------------------

test('candidates are the account\'s loopback services, never control services, the Puente or other addresses', async (t) => {
  const app = await startFakeApp(t);
  const registry = fakeSockets([
    socket('127.0.0.1', app.port), socket('::1', 5174, '/home/user/dev/app-b'), socket('0.0.0.0', 3000, '/home/user/dev/c'),
    socket('::', 3001, '/home/user/dev/d'), socket('127.0.0.2', 4000, '/home/user/dev/e'),
    socket('100.64.0.5', 4001), socket('192.168.1.20', 4002), socket('::ffff:7f00:1', 4003),
    socket('127.0.0.1', 8642, '/home/user/.hermes'), socket('127.0.0.1', 9119, '/home/user/.hermes'), socket('0.0.0.0', 8650),
    socket('127.0.0.1', CONTROL_PORT), socket('127.0.0.1', 4500, '/srv/relay', process.pid),
    { address: '127.0.0.1', port: 4600, pid: null, process: null },
  ]);
  const h = await start(t, { registry });
  const listed = await h.call('GET', '/v1/remote/web/candidates');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.candidates.map((c: { address: string; port: number }) => `${c.address} ${c.port}`), [
    `127.0.0.1 ${app.port}`, '::1 5174', '127.0.0.1 3000', '::1 3001', '127.0.0.2 4000',
  ]);
  assert.deepEqual(listed.json.candidates[0].process, { name: 'node', directory: '/home/user/dev/app-a' });
  assert.equal(app.hits.length, 0, 'discovery never connects to a service');

  // The listener of a registered app is never a candidate either.
  const registered = await h.register('127.0.0.1', app.port);
  registry.sockets.push(socket('127.0.0.1', h.listenerPort(registered), '/elsewhere', 9999));
  const again = (await h.call('GET', '/v1/remote/web/candidates')).json.candidates;
  assert.ok(!again.some((c: { port: number }) => c.port === h.listenerPort(registered)));
});

test('registering accepts only a current candidate, once per target, idempotent by requestId', async (t) => {
  const registry = fakeSockets([socket('127.0.0.1', 5173), socket('127.0.0.1', 8642), socket('100.64.0.5', 4001), socket('::', 3001)]);
  const h = await start(t, { registry });
  const notFound = { code: 'remote_not_found', message: 'No existe en este Servidor.' };
  for (const [address, port] of [['127.0.0.1', 8642], ['100.64.0.5', 4001], ['127.0.0.1', 5999], ['localhost', 5173], ['::', 3001], ['0.0.0.0', 3001]] as const) {
    const refused = await h.call('POST', '/v1/remote/web/apps', { requestId: 'request-0001', name: 'x', address, port });
    assert.equal(refused.status, 404, `${address} ${port}`);
    assert.deepEqual(refused.json.error, notFound);
  }
  for (const body of [
    { requestId: 'request-0001', name: 'x', address: '127.0.0.1', port: 5173, url: 'http://127.0.0.1:5173' },
    { requestId: 'request-0001', name: 'x', url: 'http://127.0.0.1:5173/' },
    { requestId: 'short', name: 'x', address: '127.0.0.1', port: 5173 },
    { requestId: 'request-0001', name: ' ', address: '127.0.0.1', port: 5173 },
    { requestId: 'request-0001', name: 'a\u0000b', address: '127.0.0.1', port: 5173 },
    { requestId: 'request-0001', name: 'x'.repeat(WEB_LIMITS.nameChars + 1), address: '127.0.0.1', port: 5173 },
    { requestId: 'request-0001', name: 'x', address: '127.0.0.1', port: '5173' },
  ]) {
    assert.equal((await h.call('POST', '/v1/remote/web/apps', body)).status, 400, JSON.stringify(body));
  }
  const app = await h.register('127.0.0.1', 5173, 'Mi app', 'request-0001');
  assert.match(app.id, /^app_[A-Za-z0-9_-]{22,64}$/);
  assert.deepEqual({ ...app, id: undefined, origin: undefined }, { id: undefined, name: 'Mi app', address: '127.0.0.1', port: 5173, origin: undefined, createdAt: NOW });
  assert.match(app.origin!, new RegExp(`^https://relay-[a-z0-9]{16,}\\.${TAILNET.replaceAll('.', '\\.')}$`));
  assert.deepEqual(await h.register('127.0.0.1', 5173, 'Mi app', 'request-0001'), app, 'a retry answers the same app');
  const conflict = await h.call('POST', '/v1/remote/web/apps', { requestId: 'request-0001', name: 'Otra', address: '127.0.0.1', port: 5173 });
  assert.equal(conflict.status, 409);
  assert.equal((await h.call('POST', '/v1/remote/web/apps', { requestId: 'request-0002', name: 'Mi app', address: '127.0.0.1', port: 5173 })).status, 409);
  // A wildcard bind is served on loopback.
  const wildcard = await h.register('::1', 3001, 'Comodín');
  assert.equal(wildcard.address, '::1');
  assert.deepEqual((await h.call('GET', '/v1/remote/web/apps')).json.apps, [app, wildcard]);
  const log = await changes(h.directory);
  assert.deepEqual(log.filter((c) => c.action.startsWith('remote.web.')).map((c) => [c.action, c.actor.id, c.target.id]), [
    ['remote.web.registered', DEVICE, app.id], ['remote.web.registered', DEVICE, wildcard.id],
  ]);
  assert.ok(!JSON.stringify(log).includes('5173') && !JSON.stringify(log).includes('Mi app'));
});

test('a Server keeps at most the app limit', async (t) => {
  const ports = Array.from({ length: WEB_LIMITS.apps + 1 }, (_, index) => 5000 + index);
  const h = await start(t, { registry: fakeSockets(ports.map((port) => socket('127.0.0.1', port))) });
  for (const port of ports.slice(0, -1)) await h.register('127.0.0.1', port);
  const full = await h.call('POST', '/v1/remote/web/apps', { requestId: 'request-limit', name: 'x', address: '127.0.0.1', port: ports.at(-1) });
  assert.equal(full.status, 429);
  assert.equal(full.json.error.code, 'remote_limit_reached');
});

test('registering and forgetting check the device again before changing anything', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publisher = simulatedPublisher();
  const apps = createWebApps({
    registry: fakeSockets([socket('127.0.0.1', 5173), socket('127.0.0.1', 5174)]), publisher,
    store: await createDeviceStore({ directory, now: () => NOW }), now: () => NOW, monotonic: () => 0, log() {},
  });
  t.after(() => apps.shutdown());
  const actor = { kind: 'device', id: DEVICE, name: 'phone' } as const;
  // The device was revoked after it authenticated: the guard throws what the route answers.
  const revoked = () => { throw new Error('revoked'); };
  const kept = await apps.register(actor, { requestId: 'request-0001', name: 'A', address: '127.0.0.1', port: 5173 }, () => {});
  await assert.rejects(apps.register(actor, { requestId: 'request-0002', name: 'B', address: '127.0.0.1', port: 5174 }, revoked), /revoked/);
  await assert.rejects(apps.unregister(actor, kept.id, revoked), /revoked/);
  assert.deepEqual((await apps.list()).apps, [kept]);
  assert.equal(publisher.services.size, 1);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'web-apps.json'), 'utf8'));
  assert.deepEqual(saved.apps.map((app: App) => app.id), [kept.id]);
});

test('each app gets its own listener and Service name, never the app\'s port, and a name is never reused', async (t) => {
  const registry = fakeSockets([socket('127.0.0.1', 5173), socket('127.0.0.1', 5174, '/home/user/dev/app-b')]);
  const h = await start(t, { registry });
  const a = await h.register('127.0.0.1', 5173);
  const b = await h.register('127.0.0.1', 5174, 'App B');
  assert.notEqual(a.origin, b.origin);
  assert.equal(h.publisher.services.size, 2);
  for (const listener of h.publisher.services.values()) assert.ok(![5173, 5174, CONTROL_PORT].includes(listener));
  assert.notEqual(h.listenerPort(a), h.listenerPort(b));
  // Loopback only: another loopback address does not reach it, as no other interface does.
  const stray = net.connect(h.listenerPort(a), '127.0.0.2');
  await assert.rejects(once(stray, 'connect').finally(() => stray.destroy()), /ECONNREFUSED/);
  assert.deepEqual((await h.call('DELETE', `/v1/remote/web/apps/${a.id}`)).json, { ok: true });
  assert.equal(h.publisher.services.size, 1, 'forgetting an app removes only its Service');
  const again = await h.register('127.0.0.1', 5173);
  assert.notEqual(again.id, a.id);
  assert.notEqual(again.origin, a.origin, 'an origin with old caches and service workers is never given to a new registration');
  assert.equal((await h.call('DELETE', `/v1/remote/web/apps/${a.id}`)).status, 404);
  assert.equal((await h.call('GET', '/v1/remote/web/apps/nothing')).status, 404);
  assert.deepEqual((await changes(h.directory)).filter((c) => c.action === 'remote.web.unregistered').map((c) => c.target.id), [a.id]);
});

test('a blocked publication leaves the app registered, unpublished, and impossible to open', async (t) => {
  const publisher = simulatedPublisher();
  publisher.block = 'serve_disabled';
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', 5173)]), publisher });
  const app = await h.register('127.0.0.1', 5173);
  assert.equal(app.origin, null);
  const opened = await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' });
  assert.equal(opened.status, 503);
  assert.equal(opened.json.error.code, 'remote_unavailable');
});

test('opening validates the target\'s identity again and never switches target', async (t) => {
  const fake = await startFakeApp(t);
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const h = await start(t, { registry });
  const app = await h.register('127.0.0.1', fake.port);
  registry.sockets = [socket('127.0.0.1', fake.port, '/home/user/dev/other-app')];
  const other = await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' });
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, 'remote_conflict');
  registry.sockets = [{ ...socket('127.0.0.1', fake.port), process: { name: 'python', exe: '/usr/bin/python3', cwd: '/home/user/dev/app-a' } }];
  assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' })).status, 409);
  registry.sockets = [];
  const gone = await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' });
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error.code, 'remote_ended');
  // A restart of the same app (another PID, same program and folder) is the same app.
  registry.sockets = [socket('0.0.0.0', fake.port, '/home/user/dev/app-a', 5151)];
  await h.ticket(app);
  for (const at of ['//evil.example/', '/\\evil', 'https://evil.example/', 'relative', '/__relay/entrar', `/${'x'.repeat(WEB_LIMITS.pathChars)}`]) {
    assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: at })).status, 400, at);
  }
  assert.equal(fake.hits.length, 0);
});

test('an open path outside printable ASCII is refused and the listener keeps answering', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  for (const at of ['/日本', '/€', '/caf\u00e9', '/a\u2028b', '/a\tb']) {
    const opened = await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: at });
    assert.equal(opened.status, 400, at);
    assert.equal(opened.json.error.code, 'remote_invalid_request');
  }
  const encoded = encodeURI('/búsqueda/日本?q=€');
  const entered = await h.redeem(app, await h.ticket(app, encoded));
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.location, encoded);
});

test('a redeemed path the response cannot carry is answered and the listener stays up', async (t) => {
  const origin = `https://relay-0123456789abcdef.${TAILNET}`;
  const listener = await startWebListener({
    appId: 'app_x', target: { address: '127.0.0.1', port: 9 }, origin: () => origin, session: () => null,
    redeem: (ticket) => ({ token: 'token', path: ticket === 'roto' ? '/日本' : '/ok' }), access: { request: () => null, pending: () => null }, targetDown() {}, log() {},
  });
  t.after(() => listener.close());
  const post = (ticket: string) => web(listener.port, origin, 'POST', WEB_ENTRY_PATH, FORM, `ticket=${ticket}`);
  const broken = await post('roto');
  assert.equal(broken.status, 401);
  assert.equal(broken.headers['set-cookie'], undefined);
  const next = await post('bien');
  assert.equal(next.status, 303);
  assert.equal(next.headers.location, '/ok');
});

test('the registry survives a restart with its listener and origin; sessions do not', async (t) => {
  const fake = await startFakeApp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const publisher = simulatedPublisher();
  const first = await start(t, { directory, registry, publisher });
  const app = await first.register('127.0.0.1', fake.port);
  const listener = first.listenerPort(app);
  const cookie = await first.enter(app);
  await first.close();
  const second = await start(t, { directory, registry, publisher });
  assert.deepEqual((await second.call('GET', '/v1/remote/web/apps')).json.apps, [app]);
  assert.equal(second.listenerPort(app), listener);
  assert.equal((await web(listener, app.origin!, 'GET', '/', second.own(app, cookie))).status, 401, 'in-memory sessions end with the Puente');
  assert.equal((await web(listener, app.origin!, 'GET', '/', second.own(app, await second.enter(app)))).status, 200);
});

test('a registry file pointing outside loopback stops the web tool', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registry = fakeSockets([socket('127.0.0.1', 5173)]);
  const first = await start(t, { directory, registry });
  await first.register('127.0.0.1', 5173);
  await first.close();
  const file = path.join(directory, 'web-apps.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.apps[0].address = '10.0.0.5';
  await fs.writeFile(file, `${JSON.stringify(saved)}\n`);
  const second = await start(t, { directory, registry });
  const listed = await second.call('GET', '/v1/remote/web/apps');
  assert.equal(listed.status, 503);
  assert.equal(listed.json.error.code, 'remote_unavailable');
});

test('a corrupt registry file stops the web tool without touching the file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'web-apps.json'), '{"schemaVersion":1,"apps":[{"id":"x"}]}\n', { mode: 0o600 });
  const h = await start(t, { directory });
  const listed = await h.call('GET', '/v1/remote/web/apps');
  assert.equal(listed.status, 503);
  assert.equal(listed.json.error.code, 'remote_unavailable');
  assert.equal(await fs.readFile(path.join(directory, 'web-apps.json'), 'utf8'), '{"schemaVersion":1,"apps":[{"id":"x"}]}\n');
});

// ---- The listener ----------------------------------------------------------------------------------

test('the in-Relay entry is single use, bound to its app, short-lived, and gives a host-only session', async (t) => {
  const a = await startFakeApp(t);
  const b = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', a.port), socket('127.0.0.1', b.port, '/home/user/dev/app-b')]) });
  const appA = await h.register('127.0.0.1', a.port);
  const appB = await h.register('127.0.0.1', b.port, 'App B');

  const forB = await h.ticket(appB);
  assert.equal((await h.redeem(appA, forB)).status, 401, 'a ticket for B does not enter A');
  assert.equal((await h.redeem(appA, 'inventado')).status, 401);

  const value = await h.ticket(appA, '/deep/a?x=1');
  const entered = await h.redeem(appA, value);
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.location, '/deep/a?x=1');
  assert.equal(entered.headers['cache-control'], 'no-store');
  const line = ([] as string[]).concat(entered.headers['set-cookie']!).find((c) => c.startsWith(`${WEB_SESSION_COOKIE}=`))!;
  assert.match(line, /^__Host-RelayWeb=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  assert.ok(!line.includes(value));
  assert.equal((await h.redeem(appA, value)).status, 401, 'a ticket is used once');

  const late = await h.ticket(appA);
  h.clock.monotonic += WEB_LIMITS.ticketMs;
  assert.equal((await h.redeem(appA, late)).status, 401, 'a ticket lasts less than a minute on the Server clock');
  const fresh = await h.ticket(appA);
  h.clock.monotonic += WEB_LIMITS.ticketMs - 1;
  assert.equal((await h.redeem(appA, fresh)).status, 303);

  // Other entry requests are refused before the ticket is spent.
  const spare = await h.ticket(appA);
  const port = h.listenerPort(appA);
  assert.equal((await web(port, appA.origin!, 'POST', WEB_ENTRY_PATH, { ...FORM, origin: appB.origin! }, `ticket=${spare}`)).status, 403);
  assert.equal((await web(port, appA.origin!, 'POST', WEB_ENTRY_PATH, { 'content-type': 'application/json' }, JSON.stringify({ ticket: spare }))).status, 400);
  assert.equal((await web(port, appA.origin!, 'POST', WEB_ENTRY_PATH, FORM, `ticket=${spare}&${'x'.repeat(WEB_LIMITS.entryBodyBytes)}`)).status, 413);
  assert.equal((await web(port, appA.origin!, 'GET', `${WEB_ENTRY_PATH}?ticket=${spare}`, NAV)).status, 404, 'a ticket in a URL is never accepted');
  assert.equal((await h.redeem(appA, spare)).status, 303);
  assert.equal(a.hits.length, 0, 'nothing of the entry reaches the app');
});

test('without a session nothing reaches the app', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const page = await web(port, app.origin!, 'GET', '/deep', NAV);
  assert.equal(page.status, 401);
  assert.match(page.text, /Relay/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.equal((await web(port, app.origin!, 'GET', '/api', { origin: app.origin!, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', cookie: `${WEB_SESSION_COOKIE}=plantada` })).status, 401);
  assert.equal((await web(port, app.origin!, 'POST', '/api', { origin: app.origin! }, 'x')).status, 401);
  assert.equal((await upgrade(port, app.origin!, '/hmr', { origin: app.origin! })).status, 401);
  assert.equal(fake.hits.length, 0);
});

test('Host and scheme must be the app\'s own Service, also on upgrades', async (t) => {
  const a = await startFakeApp(t);
  const b = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', a.port), socket('127.0.0.1', b.port, '/home/user/dev/app-b')]) });
  const appA = await h.register('127.0.0.1', a.port);
  const appB = await h.register('127.0.0.1', b.port, 'App B');
  const cookie = await h.enter(appA);
  const port = h.listenerPort(appA);
  const misrouted: Record<string, string>[] = [{ host: new URL(appB.origin!).host }, { host: `127.0.0.1:${port}` }, { 'x-forwarded-proto': 'http' }, { host: `${new URL(appA.origin!).host}:443` }];
  for (const headers of misrouted) {
    assert.equal((await web(port, appA.origin!, 'GET', '/', { ...h.own(appA, cookie), ...headers })).status, 421, JSON.stringify(headers));
    assert.equal((await upgrade(port, appA.origin!, '/hmr', { ...h.own(appA, cookie), ...headers })).status, 421, JSON.stringify(headers));
  }
  // A session for A is not one for B, even presented at B's own listener.
  assert.equal((await web(h.listenerPort(appB), appB.origin!, 'GET', '/', h.own(appB, cookie))).status, 401);
  assert.equal(a.hits.length + b.hits.length, 0);
});

test('the session never reaches the control API nor the app, and Tailscale identity stays out', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const token = cookie.split('=')[1]!;
  for (const extra of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
    const response = await fetch(`${h.base}/v1/remote/web/apps`, { headers: { 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'web/1', ...extra } });
    assert.equal(response.status, 401);
  }
  const seen = JSON.parse((await web(h.listenerPort(app), app.origin!, 'GET', '/who', {
    ...h.own(app, `${cookie}; tema=claro; __HOST-RELAYPEND=mayus; __Host-RelayOtra=x`),
    'tailscale-user-login': 'ale@example.com', 'tailscale-user-name': 'Ale', 'tailscale-headers-info': 'x',
  })).text);
  assert.equal(seen.headers.cookie, 'tema=claro');
  assert.equal(seen.headers.host, new URL(app.origin!).host);
  assert.equal(seen.headers['x-forwarded-proto'], 'https');
  assert.equal(seen.headers['x-forwarded-host'], new URL(app.origin!).host);
  assert.deepEqual(Object.keys(seen.headers).filter((name) => name.startsWith('tailscale-')), []);
  // The same on upgrades.
  const opened = await upgrade(h.listenerPort(app), app.origin!, '/hmr', { ...h.own(app, `${cookie}; tema=claro`), 'tailscale-user-login': 'ale@example.com' });
  assert.equal(opened.status, 101);
  opened.socket!.destroy();
  const upgraded = fake.hits.at(-1)!;
  assert.equal(upgraded.headers.cookie, 'tema=claro');
  assert.equal(upgraded.headers['tailscale-user-login'], undefined);
});

test('methods, bodies, queries and paths, including /v1 routes, reach only the app', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const port = h.listenerPort(app);
  const upload = randomBytes(3 * 1024 * 1024);
  const posted = JSON.parse((await web(port, app.origin!, 'POST', '/subir?x=1', { ...h.own(app, cookie), 'content-type': 'application/octet-stream' }, upload)).text);
  assert.deepEqual([posted.method, posted.url, posted.bytes, posted.sha256], ['POST', '/subir?x=1', upload.length, createHash('sha256').update(upload).digest('hex')]);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal(JSON.parse((await web(port, app.origin!, method, '/item/1', h.own(app, cookie), 'cuerpo')).text).method, method);
  }
  const before = h.logs.length;
  for (const route of ['/v1/remote/status', '/v1/remote/web/apps?x=1', '/health', '/v1/pair']) {
    const response = await web(port, app.origin!, 'GET', route, h.own(app, cookie));
    assert.equal(response.status, 200, route);
    assert.equal(JSON.parse(response.text).url, route, `${route} is the app's own route`);
  }
  assert.ok(h.logs.slice(before).every((line) => line.startsWith('web ')), 'nothing reached the control API');
  // Only the Puente's entry lives under /__relay/; the rest is a 404 from the Puente.
  const hits = fake.hits.length;
  for (const route of ['/__relay/', '/__relay/acceso', '/a/../__relay/x']) {
    assert.equal((await web(port, app.origin!, 'GET', route, h.own(app, cookie))).status, 404, route);
    assert.equal((await upgrade(port, app.origin!, route, h.own(app, cookie))).status, 404, `upgrade ${route}`);
  }
  assert.equal(fake.hits.length, hits);
});

test('upstream cookies cannot use reserved names, a blank name nor any Domain', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const response = await web(h.listenerPort(app), app.origin!, 'GET', '/cookies', h.own(app, cookie));
  assert.deepEqual(response.headers['set-cookie'], ['ok=1; Path=/', 'padre=1; Path=/', 'padre_espacio=1', 'padre_tab=1', 'padre_mayus=1']);
  // The handshake's response too: an app cannot set Relay's session from it.
  const opened = await upgrade(h.listenerPort(app), app.origin!, '/cookies', h.own(app, cookie));
  assert.equal(opened.status, 101);
  assert.deepEqual(opened.headers['set-cookie'], ['padre=1']);
  opened.socket!.destroy();
});

test('redirects to the app\'s own loopback port are rewritten; others are left alone and never followed', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const port = h.listenerPort(app);
  const location = async (to: string) => {
    const response = await web(port, app.origin!, 'GET', `/redirect?to=${encodeURIComponent(to)}`, h.own(app, cookie));
    assert.equal(response.status, 302);
    return response.headers.location;
  };
  for (const to of [`http://127.0.0.1:${fake.port}/r?a=1#f`, `//127.0.0.1:${fake.port}/r?a=1#f`, `http:/127.0.0.1:${fake.port}/r?a=1#f`,
    `http://localhost:${fake.port}/r?a=1#f`, `http://[::1]:${fake.port}/r?a=1#f`, `https://127.0.0.1:${fake.port}/r?a=1#f`]) {
    assert.equal(await location(to), `${app.origin}/r?a=1#f`, to);
  }
  const hits = fake.hits.length;
  for (const to of ['/relativa', `http://127.0.0.1:8642/v1/runs`, `http://127.0.0.1:${CONTROL_PORT}/v1/agents`, 'https://example.com/', `http://evil.example:${fake.port}/x`]) {
    assert.equal(await location(to), to, `${to} is not the app; the browser goes there on its own, never through the Puente`);
  }
  assert.equal(fake.hits.length, hits + 5, 'one upstream request per request: redirects are never followed');
});

test('a malformed Location or request target is answered and the listener stays up', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const port = h.listenerPort(app);
  const broken = await web(port, app.origin!, 'GET', `/redirect?to=${encodeURIComponent('http://')}`, h.own(app, cookie));
  assert.equal(broken.status, 302);
  assert.equal(broken.headers.location, undefined);
  const host = new URL(app.origin!).host;
  for (const target of ['//evil.example/x', '/\\evil.example', 'http://evil.example/', '*']) {
    for (const extra of ['', 'Connection: Upgrade\r\nUpgrade: websocket\r\n']) {
      const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nX-Forwarded-Proto: https\r\nCookie: ${cookie}\r\nOrigin: ${app.origin}\r\n${extra}Connection: close\r\n\r\n`);
      assert.match(answer, /^HTTP\/1\.1 400 /, `${target} ${extra ? 'upgrade' : ''}`);
    }
  }
  assert.equal((await web(port, app.origin!, 'GET', '/ok', h.own(app, cookie))).status, 200);
  assert.ok(!fake.hits.some((hit) => hit.url !== '/ok' && !hit.url.startsWith('/redirect')));
});

test('unsafe methods and upgrades need the exact own Origin; cross-site reads are refused', async (t) => {
  const a = await startFakeApp(t);
  const b = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', a.port), socket('127.0.0.1', b.port, '/home/user/dev/app-b')]) });
  const appA = await h.register('127.0.0.1', a.port);
  const appB = await h.register('127.0.0.1', b.port, 'App B');
  const cookie = await h.enter(appA);
  const port = h.listenerPort(appA);
  for (const origin of [undefined, appB.origin!, 'null', `${appA.origin}:443`, appA.origin!.replace('https:', 'http:')]) {
    const headers: Record<string, string> = { cookie };
    if (origin) headers.origin = origin;
    assert.equal((await web(port, appA.origin!, 'POST', '/form', headers, 'a=1')).status, 403, `POST ${origin}`);
    assert.equal((await upgrade(port, appA.origin!, '/hmr', headers)).status, 403, `upgrade ${origin}`);
  }
  assert.equal((await web(port, appA.origin!, 'GET', '/api', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' })).status, 403);
  assert.equal((await web(port, appA.origin!, 'GET', '/api', { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).status, 403);
  assert.equal(a.hits.length, 0);
  assert.equal((await web(port, appA.origin!, 'GET', '/page', { cookie, ...NAV, 'sec-fetch-site': 'same-site' })).status, 200, 'a navigation may come from a link');
  assert.equal((await web(port, appA.origin!, 'POST', '/form', { cookie, origin: appA.origin! }, 'a=1')).status, 200);
});

test('SSE and upgrades pass through in both directions; the app\'s CSP and CORS are untouched', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const cookie = await h.enter(app);
  const port = h.listenerPort(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, cookie));
  assert.equal(events.headers['content-type'], 'text/event-stream');
  assert.equal(await events.first, 'data: uno\n\n');
  const opened = await upgrade(port, app.origin!, '/hmr?token=x', h.own(app, cookie));
  assert.equal(opened.status, 101);
  const reply = nextData(opened.socket!);
  opened.socket!.write('ping');
  assert.equal(await reply, 'eco:ping');
  const policy = await web(port, app.origin!, 'GET', '/policy', h.own(app, cookie));
  assert.equal(policy.headers['content-security-policy'], "default-src 'self'");
  assert.equal(policy.headers['access-control-allow-origin'], '*');
  const sse = [...fake.streams][0]!;
  events.close();
  // The client left: the exchange with the app ends too (the suite's timeout fails it otherwise).
  await once(sse, 'close');
  opened.socket!.destroy();
});

test('revoking the device cuts its open streams, refuses its session and voids its tickets', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const phone = await h.enter(app);
  const tablet = await h.enter(app, TABLET_KEY);
  const events = await stream(port, app.origin!, '/sse', h.own(app, phone));
  await events.first;
  const socketOpen = (await upgrade(port, app.origin!, '/hmr', h.own(app, phone))).socket!;
  const closed = nextData(socketOpen);
  const tabletEvents = await stream(port, app.origin!, '/sse', h.own(app, tablet));
  await tabletEvents.first;
  const pending = await h.ticket(app);
  await h.revoke();
  await events.ended;
  assert.equal(await closed, null);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, phone))).status, 401);
  assert.equal((await h.redeem(app, pending)).status, 401, 'a ticket issued before the revocation is void');
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, tablet))).status, 200, 'another device keeps its session');
  tabletEvents.close();
});

test('closing from Relay, or opening again, ends that device\'s previous session and its streams', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const first = await h.enter(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, first));
  await events.first;
  const tablet = await h.enter(app, TABLET_KEY);
  const second = await h.enter(app);
  await events.ended;
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, first))).status, 401);
  const upgraded = (await upgrade(port, app.origin!, '/hmr', h.own(app, second))).socket!;
  const closedSocket = nextData(upgraded);
  const unused = await h.ticket(app);
  assert.deepEqual((await h.call('POST', `/v1/remote/web/apps/${app.id}/close`)).json, { closed: 1 });
  assert.equal(await closedSocket, null);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, second))).status, 401);
  assert.equal((await h.redeem(app, unused)).status, 401, 'closing voids the tickets not yet used');
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, tablet))).status, 200);
});

test('forgetting an app cuts its streams, voids its tickets and closes its listener', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const cookie = await h.enter(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, cookie));
  await events.first;
  const upgraded = (await upgrade(port, app.origin!, '/hmr', h.own(app, cookie))).socket!;
  const closedSocket = nextData(upgraded);
  const unused = await h.ticket(app);
  assert.equal((await h.call('DELETE', `/v1/remote/web/apps/${app.id}`)).status, 200);
  await events.ended;
  assert.equal(await closedSocket, null);
  await assert.rejects(h.redeem(app, unused, port), /ECONNREFUSED/);
});

test('a stopped app answers an error, never another target, and has to be opened again', async (t) => {
  const fake = await startFakeApp(t);
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const h = await start(t, { registry });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const cookie = await h.enter(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, cookie));
  await events.first;
  await fake.close();
  await events.ended;
  const down = await web(port, app.origin!, 'GET', '/deep', { ...NAV, cookie });
  assert.equal(down.status, 502);
  assert.match(down.text, /no responde/);
  assert.equal(down.headers['cache-control'], 'no-store');
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, cookie))).status, 401, 'the session ends with the target');
  // Another program now listens on that port: opening says so instead of serving it.
  const impostor = await startFakeApp(t, '127.0.0.1', fake.port);
  registry.sockets = [socket('127.0.0.1', fake.port, '/home/user/dev/otra')];
  assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' })).status, 409);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, cookie))).status, 401);
  assert.equal(impostor.hits.length, 0);
});

test('an app status Node cannot answer is a 502 and the Puente stays up', async (t) => {
  const odd = net.createServer((sock) => sock.once('data', () => sock.end('HTTP/1.1 099 Raro\r\nContent-Length: 0\r\n\r\n')));
  await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => odd.close(() => resolve())));
  const oddPort = (odd.address() as AddressInfo).port;
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', oddPort)]) });
  const app = await h.register('127.0.0.1', oddPort);
  const cookie = await h.enter(app);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await web(h.listenerPort(app), app.origin!, 'GET', '/', h.own(app, cookie))).status, 502, 'the app answered, so the session stays');
  }
  assert.equal((await h.call('GET', '/v1/remote/web/apps')).status, 200);
});

test('a truncated upstream response is never delivered as complete', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  await assert.rejects(web(h.listenerPort(app), app.origin!, 'GET', '/truncated', h.own(app, await h.enter(app))));
});

test('apps on ::1 and on another loopback address are served there', async (t) => {
  const six = await startFakeApp(t, '::1');
  const two = await startFakeApp(t, '127.0.0.2');
  const h = await start(t, { registry: fakeSockets([socket('::1', six.port), socket('127.0.0.2', two.port, '/home/user/dev/app-b')]) });
  for (const [fake, address] of [[six, '::1'], [two, '127.0.0.2']] as const) {
    const app = await h.register(address, fake.port, address);
    const cookie = await h.enter(app);
    assert.equal(JSON.parse((await web(h.listenerPort(app), app.origin!, 'GET', '/x', h.own(app, cookie))).text).url, '/x');
    const back = await web(h.listenerPort(app), app.origin!, 'GET', `/redirect?to=${encodeURIComponent(`http://${address.includes(':') ? `[${address}]` : address}:${fake.port}/y`)}`, h.own(app, cookie));
    assert.equal(back.headers.location, `${app.origin}/y`);
    assert.equal(fake.hits.length, 2);
  }
});

test('the listener log has the app ID, the method and the status only', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const value = await h.ticket(app);
  const before = h.logs.length;
  const entered = await h.redeem(app, value);
  const cookie = ([] as string[]).concat(entered.headers['set-cookie']!)[0]!.split(';')[0]!;
  await web(h.listenerPort(app), app.origin!, 'GET', '/secreto/ruta?token=abc', h.own(app, cookie));
  const opened = await upgrade(h.listenerPort(app), app.origin!, '/hmr?token=abc', h.own(app, cookie));
  opened.socket!.destroy();
  await web(h.listenerPort(app), app.origin!, 'GET', '/x', { cookie: `${WEB_SESSION_COOKIE}=nada`, ...NAV });
  await setImmediate();
  assert.deepEqual(h.logs.slice(before).map((line) => line.replace(/ \d+ms$/, '')).sort(), [
    `web ${app.id} GET 101`, `web ${app.id} GET 200`, `web ${app.id} GET 401`, `web ${app.id} POST 303`,
  ].sort());
  const all = h.logs.join('\n');
  for (const secret of [value, cookie.split('=')[1]!, 'secreto', 'token', '/hmr', String(fake.port)]) assert.ok(!all.includes(secret), secret);
});

test('control routes for the web tool have labels and keep the key, protocol and capability rules', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  await h.call('GET', '/v1/remote/web/candidates');
  await h.call('GET', '/v1/remote/web/apps');
  await h.call('POST', `/v1/remote/web/apps/${app.id}/open`, { path: '/' });
  await h.call('POST', `/v1/remote/web/apps/${app.id}/close`);
  const unknown = `acc_${'A'.repeat(22)}`;
  await h.call('GET', `/v1/remote/web/apps/${app.id}/authorizations`);
  await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: unknown, code: 'ABCD-EFGH' });
  await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations/${unknown}/cancel`);
  await h.call('DELETE', `/v1/remote/web/apps/${app.id}`);
  assert.equal((await h.call('GET', '/v1/remote/web/apps', undefined, '')).status, 401);
  assert.equal((await h.call('GET', '/v1/remote/web/apps', undefined, KEY, { 'X-Relay-Capability': 'files/1' })).status, 426);
  assert.equal((await h.call('GET', '/v1/remote/web/apps?x=1')).status, 400);
  await setImmediate();
  const lines = h.logs.filter((line) => !line.startsWith('web ')).map((line) => line.replace(/ \d+ms$/, ''));
  assert.deepEqual(lines, [
    'POST /v1/remote/web/apps 200', 'GET /v1/remote/web/candidates 200', 'GET /v1/remote/web/apps 200',
    'POST /v1/remote/web/apps/:id/open 200', 'POST /v1/remote/web/apps/:id/close 200',
    'GET /v1/remote/web/apps/:id/authorizations 200', 'POST /v1/remote/web/apps/:id/authorizations 404',
    'POST /v1/remote/web/apps/:id/authorizations/:accessId/cancel 404', 'DELETE /v1/remote/web/apps/:id 200',
    'GET /v1/remote/web/apps 401', 'GET /v1/remote/web/apps 426', 'GET /v1/remote/web/apps 400',
  ]);
  assert.ok(!lines.join('\n').includes(app.id) && !lines.join('\n').includes(unknown));
});

// ---- External authorization (#90) ------------------------------------------------------------------

/** Every upstream end the fake app holds (SSE responses and upgraded sockets) has closed. */
const upstreamClosed = (fake: { streams: Set<net.Socket> }) => Promise.all([...fake.streams].map((s) => {
  // Upgraded sockets are half-open on the app's side: the Puente's FIN is an `end`, not yet a `close`.
  if (s.destroyed || s.readableEnded) return null;
  const { promise, resolve } = Promise.withResolvers<void>();
  s.once('end', resolve);
  s.once('close', resolve);
  return promise;
}));

test('a browser without a session gets the access page, bound to it by a secret, with a public code', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const asked = await h.visit(app, '/deep/a?x=1');
  assert.equal(asked.page.status, 401);
  assert.equal(asked.page.headers['cache-control'], 'no-store');
  assert.match(String(asked.page.headers['content-security-policy']), /default-src 'none'/);
  assert.match(asked.page.text, /<meta http-equiv="refresh" content="2">/);
  assert.ok(asked.code, 'the page shows a public code');
  assert.match(asked.line!, /^__Host-RelayPend=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/);
  assert.ok(!asked.page.text.includes(asked.pending.split('=')[1]!), 'the secret is only in the cookie');
  // The same browser reloading waits on the same request; it does not open another.
  const again = await h.visit(app, '/deep/a?x=1', asked.pending);
  assert.equal(again.code, asked.code);
  assert.equal(again.line, undefined);
  // Subresources and upgrades without a session open nothing.
  assert.equal((await web(h.listenerPort(app), app.origin!, 'GET', '/api', { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' })).status, 401);
  assert.equal((await upgrade(h.listenerPort(app), app.origin!, '/hmr', { origin: app.origin! })).status, 401);
  const listed = await h.accessList(app);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.serverNow, NOW);
  assert.equal(listed.json.requests.length, 1);
  assert.match(listed.json.requests[0].id, /^acc_[A-Za-z0-9_-]{22,64}$/);
  assert.deepEqual({ ...listed.json.requests[0], id: undefined }, { id: undefined, code: asked.code, createdAt: NOW, expiresAt: NOW + WEB_LIMITS.pendingMs });
  assert.deepEqual(listed.json.authorizations, []);
  // Any paired device sees the pending request; it is the Server's app.
  assert.deepEqual((await h.accessList(app, TABLET_KEY)).json.requests, listed.json.requests);
  assert.equal(fake.hits.length, 0, 'nothing of the access reaches the app');
});

test('redemption is single use, needs a grant with the compared code, and only the browser holding the secret gets in', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const asked = await h.visit(app, '/deep/a?x=1');
  const other = await h.visit(app, '/');
  assert.notEqual(other.code, asked.code);
  // Before the grant the browser keeps waiting.
  assert.equal((await h.visit(app, '/deep/a?x=1', asked.pending)).code, asked.code);
  const request = (await h.accessList(app)).json.requests.find((r: { code: string }) => r.code === asked.code);
  // The ID alone, or with another request's code, grants nothing.
  for (const code of [other.code, 'ABCD-EFGH', asked.code!.toLowerCase(), '']) {
    const refused = await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code });
    assert.equal(refused.status, code === '' ? 400 : 404, code!);
  }
  for (const body of [{ request: request.id }, { request: request.id, code: asked.code, extra: 1 }, { request: 'app_x', code: asked.code }]) {
    assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, body)).status, 400, JSON.stringify(body));
  }
  const granted = await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code: asked.code });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.json, { id: request.id, code: asked.code, grantedAt: NOW, expiresAt: NOW + WEB_LIMITS.grantMs, redeemed: false });
  assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code: asked.code })).status, 404, 'granted once');
  // Another browser with the public code and no secret, or with its own secret, gets nothing.
  assert.equal((await h.visit(app, '/')).page.status, 401);
  assert.equal((await h.visit(app, '/', other.pending)).code, other.code);
  const forged = await h.visit(app, '/', `${WEB_PENDING_COOKIE}=${'A'.repeat(43)}`);
  assert.equal(forged.page.status, 401, 'a secret the Puente never issued is a new request, never the granted one');
  assert.notEqual(forged.code, asked.code);
  const redeemed = await web(port, app.origin!, 'GET', '/deep/a?x=1', { ...NAV, cookie: asked.pending });
  assert.equal(redeemed.status, 303);
  assert.equal(redeemed.headers.location, '/deep/a?x=1');
  assert.equal(redeemed.headers['cache-control'], 'no-store');
  const sessionLine = h.cookieOf(redeemed, WEB_SESSION_COOKIE)!;
  assert.match(sessionLine, /^__Host-RelayWeb=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  assert.equal(h.cookieOf(redeemed, WEB_PENDING_COOKIE), `${WEB_PENDING_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  const session = sessionLine.split(';')[0]!;
  assert.notEqual(session.split('=')[1], asked.pending.split('=')[1], 'a new identifier, never the pending secret');
  // Used once: the same secret is a fresh access page, never a second session.
  const reused = await h.visit(app, '/', asked.pending);
  assert.equal(reused.page.status, 401);
  assert.ok(reused.line, 'a spent secret opens a new request');
  assert.notEqual(reused.code, asked.code);
  const seen = JSON.parse((await web(port, app.origin!, 'GET', '/who', { ...h.own(app, `${session}; ${asked.pending}; tema=claro`) })).text);
  assert.equal(seen.headers.cookie, 'tema=claro', 'neither Relay cookie reaches the app');
  const listed = (await h.accessList(app)).json;
  assert.deepEqual(listed.authorizations, [{ ...granted.json, redeemed: true }]);
  assert.ok(!listed.requests.some((r: { id: string }) => r.id === request.id));
  assert.deepEqual((await h.accessList(app, TABLET_KEY)).json.authorizations, [], 'a device lists only what it granted');
  const log = (await changes(h.directory)).filter((c) => c.action === 'remote.web.authorized');
  assert.deepEqual(log.map((c) => [c.actor.id, c.target]), [[DEVICE, { kind: 'app', id: app.id }]]);
  // Nothing secret or forwarded reaches a log line.
  const all = h.logs.join('\n');
  for (const secret of [asked.code!, asked.pending.split('=')[1]!, session.split('=')[1]!, 'deep', request.id]) assert.ok(!all.includes(secret), secret);
});

test('the hour counts from the grant on the Server clock, is not renewed by use, and expiry cuts open SSE and WebSocket at both ends', async (t) => {
  const fake = await startFakeApp(t);
  const other = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port), socket('127.0.0.1', other.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const asked = await h.visit(app, '/');
  const granted = await h.grant(app, asked.code!);
  // Redeemed half an hour later: the cookie carries what is left, in seconds.
  h.advance(WEB_LIMITS.pendingMs - 1);
  const redeemed = await web(port, app.origin!, 'GET', '/', { ...NAV, cookie: asked.pending });
  assert.equal(redeemed.status, 303);
  const left = Math.floor((WEB_LIMITS.grantMs - WEB_LIMITS.pendingMs + 1) / 1000);
  assert.match(h.cookieOf(redeemed, WEB_SESSION_COOKIE)!, new RegExp(`; Max-Age=${left}$`));
  const session = h.cookieOf(redeemed, WEB_SESSION_COOKIE)!.split(';')[0]!;
  const events = await stream(port, app.origin!, '/sse', h.own(app, session));
  await events.first;
  const ws = (await upgrade(port, app.origin!, '/hmr', h.own(app, session))).socket!;
  const wsClosed = nextData(ws);
  // Use does not renew it: a request one millisecond before the end is the last one.
  h.advance(WEB_LIMITS.grantMs - WEB_LIMITS.pendingMs);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 200);
  assert.equal(fake.streams.size, 2);
  // A timer that fires late does not lengthen the hour: every new exchange is refused already.
  h.clock.monotonic += 1;
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.equal((await upgrade(port, app.origin!, '/hmr', h.own(app, session))).status, 401);
  // And the timer cuts what is open.
  h.advance(0);
  await events.ended;
  assert.equal(await wsClosed, null);
  await upstreamClosed(fake);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.equal((await upgrade(port, app.origin!, '/hmr', h.own(app, session))).status, 401);
  assert.ok((await h.visit(app, '/', session)).code, 'the browser is asked again, visibly');
  assert.deepEqual((await h.accessList(app)).json.authorizations, []);
  await h.register('127.0.0.1', other.port); // its record queues after the one the expiry timer wrote
  const log = (await changes(h.directory)).filter((c) => c.action.startsWith('remote.web.') && c.action !== 'remote.web.registered');
  assert.deepEqual(log.map((c) => [c.action, c.actor.kind, c.target.id]), [['remote.web.authorized', 'device', app.id], ['remote.web.expired', 'server', app.id]]);
  assert.equal(granted.json.expiresAt, NOW + WEB_LIMITS.grantMs);
});

test('a suspension does not lengthen the hour: it also ends on the wall clock, and what is open is cut after waking', async (t) => {
  const fake = await startFakeApp(t);
  const other = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port), socket('127.0.0.1', other.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const asked = await h.visit(app, '/');
  assert.equal((await h.grant(app, asked.code!)).status, 200);
  // Suspended for fifty minutes before redeeming: the monotonic clock stood still, the wall clock did not.
  h.clock.wall += WEB_LIMITS.grantMs - 600_000;
  const redeemed = await web(port, app.origin!, 'GET', '/', { ...NAV, cookie: asked.pending });
  assert.equal(redeemed.status, 303);
  assert.match(h.cookieOf(redeemed, WEB_SESSION_COOKIE)!, /; Max-Age=600$/, 'the cookie never outlives the wall-clock hour');
  const session = h.cookieOf(redeemed, WEB_SESSION_COOKIE)!.split(';')[0]!;
  const events = await stream(port, app.origin!, '/sse', h.own(app, session));
  await events.first;
  const ws = (await upgrade(port, app.origin!, '/hmr', h.own(app, session))).socket!;
  const wsClosed = nextData(ws);
  // Suspended again past the hour: new exchanges are refused at once.
  h.clock.wall += 600_000;
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.equal((await upgrade(port, app.origin!, '/hmr', h.own(app, session))).status, 401);
  // Awake: the next check cuts what is open, long before the monotonic hour.
  h.advance(WALL_CHECK_MS);
  await events.ended;
  assert.equal(await wsClosed, null);
  await upstreamClosed(fake);
  assert.deepEqual((await h.accessList(app)).json.authorizations, []);
  await h.register('127.0.0.1', other.port); // its record queues after the one the expiry timer wrote
  assert.ok((await changes(h.directory)).some((c) => c.action === 'remote.web.expired'));
});

test('a wall clock set back does not lengthen the hour: the monotonic clock still ends it', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const { session } = await h.authorize(app);
  h.clock.wall -= 24 * 60 * 60_000;
  h.advance(WEB_LIMITS.grantMs - 1);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 200);
  const events = await stream(port, app.origin!, '/sse', h.own(app, session));
  await events.first;
  h.advance(1);
  await events.ended;
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.deepEqual((await h.accessList(app)).json.authorizations, []);
});

test('a grant the browser does not redeem in time, or after the hour, opens nothing', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const asked = await h.visit(app, '/');
  assert.equal((await h.grant(app, asked.code!)).status, 200);
  h.advance(WEB_LIMITS.pendingMs);
  const late = await h.visit(app, '/', asked.pending);
  assert.equal(late.page.status, 401);
  assert.notEqual(late.code, asked.code);
  assert.deepEqual((await h.accessList(app)).json.authorizations, []);
  // A request past its five minutes cannot be granted either.
  const stale = await h.visit(app, '/');
  const request = (await h.accessList(app)).json.requests.find((r: { code: string }) => r.code === stale.code);
  h.advance(WEB_LIMITS.pendingMs);
  assert.equal((await h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code: stale.code })).status, 404);
  assert.equal(fake.hits.length, 0);
});

test('pending requests are capped per app and expire after five minutes', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  for (let index = 0; index < WEB_LIMITS.pendingPerApp; index += 1) assert.ok((await h.visit(app)).code);
  const full = await h.visit(app);
  assert.equal(full.page.status, 429);
  assert.equal(full.code, null);
  assert.equal(full.line, undefined);
  assert.equal(full.page.headers['cache-control'], 'no-store');
  assert.equal((await h.accessList(app)).json.requests.length, WEB_LIMITS.pendingPerApp);
  h.advance(WEB_LIMITS.pendingMs);
  assert.deepEqual((await h.accessList(app)).json.requests, []);
  assert.ok((await h.visit(app)).code);
});

test('locking Relay keeps the external authorization; cancelling it from Relay ends it and cuts its streams at both ends', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const { session, granted } = await h.authorize(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, session));
  await events.first;
  const ws = (await upgrade(port, app.origin!, '/hmr', h.own(app, session))).socket!;
  const wsClosed = nextData(ws);
  // Relay closes its in-Relay sessions when it locks; the external browser keeps its hour.
  assert.deepEqual((await h.call('POST', `/v1/remote/web/apps/${app.id}/close`)).json, { closed: 0 });
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 200);
  // Another device's, or an unknown, authorization is answered as missing.
  const cancel = (id: string, key = KEY) => h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations/${id}/cancel`, undefined, key);
  assert.equal((await cancel(granted.id, TABLET_KEY)).status, 404);
  assert.equal((await cancel(`acc_${'B'.repeat(22)}`)).status, 404);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 200);
  assert.deepEqual((await cancel(granted.id)).json, { ok: true });
  await events.ended;
  assert.equal(await wsClosed, null);
  await upstreamClosed(fake);
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.equal((await cancel(granted.id)).status, 404);
  // A grant not yet redeemed is cancelled too: its browser is asked again.
  const asked = await h.visit(app, '/');
  const pendingGrant = await h.grant(app, asked.code!);
  assert.deepEqual((await cancel(pendingGrant.json.id)).json, { ok: true });
  assert.ok((await h.visit(app, '/', asked.pending)).line, 'cancelled before redemption: a new request');
  const log = (await changes(h.directory)).filter((c) => c.action === 'remote.web.cancelled');
  assert.deepEqual(log.map((c) => [c.actor.id, c.target.id]), [[DEVICE, app.id], [DEVICE, app.id]]);
});

test('revoking the granting device ends its authorizations, redeemed or not, and their streams; another device\'s stay', async (t) => {
  const fake = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', fake.port)]) });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const phone = await h.authorize(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, phone.session));
  await events.first;
  const ws = (await upgrade(port, app.origin!, '/hmr', h.own(app, phone.session))).socket!;
  const wsClosed = nextData(ws);
  const phoneStreams = new Set(fake.streams);
  const waiting = await h.visit(app, '/');
  assert.equal((await h.grant(app, waiting.code!)).status, 200);
  const tablet = await h.authorize(app, '/', TABLET_KEY);
  const tabletEvents = await stream(port, app.origin!, '/sse', h.own(app, tablet.session));
  await tabletEvents.first;
  await h.revoke();
  await events.ended;
  assert.equal(await wsClosed, null);
  await upstreamClosed({ streams: phoneStreams });
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, phone.session))).status, 401);
  assert.ok((await h.visit(app, '/', waiting.pending)).line, 'its unredeemed grant is void');
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, tablet.session))).status, 200);
  tabletEvents.close();
});

test('a grant racing the device revocation never authorizes', async (t) => {
  const fake = await startFakeApp(t);
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const h = await start(t, { registry });
  const app = await h.register('127.0.0.1', fake.port);
  const asked = await h.visit(app, '/');
  const request = (await h.accessList(app)).json.requests[0];
  // The grant checks the app's identity first; the revocation lands while it waits.
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const read = registry.listening;
  registry.listening = async () => { reached.resolve(); await gate.promise; return read(); };
  const granting = h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code: asked.code });
  await reached.promise;
  await h.revoke();
  gate.resolve();
  const answered = await granting;
  assert.equal(answered.status, 403);
  assert.equal(answered.json.error.code, 'device_revoked');
  registry.listening = read;
  const after = await h.visit(app, '/', asked.pending);
  assert.equal(after.page.status, 401, 'the browser was never let in');
  assert.equal(after.code, asked.code, 'the request is still waiting for a device that may grant it');
  assert.equal(fake.hits.length, 0);
  assert.ok(!(await changes(h.directory)).some((c) => c.action === 'remote.web.authorized'));
});

test('granting checks the app\'s identity again: another program, or none, is never authorized', async (t) => {
  const fake = await startFakeApp(t);
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const h = await start(t, { registry });
  const app = await h.register('127.0.0.1', fake.port);
  const asked = await h.visit(app, '/');
  const request = (await h.accessList(app)).json.requests[0];
  const grant = () => h.call('POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: request.id, code: asked.code });
  registry.sockets = [socket('127.0.0.1', fake.port, '/home/user/dev/other-app')];
  const other = await grant();
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, 'remote_conflict');
  registry.sockets = [];
  const gone = await grant();
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error.code, 'remote_ended');
  const after = await h.visit(app, '/', asked.pending);
  assert.equal(after.page.status, 401, 'the browser was never let in');
  assert.equal(after.code, asked.code);
  assert.equal(fake.hits.length, 0);
  assert.ok(!(await changes(h.directory)).some((c) => c.action === 'remote.web.authorized'));
  // The same program again: the request is still there to grant.
  registry.sockets = [socket('127.0.0.1', fake.port)];
  assert.equal((await grant()).status, 200);
});

test('an external session is scoped to its app and never opens the control API', async (t) => {
  const a = await startFakeApp(t);
  const b = await startFakeApp(t);
  const h = await start(t, { registry: fakeSockets([socket('127.0.0.1', a.port), socket('127.0.0.1', b.port, '/home/user/dev/app-b')]) });
  const appA = await h.register('127.0.0.1', a.port);
  const appB = await h.register('127.0.0.1', b.port, 'App B');
  const { session } = await h.authorize(appA);
  const token = session.split('=')[1]!;
  // B's listener does not know A's session, by cookie or by navigation.
  assert.equal((await web(h.listenerPort(appB), appB.origin!, 'GET', '/', h.own(appB, session))).status, 401);
  assert.ok((await h.visit(appB, '/', session)).code, 'B asks for its own authorization');
  assert.equal(b.hits.length, 0);
  for (const extra of [{ Cookie: session }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
    const response = await fetch(`${h.base}/v1/remote/web/apps/${appA.id}/authorizations`, { headers: { 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'web/1', ...extra } });
    assert.equal(response.status, 401);
  }
  // A request of A is not grantable through B.
  const asked = await h.visit(appA, '/');
  const request = (await h.accessList(appA)).json.requests.find((r: { code: string }) => r.code === asked.code);
  assert.equal((await h.call('POST', `/v1/remote/web/apps/${appB.id}/authorizations`, { request: request.id, code: asked.code })).status, 404);
  assert.ok(!(await h.accessList(appB)).json.requests.some((r: { id: string }) => r.id === request.id));
  // Its writes follow the same Origin rule as any session.
  assert.equal((await web(h.listenerPort(appA), appA.origin!, 'POST', '/form', { cookie: session, origin: appB.origin! }, 'a=1')).status, 403);
  assert.equal((await web(h.listenerPort(appA), appA.origin!, 'POST', '/form', { cookie: session, origin: appA.origin! }, 'a=1')).status, 200);
});

test('forgetting the app, or the app refusing a connection, ends its external authorizations', async (t) => {
  const fake = await startFakeApp(t);
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const h = await start(t, { registry });
  const app = await h.register('127.0.0.1', fake.port);
  const port = h.listenerPort(app);
  const { session } = await h.authorize(app);
  await fake.close();
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 502);
  // Another program may take the port: the hour does not follow it there.
  assert.equal((await web(port, app.origin!, 'GET', '/', h.own(app, session))).status, 401);
  assert.deepEqual((await h.accessList(app)).json.authorizations, []);
  const impostor = await startFakeApp(t, '127.0.0.1', fake.port);
  const again = await h.authorize(app);
  const events = await stream(port, app.origin!, '/sse', h.own(app, again.session));
  await events.first;
  assert.equal((await h.call('DELETE', `/v1/remote/web/apps/${app.id}`)).status, 200);
  await events.ended;
  await upstreamClosed(impostor);
  // Its authorizations end with it, not just its connections: no timer is left to expire them later.
  h.advance(WEB_LIMITS.grantMs);
  await h.register('127.0.0.1', fake.port); // its record queues after any the timer wrote
  assert.ok(!(await changes(h.directory)).some((c) => c.action === 'remote.web.expired'));
});

test('a Puente restart ends external authorizations and asks again visibly; the app\'s own cookies still pass', async (t) => {
  const fake = await startFakeApp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registry = fakeSockets([socket('127.0.0.1', fake.port)]);
  const publisher = simulatedPublisher();
  const first = await start(t, { directory, registry, publisher });
  const app = await first.register('127.0.0.1', fake.port);
  const { session } = await first.authorize(app);
  const waiting = await first.visit(app, '/');
  await first.close();
  const second = await start(t, { directory, registry, publisher });
  assert.equal((await second.call('GET', '/v1/remote/web/apps')).status, 200, 'the registry and its listeners are back');
  const port = second.listenerPort(app);
  assert.equal((await web(port, app.origin!, 'GET', '/', second.own(app, session))).status, 401);
  const asked = await second.visit(app, '/', `${session}; ${waiting.pending}; app_session=propia`);
  assert.ok(asked.code && asked.line, 'a new request with a new code, never the old one');
  const listed = (await second.accessList(app)).json;
  assert.deepEqual([listed.requests.map((r: { code: string }) => r.code), listed.authorizations], [[asked.code], []], 'nothing survives the restart');
  const again = await second.authorize(app);
  const seen = JSON.parse((await web(port, app.origin!, 'GET', '/who', second.own(app, `${again.session}; app_session=propia`))).text);
  assert.equal(seen.headers.cookie, 'app_session=propia');
});
