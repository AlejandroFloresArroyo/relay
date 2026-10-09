import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Exec, ExecResult } from '../src/exec.ts';
import { HermesError } from '../src/hermes.ts';
import type { UpstreamEvent } from '../src/hermes.ts';
import { RealHermes } from '../src/hermes_real.ts';
import { eventually } from '../support/channel.ts';
import { FakeUpstream } from '../support/fake_upstream.ts';
import { CODING_KEY, createHermesHome, DEFAULT_KEY, GATEWAY_PID, writeStateDb } from '../support/hermes_home.ts';
import type { FakeHomeOptions } from '../support/hermes_home.ts';

interface ExecCall {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

function fakeExec(answers: Record<string, ExecResult | Error>) {
  const calls: ExecCall[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const answer = answers[args.join(' ')];
    if (!answer) throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, exec };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

function setup(t: TestContext, options: FakeHomeOptions & { exec?: Record<string, ExecResult | Error> } = {}) {
  const fixture = createHermesHome(options);
  t.after(() => fixture.cleanup());
  const { calls, exec } = fakeExec(options.exec ?? {});
  const hermes = new RealHermes({ home: fixture.home, bin: '/opt/hermes', exec, procRoot: fixture.procRoot });
  return { fixture, hermes, execCalls: calls };
}

async function withUpstream(t: TestContext) {
  const upstream = await new FakeUpstream({ default: DEFAULT_KEY, coding: CODING_KEY }).start();
  t.after(() => upstream.stop());
  const base = setup(t, { apiPort: upstream.port });
  return { ...base, upstream };
}

const isHermesError = (code: string) => (err: unknown) => err instanceof HermesError && err.code === code;

// ---- profiles, model, version ---------------------------------------------------------------

test('profiles: default plus one per directory under profiles/, with model and provider from config.yaml', async (t) => {
  const { hermes } = setup(t);
  assert.deepEqual(await hermes.profiles(), [
    { id: 'default', name: 'default', model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
    { id: 'coding', name: 'coding', model: 'qwen3.8-max', provider: 'opencode-go' },
    { id: 'personal', name: 'personal', model: 'unknown', provider: 'unknown' },
  ]);
});

test('model is the default profile model', async (t) => {
  const { hermes } = setup(t);
  assert.deepEqual(await hermes.model(), { model: 'deepseek-v4.1-flash', provider: 'opencode-go' });
});

test('version comes from `hermes --version`', async (t) => {
  const { hermes, execCalls } = setup(t, {
    exec: { '--version': ok('Hermes Agent v0.21.5+4536.gea114c3 (2026.9.24) · upstream ea114c3e\nPython: 3.14.7\n') },
  });
  assert.equal(await hermes.version(), '0.21.5');
  assert.equal(await hermes.version(), '0.21.5');
  assert.deepEqual(execCalls.map((call) => [call.file, call.args]), [['/opt/hermes', ['--version']]], 'cached');
});

test('version falls back to the running gateway record when the CLI cannot be run', async (t) => {
  const { hermes } = setup(t, { exec: { '--version': new Error('could not run hermes: ENOENT') } });
  assert.equal(await hermes.version(), '0.21.5');
});

// ---- gateway --------------------------------------------------------------------------------

test('gateway: active with pid and uptime while the recorded process is alive', async (t) => {
  const { hermes } = setup(t, { apiPort: null });
  assert.deepEqual(await hermes.gateway(), { state: 'active', pid: GATEWAY_PID, uptimeSeconds: 5000, port: null });
});

test('gateway: stopped when the recorded pid is gone or was reused by another process', async (t) => {
  const { hermes, fixture } = setup(t, { apiPort: null });
  const state = { pid: 999, start_time: 1147, gateway_state: 'running' };
  fixture.write('gateway_state.json', JSON.stringify(state));
  assert.deepEqual(await hermes.gateway(), { state: 'stopped', pid: null, uptimeSeconds: null, port: null });

  fixture.write('gateway_state.json', JSON.stringify({ ...state, pid: GATEWAY_PID, start_time: 555 }));
  assert.equal((await hermes.gateway()).state, 'stopped');
});

test('gateway: stopped when Hermes recorded a stop or was never started, unknown when unreadable', async (t) => {
  const { hermes, fixture } = setup(t, { apiPort: null });
  fixture.write('gateway_state.json', JSON.stringify({ pid: GATEWAY_PID, start_time: 1147, gateway_state: 'stopped' }));
  assert.equal((await hermes.gateway()).state, 'stopped');
  fixture.write('gateway_state.json', JSON.stringify({ pid: GATEWAY_PID, start_time: 1147, gateway_state: 'starting' }));
  assert.equal((await hermes.gateway()).state, 'unknown');
  fixture.write('gateway_state.json', '{ not json');
  assert.deepEqual(await hermes.gateway(), { state: 'unknown', pid: null, uptimeSeconds: null, port: null });
  fixture.remove('gateway_state.json');
  assert.equal((await hermes.gateway()).state, 'stopped');
});

test('gateway: reports the API server port only when it really answers', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  assert.equal((await hermes.gateway()).port, upstream.port);
  await upstream.stop();
  assert.equal((await hermes.gateway()).port, null);
});

test('gatewayAction runs `hermes -p default gateway <action>` (the host gateway, never the sticky profile) and fails loudly on a non-zero exit', async (t) => {
  const { hermes, execCalls } = setup(t, {
    exec: {
      '-p default gateway restart': ok('restarted'),
      '-p default gateway stop': { code: 1, stdout: '', stderr: 'unit not found, API_SERVER_KEY=supersecretvalue123' },
    },
  });
  await hermes.gatewayAction('restart');
  assert.deepEqual(execCalls[0].args, ['-p', 'default', 'gateway', 'restart']);
  await assert.rejects(hermes.gatewayAction('stop'), (err: unknown) => {
    assert.ok(err instanceof HermesError && err.code === 'upstream');
    assert.match(err.message, /unit not found/);
    assert.ok(!err.message.includes('supersecretvalue123'), 'CLI output is redacted');
    return true;
  });
});

test('profileStates: on when served, err when one of its platforms needs attention, off when the gateway is down', async (t) => {
  const { hermes, fixture } = setup(t, { apiPort: null });
  assert.deepEqual(await hermes.profileStates(['default', 'coding', 'personal', 'ghost']), {
    default: 'on',
    coding: 'on',
    personal: 'err',
    ghost: 'off',
  });
  fixture.write('gateway_state.json', JSON.stringify({ pid: 999, start_time: 1, gateway_state: 'running' }));
  assert.deepEqual(await hermes.profileStates(['default', 'coding']), { default: 'off', coding: 'off' });
});

// ---- doctor ---------------------------------------------------------------------------------

const DOCTOR_OUTPUT = [
  '',
  '┌─────────────────────────────────────────────────────────┐',
  '│                 🩺 Hermes Doctor                        │',
  '└─────────────────────────────────────────────────────────┘',
  '',
  '\u001b[1;36m◆ Python Environment\u001b[0m',
  '  \u001b[32m✓\u001b[0m Python 3.14.7',
  '  \u001b[32m✓\u001b[0m Virtual environment \u001b[2m(active)\u001b[0m',
  '',
  '◆ Auth Providers',
  '  ⚠ OpenAI Codex auth (not logged in)',
  '    → run hermes auth codex',
  '  ✗ OpenRouter API (HTTP 401, key sk-or-ABCDEFGHIJKLMNOPQRSTUVWX)',
  '',
  '────────────────────────────────────────────────────────────',
  '  Found 1 issue(s) to address:',
  '',
].join('\n');

test('doctor runs `hermes doctor` without colour and turns each check line into a DoctorCheck', async (t) => {
  const { hermes, execCalls } = setup(t, { exec: { '-p default doctor': { code: 1, stdout: DOCTOR_OUTPUT, stderr: '' } } });
  const checks = await hermes.doctor();
  assert.deepEqual(checks.slice(0, 3), [
    { label: 'Python 3.14.7', value: 'ok', ok: true },
    { label: 'Virtual environment', value: 'active', ok: true },
    { label: 'OpenAI Codex auth', value: 'not logged in', ok: false },
  ]);
  assert.equal(checks.length, 4);
  assert.equal(checks[3].label, 'OpenRouter API');
  assert.equal(checks[3].ok, false);
  assert.ok(!checks[3].value.includes('ABCDEFGHIJKLMNOPQRSTUVWX'), 'secrets in doctor output are redacted');
  assert.deepEqual(execCalls[0].args, ['-p', 'default', 'doctor'], 'never --fix, never --live');
  assert.equal(execCalls[0].env?.NO_COLOR, '1');
});

test('doctor is an upstream error when the CLI produced no checks', async (t) => {
  const { hermes } = setup(t, { exec: { '-p default doctor': { code: 2, stdout: '', stderr: 'Traceback: boom' } } });
  await assert.rejects(hermes.doctor(), isHermesError('upstream'));
});

// ---- logs -----------------------------------------------------------------------------------

test('logs: tail of agent.log, oldest first, filtered by minimum level, with Hermes levels mapped', async (t) => {
  const { hermes } = setup(t);
  const info = await hermes.logs({ level: 'INFO', lines: 100 });
  assert.deepEqual(
    info.map((line) => [line.t, line.level]),
    [
      ['15:08:35', 'ERROR'],
      ['15:08:35', 'WARN'],
      ['15:08:36', 'INFO'],
      ['15:08:39', 'INFO'],
      ['04:58:41', 'ERROR'],
    ],
  );
  assert.equal(info[1].msg, 'gateway.run: No connected messaging platforms remain');
  assert.match(info[0].msg, /Traceback \(most recent call last\)/, 'continuation lines stay with their entry');

  const errors = await hermes.logs({ level: 'ERROR', lines: 100 });
  assert.deepEqual(errors.map((line) => line.level), ['ERROR', 'ERROR']);
  const debug = await hermes.logs({ level: 'DEBUG', lines: 100 });
  assert.equal(debug.length, 6);
  const lastTwo = await hermes.logs({ level: 'INFO', lines: 2 });
  assert.deepEqual(lastTwo.map((line) => line.t), ['15:08:39', '04:58:41']);
});

test('logs: redacts credentials and returns nothing when the log file does not exist', async (t) => {
  const { hermes, fixture } = setup(t);
  const lines = await hermes.logs({ level: 'INFO', lines: 100 });
  assert.ok(!JSON.stringify(lines).includes('abcdef0123456789abcdef'));
  fixture.remove('logs/agent.log');
  assert.deepEqual(await hermes.logs({ level: 'INFO', lines: 100 }), []);
});

// ---- jobs -----------------------------------------------------------------------------------

test('jobs: every profile cron/jobs.json, with the owning profile as agent', async (t) => {
  const { hermes } = setup(t);
  assert.deepEqual(await hermes.jobs(), [
    { id: '02e9b6866f94', name: 'TFV morning digest', cron: '30 8 * * 1-5', agent: 'coding', nextRunAt: null, enabled: false },
    {
      id: 'aa11bb22cc33',
      name: 'poll inbox',
      cron: 'every 5m',
      agent: 'coding',
      nextRunAt: Date.parse('2026-10-02T05:05:00-06:00'),
      enabled: true,
    },
  ]);
});

test('jobs: a corrupt jobs.json in one profile does not hide the others', async (t) => {
  const { hermes, fixture } = setup(t);
  fixture.write('cron/jobs.json', '{ broken');
  assert.equal((await hermes.jobs()).length, 2);
});

// ---- session store --------------------------------------------------------------------------

function seedSessions(home: string) {
  writeStateDb(
    path.join(home, 'profiles/coding/state.db'),
    [
      { id: 'sess_old', source: 'desktop', startedAt: 100, lastActivityAt: 150 },
      { id: 'sess_chat', source: 'discord', startedAt: 200, lastActivityAt: 900 },
      { id: 'sess_cron', source: 'cron', startedAt: 950, lastActivityAt: 990 },
      { id: 'sess_child', source: 'subagent', startedAt: 960, lastActivityAt: 995, parent: 'sess_chat' },
      { id: 'sess_hidden', source: 'desktop', startedAt: 970, lastActivityAt: 999, hidden: 1 },
    ],
    [
      { session: 'sess_old', role: 'user', content: 'old question', at: 100 },
      { session: 'sess_chat', role: 'session_meta', content: '{"x":1}', at: 200 },
      { session: 'sess_chat', role: 'user', content: 'corre los tests', at: 201.5 },
      {
        session: 'sess_chat',
        role: 'assistant',
        content: '',
        at: 202,
        toolCalls: [
          { id: 'call_1', name: 'terminal', args: { command: 'npm test -- integration' } },
          { id: 'call_2', name: 'read_file', args: { path: 'src/main.ts' } },
        ],
      },
      { session: 'sess_chat', role: 'tool', content: '{"output":"12 passed","exit_code":0,"error":null}', at: 203, toolCallId: 'call_1', toolName: 'terminal' },
      { session: 'sess_chat', role: 'tool', content: '{"error":"file not found"}', at: 204, toolCallId: 'call_2', toolName: 'read_file' },
      { session: 'sess_chat', role: 'user', content: 'rewound message', at: 205, active: 0 },
      { session: 'sess_chat', role: 'assistant', content: 'Listo, 12 tests pasan.', at: 206 },
      { session: 'sess_cron', role: 'assistant', content: 'cron digest', at: 990 },
      { session: 'sess_child', role: 'assistant', content: 'subagent chatter', at: 995 },
      { session: 'sess_hidden', role: 'assistant', content: 'hidden', at: 999 },
    ],
  );
}

test('lastMessage: the newest user/assistant text of an interactive session', async (t) => {
  const { hermes, fixture } = setup(t);
  seedSessions(fixture.home);
  assert.deepEqual(await hermes.lastMessage('coding'), { text: 'hidden', at: 999_000 });
  assert.equal(await hermes.lastMessage('personal'), null, 'no state.db yet');
});

test('transcript: latest includes hidden interactive conversations; explicit selection preserves tool history', async (t) => {
  const { hermes, fixture } = setup(t);
  seedSessions(fixture.home);
  assert.deepEqual(await hermes.transcript('coding', null), {
    sessionId: 'sess_hidden', items: [{ kind: 'assistant', id: '11', text: 'hidden', at: 999_000 }],
  });
  const transcript = await hermes.transcript('coding', 'sess_chat');
  assert.equal(transcript.sessionId, 'sess_chat');
  assert.deepEqual(transcript.items, [
    { kind: 'user', id: '3', text: 'corre los tests', at: 201_500 },
    {
      kind: 'tool',
      id: 'call_1',
      tool: 'terminal',
      preview: 'npm test -- integration',
      status: 'done',
      durationSeconds: null,
      result: '{"output":"12 passed","exit_code":0,"error":null}',
      at: 202_000,
    },
    {
      kind: 'tool',
      id: 'call_2',
      tool: 'read_file',
      preview: 'src/main.ts',
      status: 'error',
      durationSeconds: null,
      result: '{"error":"file not found"}',
      at: 202_000,
    },
    { kind: 'assistant', id: '8', text: 'Listo, 12 tests pasan.', at: 206_000 },
  ]);
});

test('transcript: a given session id is honoured; an unknown one is conversation_not_found', async (t) => {
  const { hermes, fixture } = setup(t);
  seedSessions(fixture.home);
  const old = await hermes.transcript('coding', 'sess_old');
  assert.equal(old.sessionId, 'sess_old');
  assert.deepEqual(old.items.map((item) => item.kind), ['user']);
  await assert.rejects(hermes.transcript('coding', 'sess_nope'), isHermesError('conversation_not_found'));
});

test('transcript: tool results are cut to 500 characters, a non-zero exit code is an error, an unanswered trailing call is running', async (t) => {
  const { hermes, fixture } = setup(t);
  writeStateDb(
    path.join(fixture.home, 'state.db'),
    [{ id: 's1', source: 'cli', startedAt: 1 }],
    [
      { session: 's1', role: 'assistant', content: 'voy', at: 2, toolCalls: [{ id: 'c1', name: 'terminal', args: '{"command":"false"}' }] },
      { session: 's1', role: 'tool', content: JSON.stringify({ output: 'x'.repeat(900), exit_code: 1, error: null }), at: 3, toolCallId: 'c1' },
      { session: 's1', role: 'assistant', content: null, at: 4, toolCalls: [{ id: 'c2', name: 'web_search', args: 'not json' }] },
    ],
  );
  const { items } = await hermes.transcript('default', null);
  const tools = items.filter((item) => item.kind === 'tool');
  assert.equal(tools[0].status, 'error');
  assert.equal(tools[0].result?.length, 500);
  assert.equal(tools[1].status, 'running');
  assert.equal(tools[1].result, null);
  assert.equal(tools[1].preview, 'not json');
});

test('transcript: empty when the profile has no session store', async (t) => {
  const { hermes } = setup(t);
  assert.deepEqual(await hermes.transcript('personal', null), { sessionId: null, items: [] });
});

test('the session store is opened read-only', async (t) => {
  const { hermes, fixture } = setup(t);
  seedSessions(fixture.home);
  const fs = await import('node:fs');
  const file = path.join(fixture.home, 'profiles/coding/state.db');
  fs.chmodSync(file, 0o444);
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    assert.equal((await hermes.transcript('coding', null)).sessionId, 'sess_hidden');
    assert.deepEqual(await hermes.lastMessage('coding'), { text: 'hidden', at: 999_000 });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('state.db')), ['state.db']);
  } finally {
    fs.chmodSync(path.dirname(file), 0o755); // so the fixture can be deleted
  }
});

