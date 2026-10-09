import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createDecisionStore } from '../src/decisionStore.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import type { StateIO } from '../src/changeLog.ts';
import { createPairing } from '../src/pairing.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { eventually } from '../support/channel.ts';
import { loadConfig } from '../src/config.ts';
import { HermesError, HTTP_STATUS } from '../src/hermes.ts';
import { createAuthLimiter } from '../src/auth.ts';

async function boot(t: TestContext, io?: StateIO, decisionIO?: StateIO) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-http-pair-'));
  let now = 100_000; let ip = '100.64.0.1'; let whoisCount = 0;
  let whois = async (_ip: string): Promise<{ device: string | null; tailnet: string | null } | null> => ({ device: 'phone', tailnet: 'example.ts.net' });
  const store = await createDeviceStore({ directory, now: () => now, io });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, ...(decisionIO ? {decisionStore: await createDecisionStore({directory,io:decisionIO})}:{}), notifier: { approvalCreated: async () => {} }, sleep: async () => {} });
  const logs: string[] = [];
  const server = createApp({ config: { corsOrigins: [] }, hermes, runs, store, pairing,
    tailnet: { whois: async (ip) => { whoisCount++; return whois(ip); } }, peerAddress: () => ip,
    now: () => now, log: (line) => logs.push(line), keepaliveMs: 10 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { runs.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  async function call(route: string, init?: RequestInit) {
    const res = await fetch(base + route, init);
    return { status: res.status, headers: res.headers, body: await res.json() };
  }
  async function pair() {
    const { payload } = await pairing.pair();
    return (await call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) })).body;
  }
  return { directory, store, pairing, hermes, runs, server, logs, base, call, pair, setNow: (at: number) => { now = at; }, setIp: (value: string) => { ip = value; }, setWhois: (fn: typeof whois) => { whois = fn; }, whoisCount: () => whoisCount };
}

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

async function penalize(f: Awaited<ReturnType<typeof boot>>) {
  for (let i = 0; i < 5; i++) assert.equal((await f.call('/v1/model')).status, i === 4 ? 429 : 401);
  return f.store.snapshot().failedAttempts;
}

const saturatedAttempts = () => Array.from({ length: 4096 }, (_, i) => ({
  ip: `100.65.${i >>> 8}.${i & 255}`, failures: [100_000], blockedUntil: 400_000,
}));

async function partialPost(t: TestContext, f: Awaited<ReturnType<typeof boot>>, route: string, headers = {}) {
  let incoming: http.IncomingMessage | undefined;
  f.server.once('request', (req) => { incoming = req; });
  const request = http.request(new URL(f.base + route), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } });
  t.after(() => request.destroy());
  const reply = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
    request.on('error', reject); request.on('response', res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(body) }));
    });
  });
  request.write('{');
  await eventually(() => assert.ok(incoming && incoming.listenerCount('data') > 0));
  return { request, reply };
}

test('A1 delayed pairing body is blocked before code comparison and whois', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair();
  const pending = f.store.snapshot().pendingPairing;
  const post = await partialPost(t, f, '/v1/pair');
  for (let i = 0; i < 5; i++) assert.equal((await f.call('/v1/model')).status, i === 4 ? 429 : 401);
  const spy = t.mock.method(crypto, 'timingSafeEqual', crypto.timingSafeEqual);
  post.request.end(JSON.stringify({ code: payload.code }).slice(1));
  const result = await post.reply;
  assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], '300');
  assert.equal(spy.mock.callCount(), 0); assert.equal(f.whoisCount(), 0);
  assert.deepEqual(f.store.snapshot().pendingPairing, pending); assert.equal(f.store.snapshot().devices.length, 0);
});

test('A1 penalty queued after verification prevents the following whois', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair();
  const limiter = createAuthLimiter(f.store);
  for (let i = 0; i < 4; i++) await limiter.failure('100.64.0.1');
  const post = await partialPost(t, f, '/v1/pair');
  let verified = false;
  const original = crypto.timingSafeEqual;
  t.mock.method(crypto, 'timingSafeEqual', (...args: Parameters<typeof crypto.timingSafeEqual>) => { verified = true; return original(...args); });
  // A real fifth failure joins the store queue after comparison, before verify resolves.
  const unsubscribe = f.store.subscribe(() => {
    if (verified) { unsubscribe(); void limiter.failure('100.64.0.1'); }
  });
  t.after(unsubscribe);
  post.request.end(JSON.stringify({ code: payload.code }).slice(1));
  const result = await post.reply;
  assert.equal(result.status, 429); assert.equal(f.whoisCount(), 0);
  assert.equal(f.store.snapshot().devices.length, 0); assert.ok(f.store.snapshot().pendingPairing);
});

