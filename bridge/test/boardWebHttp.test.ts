import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { FakeHermes } from '../support/fake_hermes.ts';
import { createBoardReader } from '../src/board.ts';
import { createBoardWebReader } from '../src/boardWebReader.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { BOARD_WEB_HEADER, BOARD_WEB_LEGACY_TEXT } from '../../protocol/boardWeb.ts';
const now = 1791028800000;
const key = `rly1_${Buffer.alloc(32, 57).toString('base64url')}`;
const auth = { Authorization: `Bearer ${key}`, 'X-Relay-Protocol': '2', [BOARD_WEB_HEADER]: '1' };
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.resolve('board-web-http-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), published = path.join(profile, 'relay-board'); await fs.mkdir(published, { recursive: true });
  const privateRoot = path.join(root, 'private'); await fs.mkdir(privateRoot, { mode: 0o700 });
  const store = await createDeviceStore({ directory: privateRoot });
  await store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000057', name: 'synthetic-device', pairedAt: now, revokedAt: null, keyHash: hashDeviceKey(key).toString('hex') }); });
  const bytes = Buffer.from('<!doctype html><h1>Contenido sintético</h1>');
  const manifest = { schemaVersion: 1, entry: 'index.html', files: [{ name: 'index.html', mime: 'text/html', bytes: bytes.length, sha256: hash(bytes) }] };
  const revision = hash(JSON.stringify(manifest)); const bundleRoot = path.join(profile, 'relay-board-web', 'counter', revision); await fs.mkdir(bundleRoot, { recursive: true });
  await fs.writeFile(path.join(bundleRoot, 'manifest.json'), JSON.stringify(manifest)); await fs.writeFile(path.join(bundleRoot, 'index.html'), bytes);
  const envelope = { title: 'Web sintética', updatedAt: now, maxAgeMs: 60000, state: 'ready' };
  const writeWeb = () => fs.writeFile(path.join(published, 'web.json'), JSON.stringify({ ...envelope, content: { type: 'web', bundleRef: 'counter', revision } })); await writeWeb();
  await fs.writeFile(path.join(published, 'native.json'), JSON.stringify({ ...envelope, title: 'Nativa', content: { type: 'text', text: 'native fixture unchanged' } }));
  const hermes = Object.assign(new FakeHermes(), { board: createBoardReader(() => profile, () => now), boardWeb: createBoardWebReader(() => profile) });
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } }); const logs: string[] = [];
  const server = createApp({ config: { corsOrigins: ['http://fixture.test'] }, hermes, runs, store, pairing: createPairing({ store, origin: async () => 'http://fixture.test.ts.net', serverName: 'synthetic' }), tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', now: () => now, log: line => logs.push(line) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runs.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (route = '/v1/board', headers: Record<string, string> = auth) => fetch(base + route, { headers });
  const resource = `/v1/agents/default/board-web/counter/${revision}`;
  return { root, profile, published, bundleRoot, bytes, manifest, revision, store, hermes, server, base, resource, logs, call, writeWeb };
}
test('v1 keeps seven native types while capability-negotiated boards expose web without changing attribution', async t => {
  const f = await fixture(t);
  const legacy = await f.call('/v1/board', { Authorization: auth.Authorization }); const old = await legacy.json();
  const modern = await f.call(); const page = await modern.json();
  assert.equal(modern.headers.get(BOARD_WEB_HEADER), '1'); assert.equal(legacy.headers.get(BOARD_WEB_HEADER), null);
  const oldWeb = old.cards.find((c: { id: string; agentId: string }) => c.id === 'web' && c.agentId === 'default');
  const newWeb = page.cards.find((c: { id: string; agentId: string }) => c.id === 'web' && c.agentId === 'default');
  assert.deepEqual(oldWeb.content, { type: 'text', text: BOARD_WEB_LEGACY_TEXT });
  assert.deepEqual(newWeb.content, { type: 'web', bundleRef: 'counter', revision: f.revision });
  assert.deepEqual({ ...newWeb, content: oldWeb.content }, oldWeb);
  assert.deepEqual(page.cards.filter((c: { id: string }) => c.id === 'native'), old.cards.filter((c: { id: string }) => c.id === 'native'));
});
test('only authenticated protocol/capability-bound published refs return bounded manifest and asset bytes', async t => {
  const f = await fixture(t);
  const metadata = await f.call(f.resource + '/manifest'); assert.equal(metadata.status, 200); assert.deepEqual(await metadata.json(), { bundleRef: 'counter', revision: f.revision, manifest: f.manifest });
  const asset = await f.call(f.resource + '/assets/index.html'); assert.equal(asset.status, 200); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), f.bytes);
  assert.equal(asset.headers.get('content-type'), 'text/html'); assert.equal(asset.headers.get('cache-control'), 'no-store'); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(asset.headers.get(BOARD_WEB_HEADER), '1'); assert.equal(asset.headers.get('set-cookie'), null);
  assert.equal((await f.call(f.resource + '/manifest', {})).status, 401);
  assert.equal((await f.call(f.resource + '/manifest', { Authorization: auth.Authorization, [BOARD_WEB_HEADER]: '1' })).status, 426);
  assert.equal((await f.call(f.resource + '/manifest', { ...auth, [BOARD_WEB_HEADER]: '9' })).status, 426);
  assert.equal((await f.call(f.resource + '/assets/index.html?path=private')).status, 400);
  await fs.unlink(path.join(f.published, 'web.json')); assert.equal((await f.call(f.resource + '/manifest')).status, 404);
  assert.doesNotMatch(f.logs.join('\n'), /counter|index.html|manifest.json|rly1_|Contenido|board-web-http-|Bearer/);
});