test('a WAL session store with no live writer uses normal read-only WAL and preserves the database bytes', async (t) => {
  const { hermes, fixture } = setup(t);
  const fs = await import('node:fs');
  const dir = path.join(fixture.home, 'profiles/coding');
  writeStateDb(
    path.join(dir, 'state.db'),
    [{ id: 's1', source: 'cli', startedAt: 1 }],
    [{ session: 's1', role: 'user', content: 'hola', at: 2 }],
    { wal: true },
  );
  const before = fs.readdirSync(dir).sort();
  assert.ok(!before.includes('state.db-shm'), 'precondition: the writer closed cleanly');
  const databaseBefore = fs.readFileSync(path.join(dir, 'state.db'));

  assert.deepEqual(await hermes.lastMessage('coding'), { text: 'hola', at: 2000 });
  assert.equal((await hermes.transcript('coding', null)).items.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.db')), databaseBefore);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== 'state.db-shm' && name !== 'state.db-wal').sort(), before);
});

test('a WAL session store held by a live writer is read through its WAL, including rows not yet checkpointed', async (t) => {
  const { hermes, fixture } = setup(t);
  const fs = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(fixture.home, 'profiles/coding');
  const file = path.join(dir, 'state.db');
  writeStateDb(file, [{ id: 's1', source: 'cli', startedAt: 1 }], [{ session: 's1', role: 'user', content: 'viejo', at: 2 }], { wal: true });

  const writer = new DatabaseSync(file); // stands in for the running gateway
  t.after(() => writer.close());
  writer.exec("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', 'assistant', 'nuevo', 3)");
  const before = fs.readdirSync(dir).sort();
  assert.ok(before.includes('state.db-wal') && before.includes('state.db-shm'), 'precondition: WAL is live');

  assert.deepEqual(await hermes.lastMessage('coding'), { text: 'nuevo', at: 3000 });
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  writer.exec("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s1', 'user', 'el writer sigue pudiendo escribir', 4)");
});

// ---- API server: availability ---------------------------------------------------------------

test('chat is unavailable, with the reason, when the API server is not configured', async (t) => {
  const { hermes } = setup(t, { apiPort: null });
  const chat = await hermes.chat();
  assert.equal(chat.available, false);
  assert.match(chat.reason ?? '', /API_SERVER_KEY/);
  await assert.rejects(hermes.createRun('default', { input: 'x' }), isHermesError('unavailable'));
});

test('chat is unavailable when the key is configured but nothing listens', async (t) => {
  // A closed server's port can be taken by another test's server before the request. A connected
  // client socket keeps its local port bound without listening: connecting to it is refused, and
  // no server can bind it while the test runs.
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const reserved = net.connect((holder.address() as AddressInfo).port, '127.0.0.1');
  t.after(() => { reserved.destroy(); holder.close(); });
  await once(reserved, 'connect');
  const port = reserved.localPort!;
  const { hermes } = setup(t, { apiPort: port });
  const chat = await hermes.chat();
  assert.equal(chat.available, false);
  assert.match(chat.reason ?? '', new RegExp(`127\\.0\\.0\\.1:${port}`));
  await assert.rejects(hermes.createRun('default', { input: 'x' }), isHermesError('unavailable'));
});

test('chat is available when the API server answers /health', async (t) => {
  const { hermes } = await withUpstream(t);
  assert.deepEqual(await hermes.chat(), { available: true, reason: null });
});

test('a profile without its own API_SERVER_KEY cannot chat, and the message says which file to edit', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  await assert.rejects(hermes.createRun('personal', { input: 'x' }), (err: unknown) => {
    assert.ok(err instanceof HermesError && err.code === 'unavailable');
    assert.match(err.message, /personal/);
    assert.match(err.message, /API_SERVER_KEY/);
    return true;
  });
  assert.equal(upstream.requests.length, 0);
});

