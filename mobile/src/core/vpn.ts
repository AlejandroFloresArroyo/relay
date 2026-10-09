import type { ConnectionDiagnosis } from './connectionStatus.ts';
import type { VpnAvailability, VpnReading, VpnReason } from '../native/vpnContract.ts';
export const UNKNOWN_VPN: VpnReading = { version: 1, scope: 'relay-default-network', generation: 0, sequence: 0, vpn: 'unknown', reason: 'unavailable' };
export function vpnConnectionDiagnosis(diagnosis: ConnectionDiagnosis, vpn: VpnAvailability, bridgeResponded = false): ConnectionDiagnosis {
  if (diagnosis.kind !== 'unreachable') return diagnosis;
  if (bridgeResponded) return { ...diagnosis, kind: 'known', label: 'EL PUENTE RESPONDE',
    hint: 'El Puente respondió, pero no se pudieron cargar los datos. Reintenta.', action: 'retry' };
  if (vpn === 'absent') return { ...diagnosis, label: 'SIN VPN PARA RELAY',
    hint: 'La red actual de Relay no usa VPN. Comprueba Tailscale; Android no confirma su estado.', action: 'tailscale' };
  if (vpn === 'available') return { ...diagnosis, label: 'SERVIDOR SIN RESPUESTA',
    hint: 'VPN activa para Relay, sin identificar al proveedor. No hubo respuesta del Puente; no sabemos si falla el Servidor o la ruta.', action: 'retry' };
  return { ...diagnosis, hint: 'No se pudo comprobar la VPN de Relay. Reintenta. Comprueba Tailscale y que el Puente esté corriendo en el Servidor.' };
}
export function validVpnReading(value: unknown, generation: number): VpnReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 6 || v.version !== 1 || v.scope !== 'relay-default-network' || v.generation !== generation
    || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || Number(v.generation) > 2147483647
    || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 0
    || typeof v.vpn !== 'string' || !['available', 'absent', 'unknown'].includes(v.vpn)
    || typeof v.reason !== 'string' || !['capabilities', 'no-default-or-blocked', 'blocked', 'transition', 'inactive', 'unavailable'].includes(v.reason)
    || (v.vpn !== 'unknown' && v.reason !== 'capabilities')) return null;
  return { version: 1, scope: 'relay-default-network', generation, sequence: v.sequence as number, vpn: v.vpn as VpnAvailability, reason: v.reason as VpnReason };
}
