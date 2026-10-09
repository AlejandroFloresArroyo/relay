// The whole bridge wired the way main.ts wires it (HTTP server -> RunManager -> RealHermes),
// against a fake Hermes API server and a throwaway HERMES_HOME. Nothing here touches ~/.hermes.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exactObject } from '../src/changeLog.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Approval, ChatRunEvent, RunEvent, RunSnapshot, SteerAccepted } from '../../protocol/protocol.ts';
import type { Exec } from '../src/exec.ts';
import { RealHermes } from '../src/hermes_real.ts';
import { createNotifier } from '../src/notify.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { eventually } from '../support/channel.ts';
import { FakeUpstream } from '../support/fake_upstream.ts';
import { CODING_KEY, createHermesHome, DEFAULT_KEY, writeStateDb } from '../support/hermes_home.ts';

const DEVICE_KEY = `rly1_${Buffer.alloc(32, 9).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${DEVICE_KEY}` };

async function boot(t: TestContext, options: { api: boolean } = { api: true }) {
  const upstream = await new FakeUpstream({ default: DEFAULT_KEY, coding: CODING_KEY }).start();
  const fixture = createHermesHome({ apiPort: options.api ? upstream.port : null });
  for (const profile of ['default', 'coding']) writeStateDb(path.join(fixture.home, profile === 'default' ? '' : `profiles/${profile}`, 'state.db'), [], []);
  upstream.respond('POST', '/api/sessions', (request, response) => {
    const body: unknown = request.body;
    assert.ok(exactObject(body, ['id', 'source']));
    assert.equal(typeof body.id, 'string'); assert.equal(body.source, 'api_server');
    const db = new DatabaseSync(path.join(fixture.home, request.profile === 'default' ? '' : `profiles/${request.profile}`, 'state.db'));
    try { db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(String(body.id), 'api_server', Date.now() / 1000); }
    finally { db.close(); }
    upstream.seedSession(request.profile, { id: String(body.id), source: 'api_server', title: null });
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ object: 'hermes.session', session: { id: body.id, source: 'api_server', title: null } }));
  });
  const execCalls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    execCalls.push(args);
    return { code: 0, stdout: 'Hermes Agent v0.21.5 (test)\n', stderr: '' };
  };
  const hermes = new RealHermes({ home: fixture.home, bin: 'hermes', exec, procRoot: fixture.procRoot });

  const pushes: { url: string; body: string }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    pushes.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('', { status: 200 });
  }) as typeof fetch;
  const logs: string[] = [];
  const runs = new RunManager({
    hermes,
    notifier: createNotifier('https://ntfy.invalid/relay-test-topic', fakeFetch),
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-e2e-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000001', name: 'phone', pairedAt: Date.now(), revokedAt: null, keyHash: hashDeviceKey(DEVICE_KEY).toString('hex') }); });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  const server = createApp({
    config: { corsOrigins: [] }, store, pairing, peerAddress: () => '100.64.0.1',
    hermes,
    runs,
    tailnet: { whois: async () => null },
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    runs.close();
    server.closeAllConnections();
    server.close();
    await upstream.stop();
    fixture.cleanup();
  });

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? AUTH : { ...AUTH, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith('{') ? JSON.parse(text) : null };
  }
  return { upstream, base, call, pushes, logs, execCalls };
}

function approvalFields(requestId: string, command: string) {
  return {
    command,
    description: 'recursive delete',
    pattern_key: 'recursive delete',
    pattern_keys: ['recursive delete'],
    allow_permanent: true,
    allow_session: true,
    request_id: requestId,
    choices: ['once', 'session', 'always', 'deny'],
  };
}