test('approvalTimeoutSeconds reads approvals.timeout and defaults to 300', async (t) => {
  const { hermes } = setup(t);
  assert.equal(await hermes.approvalTimeoutSeconds('default'), 120);
  assert.equal(await hermes.approvalTimeoutSeconds('coding'), 300);
});

// ---- API server: runs -----------------------------------------------------------------------

test('createRun posts to the default listener with the default key', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const created = await hermes.createRun('default', { input: 'hola', sessionId: 'sess_1' });
  assert.deepEqual(created, { runId: 'run_up1', sessionId: 'sess_1' });
  const [post] = upstream.requestsTo('POST', /^\/v1\/runs$/);
  assert.equal(post.profile, 'default');
  assert.equal(post.authorized, true);
  assert.deepEqual(post.body, { input: 'hola', session_id: 'sess_1' });
});

test('image Turns preserve text, conversation and model and send an image_url data URL without local metadata', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  await hermes.createRun('coding', { input: 'Describe esta imagen', sessionId: 'image-fixture', model: { provider: 'team', model: 'vision' }, images: [{ attachmentId: 'image-fixture-1', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', width: 1, height: 1 }] });
  assert.deepEqual(upstream.requestsTo('POST', /^\/v1\/runs$/)[0].body, {
    input: [{ type: 'text', text: 'Describe esta imagen' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }],
    session_id: 'image-fixture', provider: 'team', model: 'vision',
  });
});

test('createRun for a named profile uses /p/<profile>/ and that profile key; the session id comes from the run status', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const created = await hermes.createRun('coding', { input: 'hola' });
  assert.deepEqual(created, { runId: 'run_up1', sessionId: 'run_up1' });
  const [post] = upstream.requestsTo('POST', /^\/v1\/runs$/);
  assert.equal(post.profile, 'coding');
  assert.equal(post.authorized, true, 'must authenticate with the coding key, not the default one');
  assert.deepEqual(post.body, { input: 'hola' });
});

test('#37 real steer posts only input to the owning Agent and preserves queued text returned at terminal', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'Trabaja' });
  upstream.respond('POST', `/v1/runs/${runId}/steer`, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'hermes.run.steer', run_id: runId, accepted: true }));
  });
  await hermes.steerRun('coding', runId, 'Guía en cola');
  const requests = upstream.requestsTo('POST', /\/steer$/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].profile, 'coding'); assert.equal(requests[0].authorized, true);
  assert.deepEqual(requests[0].body, { input: 'Guía en cola' });
  assert.equal(upstream.requestsTo('POST', /\/stop$/).length, 0);
  upstream.respond('GET', `/v1/runs/${runId}`, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ run_id: runId, status: 'completed', output: 'Listo', pending_steer: 'Guía en cola' }));
  });
  const status = await hermes.runStatus('coding', runId);
  assert.equal(status?.status, 'completed');
  assert.ok(status && 'pendingSteer' in status);
  assert.equal(status.pendingSteer, 'Guía en cola');
});

