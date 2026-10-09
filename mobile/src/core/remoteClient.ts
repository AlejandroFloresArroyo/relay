// Requests to /v1/remote/*. Errors are normalized here by code (ADR 0006 «Peticiones remotas»),
// never through responseError, which turns any unknown 401/403 into `unauthorized`, nor through
// classifyConnectionError, which turns any unknown code into «SIN RESPUESTA».
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION, REMOTE_CAPABILITY_HEADER, REMOTE_ERROR_MESSAGES, REMOTE_ERROR_STATUS } from '../../../protocol/protocol.ts';
import type { RemoteErrorCode, RemoteStatus } from '../../../protocol/protocol.ts';
import type { NegotiatedCapability, RemoteToolState } from './remoteCapabilities.ts';
import { createSseDecoder } from './sse.ts';

export type RemoteFailureKind =
  /** Nothing was sent: no current advertisement includes this capability at this version. */
  | 'not_offered'
  | 'no_response'
  /** 426, or a 404 other than remote_not_found: read /health again and recompute. Never «no existe». */
  | 'bridge_changed'
  /** The existing pairing and limiter flows (RelayError codes of the same name). */
  | 'auth'
  | 'remote'
  | 'unexpected';

const MESSAGES: Record<Exclude<RemoteFailureKind, 'remote' | 'auth'>, string> = {
  not_offered: 'Esta herramienta no está disponible ahora en este Servidor.',
  no_response: 'Sin respuesta',
  bridge_changed: 'El Puente cambió. Comprobando sus herramientas otra vez.',
  unexpected: 'El Puente respondió algo inesperado.',
};
const AUTH_MESSAGES = {
  key_unknown: 'El Puente no acepta la llave guardada. Empareja de nuevo.',
  device_revoked: 'Este dispositivo fue revocado. Empareja de nuevo con el Puente.',
  rate_limited: 'Demasiados intentos. Espera unos minutos antes de reintentar.',
  tailnet_required: 'Conecta este teléfono a tu tailnet en Tailscale y reintenta.',
} as const;
type AuthCode = keyof typeof AUTH_MESSAGES;

export class RemoteFailure extends Error {
  kind: RemoteFailureKind;
  code?: RemoteErrorCode | AuthCode;
  status?: number;
  constructor(kind: RemoteFailureKind, detail: { code?: RemoteErrorCode | AuthCode; status?: number } = {}) {
    super(kind === 'remote' ? REMOTE_ERROR_MESSAGES[detail.code as RemoteErrorCode]
      : kind === 'auth' ? AUTH_MESSAGES[detail.code as AuthCode] : MESSAGES[kind]);
    this.name = 'RemoteFailure';
    this.kind = kind;
    if (detail.code !== undefined) this.code = detail.code;
    if (detail.status !== undefined) this.status = detail.status;
  }
}

export interface RemoteTransport { baseUrl: string; key: string; fetch: typeof fetch; timeoutMs?: number }

function normalize(status: number, code: unknown): RemoteFailure {
  if (status === 404) return code === 'remote_not_found' ? new RemoteFailure('remote', { code }) : new RemoteFailure('bridge_changed');
  if (status === 426) return new RemoteFailure('bridge_changed');
  if (status === 401) return new RemoteFailure('auth', { code: 'key_unknown' });
  if ((status === 403 && (code === 'device_revoked' || code === 'tailnet_required')) || (status === 429 && code === 'rate_limited')) {
    return new RemoteFailure('auth', { code });
  }
  if (typeof code === 'string' && Object.hasOwn(REMOTE_ERROR_STATUS, code) && REMOTE_ERROR_STATUS[code as RemoteErrorCode] === status) {
    return new RemoteFailure('remote', { code: code as RemoteErrorCode });
  }
  return new RemoteFailure('unexpected', { status });
}

