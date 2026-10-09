import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/protocol.ts';
import type { ChangeInput, ChangeRecord } from '../src/changeLog.ts';
import { createActivityReader } from '../src/activity.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
const DEVICE = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const OTHER_KEY = `rly1_${Buffer.alloc(32, 8).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}`, [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
async function start(t: TestContext, peer = '100.64.0.1', readerFactory?: (directory: string) => ReturnType<typeof createActivityReader>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-activity-http-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 1791115200000;
  const store = await createDeviceStore({ directory, now: () => now });
  await store.mutate(state => {
    state.devices.push({ id: DEVICE, name: 'device-name-canary', pairedAt: now, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') });
    state.devices.push({ id: OTHER, name: 'second-device', pairedAt: now, revokedAt: null, keyHash: hashDeviceKey(OTHER_KEY).toString('hex') });
  });
  const pairing = createPairing({ store, origin: async () => 'http://synthetic.example.ts.net:8650', serverName: 'synthetic' });
  const hermes = new FakeHermes();
  hermes.profiles = async () => { throw new Error('Activity must not call Hermes'); };
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const logs: string[] = [];
  const server = createApp({ config: { corsOrigins: [] }, store, pairing, peerAddress: () => peer, hermes, runs,
    tailnet: { async whois() { throw new Error('Activity must not call Tailscale'); } }, now: () => now,
    ...(readerFactory ? { activity: readerFactory(directory) } : {}), log: line => logs.push(line) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (query = '', headers: Record<string, string> = AUTH) => {
    const response = await fetch(base + '/v1/activity' + query, { headers });
    const text = await response.text(); return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  };
  const append = (n: number) => store.changeLog.appendCommitted({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at: new Date(now).toISOString(),
    actor: { kind: 'device', id: DEVICE, name: 'device-name-canary' }, action: 'agent.tools.enable.requested', target: { kind: 'agent', id: 'dev' } });
  return { get, append, store, logs, directory, advance: () => { now += 600000; } };
}

test('GET activity uses private audit state only, preserves requested and protocol, and omits private payloads from responses and logs', async t => {
  const { get, append, logs } = await start(t);
  await append(1);
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.body.items[0].result, 'requested');
  assert.equal(response.body.items[0].action, 'agent.tools.enable');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(response.text, /device-name-canary|keyHash|name|content|previous|changes.jsonl/);
  assert.equal((await get('', {})).status, 401);
  assert.equal((await get('', { ...AUTH, [CHAT_PROTOCOL_HEADER]: '999' })).status, 426);
  assert.equal((await get('', { Authorization: AUTH.Authorization })).status, 426);
  assert.equal((await get('?path=private-query-canary')).status, 400);
  assert.doesNotMatch(logs.join('\n'), /private-query-canary|device-name-canary|Bearer|rly1_|path=/);
  assert.match(logs.join('\n'), /GET \/v1\/activity 200/);
});

test('HTTP query limits, unknown parameters and duplicates fail before reading audit state', async t => {
  const { get } = await start(t);
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=01', '?limit=-1', '?limit=1&limit=2',
    '?category=messages', '?category=server&category=tasks', '?agentId=../private-canary', '?agentId=', '?failuresOnly=1',
    '?failuresOnly=true&failuresOnly=false', '?cursor=', '?cursor=private-cursor-canary', '?offset=0']) {
    const response = await get(query);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, 'invalid_activity_query');
    assert.doesNotMatch(response.text, /private-canary|private-cursor-canary|\.\.\//);
  }
  assert.equal((await get('?limit=100&failuresOnly=false&category=configuration&agentId=dev')).status, 200);
});

test('HTTP cursor ownership, tampering and expiry cannot disclose another snapshot', async t => {
  const { get, append, advance } = await start(t);
  await append(1); await append(2);
  const first = await get('?limit=1');
  const cursor = first.body.nextCursor;
  assert.equal(typeof cursor, 'string');
  assert.equal((await get('?limit=1&cursor=' + cursor)).body.items[0].id, '00000000-0000-4000-8000-000000000001');
  const other = await get('?limit=1&cursor=' + cursor, { ...AUTH, Authorization: `Bearer ${OTHER_KEY}` });
  assert.equal(other.status, 400); assert.equal(other.body.items, undefined);
  assert.equal((await get('?limit=1&failuresOnly=true&cursor=' + cursor)).status, 400);
  const altered = cursor.slice(0, 40) + (cursor[40] === 'A' ? 'B' : 'A') + cursor.slice(41);
  assert.equal((await get('?limit=1&cursor=' + altered)).status, 409);
  advance();
  assert.equal((await get('?limit=1&cursor=' + cursor)).body.error.code, 'activity_cursor_expired');
});

test('non-tailnet peers and revoked devices cannot list audit entries', async t => {
  const outside = await start(t, '192.0.2.1');
  assert.equal((await outside.get()).body.error.code, 'tailnet_required');
  const { get, store } = await start(t);
  await store.mutate(state => { state.devices[0].revokedAt = 1791115200001; });
  const response = await get();
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'device_revoked');
  assert.equal(response.body.items, undefined);
});

test('revocation during filesystem await is rechecked before reading or returning private entries', async t => {
  let signal!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { get, append, store } = await start(t, '100.64.0.1', directory => createActivityReader({ directory, io: {
    ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('/changes.jsonl')) { signal(); await gate; }
      return handle;
    },
  } }));
  await append(1);
  const request = get();
  await opened;
  await store.mutate(state => { state.devices[0].revokedAt = 1791115200001; });
  release();
  const response = await request;
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'device_revoked');
  assert.equal(response.body.items, undefined);
  assert.doesNotMatch(response.text, /device-name-canary|agent.tools|dev"/);
});