test('A2 concurrent fifth failure denies an already checked valid HTTP request', async (t) => {
  let pause = false; let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const io: StateIO = { ...fs, async rename(...args) {
    if (pause) { pause = false; entered = true; await gate; }
    await fs.rename(...args);
  } };
  const f = await boot(t, io); const paired = await f.pair();
  await f.store.mutate(state => { state.failedAttempts = [
    { ip: '100.64.0.1', failures: [100_001, 100_001, 100_001, 100_001], blockedUntil: null },
    { ip: '100.64.0.2', failures: [100_000], blockedUntil: null },
  ]; });
  f.setNow(160_000); pause = true;
  const invalid = f.call('/v1/model');
  await eventually(() => assert.ok(entered));
  const received = new Promise<void>(resolve => f.server.once('request', () => resolve()));
  const valid = f.call('/v1/model', { headers: auth(paired.deviceKey) });
  await received; release();
  const [failed, authorized] = await Promise.all([invalid, valid]);
  assert.equal(failed.status, 429); assert.equal(authorized.status, 429);
  assert.equal(authorized.body.error.code, 'rate_limited'); assert.equal(authorized.headers.get('retry-after'), '300');
  assert.equal(f.hermes.callsTo('model').length, 0);
  assert.equal(f.store.snapshot().failedAttempts[0].blockedUntil, 460_000);
});

for (const [route, prerequisite, forbidden] of [
  ['/v1/agents/default/transcript', 'profiles', ['transcript']],
  ['/v1/agents', 'profiles', ['profileStates', 'lastMessage']],
  ['/v1/agents', 'profileStates', ['lastMessage']],
] as const) {
  test(`A3 revocation during ${prerequisite} prevents continuation of ${route}`, async (t) => {
    const f = await boot(t); const paired = await f.pair();
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const original = f.hermes[prerequisite].bind(f.hermes);
    t.mock.method(f.hermes, prerequisite, async (...args: [string[]]) => {
      const result = await original(...args); entered = true; await gate; return result;
    });
    const pending = f.call(route, { headers: auth(paired.deviceKey) });
    await eventually(() => assert.ok(entered)); await f.pairing.revoke(paired.device.id); release();
    const result = await pending;
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'device_revoked');
    for (const method of forbidden) assert.equal(f.hermes.callsTo(method).length, 0);
  });
}

test('A4 revocation during approval body read prevents resolveApproval', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  const run = await f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'hello' }) });
  f.hermes.stream(run.body.runId).push({ event: 'approval.request', seq: 0, command: 'synthetic command', description: 'fixture',
    pattern_key: 'fixture', request_id: 'fixture-request', choices: ['once', 'deny'], timestamp: Date.now() / 1000 });
  await eventually(() => assert.equal(f.runs.approvals().length, 1));
  const id = f.runs.approvals()[0].id;
  const post = await partialPost(t, f, `/v1/approvals/${id}`, auth(paired.deviceKey));
  await f.pairing.revoke(paired.device.id); post.request.end('"choice":"once"}');
  const result = await post.reply;
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'device_revoked');
  assert.equal(f.hermes.callsTo('resolveApproval').length, 0); assert.equal(f.runs.approvals().length, 1);
});

for (const action of ['start', 'stop', 'restart'] as const) {
  test(`revocation while gateway ${action} is pending prevents the following gateway read`, async (t) => {
    const f = await boot(t); const paired = await f.pair(); const other = await f.pair();
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const original = f.hermes.gatewayAction.bind(f.hermes);
    t.mock.method(f.hermes, 'gatewayAction', async (value: typeof action) => {
      await original(value); entered = true; await gate;
    });
    const pending = f.call(`/v1/gateway/${action}`, { method: 'POST', headers: { ...auth(paired.deviceKey), 'X-Relay-Protocol': '2' } });
    await eventually(() => assert.ok(entered));
    const allowedReads = f.hermes.callsTo('gateway').length; assert.equal(allowedReads, 1);
    await f.pairing.revoke(paired.device.id); release();
    const result = await pending;
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'device_revoked');
    assert.equal(f.hermes.callsTo('gateway').length, allowedReads);
    assert.deepEqual(f.hermes.callsTo('gatewayAction').map(call => call.args[0]), [action]);
    // Already dispatched work can finish; the lock and the other device remain usable.
    assert.equal((await f.call('/v1/gateway/stop', { method: 'POST', headers: { ...auth(other.deviceKey), 'X-Relay-Protocol': '2' } })).status, 200);
    assert.equal(f.hermes.callsTo('gateway').length, allowedReads + 2);
  });
}

test('revocation queued during gateway authentication prevents both action and gateway read', async (t) => {
  let pause = false; let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const io: StateIO = { ...fs, async rename(...args) {
    if (pause) { pause = false; entered = true; await gate; }
    await fs.rename(...args);
  } };
  const f = await boot(t, io); const paired = await f.pair();
  await f.store.mutate(state => { state.failedAttempts = [{ ip: '100.64.0.2', failures: [100_000], blockedUntil: null }]; });
  f.setNow(160_000); pause = true;
  const pending = f.call('/v1/gateway/restart', { method: 'POST', headers: auth(paired.deviceKey) });
  await eventually(() => assert.ok(entered));
  const revoked = f.pairing.revoke(paired.device.id); release(); await revoked;
  const result = await pending;
  assert.equal(result.status, 403); assert.equal(result.body.error.code, 'device_revoked');
  assert.equal(f.hermes.callsTo('gatewayAction').length, 0); assert.equal(f.hermes.callsTo('gateway').length, 0);
});

test('A6 penalty during a run body prevents createRun without changing failures', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  const post = await partialPost(t, f, '/v1/agents/default/runs', auth(paired.deviceKey));
  const attempts = await penalize(f); const calls = f.hermes.calls.length;
  post.request.end('"input":"fixture"}'); const result = await post.reply;
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers['retry-after'], '300');
  assert.equal(f.hermes.callsTo('createRun').length, 0); assert.equal(f.hermes.calls.length, calls);
  assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
});

