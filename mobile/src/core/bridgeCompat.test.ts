// Acceptance, scenario 6 (second part) of docs/relay-v3.md §7 and #97: «Probar un Puente sin V3».
// The app of this build (its real core: protocol check, remote tool states, remote client and the
// v1/v2 client) against the real Puente of the v2 release, the one production runs
// (`~/dev/relay-app-bridge-v2.0.0`, 3498e99, relayd 0.2.0-preview.3, observed /health without
// `capabilities`), against this build's Puente with no V3 tool configured, and through a rollback
// from a V3 Puente to v2 at the same address. Nothing V3 is sent to a Puente that did not advertise
// it, nothing fakes success, and the functions of v1 and v2 keep working.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBridgeClient } from './bridgeClient.ts';
import type { RelayClient } from './client.ts';
import { checkProtocolVersion } from './protocolVersion.ts';
import { remoteToolStates, type RemoteToolStates } from './remoteCapabilities.ts';
import { createRemoteClient, fetchRemoteStatus, RemoteFailure } from './remoteClient.ts';
import { hashDeviceKey } from '../../../bridge/src/auth.ts';
import { createDeviceStore } from '../../../bridge/src/deviceStore.ts';
import { createPairing } from '../../../bridge/src/pairing.ts';
import { RunManager } from '../../../bridge/src/runs.ts';
import { createApp } from '../../../bridge/src/server.ts';
import type { RemoteTools } from '../../../bridge/src/remote/ports.ts';
import { FakeHermes } from '../../../bridge/support/fake_hermes.ts';
import { fakeRemoteTools } from '../../../bridge/support/fake_remote.ts';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** The Puente of the v2 release: production runs this commit (bridge/update-entry.ts of relay-app-bridge-v2.0.0). */
const V2_COMMIT = '3498e99';
const KEY = `rly1_${Buffer.alloc(32, 5).toString('base64url')}`;
const DEVICE = '00000000-0000-4000-8000-000000000005';
/** One address for the Servidor, whatever Puente answers there (the rollback swaps it). */
const SERVER = 'http://servidor-relay.ts.net:8650';

async function v2Tree(): Promise<string | false> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-bridge-v2-'));
  try {
    await run('git', ['-C', REPO, 'archive', '-o', path.join(root, 'v2.tar'), V2_COMMIT, 'bridge', 'protocol']);
    await run('tar', ['-xf', path.join(root, 'v2.tar'), '-C', root]);
    return root;
  } catch {
    await fs.rm(root, { recursive: true, force: true });
    return false;
  }
}
const V2 = await v2Tree();
const SKIP = V2 ? false : `the v2 Puente (${V2_COMMIT}) is not in this clone's history`;

interface Running { base: string; requests: string[]; close(): void }

