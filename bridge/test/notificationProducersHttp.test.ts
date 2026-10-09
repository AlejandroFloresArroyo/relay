import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATIONS_HEADER, type NotificationPreferences } from '../../protocol/notifications.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { eventually, settle } from '../support/channel.ts';
import type { JobHistory, ScheduledJob } from '../../protocol/scheduledJobs.ts';
import type { JobsManager } from '../src/jobsManager.ts';
import type { StateIO } from '../src/changeLog.ts';
import type { NotificationPublisher } from '../src/notifications.ts';

const DEVICE = '00000000-0000-4000-8000-000000000044';
const KEY = `rly1_${Buffer.alloc(32, 44).toString('base64url')}`;
const HEADERS = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', [NOTIFICATIONS_HEADER]: '1' };
const ORIGIN = 'http://ntfy.fixture.ts.net:8080';
const ENDPOINT = ORIGIN + '/upSyntheticCapability123456789?up=1';
async function start(t: TestContext, options: { io?: StateIO; publish?: NotificationPublisher; configure?: (hermes: FakeHermes) => void } = {}) {
  const directory = await fs.mkdtemp(path.resolve('.notification-producers-fixture-'));
  let clock = 1700000000000;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate(state => { state.devices.push({ id: DEVICE, name: 'private-phone-canary', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes(); options.configure?.(hermes);
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, now: () => clock, sleep: async () => {}, log: line => logs.push(line) });
  const publications: Array<{ endpoint: string; body: string; signal: AbortSignal }> = [];
  const server = createApp({ config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://relay.fixture.ts.net:1234', serverName: 'private-server-canary' }),
    hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', now: () => clock,
    log: line => logs.push(line), notificationOrigin: ORIGIN, notificationIO: options.io,
    // Widget signals have their own suite (widgetHttp.test.ts); these count notices only.
    notificationPublisher: async (endpoint, body, signal) => { if (JSON.parse(body).kind === 'widget') return; publications.push({ endpoint, body, signal }); await options.publish?.(endpoint, body, signal); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function stop() { runs.close(); if (!server.listening) return; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  t.after(async () => {
    try {
      const revoked = store.snapshot().devices.filter(device => device.revokedAt !== null).map(device => device.id);
      if (revoked.length) await eventually(async () => {
        const value = JSON.parse(await fs.readFile(path.join(directory, 'notifications.json'), 'utf8'));
        assert.ok(value.entries.every((entry: { deviceId: string; endpoint: string | null }) => !revoked.includes(entry.deviceId) || entry.endpoint === null));
      });
    } finally { await stop(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = HEADERS) {
    const response = await fetch(base + route, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); return { status: response.status, text, body: JSON.parse(text) };
  }
  async function enroll(revision = 0, types: NotificationPreferences['types'] = DEFAULT_NOTIFICATION_PREFERENCES.types) {
    const result = await call('PUT', '/v1/notifications/registration', { schema: 1, revision, endpoint: ENDPOINT, preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true, types } });
    assert.equal(result.status, 200); return result.body;
  }
  return { call, enroll, stop, publications, store, hermes, runs, logs, directory, now: () => clock, advance(ms: number) { clock += ms; } };
}

function generic(body: string, kind: string, registrationId: string, expiresAt: number) {
  const value = JSON.parse(body);
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'kind', 'noticeId', 'registrationId', 'expiresAt'].sort());
  assert.equal(value.schema, 1); assert.equal(value.kind, kind); assert.equal(value.registrationId, registrationId); assert.equal(value.expiresAt, expiresAt);
  assert.match(value.noticeId, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(body, /private-|run_1|coding|rly1_|command|result|action|endpoint/);
  return value;
}

test('confirmed Relay Turn completion publishes one generic task notice, without an effectful action', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  await app.runs.start(app.hermes.profilesList[1], { input: 'private-input-canary' });
  assert.equal(app.publications.length, 0, 'accepting work is not completion');
  app.hermes.stream('run_1').push({ event: 'run.completed', seq: 0, output: 'private-result-canary' });
  await eventually(() => assert.equal(app.publications.length, 1));
  const notice = generic(app.publications[0].body, 'task', enrollment.registration.id, 1700000300000);
  assert.equal((await app.call('GET', '/v1/notifications/notices/' + notice.noticeId)).status, 404);
  assert.equal((await app.call('POST', '/v1/notifications/notices/' + notice.noticeId + '/decision', { schema: 1, registrationId: notice.registrationId, target: { agentId: 'coding', runId: 'run_1', approvalId: 'fake' }, choice: 'once' })).status, 404);
  assert.equal(app.hermes.callsTo('resolveApproval').length, 0);
  assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'accepted');
  assert.doesNotMatch(app.logs.join('\n'), /private-|SyntheticCapability|run_1|coding/);
});

for (const event of ['run.failed', 'run.interrupted'] as const) {
  test(`confirmed ${event} emits error once and never exposes upstream error text`, async t => {
    const app = await start(t); const enrollment = await app.enroll();
    await app.runs.start(app.hermes.profilesList[1], { input: 'private-input-canary' });
    const terminal = { event, seq: 0, error: 'private-error-canary' };
    app.hermes.stream('run_1').push(terminal); app.hermes.stream('run_1').push(terminal);
    await eventually(() => assert.equal(app.publications.length, 1)); await settle();
    generic(app.publications[0].body, 'error', enrollment.registration.id, 1700000300000);
    assert.doesNotMatch(app.logs.join('\n'), /private-error-canary/);
  });
}
test('terminal snapshot recovery is observed, while missing, cancelled and unreachable Turns never invent a result', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.statuses.set('run_1', { status: 'completed', output: 'private-result-canary', error: null });
  app.hermes.stream('run_1').fail(new Error('private-stream-canary'));
  await eventually(() => assert.equal(app.publications.length, 1));
  generic(app.publications[0].body, 'task', enrollment.registration.id, 1700000300000);
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.statuses.set('run_2', null);
  app.hermes.stream('run_2').end();
  await eventually(() => assert.equal(app.runs.snapshot('run_2').phase, 'failed'));
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.stream('run_3').push({ event: 'run.cancelled', seq: 0 });
  await eventually(() => assert.equal(app.runs.snapshot('run_3').phase, 'cancelled'));
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.failWith.runStatus = new Error('private-status-canary');
  app.hermes.stream('run_4').end();
  await eventually(() => assert.ok(app.hermes.callsTo('runStatus').some(call => call.args[1] === 'run_4')));
  assert.equal(app.runs.snapshot('run_4').connection, 'reconnecting');
  await settle(); assert.equal(app.publications.length, 1);
  assert.doesNotMatch(app.logs.join('\n'), /private-/);
});

test('gateway notices require a confirmed transition; baseline, repetition and network failure are silent', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200);
  assert.equal(app.publications.length, 0, 'first status establishes baseline');
  assert.equal((await app.call('POST', '/v1/gateway/stop')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 1));
  generic(app.publications[0].body, 'server', enrollment.registration.id, 1700000300000);
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200);
  assert.equal((await app.call('POST', '/v1/gateway/stop')).status, 200);
  await settle(); assert.equal(app.publications.length, 1, 'same confirmed state is not another transition');
  app.hermes.failWith.gatewayAction = new Error('private-gateway-command-canary');
  assert.equal((await app.call('POST', '/v1/gateway/start')).status, 502);
  app.hermes.failWith.gateway = new Error('private-network-canary');
  assert.equal((await app.call('GET', '/v1/gateway')).status, 500);
  await settle(); assert.equal(app.publications.length, 1, 'no claim that the Server is down');
  delete app.hermes.failWith.gateway; delete app.hermes.failWith.gatewayAction;
  app.hermes.gatewayStatus = { state: 'active', pid: 9876, uptimeSeconds: 10, port: 1234 };
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 2));
  assert.doesNotMatch(app.publications.map(p => p.body).join('\n'), /private-|9876|1234|stopped|active/);
});

