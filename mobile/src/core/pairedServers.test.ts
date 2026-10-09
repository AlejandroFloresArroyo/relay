import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migratePairedServers, createPairedServerStore } from './pairedServers.ts';
import { createHttpPairingFlow, createPairingFlow } from './pairing.ts';
import { loadStoredState } from './settings.ts';
import type { PairingResponse } from '../../../protocol/protocol.ts';

const legacy = { id: 'atlas', name: 'Mi atlas', url: 'http://atlas.example.ts.net:8650', isDefault: true, key: 'old-shared-key' };
const paired = { ...legacy, key: 'new-synthetic-key', deviceId: 'device-1' };
const result: PairingResponse = { deviceKey: 'new-synthetic-key', device: { id: 'device-1', name: 'Teléfono', pairedAt: 1700000000000, revokedAt: null }, server: { name: 'atlas' } };

test('migration keeps legacy identity, name, URL and default but drops any old key', () => {
  const migrated = migratePairedServers(JSON.stringify([legacy, { ...paired, id: 'second' }, null]));
  assert.deepEqual(migrated.servers, [{ ...legacy, key: '' }, { ...paired, id: 'second' }]);
  assert.equal(migrated.invalidCount, 1);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migratePairedServers(JSON.stringify([paired])).servers, [paired]);
  assert.throws(() => migratePairedServers('{broken'));
  assert.throws(() => migratePairedServers('{}'));
});

test('combined stored loading normalizes old settings and migrates servers with independent corruption handling', () => {
  const oldSettings = '{"faceid":false,"faceApprove":false,"nAppr":true,"nTask":false,"nOff":true,"theme":"dark"}';
  const normalized = { faceid: false, faceApprove: false, autoLockMs: 60_000 };
  const safe = { ...paired, id: 'safe', isDefault: false, url: 'HTTP://ATLAS.EXAMPLE.TS.NET.' };
  const unsafe = { ...paired, id: 'unsafe', isDefault: false, url: 'https://evil.example' };
  const rawServers = JSON.stringify([legacy, safe, unsafe, null]);
  for (const rawSettings of [oldSettings, 'broken']) {
    const loaded = loadStoredState(rawServers, rawSettings);
    const migrated = migratePairedServers(JSON.stringify(loaded.servers));
    assert.deepEqual(loaded.settings, rawSettings === oldSettings ? normalized : { faceid: true, faceApprove: true, autoLockMs: 60_000 });
    assert.deepEqual(migrated.servers, [{ ...legacy, key: '' }, { ...safe, url: legacy.url }, unsafe]);
    assert.equal(migrated.invalidCount, 1);
    assert.equal(migrated.changed, true);
  }
  for (const corruptServers of ['broken', '{}']) {
    const loaded = loadStoredState(corruptServers, oldSettings);
    const migrated = migratePairedServers(JSON.stringify(loaded.servers));
    assert.deepEqual(loaded.settings, normalized);
    assert.deepEqual(migrated.servers, []);
    assert.equal(migrated.changed, false);
  }
});

test('persistent server operations preserve identity on re-pairing and publish only after writes', async () => {
  let disk = '';
  const store = createPairedServerStore({ initial: [paired], write: async (raw) => { disk = raw; }, newId: () => 'other' });
  const replacement = await store.replace('atlas', { name: 'ignored', url: 'http://atlas.example.ts.net:1234', key: 'replacement', deviceId: 'replacement-device' });
  assert.equal(replacement.name, 'Mi atlas');
  assert.equal(replacement.id, 'atlas');
  assert.equal(replacement.isDefault, true);
  await store.add({ name: 'other', url: legacy.url, key: 'synthetic', deviceId: 'other-device' });
  await store.setDefault('other');
  assert.equal(JSON.parse(disk)[1].isDefault, true);
  assert.equal(JSON.parse(disk)[0].isDefault, false);
  await store.remove('other');
  assert.equal(store.entries()[0].isDefault, true);
  await store.remove('atlas');
  assert.deepEqual(store.entries(), []);
});