test('an approval raised with no app attached reaches the inbox, pushes a notification, and the decision goes back to the run and profile that asked', async (t) => {
  const { upstream, call, pushes } = await boot(t);

  const coding = (await call('POST', '/v1/agents/coding/runs', { input: 'limpia el build' })).json;
  const other = (await call('POST', '/v1/agents/default/runs', { input: 'otra cosa' })).json;
  assert.notEqual(coding.runId, other.runId);

  // No client is subscribed to either run. The bridge must be reading both streams on its own.
  await eventually(() => assert.equal(upstream.requestsTo('GET', /\/events$/).length, 2));
  upstream.emit(coding.runId, 'tool.started', { tool: 'terminal', preview: 'rm -rf build/' });
  upstream.emit(coding.runId, 'approval.request', approvalFields('req_coding', 'rm -rf build/'));
  upstream.emit(other.runId, 'approval.request', approvalFields('req_default', 'rm -rf /tmp/x'));

  let approvals: Approval[] = [];
  await eventually(async () => {
    approvals = (await call('GET', '/v1/approvals')).json.approvals;
    assert.equal(approvals.length, 2);
  });
  const mine = approvals.find((approval) => approval.id === 'req_coding')!;
  assert.equal(mine.runId, coding.runId);
  assert.equal(mine.agentId, 'coding');
  assert.equal(mine.command, 'rm -rf build/');
  assert.deepEqual(mine.risk, { level: 3, label: 'RIESGO MEDIO', summary: 'recursive delete' });
  assert.equal(mine.expiresAt, mine.createdAt + 300_000, 'coding has no approvals.timeout: Hermes default of 300 s');
  const theirs = approvals.find((approval) => approval.id === 'req_default')!;
  assert.equal(theirs.expiresAt, theirs.createdAt + 120_000, 'default profile sets approvals.timeout: 120');

  await eventually(() => assert.equal(pushes.length, 2));
  assert.ok(pushes.every((push) => push.url === 'https://ntfy.invalid/relay-test-topic'));
  assert.ok(!JSON.stringify(pushes).includes('rm -rf'), 'the command is not pushed');

  const agents = (await call('GET', '/v1/agents')).json.agents;
  assert.deepEqual(
    agents.map((agent: { id: string; status: string; pendingApprovals: number }) => [agent.id, agent.status, agent.pendingApprovals]),
    [
      ['default', 'busy', 1],
      ['coding', 'busy', 1],
      ['personal', 'err', 0],
    ],
  );

  const decided = await call('POST', '/v1/approvals/req_coding', { choice: 'once' });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.json, { ok: true });

  const relayed = upstream.requestsTo('POST', /\/approval$/);
  assert.equal(relayed.length, 1, 'exactly one decision goes upstream');
  assert.equal(relayed[0].profile, 'coding');
  assert.equal(relayed[0].path, `/v1/runs/${coding.runId}/approval`);
  assert.equal(relayed[0].authorized, true, 'signed with the coding profile key');
  assert.deepEqual(relayed[0].body, { choice: 'once', request_id: 'req_coding' });

  const left = (await call('GET', '/v1/approvals')).json.approvals;
  assert.deepEqual(left.map((approval: Approval) => approval.id), ['req_default'], 'the other approval is untouched');

  // Hermes confirms on the stream and finishes the run; a client attaching now replays it all.
  upstream.emit(coding.runId, 'approval.responded', { choice: 'once', request_id: 'req_coding', resolved: 1 });
  upstream.emit(coding.runId, 'tool.completed', { tool: 'terminal', duration: 0.42, error: false, preview: '' });
  upstream.emit(coding.runId, 'run.completed', { output: 'Build limpio.' });
  upstream.closeStream(coding.runId);

  let events: RunEvent[] = [];
  await eventually(async () => {
    const stream = await call('GET', `/v1/runs/${coding.runId}/events`);
    events = stream.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1)?.type, 'run.completed');
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool.started', 'approval.request', 'approval.resolved', 'tool.completed', 'run.completed'],
  );
  assert.deepEqual(events[2], { type: 'approval.resolved', approvalId: 'req_coding', choice: 'once', resolution: 'decision' });
});

test('a deny is relayed as a deny', async (t) => {
  const { upstream, call } = await boot(t);
  const run = (await call('POST', '/v1/agents/coding/runs', { input: 'x' })).json;
  await eventually(() => assert.equal(upstream.requestsTo('GET', /\/events$/).length, 1));
  upstream.emit(run.runId, 'approval.request', approvalFields('req_1', 'rm -rf node_modules'));
  await eventually(async () => assert.equal((await call('GET', '/v1/approvals')).json.approvals.length, 1));
  await call('POST', '/v1/approvals/req_1', { choice: 'deny' });
  assert.deepEqual(upstream.requestsTo('POST', /\/approval$/)[0].body, { choice: 'deny', request_id: 'req_1' });
});