test('A6 penalty during an approval body prevents resolveApproval without changing failures', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  const run = await f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'fixture' }) });
  f.hermes.stream(run.body.runId).push({ event: 'approval.request', seq: 0, command: 'synthetic command', description: 'fixture',
    pattern_key: 'fixture', request_id: 'fixture-request', choices: ['once', 'deny'], timestamp: Date.now() / 1000 });
  await eventually(() => assert.equal(f.runs.approvals().length, 1));
  const post = await partialPost(t, f, `/v1/approvals/${f.runs.approvals()[0].id}`, auth(paired.deviceKey));
  const attempts = await penalize(f); const calls = f.hermes.calls.length;
  post.request.end('"choice":"once"}'); const result = await post.reply;
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers['retry-after'], '300');
  assert.equal(f.hermes.callsTo('resolveApproval').length, 0); assert.equal(f.hermes.calls.length, calls);
  assert.equal(f.runs.approvals().length, 1); assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
});

for (const [route, prerequisite, forbidden] of [
  ['/v1/agents/default/transcript', 'profiles', ['transcript']],
  ['/v1/agents', 'profiles', ['profileStates', 'lastMessage']],
  ['/v1/agents', 'profileStates', ['lastMessage']],
] as const) {
  test(`A6 penalty during ${prerequisite} prevents continuation of ${route}`, async (t) => {
    const f = await boot(t); const paired = await f.pair();
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const original = f.hermes[prerequisite].bind(f.hermes);
    t.mock.method(f.hermes, prerequisite, async (...args: [string[]]) => {
      const result = await original(...args); entered = true; await gate; return result;
    });
    const pending = f.call(route, { headers: auth(paired.deviceKey) });
    await eventually(() => assert.ok(entered)); const attempts = await penalize(f); release();
    const result = await pending;
    assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers.get('retry-after'), '300');
    for (const method of forbidden) assert.equal(f.hermes.callsTo(method).length, 0);
    assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
  });
}

for (const action of ['start', 'stop', 'restart'] as const) {
  test(`A6 penalty while gateway ${action} is pending prevents the following gateway read`, async (t) => {
    const f = await boot(t); const paired = await f.pair();
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    t.mock.method(f.hermes, 'gatewayAction', async () => { entered = true; await gate; });
    const pending = f.call(`/v1/gateway/${action}`, { method: 'POST', headers: { ...auth(paired.deviceKey), 'X-Relay-Protocol': '2' } });
    await eventually(() => assert.ok(entered));
    const allowedReads = f.hermes.callsTo('gateway').length; assert.equal(allowedReads, 1);
    const attempts = await penalize(f); release();
    const result = await pending;
    assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers.get('retry-after'), '300');
    assert.equal(f.hermes.callsTo('gateway').length, allowedReads); assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
  });
}

test('A6 penalty suppresses an awaited private result using the captured peer IP', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  t.mock.method(f.hermes, 'model', async () => { entered = true; await gate; return { model: 'private-result', provider: 'fake' }; });
  const pending = f.call('/v1/model', { headers: auth(paired.deviceKey) });
  await eventually(() => assert.ok(entered)); const attempts = await penalize(f);
  f.setIp('100.64.0.2'); release(); const result = await pending;
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers.get('retry-after'), '300');
  assert.ok(!JSON.stringify(result.body).includes('private-result')); assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
  assert.equal((await f.call('/v1/model', { headers: auth(paired.deviceKey) })).status, 200);
});

test('A6 saturation during whois rejects redemption before comparing or consuming the code', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair(); const code = f.store.snapshot().pendingPairing;
  let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  f.setWhois(async () => { entered = true; await gate; return { device: 'phone', tailnet: 'example.ts.net' }; });
  const pending = f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) });
  await eventually(() => assert.ok(entered));
  await f.store.mutate(state => { state.failedAttempts = saturatedAttempts(); });
  assert.deepEqual(await createAuthLimiter(f.store).check('100.64.0.1'), { blocked: true, retryAfter: 60 });
  const spy = t.mock.method(crypto, 'timingSafeEqual', crypto.timingSafeEqual); release();
  const result = await pending;
  assert.equal(result.status, 429); assert.equal(result.body.error.code, 'rate_limited'); assert.equal(result.headers.get('retry-after'), '60');
  assert.equal(spy.mock.callCount(), 0); assert.equal(f.store.snapshot().devices.length, 0);
  assert.deepEqual(f.store.snapshot().pendingPairing, code); assert.equal(f.store.snapshot().failedAttempts.length, 4096);
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Stream did not finish in time.')), 500); })]); }
  finally { clearTimeout(timer); }
}

test('two simultaneous HTTP redemptions return exactly one 201 and one pairing_invalid', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair();
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) };
  const results = await Promise.all([f.call('/v1/pair', init), f.call('/v1/pair', init)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 401]);
  assert.equal(results.find((result) => result.status === 401)!.body.error.code, 'pairing_invalid');
  assert.equal(f.store.snapshot().devices.length, 1);
});

