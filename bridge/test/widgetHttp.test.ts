import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_REGISTRATION_TTL_MS, NOTIFICATIONS_HEADER } from '../../protocol/notifications.ts';
import { WIDGET_OBSERVATION_TTL_MS, WIDGET_SIGNAL_INTERVAL_MS } from '../../protocol/widget.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { eventually, settle } from '../support/channel.ts';

const DEVICE = '00000000-0000-4000-8000-000000000055';
const KEY = `rly1_${Buffer.alloc(32, 55).toString('base64url')}`;
const HEADERS = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2' };
const ORIGIN = 'http://ntfy.fixture.ts.net:8080';
const ENDPOINT = ORIGIN + '/upSyntheticWidgetCapability123?up=1';
const START = 1700000000000;

async function start(t: TestContext, options: { hold?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.resolve('.widget-fixture-'));
  let clock = START;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate(state => { state.devices.push({ id: DEVICE, name: 'private-phone-canary', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  hermes.profilesList = [
    { id: 'default', name: 'dev', model: 'private-model-canary', provider: 'private-provider-canary' },
    { id: 'coding', name: 'sk-private-label-canary', model: 'm', provider: 'p' },
    { id: 'ops', name: 'ops', model: 'm', provider: 'p' },
    { id: 'fourth', name: 'fourth', model: 'm', provider: 'p' },
  ];
  hermes.states = { default: 'on', coding: 'err', ops: 'off', fourth: 'on' };
  hermes.lastMessages = { default: { text: 'private-transcript-canary', at: START } };
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, now: () => clock, sleep: async () => {}, log: line => logs.push(line) });
  const publications: Array<{ endpoint: string; body: string; signal: AbortSignal }> = [];
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const server = createApp({ config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://relay.fixture.ts.net:1234', serverName: 'private-server-canary' }),
    hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', now: () => clock,
    log: line => logs.push(line), notificationOrigin: ORIGIN,
    notificationPublisher: async (endpoint, body, signal) => {
      publications.push({ endpoint, body, signal });
      if (options.hold) {
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        await promise;
      }
    },
    timer: (ms, run) => { const entry = { at: clock + ms, run, cancelled: false }; timers.push(entry); return () => { entry.cancelled = true; }; },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    try {
      // Revocation prunes an enrollment asynchronously; let that write land before removing the fixture.
      const file = path.join(directory, 'notifications.json');
      if (store.snapshot().devices.some(device => device.revokedAt !== null) && await fs.stat(file).then(() => true, () => false)) await eventually(async () => {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.ok(value.entries.every((entry: { endpoint: string | null }) => entry.endpoint === null));
      });
    } finally {
      runs.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = HEADERS) {
    const response = await fetch(base + route, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); return { status: response.status, text, body: JSON.parse(text) };
  }
  async function enroll(enabled = true) {
    const result = await call('PUT', '/v1/notifications/registration', { schema: 1, revision: 0, endpoint: ENDPOINT, preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled } },
      { ...HEADERS, [NOTIFICATIONS_HEADER]: '1' });
    assert.equal(result.status, 200); return result.body;
  }
  /** Advances the injected clock and runs every due timer once. */
  async function advance(ms: number) {
    clock += ms;
    for (const entry of timers.splice(0)) {
      if (entry.cancelled) continue;
      if (entry.at <= clock) entry.run(); else timers.push(entry);
    }
    await settle();
  }
  const signals = () => publications.filter(item => JSON.parse(item.body).kind === 'widget');
  return { call, enroll, advance, signals, publications, store, hermes, runs, logs, timers };
}

function approvalEvent(id: string, timestamp = START / 1000) {
  return { event: 'approval.request', seq: 0, request_id: id, command: 'private-command-canary', choices: ['once', 'deny'], timestamp };
}

test('GET /v1/widget returns exactly the minimal projection, never commands, messages, models or free text', async t => {
  const app = await start(t);
  await app.runs.start(app.hermes.profilesList[0], { input: 'private-input-canary' });
  app.hermes.stream('run_1').push(approvalEvent('synthetic-approval'));
  await eventually(() => assert.equal(app.runs.approvals().length, 1));
  const response = await app.call('GET', '/v1/widget');
  assert.equal(response.status, 200);
  const approvalExpiry = app.runs.approvals()[0].expiresAt!;
  assert.deepEqual(response.body, {
    schema: 1, observedAt: START, expiresAt: Math.min(START + WIDGET_OBSERVATION_TTL_MS, approvalExpiry), count: 1,
    agents: [{ label: 'dev', state: 'busy' }, { label: 'Agente', state: 'err' }, { label: 'ops', state: 'off' }],
  });
  assert.doesNotMatch(response.text, /private-|synthetic-approval|run_1|coding|default|fourth/);
  assert.equal(app.hermes.callsTo('lastMessage').length, 0, 'the widget never reads a transcript');
  assert.doesNotMatch(app.logs.join('\n'), /private-|rly1_/);
});

test('the projection expires at the TTL without Aprobaciones and never counts an expired one', async t => {
  const app = await start(t);
  assert.deepEqual((await app.call('GET', '/v1/widget')).body, {
    schema: 1, observedAt: START, expiresAt: START + WIDGET_OBSERVATION_TTL_MS, count: 0,
    agents: [{ label: 'dev', state: 'on' }, { label: 'Agente', state: 'err' }, { label: 'ops', state: 'off' }],
  });
  await app.runs.start(app.hermes.profilesList[0], { input: 'x' });
  app.hermes.stream('run_1').push(approvalEvent('synthetic-approval'));
  await eventually(() => assert.equal(app.runs.approvals().length, 1));
  await app.advance(app.runs.approvals()[0].expiresAt! - START);
  const after = (await app.call('GET', '/v1/widget')).body;
  assert.equal(after.count, 0);
  assert.ok(after.expiresAt > after.observedAt);
});

test('GET /v1/widget requires the device key, a current device and protocol 2', async t => {
  const app = await start(t);
  assert.equal((await app.call('GET', '/v1/widget', undefined, { 'X-Relay-Protocol': '2' })).status, 401);
  assert.equal((await app.call('GET', '/v1/widget', undefined, { Authorization: HEADERS.Authorization })).status, 426);
  await app.store.mutate(state => { state.devices[0].revokedAt = START; });
  const revoked = await app.call('GET', '/v1/widget');
  assert.equal(revoked.status, 403); assert.equal(revoked.body.error.code, 'device_revoked');
  assert.doesNotMatch(revoked.text, /"dev"|"ops"|count|agents/);
});

test('changes publish one content-free widget signal per window, with a trailing one for later changes', async t => {
  const app = await start(t); const enrollment = await app.enroll();
  await app.runs.start(app.hermes.profilesList[0], { input: 'private-input-canary' });
  app.hermes.stream('run_1').push(approvalEvent('synthetic-approval'));
  await eventually(() => assert.equal(app.runs.approvals().length, 1));
  await app.advance(0);
  assert.equal(app.signals().length, 1, 'a Turn start and an Aprobación in the same instant coalesce');
  const body = app.signals()[0].body;
  assert.deepEqual(JSON.parse(body), { schema: 1, kind: 'widget', registrationId: enrollment.registration.id });
  assert.equal(app.signals()[0].endpoint, ENDPOINT);
  assert.doesNotMatch(body, /private-|synthetic-approval|run_1|dev|count|agents|expiresAt|noticeId/);
  app.hermes.stream('run_1').push({ event: 'run.completed', seq: 1, output: 'private-result-canary' });
  await eventually(() => assert.equal(app.runs.approvals().length, 0));
  await app.advance(WIDGET_SIGNAL_INTERVAL_MS - 1);
  assert.equal(app.signals().length, 1, 'no second signal inside the window');
  await app.advance(1);
  assert.equal(app.signals().length, 2, 'the change inside the window is not lost');
  await app.advance(WIDGET_SIGNAL_INTERVAL_MS * 3);
  assert.equal(app.signals().length, 2, 'no signal without a change');
  assert.doesNotMatch(app.logs.join('\n'), /private-|SyntheticWidget/);
});

test('no widget signal without an enabled registration, and none after revocation', async t => {
  const app = await start(t); await app.enroll(false);
  await app.runs.start(app.hermes.profilesList[0], { input: 'x' });
  await app.advance(WIDGET_SIGNAL_INTERVAL_MS);
  assert.equal(app.signals().length, 0);
  const second = await start(t); await second.enroll();
  await second.store.mutate(state => { state.devices[0].revokedAt = START; });
  await settle();
  await second.runs.start(second.hermes.profilesList[0], { input: 'x' });
  await second.advance(WIDGET_SIGNAL_INTERVAL_MS);
  assert.equal(second.signals().length, 0, 'a revoked device receives no signal');
});

test('an expired registration lease receives no widget signal', async t => {
  const app = await start(t); await app.enroll();
  await app.advance(NOTIFICATION_REGISTRATION_TTL_MS);
  await app.runs.start(app.hermes.profilesList[0], { input: 'x' });
  await app.advance(WIDGET_SIGNAL_INTERVAL_MS);
  assert.equal(app.signals().length, 0);
});

test('revocation aborts a widget signal still in flight', async t => {
  const app = await start(t, { hold: true }); await app.enroll();
  await app.runs.start(app.hermes.profilesList[0], { input: 'x' });
  await app.advance(0);
  assert.equal(app.signals().length, 1);
  assert.equal(app.signals()[0].signal.aborted, false);
  await app.store.mutate(state => { state.devices[0].revokedAt = START; });
  await eventually(() => assert.equal(app.signals()[0].signal.aborted, true));
});