test('secure-store write failure never reports pairing success and retry never re-posts consumed code', async () => {
  let fail = true;
  let posts = 0;
  const store = createPairedServerStore({ initial: [paired], write: async () => { if (fail) throw new Error('secure-store locked'); }, newId: () => 'new' });
  const states: string[] = [];
  const flow = createPairingFlow({ exchange: async () => { posts++; return result; }, persist: (value, url) => store.replace('atlas', { name: value.server.name, url, key: value.deviceKey, deviceId: value.device.id }), onState: (state) => states.push(state.kind) });
  await flow.submit({ baseUrl: legacy.url, code: '0123456789' });
  assert.equal(flow.state().kind, 'storage');
  assert.equal(states.includes('success'), false);
  assert.equal(store.entries()[0].key, paired.key);
  fail = false;
  await flow.retrySave();
  assert.equal(flow.state().kind, 'success');
  assert.equal(posts, 1);
  assert.equal(store.entries()[0].key, result.deviceKey);
});

test('pending secure-store write is awaited and duplicate submits do not exchange twice', async () => {
  let finish!: () => void;
  let posts = 0;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const flow = createPairingFlow({ exchange: async () => { posts++; return result; }, persist: async () => waiting });
  const first = flow.submit({ baseUrl: legacy.url, code: '0123456789' });
  await flow.submit({ baseUrl: legacy.url, code: '0123456789' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flow.state().kind, 'saving');
  assert.equal(posts, 1);
  finish();
  await first;
  assert.equal(flow.state().kind, 'success');
});

test('concurrent server operations serialize, failed writes leave previous entries intact', async () => {
  let writes = 0;
  const store = createPairedServerStore({ initial: [], newId: () => `srv-${writes}`, write: async () => { writes++; if (writes === 1) throw new Error('locked'); } });
  const input = { name: 'a', url: legacy.url, key: 'synthetic', deviceId: 'device' };
  const one = store.add(input);
  const two = store.add({ ...input, name: 'b' });
  await assert.rejects(one);
  await two;
  assert.equal(store.entries().length, 1);
  assert.equal(store.entries()[0].name, 'b');
  assert.equal(store.entries()[0].isDefault, true);
});

test('a rejected exchange can reset for a fresh QR while a consumed key cannot be discarded', async () => {
  let reject = true;
  const flow = createPairingFlow({ exchange: async () => { if (reject) throw new Error('offline'); return result; }, persist: async () => { throw new Error('locked'); } });
  await flow.submit({ baseUrl: legacy.url, code: '0123456789' });
  assert.equal(flow.state().kind, 'error');
  flow.reset();
  assert.equal(flow.state().kind, 'idle');
  reject = false;
  await flow.submit({ baseUrl: legacy.url, code: '0123456789' });
  flow.reset();
  assert.equal(flow.state().kind, 'storage');
});

test('re-pairing preflight rejects unknown and deleted targets before exchange, valid targets replace', async () => {
  for (const target of ['missing', 'deleted', 'atlas']) {
    let posts = 0;
    const replacement = { ...result, deviceKey: 'replacement-key', device: { ...result.device, id: 'replacement-device' } };
    const store = createPairedServerStore({ initial: [paired, { ...paired, id: 'deleted', isDefault: false }], write: async () => {}, newId: () => 'new' });
    const flow = createPairingFlow({ beforeExchange: () => store.assertPairingTarget(target), exchange: async () => { posts++; return replacement; }, persist: (value, url) => store.replace(target, { name: value.server.name, url, key: value.deviceKey, deviceId: value.device.id }) });
    await store.remove('deleted');
    await flow.submit({ baseUrl: legacy.url, code: '0123456789' });
    if (target === 'atlas') {
      assert.equal(posts, 1);
      assert.equal(flow.state().kind, 'success');
      assert.deepEqual(store.entries(), [{ ...paired, key: replacement.deviceKey, deviceId: replacement.device.id }]);
    } else {
      assert.equal(posts, 0, target);
      const state = flow.state();
      assert.equal(state.kind, 'error');
      if (state.kind === 'error') assert.equal(state.error.kind, 'server_missing');
      await flow.retrySave();
      assert.equal(posts, 0);
      flow.reset();
      assert.equal(flow.state().kind, 'idle');
    }
    store.assertPairingTarget(undefined);
  }
});

test('removal evicts cached credentials only after persistence succeeds and retains them on failure', async () => {
  let fail = true;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const cached = { sig: JSON.stringify([paired.url, paired.deviceId, paired.key]), client: { key: paired.key } };
  const cache = new Map([['atlas', cached], ['other', cached]]);
  const store = createPairedServerStore({ initial: [paired], write: async () => { if (fail) throw new Error('locked'); await waiting; }, newId: () => 'new', onRemove: (id) => { cache.delete(id); } });
  await assert.rejects(store.remove('atlas'));
  assert.equal(cache.get('atlas'), cached);
  assert.deepEqual(store.entries(), [paired]);
  fail = false;
  const removal = store.remove('atlas');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.get('atlas'), cached);
  finish();
  await removal;
  assert.equal(cache.has('atlas'), false);
  assert.equal(cache.get('other'), cached);
  assert.deepEqual(store.entries(), []);
});