test('pairing audit persistence failure sends 503 without a key and leaves consumed code recoverable', async (t) => {
  let fail = false;
  const io: StateIO = { ...fs, async open(...args) {
    if (fail && String(args[0]).endsWith('changes.jsonl') && (Number(args[1]) & constants.O_WRONLY)) throw new Error('private-fixture');
    return fs.open(...args);
  } };
  const f = await boot(t, io); const { payload } = await f.pairing.pair(); fail = true;
  const res = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) });
  assert.equal(res.status, 503); assert.equal(res.body.error.code, 'unavailable'); assert.ok(!JSON.stringify(res.body).includes('rly1_'));
  assert.equal(f.store.snapshot().pendingPairing, null); assert.equal(f.store.snapshot().devices.length, 1); assert.equal(f.store.snapshot().auditOutbox.length, 1);
  fail = false;
  const restored = await createDeviceStore({ directory: f.directory, now: () => 100_000 });
  assert.equal(restored.snapshot().pendingPairing, null); assert.equal(restored.snapshot().auditOutbox.length, 0);
});

test('pair HTTP exact schema, no-store, private routes and secret-free logs', async (t) => {
  const f = await boot(t);
  const { payload } = await f.pairing.pair();
  const invalid = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'invalid' }) });
  assert.equal(invalid.status, 401); assert.equal(invalid.body.error.code, 'pairing_invalid');
  assert.equal(invalid.headers.get('www-authenticate'), null); assert.equal(f.whoisCount(), 0);
  const success = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) });
  assert.equal(success.status, 201); assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(success.body).sort(), ['device', 'deviceKey', 'server']);
  assert.equal(success.body.device.name, 'phone'); assert.equal(success.body.device.revokedAt, null);
  assert.equal((await f.call('/v1/model', { headers: auth(success.body.deviceKey) })).status, 200);
  assert.equal((await f.call('/v1/pair')).body.error.code, 'key_unknown');
  assert.equal((await f.call('/v1/model', { headers: auth('legacy-shared-fixture') })).body.error.code, 'key_unknown');
  await f.call('/unknown/private-fixture?code=private-query', { headers: auth(success.body.deviceKey) });
  assert.ok(!f.logs.join('\n').includes(payload.code)); assert.ok(!f.logs.join('\n').includes(success.body.deviceKey));
  assert.ok(!f.logs.join('\n').includes('private-fixture')); assert.ok(!f.logs.join('\n').includes('private-query'));
  const unknown = await f.call(`/v1/agents/${success.body.deviceKey}/transcript`, { headers: auth(success.body.deviceKey) });
  assert.equal(unknown.status, 404); assert.ok(!JSON.stringify(unknown.body).includes(success.body.deviceKey));
});

test('pair HTTP bad bodies count failures; fifth mixed failure blocks before whois and ignores forwarding headers', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair();
  for (const body of ['{', JSON.stringify({ code: payload.code, name: 'client-name' }), 'x'.repeat(4097)]) {
    assert.equal((await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
  }
  assert.equal((await f.call('/v1/model')).status, 401);
  const fifth = await f.call('/v1/model', { headers: { 'X-Forwarded-For': '100.64.0.9' } });
  assert.equal(fifth.status, 429); assert.equal(fifth.headers.get('retry-after'), '300');
  const original = crypto.timingSafeEqual;
  const spy = t.mock.method(crypto, 'timingSafeEqual', original);
  const blocked = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.0.8' }, body: JSON.stringify({ code: payload.code }) });
  assert.equal(blocked.status, 429); assert.equal(f.whoisCount(), 0); assert.equal(spy.mock.callCount(), 0); assert.equal(f.hermes.calls.length, 0);
  assert.equal((await f.call('/health')).status, 200); assert.equal((await f.call('/v1/whoami')).status, 200);
  const preflight = await fetch(f.base + '/v1/model', { method: 'OPTIONS' }); assert.equal(preflight.status, 204);
  assert.equal((await f.call('/v1/model')).status, 429);
  f.setIp('100.64.0.2'); assert.equal((await f.pair()).device.name, 'phone');
  f.setIp('100.64.0.1'); f.setNow(400_000); assert.equal((await f.call('/v1/model')).status, 401);
});

test('tailnet and failed whois do not consume a code or count a secret failure; await whois rechecks expiry', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair();
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) };
  f.setIp('192.168.1.1'); assert.equal((await f.call('/v1/pair', init)).body.error.code, 'tailnet_required');
  assert.equal(f.whoisCount(), 0); assert.equal(f.store.snapshot().failedAttempts.length, 0);
  f.setIp('100.64.0.1'); f.setWhois(async () => null);
  assert.equal((await f.call('/v1/pair', init)).status, 503); assert.equal(f.store.snapshot().failedAttempts.length, 0);
  f.setWhois(async () => { f.setNow(400_000); return { device: 'phone', tailnet: 'example.ts.net' }; });
  assert.equal((await f.call('/v1/pair', init)).body.error.code, 'pairing_invalid');
  assert.equal(f.store.snapshot().devices.length, 0);
});

test('revocation rejects new GET POST SSE while another device remains authorized', async (t) => {
  const f = await boot(t); const first = await f.pair(); const second = await f.pair();
  await f.pairing.revoke(first.device.id);
  for (const [route, method] of [['/v1/model', 'GET'], ['/v1/agents/default/runs', 'POST'], ['/v1/runs/no-run/events', 'GET']]) {
    const res = await f.call(route, { method, headers: auth(first.deviceKey) });
    assert.equal(res.status, 403); assert.equal(res.body.error.code, 'device_revoked');
  }
  assert.equal(f.hermes.calls.length, 0);
  assert.equal((await f.call('/v1/model', { headers: auth(second.deviceKey) })).status, 200);
});

