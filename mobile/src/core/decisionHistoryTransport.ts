import type { DecisionHistory } from '../../../protocol/protocol.ts';
import { RelayError } from './client.ts';
import { parseDecisionHistory } from './decisions.ts';

// The durable ledger is capped at 16 MiB; reserve room for full uncertain choices and previews.
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
const unavailable = () => new RelayError('decision_history_unavailable','El historial no se pudo validar o excede el límite seguro. Actualiza el Puente.');

/** Bound legacy payloads before JSON materialization, without dropping unconfirmed choices. */
export async function readDecisionHistoryResponse(response: Response, timeoutMs: number): Promise<DecisionHistory> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retired=false;
  try {
    const length=response.headers?.get('Content-Length');
    if (length != null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_HISTORY_BYTES)) throw unavailable();
    if (!response.body) throw unavailable();
    reader=response.body.getReader();
    const current=reader;
    const payload=async (): Promise<unknown> => {
      const chunks: Uint8Array[]=[]; let size=0;
      while (!retired) {
        const chunk=await current.read();
        if (retired) throw unavailable();
        if (chunk.done) break;
        size+=chunk.value.byteLength;
        if (size > MAX_HISTORY_BYTES) throw unavailable();
        chunks.push(chunk.value);
      }
      const bytes=new Uint8Array(size); let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    };
    const value=await Promise.race([payload(),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new RelayError('timeout','Sin respuesta del Servidor.')),timeoutMs);
    })]);
    if (!response.ok) {
      const code=value && typeof value==='object' && 'error' in value && value.error && typeof value.error==='object' && 'code' in value.error ? value.error.code:null;
      const safe=['device_revoked','key_unknown','unauthorized','pairing_required','protocol_upgrade_required','rate_limited','tailnet_required','decision_store_unavailable','decision_history_unavailable'] as const;
      const preserved=safe.find(known=>known===code);
      throw new RelayError(preserved ?? ([401,403].includes(response.status) ? 'unauthorized':'decision_history_unavailable'),'No se pudo consultar el historial del Puente. Reintenta.',response.status);
    }
    return parseDecisionHistory(value);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw unavailable();
  } finally {
    retired=true;clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(()=>{});
      try { reader.releaseLock(); } catch { /* Pending native reads retire when they settle. */ }
    } else { void response.body?.cancel().catch(()=>{}); }
  }
}