test('migration canonicalizes safe paired origins without dropping invalid destination metadata', () => {
  const entry = { ...paired, url: 'HTTP://ATLAS.EXAMPLE.TS.NET.' };
  assert.deepEqual(migratePairedServers(JSON.stringify([entry])).servers, [paired]);
});

test('production pairing flow rechecks its live target after deferred health before spending a code', async () => {
  for (const deleted of [true, false]) {
    let posts = 0;
    let releaseHealth!: (response: Response) => void;
    let healthStarted!: () => void;
    const started = new Promise<void>((resolve) => { healthStarted = resolve; });
    const health = new Promise<Response>((resolve) => { releaseHealth = resolve; });
    const store = createPairedServerStore({ initial: [paired], write: async () => {}, newId: () => 'new' });
    const replacement = { ...result, deviceKey: 'replacement-key', device: { ...result.device, id: 'replacement-device' } };
    const states: string[] = [];
    const flow = createHttpPairingFlow({
      beforeExchange: () => store.assertPairingTarget('atlas'),
      fetch: async (url, init) => {
        if (String(url).endsWith('/health')) { healthStarted(); return health; }
        assert.equal(String(url), `${legacy.url}/v1/pair`);
        assert.equal(init?.method, 'POST');
        posts++;
        return new Response(JSON.stringify(replacement), { status: 201 });
      },
      persist: (value, url) => store.replace('atlas', { name: value.server.name, url, key: value.deviceKey, deviceId: value.device.id }),
      onState: (state) => states.push(state.kind),
    });
    const submission = flow.submit({ baseUrl: legacy.url, code: '0123456789' });
    await started;
    if (deleted) await store.remove('atlas');
    assert.equal(posts, 0);
    releaseHealth(new Response(JSON.stringify({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 })));
    await submission;
    if (deleted) {
      assert.equal(posts, 0, 'deleted target must not spend the code');
      const state = flow.state();
      assert.equal(state.kind, 'error');
      if (state.kind === 'error') assert.equal(state.error.kind, 'server_missing');
      assert.deepEqual(store.entries(), []);
      assert.equal(states.includes('storage'), false);
      assert.equal(states.includes('success'), false);
      await flow.retrySave();
      assert.equal(posts, 0);
      flow.reset();
      assert.equal(flow.state().kind, 'idle');
    } else {
      assert.equal(posts, 1);
      assert.equal(flow.state().kind, 'success');
      assert.deepEqual(store.entries(), [{ ...paired, key: replacement.deviceKey, deviceId: replacement.device.id }]);
    }
  }
});