function errorCode(parsed: unknown): unknown {
  const error = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** The capability to send with, after the path check; throws when nothing may be sent. */
function target(path: string, offered: () => NegotiatedCapability | null): NegotiatedCapability {
  // Plain segments only: `..`, `.`, `//`, `?`, `#` or `%2e` could make fetch normalize the path out of
  // /v1/remote/ and send the key and capability somewhere else.
  if (!/^\/v1\/remote(\/[A-Za-z0-9_-]+)+$/.test(path)) throw new Error('Remote requests go only to /v1/remote/*.');
  const capability = offered();
  if (!capability) throw new RemoteFailure('not_offered');
  return capability;
}

function headers(transport: RemoteTransport, capability: NegotiatedCapability) {
  return {
    Authorization: `Bearer ${transport.key}`,
    [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    [REMOTE_CAPABILITY_HEADER]: `${capability.name}/${capability.version}`,
  };
}

/** A chunk of a transfer: a longer wait than control requests, and the person's cancel aborts it. */
export const TRANSFER_CHUNK_TIMEOUT_MS = 60_000;

interface RequestOptions { raw?: boolean; timeoutMs?: number; signal?: AbortSignal }

/**
 * `offered` is read right before sending; null sends nothing. A Uint8Array body goes raw as
 * application/octet-stream; `raw` answers a success's bytes instead of its JSON.
 */
async function remoteRequest(transport: RemoteTransport, offered: () => NegotiatedCapability | null, method: string, path: string, body?: unknown,
  options: RequestOptions = {}): Promise<unknown> {
  const capability = target(path, offered);
  // A local copy: calling it as transport.fetch(...) throws «Illegal invocation» in the browser.
  const doFetch = transport.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? transport.timeoutMs ?? 5000);
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const bytes = body instanceof Uint8Array;
  let response: Response;
  let text = '';
  let data: Uint8Array | null = null;
  try {
    response = await doFetch(`${transport.baseUrl.replace(/\/+$/, '')}${path}`, {
      method, redirect: 'error', signal: controller.signal,
      headers: {
        Accept: options.raw ? 'application/octet-stream' : 'application/json',
        ...headers(transport, capability),
        ...(body !== undefined ? { 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' } : {}),
      },
      body: body === undefined ? undefined : bytes ? body as Uint8Array<ArrayBuffer> : JSON.stringify(body),
    });
    if (options.raw && response.ok) data = new Uint8Array(await response.arrayBuffer());
    else text = await response.text();
  } catch {
    throw new RemoteFailure('no_response');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
  if (data) return data;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (response.ok) {
    if (parsed === undefined) throw new RemoteFailure('unexpected', { status: response.status });
    return parsed;
  }
  throw normalize(response.status, errorCode(parsed));
}

/**
 * GET an SSE stream under /v1/remote/*: each event's `data` goes to `onData`. Resolves when the stream
 * ends or `signal` aborts; rejects with `no_response` when nothing arrives for `idleMs` (the Puente
 * sends a keepalive every 15 s), or with the normalized error of a refused request.
 */
async function remoteStream(transport: RemoteTransport, offered: () => NegotiatedCapability | null, path: string, lastEventId: number,
  onData: (data: string) => void, signal: AbortSignal, idleMs: number): Promise<void> {
  const capability = target(path, offered);
  const doFetch = transport.fetch;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  let timer = setTimeout(stop, transport.timeoutMs ?? 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let response: Response;
    try {
      response = await doFetch(`${transport.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'text/event-stream', ...headers(transport, capability), 'Last-Event-ID': String(lastEventId) },
      });
    } catch {
      if (signal.aborted) return;
      throw new RemoteFailure('no_response');
    }
    if (!response.ok) {
      let parsed: unknown;
      try { parsed = await response.json(); } catch { parsed = undefined; }
      throw normalize(response.status, errorCode(parsed));
    }
    if (!response.body) throw new RemoteFailure('unexpected', { status: response.status });
    reader = response.body.getReader();
    const text = new TextDecoder();
    const events = createSseDecoder(onData);
    while (true) {
      clearTimeout(timer);
      timer = setTimeout(stop, idleMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch {
        if (signal.aborted) return;
        throw new RemoteFailure('no_response');
      }
      if (chunk.done) { events.end(); return; }
      events.push(text.decode(chunk.value, { stream: true }));
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    void reader?.cancel().catch(() => {});
  }
}

export interface RemoteClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  /** A transfer chunk: raw bytes up with PUT (JSON answer), or down with GET (raw answer). */
  chunk(method: 'PUT' | 'GET', path: string, body: Uint8Array | undefined, signal: AbortSignal): Promise<unknown>;
  stream(path: string, lastEventId: number, onData: (data: string) => void, signal: AbortSignal, idleMs?: number): Promise<void>;
}

/**
 * Built only from an available tool. Every call re-reads `current` and sends nothing unless the tool
 * is still available at the same negotiated version. After the Puente changed or stopped answering,
 * this client sends nothing more: build a new one from the recomputed state.
 */
export function createRemoteClient(transport: RemoteTransport, built: RemoteToolState, current: () => RemoteToolState): RemoteClient {
  if (built.state !== 'available') throw new Error('A remote client needs an available tool.');
  const { name, version } = built.capability;
  let retired = false;
  const offered = () => {
    const now = current();
    return !retired && now.state === 'available' && now.capability.name === name && now.capability.version === version ? built.capability : null;
  };
  const retire = (error: unknown) => {
    if (error instanceof RemoteFailure && (error.kind === 'bridge_changed' || error.kind === 'no_response')) retired = true;
    return error;
  };
  return {
    async request(method, path, body) {
      try { return await remoteRequest(transport, offered, method, path, body); } catch (error) { throw retire(error); }
    },
    async chunk(method, path, body, signal) {
      try { return await remoteRequest(transport, offered, method, path, body, { raw: method === 'GET', timeoutMs: TRANSFER_CHUNK_TIMEOUT_MS, signal }); }
      catch (error) { throw retire(error); }
    },
    async stream(path, lastEventId, onData, signal, idleMs = 40_000) {
      try { await remoteStream(transport, offered, path, lastEventId, onData, signal, idleMs); } catch (error) { throw retire(error); }
    },
  };
}

/** GET /v1/remote/status with `RemoteToolStates.status`, read right before sending. */
export async function fetchRemoteStatus(transport: RemoteTransport, capability: () => NegotiatedCapability | null): Promise<RemoteStatus> {
  const body = await remoteRequest(transport, capability, 'GET', '/v1/remote/status');
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('serverNow' in body)
    || typeof body.serverNow !== 'number' || !Number.isSafeInteger(body.serverNow) || body.serverNow < 0) throw new RemoteFailure('unexpected', { status: 200 });
  // Leaves are read by remoteToolStates, which treats any it cannot read as not reported.
  return body as RemoteStatus;
}
