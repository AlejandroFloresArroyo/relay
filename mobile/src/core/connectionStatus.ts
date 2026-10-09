import { RelayError } from './client.ts';
import type { ProtocolCompatibility } from './protocolVersion.ts';

/** The server slot is always mounted; its presentation must not rely on the row's reachability. */
export function serverConnectionPresentation(snapshot: {
  reachable: boolean | null;
  down: ConnectionDiagnosis | null;
  protocol: ProtocolCompatibility | null;
  protocolStale: boolean;
}) {
  const protocol = snapshot.protocol?.kind === 'compatible' ? null : snapshot.protocol;
  const diagnosis = snapshot.reachable === false ? snapshot.down ?? classifyConnectionError(null) : null;
  if (!protocol && !diagnosis) return null;
  return { protocol, diagnosis, stale: snapshot.protocolStale };
}

export interface ConnectionDiagnosis {
  kind: 'unreachable' | 'known';
  label: string;
  hint: string;
  action: 'pair' | 'retry' | 'tailscale';
  automaticRetry: boolean;
}

export function classifyConnectionError(error: unknown): ConnectionDiagnosis {
  const known = (label: string, hint: string, action: ConnectionDiagnosis['action'], automaticRetry = false): ConnectionDiagnosis =>
    ({ kind: 'known', label, hint, action, automaticRetry });
  if (error instanceof RelayError) {
    switch (error.code) {
      case 'device_revoked': return known('DISPOSITIVO REVOCADO', 'Este dispositivo fue revocado. Empareja de nuevo con el Puente.', 'pair');
      case 'key_unknown':
      case 'unauthorized': return known('LLAVE RECHAZADA', 'El Puente no acepta la llave guardada. Empareja de nuevo.', 'pair');
      case 'pairing_required': return known('EMPAREJAMIENTO NECESARIO', 'Empareja este teléfono con el Puente del Servidor.', 'pair');
      case 'cleartext_blocked': return known('HTTP BLOQUEADO POR ANDROID', 'Usa la dirección HTTP con el nombre completo de tailnet: máquina.tailnet.ts.net.', 'retry');
      case 'rate_limited': return known('DEMASIADOS INTENTOS', 'Espera unos minutos antes de reintentar.', 'retry');
      case 'tailnet_required': return known('TAILNET NECESARIA', 'Conecta este teléfono a tu tailnet en Tailscale y reintenta.', 'tailscale');
      case 'bad_request': return known('SOLICITUD RECHAZADA', 'Comprueba la dirección del Servidor y reintenta.', 'retry');
    }
  }
  return {
    kind: 'unreachable', label: 'SIN RESPUESTA',
    hint: 'Comprueba que Tailscale esté encendido en este teléfono y que la máquina esté encendida con el Puente corriendo.',
    action: 'tailscale', automaticRetry: true,
  };
}
