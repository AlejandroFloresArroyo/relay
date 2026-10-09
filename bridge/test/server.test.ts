import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { createDecisionStore, type DecisionStore } from '../src/decisionStore.ts';
import type { Approval, RunEvent } from '../../protocol/protocol.ts';
import { HermesError } from '../src/hermes.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { eventually, settle } from '../support/channel.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}` };

async function start(t: TestContext, peer = '100.64.0.1', decisionStore?: DecisionStore) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1_700_000_000_000;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000001', name: 'phone', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  const hermes = new FakeHermes();
  const notified: Approval[] = [];
  const logs: string[] = [];
  const runs = new RunManager({
    hermes, decisionStore,
    notifier: {
      async approvalCreated(approval) {
        notified.push(approval);
      },
    },
    sleep: async () => {},
  });
  const whoisCalls: string[] = [];
  const server = createApp({
    config: { corsOrigins: ['http://localhost:8081'] },
    store, pairing, peerAddress: () => peer,
    hermes,
    runs,
    tailnet: {
      async whois(ip) {
        whoisCalls.push(ip);
        return ip === '100.84.12.7' ? { device: 'iphone-dev', tailnet: 'tail0a1b2c.ts.net' } : null;
      },
    },
    hostname: 'arch',
    version: '9.9.9',
    now: () => clock,
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    runs.close();
    server.closeAllConnections();
    server.close();
  });

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? { ...headers, ...(path.startsWith('/v1/gateway/') ? { 'X-Relay-Protocol': '2' } : {}) } : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (SSE or empty)
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  return { hermes, runs, base, call, whoisCalls, notified, logs, advanceWindow: () => { clock += 60_000; } };
}

function approvalEvent(fields: Record<string, unknown> = {}) {
  return {
    event: 'approval.request',
    seq: 0,
    command: 'rm -rf build/',
    description: 'recursive delete',
    pattern_key: 'recursive delete',
    request_id: 'req_a',
    choices: ['once', 'session', 'always', 'deny'],
    timestamp: Date.now() / 1000,
    ...fields,
  };
}

function sseEvents(text: string): RunEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as RunEvent);
}

// ---- public routes ------------------------------------------------------------------------

test('GET /health needs no key', async (t) => {
  const { call } = await start(t);
  const response = await call('GET', '/health', undefined, {});
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, service: 'relayd', version: '9.9.9', protocolVersion: 2, minAppProtocolVersion: 2, capabilities: {} });
});

test('GET /v1/whoami needs no key; a direct local caller is not on the tailnet', async (t) => {
  const { call, whoisCalls } = await start(t, '127.0.0.1');
  const response = await call('GET', '/v1/whoami', undefined, {});
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { tailscale: false, device: null, ip: null, tailnet: null });
  assert.deepEqual(whoisCalls, []);
});

test('GET /v1/whoami identifies a direct tailnet peer and ignores forwarding', async (t) => {
  const { call, whoisCalls } = await start(t, '100.84.12.7');
  const response = await call('GET', '/v1/whoami', undefined, { 'X-Forwarded-For': '100.84.12.8' });
  assert.deepEqual(response.json, {
    tailscale: true,
    device: 'iphone-dev',
    ip: '100.84.12.7',
    tailnet: 'tail0a1b2c.ts.net',
  });
  assert.deepEqual(whoisCalls, ['100.84.12.7']);
});

test('GET /v1/whoami never passes any forwarded address to tailscale', async (t) => {
  const { call, whoisCalls } = await start(t, '127.0.0.1');
  for (const forwarded of ['8.8.8.8', '100.84.12.7; rm -rf /', '--json', '100.200.1.1']) {
    const response = await call('GET', '/v1/whoami', undefined, { 'X-Forwarded-For': forwarded });
    assert.deepEqual(response.json, { tailscale: false, device: null, ip: null, tailnet: null }, forwarded);
  }
  assert.deepEqual(whoisCalls, []);
});

// ---- auth ---------------------------------------------------------------------------------

const PROTECTED: [string, string][] = [
  ['GET', '/v1/server'],
  ['GET', '/v1/agents'],
  ['GET', '/v1/agents/coding/transcript'],
  ['POST', '/v1/agents/coding/runs'],
  ['GET', '/v1/runs/run_1/events'],
  ['POST', '/v1/runs/run_1/stop'],
  ['GET', '/v1/approvals'],
  ['POST', '/v1/approvals/req_a'],
  ['GET', '/v1/gateway'],
  ['POST', '/v1/gateway/stop'],
  ['POST', '/v1/doctor'],
  ['GET', '/v1/logs'],
  ['GET', '/v1/model'],
  ['GET', '/v1/jobs'],
  ['GET', '/v1/does-not-exist'],
];

test('every private route answers 401 for an unpenalized unknown key and never reaches Hermes', async (t) => {
  const { call, hermes, advanceWindow } = await start(t);
  for (const [method, path] of PROTECTED) {
    const body = method === 'POST' ? { input: 'x', choice: 'once' } : undefined;
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong-key-0123456789abcdef0123456789abcdef' },
      { Authorization: `Bearer ${KEY.slice(0, -1)}` },
      { Authorization: `Basic ${KEY}` },
      { Authorization: KEY },
    ] as Record<string, string>[]) {
      const response = await call(method, path, body, headers);
      assert.equal(response.status, 401, `${method} ${path} with ${JSON.stringify(Object.keys(headers))}`);
      assert.equal(response.json.error.code, 'key_unknown');
      assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
      advanceWindow();
    }
  }
  assert.deepEqual(hermes.calls, [], 'no Hermes call may happen for an unauthenticated request');
});

test('the key in the query string is not accepted', async (t) => {
  const { call } = await start(t);
  const response = await call('GET', `/v1/server?key=${KEY}&token=${KEY}`, undefined, {});
  assert.equal(response.status, 401);
});

test('with the key, protected routes are reachable and an unknown route is 404', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('GET', '/v1/model')).status, 200);
  const missing = await call('GET', '/v1/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
});

// ---- read-only routes ---------------------------------------------------------------------

test('GET /v1/server', async (t) => {
  const { call, hermes } = await start(t);
  hermes.chatStatus = { available: false, reason: 'Hermes API server is not enabled' };
  const response = await call('GET', '/v1/server');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    host: 'arch',
    hermesVersion: '0.21.5',
    profiles: 2,
    chat: { available: false, reason: 'Hermes API server is not enabled' },
  });
});

test('GET /v1/agents lists one agent per profile with status, approvals and last message', async (t) => {
  const { call, hermes, runs } = await start(t);
  hermes.states = { default: 'err', coding: 'on' };
  hermes.lastMessages = { coding: { text: 'Listo, 12 tests pasan.', at: 1_700_000_000_000 } };
  const [, coding] = hermes.profilesList;
  const { runId } = await runs.start(coding, { input: 'x' });
  hermes.stream(runId).push(approvalEvent());
  await settle();

  const response = await call('GET', '/v1/agents');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    agents: [
      {
        id: 'default',
        name: 'default',
        model: 'deepseek-v4.1-flash',
        provider: 'opencode-go',
        status: 'err',
        pendingApprovals: 0,
        lastMessage: null,
      },
      {
        id: 'coding',
        name: 'coding',
        model: 'qwen3.8-max',
        provider: 'opencode-go',
        status: 'busy',
        pendingApprovals: 1,
        lastMessage: { text: 'Listo, 12 tests pasan.', at: 1_700_000_000_000 },
      },
    ],
  });
});

test('an agent whose gateway is off stays off even with a run recorded', async (t) => {
  const { call, hermes, runs } = await start(t);
  hermes.states = { default: 'off', coding: 'off' };
  await runs.start(hermes.profilesList[1], { input: 'x' });
  const response = await call('GET', '/v1/agents');
  assert.deepEqual(response.json.agents.map((agent: { status: string }) => agent.status), ['off', 'off']);
});

test('GET /v1/agents survives a profile whose last message cannot be read', async (t) => {
  const { call, hermes } = await start(t);
  hermes.failWith.lastMessage = new Error('database is locked');
  const response = await call('GET', '/v1/agents');
  assert.equal(response.status, 200);
  assert.equal(response.json.agents[0].lastMessage, null);
});

test('GET /v1/agents/:id/transcript', async (t) => {
  const { call, hermes } = await start(t);
  hermes.transcripts.coding = {
    sessionId: 'sess_1',
    items: [
      { kind: 'user', id: '1', text: 'hola', at: 1 },
      { kind: 'tool', id: 'call_1', tool: 'terminal', preview: 'ls', status: 'done', durationSeconds: null, result: 'a b', at: 2 },
      { kind: 'assistant', id: '3', text: 'listo', at: 3 },
    ],
  };
  hermes.seedConversation('coding', { id: 'sess_1', sessionId: 'sess_1', sessionIds: ['sess_1'], source: 'cli', createdSource: 'cli', title: null,
    kind: 'interactive', hidden: false, archived: false, startedAt: 1, lastActiveAt: 3, messageCount: 3, preview: 'listo' }, hermes.transcripts.coding.items);
  const response = await call('GET', '/v1/agents/coding/transcript?sessionId=sess_1');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.items, hermes.transcripts.coding.items);
  assert.equal(response.json.conversation.id, 'sess_1');
  assert.equal(response.json.conversation.writable, false);
  assert.deepEqual(hermes.callsTo('transcript')[0].args, ['coding', 'sess_1']);

  await call('GET', '/v1/agents/coding/transcript');
  assert.deepEqual(hermes.callsTo('transcript')[1].args, ['coding', 'sess_1']);

  const missing = await call('GET', '/v1/agents/nope/transcript');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
});

test('GET /v1/gateway', async (t) => {
  const { call } = await start(t);
  const response = await call('GET', '/v1/gateway');
  assert.deepEqual(response.json, { state: 'active', pid: 4242, uptimeSeconds: 3600, port: 8642 });
});

test('POST /v1/gateway/:action runs the action and returns the new status', async (t) => {
  const { call, hermes } = await start(t);
  const stopped = await call('POST', '/v1/gateway/stop');
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.json, { state: 'stopped', pid: null, uptimeSeconds: null, port: null });
  const restarted = await call('POST', '/v1/gateway/restart');
  assert.equal(restarted.json.state, 'active');
  await call('POST', '/v1/gateway/start');
  assert.deepEqual(hermes.callsTo('gatewayAction').map((entry) => entry.args[0]), ['stop', 'restart', 'start']);
});

test('POST /v1/gateway/:action rejects anything but start, stop and restart', async (t) => {
  const { call, hermes } = await start(t);
  for (const action of ['kill', 'uninstall', 'run', 'stop;reboot']) {
    const response = await call('POST', `/v1/gateway/${encodeURIComponent(action)}`);
    assert.equal(response.status, 404, action);
  }
  assert.equal((await call('GET', '/v1/gateway/stop')).status, 404, 'an action is never a GET');
  assert.equal(hermes.callsTo('gatewayAction').length, 0);
});

test('POST /v1/doctor returns the checks stamped with the run time', async (t) => {
  const { call } = await start(t);
  const response = await call('POST', '/v1/doctor');
  assert.deepEqual(response.json, {
    ranAt: 1_700_000_000_000,
    checks: [{ label: 'config.yaml', value: 'ok', ok: true }],
  });
});

test('concurrent POST /v1/doctor requests share a single doctor run', async (t) => {
  const { call, hermes } = await start(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let runsStarted = 0;
  hermes.doctor = async () => {
    runsStarted += 1;
    await gate;
    return [{ label: 'slow check', value: 'ok', ok: true }];
  };
  const first = call('POST', '/v1/doctor');
  const second = call('POST', '/v1/doctor');
  await eventually(() => assert.equal(runsStarted, 1));
  await settle();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, b.json);
  assert.equal(runsStarted, 1);

  await call('POST', '/v1/doctor');
  assert.equal(runsStarted, 2, 'a later request runs doctor again');
});

test('a second gateway action while one is running is a 409', async (t) => {
  const { call, hermes } = await start(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const actions: string[] = [];
  hermes.gatewayAction = async (action) => {
    actions.push(action);
    await gate;
  };
  const first = call('POST', '/v1/gateway/restart');
  await eventually(() => assert.equal(actions.length, 1));
  const second = await call('POST', '/v1/gateway/stop');
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'conflict');
  release();
  assert.equal((await first).status, 200);
  assert.deepEqual(actions, ['restart']);
});

test('GET /v1/logs defaults to INFO and 100 lines, and validates its query', async (t) => {
  const { call, hermes } = await start(t);
  const response = await call('GET', '/v1/logs');
  assert.deepEqual(response.json, { lines: [{ t: '09:40:58', level: 'INFO', msg: 'gateway started' }] });
  await call('GET', '/v1/logs?level=ERROR&lines=20');
  await call('GET', '/v1/logs?lines=999999');
  assert.deepEqual(
    hermes.callsTo('logs').map((entry) => entry.args[0]),
    [
      { level: 'INFO', lines: 100 },
      { level: 'ERROR', lines: 20 },
      { level: 'INFO', lines: 1000 },
    ],
  );
  for (const query of ['level=TRACE', 'lines=abc', 'lines=0', 'lines=-5']) {
    const bad = await call('GET', `/v1/logs?${query}`);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.json.error.code, 'bad_request');
  }
});

test('GET /v1/model and GET /v1/jobs', async (t) => {
  const { call, hermes } = await start(t);
  hermes.jobList = [
    { id: 'j1', name: 'digest', cron: '30 8 * * 1-5', agent: 'coding', nextRunAt: null, enabled: false },
  ];
  assert.deepEqual((await call('GET', '/v1/model')).json, { model: 'deepseek-v4.1-flash', provider: 'opencode-go' });
  assert.deepEqual((await call('GET', '/v1/jobs')).json, { jobs: hermes.jobList });
});

// ---- runs ---------------------------------------------------------------------------------

test('POST /v1/agents/:id/runs starts a run for that agent', async (t) => {
  const { call, hermes } = await start(t);
  const created = await call('POST', '/v1/agents/coding/conversations', { requestId: 'coding-run' }, { ...AUTH, 'X-Relay-Protocol': '2' });
  assert.equal(created.status, 201);
  const response = await call('POST', '/v1/agents/coding/runs', { input: 'corre los tests', sessionId: created.json.sessionId });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { runId: 'run_1', sessionId: created.json.sessionId, conversationId: created.json.id });
  assert.deepEqual(hermes.callsTo('createRun')[0].args, ['coding', { input: 'corre los tests', sessionId: created.json.sessionId }]);
});

test('POST /v1/agents/:id/runs validates the agent and the body', async (t) => {
  const { call, hermes } = await start(t);
  assert.equal((await call('POST', '/v1/agents/nope/runs', { input: 'x' })).status, 404);
  for (const body of [{}, { input: '' }, { input: 42 }, { input: 'x', sessionId: 5 }, '{not json', '[]']) {
    const response = await call('POST', '/v1/agents/coding/runs', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.error.code, 'bad_request');
  }
  assert.equal(hermes.callsTo('createRun').length, 0);
});

test('POST /v1/agents/:id/runs answers 503 with static guidance when the Hermes API server is off', async (t) => {
  const { call, hermes } = await start(t);
  hermes.chatStatus = { available: false, reason: 'Hermes API server is not enabled: set API_SERVER_KEY' };
  const response = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, {
    error: { code: 'chat_unavailable', message: 'El chat de este Agente no está disponible en el Servidor.' },
  });
});

test('GET /v1/runs/:id/events streams one RunEvent per SSE data line and ends with the run', async (t) => {
  const { call, hermes } = await start(t);
  const { json } = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  const stream = hermes.stream(json.runId);
  stream.push({ event: 'message.delta', seq: 0, delta: 'Ho' });
  stream.push({ event: 'tool.started', seq: 1, tool: 'terminal', preview: 'ls' });
  stream.push({ event: 'tool.completed', seq: 2, tool: 'terminal', duration: 0.5, error: false, preview: 'a' });
  stream.push({ event: 'run.completed', seq: 3, output: 'Hola' });
  await settle();

  const response = await call('GET', `/v1/runs/${json.runId}/events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.deepEqual(sseEvents(response.text), [
    { type: 'message.delta', text: 'Ho' },
    { type: 'tool.started', toolCallId: 'run_1:tool:1', tool: 'terminal', preview: 'ls' },
    { type: 'tool.completed', toolCallId: 'run_1:tool:1', tool: 'terminal', durationSeconds: 0.5, error: false, preview: 'a' },
    { type: 'run.completed', output: 'Hola' },
  ]);
  assert.match(response.text, /^id: 0$/m);

  const resumed = await call('GET', `/v1/runs/${json.runId}/events`, undefined, { ...AUTH, 'Last-Event-ID': '2' });
  assert.deepEqual(sseEvents(resumed.text), [{ type: 'run.completed', output: 'Hola' }]);
});

