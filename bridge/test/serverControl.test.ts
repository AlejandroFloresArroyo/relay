import { createHermesServerControl } from '../src/hermesServerControl.ts';
import { createHermesHome } from '../support/hermes_home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { request } from 'node:http';
import type { TestContext } from 'node:test';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import type { ApiError, RunCreated } from '../../protocol/protocol.ts';
import { eventually } from '../support/channel.ts';

const KEY = `rly1_${Buffer.alloc(32, 19).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', 'Content-Type': 'application/json' };
async function start(t: TestContext, options: { directory?: string; hermes?: FakeHermes } = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'relay-server-control-'));
  if (!options.directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory });
  if (store.snapshot().devices.length === 0) await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000019', name: 'phone', pairedAt: 1700000000000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = options.hermes ?? new FakeHermes();
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const server = createApp({ config: { corsOrigins: ['http://localhost:8081'] }, store, pairing: createPairing({ store, origin: async () => 'http://fixture.example.ts.net:8650', serverName: 'fixture' }), hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: (line) => logs.push(line) });
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

test('pause closes admission before ACK, stops Relay Turns, rejects steer/reconnect and failed resume stays closed', async (t) => {
  const h = await start(t);
  let paused = false;
  let release!: () => void;
  let entered = false;
  t.after(() => release?.());
  h.hermes.serverControl = {
    async paused() { return paused; },
    async pause() { entered = true; await new Promise<void>((resolve) => { release = resolve; }); paused = true; },
    async resume() { throw new Error('secret upstream output'); },
  };
  const created = await h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'hello' });
  assert.equal(created.status, 200);
  const pending = h.call('POST', '/v1/server/pause');
  await eventually(() => assert.equal(entered, true));
  assert.equal((await h.call('POST', '/v1/agents/default/runs', { input: 'blocked' })).status, 409);
  assert.equal((await h.call('POST', `/v1/runs/${created.json.runId}/reconnect`)).status, 409);
  assert.equal((await h.call('POST', `/v1/runs/${created.json.runId}/steer`, { requestId: 'request-1', input: 'blocked' })).status, 409);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(h.hermes.callsTo('stopRun').length, 1);
  const failed = await h.call('POST', '/v1/server/resume');
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.json), /secret/);
  assert.equal((await h.call('POST', '/v1/agents/default/runs', { input: 'blocked' })).status, 409);
  assert.equal(h.hermes.callsTo('createRun').length, 1);
  assert.equal(h.hermes.callsTo('createConversation').length, 1, 'a rejected Turn must not create a Conversation');
});

test('pause waits for an upstream creation already admitted, attempts every stop and persists failure across restart', async (t) => {
  const h = await start(t); let paused = false;
  h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  const original = h.hermes.createRun.bind(h.hermes); let release!: () => void; let entered = false;
  h.hermes.createRun = async (...args) => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return original(...args); };
  const creating = h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'already admitted' });
  await eventually(() => assert.equal(entered, true));
  const pausing = h.call('POST', '/v1/server/pause');
  await eventually(async () => assert.equal((await h.call<{ phase: string }>('GET', '/v1/server/control')).json.phase, 'pending'));
  assert.equal((await h.call('POST', '/v1/agents/default/runs', { input: 'late' })).status, 409);
  release(); assert.equal((await creating).status, 200);
  h.hermes.stopRun = async () => { throw new Error('private upstream content'); };
  assert.equal((await pausing).status, 502);
  h.stop();
  const next = await start(t, { directory: h.directory, hermes: h.hermes });
  paused = false;
  assert.equal((await next.call<{ phase: string }>('GET', '/v1/server/control')).json.phase, 'failed');
  assert.equal((await next.call('POST', '/v1/agents/default/runs', { input: 'after restart' })).status, 409);
  assert.equal((await next.call('POST', '/v1/server/resume')).status, 200);
  assert.equal((await next.call<{ paused: boolean }>('GET', '/v1/server/control')).json.paused, false);
});

test('protocol rejection and revocation after an await never execute a control command', async (t) => {
  const h = await start(t); let commands = 0;
  h.hermes.serverControl = { async paused() { return false; }, async pause() { commands++; }, async resume() { commands++; } };
  assert.equal((await h.call('POST', '/v1/server/pause', undefined, { Authorization: AUTH.Authorization })).status, 426);
  const audit = h.store.changeLog.appendChange.bind(h.store.changeLog);
  h.store.changeLog.appendChange = async (input) => {
    const result = await audit(input);
    if (input.action === 'server.pause.requested') await h.store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
    return result;
  };
  assert.equal((await h.call('POST', '/v1/server/pause')).status, 403);
  assert.equal(commands, 0);
});

test('real control adapter only stats ESTOP, uses fixed CLI vectors, verifies exit-zero effects and hides output', async (t) => {
  const h = await start(t); const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  const calls: string[][] = []; let apply = true;
  h.hermes.serverControl = createHermesServerControl({ home: fixture.home, bin: '/synthetic/hermes', exec: async (file, args) => {
    assert.equal(file, '/synthetic/hermes'); calls.push(args);
    if (apply && args.at(-1) === 'pause') fixture.write('ESTOP', 'unread body');
    if (apply && args.at(-1) === 'resume') await fs.unlink(path.join(fixture.home, 'ESTOP'));
    return { code: 0, stdout: 'private CLI output', stderr: '' };
  } });
  assert.equal((await h.call('GET', '/v1/server/control')).status, 200); assert.equal(calls.length, 0);
  assert.equal((await h.call('POST', '/v1/server/pause')).status, 200);
  apply = false;
  const failed = await h.call('POST', '/v1/server/resume'); assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.json), /private CLI output/);
  apply = true; assert.equal((await h.call('POST', '/v1/server/resume')).status, 200);
  assert.deepEqual(calls, [['-p', 'default', 'pause'], ['-p', 'default', 'resume'], ['-p', 'default', 'resume']]);
});

test('gateway controls require protocol, serialize pending actions, verify ACK and audit no command output', async (t) => {
  const h = await start(t); let release!: () => void; let entered = false;
  h.hermes.gatewayAction = async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); };
  assert.equal((await h.call('POST', '/v1/gateway/start', undefined, { Authorization: AUTH.Authorization })).status, 426);
  const pending = h.call('POST', '/v1/gateway/stop');
  await eventually(() => assert.equal(entered, true));
  assert.equal((await h.call('POST', '/v1/gateway/restart')).status, 409);
  release(); assert.equal((await pending).status, 502, 'exit zero without the requested state is not success');
  h.hermes.gatewayAction = async () => { throw new Error('private output'); };
  const failed = await h.call('POST', '/v1/gateway/start'); assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.json), /private output/);
});

test('pause attempts all own active stops even if one fails and audit contains only control outcomes', async (t) => {
  const h = await start(t); let paused = false;
  h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  await h.call('POST', '/v1/agents/default/runs', { input: 'synthetic private text' });
  await h.call('POST', '/v1/agents/default/runs', { input: 'another private text' });
  const stops: string[] = [];
  h.hermes.stopRun = async (_profile, id) => { stops.push(id); if (id === 'run_1') throw new Error('private stop diagnostic'); };
  assert.equal((await h.call('POST', '/v1/server/pause')).status, 502);
  assert.deepEqual(stops.sort(), ['run_1', 'run_2']);
  const status = await h.call<{ paused: boolean; phase: string }>('GET', '/v1/server/control');
  assert.equal(status.json.paused, true); assert.equal(status.json.phase, 'failed');
  const audit = await fs.readFile(path.join(h.directory, 'changes.jsonl'), 'utf8');
  assert.match(audit, /server.pause.requested/); assert.match(audit, /server.pause.failed/);
  assert.doesNotMatch(audit + h.logs.join('\n'), /private text|private stop diagnostic|Bearer/);
});

test('a successful pause and resume each record requested then succeeded in changes.jsonl', async (t) => {
  const h = await start(t); let paused = false;
  h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  assert.equal((await h.call('POST', '/v1/server/pause')).status, 200);
  assert.equal((await h.call('POST', '/v1/server/resume')).status, 200);
  const audit = (await fs.readFile(path.join(h.directory, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { action: string; target: unknown });
  assert.deepEqual(audit.map((entry) => entry.action), ['server.pause.requested', 'server.pause.succeeded', 'server.resume.requested', 'server.resume.succeeded']);
  for (const entry of audit) assert.deepEqual(entry.target, { kind: 'server', id: 'local' });
});

test('a symlink or oversized durable control state fails closed without reading or replacing its target', async (t) => {
  for (const kind of ['symlink', 'oversized']) {
    const h = await start(t); h.stop();
    const file = path.join(h.directory, 'server-control.json');
    const target = path.join(h.directory, 'synthetic-private-data');
    const contents = kind === 'symlink' ? '{"paused":false,"phase":"ready","action":null}\n' : 'synthetic private contents';
    await fs.writeFile(target, contents, { mode: 0o600 });
    if (kind === 'symlink') await fs.symlink(target, file);
    else await fs.writeFile(file, 'x'.repeat(129), { mode: 0o600 });
    const next = await start(t, { directory: h.directory, hermes: h.hermes });
    const result = await next.call('POST', '/v1/agents/default/runs', { input: 'must not run' });
    assert.equal(result.status, 503); assert.equal(h.hermes.callsTo('createRun').length, 0);
    assert.equal(await fs.readFile(target, 'utf8'), contents);
    assert.doesNotMatch(JSON.stringify(result.json), /synthetic private contents/);
  }
});

test('a Turn waiting at a Hermes read cannot create a Conversation after the pause, and audit failure prevents commands', async (t) => {
  const h = await start(t); let paused = false;
  h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  let release!: () => void; let entered = false;
  t.after(() => release?.());
  h.hermes.chat = async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return { available: true, reason: null }; };
  const creating = h.call('POST', '/v1/agents/default/runs', { input: 'waiting at read' });
  await eventually(() => assert.equal(entered, true));
  const pausing = h.call('POST', '/v1/server/pause');
  await eventually(async () => assert.equal((await h.call<{ phase: string }>('GET', '/v1/server/control')).json.phase, 'pending'));
  release();
  assert.equal((await creating).status, 409); assert.equal((await pausing).status, 200);
  assert.equal(h.hermes.callsTo('createConversation').length, 0); assert.equal(h.hermes.callsTo('createRun').length, 0);
  let commands = 0; h.hermes.serverControl.resume = async () => { commands++; };
  h.store.changeLog.appendChange = async () => { throw new Error('synthetic audit failure'); };
  assert.equal((await h.call('POST', '/v1/server/resume')).status, 502); assert.equal(commands, 0);
  assert.equal((await h.call<{ paused: boolean }>('GET', '/v1/server/control')).json.paused, true);
});


for (const waiting of ['creation', 'read'] as const) {
  test(`pause stops existing Turns before awaiting an admitted upstream ${waiting}, and stops late creations`, async (t) => {
    const h = await start(t); let paused = false;
    h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
    const existing = await h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'existing synthetic Turn' });
    assert.equal(existing.status, 200);
    let release!: () => void; let entered = false;
    t.after(() => release?.());
    if (waiting === 'creation') {
      const original = h.hermes.createRun.bind(h.hermes);
      h.hermes.createRun = async (...args) => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return original(...args); };
    } else {
      h.hermes.chat = async () => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return { available: true, reason: null }; };
    }
    const creating = h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'admitted synthetic Turn' });
    await eventually(() => assert.equal(entered, true));
    const pausing = h.call('POST', '/v1/server/pause');
    void creating.catch(() => {}); void pausing.catch(() => {});
    await eventually(() => assert.ok(h.hermes.callsTo('stopRun').some((call) => call.args[1] === existing.json.runId),
      'the existing Turn must stop while the other admission is still blocked'));
    assert.equal((await h.call<{ phase: string }>('GET', '/v1/server/control')).json.phase, 'pending');
    assert.equal((await h.call('POST', '/v1/agents/default/runs', { input: 'new admission' })).status, 409);
    release();
    const created = await creating;
    assert.equal(created.status, waiting === 'creation' ? 200 : 409);
    assert.equal((await pausing).status, 200);
    if (waiting === 'creation') assert.ok(h.hermes.callsTo('stopRun').some((call) => call.args[1] === created.json.runId), 'a late upstream creation must also stop');
    else assert.equal(h.hermes.callsTo('createRun').length, 1, 'the admission guard prevents creation after a pending read');
  });
}

for (const action of ['pause', 'resume'] as const) {
  test(`restart from durable incomplete pending ${action} fails closed until explicit recovery`, async (t) => {
    const h = await start(t); h.stop();
    // Synthetic crash snapshot: the durable gate was closed, but no upstream ACK was recorded.
    const durable = JSON.stringify({ paused: true, phase: 'pending', action }) + '\n';
    await fs.writeFile(path.join(h.directory, 'server-control.json'), durable, { mode: 0o600 });
    let commands = 0;
    h.hermes.serverControl = { async paused() { return false; }, async pause() { commands++; }, async resume() { commands++; } };
    const next = await start(t, { directory: h.directory, hermes: h.hermes });
    const status = await next.call<{ paused: boolean; phase: string; action: string }>('GET', '/v1/server/control');
    assert.equal(status.status, 200); assert.equal(status.json.paused, true);
    assert.equal(status.json.phase, 'failed'); assert.equal(status.json.action, action);
    assert.equal((await next.call('POST', '/v1/agents/default/runs', { input: 'must stay blocked after crash' })).status, 409);
    assert.equal(h.hermes.callsTo('createConversation').length, 0); assert.equal(h.hermes.callsTo('createRun').length, 0);
    assert.equal(commands, 0, 'loading pending state must not replay an uncertain command');
    assert.equal(await fs.readFile(path.join(h.directory, 'server-control.json'), 'utf8'), durable);
    assert.equal((await next.call('POST', '/v1/server/resume')).status, 200);
    assert.equal(commands, 1);
    assert.equal((await next.call<{ paused: boolean; phase: string }>('GET', '/v1/server/control')).json.paused, false);
  });
}


test('pause stops an existing Turn while another admitted HTTP body is incomplete', async (t) => {
  const h = await start(t); let paused = false; let admissionChecked = 0;
  h.hermes.serverControl = { async paused() { admissionChecked++; return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  const existing = await h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'existing synthetic Turn' });
  assert.equal(existing.status, 200);
  const before = admissionChecked;
  const body = JSON.stringify({ input: 'incomplete synthetic body' });
  let finish!: () => void; let finished = false;
  const response = new Promise<number>((resolve, reject) => {
    const req = request(h.base + '/v1/agents/default/runs', { method: 'POST', headers: { ...AUTH, 'Content-Length': String(Buffer.byteLength(body)) } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject); req.write(body.slice(0, -1)); finish = () => { if (!finished) { finished = true; req.end(body.slice(-1)); } };
    t.after(() => req.destroy());
  });
  void response.catch(() => {});
  await eventually(() => assert.ok(admissionChecked > before, 'the incomplete request reached admission'));
  const pausing = h.call('POST', '/v1/server/pause');
  void pausing.catch(() => {});
  t.after(() => finish());
  await eventually(() => assert.ok(h.hermes.callsTo('stopRun').some((call) => call.args[1] === existing.json.runId), 'pause cannot wait for the body to finish before stopping active work'));
  finish();
  assert.equal(await response, 409); assert.equal((await pausing).status, 200);
  assert.equal(h.hermes.callsTo('createRun').length, 1);
});

test('an immediate stop failure remains a failed pause while late creation is still stopped', async (t) => {
  const h = await start(t); let paused = false;
  h.hermes.serverControl = { async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; } };
  const existing = await h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'existing synthetic Turn' });
  const original = h.hermes.createRun.bind(h.hermes); let release!: () => void; let entered = false;
  t.after(() => release?.());
  h.hermes.createRun = async (...args) => { entered = true; await new Promise<void>((resolve) => { release = resolve; }); return original(...args); };
  const stops: string[] = [];
  h.hermes.stopRun = async (_profile, id) => { stops.push(id); if (id === existing.json.runId) throw new Error('synthetic private stop diagnostic'); };
  const creating = h.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'late synthetic Turn' });
  void creating.catch(() => {});
  await eventually(() => assert.equal(entered, true));
  const pausing = h.call('POST', '/v1/server/pause');
  void pausing.catch(() => {});
  await eventually(() => assert.deepEqual(stops, [existing.json.runId]));
  release(); const created = await creating;
  assert.equal(created.status, 200); assert.equal((await pausing).status, 502);
  assert.deepEqual(stops, [existing.json.runId, created.json.runId], 'late sweep neither retries nor hides the initial failed result');
  const status = await h.call<{ phase: string; paused: boolean }>('GET', '/v1/server/control');
  assert.equal(status.json.phase, 'failed'); assert.equal(status.json.paused, true);
  assert.equal((await h.call('POST', '/v1/agents/default/runs', { input: 'blocked' })).status, 409);
});