test('revocation closes open SSE without later frames and leaves the other stream alive', async (t) => {
  const f = await boot(t); const first = await f.pair(); const second = await f.pair();
  const run = await f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(first.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'hello' }) });
  const runId = run.body.runId;
  const a = await fetch(`${f.base}/v1/runs/${runId}/events`, { headers: auth(first.deviceKey) });
  const bAbort = new AbortController(); t.after(() => bAbort.abort());
  const b = await fetch(`${f.base}/v1/runs/${runId}/events`, { headers: auth(second.deviceKey), signal: bAbort.signal });
  const reader = a.body!.getReader(); await reader.read();
  await f.pairing.revoke(first.device.id);
  let tail = ''; let done = false;
  await eventually(async () => { const chunk = await bounded(reader.read()); done = chunk.done; tail += new TextDecoder().decode(chunk.value); assert.equal(done, true); });
  assert.ok(!tail.includes('data:'));
  f.hermes.stream(runId).push({ event: 'message.delta', seq: 0, delta: 'still alive' });
  const bReader = b.body!.getReader();
  let text = '';
  await eventually(async () => { const chunk = await bReader.read(); text += new TextDecoder().decode(chunk.value); assert.ok(text.includes('still alive')); });
});

test('A6 penalty closes only SSE streams belonging to the captured penalized IP', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  const run = await f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'fixture' }) });
  const first = await fetch(`${f.base}/v1/runs/${run.body.runId}/events`, { headers: auth(paired.deviceKey) });
  const reader = first.body!.getReader(); await bounded(reader.read());
  f.setIp('100.64.0.2'); const abort = new AbortController(); t.after(() => abort.abort());
  const other = await fetch(`${f.base}/v1/runs/${run.body.runId}/events`, { headers: auth(paired.deviceKey), signal: abort.signal });
  const otherReader = other.body!.getReader(); await bounded(otherReader.read());
  f.setIp('100.64.0.1'); const attempts = await penalize(f);
  await bounded((async () => {
    let end = await reader.read();
    while (!end.done) end = await reader.read();
    assert.equal(end.done, true);
  })());
  f.hermes.stream(run.body.runId).push({ event: 'message.delta', seq: 0, delta: 'allowed fixture' });
  let text = '';
  await eventually(async () => { const chunk = await bounded(otherReader.read()); text += new TextDecoder().decode(chunk.value); assert.ok(text.includes('allowed fixture')); });
  assert.deepEqual(f.store.snapshot().failedAttempts, attempts);
});

test('revocation during body read prevents dispatch and during an awaited private read suppresses its result', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  const target = new URL(f.base);
  const request = http.request({ hostname: target.hostname, port: target.port, path: '/v1/agents/default/runs', method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' } });
  const reply = new Promise<{ status: number; body: string }>((resolve, reject) => { request.on('error', reject); request.on('response', (res) => { let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body })); }); });
  request.write('{"input":');
  await eventually(() => assert.ok(f.hermes.callsTo('profiles').length > 0));
  await f.pairing.revoke(paired.device.id); request.end('"hello"}');
  const result = await reply; assert.equal(result.status, 403); assert.equal(f.hermes.callsTo('createRun').length, 0);
  const other = await f.pair(); let release!: () => void; let entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; }); t.after(release);
  t.mock.method(f.hermes, 'model', async () => { entered = true; await gate; return { model: 'private-result', provider: 'fake' }; });
  const pending = f.call('/v1/model', { headers: auth(other.deviceKey) });
  await eventually(() => assert.ok(entered)); await f.pairing.revoke(other.device.id); release();
  const res = await pending; assert.equal(res.status, 403); assert.ok(!JSON.stringify(res.body).includes('private-result'));
});

test('unexpected private errors and arbitrary paths cannot contaminate logs', async (t) => {
  const f = await boot(t); const paired = await f.pair();
  f.hermes.failWith.model = new Error('private-exception-fixture');
  assert.equal((await f.call('/v1/model', { headers: auth(paired.deviceKey) })).status, 500);
  assert.ok(!f.logs.join('\n').includes('private-exception-fixture'));
});

test('RELAY_KEY present in the environment grants no private HTTP access and is never imported into the store', async (t) => {
  const legacy = `rly1_${Buffer.alloc(32, 8).toString('base64url')}`; const previous = process.env.RELAY_KEY;
  process.env.RELAY_KEY = legacy;
  t.after(() => { if (previous === undefined) delete process.env.RELAY_KEY; else process.env.RELAY_KEY = previous; });
  const config = loadConfig({ RELAY_HOST: '100.64.0.1', RELAY_KEY: legacy }); assert.ok(!Object.hasOwn(config, 'key'));
  const f = await boot(t); assert.deepEqual(f.store.snapshot().devices, []);
  for (const route of ['/v1/model', '/v1/agents', '/v1/runs/unknown/events']) {
    const res = await f.call(route, { headers: auth(legacy) }); assert.equal(res.status, 401); assert.equal(res.body.error.code, 'key_unknown');
  }
  const paired = await f.pair(); assert.equal((await f.call('/v1/model', { headers: auth(paired.deviceKey) })).status, 200);
});

