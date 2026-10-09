import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { createDeviceStore } from '../src/deviceStore.ts';
import { StateError } from '../src/changeLog.ts';
import type { StateIO } from '../src/changeLog.ts';

const NOW = 1_791_000_000_000;
const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-000000000002';

const DEVICE = { id: DEVICE_ID, name: 'test-phone', keyHash: 'a'.repeat(64), pairedAt: NOW, revokedAt: null };
const RECORD = {
  id: EVENT_ID, at: '2026-10-03T04:00:00.000Z', actor: { kind: 'server' as const }, action: 'device.revoked',
  target: { kind: 'device' as const, id: DEVICE_ID },
};

function revokedState() {
  return { schemaVersion: 1, devices: [{ ...DEVICE, revokedAt: NOW }], pendingPairing: null, failedAttempts: [], auditOutbox: [RECORD] };
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-device-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'devices.json'), logFile: path.join(directory, 'changes.jsonl') };
}

test('a new store initializes only in the injected directory with the exact private state shape', async (t) => {
  const { directory, file, logFile } = await fixture(t);
  const store = await createDeviceStore({ directory, now: () => NOW, newId: () => EVENT_ID });
  const initial = { schemaVersion: 1, devices: [], pendingPairing: null, failedAttempts: [], auditOutbox: [] };
  assert.deepEqual(store.snapshot(), initial);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), initial);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(logFile, 'utf8'), '');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['changes.jsonl', 'devices.json']);
});

test('private state rejects broad permissions, symbolic links, directories and foreign ownership', async (t) => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, JSON.stringify(revokedState()), { mode: 0o644 });
  await assert.rejects(createDeviceStore({ directory }), /repair them to 0600/);
  await fs.unlink(file);
  const target = path.join(directory, 'target');
  const bytes = JSON.stringify(revokedState());
  await fs.writeFile(target, bytes, { mode: 0o600 });
  await fs.symlink(target, file);
  await assert.rejects(createDeviceStore({ directory }), StateError);
  assert.equal(await fs.readFile(target, 'utf8'), bytes);
  await fs.unlink(file);
  await fs.mkdir(file);
  await assert.rejects(createDeviceStore({ directory }), StateError);
  await fs.rmdir(file);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const io: StateIO = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      if (String(args[0]) === file) {
        const original = handle.stat.bind(handle);
        t.mock.method(handle, 'stat', async () => Object.assign(await original(), { uid: (process.getuid?.() ?? 0) + 1 }));
      }
      return handle;
    },
  };
  await assert.rejects(createDeviceStore({ directory, io }), StateError);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('symlinked and foreign-owned state directories are rejected before creating files', async (t) => {
  const { directory } = await fixture(t);
  const linked = `${directory}-link`;
  t.after(() => fs.unlink(linked));
  await fs.symlink(directory, linked);
  await assert.rejects(createDeviceStore({ directory: linked }), StateError);
  const io: StateIO = {
    ...fs,
    lstat: (async (file) => {
      const stat = await fs.lstat(file);
      return Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 });
    }) as StateIO['lstat'],
  };
  await assert.rejects(createDeviceStore({ directory, io }), StateError);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('mutation audit inputs cannot override the server timestamp or identity', async (t) => {
  const { directory, file } = await fixture(t);
  const store = await createDeviceStore({ directory, now: () => NOW, newId: () => EVENT_ID });
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.mutate((_state, transaction) => {
    const tainted = { ...RECORD, at: '2020-01-01T00:00:00.000Z' };
    transaction.addChange(tainted);
  }), StateError);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('an existing state that becomes unreadable is never treated as a new installation', async (t) => {
  const { directory, file } = await fixture(t);
  const bytes = JSON.stringify(revokedState());
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const io: StateIO = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      if (String(args[0]) === file) t.mock.method(handle, 'readFile', async () => { throw Object.assign(new Error('private-fixture'), { code: 'ENOENT' }); });
      return handle;
    },
  };
  await assert.rejects(createDeviceStore({ directory, io }), StateError);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('invalid UTF-8 state is rejected instead of replacing corrupted device names', async (t) => {
  const { directory, file } = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(revokedState()).replace('test-phone', 'x'));
  bytes[bytes.indexOf(Buffer.from('"name":"x"')) + 8] = 0xff;
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await assert.rejects(createDeviceStore({ directory }), StateError);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('no snapshot is published before the atomic file and directory commit completes', async (t) => {
  const { directory } = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  let pause = false;
  const io: StateIO = {
    ...fs,
    async rename(...args) {
      await fs.rename(...args);
      if (pause) { entered(); await pending; }
    },
  };
  const store = await createDeviceStore({ directory, io });
  pause = true;
  const operation = store.mutate((state) => { state.devices.push({ ...DEVICE }); });
  await started;
  assert.equal(store.snapshot().devices.length, 0);
  release();
  await operation;
  assert.equal(store.snapshot().devices.length, 1);
});

test('outbox recovery completes durable revocation and consumes no extra audit ID', async (t) => {
  const { directory, file, logFile } = await fixture(t);
  await fs.writeFile(file, JSON.stringify(revokedState()), { mode: 0o600 });
  const store = await createDeviceStore({ directory, now: () => NOW, newId: () => { throw new Error('No new identity on recovery'); } });
  assert.equal(store.snapshot().devices[0].revokedAt, NOW);
  assert.equal(store.snapshot().pendingPairing, null);
  assert.deepEqual(store.snapshot().auditOutbox, []);
  assert.equal(await fs.readFile(logFile, 'utf8'), `${JSON.stringify(RECORD)}\n`);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).auditOutbox, []);
});

