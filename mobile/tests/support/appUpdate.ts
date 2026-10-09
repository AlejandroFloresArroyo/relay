import type { AppUpdateNative, InstalledApp, VerifiedApk } from '@/core/appUpdateSession';
export const fixtureArtifact = { applicationId: 'io.fixture.relay', versionCode: 4, versionName: '1.3.0', byteLength: 4, sha256: 'a'.repeat(64), signerSha256: 'b'.repeat(64), builtAtMs: 1700000000000, sourceCommit: 'c'.repeat(40) };
export const fixtureManifest = { state: 'published' as const, revision: 'd'.repeat(64), artifact: fixtureArtifact };
export const fixtureInstalled: InstalledApp = { supported: true, canInstall: true, applicationId: 'io.fixture.relay', versionCode: 3, versionName: '1.2.0', signerSha256: 'b'.repeat(64) };
export const fixtureVerified: VerifiedApk = { applicationId: 'io.fixture.relay', versionCode: 4, versionName: '1.3.0', byteLength: 4, sha256: 'a'.repeat(64), signerSha256: 'b'.repeat(64) };
let next = 0;
export const apkNative = {
  claim: jest.fn(() => 'private-fixture-' + ++next), retire: jest.fn(), info: jest.fn<Promise<InstalledApp>, []>(),
  open: jest.fn<Promise<void>, Parameters<AppUpdateNative['open']>>(), writeChunk: jest.fn<Promise<void>, Parameters<AppUpdateNative['writeChunk']>>(),
  verify: jest.fn<Promise<VerifiedApk>, [string]>(), install: jest.fn<Promise<void>, [string]>(), requestInstallPermission: jest.fn<Promise<void>, [string]>(),
};
export function resetApkNative() {
  next = 0; Object.values(apkNative).forEach(fn => fn.mockReset());
  apkNative.claim.mockImplementation(() => 'private-fixture-' + ++next); apkNative.retire.mockImplementation(() => {});
  apkNative.info.mockResolvedValue({ ...fixtureInstalled }); apkNative.open.mockResolvedValue(undefined); apkNative.writeChunk.mockResolvedValue(undefined);
  apkNative.verify.mockResolvedValue({ ...fixtureVerified }); apkNative.install.mockResolvedValue(undefined); apkNative.requestInstallPermission.mockResolvedValue(undefined);
}
