import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import type { ApiError } from '../../protocol/protocol.ts';
import { createHermesAgentTools } from '../src/hermesAgentTools.ts';
import { HermesError } from '../src/hermes.ts';
import { realExec } from '../src/exec.ts';
import type { HermesAgentTools } from '../src/agentToolsPort.ts';
const KEY = `rly1_${Buffer.alloc(32, 19).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', 'Content-Type': 'application/json' };
async function start(t: TestContext, options: { directory?: string; hermes?: FakeHermes } = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.resolve('tools-http-fixture-'));
  if (!options.directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory });
  if (store.snapshot().devices.length === 0) await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000019', name: 'phone', pairedAt: 1700000000000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = options.hermes ?? new FakeHermes();
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const server = createApp({ config: { corsOrigins: ['http://localhost:8081'] }, store, pairing: createPairing({ store, origin: async () => 'http://fixture.example.ts.net:17651', serverName: 'fixture' }), hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call<T = ApiError>(method: string, route: string, body?: unknown, headers: Record<string, string> = AUTH) {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // Each test asserts the exercised wire shape and status independently.
    const json = await response.json() as T;
    return { status: response.status, headers: response.headers, json };
  }
  return { call, hermes, runs, directory, store, logs, base, stop: () => { runs.close(); server.closeAllConnections(); server.close(); } };
}


test('tools routes enforce auth, protocol, body and profile before calling the optional Hermes port', async (t) => {
  const hermes = new FakeHermes();
  const calls: unknown[] = [];
  const catalog = { platform: 'api_server' as const, toolsets: [], observedAt: 1700000000000, appliesTo: 'next_turn' as const };
  const port: HermesAgentTools = {
    async tools(profile) { calls.push(['tools', profile]); return catalog; },
    async skills(profile) { calls.push(['skills', profile]); return { skills: [], observedAt: 1700000000000, scope: 'profile_installed', limited: false }; },
    async setToolset(profile, name, enabled, context) { context.guard(); await context.beforeWrite(); calls.push(['set', profile, name, enabled]); return catalog; },
  };
  Object.assign(hermes, { agentTools: port });
  const { call, directory, logs } = await start(t, { hermes });
  assert.equal((await call('GET', '/v1/agents/default/tools', undefined, {})).status, 401);
  assert.equal((await call('POST', '/v1/agents/default/tools/terminal', { enabled: true }, { Authorization: AUTH.Authorization })).status, 426);
  assert.equal((await call('POST', '/v1/agents/default/tools/terminal', { enabled: 'yes' })).status, 400);
  assert.equal((await call('GET', '/v1/agents/missing/tools')).status, 404);
  assert.deepEqual(calls, []);
  const reading = await call<{ platform: string; appliesTo: string }>('GET', '/v1/agents/default/tools');
  assert.equal(reading.status, 200);
  assert.equal(reading.json.platform, 'api_server');
  assert.equal(reading.json.appliesTo, 'next_turn');
  assert.equal((await call('GET', '/v1/agents/default/skills')).status, 200);
  const saved = await call<{ platform: string; appliesTo: string }>('POST', '/v1/agents/default/tools/terminal', { enabled: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.platform, 'api_server');
  assert.equal(saved.json.appliesTo, 'next_turn');
  assert.deepEqual(calls, [['tools', 'default'], ['skills', 'default'], ['set', 'default', 'terminal', false]]);
  const audit = await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8');
  assert.match(audit, /agent.tools.disable.requested/); assert.doesNotMatch(audit, /terminal|enabled/);
  assert.doesNotMatch(logs.join('\n'), /Bearer|enabled/);
});

test('older Hermes ports report unavailable', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('GET', '/v1/agents/default/tools')).status, 503);
});


test('blocked enable returns a safe actionable code without changing global settings', async (t) => {
  const hermes = new FakeHermes();
  const running = await start(t, { hermes });
  const home = path.join(running.directory, 'synthetic-profile'); await fs.mkdir(home);
  const raw = 'agent:\n  disabled_toolsets: [terminal]\n'; await fs.writeFile(path.join(home, 'config.yaml'), raw);
  Object.assign(hermes, { agentTools: createHermesAgentTools({ profileHome: () => home, python: 'python3', exec: realExec,
    toolsets: async () => ({ platform: 'api_server', data: [{ name: 'terminal', label: 'Terminal', description: 'Execute', enabled: false, configured: true, tools: ['terminal'] }] }),
  }) });
  const result = await running.call('POST', '/v1/agents/default/tools/terminal', { enabled: true });
  assert.equal(result.status, 409); assert.equal(result.json.error.code, 'tool_global_restriction');
  assert.match(result.json.error.message, /restricciones globales/);
  assert.equal(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'), raw);
});

test('revocation while metadata is being read blocks both the response and profile write', async (t) => {
  const hermes = new FakeHermes();
  const running = await start(t, { hermes });
  const home = path.join(running.directory, 'synthetic-profile'); await fs.mkdir(home);
  const raw = 'model: fixture\n'; await fs.writeFile(path.join(home, 'config.yaml'), raw);
  let reached!: () => void; const reading = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  Object.assign(hermes, { agentTools: createHermesAgentTools({ profileHome: () => home, python: 'python3',
    exec: async (file, args, options) => { reached(); await pending; return realExec(file, args, options); },
    toolsets: async () => ({ platform: 'api_server', data: [{ name: 'terminal', label: 'Terminal', description: 'Execute', enabled: true, configured: true, tools: ['terminal'] }] }),
  }) });
  const response = running.call('POST', '/v1/agents/default/tools/terminal', { enabled: false });
  await reading;
  await running.store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
  release();
  const result = await response;
  assert.equal(result.status, 403); assert.equal(result.json.error.code, 'device_revoked');
  assert.equal(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'), raw);
  assert.equal((await fs.readdir(running.directory)).filter((name) => name.endsWith('.previous')).length, 0);
});


test('tools errors and request logs never include private adapter output or route identities', async (t) => {
  const hermes = new FakeHermes();
  Object.assign(hermes, { agentTools: {
    async tools() { throw new HermesError('agent_tools_unavailable', 'synthetic-private-error'); },
  } });
  const running = await start(t, { hermes });
  const result = await running.call('GET', '/v1/agents/default/tools');
  assert.equal(result.status, 503);
  assert.equal(result.json.error.message, 'No se pudieron leer las herramientas o skills del Agente. Reintenta.');
  assert.doesNotMatch(JSON.stringify(result.json), /synthetic-private-error/);
  assert.doesNotMatch(running.logs.join('\n'), /default|synthetic-private-error/);
  assert.match(running.logs.join('\n'), /GET \/v1\/agents\/:id\/tools 503/);
});
