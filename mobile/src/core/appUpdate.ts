import type { AppUpdateArtifact, AppUpdateManifest } from '../../../protocol/appUpdate.ts';
import { APP_UPDATE_MAX_BYTES } from '../../../protocol/appUpdate.ts';
import { RelayError } from './client.ts';
export type AppUpdateErrorCode = 'app_update_unavailable' | 'app_update_changed' | 'app_update_invalid' | 'app_update_busy';
export const APP_UPDATE_MESSAGES: Record<AppUpdateErrorCode, string> = {
  app_update_unavailable: 'Este Puente no ofrece actualización APK.',
  app_update_changed: 'La publicación cambió. Revisa las versiones y descarga de nuevo.',
  app_update_invalid: 'La respuesta del Puente sobre la actualización no es válida.',
  app_update_busy: 'El Puente está ocupado. Reintenta más tarde.',
};
export const appUpdateRevision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
export function parseAppUpdateManifest(value: unknown, etag: string | null): AppUpdateManifest {
  const invalid = () => { throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid); };
  if (exact(value, ['state']) && value.state === 'unpublished') return { state: 'unpublished' };
  if (!exact(value, ['state', 'revision', 'artifact']) || value.state !== 'published' || !appUpdateRevision(value.revision) || etag !== '"' + value.revision + '"') return invalid();
  const a = value.artifact;
  if (!exact(a, ['applicationId', 'versionCode', 'versionName', 'byteLength', 'sha256', 'signerSha256', 'builtAtMs', 'sourceCommit'])
    || typeof a.applicationId !== 'string' || a.applicationId.length > 200 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(a.applicationId)
    || !positive(a.versionCode, 2147483647) || typeof a.versionName !== 'string' || a.versionName.length < 1 || a.versionName.length > 128
    || !positive(a.byteLength, APP_UPDATE_MAX_BYTES) || !appUpdateRevision(a.sha256) || !appUpdateRevision(a.signerSha256)
    || typeof a.builtAtMs !== 'number' || !Number.isSafeInteger(a.builtAtMs) || a.builtAtMs < 0
    || typeof a.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(a.sourceCommit)) return invalid();
  return { state: 'published', revision: value.revision, artifact: { ...a } as AppUpdateArtifact };
}