test('corruption and missing audit state produce a safe unavailable error without modifying or recreating the source', async t => {
  const { directory, get, logs } = await start(t);
  const file = path.join(directory, 'changes.jsonl');
  const bytes = 'private-state-canary\n{"unfinished":';
  await fs.writeFile(file, bytes);
  const corrupt = await get();
  assert.equal(corrupt.status, 503); assert.equal(corrupt.body.error.code, 'activity_unavailable');
  assert.doesNotMatch(corrupt.text + logs.join('\n'), /private-state-canary|changes.jsonl|unfinished/);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  await fs.unlink(file);
  assert.equal((await get()).status, 503);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});


test('every valid Personality and Avisos producer composes with the real journal reader and HTTP filters', async t => {
  const { store, get, append, logs } = await start(t);
  await append(100);
  const presetId = '00000000-0000-4000-8000-000000000099';
  const cases: [string, ChangeInput['target'], string, string, string][] = [
    ['personality.preset.create.requested', { kind: 'preset', id: presetId }, 'personality.preset.create', 'configuration', 'requested'],
    ['personality.preset.create.succeeded', { kind: 'preset', id: presetId }, 'personality.preset.create', 'configuration', 'succeeded'],
    ['personality.preset.update.requested', { kind: 'preset', id: presetId }, 'personality.preset.update', 'configuration', 'requested'],
    ['personality.preset.update.succeeded', { kind: 'preset', id: presetId }, 'personality.preset.update', 'configuration', 'succeeded'],
    ['personality.preset.delete.requested', { kind: 'preset', id: presetId }, 'personality.preset.delete', 'configuration', 'requested'],
    ['personality.preset.delete.succeeded', { kind: 'preset', id: presetId }, 'personality.preset.delete', 'configuration', 'succeeded'],
    ['personality.soul.apply.requested', { kind: 'agent', id: 'dev' }, 'personality.soul.apply', 'configuration', 'requested'],
    ['personality.soul.apply.recorded', { kind: 'agent', id: 'dev' }, 'personality.soul.apply', 'configuration', 'recorded'],
    ['conversation.personality.changed', { kind: 'conversation', id: JSON.stringify(['dev', 'synthetic-conversation']) }, 'conversation.personality.change', 'conversations', 'recorded'],
    ['notification.registration.requested', { kind: 'device', id: DEVICE }, 'notification.registration', 'server', 'requested'],
  ];
  const records: ChangeRecord[] = [];
  for (const [action, target] of cases) records.push(await store.changeLog.appendChange({
    actor: { kind: 'device', id: DEVICE, name: 'private-personality-name-canary' }, action, target,
  }));
  const response = await get();
  assert.equal(response.status, 200, 'One valid producer must never make the entire journal unavailable');
  assert.equal(response.body.items.length, 11, 'Existing entries remain visible alongside all ten new events');
  for (const [index, [, target, action, category, result]] of cases.entries()) {
    const row = response.body.items.find((item: { id: string }) => item.id === records[index].id);
    assert.deepEqual(row, { id: records[index].id, at: Date.parse(records[index].at), actor: { kind: 'device', id: DEVICE }, action, category, result,
      scope: target.kind === 'agent' || target.kind === 'conversation' ? { kind: 'agent', agentId: 'dev' } : { kind: 'server' },
      conversationId: target.kind === 'conversation' ? 'synthetic-conversation' : null }, cases[index][0]);
  }
  assert.doesNotMatch(response.text + logs.join('\n'), /private-personality-name-canary|device-name-canary|00000000-0000-4000-8000-000000000099/);
  for (const [category, count] of [['configuration', 9], ['conversations', 1], ['server', 1]] as const) {
    const filtered = await get('?category=' + category);
    assert.equal(filtered.status, 200); assert.equal(filtered.body.items.length, count);
    assert.ok(filtered.body.items.every((item: { category: string }) => item.category === category));
  }
  assert.equal((await get('?agentId=dev')).body.items.length, 4);
  assert.equal((await get('?failuresOnly=true')).body.items.length, 0);
});

test('an unknown complete producer beside valid entries still fails closed without discarding the corrupt row', async t => {
  const { get, append, directory } = await start(t); await append(1);
  const file = path.join(directory, 'changes.jsonl');
  await fs.appendFile(file, JSON.stringify({ id: OTHER, at: new Date(1791115200000).toISOString(), actor: { kind: 'server' },
    action: 'future.private.requested', target: { kind: 'server', id: 'local' } }) + '\n');
  const before = await fs.readFile(file);
  const response = await get();
  assert.equal(response.status, 503); assert.equal(response.body.error.code, 'activity_unavailable');
  assert.equal(response.body.items, undefined); assert.doesNotMatch(response.text, /future.private|agent.tools/);
  assert.deepEqual(await fs.readFile(file), before);
});