test('a key Hermes rejects is an upstream error that never echoes the key', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  upstream.keys.coding = 'rotated-key-that-relayd-does-not-have';
  await assert.rejects(hermes.createRun('coding', { input: 'x' }), (err: unknown) => {
    assert.ok(err instanceof HermesError && err.code === 'upstream');
    assert.ok(!err.message.includes(CODING_KEY));
    return true;
  });
});

test('runEvents yields the upstream events with their seq, and resumes with Last-Event-ID', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'x' });
  upstream.emit(runId, 'message.delta', { delta: 'ho' });
  upstream.emit(runId, 'tool.started', { tool: 'terminal', preview: 'ls' });

  const abort = new AbortController();
  const seen: UpstreamEvent[] = [];
  const reading = (async () => {
    for await (const event of hermes.runEvents('coding', runId, null, abort.signal)) seen.push(event);
  })();
  await eventually(() => assert.equal(seen.length, 2));
  upstream.emit(runId, 'run.completed', { output: 'hola' });
  upstream.closeStream(runId);
  await reading;

  assert.deepEqual(seen.map((event) => [event.event, event.seq]), [
    ['message.delta', 0],
    ['tool.started', 1],
    ['run.completed', 2],
  ]);
  assert.equal(seen[0].delta, 'ho');
  assert.equal(seen[2].output, 'hola');
  const [get] = upstream.requestsTo('GET', /\/events$/);
  assert.equal(get.profile, 'coding');
  assert.equal(get.authorized, true);
  assert.equal(get.lastEventId, null);

  const resumed: UpstreamEvent[] = [];
  const again = (async () => {
    for await (const event of hermes.runEvents('coding', runId, 1, abort.signal)) resumed.push(event);
  })();
  await eventually(() => assert.equal(resumed.length, 1));
  upstream.closeStream(runId);
  await again;
  assert.equal(upstream.requestsTo('GET', /\/events$/)[1].lastEventId, '1');
  assert.deepEqual(resumed.map((event) => event.seq), [2]);
});