test('Pausa general publishes only after Hermes confirms a change, not while a request is pending or uncertain', async t => {
  let paused = false; let entered = false; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const app = await start(t, { configure(hermes) { hermes.serverControl = {
    async paused() { return paused; }, async pause() { entered = true; await waiting; paused = true; }, async resume() { throw new Error('private-resume-canary'); },
  }; } });
  const enrollment = await app.enroll();
  assert.equal((await app.call('GET', '/v1/server/control')).status, 200);
  const changing = app.call('POST', '/v1/server/pause');
  await eventually(() => assert.equal(entered, true)); await settle();
  assert.equal(app.publications.length, 0);
  release(); assert.equal((await changing).status, 200);
  await eventually(() => assert.equal(app.publications.length, 1));
  generic(app.publications[0].body, 'server', enrollment.registration.id, 1700000300000);
  assert.equal((await app.call('POST', '/v1/server/resume')).status, 502);
  await settle(); assert.equal(app.publications.length, 1);
  paused = false;
  assert.equal((await app.call('GET', '/v1/server/control')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 2));
});

const JOB = 'abcdef123456';
function jobs(history: JobsManager['history']): JobsManager {
  const job: ScheduledJob = { id: JOB, agentId: 'coding', name: 'private-job-canary', prompt: 'private-prompt-canary', schedule: 'every 30m', deliver: 'local', skills: [], repeat: null,
    enabled: true, state: 'scheduled', timezone: 'UTC', nextRunAt: null, lastStatus: 'completed', model: null, workdir: null, script: null };
  return { history, async snapshot() { return null; }, async list(agentId) { return { agentId, timezone: 'UTC', jobs: [{ ...job, agentId }] }; },
    async get(agentId) { return { ...job, agentId }; }, async create(agentId) { return { ...job, agentId }; }, async edit(agentId) { return { ...job, agentId }; },
    async delete() {}, async action(agentId) { return { ...job, agentId }; } };
}

