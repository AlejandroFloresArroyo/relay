import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { FakeHermes } from './fake_hermes.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/protocol.ts';
export const KEY = `rly1_${Buffer.alloc(32, 71).toString('base64url')}`;
export const AUTH = { Authorization: `Bearer ${KEY}`, [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
export const metadata = { schemaVersion: 1, applicationId: 'io.github.fixture.relay', versionCode: 2, versionName: '2.0', byteLength: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', signerSha256: 'a'.repeat(64), builtAtMs: 1791028800000, sourceCommit: 'b'.repeat(40) };
export async function fixture(t: TestContext, enabled = true) {
  const root = await fs.mkdtemp(path.resolve('app-update-http-')); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const published = path.join(root, 'published'), privateRoot = path.join(root, 'private');
  await fs.mkdir(published, { mode: 0o700 }); await fs.mkdir(privateRoot, { mode: 0o700 });
  const store = await createDeviceStore({ directory: privateRoot });
  await store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000071', name: 'synthetic-phone', pairedAt: 1791028800000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes(); const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } });
  const server = createApp({ config: { corsOrigins: ['http://fixture.test'], ...(enabled ? { appUpdateRoot: published } : {}) }, store,
    pairing: createPairing({ store, origin: async () => 'http://fixture.test.ts.net', serverName: 'fixture' }), hermes, runs,
    tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: line => logs.push(line) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runs.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(suffix = '', headers: Record<string, string> = AUTH) {
    const response = await fetch(base + '/v1/app-update' + suffix, { headers });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  }
  async function publish(apk = Buffer.from('abc'), changes: Record<string, unknown> = {}) {
    await fs.writeFile(path.join(published, 'relay.apk'), apk, { mode: 0o600 });
    await fs.writeFile(path.join(published, 'release.json'), JSON.stringify({ ...metadata, byteLength: apk.length,
      sha256: createHash('sha256').update(apk).digest('hex'), ...changes }), { mode: 0o600 });
  }
  return { root, published, privateRoot, store, logs, base, call, publish, server };
}