test('the bridge resumes a run stream that Hermes dropped, without losing or repeating events', async (t) => {
  const { upstream, call } = await boot(t);
  const run = (await call('POST', '/v1/agents/coding/runs', { input: 'x' })).json;
  await eventually(() => assert.equal(upstream.requestsTo('GET', /\/events$/).length, 1));
  upstream.emit(run.runId, 'message.delta', { delta: 'uno ' });
  upstream.emit(run.runId, 'message.delta', { delta: 'dos ' });
  await eventually(() => assert.equal(upstream.runs.get(run.runId)!.subscribers.size, 1));
  // Give the bridge time to read both events before the connection dies.
  await new Promise((resolve) => setTimeout(resolve, 50));
  upstream.dropConnections(run.runId);

  await eventually(() => assert.equal(upstream.requestsTo('GET', /\/events$/).length, 2));
  assert.equal(upstream.requestsTo('GET', /\/events$/)[1].lastEventId, '1');
  upstream.emit(run.runId, 'message.delta', { delta: 'tres' });
  upstream.emit(run.runId, 'run.completed', { output: 'uno dos tres' });
  upstream.closeStream(run.runId);

  await eventually(async () => {
    const stream = await call('GET', `/v1/runs/${run.runId}/events`);
    const events = stream.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(events, [
      { type: 'message.delta', text: 'uno ' },
      { type: 'message.delta', text: 'dos ' },
      { type: 'run.connection', connection: 'reconnecting' },
      { type: 'run.connection', connection: 'connected' },
      { type: 'message.delta', text: 'tres' },
      { type: 'run.completed', output: 'uno dos tres' },
    ]);
  });
});

test('stop is relayed to the run of the owning profile', async (t) => {
  const { upstream, call } = await boot(t);
  const run = (await call('POST', '/v1/agents/coding/runs', { input: 'x' })).json;
  const stopped = await call('POST', `/v1/runs/${run.runId}/stop`);
  assert.deepEqual(stopped.json, { ok: true });
  const [post] = upstream.requestsTo('POST', /\/stop$/);
  assert.equal(post.profile, 'coding');
  assert.equal(post.path, `/v1/runs/${run.runId}/stop`);
  assert.equal(post.authorized, true);
});

test('with the Hermes API server off, chat answers 503 with the reason and the rest of the bridge keeps working', async (t) => {
  const { upstream, call } = await boot(t, { api: false });

  const info = (await call('GET', '/v1/server')).json;
  assert.equal(info.hermesVersion, '0.21.5');
  assert.equal(info.profiles, 3);
  assert.equal(info.chat.available, false);
  assert.match(info.chat.reason, /API_SERVER_KEY/);

  const run = await call('POST', '/v1/agents/coding/runs', { input: 'hola' });
  assert.equal(run.status, 503);
  assert.equal(run.json.error.code, 'chat_unavailable');
  assert.match(run.json.error.message, /Agente.*no está disponible/);

  assert.deepEqual((await call('GET', '/v1/gateway')).json, { state: 'active', pid: 4242, uptimeSeconds: 5000, port: null });
  const beforeApprovals = Date.now();
  const pending = (await call('GET', '/v1/approvals')).json;
  assert.deepEqual(pending.approvals, []);
  assert.ok(Number.isSafeInteger(pending.serverNow) && pending.serverNow >= beforeApprovals && pending.serverNow <= Date.now());
  assert.equal((await call('GET', '/v1/agents')).json.agents.length, 3);
  assert.equal((await call('GET', '/v1/jobs')).json.jobs.length, 2);
  assert.equal((await call('GET', '/v1/logs?level=ERROR')).json.lines.length, 2);
  assert.deepEqual((await call('GET', '/v1/model')).json, { model: 'deepseek-v4.1-flash', provider: 'opencode-go' });
  assert.equal(upstream.requests.length, 0, 'nothing is sent to an API server that is not configured');
});

