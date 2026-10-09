export const APP_UPDATE_METADATA_VERSION = 1;
export const APP_UPDATE_MAX_BYTES = 256 * 1024 * 1024;
export const APP_UPDATE_METADATA_MAX_BYTES = 16 * 1024;

export type AppUpdateArtifact = {
  applicationId: string;
  versionCode: number;
  versionName: string;
  byteLength: number;
  sha256: string;
  signerSha256: string;
  builtAtMs: number;
  sourceCommit: string;
};
export type AppUpdatePublication = AppUpdateArtifact & { schemaVersion: 1 };
export type AppUpdateManifest =
  | { state: 'unpublished' }
  | { state: 'published'; revision: string; artifact: AppUpdateArtifact };