test('logger and errors exclude codes keys hashes and bodies across successful failed authenticated and unexpected requests', async (t) => {
  const f = await boot(t); const { payload } = await f.pairing.pair(); const codeHash = f.store.snapshot().pendingPairing!.codeHash;
  const invalidCode = 'ZZZZZZZZZZ'; const marker = 'synthetic-body-marker';
  const failed = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invalidCode }) });
  assert.equal(failed.status, 401);
  const body = JSON.stringify({ code: payload.code });
  const success = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); assert.equal(success.status, 201);
  const key = success.body.deviceKey; const keyHash = f.store.snapshot().devices[0].keyHash;
  const authenticated = await f.call('/v1/model', { headers: auth(key) }); assert.equal(authenticated.status, 200);
  f.hermes.failWith.model = new Error([payload.code, key, codeHash, keyHash, marker].join(' '));
  const unexpected = await f.call('/v1/model', { headers: auth(key) }); assert.equal(unexpected.status, 500);
  const malformed = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{${marker}` }); assert.equal(malformed.status, 400);
  await eventually(() => assert.ok(f.logs.filter(line => /POST|GET/.test(line)).length >= 5));
  const typedErrors: unknown[] = [];
  for (const code of ['bad_request', 'not_found', 'conflict', 'upstream', 'unavailable'] as const) {
    f.hermes.failWith.model = new HermesError(code, [payload.code, key, codeHash, keyHash, marker].join(' '));
    const result = await f.call('/v1/model', { headers: auth(key) }); assert.equal(result.status, HTTP_STATUS[code]); typedErrors.push(result.body);
  }
  const errors = JSON.stringify([failed.body, unexpected.body, malformed.body, ...typedErrors]);
  for (const secret of [payload.code, invalidCode, key, codeHash, keyHash, marker, body]) {
    assert.ok(!f.logs.join('\n').includes(secret), 'logger excludes every synthetic secret');
    assert.ok(!errors.includes(secret), 'errors exclude every synthetic secret');
  }
});

test('state and every atomic temporary contain hashes but never plaintext pairing codes or device keys', async (t) => {
  const snapshots: string[] = [];
  const io: StateIO = { ...fs, async rename(...args) { snapshots.push(await fs.readFile(args[0], 'utf8')); await fs.rename(...args); } };
  const f = await boot(t, io); const { payload } = await f.pairing.pair();
  const paired = await f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: payload.code }) });
  await f.pairing.revoke(paired.body.device.id);
  snapshots.push(await fs.readFile(path.join(f.directory, 'devices.json'), 'utf8'), await fs.readFile(path.join(f.directory, 'changes.jsonl'), 'utf8'));
  assert.ok(snapshots.length > 4);
  for (const snapshot of snapshots) { assert.ok(!snapshot.includes(payload.code)); assert.ok(!snapshot.includes(paired.body.deviceKey)); }
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['changes.jsonl', 'devices.json']);
});

test('HTTP nonexistent replaced expired and consumed codes return exactly the same error without a bearer challenge', async (t) => {
  const f = await boot(t);
  const redeem = (code: string) => f.call('/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const missing = await redeem('0000000000');
  const first = await f.pairing.pair(); const second = await f.pairing.pair();
  const replaced = await redeem(first.payload.code);
  f.setNow(second.expiresAt); const expired = await redeem(second.payload.code);
  const third = await f.pairing.pair(); assert.equal((await redeem(third.payload.code)).status, 201);
  const used = await redeem(third.payload.code);
  for (const result of [missing, replaced, expired, used]) {
    assert.equal(result.status, 401); assert.equal(result.body.error.code, 'pairing_invalid'); assert.deepEqual(result.body, missing.body);
    assert.equal(result.headers.get('www-authenticate'), null);
  }
});

test('malformed request targets fail statically without uncaught URL errors or secret logging', async (t) => {
  const f = await boot(t); const target = new URL(f.base); const marker = 'synthetic-private-url';
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, path: `//[${marker}?code=${marker}` }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.setTimeout(500, () => request.destroy(new Error('Request timeout.'))); request.on('error', reject); request.end();
  });
  assert.equal(result.status, 400); assert.equal(JSON.parse(result.body).error.code, 'bad_request');
  assert.ok(!result.body.includes(marker)); await eventually(() => assert.ok(f.logs.some(line => line.includes('unmatched 400'))));
  assert.ok(!f.logs.join('\n').includes(marker)); assert.equal(f.hermes.calls.length, 0);
});


test('#42 revocation while the durable approval attempt is being prepared prevents upstream effect', async(t)=>{
 let blocked=false;let entered=false;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const io:StateIO={...fs,async rename(from,to){if(blocked && String(to).endsWith('/decisions.json')){entered=true;await gate;}return fs.rename(from,to);}};
 const f=await boot(t,undefined,io);const paired=await f.pair();
 const run=await f.call('/v1/agents/default/runs',{method:'POST',headers:{...auth(paired.deviceKey),'Content-Type':'application/json'},body:JSON.stringify({input:'fixture'})});
 f.hermes.stream(run.body.runId).push({event:'approval.request',seq:0,command:'synthetic command',request_id:'fixture-approval',timestamp:Date.now()/1000,choices:['once','deny']});
 await eventually(()=>assert.equal(f.runs.approvals().length,1));
 blocked=true;
 const pending=f.call('/v1/approvals/fixture-approval',{method:'POST',headers:{...auth(paired.deviceKey),'Content-Type':'application/json'},body:JSON.stringify({choice:'once'})});
 await eventually(()=>assert.ok(entered));await f.pairing.revoke(paired.device.id);blocked=false;release();
 const response=await pending;assert.equal(response.status,403);assert.equal(response.body.error.code,'device_revoked');assert.equal(f.hermes.callsTo('resolveApproval').length,0);
});

