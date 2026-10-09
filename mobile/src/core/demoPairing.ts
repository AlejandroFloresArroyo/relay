import type { PairingResponse } from '../../../protocol/protocol.ts';
import type { PairingFailure } from './pairing.ts';

export const DEMO_PAIRING_RESPONSE: PairingResponse = {
  deviceKey: 'demo-paired-device-key',
  device: { id: 'demo-phone-device', name: 'S23 de Ana', pairedAt: 1_700_000_000_000, revokedAt: null },
  server: { name: 'atlas' },
};
export const DEMO_PAIRING_ADDRESS = 'http://atlas.tailnet-7f2c.ts.net:8650';
export const DEMO_PAIRING_CODE = '01234-56789';
export const DEMO_PAIRING_QR = JSON.stringify({ type: 'relay-pair', version: 1, url: DEMO_PAIRING_ADDRESS, code: '0123456789' });
export const DEMO_PAIRING_STATES: { id: 'intro' | 'scan' | 'manual' | 'success' | 'permission' | 'exchanging' | 'saving' | 'legacy' | PairingFailure; label: string }[] = [
  { id: 'intro', label: 'Agregar' }, { id: 'scan', label: 'Cámara' }, { id: 'manual', label: 'Manual' },
  { id: 'success', label: 'Emparejado' }, { id: 'pairing_invalid', label: 'Caducado / usado' },
  { id: 'unreachable', label: 'Sin respuesta' }, { id: 'device_revoked', label: 'Revocado' },
  { id: 'permission', label: 'Sin permiso' }, { id: 'legacy', label: 'Llave antigua' },
  { id: 'key_unknown', label: 'Llave rechazada' }, { id: 'rate_limited', label: 'Espera' },
  { id: 'tailnet_required', label: 'Sin tailnet' }, { id: 'unavailable', label: 'Puente no disponible' },
  { id: 'bad_request', label: 'Protocolo inválido' }, { id: 'invalid_input', label: 'Entrada inválida' },
  { id: 'invalid_qr', label: 'QR inválido' }, { id: 'update_bridge', label: 'Puente antiguo' },
  { id: 'storage', label: 'Fallo al guardar' }, { id: 'exchanging', label: 'Canjeando…' }, { id: 'saving', label: 'Guardando…' },
  { id: 'server_missing', label: 'Servidor eliminado' },
];

/** Same HTTP boundary as the real flow, without consulting a server or Hermes. */
export const demoPairingFetch: typeof fetch = async (url) => new Response(JSON.stringify(
  String(url).endsWith('/health') ? { ok: true, service: 'relayd', version: 'demo', protocolVersion: 1, minAppProtocolVersion: 1 } : DEMO_PAIRING_RESPONSE,
), { status: String(url).endsWith('/health') ? 200 : 201, headers: { 'Content-Type': 'application/json' } });

export const DEMO_SERVER_LIST_STATES = [
  { count: 0, label: '0 Servidores' }, { count: 1, label: '1 Servidor' }, { count: 2, label: '2 Servidores' },
] as const;
export const DEMO_SERVER_STORAGE_ERROR = 'El llavero de Servidores no se pudo leer. Vuelve a abrir Relay para reintentar.';