test('scheduled task notices use only recent terminal ledger rows observed by history request, with scoped bounded dedup', async t => {
  const rows: JobHistory = { hasMore: false, executions: [
    { id: 'private-execution-canary', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:15Z', deliveryOutcome: 'private-result-canary', scheduledInstant: null },
    { id: 'failed-execution', status: 'failed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:18Z', deliveryOutcome: null, scheduledInstant: null },
    { id: 'running', status: 'running', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: null, deliveryOutcome: null, scheduledInstant: null },
    { id: 'unknown', status: 'unknown', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:18Z', deliveryOutcome: null, scheduledInstant: null },
    { id: 'old', status: 'completed', claimedAt: '2023-11-14T22:00:00Z', startedAt: null, finishedAt: '2023-11-14T22:00:00Z', deliveryOutcome: null, scheduledInstant: null },
    { id: 'future', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:21Z', deliveryOutcome: null, scheduledInstant: null },
    { id: 'no-time', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: null, deliveryOutcome: null, scheduledInstant: null },
  ] };
  let historyCalls = 0;
  const app = await start(t, { configure(hermes) { Object.assign(hermes, { jobsManager: jobs(async () => { historyCalls++; return rows; }) }); } });
  const enrollment = await app.enroll();
  assert.equal((await app.call('GET', '/v1/agents/coding/jobs')).status, 200);
  assert.equal((await app.call('POST', `/v1/agents/coding/jobs/${JOB}/run`, {})).status, 200);
  assert.equal(historyCalls, 0, 'no new automatic history polling');
  assert.equal(app.publications.length, 0, 'run acceptance and lastStatus do not prove a new result');
  const route = `/v1/agents/coding/jobs/${JOB}/history`;
  assert.equal((await app.call('GET', route)).status, 200);
  await eventually(() => assert.equal(app.publications.length, 2));
  assert.doesNotMatch(app.publications.map(p => p.body).join('\n'), /private-|abcdef123456|coding/);
  generic(app.publications[0].body, 'task', enrollment.registration.id, 1700000295000);
  generic(app.publications[1].body, 'error', enrollment.registration.id, 1700000298000);
  assert.equal((await app.call('GET', route + '?offset=1')).status, 200);
  await settle(); assert.equal(app.publications.length, 2);
  assert.equal((await app.call('GET', `/v1/agents/default/jobs/${JOB}/history`)).status, 200);
  await eventually(() => assert.equal(app.publications.length, 4), 2000);
  assert.equal((await app.call('GET', '/v1/agents/coding/jobs/012345abcdef/history')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 6));
  assert.doesNotMatch(app.publications.map(p => p.body).join('\n') + app.logs.join('\n'), /private-|abcdef123456|012345abcdef|coding/);
});

test('capability advertises the four installed producers, including task without an optional jobs port', async t => {
  const app = await start(t);
  const status = await app.call('GET', '/v1/notifications');
  assert.deepEqual(status.body.availableKinds, ['approval', 'task', 'error', 'server']);
  assert.equal(status.body.preferences.enabled, false); assert.equal(app.publications.length, 0);
});

for (const kind of ['task', 'error', 'server'] as const) {
  test(`muted ${kind} stays silent while the other terminal types remain opted in`, async t => {
    const app = await start(t);
    await app.enroll(0, { ...DEFAULT_NOTIFICATION_PREFERENCES.types, [kind]: false });
    await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
    app.hermes.stream('run_1').push({ event: 'run.completed', seq: 0 });
    await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
    app.hermes.stream('run_2').push({ event: 'run.failed', seq: 0, error: 'private-error-canary' });
    await app.call('GET', '/v1/gateway'); await app.call('POST', '/v1/gateway/stop');
    await eventually(() => assert.equal(app.runs.snapshot('run_2').phase, 'failed')); await settle();
    await eventually(() => assert.equal(app.publications.length, 2));
    assert.deepEqual(app.publications.map(p => JSON.parse(p.body).kind).sort(), ['task', 'error', 'server'].filter(k => k !== kind).sort());
  });
}

test('generic observations stop at registration expiry and never extend the final lease', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  app.advance(7 * 24 * 60 * 60 * 1000 - 1000);
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.stream('run_1').push({ event: 'run.completed', seq: 0 });
  await eventually(() => assert.equal(app.publications.length, 1));
  generic(app.publications[0].body, 'task', enrollment.registration.id, 1700604800000);
  app.advance(1000);
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.stream('run_2').push({ event: 'run.failed', seq: 0 });
  await eventually(() => assert.equal(app.runs.snapshot('run_2').phase, 'failed')); await settle();
  assert.equal(app.publications.length, 1);
  assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'disabled');
});

test('generic inflight delivery is bounded per device and dropped observations are not queued', async t => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const app = await start(t, { publish: async () => waiting }); await app.enroll();
  for (let i = 1; i <= 12; i++) {
    await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
    app.hermes.stream(`run_${i}`).push({ event: 'run.completed', seq: 0 });
    await eventually(() => assert.equal(app.runs.snapshot(`run_${i}`).phase, 'completed')); await settle();
  }
  assert.equal(app.publications.length, 8, 'eight outstanding observations at most per device');
  release(); await settle(); assert.equal(app.publications.length, 8, 'no automatic queue/retry after capacity returns');
});