test('no response and no log line ever contains a Hermes API key or a provider key from .env', async (t) => {
  const { call, logs, upstream } = await boot(t);
  const bodies: string[] = [];
  for (const path of ['/v1/server', '/v1/agents', '/v1/gateway', '/v1/logs', '/v1/model', '/v1/jobs', '/v1/approvals']) {
    bodies.push((await call('GET', path)).text);
  }
  bodies.push((await call('POST', '/v1/agents/personal/runs', { input: 'x' })).text);
  upstream.keys.coding = 'rotated-so-the-bridge-key-is-now-wrong';
  bodies.push((await call('POST', '/v1/agents/coding/runs', { input: 'x' })).text);

  const everything = [...bodies, ...logs].join('\n');
  for (const secret of [DEFAULT_KEY, CODING_KEY, 'provider-secret-should-never-leak', DEVICE_KEY]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 8)}…`);
  }
});

test('#37 the real HTTP pipeline redirects the owning Agent, resumes a snapshot and preserves an undelivered terminal instruction', async (t) => {
  const { base, call, upstream, logs } = await boot(t);
  const created = await call('POST', '/v1/agents/coding/runs', { input: 'Entrada privada del Turno' });
  assert.equal(created.status, 200);
  const runId: string = created.json.runId;
  const headers = { ...AUTH, 'X-Relay-Protocol': '2', 'Content-Type': 'application/json' };
  await eventually(() => assert.equal(upstream.runs.get(runId)?.subscribers.size, 1));
  upstream.emit(runId, 'message.delta', { delta: 'Parcial' });
  const request = { requestId: 'real-steer', input: 'Instrucción privada pendiente' };
  const response = await fetch(`${base}/v1/runs/${runId}/steer`, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(response.status, 200);
  const receipt = await response.json() as SteerAccepted;
  assert.deepEqual(receipt, { runId, requestId: 'real-steer', accepted: true });
  const repeated = await fetch(`${base}/v1/runs/${runId}/steer`, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(repeated.status, 200); await repeated.body?.cancel();
  assert.deepEqual(upstream.requestsTo('POST', /\/steer$/).map((entry) => [entry.profile, entry.body]), [['coding', { input: request.input }]]);
  assert.equal(upstream.requestsTo('POST', /\/stop$/).length, 0);
  await eventually(async () => {
    const state = await fetch(`${base}/v1/runs/${runId}`, { headers });
    const snapshot = await state.json() as RunSnapshot;
    assert.equal(snapshot.items.some((item) => item.kind === 'assistant' && item.text === 'Parcial'), true);
  });
  const state = await fetch(`${base}/v1/runs/${runId}`, { headers });
  const snapshot = await state.json() as RunSnapshot;
  const cursor = snapshot.lastEventId;
  assert.deepEqual(snapshot.steers, [{ requestId: 'real-steer', status: 'accepted' }]);
  assert.equal(snapshot.items.some((item) => item.kind === 'user' && item.text === request.input && item.redirected), true);
  upstream.emit(runId, 'run.completed', { output: 'Respuesta completa', pending_steer: request.input });
  upstream.closeStream(runId);
  const stream = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { ...headers, 'Last-Event-ID': String(cursor) } });
  const frames = (await stream.text()).split('\n').filter((line) => line.startsWith('data: '));
  const events = frames.map((line) => JSON.parse(line.slice(6)) as ChatRunEvent);
  assert.deepEqual(events, [{ type: 'run.completed', output: 'Respuesta completa', pendingSteer: request.input }]);
  const reconnected = await fetch(`${base}/v1/runs/${runId}/reconnect`, { method: 'POST', headers, body: '{}' });
  const final = await reconnected.json() as RunSnapshot;
  assert.equal(final.phase, 'completed'); assert.equal(final.terminal?.pendingSteer, request.input);
  assert.equal(upstream.requestsTo('POST', /^\/v1\/runs$/).length, 1);
  assert.doesNotMatch(logs.join('\n'), /Entrada privada|Instrucción privada|real-steer/);
  assert.match(logs.join('\n'), /POST \/v1\/runs\/:id\/steer 200/);
});
