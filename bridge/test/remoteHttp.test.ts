import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import type { RemoteTools } from '../src/remote/ports.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { fakeRemoteTools, fixedBrowser, fixedFiles, fixedPort, fixedPty, fixedSupervisor } from '../support/fake_remote.ts';
import { fakeSockets, simulatedPublisher } from '../support/fake_web.ts';

const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const DEVICE = '00000000-0000-4000-8000-000000000001';
const NOW = 1_700_000_000_000;
const OK = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2' };

async function start(t: TestContext, remote?: RemoteTools) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-remote-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory, now: () => NOW });
  await store.mutate((state) => { state.devices.push({ id: DEVICE, name: 'phone', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const logs: string[] = [];
  const server = createApp({
    config: { corsOrigins: ['http://localhost:8081'] },
    store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null },
    hostname: 'arch', version: '9.9.9', now: () => NOW, log: (line) => logs.push(line),
    ...(remote ? { remote } : {}),
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  async function call(method: string, route: string, headers: Record<string, string>) {
    const response = await fetch(base + route, { method, headers });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  }
  const revoke = () => store.mutate((state) => { state.devices[0]!.revokedAt = NOW; });
  return { call, logs, revoke };
}

const status = (headers: Record<string, string>) => ['GET', '/v1/remote/status', headers] as const;

test('health advertises no capability while no remote tool is wired', async (t) => {
  const { call } = await start(t);
  const health = await call('GET', '/health', {});
  assert.deepEqual(health.json.capabilities, {});
  assert.equal(health.json.protocolVersion, 2);
});

test('health advertises exactly the wired capabilities, and terminal or browser only with environments', async (t) => {
  const tools = fakeRemoteTools({ files: { capability: { version: 3, minAppVersion: 2 }, port: fixedFiles() } });
  assert.deepEqual((await (await start(t, tools)).call('GET', '/health', {})).json.capabilities, {
    environments: { version: 1, minAppVersion: 1 }, terminal: { version: 1, minAppVersion: 1 },
    files: { version: 3, minAppVersion: 2 }, web: { version: 1, minAppVersion: 1 }, browser: { version: 1, minAppVersion: 1 },
    chat_files: { version: 1, minAppVersion: 1 },
  });
  const partial = await start(t, { terminal: fakeRemoteTools().terminal, files: fakeRemoteTools().files, browser: fakeRemoteTools().browser });
  assert.deepEqual((await partial.call('GET', '/health', {})).json.capabilities, { files: { version: 1, minAppVersion: 1 }, chat_files: { version: 1, minAppVersion: 1 } });
});

test('remote status reports only wired tools, gating terminal and browser on the supervisor', async (t) => {
  const missing = { state: 'unavailable', reason: 'helper_missing' } as const;
  const { call } = await start(t, fakeRemoteTools({
    environments: { capability: { version: 1, minAppVersion: 1 }, port: fixedSupervisor(async () => missing) },
  }));
  const response = await call(...status({ ...OK, 'X-Relay-Capability': 'files/1' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    serverNow: NOW, terminal: missing, files: { state: 'available' },
    web: { inRelay: { state: 'available' }, external: { state: 'available' } },
    browser: { dedicated: missing, habitual: missing },
  });
  const partial = await start(t, { files: fakeRemoteTools().files, browser: { capability: { version: 1, minAppVersion: 1 }, port: fixedBrowser() } });
  assert.deepEqual((await partial.call(...status({ ...OK, 'X-Relay-Capability': 'files/1' }))).json, { serverNow: NOW, files: { state: 'available' } });
});

test('the in-Relay viewer reaches an app only through its Service, so it needs the publisher too', async (t) => {
  const notConfigured = { state: 'unavailable', reason: 'not_configured' } as const;
  const unpublished = await start(t, fakeRemoteTools({
    web: { capability: { version: 1, minAppVersion: 1 }, port: { apps: fakeSockets(), publisher: simulatedPublisher(notConfigured) } },
  }));
  assert.deepEqual((await unpublished.call(...status({ ...OK, 'X-Relay-Capability': 'web/1' }))).json.web, { inRelay: notConfigured, external: notConfigured });
  const noDiscovery = await start(t, fakeRemoteTools({
    web: { capability: { version: 1, minAppVersion: 1 }, port: { apps: fakeSockets([], { state: 'unavailable', reason: 'unsupported_platform' }), publisher: simulatedPublisher() } },
  }));
  assert.deepEqual((await noDiscovery.call(...status({ ...OK, 'X-Relay-Capability': 'web/1' }))).json.web, {
    inRelay: { state: 'unavailable', reason: 'unsupported_platform' }, external: { state: 'available' },
  });
});

test('a port that throws makes its tool unavailable, never a 500 or its error text', async (t) => {
  const down = { availability: async (): Promise<never> => { throw new Error('connect ENOENT /run/user/1000/relay/supervisor.sock'); } };
  const { call } = await start(t, fakeRemoteTools({
    environments: { capability: { version: 1, minAppVersion: 1 }, port: fixedSupervisor(down.availability) },
    files: { capability: { version: 1, minAppVersion: 1 }, port: fixedFiles(down.availability) },
    web: { capability: { version: 1, minAppVersion: 1 }, port: { apps: { ...fakeSockets(), availability: down.availability }, publisher: simulatedPublisher() } },
  }));
  const response = await call(...status({ ...OK, 'X-Relay-Capability': 'files/1' }));
  assert.equal(response.status, 200);
  const stopped = { state: 'unavailable', reason: 'helper_stopped' };
  assert.deepEqual(response.json, {
    serverNow: NOW, terminal: stopped, files: { state: 'unavailable', reason: 'dependency_missing' },
    web: { inRelay: { state: 'unavailable', reason: 'dependency_missing' }, external: { state: 'available' } },
    browser: { dedicated: stopped, habitual: stopped },
  });
  const terminalDown = await start(t, fakeRemoteTools({ terminal: { capability: { version: 1, minAppVersion: 1 }, port: fixedPty(down.availability) }, browser: { capability: { version: 1, minAppVersion: 1 }, port: fixedBrowser(down.availability, down.availability) } }));
  const inner = (await terminalDown.call(...status({ ...OK, 'X-Relay-Capability': 'files/1' }))).json;
  assert.deepEqual([inner.terminal, inner.browser], [stopped, { dedicated: stopped, habitual: stopped }]);
});

test('remote routes require the protocol header inside the bridge range, before anything else', async (t) => {
  const { call } = await start(t, fakeRemoteTools());
  // Surrounding whitespace is optional whitespace in HTTP and never reaches the Puente.
  for (const protocol of [undefined, '1', '3', '02', '2.0', '+2', '2, 2', '0x2', '']) {
    const headers: Record<string, string> = { Authorization: OK.Authorization, 'X-Relay-Capability': 'files/1' };
    if (protocol !== undefined) headers['X-Relay-Protocol'] = protocol;
    const response = await call(...status(headers));
    assert.equal(response.status, 426, `protocol ${JSON.stringify(protocol)}`);
    assert.equal(response.json.error.code, 'protocol_upgrade_required');
    assert.doesNotMatch(response.json.error.message, /Conversaciones/);
  }
  // Protocol comes before the route: an unknown remote route with a bad protocol is still 426.
  const unknown = await call('GET', '/v1/remote/nothing', { Authorization: OK.Authorization, 'X-Relay-Protocol': '3', 'X-Relay-Capability': 'files/1' });
  assert.equal(unknown.status, 426);
  assert.equal(unknown.json.error.code, 'protocol_upgrade_required');
});

test('an unknown remote route is a plain 404 before the capability is checked', async (t) => {
  const { call } = await start(t, fakeRemoteTools());
  for (const [method, route] of [['GET', '/v1/remote/nothing'], ['POST', '/v1/remote/status'], ['GET', '/v1/remote'], ['GET', '/v1/remote/status/x']]) {
    const response = await call(method!, route!, OK);
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.equal(response.json.error.code, 'not_found');
  }
});

test('remote routes require an advertised capability at a version inside its range', async (t) => {
  const { call } = await start(t, fakeRemoteTools({ files: { capability: { version: 4, minAppVersion: 2 }, port: fixedFiles() }, terminal: undefined }));
  for (const capability of [undefined, 'files/1', 'files/5', 'terminal/1', 'unknown/1', 'constructor/1', 'files', 'files/02', 'files/2/2', 'Files/2', 'files/2, files/2', '']) {
    const headers: Record<string, string> = { ...OK };
    if (capability !== undefined) headers['X-Relay-Capability'] = capability;
    const response = await call(...status(headers));
    assert.equal(response.status, 426, `capability ${JSON.stringify(capability)}`);
    assert.equal(response.json.error.code, 'remote_upgrade_required');
  }
  for (const capability of ['files/2', 'files/4', 'environments/1', 'web/1', 'browser/1']) {
    assert.equal((await call(...status({ ...OK, 'X-Relay-Capability': capability }))).status, 200, capability);
  }
});

test('without any advertised capability no remote request is served', async (t) => {
  const { call } = await start(t);
  for (const capability of ['environments/1', 'terminal/1', 'files/1', 'web/1', 'browser/1', 'constructor/1']) {
    const response = await call(...status({ ...OK, 'X-Relay-Capability': capability }));
    assert.equal(response.status, 426, capability);
    assert.equal(response.json.error.code, 'remote_upgrade_required');
  }
});

test('remote status accepts no query', async (t) => {
  const { call } = await start(t, fakeRemoteTools());
  const response = await call('GET', '/v1/remote/status?path=/etc', { ...OK, 'X-Relay-Capability': 'files/1' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.json.error, { code: 'remote_invalid_request', message: 'La solicitud a la herramienta remota no es válida.' });
});

test('remote routes keep the key, revocation and log rules of every route', async (t) => {
  const { call, logs, revoke } = await start(t, fakeRemoteTools());
  const capability = { 'X-Relay-Capability': 'files/1' };
  assert.equal((await call(...status({ 'X-Relay-Protocol': '2', ...capability }))).status, 401);
  await call(...status({ ...OK, ...capability }));
  await call('GET', '/v1/remote/env_secret-looking-id', { ...OK, ...capability });
  await revoke();
  const revoked = await call(...status({ ...OK, ...capability }));
  assert.equal(revoked.status, 403);
  assert.equal(revoked.json.error.code, 'device_revoked');
  await setImmediate();
  assert.deepEqual(logs.map((line) => line.replace(/ \d+ms$/, '')), [
    'GET /v1/remote/status 401', 'GET /v1/remote/status 200', 'GET unmatched 404', 'GET /v1/remote/status 403',
  ]);
});

test('revocation answers a remote request still in flight at once, without waiting for its tool', { timeout: 5000 }, async (t) => {
  const entered = Promise.withResolvers<void>();
  const stuck = Promise.withResolvers<{ state: 'available' }>();
  t.after(() => stuck.resolve({ state: 'available' }));
  const port = fixedFiles(() => { entered.resolve(); return stuck.promise; });
  const { call, revoke } = await start(t, { files: { capability: { version: 1, minAppVersion: 1 }, port } });
  const inFlight = call(...status({ ...OK, 'X-Relay-Capability': 'files/1' }));
  await entered.promise;
  await revoke();
  // The tool never answers here: without the cut this request stays open until the test times out.
  const response = await inFlight;
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'device_revoked');
});

test('the web preflight allows the capability header', async (t) => {
  const { call } = await start(t, fakeRemoteTools());
  const response = await call('OPTIONS', '/v1/remote/status', { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'GET' });
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /X-Relay-Capability/);
});
