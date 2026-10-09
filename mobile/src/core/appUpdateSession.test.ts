import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as session from './appUpdateSession.ts';
import { createBridgeClient } from './bridgeClient.ts';
import type { AppUpdateArtifact, AppUpdateManifest } from '../../../protocol/appUpdate.ts';
const artifact: AppUpdateArtifact = { applicationId: 'io.fixture.relay', versionCode: 4, versionName: '1.3', byteLength: 4, sha256: 'a'.repeat(64), signerSha256: 'b'.repeat(64), builtAtMs: 1700000000000, sourceCommit: 'c'.repeat(40) };
const manifest = { state: 'published' as const, revision: 'd'.repeat(64), artifact };
const installed = { supported: true, canInstall: true, applicationId: artifact.applicationId, versionCode: 3, versionName: '1.2', signerSha256: artifact.signerSha256 };
function fixture() {
  let fetches = 0; const calls: string[] = []; let info = installed; let actual = artifact;
  const native = { claim: () => { calls.push('claim'); return 'fixture-token'; }, retire: (token: string) => { assert.equal(token, 'fixture-token'); calls.push('retire'); },
    info: async () => { calls.push('info'); return info; }, open: async () => { calls.push('open'); },
    writeChunk: async (_token: string, bytes: number[]) => { calls.push('write:' + bytes.length); }, verify: async () => { calls.push('verify'); return actual; },
    install: async () => { calls.push('install'); }, requestInstallPermission: async () => {},
  };
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => { fetches++; return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { ETag: '"' + manifest.revision + '"', 'Content-Length': '4', 'Content-Type': 'application/vnd.android.package-archive' } }); }) as typeof fetch });
  return { native, client, calls, fetches: () => fetches, setInstalled: (value: typeof installed) => { info = value; }, setActual: (value: AppUpdateArtifact) => { actual = value; } };
}
test('only a locally verified private APK can open Android confirmation, after dynamic installed-app revalidation', async () => {
  const f = fixture(); const Constructor = (session as { AppUpdateDownload?: typeof session.AppUpdateDownload }).AppUpdateDownload;
  assert.equal(typeof Constructor, 'function', 'Expose the guarded APK session');
  const download = new Constructor!(f.native, () => true);
  await assert.rejects(download.install(), { code: 'app_update_invalid' });
  const second = new Constructor!(f.native, () => true);
  await second.download(f.client, manifest as AppUpdateManifest & { state: 'published' }, () => {});
  assert.equal(f.calls.includes('install'), false);
  await second.install();
  assert.deepEqual(f.calls.slice(-6), ['write:4', 'verify', 'info', 'info', 'install', 'retire']);
});


test('local package/version/length/hash/signer mismatches retire private bytes and never authorize installation', async () => {
  for (const actual of [
    { ...artifact, applicationId: 'io.fixture.other' }, { ...artifact, versionCode: 5 }, { ...artifact, versionName: 'wrong-version' },
    { ...artifact, byteLength: 3 }, { ...artifact, sha256: 'f'.repeat(64) }, { ...artifact, signerSha256: 'f'.repeat(64) },
  ]) {
    const f = fixture(); f.setActual(actual); const candidate = new session.AppUpdateDownload(f.native, () => true);
    await assert.rejects(candidate.download(f.client, manifest, () => {}), { code: 'app_update_invalid' });
    assert.equal(f.calls.at(-1), 'retire'); assert.ok(!f.calls.includes('install'));
  }
});

test('changing the installed app signer before the install gesture rejects and cleans up the previously verified APK', async () => {
  const f = fixture(); const candidate = new session.AppUpdateDownload(f.native, () => true);
  await candidate.download(f.client, manifest, () => {});
  f.setInstalled({ ...installed, signerSha256: 'f'.repeat(64) });
  await assert.rejects(candidate.install(), { code: 'app_update_invalid' });
  assert.equal(f.calls.at(-1), 'retire'); assert.ok(!f.calls.includes('install'));
});

test('retirement while the private file open is pending prevents even starting HTTP download afterwards', async () => {
  const f = fixture(); let finish!: () => void; let opened!: () => void;
  const opening = new Promise<void>(resolve => { opened = resolve; });
  f.native.open = async () => { opened(); await new Promise<void>(resolve => { finish = resolve; }); };
  let valid = true;
  const candidate = new session.AppUpdateDownload(f.native, () => valid);
  const outcome = candidate.download(f.client, manifest, () => {}).catch(error => error.code);
  await opening; valid = false; finish(); assert.equal(await outcome, 'cancelled');
  assert.equal(f.fetches(), 0); assert.ok(!f.calls.includes('verify')); assert.equal(f.calls.at(-1), 'retire');
});

test('scope retirement while installation info is pending prevents the Android side effect before awaiting its result', async () => {
  const f = fixture(); let valid = true; const candidate = new session.AppUpdateDownload(f.native, () => valid);
  await candidate.download(f.client, manifest, () => {});
  let finish!: () => void; let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  f.native.info = async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return installed; };
  const outcome = candidate.install().catch(error => error.code);
  await reading; valid = false; finish(); assert.equal(await outcome, 'cancelled');
  assert.ok(!f.calls.includes('install'), 'An invalid lease cannot even open Android confirmation');
  assert.equal(f.calls.at(-1), 'retire');
});
test('a publication whose versionCode is lower than the installed app is refused as incompatible', () => {
  assert.equal(session.appUpdateCompatibility({ ...artifact, versionCode: 2 }, installed), 'incompatible');
  assert.equal(session.appUpdateCompatibility({ ...artifact, versionCode: 3 }, installed), 'current');
});