test('runStatus returns the status, or null when Hermes does not know the run', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'x' });
  assert.deepEqual(await hermes.runStatus('coding', runId), { status: 'running', output: null, error: null });
  upstream.emit(runId, 'run.completed', { output: 'fin' });
  assert.deepEqual(await hermes.runStatus('coding', runId), { status: 'completed', output: 'fin', error: null });
  assert.equal(await hermes.runStatus('coding', 'run_nope'), null);
  assert.equal(await hermes.runStatus('default', runId), null, 'runs are scoped to the profile that created them');
});

test('resolveApproval posts the choice and request id to the run of that profile', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'x' });
  await hermes.resolveApproval('coding', runId, 'session', 'req_42');
  const [post] = upstream.requestsTo('POST', /\/approval$/);
  assert.equal(post.path, `/v1/runs/${runId}/approval`);
  assert.equal(post.profile, 'coding');
  assert.equal(post.authorized, true);
  assert.deepEqual(post.body, { choice: 'session', request_id: 'req_42' });

  await hermes.resolveApproval('coding', runId, 'deny', null);
  assert.deepEqual(upstream.requestsTo('POST', /\/approval$/)[1].body, { choice: 'deny' });
});

test('resolveApproval maps "no pending approval" to conflict and an unknown run to not_found', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'x' });
  upstream.approvalStatus = 409;
  await assert.rejects(hermes.resolveApproval('coding', runId, 'once', 'req_1'), isHermesError('conflict'));
  await assert.rejects(hermes.resolveApproval('coding', 'run_nope', 'once', 'req_1'), isHermesError('not_found'));
});