test('concurrent removal cannot bypass pending snapshot disposal and release its quota twice', async t => {
  const f = await fixture(t); const open = fs.open.bind(fs); let retained = false;
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (!retained && String(args[0]).endsWith('/index.html')) {
      retained = true; const close = file.close.bind(file);
      t.mock.method(file, 'close', async () => { enter(); await held; return close(); });
    }
    return file;
  });
  assert.equal((await f.call(f.resource + '/manifest')).status, 200);
  await fs.unlink(path.join(f.published, 'web.json'));
  const first = f.call(f.resource + '/manifest'); await entered;
  const second = f.call(f.resource + '/manifest');
  let observed: string;
  try { observed = await Promise.race([second.then(() => 'completed'), new Promise<string>(resolve => setTimeout(() => resolve('pending'), 30))]); }
  finally { release(); await first; await second; }
  assert.equal(observed, 'pending', 'Disposal must retain ownership and quota through all concurrent waiters');
});

for (const attack of ['revoked', 'unpublished'] as const) {
  test(`a ${attack} device/publication during IO cannot receive web bytes`, async t => {
    const f = await fixture(t), open = fs.open.bind(fs); let entered!: () => void, release!: () => void, intercepted = false;
    const waiting = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (!intercepted && String(args[0]).endsWith('/index.html')) {
        intercepted = true; const read = file.read.bind(file);
        t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => { const result = await read(...params); entered(); await held; return result; });
      }
      return file;
    });
    const response = f.call(f.resource + '/assets/index.html'); await waiting;
    if (attack === 'revoked') await f.store.mutate(state => { state.devices[0].revokedAt = now; });
    else await fs.unlink(path.join(f.published, 'web.json'));
    release(); const result = await response;
    assert.equal(result.status, attack === 'revoked' ? 403 : 409);
    assert.doesNotMatch(await result.text(), /Contenido|index.html|profile|board-web-http-/);
  });
}
test('missing protocol/capability and invalid asset paths never enter private snapshot IO', async t => {
  const f = await fixture(t); let copies = 0;
  const snapshot = f.hermes.boardWeb.snapshot.bind(f.hermes.boardWeb);
  t.mock.method(f.hermes.boardWeb, 'snapshot', async (...args: Parameters<typeof snapshot>) => { copies++; return snapshot(...args); });
  for (const headers of [{ Authorization: auth.Authorization }, { ...auth, 'X-Relay-Protocol': '1' }, { ...auth, [BOARD_WEB_HEADER]: '2' }]) {
    assert.equal((await f.call(f.resource + '/manifest', headers)).status, 426);
  }
  assert.equal((await f.call(f.resource + '/assets/a%2fb.js')).status, 400);
  assert.equal((await f.call(f.resource + '/assets/index.html?x=1')).status, 400);
  assert.equal(copies, 0);
});
test('server snapshot quota remains bounded and an unpublished bundle releases only its own bytes', async t => {
  const f = await fixture(t); const envelope = { title: 'Synthetic quota', updatedAt: now, maxAgeMs: 60000, state: 'ready' };
  for (let i = 0; i < 9; i++) await fs.writeFile(path.join(f.published, `quota${i}.json`), JSON.stringify({ ...envelope, content: { type: 'web', bundleRef: `quota${i}`, revision: f.revision } }));
  let live = 0, peak = 0;
  t.mock.method(f.hermes.boardWeb, 'snapshot', async () => {
    live++; peak = Math.max(peak, live); let retired = false;
    return { revision: f.revision, manifest: f.manifest, assets: new Map([['index.html', f.bytes]]), byteLength: 1048576,
      async verify(check: () => void) { check(); }, async dispose() { if (!retired) { retired = true; live--; } } };
  });
  const route = (i: number) => `/v1/agents/default/board-web/quota${i}/${f.revision}/manifest`;
  for (let i = 0; i < 8; i++) assert.equal((await f.call(route(i))).status, 200);
  assert.equal((await f.call(route(8))).status, 429); assert.equal(live, 8); assert.equal(peak, 8);
  await fs.unlink(path.join(f.published, 'quota0.json'));
  assert.equal((await f.call(route(8))).status, 200); assert.equal(live, 8); assert.equal(peak, 8);
});
test('concurrent callers are rejected before exceeding the fixed consumer bound', async t => {
  const f = await fixture(t), profiles = f.hermes.profiles.bind(f.hermes); let entries = 0, release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { entered = r; });
  t.mock.method(f.hermes, 'profiles', async () => { entries++; if (entries === 32) entered(); await held; return profiles(); });
  const pending = Array.from({ length: 32 }, () => f.call(f.resource + '/manifest')); await waiting;
  try { assert.equal((await f.call(f.resource + '/manifest')).status, 429); assert.equal(entries, 32); }
  finally { release(); await Promise.all(pending); }
});