/** The v2 release's own createApp, store, pairing, runs and FakeHermes, loaded from its tree. */
async function startV2(t: TestContext): Promise<Running> {
  // Dynamic on purpose: the module path is the extracted v2 tree, chosen at run time.
  const load = (file: string) => import(pathToFileURL(path.join(V2 as string, 'bridge', file)).href);
  const [{ createApp: createV2App }, { createDeviceStore: createV2Store }, { createPairing: createV2Pairing }, { RunManager: V2Runs }, { FakeHermes: V2Hermes }, { hashDeviceKey: v2Hash }] = await Promise.all([
    load('src/server.ts'), load('src/deviceStore.ts'), load('src/pairing.ts'), load('src/runs.ts'), load('support/fake_hermes.ts'), load('src/auth.ts'),
  ]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-v2-state-'));
  const store = await createV2Store({ directory });
  await store.mutate((draft: { devices: unknown[] }) => { draft.devices.push({ id: DEVICE, name: 'phone', pairedAt: Date.now(), revokedAt: null, keyHash: v2Hash(KEY).toString('hex') }); });
  const hermes = new V2Hermes();
  const runs = new V2Runs({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const requests: string[] = [];
  const server = createV2App({
    config: { corsOrigins: [] }, store, pairing: createV2Pairing({ store, origin: async () => SERVER, serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, hostname: 'arch', version: '0.2.0-preview.3',
    log: (line: string) => requests.push(line),
  });
  return listen(t, server, requests, () => { runs.close(); }, directory);
}

/** This build's Puente; `remote` as main.ts would wire it from RELAY_SUPERVISOR_DIR, RELAY_REMOTE_FILES, RELAY_REMOTE_WEB. */
async function startCurrent(t: TestContext, remote: RemoteTools | undefined): Promise<Running> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-v3-state-'));
  const store = await createDeviceStore({ directory });
  await store.mutate((draft) => { draft.devices.push({ id: DEVICE, name: 'phone', pairedAt: Date.now(), revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const requests: string[] = [];
  const server = createApp({
    config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => SERVER, serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, hostname: 'arch', version: '9.9.9',
    log: (line) => requests.push(line), remote,
  });
  return listen(t, server, requests, () => { runs.close(); }, directory);
}

async function listen(t: TestContext, server: Server, requests: string[], stop: () => void, directory: string): Promise<Running> {
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stop(); server.closeAllConnections(); server.close();
  };
  t.after(async () => { close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close };
}

/** The phone's transport to the Servidor's one address; every path that reaches a Puente is kept. */
function phone(at: { current: Running }) {
  const sent: string[] = [];
  const routed: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith(SERVER), url);
    sent.push(`${init?.method ?? 'GET'} ${url.slice(SERVER.length)}`);
    return fetch(at.current.base + url.slice(SERVER.length), init);
  };
  const client = createBridgeClient({ baseUrl: SERVER, key: KEY, fetch: routed });
  const transport = { baseUrl: SERVER, key: KEY, fetch: routed };
  /** What the app decides from a /health it just received. */
  const states = async (): Promise<RemoteToolStates> => remoteToolStates({ health: { body: await client.health(), at: 1 }, lastConnectionFailureAt: null, bridgeChangedAt: null, status: null });
  return { client, transport, sent, states, remote: () => sent.filter((line) => line.includes('/v1/remote/')) };
}

const TOOLS = ['terminal', 'files', 'webInRelay', 'webExternal', 'browserDedicated', 'browserHabitual'] as const;

/** The functions of v1 and v2 the app uses everywhere: they answer as before. */
async function v1AndV2Work(client: RelayClient) {
  const agents = await client.agents();
  assert.ok(Array.isArray(agents) && agents.length > 0);
  await client.conversations(agents[0]!.id);
  assert.equal((await client.server()).host, 'arch');
  assert.ok(Array.isArray(await client.approvals()));
  await client.whoami();
}

test('the app keeps v1 and v2 working with the Puente of the v2 release and offers no V3 tool: «Actualiza el Puente», nothing sent', { skip: SKIP }, async (t) => {
  const v2 = await startV2(t);
  const app = phone({ current: v2 });
  const health = await app.client.health();
  assert.equal(health.protocolVersion, 2);
  assert.equal('capabilities' in health, false, 'the v2 release advertises nothing');
  assert.equal(checkProtocolVersion(health).kind, 'compatible');
  const states = await app.states();
  for (const tool of TOOLS) assert.deepEqual(states.tools[tool], { state: 'update_bridge' }, tool);
  assert.equal(states.status, null, 'the authenticated status must not be asked for');
  // Even asked to, the remote core sends nothing without an advertised capability.
  await assert.rejects(fetchRemoteStatus(app.transport, () => states.status));
  await v1AndV2Work(app.client);
  assert.deepEqual(app.remote(), [], 'no request to /v1/remote/* left the phone');
  assert.ok(v2.requests.every((line) => !line.includes('/v1/remote')), v2.requests.join('\n'));
});

test('this build\'s Puente with no V3 tool configured (production default) advertises none; the app behaves as with v2', async (t) => {
  const bare = await startCurrent(t, undefined);
  const app = phone({ current: bare });
  const health = await app.client.health();
  assert.deepEqual(health.capabilities, {});
  const states = await app.states();
  for (const tool of TOOLS) assert.deepEqual(states.tools[tool], { state: 'update_bridge' }, tool);
  assert.equal(states.status, null);
  await v1AndV2Work(app.client);
  assert.deepEqual(app.remote(), []);
});

test('a rollback from a V3 Puente to the v2 release at the same address retires the remote client: one 404, then nothing more is sent', { skip: SKIP }, async (t) => {
  const v3 = await startCurrent(t, fakeRemoteTools());
  const at = { current: v3 };
  const app = phone(at);
  const before = await app.states();
  assert.equal(before.status?.name, 'environments');
  const status = await fetchRemoteStatus(app.transport, () => before.status);
  const ready = remoteToolStates({ health: { body: await app.client.health(), at: 1 }, lastConnectionFailureAt: null, bridgeChangedAt: null, status: { body: status, at: 2 } });
  assert.equal(ready.tools.terminal?.state, 'available');
  // As the app's terminals list (state/remoteTools.ts): the negotiated environments capability.
  const environments = { state: 'available' as const, capability: ready.status! };
  const remote = createRemoteClient(app.transport, environments, () => environments);
  await remote.request('GET', '/v1/remote/environments');

  // The person reinstalls the v2 release on the Servidor.
  v3.close();
  at.current = await startV2(t);
  const sentBefore = app.remote().length;
  await assert.rejects(remote.request('GET', '/v1/remote/environments'), (error) => error instanceof RemoteFailure && error.kind === 'bridge_changed');
  await assert.rejects(remote.request('GET', '/v1/remote/environments'), (error) => error instanceof RemoteFailure);
  assert.equal(app.remote().length, sentBefore + 1, 'one request found the old Puente; the retired client sent nothing more');
  const after = await app.states();
  for (const tool of TOOLS) assert.deepEqual(after.tools[tool], { state: 'update_bridge' }, tool);
  await v1AndV2Work(app.client);
});

test.after(async () => { if (V2) await fs.rm(V2, { recursive: true, force: true }); });