test('stopRun posts to the run stop route', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('default', { input: 'x' });
  await hermes.stopRun('default', runId);
  const [post] = upstream.requestsTo('POST', /\/stop$/);
  assert.equal(post.path, `/v1/runs/${runId}/stop`);
  assert.equal(post.authorized, true);
  await assert.rejects(hermes.stopRun('default', 'run_nope'), isHermesError('not_found'));
});

test('an unknown profile is rejected before anything is read or sent', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  for (const profile of ['ghost', '../../etc', 'coding/../..']) {
    await assert.rejects(hermes.createRun(profile, { input: 'x' }), isHermesError('not_found'), profile);
    await assert.rejects(hermes.transcript(profile, null), isHermesError('not_found'), profile);
  }
  assert.equal(upstream.requests.length, 0);
});

test('#37 Agent chat availability checks the selected profile key without leaking configuration', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  assert.deepEqual(await hermes.chat('coding'), { available: true, reason: null });
  assert.deepEqual(upstream.requestsTo('GET', /^\/v1\/models$/).map((request) => [request.profile, request.authorized]), [['coding', true]]);
  const before = upstream.requests.length;
  const personal = await hermes.chat('personal');
  assert.equal(personal.available, false); assert.ok(personal.reason);
  assert.equal(upstream.requests.length, before, 'a profile with no key makes no upstream request');
  upstream.keys.coding = 'rotated fixture key';
  const rejected = await hermes.chat('coding');
  assert.equal(rejected.available, false);
  assert.doesNotMatch(rejected.reason ?? '', new RegExp(`${CODING_KEY}|API_SERVER_KEY|\\.env`));
});

