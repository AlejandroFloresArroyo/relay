import type { AppUpdateArtifact } from '../../../protocol/appUpdate.ts';
import type { AppUpdateNative } from './appUpdateSession.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
export const DEMO_APP_UPDATE_SCENARIOS = [
  { id: 'new', label: 'Nueva' }, { id: 'current', label: 'Actual' }, { id: 'unpublished', label: 'No publicado' },
  { id: 'incompatible', label: 'Incompatible' }, { id: 'permission', label: 'Fuentes desconocidas' },
  { id: 'unsupported', label: 'Módulo ausente' }, { id: 'loading', label: 'Cargando' }, { id: 'busy', label: 'Puente ocupado' },
  { id: 'unavailable', label: 'Actualiza Puente' }, { id: 'error', label: 'Error' }, { id: 'verify-error', label: 'Verificación fallida' },
  { id: 'offline', label: 'Sin conexión' },
] as const;
export type DemoAppUpdateScenario = typeof DEMO_APP_UPDATE_SCENARIOS[number]['id'];
const scenarios = new Map<string, DemoAppUpdateScenario>();
const ports = new Map<string, AppUpdateNative>();
export const demoAppUpdateScenario = (serverId: string) => scenarios.get(serverId) ?? 'new';
export const setDemoAppUpdateScenario = (serverId: string, scenario: DemoAppUpdateScenario) => { scenarios.set(serverId, scenario); };
export function resetDemoAppUpdate() { scenarios.clear(); ports.clear(); }
const demoArtifact: AppUpdateArtifact = { applicationId: 'io.fixture.relay', versionCode: 4, versionName: '1.3.0', byteLength: 4096, sha256: 'a'.repeat(64), signerSha256: 'b'.repeat(64), builtAtMs: 1700000000000, sourceCommit: 'c'.repeat(40) };
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RelayError('cancelled', 'Simulación cancelada.'));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new RelayError('cancelled', 'Simulación cancelada.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function createDemoAppUpdate(serverId: string): Pick<RelayClient, 'appUpdate' | 'downloadAppUpdate'> {
  return {
    appUpdate: async signal => {
      const connection = demoConnectionError(serverId); if (connection) throw connection;
      const scenario = demoAppUpdateScenario(serverId); await delay(scenario === 'loading' ? 2500 : 0, signal);
      if (scenario === 'offline') throw new RelayError('unreachable', 'Sin conexión.');
      if (scenario === 'busy') throw new RelayError('app_update_busy', 'El Puente está ocupado. Reintenta más tarde.');
      if (scenario === 'unavailable') throw new RelayError('app_update_unavailable', 'Este Puente no ofrece actualización APK.');
      if (scenario === 'error') throw new RelayError('app_update_invalid', 'La respuesta del Puente sobre la actualización no es válida.');
      if (scenario === 'unpublished') return { state: 'unpublished' };
      return { state: 'published', revision: 'd'.repeat(64), artifact: { ...demoArtifact, ...(scenario === 'current' ? { versionCode: 3, versionName: '1.2.0' } : scenario === 'incompatible' ? { applicationId: 'io.fixture.other' } : {}) } };
    },
    downloadAppUpdate: async (manifest, options) => {
      const connection = demoConnectionError(serverId); if (connection) throw connection;
      for (let received = 0; received < manifest.artifact.byteLength; received += 512) {
        await delay(100, options.signal); const bytes = new Uint8Array(Math.min(512, manifest.artifact.byteLength - received));
        await options.writeChunk(bytes); if (options.signal.aborted) throw new RelayError('cancelled', 'Simulación cancelada.'); options.onProgress(received + bytes.length);
      }
    },
  };
}
export function demoAppUpdateNative(serverId: string): AppUpdateNative {
  let port = ports.get(serverId); if (port) return port;
  let next = 0; let current: string | null = null; let expected: AppUpdateArtifact | null = null; let written = 0; let verified = false;
  const check = (token: string) => { if (token !== current) throw new RelayError('cancelled', 'Simulación cancelada.'); };
  port = {
    claim: () => { current = 'demo-private-' + ++next; expected = null; written = 0; verified = false; return current; },
    retire: token => { if (token === current) { current = null; expected = null; written = 0; verified = false; } },
    info: async () => ({ supported: demoAppUpdateScenario(serverId) !== 'unsupported', canInstall: demoAppUpdateScenario(serverId) !== 'permission', applicationId: 'io.fixture.relay', versionCode: 3, versionName: '1.2.0', signerSha256: 'b'.repeat(64) }),
    open: async (token, artifact) => { check(token); expected = artifact; },
    writeChunk: async (token, bytes) => { check(token); written += bytes.length; },
    verify: async token => {
      check(token); await delay(700); check(token);
      if (!expected || written !== expected.byteLength || demoAppUpdateScenario(serverId) === 'verify-error') throw new RelayError('app_update_invalid', 'Verificación simulada fallida.');
      verified = true; return { ...expected };
    },
    install: async token => { check(token); if (!verified) throw new RelayError('app_update_invalid', 'Simulación sin verificar.'); },
    requestInstallPermission: async token => { check(token); setDemoAppUpdateScenario(serverId, 'new'); },
  };
  ports.set(serverId, port); return port;
}