for (const ending of ['rotate', 'disable', 'revoke', 'expire', 'close'] as const) {
  test(`generic late transport success cannot restore delivery after ${ending}`, async t => {
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    const app = await start(t, { publish: async () => waiting }); const enrollment = await app.enroll();
    await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
    app.hermes.stream('run_1').push({ event: 'run.completed', seq: 0 });
    await eventually(() => assert.equal(app.publications.length, 1));
    const signal = app.publications[0].signal;
    if (ending === 'rotate') {
      const updated = await app.enroll(1); assert.notEqual(updated.registration.id, enrollment.registration.id);
    } else if (ending === 'disable') {
      assert.equal((await app.call('DELETE', '/v1/notifications/registration', { schema: 1, revision: 1 })).status, 200);
    } else if (ending === 'revoke') {
      await app.store.mutate(state => { state.devices[0].revokedAt = app.now(); });
    } else if (ending === 'expire') app.advance(300000);
    else await app.stop();
    if (ending !== 'expire') assert.equal(signal.aborted, true);
    release();
    if (ending === 'rotate') {
      await settle(); assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'unknown');
    } else if (ending === 'disable') {
      await settle(); assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'disabled');
    } else if (ending === 'revoke') assert.equal((await app.call('GET', '/v1/notifications')).status, 403);
    else if (ending === 'expire') await eventually(async () => assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'failed'));
    else await eventually(() => assert.ok(app.logs.includes('Turn notification unavailable.')));
    assert.equal(app.publications.length, 1);
  });
}

