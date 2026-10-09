import { MIN_APP_PROTOCOL_VERSION, PROTOCOL_VERSION, type Health } from '../../protocol/protocol.ts';

export function createHealth(version: string, capabilities: NonNullable<Health['capabilities']>): Health {
  return { ok: true, service: 'relayd', version, protocolVersion: PROTOCOL_VERSION, minAppProtocolVersion: MIN_APP_PROTOCOL_VERSION, capabilities };
}