test('GET /v1/runs/:id/events delivers events live while the run is in flight', async (t) => {
  const { base, call, hermes } = await start(t);
  const { json } = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  const response = await fetch(`${base}/v1/runs/${json.runId}/events`, { headers: AUTH });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readUntil = async (needle: string) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before "${needle}"`);
      text += decoder.decode(value, { stream: true });
    }
  };

  hermes.stream(json.runId).push({ event: 'message.delta', seq: 0, delta: 'primero' });
  await readUntil('primero');
  hermes.stream(json.runId).push({ event: 'run.cancelled', seq: 1 });
  await readUntil('run.cancelled');
  const { done } = await reader.read();
  assert.equal(done, true, 'the bridge closes the stream after the terminal event');
});

test('GET /v1/runs/:id/events and POST stop answer 404 for an unknown run', async (t) => {
  const { call } = await start(t);
  for (const [method, path] of [
    ['GET', '/v1/runs/run_nope/events'],
    ['POST', '/v1/runs/run_nope/stop'],
  ]) {
    const response = await call(method, path);
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, 'not_found');
  }
});

test('POST /v1/runs/:id/stop relays the stop', async (t) => {
  const { call, hermes } = await start(t);
  const { json } = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  const response = await call('POST', `/v1/runs/${json.runId}/stop`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(hermes.callsTo('stopRun')[0].args, ['coding', 'run_1']);
});

// ---- approvals ----------------------------------------------------------------------------

test('GET /v1/approvals lists what the bridge collected, POST /v1/approvals/:id relays the decision', async (t) => {
  const { call, hermes, notified } = await start(t);
  const { json: run } = await call('POST', '/v1/agents/coding/runs', { input: 'limpia' });
  hermes.stream(run.runId).push(approvalEvent());
  await eventually(() => assert.equal(notified.length, 1));

  const list = await call('GET', '/v1/approvals');
  assert.equal(list.status, 200);
  assert.equal(list.json.approvals.length, 1);
  const approval = list.json.approvals[0] as Approval;
  assert.equal(approval.id, 'req_a');
  assert.equal(approval.runId, run.runId);
  assert.equal(approval.agentId, 'coding');
  assert.equal(approval.command, 'rm -rf build/');
  assert.deepEqual(approval.risk, { level: 3, label: 'RIESGO MEDIO', summary: 'recursive delete' });
  assert.equal(approval.cwd, null);
  assert.equal(approval.reason, null);
  assert.equal(approval.affects, null);

  const decided = await call('POST', '/v1/approvals/req_a', { choice: 'once' });
  assert.equal(decided.status, 200);
  assert.deepEqual(decided.json, { ok: true });
  assert.deepEqual(hermes.callsTo('resolveApproval')[0].args, ['coding', run.runId, 'once', 'req_a']);
  assert.deepEqual((await call('GET', '/v1/approvals')).json, { approvals: [], serverNow: 1700000000000 });
});

test('POST /v1/approvals/:id validates the choice and the id', async (t) => {
  const { call, hermes } = await start(t);
  const { json: run } = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  hermes.stream(run.runId).push(approvalEvent({ choices: ['once', 'deny'] }));
  await settle();

  for (const body of [{}, { choice: 'yes' }, { choice: 'always' }, { choice: null }, 'nope']) {
    const response = await call('POST', '/v1/approvals/req_a', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const missing = await call('POST', '/v1/approvals/req_zzz', { choice: 'once' });
  assert.equal(missing.status, 404);
  assert.equal(hermes.callsTo('resolveApproval').length, 0);
});

test('POST /v1/approvals/:id answers 409 when Hermes already resolved it', async (t) => {
  const { call, hermes } = await start(t);
  const { json: run } = await call('POST', '/v1/agents/coding/runs', { input: 'x' });
  hermes.stream(run.runId).push(approvalEvent());
  await settle();
  hermes.failWith.resolveApproval = new HermesError('conflict', 'Run has no pending approval');
  const response = await call('POST', '/v1/approvals/req_a', { choice: 'once' });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'conflict');
});

// ---- errors and CORS ----------------------------------------------------------------------

test('Hermes errors map to their HTTP status; unexpected ones become an opaque 500', async (t) => {
  const { call, hermes, logs } = await start(t);
  hermes.failWith.gateway = new HermesError('upstream', 'hermes exited with code 3');
  const upstream = await call('GET', '/v1/gateway');
  assert.equal(upstream.status, 502);
  assert.deepEqual(upstream.json, { error: { code: 'upstream', message: 'Hermes request failed.' } });

  hermes.failWith.jobs = new Error('ENOENT: /home/someone/.hermes/secret-path');
  const internal = await call('GET', '/v1/jobs');
  assert.equal(internal.status, 500);
  assert.equal(internal.json.error.code, 'internal');
  assert.ok(!internal.text.includes('secret-path'), 'internal details are not disclosed');
  assert.ok(!logs.some((line) => line.includes('secret-path')));
});

test('the request log never contains the key or the query string', async (t) => {
  const { call, logs } = await start(t);
  await call('GET', `/v1/logs?level=INFO&secret=${KEY}`);
  await call('GET', '/v1/model', undefined, { Authorization: `Bearer ${KEY}` });
  assert.ok(logs.length >= 2);
  assert.ok(!logs.join('\n').includes(KEY));
});

test('CORS: an allowed origin gets a preflight answer without the key', async (t) => {
  const { call } = await start(t);
  const preflight = await call('OPTIONS', '/v1/agents', undefined, {
    Origin: 'http://localhost:8081',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(preflight.headers.get('vary') ?? '', /Origin/i);

  const actual = await call('GET', '/v1/model', undefined, { ...AUTH, Origin: 'http://localhost:8081' });
  assert.equal(actual.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  const unauthorized = await call('GET', '/v1/model', undefined, { Origin: 'http://localhost:8081' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), 'http://localhost:8081');
});

test('CORS: an origin that is not listed gets no allow header', async (t) => {
  const { call } = await start(t);
  for (const origin of ['https://evil.example', 'http://localhost:8082', 'null']) {
    const preflight = await call('OPTIONS', '/v1/agents', undefined, {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, origin);
    const actual = await call('GET', '/v1/model', undefined, { ...AUTH, Origin: origin });
    assert.equal(actual.headers.get('access-control-allow-origin'), null, origin);
  }
});

test('#42 decision history is private, filters agent/channel without exposing pending others, and rejects malformed filters', async (t) => {
 const {call,hermes,logs}=await start(t);
 hermes.decisions.default=[{id:'db-fixture',agentId:'default',agentName:'Default',sessionId:'discord-fixture',runId:null,approvalId:null,toolCallId:'fixture-call',command:'echo private command',actor:'guardian',outcome:'approved',choice:null,at:1700000000000,timeKind:'result',origin:'other',source:'discord',originLabel:'Discord'}];
 const response=await call('GET','/v1/decisions?agentId=default&origin=other');
 assert.equal(response.status,200); assert.equal(response.json.decisions[0].originLabel,'Discord');
 assert.equal((await call('GET','/v1/decisions',undefined,{})).status,401);
 assert.equal((await call('GET','/v1/decisions?origin=other&origin=relay')).status,400);
 assert.equal((await call('GET','/v1/decisions?actor=guardian')).json.error.code,'invalid_decision_query');
 assert.ok(!logs.some(line=>line.includes('private command') || line.includes('default')));
});


test('#42 decision history failures never expose upstream content in the response or request log',async(t)=>{
 const {call,hermes,logs}=await start(t);
 hermes.decisionHistory=async()=>{throw new HermesError('decision_history_unavailable','fixture-sensitive-history-error');};
 const response=await call('GET','/v1/decisions');
 assert.equal(response.status,503);assert.equal(response.json.error.code,'decision_history_unavailable');
 assert.doesNotMatch(JSON.stringify(response.json)+logs.join('\n'),/fixture-sensitive-history-error/);
 assert.equal(response.json.error.message,'No se pudo leer el historial de comandos de Hermes. Reintenta.');
});


test('large decision history HTTP is bounded without changing the durable ledger or uncertain choices',async t=>{
 const directory=await fs.mkdtemp(path.resolve('history-ledger-fixture.log-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.chmod(directory,0o700);
 const base={id:'ledger',agentId:'default',agentName:'Default',sessionId:'relay-synthetic',runId:'run',approvalId:'approval',toolCallId:null,command:'echo ledger',actor:'person' as const,outcome:'approved' as const,choice:'once' as const,at:1700000010000,timeKind:'decision' as const,origin:'relay' as const,source:'api_server',originLabel:'Relay'};
 const records=Array.from({length:150},(_,i)=>({...base,id:`ledger-${i}`,command:`ledger-${i} `+'l'.repeat(4096),at:base.at+i}));
 const intent={...base,id:'intent',approvalId:'intent-approval',command:'unconfirmed-full '+'u'.repeat(12000),choice:'session' as const};
 const intents=[intent,...Array.from({length:149},(_,i)=>({...intent,id:`intent-${i}`,approvalId:`intent-approval-${i}`,command:'uncertain '+ 'u'.repeat(1024)}))];
 const file=path.join(directory,'decisions.json'), bytes=JSON.stringify({schemaVersion:1,decisions:records,intents})+'\n';
 await fs.writeFile(file,bytes,{mode:0o600});const ledger=await createDecisionStore({directory});
 const {call,hermes,logs}=await start(t,'100.64.0.1',ledger);
 hermes.decisions.default=Array.from({length:1000},(_,i)=>({...base,id:`import-${i}`,sessionId:'discord-synthetic',runId:null,approvalId:null,command:'imported '+'x'.repeat(4096),at:1700000000000+i,actor:'guardian',choice:null,origin:'other',source:'discord',originLabel:'Discord'}));
 const response=await call('GET','/v1/decisions');assert.equal(response.status,200);
 assert.equal(response.json.decisions.length,100);assert.deepEqual(response.json.window,{limit:100,total:1150});
 assert.ok(Buffer.byteLength(response.text)<300000,'bounded confirmed previews plus full uncertain command');
 const latest=response.json.decisions[0];assert.equal(latest.id,'ledger-149');assert.equal(latest.command.length,512);assert.equal(latest.commandTruncated,true);
 assert.deepEqual([latest.actor,latest.outcome,latest.choice,latest.at,latest.timeKind],['person','approved','once',1700000010149,'decision']);
 assert.equal(response.json.uncertain.length,150);assert.equal(ledger.pending().length,150);
 assert.equal(response.json.uncertain[0].command,intent.command);assert.equal(response.json.uncertain[0].choice,'session');
 assert.equal(ledger.list().length,150);assert.equal(ledger.pending()[0].command,intent.command);assert.equal(await fs.readFile(file,'utf8'),bytes);
 const filtered=await call('GET','/v1/decisions?origin=other');assert.equal(filtered.json.decisions.length,100);assert.deepEqual(filtered.json.window,{limit:100,total:1000});assert.deepEqual(filtered.json.uncertain,[]);assert.equal(filtered.json.decisions[0].actor,'guardian');assert.equal(filtered.json.decisions[0].choice,null);
 assert.ok(!logs.some(line=>line.includes('unconfirmed-full') || line.includes('imported')));
});