test('#42 failed durable preparation prevents any upstream decision and exposes only a static error',async(t)=>{
 let fail=false;const io:StateIO={...fs,async open(file,...args){if(fail && String(file).includes('/.decisions.'))throw new Error('synthetic-sensitive-payload');return fs.open(file,...args);}};
 const f=await boot(t,undefined,io);const paired=await f.pair();const run=await f.call('/v1/agents/default/runs',{method:'POST',headers:{...auth(paired.deviceKey),'Content-Type':'application/json'},body:JSON.stringify({input:'fixture'})});
 f.hermes.stream(run.body.runId).push({event:'approval.request',seq:0,command:'synthetic command',request_id:'fixture-approval',timestamp:Date.now()/1000,choices:['once','deny']});await eventually(()=>assert.equal(f.runs.approvals().length,1));
 fail=true;const response=await f.call('/v1/approvals/fixture-approval',{method:'POST',headers:{...auth(paired.deviceKey),'Content-Type':'application/json'},body:JSON.stringify({choice:'once'})});
 assert.equal(response.status,503);assert.equal(response.body.error.code,'decision_store_unavailable');assert.equal(f.hermes.callsTo('resolveApproval').length,0);assert.deepEqual(await f.runs.decisionHistory(),[]);assert.doesNotMatch(JSON.stringify(response.body)+f.logs.join('\n'),/synthetic-sensitive-payload/);
});

test('#42 a lost HTTP answer can be retried as a durable ACK without repeating the upstream decision', async t => {
  const f = await boot(t, undefined, fs); const paired = await f.pair();
  const run = await f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'synthetic' }) });
  f.hermes.stream(run.body.runId).push({ event: 'approval.request', seq: 0, command: 'echo synthetic', request_id: 'lost-answer', timestamp: Date.now() / 1000, choices: ['once', 'deny'] });
  await eventually(() => assert.equal(f.runs.approvals().length, 1));
  const original = f.hermes.resolveApproval.bind(f.hermes); let release!: () => void;
  f.hermes.resolveApproval = async (...args) => { await original(...args); await new Promise<void>(resolve => { release = resolve; }); };
  const first = http.request(new URL(f.base + '/v1/approvals/lost-answer'), { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' } });
  first.on('error', () => {}); t.after(() => first.destroy());
  first.end(JSON.stringify({ choice: 'once' }));
  await eventually(() => assert.equal(f.hermes.callsTo('resolveApproval').length, 1));
  first.destroy(); release();
  await eventually(async () => assert.equal((await f.runs.decisionHistory()).length, 1));
  const post = (choice: string) => f.call('/v1/approvals/lost-answer', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
  assert.equal((await post('once')).status, 200);
  const conflict = await post('deny'); assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'conflict');
  assert.equal(f.hermes.callsTo('resolveApproval').length, 1);
  const ledger = await createDecisionStore({ directory: f.directory });
  assert.equal(ledger.list()[0].choice, 'once'); assert.deepEqual(ledger.pending(), []);
});

test('#42 revocation during ledger readiness prevents a persisted replay ACK', async t => {
  let blocked = false; let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const io: StateIO = { ...fs, async rename(from, to) { if (blocked && String(to).endsWith('/decisions.json')) { entered = true; await gate; } return fs.rename(from, to); } };
  const f = await boot(t, undefined, io); const paired = await f.pair();
  const start = () => f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'synthetic' }) });
  const request = (id: string) => ({ event: 'approval.request', seq: 0, command: 'echo synthetic', request_id: id, timestamp: Date.now() / 1000, choices: ['once', 'deny'] });
  const post = (id: string) => f.call(`/v1/approvals/${id}`, { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'once' }) });
  const first = await start(); f.hermes.stream(first.body.runId).push(request('confirmed'));
  await eventually(() => assert.equal(f.runs.approvals().length, 1)); assert.equal((await post('confirmed')).status, 200);
  const second = await start(); f.hermes.stream(second.body.runId).push(request('preparing'));
  await eventually(() => assert.equal(f.runs.approvals().length, 1));
  blocked = true; const prepare = post('preparing'); await eventually(() => assert.ok(entered));
  // runs.decide() captures its approval and parks on the ledger before its first await returns control here.
  const waiting = Promise.withResolvers<void>(); const decide = f.runs.decide;
  t.mock.method(f.runs, 'decide', function (this: RunManager, ...args: Parameters<RunManager['decide']>) {
    const result = decide.apply(this, args); if (args[0] === 'confirmed') waiting.resolve(); return result;
  });
  let replayFinished = false; const replay = post('confirmed').then(result => { replayFinished = true; return result; });
  await waiting.promise; assert.equal(replayFinished, false);
  await f.pairing.revoke(paired.device.id); blocked = false; release();
  const result = await replay; assert.equal(result.status, 403); assert.equal(result.body.error.code, 'device_revoked');
  assert.equal((await prepare).status, 403); assert.equal(f.hermes.callsTo('resolveApproval').length, 1);
});


