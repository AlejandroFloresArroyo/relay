import { ACTIVITY_ERROR_MESSAGES, type ActivityErrorCode, type ActivityPage, type ActivityQuery } from '../../../protocol/activity.ts';
import { ACTIVITY_RESPONSE_BYTES, parseActivityPage } from './activity.ts';
import { utf8Bytes } from './agentMemory.ts';
import { RelayError } from './client.ts';
/** Activity never forwards free-form upstream errors or unbounded response bodies. */
export async function readActivityResponse(response: Response, query: ActivityQuery, timeoutMs: number): Promise<ActivityPage> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if ([404, 405, 501].includes(response.status)) throw new RelayError('activity_unavailable', 'Actualiza el Puente para consultar Actividad.', response.status);
    const length = response.headers?.get('Content-Length');
    if (length && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > ACTIVITY_RESPONSE_BYTES)) throw new Error('Invalid size');
    const payload = async (): Promise<unknown> => {
      if (!response.body) {
        const value: unknown = await response.json();
        if (utf8Bytes(JSON.stringify(value)) > ACTIVITY_RESPONSE_BYTES) throw new Error('Invalid size');
        return value;
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > ACTIVITY_RESPONSE_BYTES) throw new Error('Invalid size');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    };
    const value = await Promise.race([payload(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayError('timeout', 'Sin respuesta del Servidor.')), timeoutMs);
    })]);
    if (!response.ok) {
      const code = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error ? value.error.code : null;
      if (typeof code === 'string' && Object.hasOwn(ACTIVITY_ERROR_MESSAGES, code)) throw new RelayError(code as ActivityErrorCode, ACTIVITY_ERROR_MESSAGES[code as ActivityErrorCode], response.status);
      const safe = ['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required', 'protocol_upgrade_required', 'rate_limited', 'tailnet_required'] as const;
      const preserved = safe.find(known => known === code);
      throw new RelayError(preserved ?? ([401, 403].includes(response.status) ? 'unauthorized' : 'activity_unavailable'), 'No se pudo consultar la Actividad del Puente. Reintenta.', response.status);
    }
    return parseActivityPage(value, query);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('activity_unavailable', 'La respuesta del Puente sobre la Actividad no es válida.');
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending native reads are cancelled asynchronously. */ } }
  }
}
