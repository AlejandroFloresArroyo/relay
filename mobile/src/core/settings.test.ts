import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTO_LOCK_OPTIONS, loadSettings, readSettings, updateSettings, loadStoredState } from './settings.ts';

test('old stored settings load security values and discard notification and theme preferences', () => {
  const settings = loadSettings('{"faceid":false,"faceApprove":true,"nAppr":true,"nTask":false,"nOff":true,"theme":"dark"}');
  assert.deepEqual(settings, { faceid: false, faceApprove: true, autoLockMs: 60_000 });
  assert.equal(JSON.stringify(settings), '{"faceid":false,"faceApprove":true,"autoLockMs":60000}');
});

test('the selector offers exactly now, one, five and fifteen minutes and persists every choice', () => {
  assert.deepEqual(AUTO_LOCK_OPTIONS.map(({ label, ms }) => [label, ms]), [['AHORA', 0], ['1 MIN', 60_000], ['5 MIN', 300_000], ['15 MIN', 900_000]]);
  for (const autoLockMs of [0, 60_000, 300_000, 900_000]) {
    const saved = JSON.stringify({ ...loadSettings(null), autoLockMs });
    assert.equal(loadSettings(saved).autoLockMs, autoLockMs);
  }
});

test('missing or invalid settings use the one minute default without crashing', () => {
  for (const raw of [null, 'broken', 'null', '[]', '{"autoLockMs":1,"faceid":"false"}']) {
    assert.deepEqual(loadSettings(raw), { faceid: true, faceApprove: true, autoLockMs: 60_000 });
  }
});

test('settings storage tolerates corruption and old preferences without reading or changing servers', async () => {
  const servers = '[{"id":"saved-server","name":"Atlas","isDefault":true}]';
  const disk = new Map([['relay.servers.v1', servers], ['relay.settings.v1', 'broken']]);
  const reads: string[] = [];
  const read = async (key: string) => { reads.push(key); return disk.get(key) ?? null; };
  assert.deepEqual(await readSettings(read), { faceid: true, faceApprove: true, autoLockMs: 60_000 });
  disk.set('relay.settings.v1', '{"faceid":false,"nAppr":true,"nTask":true,"nOff":true,"theme":"dark"}');
  const old = await readSettings(read);
  assert.deepEqual(old, { faceid: false, faceApprove: true, autoLockMs: 60_000 });
  assert.deepEqual(reads, ['relay.settings.v1', 'relay.settings.v1']);
  assert.equal(disk.get('relay.servers.v1'), servers);
  const writes: string[] = [];
  const dirty = { ...old, nAppr: true, nTask: true, nOff: true, theme: 'dark' };
  const next = updateSettings(dirty, 'autoLockMs', 900_000, (key, value) => { writes.push(key); disk.set(key, value); });
  assert.deepEqual(next, { faceid: false, faceApprove: true, autoLockMs: 900_000 });
  assert.equal(disk.get('relay.settings.v1'), '{"faceid":false,"faceApprove":true,"autoLockMs":900000}');
  assert.deepEqual(writes, ['relay.settings.v1']);
  assert.equal(disk.get('relay.servers.v1'), servers);
});

test('loading both stored strings isolates corrupt settings from servers and corrupt servers from settings', () => {
  const servers = '[{"id":"saved-server","name":"Atlas","isDefault":true}]';
  const expectedServers = [{ id: 'saved-server', name: 'Atlas', isDefault: true }];
  assert.deepEqual(loadStoredState(servers, 'broken'), { servers: expectedServers, settings: { faceid: true, faceApprove: true, autoLockMs: 60_000 } });
  const settings = '{"faceid":false,"faceApprove":false,"autoLockMs":900000,"theme":"dark"}';
  assert.deepEqual(loadStoredState('broken', settings), { servers: [], settings: { faceid: false, faceApprove: false, autoLockMs: 900_000 } });
  assert.deepEqual(loadStoredState(servers, settings), { servers: expectedServers, settings: { faceid: false, faceApprove: false, autoLockMs: 900_000 } });
  assert.deepEqual(loadStoredState(null, null), { servers: [], settings: { faceid: true, faceApprove: true, autoLockMs: 60_000 } });
});

test('non-array stored servers are corrupt independently of valid settings', () => {
  for (const rawServers of ['null', '{}', '"server"', '42']) {
    assert.deepEqual(loadStoredState(rawServers, '{"faceid":false,"autoLockMs":0}'), {
      servers: [], settings: { faceid: false, faceApprove: true, autoLockMs: 0 },
    });
  }
});