test('#42 a reused approval id returns HTTP conflict without deciding or removing the new Turn', async t => {
  const f = await boot(t, undefined, fs); const paired = await f.pair();
  const start = () => f.call('/v1/agents/default/runs', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'synthetic' }) });
  const post = (choice: string) => f.call('/v1/approvals/reused-id', { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
  const request = (command: string) => ({ event: 'approval.request', seq: 0, command, request_id: 'reused-id', timestamp: Date.now() / 1000, choices: ['once', 'deny'] });
  const first = await start(); f.hermes.stream(first.body.runId).push(request('echo old'));
  await eventually(() => assert.equal(f.runs.approvals().length, 1));
  assert.equal((await post('once')).status, 200);
  f.hermes.stream(first.body.runId).push({ event: 'run.completed', seq: 1 });
  await eventually(() => assert.equal(f.runs.snapshot(first.body.runId).phase, 'completed'));
  const second = await start(); f.hermes.stream(second.body.runId).push(request('echo new'));
  await eventually(() => assert.equal(f.runs.approvals()[0]?.runId, second.body.runId));
  for (const choice of ['once', 'deny']) {
    const response = await post(choice);
    assert.equal(response.status, 409); assert.equal(response.body.error.code, 'conflict');
    assert.equal(f.hermes.callsTo('resolveApproval').length, 1);
    assert.deepEqual(f.runs.approvals().map(approval => [approval.id, approval.runId, approval.command]), [['reused-id', second.body.runId, 'echo new']]);
  }
  const ledger = await createDecisionStore({ directory: f.directory });
  assert.deepEqual(ledger.list().map(record => [record.runId, record.choice]), [[first.body.runId, 'once']]);
  assert.deepEqual(ledger.pending(), []);
});


for (const initial of ['active', 'absent'] as const) {
  test(`#42 HTTP ${initial} approval snapshot during ledger readiness cannot decide a new Agent`, async t => {
    let blocked = false; let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const io: StateIO = { ...fs, async rename(from, to) {
      if (blocked && String(to).endsWith('/decisions.json')) { blocked = false; entered = true; await gate; }
      return fs.rename(from, to);
    } };
    const f = await boot(t, undefined, io); const paired = await f.pair();
    const start = (agentId: string) => f.call(`/v1/agents/${agentId}/runs`, { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'synthetic' }) });
    const post = (id: string) => f.call(`/v1/approvals/${id}`, { method: 'POST', headers: { ...auth(paired.deviceKey), 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'once' }) });
    const request = (id: string, command: string) => ({ event: 'approval.request', seq: 0, request_id: id, timestamp: Date.now() / 1000, choices: ['once', 'deny'], command });
    const old = await start('default'); const newer = await start('coding'); const unrelated = await start('default');
    if (initial === 'active') {
      f.hermes.stream(old.body.runId).push(request('snapshot-id', 'echo old'));
      await eventually(() => assert.equal(f.runs.approvals()[0]?.runId, old.body.runId));
    }
    f.hermes.stream(unrelated.body.runId).push(request('unrelated', 'echo unrelated'));
    await eventually(() => assert.ok(f.runs.approvals().some(approval => approval.id === 'unrelated')));
    blocked = true; const preparing = post('unrelated');
    await eventually(() => assert.ok(entered));
    // runs.decide() captures its approval and parks on the ledger before its first await returns control here.
    const waiting = Promise.withResolvers<void>(); const decide = f.runs.decide;
    t.mock.method(f.runs, 'decide', function (this: RunManager, ...args: Parameters<RunManager['decide']>) {
      const result = decide.apply(this, args); if (args[0] === 'snapshot-id') waiting.resolve(); return result;
    });
    let finished = false;
    const deciding = post('snapshot-id').then(response => { finished = true; return response; });
    await waiting.promise; assert.equal(finished, false);
    if (initial === 'active') {
      f.hermes.stream(old.body.runId).push({ event: 'run.completed', seq: 1 });
      await eventually(() => assert.equal(f.runs.snapshot(old.body.runId).phase, 'completed'));
    }
    f.hermes.stream(newer.body.runId).push(request('snapshot-id', 'echo new'));
    await eventually(() => assert.ok(f.runs.approvals().some(approval => approval.id === 'snapshot-id' && approval.runId === newer.body.runId)));
    release();
    const response = await deciding; assert.equal(response.status, 409); assert.equal(response.body.error.code, 'conflict');
    assert.equal((await preparing).status, 200);
    assert.deepEqual(f.hermes.callsTo('resolveApproval').map(call => call.args), [['default', unrelated.body.runId, 'once', 'unrelated']]);
    assert.deepEqual(f.runs.approvals().map(approval => [approval.agentId, approval.runId, approval.command]), [['coding', newer.body.runId, 'echo new']]);
    const ledger = await createDecisionStore({ directory: f.directory });
    assert.deepEqual(ledger.list().map(record => record.approvalId), ['unrelated']); assert.deepEqual(ledger.pending(), []);
  });
}