for (const [httpStatus, code, expected] of [
  [409, 'run_not_accepting_steer', 'run_not_accepting_steer'],
  [409, 'steer_not_accepted', 'steer_not_accepted'],
  [400, 'invalid_steer_input', 'invalid_steer_input'],
  [404, 'run_not_found', 'run_not_found'],
  [500, 'steer_failed', 'operation_uncertain'],
  [403, 'invalid_api_key', 'operation_uncertain'],
] as const) test(`#37 real steer maps upstream ${httpStatus}/${code} without inventing acceptance`, async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'Entrada' });
  upstream.respond('POST', `/v1/runs/${runId}/steer`, (_request, response) => {
    response.writeHead(httpStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code, message: 'private instruction API_SERVER_KEY=credential-secret' } }));
  });
  await assert.rejects(hermes.steerRun('coding', runId, 'Instrucción'), (error: unknown) => {
    assert.ok(error instanceof HermesError); assert.equal(error.code, expected);
    assert.doesNotMatch(error.message, /private instruction|credential-secret|API_SERVER_KEY/);
    return true;
  });
});

test('#37 real steer treats a missing, malformed or mismatched success receipt as unknown', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const { runId } = await hermes.createRun('coding', { input: 'Entrada' });
  for (const receipt of [{}, { run_id: 'wrong', accepted: true }, { run_id: runId, accepted: false }, 'not-json']) {
    upstream.respond('POST', `/v1/runs/${runId}/steer`, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
    });
    await assert.rejects(hermes.steerRun('coding', runId, 'Instrucción'), isHermesError('operation_uncertain'));
  }
  upstream.respond('POST', `/v1/runs/${runId}/steer`, (_request, response) => { response.destroy(); });
  await assert.rejects(hermes.steerRun('coding', runId, 'Instrucción'), isHermesError('operation_uncertain'));
});


