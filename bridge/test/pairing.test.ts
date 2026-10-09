import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing, generatePairingCode, normalizePairingCode, pairingOrigin, PairingError } from '../src/pairing.ts';
import { checkBearer } from '../src/auth.ts';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-pair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 100_000;
  const store = await createDeviceStore({ directory, now: () => now });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  return { directory, store, pairing, setNow: (value: number) => { now = value; } };
}

test('Crockford normalization accepts ASCII aliases but rejects Unicode, other whitespace and lengths', () => {
  assert.equal(normalizePairingCode(' o i l 3 4-5 6 7 8 9 '), '0113456789');
  for (const code of ['０123456789', '01234\t56789', '01234\n56789', '012345678U', '012345678', '01234567890', 'ß123456789']) assert.equal(normalizePairingCode(code), null);
});

test('pair preserves the explicitly allowed HTTP default port and rejects injected origins', async (t) => {
  const { store } = await fixture(t);
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:80', serverName: 'arch' });
  assert.equal((await pairing.pair()).payload.url, 'http://arch.example.ts.net:80');
  for (const url of ['https://arch.example.ts.net:8650', 'http://user@arch.example.ts.net:8650', 'http://arch.example.ts.net:8650/path', 'http://arch.example.ts.net:8650?code=x']) {
    await assert.rejects(createPairing({ store, origin: async () => url, serverName: 'arch' }).pair());
  }
});

test('code generation masks ten random bytes uniformly into the frozen alphabet', (t) => {
  const spy = t.mock.method(crypto, 'randomBytes', (length: number) => { assert.equal(length, 10); return Buffer.from([0, 1, 2, 3, 31, 32, 33, 34, 35, 255]); });
  assert.equal(generatePairingCode(), '0123Z0123Z');
  assert.equal(spy.mock.callCount(), 1);
});

test('persisted code hash matches independent domain-separated SHA-256 fixture', async (t) => {
  const { pairing, store } = await fixture(t);
  const original = crypto.randomBytes;
  t.mock.method(crypto, 'randomBytes', (length: number) => length === 10 ? Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) : original(length));
  await pairing.pair();
  assert.equal(store.snapshot().pendingPairing?.codeHash, '83d481b9039ea3b2c96774d6fcd6c5005508d8ea61ff82460fbd678e50576137');
});

test('pairing origins use only full ASCII MagicDNS names and an explicit port', () => {
  assert.equal(pairingOrigin('ARCH.Example.TS.NET.', 8650), 'http://arch.example.ts.net:8650');
  for (const host of ['arch', 'ts.net', 'arch.ts.net', 'arch.example.ts.net.evil', 'user@arch.example.ts.net', 'á.example.ts.net', 'K.example.ts.net', '-a.example.ts.net', 'a..example.ts.net']) assert.throws(() => pairingOrigin(host, 8650));
  assert.throws(() => pairingOrigin('arch.example.ts.net', 0));
});

test('pairing expiry boundary accepts at 299999 ms and rejects at 300000 ms', async (t) => {
  const { pairing, setNow } = await fixture(t);
  const first = await pairing.pair();
  assert.equal(first.expiresAt, 400_000);
  setNow(399_999);
  assert.equal(await pairing.verify(first.payload.code, '100.64.0.1'), true);
  await pairing.redeem(first.payload.code, 'phone', '100.64.0.1');
  const second = await pairing.pair();
  setNow(699_999);
  assert.equal(await pairing.verify(second.payload.code, '100.64.0.1'), false);
  await assert.rejects(pairing.redeem(second.payload.code, 'phone', '100.64.0.1'), (error: PairingError) => error.code === 'pairing_invalid');
});

test('two concurrent redemptions yield one key, one device and one event; repetition has the same invalid error', async (t) => {
  const { pairing, store, directory } = await fixture(t);
  const { payload } = await pairing.pair();
  const results = await Promise.allSettled([pairing.redeem(payload.code, 'phone', '100.64.0.1'), pairing.redeem(payload.code, 'phone', '100.64.0.1')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'pairing_invalid');
  const success = (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof pairing.redeem>>>).value;
  assert.equal(success.deviceKey.length, 48);
  assert.deepEqual(success.server, { name: 'arch' });
  assert.equal(store.snapshot().devices.length, 1);
  assert.deepEqual(checkBearer(`Bearer ${success.deviceKey}`, store.snapshot().devices), { ok: true, deviceId: success.device.id, deviceName: 'phone' });
  await assert.rejects(pairing.redeem(payload.code, 'phone', '100.64.0.1'), (error: PairingError) => error.code === 'pairing_invalid');
  const bytes = await fs.readFile(path.join(directory, 'devices.json'), 'utf8') + await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8');
  assert.ok(!bytes.includes(success.deviceKey) && !bytes.includes(payload.code));
  assert.equal((await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('new pair invalidates its predecessor; restart preserves its original expiry and revocation is idempotent', async (t) => {
  const { pairing, directory, store } = await fixture(t);
  const first = await pairing.pair(); const second = await pairing.pair();
  assert.equal(await pairing.verify(first.payload.code, '100.64.0.1'), false);
  const restored = createPairing({ store: await createDeviceStore({ directory, now: () => 399_999 }), origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  const response = await restored.redeem(second.payload.code, 'phone', '100.64.0.1');
  const revoked = await restored.revoke(response.device.id);
  assert.equal(revoked.device.revokedAt, 399_999);
  assert.deepEqual(await restored.revoke(response.device.id), revoked);
  assert.deepEqual((await restored.devices()).devices, [revoked.device]);
  const lines = (await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(store.snapshot().pendingPairing?.expiresAt, 400_000);
});

test('missing or malformed codes still use a real fixed-length secret comparison', async (t) => {
  const { pairing } = await fixture(t);
  const original = crypto.timingSafeEqual;
  const spy = t.mock.method(crypto, 'timingSafeEqual', (a: Buffer, b: Buffer) => { assert.equal(a.length, 32); assert.equal(b.length, 32); return original(a, b); });
  assert.equal(await pairing.verify('invalid', '100.64.0.1'), false);
  assert.equal(spy.mock.callCount(), 1);
});

test('a device reaching the Puente through the Servidor itself (an emulator on it) is never named after the Servidor', async (t) => {
  const { pairing, store, directory } = await fixture(t);
  for (const peer of ['arch', 'ARCH']) {
    const { payload } = await pairing.pair();
    const response = await pairing.redeem(payload.code, peer, '100.64.0.1');
    assert.equal(response.device.name, 'teléfono');
    assert.deepEqual(response.server, { name: 'arch' });
  }
  const { payload } = await pairing.pair();
  assert.equal((await pairing.redeem(payload.code, 's23-de-ana', '100.64.0.2')).device.name, 's23-de-ana');
  assert.deepEqual(store.snapshot().devices.map((device) => device.name), ['teléfono', 'teléfono', 's23-de-ana']);
  const changes = (await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).actor.name);
  assert.deepEqual(changes, ['teléfono', 'teléfono', 's23-de-ana']);
  const fqdn = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'Arch.localdomain' });
  assert.equal((await fqdn.redeem((await fqdn.pair()).payload.code, 'arch', '100.64.0.1')).device.name, 'teléfono');
});
