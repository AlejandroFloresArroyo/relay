import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createChangeLog, makeChangeRecord, StateError } from '../src/changeLog.ts';
import type { StateIO } from '../src/changeLog.ts';

const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const DEVICE_ID = '00000000-0000-4000-8000-000000000002';
const NOW = 1_791_000_000_000;

test('appendChange returns a server-stamped record and persists one compact private JSONL line', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const log = createChangeLog({ file, now: () => NOW, newId: () => EVENT_ID });
  const input = { actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID } };
  const record = await log.appendChange(input);
  assert.deepEqual(record, { id: EVENT_ID, at: '2026-10-03T04:00:00.000Z', ...input });
  assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify(record)}\n`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('append failure after writing a complete line retries durably without losing or duplicating its event', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  let failSync = true;
  const io: StateIO = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      if (failSync && String(args[0]) === file && (Number(args[1]) & constants.O_WRONLY)) {
        t.mock.method(handle, 'sync', async () => { throw new Error('private-fixture'); });
      }
      return handle;
    },
  };
  const log = createChangeLog({ file, io, now: () => NOW, newId: () => EVENT_ID });
  const input = { actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID } };
  await assert.rejects(log.appendChange(input), StateError);
  const record = { id: EVENT_ID, at: '2026-10-03T04:00:00.000Z', ...input };
  failSync = false;
  await log.appendCommitted(record);
  await createChangeLog({ file }).appendCommitted(record);
  assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify(record)}\n`);
});

test('stage-one audit records contain only paired identity, revocation or penalty metadata', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const ids = [EVENT_ID, '00000000-0000-4000-8000-000000000003'];
  const log = createChangeLog({ file, now: () => NOW, newId: () => ids.shift()! });
  const paired = await log.appendChange({ actor: { kind: 'device', id: DEVICE_ID, name: 'test-phone' }, action: 'device.paired', target: { kind: 'device', id: DEVICE_ID } });
  const limited = await log.appendChange({ actor: { kind: 'server' }, action: 'auth.rate_limited', target: { kind: 'ip', id: '100.64.0.1' }, details: { blockedUntil: NOW + 300_000 } });
  assert.equal(await fs.readFile(file, 'utf8'), `${JSON.stringify(paired)}\n${JSON.stringify(limited)}\n`);
  assert.deepEqual(Object.keys(paired).sort(), ['action', 'actor', 'at', 'id', 'target']);
  assert.deepEqual(limited.details, { blockedUntil: NOW + 300_000 });
  await assert.rejects(log.appendChange({ actor: { kind: 'server' }, action: 'auth.rate_limited', target: { kind: 'ip', id: '100.64.0.1' }, details: { blockedUntil: NOW - 1 } }), StateError);
});

test('audit recovery rejects duplicate identities, invalid UTF-8 and invalid fields in complete lines', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const record = { id: EVENT_ID, at: '2026-10-03T04:00:00.000Z', actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID } };
  const line = `${JSON.stringify(record)}\n`;
  for (const bytes of [
    Buffer.from(`${line}${line}`),
    Buffer.concat([Buffer.from(line), Buffer.from([0xff, 10])]),
    Buffer.from(`${JSON.stringify({ ...record, at: 'invalid-date' })}\n`),
    Buffer.from(`${JSON.stringify({ ...record, keyHash: 'private-fixture' })}\n`),
  ]) {
    await fs.writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(createChangeLog({ file }).appendCommitted(record), StateError);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test('audit files with broad permissions, symlinks or non-file types fail closed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const input = { actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID } };
  await fs.writeFile(file, '', { mode: 0o644 });
  await assert.rejects(createChangeLog({ file }).appendChange(input), StateError);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  await fs.unlink(file);
  const destination = path.join(directory, 'destination');
  await fs.writeFile(destination, '', { mode: 0o600 });
  await fs.symlink(destination, file);
  await assert.rejects(createChangeLog({ file }).appendChange(input), StateError);
  assert.equal(await fs.readFile(destination, 'utf8'), '');
  await fs.unlink(file);
  await fs.mkdir(file);
  await assert.rejects(createChangeLog({ file }).appendChange(input), StateError);
});

test('audit input and persisted records reject unknown fields, actions and unbounded names', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const valid = { actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID } };
  const log = createChangeLog({ file, now: () => NOW, newId: () => EVENT_ID });
  for (const input of [
    { ...valid, action: 'arbitrary-text' },
    { ...valid, secret: 'private-fixture' },
    { ...valid, details: { blockedUntil: NOW } },
    { ...valid, actor: { kind: 'device', id: DEVICE_ID, name: 'n'.repeat(256) } },
  ]) await assert.rejects(log.appendChange(input as typeof valid), StateError);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await fs.writeFile(file, '{"id":"valid-looking-but-not-a-record"}\n', { mode: 0o600 });
  await assert.rejects(createChangeLog({ file }).appendChange(valid), StateError);
});