test('crash after audit append and before clearing outbox does not duplicate the record on restart', async (t) => {
  const { directory, file, logFile } = await fixture(t);
  await fs.writeFile(file, JSON.stringify(revokedState()), { mode: 0o600 });
  const line = `${JSON.stringify(RECORD)}\n`;
  await fs.writeFile(logFile, line, { mode: 0o600 });
  const store = await createDeviceStore({ directory, now: () => NOW });
  assert.deepEqual(store.snapshot().auditOutbox, []);
  assert.equal(await fs.readFile(logFile, 'utf8'), line);
});

test('an audit append failure preserves committed revocation and outbox for restart recovery', async (t) => {
  const { directory, file, logFile } = await fixture(t);
  let failAppend = false;
  const io: StateIO = {
    ...fs,
    async open(...args) {
      if (failAppend && String(args[0]) === logFile && (Number(args[1]) & constants.O_WRONLY)) throw new Error('private-fixture');
      return fs.open(...args);
    },
  };
  const store = await createDeviceStore({ directory, now: () => NOW, newId: () => EVENT_ID, io });
  await store.mutate((state) => { state.devices.push({ ...DEVICE }); });
  failAppend = true;
  await assert.rejects(store.mutate((state, transaction) => {
    state.devices[0].revokedAt = transaction.now;
    transaction.addChange({ actor: { kind: 'server' }, action: 'device.revoked', target: { kind: 'device', id: DEVICE_ID } });
  }), StateError);
  assert.equal(store.snapshot().devices[0].revokedAt, NOW);
  assert.deepEqual(store.snapshot().auditOutbox, [RECORD]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).auditOutbox, [RECORD]);
  assert.equal(await fs.readFile(logFile, 'utf8'), '');
  const restored = await createDeviceStore({ directory, now: () => NOW });
  assert.deepEqual(restored.snapshot().auditOutbox, []);
  assert.equal(restored.snapshot().devices[0].revokedAt, NOW);
  assert.equal(await fs.readFile(logFile, 'utf8'), `${JSON.stringify(RECORD)}\n`);
});

test('failure before rename preserves pending pairing and cleans its private temporary file', async (t) => {
  const { directory, file } = await fixture(t);
  let failSync = false;
  const io: StateIO = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      if (failSync && String(args[0]).endsWith('.tmp')) t.mock.method(handle, 'sync', async () => { throw new Error('private-fixture'); });
      return handle;
    },
  };
  const store = await createDeviceStore({ directory, now: () => NOW, io });
  await store.mutate((state) => { state.pendingPairing = { codeHash: 'b'.repeat(64), createdAt: NOW, expiresAt: NOW + 300_000 }; });
  const before = await fs.readFile(file, 'utf8');
  failSync = true;
  await assert.rejects(store.mutate((state) => { state.pendingPairing = null; }), StateError);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(store.snapshot().pendingPairing?.expiresAt, NOW + 300_000);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['changes.jsonl', 'devices.json']);
  failSync = false;
  await store.mutate((state) => { state.pendingPairing = null; });
  assert.equal(store.snapshot().pendingPairing, null);
});

test('uncertain directory fsync after rename fails closed and recovers consumed pairing from disk', async (t) => {
  const { directory } = await fixture(t);
  let failSync = false;
  let fatalCalls = 0;
  const io: StateIO = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      if (failSync && String(args[0]) === directory) t.mock.method(handle, 'sync', async () => { throw new Error('private-fixture'); });
      return handle;
    },
  };
  const store = await createDeviceStore({ directory, now: () => NOW, io, onFatal: () => { fatalCalls++; } });
  await store.mutate((state) => { state.pendingPairing = { codeHash: 'b'.repeat(64), createdAt: NOW, expiresAt: NOW + 300_000 }; });
  failSync = true;
  await assert.rejects(store.mutate((state) => { state.pendingPairing = null; }), StateError);
  assert.equal(fatalCalls, 1);
  assert.throws(() => store.snapshot(), /recover from disk/);
  await assert.rejects(store.mutate(() => {}), StateError);
  const restored = await createDeviceStore({ directory, now: () => NOW });
  assert.equal(restored.snapshot().pendingPairing, null);
});

