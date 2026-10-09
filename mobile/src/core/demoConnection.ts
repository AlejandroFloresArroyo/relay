import { PROTOCOL_VERSION, MIN_APP_PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
import type { Health } from '../../../protocol/protocol.ts';
import type { VpnAvailability } from '../native/vpnContract.ts';
import { RelayError, type RelayErrorCode } from './client.ts';

export const DEMO_CONNECTION_SCENARIOS = [
  { id: 'compatible', name: 'Compatible', protocolKind: 'compatible', label: null },
  { id: 'offline', name: 'Sin respuesta', protocolKind: null, label: 'SIN RESPUESTA' },
  { id: 'offline_vpn_available', name: 'VPN activa para Relay', protocolKind: null, label: 'SIN RESPUESTA' },
  { id: 'offline_vpn_absent', name: 'Red de Relay sin VPN', protocolKind: null, label: 'SIN RESPUESTA' },
  { id: 'offline_vpn_unknown', name: 'VPN desconocida', protocolKind: null, label: 'SIN RESPUESTA' },
  { id: 'legacy', name: 'Puente legado', protocolKind: 'update_bridge', label: null },
  { id: 'bridge_old', name: 'Puente viejo', protocolKind: 'update_bridge', label: null },
  { id: 'app_old', name: 'Relay viejo', protocolKind: 'update_app', label: null },
  { id: 'future', name: 'Puente futuro compatible', protocolKind: 'compatible', label: null },
  { id: 'invalid', name: 'Protocolo inválido', protocolKind: 'invalid', label: null },
  { id: 'legacy_key', name: 'Legado y llave rechazada', protocolKind: 'update_bridge', label: 'LLAVE RECHAZADA' },
  { id: 'device_revoked', name: 'Dispositivo revocado', protocolKind: 'compatible', label: 'DISPOSITIVO REVOCADO' },
  { id: 'key_unknown', name: 'Llave rechazada', protocolKind: 'compatible', label: 'LLAVE RECHAZADA' },
  { id: 'pairing_required', name: 'Emparejamiento necesario', protocolKind: 'compatible', label: 'EMPAREJAMIENTO NECESARIO' },
  { id: 'cleartext_blocked', name: 'HTTP bloqueado', protocolKind: 'compatible', label: 'HTTP BLOQUEADO POR ANDROID' },
  { id: 'rate_limited', name: 'Demasiados intentos', protocolKind: 'compatible', label: 'DEMASIADOS INTENTOS' },
  { id: 'tailnet_required', name: 'Tailnet necesaria', protocolKind: 'compatible', label: 'TAILNET NECESARIA' },
] as const;

export type DemoConnectionScenario = (typeof DEMO_CONNECTION_SCENARIOS)[number]['id'];
const selected = new Map<string, DemoConnectionScenario>();

export function demoConnectionScenario(serverId: string): DemoConnectionScenario {
  return selected.get(serverId) ?? (serverId === 'atlas' ? 'compatible' : 'offline');
}

export function setDemoConnection(serverId: string, scenario: DemoConnectionScenario): void {
  selected.set(serverId, scenario);
}

export function demoConnectionError(serverId: string): RelayError | null {
  const scenario = demoConnectionScenario(serverId);
  const code: RelayErrorCode | null = scenario.startsWith('offline') ? 'timeout' : scenario === 'legacy_key' ? 'unauthorized'
    : ['device_revoked', 'key_unknown', 'pairing_required', 'cleartext_blocked', 'rate_limited', 'tailnet_required'].includes(scenario) ? scenario as RelayErrorCode : null;
  return code ? new RelayError(code, 'Demo connection failure') : null;
}

export function demoConnectionHealth(serverId: string): Health {
  const scenario = demoConnectionScenario(serverId);
  if (scenario.startsWith('offline')) throw new RelayError('timeout', 'Demo timeout');
  const base: Health = { ok: true, service: 'relayd', version: '0.1.0' };
  if (scenario === 'legacy' || scenario === 'legacy_key') return base;
  if (scenario === 'bridge_old') return { ...base, protocolVersion: 0 };
  if (scenario === 'app_old') return { ...base, protocolVersion: 3, minAppProtocolVersion: 3 };
  if (scenario === 'future') return { ...base, protocolVersion: 3, minAppProtocolVersion: 1 };
  if (scenario === 'invalid') return { ...base, protocolVersion: 1.5, minAppProtocolVersion: 1 };
  // Only atlas has a Puente with `metrics` and `chat_files`: homelab shows «Actualiza el Puente» when it answers.
  return { ...base, protocolVersion: PROTOCOL_VERSION, minAppProtocolVersion: MIN_APP_PROTOCOL_VERSION, ...(serverId === 'atlas' ? { capabilities: { metrics: { version: 1, minAppVersion: 1 }, chat_files: { version: 1, minAppVersion: 1 } } } : {}) };
}

/** Synthetic app-default network metadata, never a claim about the installed VPN provider. */
export function demoVpnAvailability(serverId: string): VpnAvailability {
  const scenario = demoConnectionScenario(serverId);
  return scenario === 'offline_vpn_available' ? 'available' : scenario === 'offline_vpn_absent' ? 'absent' : 'unknown';
}