test('appendCommitted deduplicates event IDs on restart and repairs only an incomplete tail', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const record = {
    id: EVENT_ID, at: '2026-10-03T04:00:00.000Z',
    actor: { kind: 'server' as const }, action: 'device.revoked', target: { kind: 'device' as const, id: DEVICE_ID },
  };
  const line = `${JSON.stringify(record)}\n`;
  await fs.writeFile(file, `${line}{"incomplete":`, { mode: 0o600 });
  const log = createChangeLog({ file });
  await Promise.all([log.appendCommitted(record), log.appendCommitted(record)]);
  assert.equal(await fs.readFile(file, 'utf8'), line);
  await createChangeLog({ file }).appendCommitted(record);
  assert.equal(await fs.readFile(file, 'utf8'), line);
});

test('a corrupt complete audit line fails closed without echoing or modifying its contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-change-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  const bytes = 'invalid-private-fixture\n{"incomplete":';
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const log = createChangeLog({ file, newId: () => EVENT_ID, now: () => NOW });
  await assert.rejects(log.appendChange({ actor: { kind: 'server' }, action: 'device.revoked', target: { kind: 'device', id: DEVICE_ID } }),
    (error: Error) => !error.message.includes('invalid-private-fixture'));
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('remote audit records name an environment or app by its prefixed ID and carry nothing else', () => {
  const env = `env_${'A'.repeat(22)}`;
  const app = `app_${'b'.repeat(22)}`;
  const device = { kind: 'device' as const, id: DEVICE_ID, name: 'test-phone' };
  for (const [action, target] of [
    ['remote.environment.created', { kind: 'environment', id: env }],
    ['remote.environment.terminate_requested', { kind: 'environment', id: env }],
    ['remote.browser.disconnected', { kind: 'environment', id: env }],
    ['remote.web.authorized', { kind: 'app', id: app }],
  ] as const) assert.equal(makeChangeRecord({ actor: device, action, target }, NOW, () => EVENT_ID).action, action);
  assert.equal(makeChangeRecord({ actor: { kind: 'server' }, action: 'remote.environment.lost', target: { kind: 'environment', id: env } }, NOW, () => EVENT_ID).target.id, env);
  for (const input of [
    { actor: device, action: 'remote.environment.created', target: { kind: 'app', id: app } },
    { actor: device, action: 'remote.environment.created', target: { kind: 'environment', id: `term_${'A'.repeat(22)}` } },
    { actor: device, action: 'remote.environment.created', target: { kind: 'environment', id: 'env_short' } },
    { actor: device, action: 'remote.environment.created', target: { kind: 'environment', id: '/home/user/secret' } },
    { actor: device, action: 'remote.web.authorized', target: { kind: 'environment', id: env } },
    { actor: device, action: 'remote.web.expired', target: { kind: 'app', id: app }, details: { path: '/srv' } },
    { actor: device, action: 'remote.environment.renamed', target: { kind: 'environment', id: env } },
  ]) assert.throws(() => makeChangeRecord(input as never, NOW, () => EVENT_ID), StateError);
});

test('file records say who did which operation on the Server, never the path; profile writes say whether a previous version was kept', () => {
  const device = { kind: 'device' as const, id: DEVICE_ID, name: 'test-phone' };
  const server = { kind: 'server', id: 'local' } as const;
  for (const action of ['remote.file.create', 'remote.file.write', 'remote.file.move', 'remote.file.rename', 'remote.file.delete']) {
    assert.equal(makeChangeRecord({ actor: device, action, target: server }, NOW, () => EVENT_ID).action, action);
    for (const previous of [true, false]) assert.deepEqual(makeChangeRecord({ actor: device, action, target: server, details: { profile: true, previous } }, NOW, () => EVENT_ID).details, { profile: true, previous });
  }
  for (const input of [
    { actor: { kind: 'server' }, action: 'remote.file.write', target: server },
    { actor: device, action: 'remote.file.write', target: { kind: 'server', id: '/home/user/notes.txt' } },
    { actor: device, action: 'remote.file.write', target: { kind: 'operation', id: `op_${'A'.repeat(22)}` } },
    { actor: device, action: 'remote.file.write', target: server, details: { path: '/home/user/notes.txt' } },
    { actor: device, action: 'remote.file.write', target: server, details: { profile: false, previous: false } },
    { actor: device, action: 'remote.file.write', target: server, details: { profile: true, previous: 'yes' } },
    { actor: device, action: 'remote.file.write', target: server, details: { profile: true, previous: true, bytes: 'c2VjcmV0' } },
    { actor: device, action: 'remote.file.copy', target: server },
  ]) assert.throws(() => makeChangeRecord(input as never, NOW, () => EVENT_ID), StateError, JSON.stringify(input));
});