test('model catalog filters unconfigured providers and unavailable models within the requested profile without exposing credentials', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  upstream.respond('GET', '/api/model/options', (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ provider: 'custom:team', model: 'org/default', providers: [
      { slug: 'team', name: 'Team', aliases: ['team', 'custom:team'], authenticated: true, api_url: 'https://private.example', key_env: 'PRIVATE_KEY', models: ['org/default', 'org/other', 'denied'], unavailable_models: ['denied'] },
      { slug: 'missing', authenticated: false, models: ['must-not-offer'] },
    ] }));
  });
  const catalog = await hermes.models('coding');
  assert.deepEqual(catalog, { defaultModel: { provider: 'team', model: 'org/default' }, models: [{ provider: 'team', model: 'org/default', label: 'org/default' }, { provider: 'team', model: 'org/other', label: 'org/other' }] });
  assert.equal(upstream.requestsTo('GET', /model\/options/)[0].profile, 'coding');
  assert.equal(upstream.requestsTo('GET', /model\/options/)[0].authorized, true);
});

test('selected conversation model/provider reach only the upstream Run body and terminal runtime is read from actual runtime', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  const created = await hermes.createRun('coding', { input: 'Fixture', sessionId: 'fixture', model: { provider: 'team', model: 'org/selected' } });
  assert.deepEqual(upstream.requestsTo('POST', /^\/v1\/runs$/)[0].body, { input: 'Fixture', session_id: 'fixture', provider: 'team', model: 'org/selected' });
  upstream.respond('GET', `/v1/runs/${created.runId}`, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'completed', model: 'request-echo', runtime: { provider: 'fallback', model: 'served', requested: { provider: 'team', model: 'org/selected' }, route_source: 'raw_request' } }));
  });
  assert.deepEqual((await hermes.runStatus('coding', created.runId))?.runtime, { provider: 'fallback', model: 'served' });
  upstream.respond('GET', `/v1/runs/${created.runId}`, (_request, response) => { response.writeHead(200).end(JSON.stringify({ status: 'cancelled', model: 'request-echo' })); });
  assert.equal((await hermes.runStatus('coding', created.runId))?.runtime, undefined);
});

test('model catalog failures discard upstream bodies and credential metadata', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  upstream.respond('GET', '/api/model/options', (_request, response) => { response.writeHead(500).end(JSON.stringify({ error: { message: 'private-provider-key' } })); });
  await assert.rejects(hermes.models('default'), (error: unknown) => error instanceof HermesError && error.code === 'chat_unavailable' && !error.message.includes('private-provider-key'));
});


test('malformed authenticated catalog models fail closed with a safe typed error', async (t) => {
  const { hermes, upstream } = await withUpstream(t);
  for (const providers of [[{ slug: 'p', authenticated: true, models: [null] }], [{ slug: 'p', authenticated: true, models: ['safe'], unavailable_models: 'invalid' }]]) {
    upstream.respond('GET', '/api/model/options', (_request, response) => { response.writeHead(200).end(JSON.stringify({ provider: 'p', model: 'm', providers, private_field: 'do-not-leak' })); });
    await assert.rejects(hermes.models('default'), (error: unknown) => error instanceof HermesError && error.code === 'chat_unavailable' && !error.message.includes('do-not-leak'));
  }
});
