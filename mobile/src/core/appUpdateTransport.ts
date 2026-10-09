import type { AppUpdateManifest } from '../../../protocol/appUpdate.ts';
import { APP_UPDATE_METADATA_MAX_BYTES } from '../../../protocol/appUpdate.ts';
import { APP_UPDATE_MESSAGES, parseAppUpdateManifest } from './appUpdate.ts';
import { RelayError, type RelayErrorCode } from './client.ts';
import { utf8Bytes } from './agentMemory.ts';

function pending<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  if (signal?.aborted) return Promise.reject(new RelayError('cancelled', 'Descarga cancelada.'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  return Promise.race([operation, new Promise<never>((_, reject) => {
    abort = () => reject(new RelayError('cancelled', 'Descarga cancelada.'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new RelayError('timeout', 'Sin respuesta del Servidor.')), Math.max(0, timeoutMs));
  })]).finally(() => { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); });
}
async function boundedJSON(response: Response, signal?: AbortSignal, timeoutMs = 5000): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = Date.now() + timeoutMs;
  try {
    const length = response.headers?.get('Content-Length');
    if (length && (!/^\d+$/.test(length) || Number(length) > APP_UPDATE_METADATA_MAX_BYTES)) throw new Error('Size');
    if (!response.body) {
      const value: unknown = await pending(response.json(), signal, deadline - Date.now());
      if (utf8Bytes(JSON.stringify(value)) > APP_UPDATE_METADATA_MAX_BYTES) throw new Error('Size');
      return value;
    }
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await pending(reader.read(), signal, deadline - Date.now());
      if (chunk.done) break;
      size += chunk.value.byteLength; if (size > APP_UPDATE_METADATA_MAX_BYTES) throw new Error('Size'); chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Native read may still be settling. */ } } else { void response.body?.cancel?.().catch(() => {}); } }
}
async function assertResponse(response: Response, signal?: AbortSignal) {
  if (response.redirected) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
  if (response.ok) return;
  if ([401, 403, 426].includes(response.status)) {
    let value: unknown;
    try { value = await boundedJSON(response, signal); } catch (error) { if (error instanceof RelayError && error.code === 'cancelled') throw error; }
    const candidate = (value as { error?: { code?: unknown } } | null)?.error?.code;
    const allowed = ['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required', 'protocol_upgrade_required'];
    const code = typeof candidate === 'string' && allowed.includes(candidate) ? candidate as RelayErrorCode : response.status === 426 ? 'protocol_upgrade_required' : 'unauthorized';
    throw new RelayError(code, code === 'protocol_upgrade_required' ? 'Actualiza Relay para consultar el APK.' : 'Este Puente no autoriza al dispositivo. Empareja de nuevo.', response.status);
  }
  const code = [404, 405, 501].includes(response.status) ? 'app_update_unavailable' : response.status === 412 ? 'app_update_changed' : response.status === 429 ? 'app_update_busy' : 'app_update_invalid';
  throw new RelayError(code, APP_UPDATE_MESSAGES[code], response.status);
}
export async function readAppUpdateMetadata(response: Response, signal?: AbortSignal, timeoutMs = 5000): Promise<AppUpdateManifest> {
  try {
    await assertResponse(response, signal);
    return parseAppUpdateManifest(await boundedJSON(response, signal, timeoutMs), response.headers?.get('ETag') ?? null);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
  }
}
export interface AppUpdateDownloadOptions {
  signal: AbortSignal;
  onDenial?: (error: RelayError) => void;
  writeChunk: (bytes: Uint8Array) => Promise<void>;
  onProgress: (received: number) => void;
}
export async function streamAppUpdate(response: Response, manifest: Extract<AppUpdateManifest, { state: 'published' }>, options: AppUpdateDownloadOptions): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = Date.now() + 600000;
  const current = () => {
    if (options.signal.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
    if (Date.now() >= deadline) throw new RelayError('timeout', 'La descarga caducó. Revisa y descarga de nuevo.');
  };
  try {
    current(); await assertResponse(response, options.signal); current();
    if (response.status !== 200 || response.headers.get('ETag') !== '"' + manifest.revision + '"'
      || response.headers.get('Content-Type') !== 'application/vnd.android.package-archive'
      || response.headers.get('Content-Length') !== String(manifest.artifact.byteLength)
      || !response.body) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
    reader = response.body.getReader(); let received = 0;
    while (true) {
      const chunk = await pending(reader.read(), options.signal, Math.min(30000, deadline - Date.now())); current();
      if (chunk.done) break;
      if (received + chunk.value.byteLength > manifest.artifact.byteLength) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
      for (let offset = 0; offset < chunk.value.byteLength; offset += 65536) {
        current(); const bytes = chunk.value.subarray(offset, Math.min(offset + 65536, chunk.value.byteLength));
        await pending(options.writeChunk(bytes), options.signal, Math.min(30000, deadline - Date.now())); current(); received += bytes.byteLength; options.onProgress(received);
      }
    }
    if (received !== manifest.artifact.byteLength) throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('app_update_invalid', APP_UPDATE_MESSAGES.app_update_invalid);
  } finally { if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Native read may still be settling. */ } } else { void response.body?.cancel?.().catch(() => {}); } }
}
