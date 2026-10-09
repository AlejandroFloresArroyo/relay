import type { AppUpdateArtifact, AppUpdateManifest } from '../../../protocol/appUpdate.ts';
import { parseAppUpdateManifest, APP_UPDATE_MESSAGES } from './appUpdate.ts';
import { RelayError, type RelayClient } from './client.ts';
export interface InstalledApp { supported: boolean; canInstall: boolean; applicationId: string; versionCode: number; versionName: string; signerSha256: string }
export type VerifiedApk = Pick<AppUpdateArtifact, 'applicationId' | 'versionCode' | 'versionName' | 'byteLength' | 'sha256' | 'signerSha256'>;
/** Platform boundary. Native owns private bytes, streaming SHA256, PackageManager and Android consent. */
export interface AppUpdateNative {
  claim(): string;
  retire(token: string): void;
  info(): Promise<InstalledApp>;
  open(token: string, artifact: AppUpdateArtifact): Promise<void>;
  writeChunk(token: string, bytes: number[]): Promise<void>;
  verify(token: string): Promise<VerifiedApk>;
  install(token: string): Promise<void>;
  requestInstallPermission(token: string): Promise<void>;
}
export function appUpdateCompatibility(artifact: AppUpdateArtifact, installed: InstalledApp): 'unsupported' | 'incompatible' | 'current' | 'new' {
  if (!installed.supported) return 'unsupported';
  if (artifact.applicationId !== installed.applicationId || artifact.signerSha256 !== installed.signerSha256 || artifact.versionCode < installed.versionCode) return 'incompatible';
  return artifact.versionCode === installed.versionCode ? 'current' : 'new';
}
export class AppUpdateDownload {
  readonly token: string;
  private readonly abort = new AbortController();
  private retired = false;
  private started = false;
  private verified: AppUpdateArtifact | null = null;
  private readonly native: AppUpdateNative;
  private readonly valid: () => boolean;
  private readonly onDenial?: (error: RelayError) => void;
  constructor(native: AppUpdateNative, valid: () => boolean, onDenial?: (error: RelayError) => void) {
    this.native = native; this.valid = valid; this.onDenial = onDenial; this.current(); this.token = native.claim();
  }
  private current() { if (this.retired || !this.valid()) throw new RelayError('cancelled', 'Descarga cancelada.'); }
  cancel() { if (this.retired) return; this.retired = true; this.verified = null; this.abort.abort(); this.native.retire(this.token); }
  async download(client: RelayClient, manifest: Extract<AppUpdateManifest, { state: 'published' }>, onProgress: (received: number) => void, onVerifying?: () => void): Promise<VerifiedApk> {
    try {
      this.current(); if (this.started) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid); this.started = true;
      const value = parseAppUpdateManifest(manifest, '"' + manifest.revision + '"');
      if (value.state !== 'published') throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
      const before = await this.native.info(); this.current();
      if (appUpdateCompatibility(value.artifact, before) !== 'new' || !before.canInstall) throw new RelayError('app_update_invalid', 'Revisa compatibilidad y permiso de instalación antes de descargar.');
      await this.native.open(this.token, value.artifact); this.current();
      await client.downloadAppUpdate(value, { signal: this.abort.signal, onDenial: this.onDenial,
        writeChunk: async bytes => { this.current(); await this.native.writeChunk(this.token, [...bytes]); this.current(); },
        onProgress: received => { this.current(); onProgress(received); },
      }); this.current();
      onVerifying?.(); this.current();
      const actual = await this.native.verify(this.token); this.current();
      const installed = await this.native.info(); this.current();
      const a = value.artifact;
      if (actual.applicationId !== a.applicationId || actual.versionCode !== a.versionCode || actual.versionName !== a.versionName || actual.byteLength !== a.byteLength || actual.sha256 !== a.sha256 || actual.signerSha256 !== a.signerSha256 || appUpdateCompatibility(a, installed) !== 'new' || !installed.canInstall) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
      this.verified = a; return actual;
    } catch (error) { this.cancel(); if (error instanceof RelayError) throw error; throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid); }
  }
  async install(): Promise<void> {
    try {
      this.current(); if (!this.verified) throw new RelayError('app_update_invalid', 'Descarga y verifica el APK antes de instalar.');
      const installed = await this.native.info(); this.current();
      if (appUpdateCompatibility(this.verified, installed) !== 'new' || !installed.canInstall) throw new RelayError('app_update_invalid', 'La app instalada cambió. Revisa y descarga de nuevo.');
      await this.native.install(this.token); this.current();
    } catch (error) { if (error instanceof RelayError) throw error; throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid); }
    finally { this.cancel(); }
  }
}
