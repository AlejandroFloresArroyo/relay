import { MIN_BRIDGE_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';

export type ProtocolCompatibility =
  | { kind: 'compatible'; bridgeVersion: number }
  | { kind: 'update_bridge'; bridgeVersion: number; message: 'Actualiza el Puente' }
  | { kind: 'update_app'; bridgeVersion: number; message: 'Actualiza Relay' }
  | { kind: 'invalid'; message: 'Respuesta de protocolo inválida' };

export function checkProtocolVersion(
  health: unknown,
  appVersion: number = PROTOCOL_VERSION,
  minBridgeVersion: number = MIN_BRIDGE_PROTOCOL_VERSION,
): ProtocolCompatibility {
  const invalid = (): ProtocolCompatibility => ({ kind: 'invalid', message: 'Respuesta de protocolo inválida' });
  if (!health || typeof health !== 'object' || Array.isArray(health)) return invalid();
  const h = health as Record<string, unknown>;
  if (h.ok !== true || h.service !== 'relayd' || typeof h.version !== 'string') return invalid();
  const hasVersion = Object.hasOwn(h, 'protocolVersion');
  const hasMinimum = Object.hasOwn(h, 'minAppProtocolVersion');
  const validNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (hasVersion && !validNumber(h.protocolVersion)) return invalid();
  if (hasMinimum && !validNumber(h.minAppProtocolVersion)) return invalid();
  if (!hasVersion) {
    if (hasMinimum) return invalid();
    return { kind: 'update_bridge', bridgeVersion: 0, message: 'Actualiza el Puente' };
  }
  const bridgeVersion = h.protocolVersion as number;
  const minimum = hasMinimum ? h.minAppProtocolVersion as number : bridgeVersion;
  if (minimum > bridgeVersion) return invalid();
  if (bridgeVersion < minBridgeVersion) return { kind: 'update_bridge', bridgeVersion, message: 'Actualiza el Puente' };
  if (appVersion < minimum) return { kind: 'update_app', bridgeVersion, message: 'Actualiza Relay' };
  return { kind: 'compatible', bridgeVersion };
}