async function otherEnrollment(app: Awaited<ReturnType<typeof start>>, number = 45) {
  const deviceId = '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
  const key = `rly1_${Buffer.alloc(32, number).toString('base64url')}`;
  await app.store.mutate(state => { state.devices.push({ id: deviceId, name: 'private-other-device-canary', pairedAt: app.now(), revokedAt: null, keyHash: hashDeviceKey(key).toString('hex') }); });
  const headers = { ...HEADERS, Authorization: 'Bearer ' + key };
  assert.equal((await app.call('PUT', '/v1/notifications/registration', { schema: 1, revision: 0, endpoint: ENDPOINT, preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } }, headers)).status, 200);
  return headers;
}
for (const source of ['gateway', 'paused', 'jobs'] as const) {
  test(`revocation during the final ${source} observation read prevents broadcast even to another valid device`, async t => {
    let release!: () => void; let entered = false;
    const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    let arm = false;
    const app = await start(t, { configure(hermes) {
      if (source === 'paused') hermes.serverControl = { async paused() { if (arm) { entered = true; await waiting; return true; } return false; }, async pause() {}, async resume() {} };
      if (source === 'jobs') Object.assign(hermes, { jobsManager: jobs(async () => { entered = true; await waiting; return { hasMore: false, executions: [{ id: 'private-row-canary', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:20Z', deliveryOutcome: null, scheduledInstant: null }] }; }) });
    } });
    await app.enroll(); const otherHeaders = await otherEnrollment(app);
    const route = source === 'gateway' ? '/v1/gateway' : source === 'paused' ? '/v1/server/control' : `/v1/agents/coding/jobs/${JOB}/history`;
    if (source !== 'jobs') assert.equal((await app.call('GET', route)).status, 200);
    if (source === 'gateway') t.mock.method(app.hermes, 'gateway', async () => { entered = true; await waiting; return { state: 'stopped', pid: null, uptimeSeconds: null, port: null }; });
    arm = true; const reading = app.call('GET', route);
    await eventually(() => assert.equal(entered, true));
    await app.store.mutate(state => { state.devices[0].revokedAt = app.now(); }); release();
    assert.equal((await reading).status, 403);
    const otherStatus = await app.call('GET', '/v1/notifications', undefined, otherHeaders);
    assert.equal(otherStatus.status, 200); assert.equal(otherStatus.body.delivery, 'unknown');
    await settle(); assert.equal(app.publications.length, 0);
    assert.doesNotMatch(app.logs.join('\n'), /private-row-canary/);
  });
}

test('failed publication retains a bounded dedup claim and never retries the observed scheduled result', async t => {
  const row: JobHistory = { hasMore: false, executions: [{ id: 'private-row-canary', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:20Z', deliveryOutcome: null, scheduledInstant: null }] };
  const app = await start(t, { configure(hermes) { Object.assign(hermes, { jobsManager: jobs(async () => row) }); }, publish: async () => { throw new Error('private-transport-canary'); } });
  await app.enroll();
  const route = `/v1/agents/coding/jobs/${JOB}/history`;
  assert.equal((await app.call('GET', route)).status, 200, 'delivery failure does not change the observed job result');
  await eventually(() => assert.ok(app.logs.includes('Task notification unavailable.')));
  assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'failed');
  assert.equal((await app.call('GET', route)).status, 200); await settle();
  assert.equal(app.publications.length, 1);
  assert.doesNotMatch(app.logs.join('\n'), /private-/);
});

test('a history read that finishes after Puente close cannot start a late publication', async t => {
  let release!: () => void; let entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const app = await start(t, { configure(hermes) { Object.assign(hermes, { jobsManager: jobs(async () => {
    entered = true; await waiting;
    return { hasMore: false, executions: [{ id: 'private-row-canary', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:20Z', deliveryOutcome: null, scheduledInstant: null }] };
  }) }); } });
  await app.enroll();
  const reading = app.call('GET', `/v1/agents/coding/jobs/${JOB}/history`).catch(() => null);
  await eventually(() => assert.equal(entered, true)); await app.stop(); release(); await reading;
  await settle(); assert.equal(app.publications.length, 0);
});

test('generic publication bounds apply across devices while each recipient keeps its own opaque identity', async t => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const app = await start(t, { publish: async () => waiting }); await app.enroll();
  for (let number = 45; number <= 52; number++) await otherEnrollment(app, number);
  for (let i = 1; i <= 8; i++) {
    await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
    app.hermes.stream(`run_${i}`).push({ event: 'run.completed', seq: 0 });
    await eventually(() => assert.equal(app.runs.snapshot(`run_${i}`).phase, 'completed')); await settle();
  }
  assert.equal(app.publications.length, 64, '64 simultaneous generic publications at most across all devices');
  const notices = app.publications.map(p => JSON.parse(p.body));
  assert.equal(new Set(notices.map(n => n.noticeId)).size, 64);
  assert.equal(new Set(notices.map(n => n.registrationId)).size, 9);
  release(); await settle(); assert.equal(app.publications.length, 64);
});

test('dedup storage refuses live overflow, purges expired claims and does not replay old observations', async t => {
  let page = 0;
  const app = await start(t, { configure(hermes) { Object.assign(hermes, { jobsManager: jobs(async () => ({ hasMore: true, executions: Array.from({ length: 8 }, (_, i) => ({
    id: `row-${page * 8 + i}`, status: 'completed' as const, claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:20Z', deliveryOutcome: null, scheduledInstant: null,
  })) })) }); } });
  await app.enroll();
  const route = `/v1/agents/coding/jobs/${JOB}/history`;
  for (page = 0; page <= 256; page++) {
    assert.equal((await app.call('GET', route)).status, 200); await settle();
  }
  assert.equal(app.publications.length, 2048, 'dedup references remain bounded; no eviction of live claims');
  page = 0; assert.equal((await app.call('GET', route)).status, 200); await settle(); assert.equal(app.publications.length, 2048);
  app.advance(300000);
  assert.equal((await app.call('GET', route)).status, 200); await settle(); assert.equal(app.publications.length, 2048, 'expired old result cannot be republished');
  await app.runs.start(app.hermes.profilesList[1], { input: 'synthetic' });
  app.hermes.stream('run_1').push({ event: 'run.completed', seq: 0 });
  await eventually(() => assert.equal(app.publications.length, 2049), 2000);
});

test('a gateway action ACK does not publish success until the returned state is confirmed', async t => {
  let release!: () => void; let entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const app = await start(t); await app.enroll();
  t.mock.method(app.hermes, 'gatewayAction', async () => { entered = true; await waiting; });
  const stopping = app.call('POST', '/v1/gateway/stop');
  await eventually(() => assert.equal(entered, true)); await settle(); assert.equal(app.publications.length, 0);
  release(); assert.equal((await stopping).status, 502, 'active state does not confirm a requested stop');
  await settle(); assert.equal(app.publications.length, 0);
});

test('delivery failures cannot relabel confirmed gateway or Pausa general success', async t => {
  let paused = false;
  const app = await start(t, { publish: async () => { throw new Error('private-transport-canary'); }, configure(hermes) { hermes.serverControl = {
    async paused() { return paused; }, async pause() { paused = true; }, async resume() { paused = false; },
  }; } });
  await app.enroll();
  assert.equal((await app.call('POST', '/v1/gateway/stop')).status, 200);
  assert.equal((await app.call('POST', '/v1/server/pause')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 2));
  await eventually(async () => assert.equal((await app.call('GET', '/v1/notifications')).body.delivery, 'failed'));
  assert.doesNotMatch(app.logs.join('\n'), /private-/);
});

test('source authorization survives a queued enrollment disk wait before publishing to any valid device', async t => {
  let arm = false; let entered = false; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const io: StateIO = { ...fs, open: (async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: number) => {
    const handle = await fs.open(file, flags, mode);
    if (arm && String(file).includes('/.notifications.')) {
      arm = false; const close = handle.close.bind(handle);
      handle.close = async () => { await close(); entered = true; await waiting; };
    }
    return handle;
  }) as typeof fs.open };
  const app = await start(t, { io, configure(hermes) { Object.assign(hermes, { jobsManager: jobs(async () => ({ hasMore: false, executions: [{
    id: 'private-row-canary', status: 'completed', claimedAt: '2023-11-14T22:13:00Z', startedAt: null, finishedAt: '2023-11-14T22:13:20Z', deliveryOutcome: null, scheduledInstant: null,
  }] })) }); } });
  await app.enroll(); await otherEnrollment(app); arm = true;
  const rotating = app.call('PUT', '/v1/notifications/registration', { schema: 1, revision: 1, endpoint: ENDPOINT, preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true } });
  await eventually(() => assert.equal(entered, true));
  assert.equal((await app.call('GET', `/v1/agents/coding/jobs/${JOB}/history`)).status, 200);
  await settle(); assert.equal(app.publications.length, 0);
  await app.store.mutate(state => { state.devices[0].revokedAt = app.now(); }); release();
  assert.equal((await rotating).status, 403);
  await eventually(() => assert.ok(app.logs.includes('Task notification unavailable.'))); await settle();
  assert.equal(app.publications.length, 0, 'even the other enrollment cannot receive a source whose authorization expired during the disk wait');
});

test('an observed gateway process replacement is a confirmed server transition, while uptime changes are not', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200);
  assert.equal((await app.call('POST', '/v1/gateway/restart')).status, 200);
  await eventually(() => assert.equal(app.publications.length, 1));
  generic(app.publications[0].body, 'server', enrollment.registration.id, 1700000300000);
  app.hermes.gatewayStatus = { ...app.hermes.gatewayStatus, uptimeSeconds: 9999 };
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200); await settle(); assert.equal(app.publications.length, 1);
  app.hermes.gatewayStatus = { ...app.hermes.gatewayStatus, pid: null };
  assert.equal((await app.call('GET', '/v1/gateway')).status, 200); await settle(); assert.equal(app.publications.length, 1, 'unknown PID does not prove a restart');
});

for (const source of ['gateway', 'paused'] as const) {
  test(`older ${source} reads finishing after a newer confirmed observation cannot invent a reverse transition`, async t => {
    let release!: () => void; let entered = false; let arm = false; let reads = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    const app = await start(t, { configure(hermes) {
      if (source === 'paused') hermes.serverControl = { async paused() {
        if (!arm) return false;
        if (++reads === 1) { entered = true; await waiting; return false; }
        return true;
      }, async pause() {}, async resume() {} };
    } });
    await app.enroll();
    const route = source === 'gateway' ? '/v1/gateway' : '/v1/server/control';
    assert.equal((await app.call('GET', route)).status, 200);
    if (source === 'gateway') t.mock.method(app.hermes, 'gateway', async () => {
      if (++reads === 1) { entered = true; await waiting; return { state: 'active', pid: 4242, uptimeSeconds: 10, port: 1234 }; }
      return { state: 'stopped', pid: null, uptimeSeconds: null, port: null };
    });
    arm = true; const old = app.call('GET', route);
    await eventually(() => assert.equal(entered, true));
    assert.equal((await app.call('GET', route)).status, 200);
    await eventually(() => assert.equal(app.publications.length, 1));
    release(); assert.equal((await old).status, 200); await settle();
    assert.equal(app.publications.length, 1, 'an older sample is not evidence of another transition');
  });
}
