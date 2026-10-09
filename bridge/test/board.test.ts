import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { FakeHermes } from '../support/fake_hermes.ts';
import { createBoardReader } from '../src/board.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { hashDeviceKey } from '../src/auth.ts';
const now = 1791028800000;
const publication = { title: 'Disco', updatedAt: now, maxAgeMs: 60000, state: 'ready', content: { type: 'number', value: '82', unit: '%', detail: 'Uso' } };
async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve('board-fixture-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const published = path.join(root, 'profile', 'relay-board'); await fs.mkdir(published, { recursive: true });
  const privateDirectory = path.join(root, 'private'); await fs.mkdir(privateDirectory, { mode: 0o700 });
  const store = await createDeviceStore({ directory: privateDirectory });
  const key = `rly1_${Buffer.alloc(32, 43).toString('base64url')}`;
  await store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000043', name: 'fixture', pairedAt: now, revokedAt: null, keyHash: hashDeviceKey(key).toString('hex') }); });
  const hermes = new FakeHermes();
  const reader = createBoardReader(() => path.join(root, 'profile'), () => now);
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } });
  const logs: string[] = [];
  const server = createApp({ config: { corsOrigins: [] }, hermes: Object.assign(hermes, { board: reader }), runs, store, pairing: createPairing({ store, origin: async () => 'http://fixture.test.ts.net', serverName: 'fixture' }), tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', now: () => now, log: l => logs.push(l) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const call = (suffix = '', auth = true) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/board${suffix}`, { headers: auth ? { Authorization: `Bearer ${key}` } : {} });
  const write = (data: unknown = publication) => fs.writeFile(path.join(published, 'disk.json'), JSON.stringify(data));
  return { root, published, call, write, store, logs };
}
test('HTTP board reads only validated publication and derives ownership from profile', async t => {
  const f = await setup(t); await f.write();
  const response = await f.call(); assert.equal(response.status, 200);
  const page = await response.json(); assert.equal(page.cards[0].agentId, 'default'); assert.equal(page.cards[0].content.value, '82'); assert.equal(page.cards[0].status, 'ready');
  assert.equal((await f.call('', false)).status, 401);
  assert.equal((await f.call('?path=elsewhere')).status, 400);
  await f.store.mutate(s => { s.devices[0].revokedAt = now; }); assert.equal((await f.call()).status, 403);
  assert.doesNotMatch(f.logs.join('\n'), /Disco|82|disk.json/);
});

test('schema, byte bounds, symlinks, hardlinks and ancestor escapes never expose their contents', async t => {
  const f = await setup(t); const file = path.join(f.published, 'disk.json');
  const invalid = [ { ...publication, agentId: 'spoof' }, { ...publication, content: { type: 'web', url: 'https://invalid.test' } }, { ...publication, updatedAt: now / 1000 }, { ...publication, updatedAt: now + 300001 }, { ...publication, content: { type: 'action', label: 'Run', message: 'hello', command: 'sh' } }, { ...publication, content: { type: 'meter', value: 2, max: 1, unit: '' } }, { ...publication, content: { type: 'text', text: 'x'.repeat(33000) } } ];
  for (const data of invalid) { await f.write(data); const page = await (await f.call()).json(); assert.equal(page.cards[0].status, 'error'); assert.equal(page.cards[0].title, 'Tarjeta no disponible'); }
  await f.write(); await f.call();
  const outside = path.join(f.root, 'outside.json'); await fs.writeFile(outside, JSON.stringify({ ...publication, title: 'NEVER SERVE' }));
  for (const kind of ['symlink', 'hardlink']) {
    await fs.unlink(file);
    if (kind === 'symlink') await fs.symlink(outside, file); else await fs.link(outside, file);
    const page = await (await f.call()).json(); assert.equal(page.cards[0].status, 'error'); assert.equal(page.cards[0].title, 'Disco'); assert.doesNotMatch(JSON.stringify(page), /NEVER SERVE/);
  }
  await fs.rename(f.published, f.published + '-old'); await fs.symlink(f.published + '-old', f.published);
  const page = await (await f.call()).json(); assert.equal(page.cards.length, 0); assert.ok(page.failedAgents.includes('default'));
});
test('all seven native payloads are bounded and publication state is explicit; missing files disappear', async t => {
  const f = await setup(t);
  for (const content of [ publication.content, { type: 'meter', value: 6.1, max: 16, unit: 'GB' }, { type: 'states', items: [{ label: 'Backup', state: 'ok', detail: '03:00' }] }, { type: 'series', points: [{ at: now - 1000, value: 1 }, { at: now, value: 4 }], unit: 'req/min' }, { type: 'log', lines: ['Complete'] }, { type: 'text', text: 'Note' }, { type: 'action', label: 'Review', message: 'Review backups' } ]) {
    await f.write({ ...publication, content }); const page = await (await f.call()).json(); assert.equal(page.cards[0].status, 'ready'); assert.deepEqual(page.cards[0].content, content);
  }
  await f.write({ ...publication, updatedAt: now - 60001 }); assert.equal((await (await f.call()).json()).cards[0].status, 'stale');
  await f.write({ ...publication, state: 'updating' }); assert.equal((await (await f.call()).json()).cards[0].status, 'updating');
  await f.write({ ...publication, state: 'error' }); assert.equal((await (await f.call()).json()).cards[0].status, 'error');
  await fs.unlink(path.join(f.published, 'disk.json')); assert.deepEqual((await (await f.call()).json()).cards, []);
  for (let i = 0; i < 33; i++) await fs.writeFile(path.join(f.published, `card${i}.json`), JSON.stringify(publication));
  assert.ok((await (await f.call()).json()).failedAgents.includes('default'));
});

test('descriptor chain stays inside the opened publication when its directory path is swapped', async t => {
  const f = await setup(t); await f.write();
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'disk.json'), JSON.stringify({ ...publication, title: 'OUTSIDE PUBLICATION' }));
  const openDirectory = fs.opendir.bind(fs); let swapped = false;
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    if (!swapped && String(args[0]).startsWith('/proc/self/fd/')) {
      swapped = true; await fs.rename(f.published, f.published + '-original'); await fs.symlink(outside, f.published);
    }
    return openDirectory(...args);
  });
  const response = await f.call(); assert.equal(response.status, 200);
  const page = await response.json(); assert.equal(page.cards[0].title, 'Disco'); assert.doesNotMatch(JSON.stringify(page), /OUTSIDE PUBLICATION/);
});