test('restart preserves the original pairing expiry and purges only expired failure entries', async (t) => {
  const { directory } = await fixture(t);
  const store = await createDeviceStore({ directory, now: () => NOW });
  await store.mutate((state) => {
    state.pendingPairing = { codeHash: 'b'.repeat(64), createdAt: NOW, expiresAt: NOW + 300_000 };
    state.failedAttempts = [
      { ip: '100.64.0.1', failures: [NOW], blockedUntil: null },
      { ip: '100.64.0.2', failures: [NOW], blockedUntil: NOW + 300_000 },
    ];
  });
  const beforeBoundary = await createDeviceStore({ directory, now: () => NOW + 59_999 });
  assert.equal(beforeBoundary.snapshot().failedAttempts.length, 2);
  const boundary = await createDeviceStore({ directory, now: () => NOW + 60_000 });
  assert.deepEqual(boundary.snapshot().failedAttempts.map((entry) => entry.ip), ['100.64.0.2']);
  assert.equal(boundary.snapshot().pendingPairing?.expiresAt, NOW + 300_000);
  const penaltyBoundary = await createDeviceStore({ directory, now: () => NOW + 300_000 });
  assert.deepEqual(penaltyBoundary.snapshot().failedAttempts, []);
  assert.equal(penaltyBoundary.snapshot().pendingPairing?.expiresAt, NOW + 300_000);
});

test('corrupt JSON or any invalid state field fails closed without rewriting the file', async (t) => {
  const { directory, file, logFile } = await fixture(t);
  const valid = {
    schemaVersion: 1, pendingPairing: null, failedAttempts: [], auditOutbox: [],
    devices: [{ id: DEVICE_ID, name: 'test-phone', keyHash: 'a'.repeat(64), pairedAt: NOW, revokedAt: null }],
  };
  const device = valid.devices[0];
  for (const value of [
    'invalid-private-fixture',
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, arbitrary: 'private-fixture' }),
    JSON.stringify({ ...valid, devices: [device, device] }),
    JSON.stringify({ ...valid, devices: [device, { ...device, id: EVENT_ID }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, keyHash: 'A'.repeat(64) }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, name: 'n'.repeat(256) }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, name: '' }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, id: 'not-a-uuid' }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, pairedAt: NOW + 0.5 }] }),
    JSON.stringify({ ...valid, devices: [{ ...device, revokedAt: NOW - 1 }] }),
    JSON.stringify({ ...valid, pendingPairing: { codeHash: 'b'.repeat(64), createdAt: NOW, expiresAt: NOW + 300_001 } }),
    JSON.stringify({ ...valid, failedAttempts: [{ ip: 'not-an-ip', failures: [NOW], blockedUntil: null }] }),
    JSON.stringify({ ...valid, auditOutbox: [{ id: EVENT_ID }] }),
  ]) {
    await fs.writeFile(file, value, { mode: 0o600 });
    await assert.rejects(createDeviceStore({ directory }), (error: Error) => error instanceof StateError && !error.message.includes('private-fixture'));
    assert.equal(await fs.readFile(file, 'utf8'), value);
    await assert.rejects(fs.stat(logFile), { code: 'ENOENT' });
  }
});

test('invalid queued mutations reject without changing the durable snapshot', async (t) => {
  const { directory, file } = await fixture(t);
  const store = await createDeviceStore({ directory });
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.mutate((draft) => { draft.pendingPairing = { codeHash: 'cleartext', createdAt: NOW, expiresAt: NOW + 300_000 }; }), StateError);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(store.snapshot().pendingPairing, null);
});

test('queued mutations persist before publishing and snapshots cannot mutate the live state', async (t) => {
  const { directory } = await fixture(t);
  const store = await createDeviceStore({ directory, now: () => NOW, newId: () => EVENT_ID });
  const device = { id: DEVICE_ID, name: 'test-phone', keyHash: 'a'.repeat(64), pairedAt: NOW, revokedAt: null };
  const writes = await Promise.all([
    store.mutate((state) => { state.devices.push(device); return state.devices.length; }),
    store.mutate((state) => { state.devices[0].revokedAt = NOW + 1; return state.devices.length; }),
  ]);
  assert.deepEqual(writes, [1, 1]);
  const copy = store.snapshot();
  copy.devices.length = 0;
  device.name = 'changed-outside-queue';
  assert.equal(store.snapshot().devices[0].name, 'test-phone');
  assert.equal(store.snapshot().devices[0].revokedAt, NOW + 1);
  const reopened = await createDeviceStore({ directory, now: () => NOW, newId: () => EVENT_ID });
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});
