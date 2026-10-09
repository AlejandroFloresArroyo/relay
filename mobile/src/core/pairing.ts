import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_QR_TYPE, PAIRING_QR_VERSION, type PairingQrPayload } from '../../../protocol/protocol.ts';

export type PairingFailure = 'invalid_input' | 'invalid_qr' | 'update_bridge' | 'pairing_invalid' | 'key_unknown' | 'device_revoked' | 'rate_limited' | 'tailnet_required' | 'unavailable' | 'bad_request' | 'unreachable' | 'storage' | 'server_missing';

export class PairingError extends Error {
  readonly code: PairingFailure;
  readonly retryAfterSeconds: number | null;
  constructor(code: PairingFailure, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'PairingError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function normalizePairingCode(input: string): string {
  const code = input.replace(/[ -]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== PAIRING_CODE_LENGTH || [...code].some((c) => !PAIRING_CODE_ALPHABET.includes(c))) throw new PairingError('invalid_input');
  return code;
}

export function formatPairingCode(input: string): string {
  const code = normalizePairingCode(input);
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Parse the literal origin rather than letting URL silently fix paths, Unicode or credentials. */
export function validateServerAddress(input: string): string {
  const match = /^(?:http:\/\/)?([A-Za-z0-9.-]+)(?::([0-9]+))?$/i.exec(input.trim());
  if (!match) throw new PairingError('invalid_input');
  const host = match[1].toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 4 || labels.slice(-2).join('.') !== 'ts.net' || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new PairingError('invalid_input');
  }
  const port = match[2] === undefined ? 8650 : Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new PairingError('invalid_input');
  return `http://${host}:${port}`;
}

export function parsePairingQr(text: string): PairingQrPayload {
  if (new TextEncoder().encode(text).byteLength > 2048) throw new PairingError('invalid_qr');
  try {
    const value = JSON.parse(text);
    if (value?.type !== PAIRING_QR_TYPE || value?.version !== PAIRING_QR_VERSION || typeof value?.url !== 'string' || typeof value?.code !== 'string' || !/^http:\/\//i.test(value.url)) throw new PairingError('invalid_qr');
    return { type: PAIRING_QR_TYPE, version: PAIRING_QR_VERSION, url: validateServerAddress(value.url), code: normalizePairingCode(value.code) };
  } catch {
    throw new PairingError('invalid_qr');
  }
}

export interface PairingFailureView {
  kind: PairingFailure;
  title: string;
  hint: string;
}

export function describePairingFailure(error: unknown): PairingFailureView {
  const kind = error instanceof PairingError ? error.code : 'unreachable';
  const copy: Record<PairingFailure, [string, string]> = {
    invalid_input: ['DIRECCIÓN O CÓDIGO INVÁLIDO', 'Usa una dirección HTTP completa de tu tailnet (*.ts.net) y un código de diez caracteres.'],
    invalid_qr: ['CÓDIGO QR NO VÁLIDO', 'Escanea el QR que muestra relayd pair. Debe ser compatible con esta versión de Relay.'],
    update_bridge: ['ACTUALIZA EL PUENTE', 'Este Puente aún no permite emparejar. Actualízalo y genera un código con relayd pair.'],
    pairing_invalid: ['CÓDIGO CADUCADO', 'Ese código ya se usó o caducó. Ejecuta relayd pair otra vez.'],
    key_unknown: ['LLAVE RECHAZADA', 'El Servidor ya no acepta la llave de este teléfono. Empareja de nuevo.'],
    device_revoked: ['ESTE TELÉFONO FUE REVOCADO', 'La llave del Servidor ya no vale. Empareja de nuevo.'],
    rate_limited: ['DEMASIADOS INTENTOS', error instanceof PairingError && error.retryAfterSeconds ? `Espera ${error.retryAfterSeconds} segundos antes de reintentar.` : 'Espera unos minutos antes de reintentar.'],
    tailnet_required: ['CONECTA TAILSCALE', 'El Puente solo permite emparejar desde tu tailnet. Enciende Tailscale en este teléfono.'],
    unavailable: ['EL PUENTE NO ESTÁ DISPONIBLE', 'No se pudo confirmar el emparejamiento. Reintenta. Si el código ya se usó, genera otro con relayd pair.'],
    bad_request: ['RESPUESTA DE EMPAREJAMIENTO INVÁLIDA', 'Comprueba que Relay y el Puente estén actualizados y genera otro código.'],
    unreachable: ['SIN RESPUESTA', 'Comprueba que Tailscale esté encendido en este teléfono y que la máquina esté encendida con el Puente corriendo.'],
    storage: ['NO SE PUDO GUARDAR', 'La llave sigue en este flujo. Reintenta guardar; no necesitas canjear el código otra vez. Si cierras Relay, genera otro código.'],
    server_missing: ['EL SERVIDOR YA NO ESTÁ GUARDADO', 'Vuelve a la lista de Servidores y agrégalo de nuevo. El código no se ha usado.'],
  };
  return { kind, title: copy[kind][0], hint: copy[kind][1] };
}

export async function exchangePairing({ baseUrl, code, fetch: doFetch, timeoutMs = 5000, beforePost }: { baseUrl: string; code: string; fetch: typeof fetch; timeoutMs?: number; beforePost?: () => void }): Promise<import('../../../protocol/protocol.ts').PairingResponse> {
  const url = validateServerAddress(baseUrl);
  const canonical = normalizePairingCode(code);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const health = await doFetch(`${url}/health`, { redirect: 'error', signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!health.ok) throw new PairingError('unreachable');
    const declaration = await health.json();
    if (declaration?.ok !== true || declaration?.service !== 'relayd' || typeof declaration?.version !== 'string') throw new PairingError('bad_request');
    if (declaration.protocolVersion === undefined || declaration.protocolVersion === 0) throw new PairingError('update_bridge');
    if (!Number.isSafeInteger(declaration.protocolVersion) || declaration.protocolVersion < 1) throw new PairingError('bad_request');
    beforePost?.();
    const res = await doFetch(`${url}/v1/pair`, {
      method: 'POST', redirect: 'error', signal: ctrl.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: canonical }),
    });
    if (res.status >= 300 && res.status < 400) throw new PairingError('unreachable');
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const known = ['pairing_invalid', 'key_unknown', 'device_revoked', 'rate_limited', 'tailnet_required', 'unavailable', 'bad_request'] as const;
      const kind = known.find((c) => c === body?.error?.code) ?? 'bad_request';
      const retry = res.headers.get('Retry-After');
      const seconds = retry && /^[0-9]+$/.test(retry) ? Number(retry) : null;
      throw new PairingError(kind, seconds && Number.isSafeInteger(seconds) ? seconds : null);
    }
    if (res.status !== 201) throw new PairingError('bad_request');
    const value = await res.json();
    const text = (s: unknown) => typeof s === 'string' && s.trim().length > 0 && s.length <= 256;
    if (!text(value?.deviceKey) || !text(value?.device?.id) || !text(value?.device?.name) || !text(value?.server?.name) || !Number.isSafeInteger(value?.device?.pairedAt) || value.device.pairedAt < 0 || value.device.revokedAt !== null) throw new PairingError('bad_request');
    return { deviceKey: value.deviceKey, device: { id: value.device.id, name: value.device.name, pairedAt: value.device.pairedAt, revokedAt: null }, server: { name: value.server.name } };
  } catch (error) {
    if (error instanceof PairingError) throw error;
    throw new PairingError('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

export type PairingFlowState =
  | { kind: 'idle' | 'exchanging' | 'saving' }
  | { kind: 'error'; error: PairingFailureView }
  | { kind: 'storage' }
  | { kind: 'success'; response: import('../../../protocol/protocol.ts').PairingResponse; url: string };

/** Shared HTTP wiring used by the screen and its deferred-health regression. */
export function createHttpPairingFlow({ fetch: doFetch, beforeExchange, ...options }: Omit<Parameters<typeof createPairingFlow>[0], 'exchange'> & { fetch: typeof fetch }) {
  return createPairingFlow({
    ...options,
    beforeExchange,
    exchange: (input) => exchangePairing({ ...input, fetch: doFetch, beforePost: beforeExchange }),
  });
}

/** Retains the issued key only for this flow when persistence fails. Never repeats a consumed POST. */
export function createPairingFlow({ exchange, persist, onState, beforeExchange }: {
  exchange: (input: { baseUrl: string; code: string }) => Promise<import('../../../protocol/protocol.ts').PairingResponse>;
  persist: (response: import('../../../protocol/protocol.ts').PairingResponse, url: string) => Promise<unknown>;
  onState?: (state: PairingFlowState) => void;
  beforeExchange?: () => void;
}) {
  let state: PairingFlowState = { kind: 'idle' };
  let pending: { response: import('../../../protocol/protocol.ts').PairingResponse; url: string } | null = null;
  let busy = false;
  const publish = (next: PairingFlowState) => { state = next; onState?.(next); };
  async function savePending() {
    if (!pending) return;
    publish({ kind: 'saving' });
    try {
      await persist(pending.response, pending.url);
      const response = pending.response;
      const url = pending.url;
      pending = null;
      publish({ kind: 'success', response, url });
    } catch {
      publish({ kind: 'storage' });
    }
  }
  return {
    state: () => state,
    reset() { if (!busy && !pending) publish({ kind: 'idle' }); },
    async submit(input: { baseUrl: string; code: string }) {
      if (busy || pending || state.kind === 'success') return;
      busy = true;
      publish({ kind: 'exchanging' });
      try {
        beforeExchange?.();
        const url = validateServerAddress(input.baseUrl);
        const response = await exchange({ baseUrl: url, code: normalizePairingCode(input.code) });
        pending = { response, url };
        await savePending();
      } catch (error) {
        publish({ kind: 'error', error: describePairingFailure(error) });
      } finally { busy = false; }
    },
    async retrySave() {
      if (busy || !pending) return;
      busy = true;
      try { await savePending(); } finally { busy = false; }
    },
  };
}
