import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBearer, createAuthLimiter, guardAuthorization, hashDeviceKey, normalizePeerIp } from '../src/auth.ts';
import type { DeviceState } from '../src/deviceStore.ts';
import { createDeviceStore } from '../src/deviceStore.ts';

const KEY = `rly1_${Buffer.alloc(32, 1).toString('base64url')}`;
const ID = '00000000-0000-4000-8000-000000000001';
const devices = () => [{ id: ID, name: 'test-phone', pairedAt: 1000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }];

test('device hash matches independent SHA-256 fixture with domain separation and a NUL byte', () => {
  assert.equal(hashDeviceKey(KEY).toString('hex'), 'f3e94219fae386945590c54e69d7872d21b8756b5942cdfbd39b49b0249bdc8e');
});

test('device bearer accepts only exact registered keys and distinguishes tombstones', () => {
  assert.deepEqual(checkBearer(`bearer ${KEY}`, devices()), { ok: true, deviceId: ID, deviceName: 'test-phone' });
  for (const header of [undefined, '', 'Bearer ', KEY, `Basic ${KEY}`, `Bearer ${KEY.slice(0, -1)}`, `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}A`]) {
    assert.deepEqual(checkBearer(header, devices()), { ok: false, code: 'key_unknown' });
  }
  const revoked = devices().map((device) => ({ ...device, revokedAt: 1001 }));
  assert.deepEqual(checkBearer(`Bearer ${KEY}`, revoked), { ok: false, code: 'device_revoked' });
});

test('real timingSafeEqual sees 32-byte buffers for every record, invalid input and an empty store', (t) => {
  const original = crypto.timingSafeEqual;
  const spy = t.mock.method(crypto, 'timingSafeEqual', (a: Buffer, b: Buffer) => {
    assert.ok(Buffer.isBuffer(a) && Buffer.isBuffer(b));
    assert.equal(a.length, 32); assert.equal(b.length, 32);
    return original(a, b);
  });
  const records = [...devices(), { ...devices()[0], id: '00000000-0000-4000-8000-000000000002', keyHash: 'b'.repeat(64), revokedAt: 1001 }];
  checkBearer(`Bearer ${KEY}`, records);
  assert.equal(spy.mock.callCount(), 2);
  checkBearer('Basic malformed', records);
  assert.equal(spy.mock.callCount(), 4);
  checkBearer(undefined, []);
  assert.equal(spy.mock.callCount(), 5);
  t.mock.method(crypto, 'timingSafeEqual', () => false);
  assert.deepEqual(checkBearer(`Bearer ${KEY}`, records), { ok: false, code: 'key_unknown' });
});

test('peer normalization uses the socket address, including mapped IPv4 and canonical IPv6', () => {
  assert.equal(normalizePeerIp('::ffff:100.64.0.1'), '100.64.0.1');
  assert.equal(normalizePeerIp('0:0:0:0:0:FFFF:6440:1'), '100.64.0.1');
  assert.equal(normalizePeerIp('FD7A:115C:A1E0:0:0:0:0:1'), 'fd7a:115c:a1e0::1');
  assert.equal(normalizePeerIp('invalid'), null);
});

test('limiter fifth failure and exact penalty duration persist, without extending blocked traffic', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 100_000;
  const store = await createDeviceStore({ directory, now: () => now });
  const limiter = createAuthLimiter(store);
  for (let i = 0; i < 4; i++) assert.equal((await limiter.failure('100.64.0.1')).blocked, false);
  assert.deepEqual(await limiter.failure('100.64.0.1'), { blocked: true, retryAfter: 300 });
  now += 1;
  assert.deepEqual(await limiter.check('100.64.0.1'), { blocked: true, retryAfter: 300 });
  await limiter.success('100.64.0.1');
  await limiter.failure('100.64.0.1');
  assert.equal(store.snapshot().failedAttempts[0].blockedUntil, 400_000);
  assert.equal((await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const restored = createAuthLimiter(await createDeviceStore({ directory, now: () => now }));
  now = 399_999;
  assert.deepEqual(await restored.check('100.64.0.1'), { blocked: true, retryAfter: 1 });
  now = 400_000;
  assert.deepEqual(await restored.check('100.64.0.1'), { blocked: false, retryAfter: 0 });
});

test('limiter rolling window and success affect only that IP; saturation never evicts active blocks', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 100_000;
  const store = await createDeviceStore({ directory, now: () => now });
  const limiter = createAuthLimiter(store);
  await limiter.failure('100.64.0.1'); await limiter.failure('100.64.0.2');
  await limiter.success('100.64.0.1');
  assert.deepEqual(store.snapshot().failedAttempts.map((entry) => entry.ip), ['100.64.0.2']);
  now += 60_000;
  await limiter.failure('100.64.0.2');
  assert.deepEqual(store.snapshot().failedAttempts[0].failures, [now]);
  await store.mutate((state) => {
    state.failedAttempts = Array.from({ length: 4096 }, (_, i) => ({ ip: `100.64.${Math.floor(i / 256)}.${i % 256}`, failures: [now], blockedUntil: now + 300_000 }));
  });
  assert.deepEqual(await limiter.check('100.100.0.1'), { blocked: true, retryAfter: 60 });
  assert.equal(store.snapshot().failedAttempts.length, 4096);
  assert.equal((await limiter.check('100.64.0.1')).retryAfter, 300);
});

test('A6 snapshot guard uses exact penalty and rolling-window expiry without mutating failures', () => {
  const state: DeviceState = { schemaVersion: 1, devices: devices(), pendingPairing: null, failedAttempts: [
    { ip: '100.64.0.1', failures: [100_000], blockedUntil: 400_000 },
  ], auditOutbox: [] };
  const before = structuredClone(state);
  assert.throws(() => guardAuthorization(state, { ip: '100.64.0.1', deviceId: ID }, 399_999), { code: 'rate_limited', retryAfter: 1 });
  assert.doesNotThrow(() => guardAuthorization(state, { ip: '100.64.0.1', deviceId: ID }, 400_000));
  assert.deepEqual(state, before);
  state.failedAttempts = Array.from({ length: 4096 }, (_, i) => ({ ip: `100.65.${i >>> 8}.${i & 255}`, failures: [100_000], blockedUntil: null }));
  const saturated = structuredClone(state);
  assert.throws(() => guardAuthorization(state, { ip: '100.64.0.1', deviceId: ID }, 159_999), { code: 'rate_limited', retryAfter: 60 });
  assert.doesNotThrow(() => guardAuthorization(state, { ip: '100.65.0.0', deviceId: ID }, 159_999));
  assert.doesNotThrow(() => guardAuthorization(state, { ip: '100.64.0.1', deviceId: ID }, 160_000));
  assert.deepEqual(state, saturated);
  state.devices[0].revokedAt = 160_000;
  assert.throws(() => guardAuthorization(state, { ip: '100.64.0.1', deviceId: ID }, 160_000), { code: 'device_revoked' });
});
