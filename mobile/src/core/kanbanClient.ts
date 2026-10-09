import type { KanbanCommentsPage, KanbanCommentMutationResult, KanbanCommentRequest, KanbanCreateItemRequest, KanbanItemDetail, KanbanItemMutationResult, KanbanItemsPage, KanbanItemsQuery, KanbanNotifyReceipt, KanbanNotifyRequest, KanbanPageQuery, KanbanUpdateItemRequest } from '../../../protocol/kanban.ts';
import { KANBAN_ERROR_STATUS, KANBAN_REQUEST_MAX_BYTES, KANBAN_RESPONSE_MAX_BYTES } from '../../../protocol/kanban.ts';
import { RelayError, type RelayErrorCode } from './client.ts';
import { record, utf8Size, validWorkComment, validWorkComments, validWorkDetail, validWorkItem, validWorkPage, validWorkReceipt, workId, workRequestId } from './kanban.ts';
export interface KanbanClient {
  items(query?: KanbanItemsQuery): Promise<KanbanItemsPage>;
  item(id: string): Promise<KanbanItemDetail>;
  comments(id: string, query?: KanbanPageQuery): Promise<KanbanCommentsPage>;
  create(body: KanbanCreateItemRequest): Promise<KanbanItemMutationResult>;
  update(id: string, body: KanbanUpdateItemRequest): Promise<KanbanItemMutationResult>;
  comment(id: string, body: KanbanCommentRequest): Promise<KanbanCommentMutationResult>;
  notify(id: string, body: KanbanNotifyRequest): Promise<KanbanNotifyReceipt>;
  receipt(id: string, requestId: string): Promise<KanbanNotifyReceipt>;
}
export const WORK_MESSAGES: Partial<Record<RelayErrorCode, string>> = {
  kanban_conflict:'El elemento cambió. Recarga y revisa los cambios.', kanban_dependency_blocked:'Una dependencia sigue pendiente.',
  kanban_notification_busy:'Ya existe un aviso pendiente o un Turno sin resultado confirmado.', kanban_notification_uncertain:'Resultado incierto. Consulta el recibo; no vuelvas a enviar.',
  kanban_store_full:'Trabajo alcanzó su límite. No se guardaron cambios.', kanban_store_unavailable:'No se pudo leer o guardar Trabajo. Reintenta.',
  kanban_agent_unavailable:'El Agente ya no está disponible en este Servidor.', kanban_invalid_request:'Revisa los datos del elemento.',
  kanban_not_found:'El elemento o recibo no está disponible.', server_paused:'Pausa general activa. El elemento sigue guardado.',
  device_revoked:'Este teléfono fue revocado. Empareja de nuevo.', unauthorized:'Empareja de nuevo este teléfono.', key_unknown:'Empareja de nuevo este teléfono.',
  pairing_required:'Empareja de nuevo este teléfono.', protocol_upgrade_required:'Actualiza Relay o el Puente.', kanban_unsupported:'Actualiza el Puente para usar Trabajo.',
};
export function workFailure(error: unknown): string {
  return error instanceof RelayError ? WORK_MESSAGES[error.code] ?? 'No se pudo conectar con Trabajo. Reintenta.' : 'No se pudo cargar Trabajo. Reintenta.';
}
const invalid = () => new RelayError('kanban_store_unavailable', 'Respuesta de Trabajo no disponible.');
export function createKanbanClient(request: (method: string, path: string, body?: unknown) => Promise<Response>, timeoutMs = 5000): KanbanClient {
  async function read<T>(method: string, path: string, validate: (v: unknown) => v is T, body?: unknown): Promise<T> {
    if (body !== undefined && utf8Size(JSON.stringify(body)) > KANBAN_REQUEST_MAX_BYTES) throw new RelayError('kanban_invalid_request', WORK_MESSAGES.kanban_invalid_request!);
    try {
      const response = await request(method,path,body);
      const length = response.headers?.get('Content-Length');
      if (length && (!/^\d+$/.test(length) || Number(length) > KANBAN_RESPONSE_MAX_BYTES)) { await response.body?.cancel(); throw invalid(); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reader = response.body?.getReader();
      // A Puente older than Work answers its unknown routes with 404/405/501 and no Work error code.
      const outdated = [404,405,501].includes(response.status);
      let value: unknown;
      try {
        value = await Promise.race([
          (async () => {
            if (!reader) { const v: unknown = await response.json(); if (utf8Size(JSON.stringify(v)) > KANBAN_RESPONSE_MAX_BYTES) throw invalid(); return v; }
            let size = 0; const chunks: Uint8Array[] = [];
            for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > KANBAN_RESPONSE_MAX_BYTES) throw invalid(); chunks.push(chunk.value); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
            return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
          })(),
          new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new RelayError('timeout','Trabajo no responde.')),timeoutMs); }),
        ]);
      } catch (error) { if (outdated && !(error instanceof RelayError)) throw new RelayError('kanban_unsupported','Trabajo no disponible.',response.status); throw error; }
      finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* A pending read is cancelled. */ } } }
      if (!response.ok) {
        const code = record(value) && record(value.error) ? value.error.code : null;
        const auth = ['device_revoked','unauthorized','key_unknown','pairing_required','protocol_upgrade_required','rate_limited','tailnet_required'];
        const known = typeof code === 'string' && (Object.hasOwn(KANBAN_ERROR_STATUS,code) || auth.includes(code));
        throw new RelayError(known ? code as RelayErrorCode : outdated ? 'kanban_unsupported' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'kanban_store_unavailable', 'Trabajo no disponible.',response.status);
      }
      if (!validate(value)) throw invalid();
      return value;
    } catch (error) {
      if (error instanceof RelayError) throw new RelayError(error.code, WORK_MESSAGES[error.code] ?? 'Trabajo no disponible.',error.status);
      throw invalid();
    }
  }
  const path = (id: string) => { if (!workId(id)) throw invalid(); return `/v1/kanban/items/${id}`; };
  const query = (q: KanbanItemsQuery = {}) => {
    const p = new URLSearchParams();
    if (q.column) p.set('column',q.column);
    if (q.cursor) { if (!/^[A-Za-z0-9_-]{1,512}$/.test(q.cursor)) throw invalid(); p.set('cursor',q.cursor); }
    if (q.limit !== undefined) { if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) throw invalid(); p.set('limit',String(q.limit)); }
    return p.size ? `?${p}` : '';
  };
  const result = (v: unknown): v is KanbanItemMutationResult => record(v) && workRequestId(v.requestId) && validWorkItem(v.item);
  const boundResult = (body: {requestId:string}, id?: string) => (v: unknown): v is KanbanItemMutationResult => result(v) && v.requestId === body.requestId && (!id || v.item.id === id);
  const boundReceipt = (id: string, requestId: string, body?: KanbanNotifyRequest) => (v: unknown): v is KanbanNotifyReceipt => validWorkReceipt(v) && v.itemId === id && v.requestId === requestId && (!body || v.agentId === body.agentId && v.itemRevision === body.revision);
  return {
    items:q=>read('GET',`/v1/kanban/items${query(q)}`,validWorkPage),
    item:id=>read('GET',path(id),(v):v is KanbanItemDetail=>validWorkDetail(v) && v.item.id===id),
    comments:(id,q)=>read('GET',`${path(id)}/comments${query(q)}`,validWorkComments),
    create:body=>read('POST','/v1/kanban/items',boundResult(body),body),
    update:(id,body)=>read('PATCH',path(id),boundResult(body,id),body),
    comment:(id,body)=>read('POST',`${path(id)}/comments`,(v):v is KanbanCommentMutationResult=>boundResult(body,id)(v) && record(v) && validWorkComment(v.comment),body),
    notify:async (id,body)=>read('POST',`${path(id)}/notify`,boundReceipt(id,body.requestId,body),body),
    receipt:async (id,requestId)=>{ if (!workRequestId(requestId)) throw invalid(); return read('GET',`${path(id)}/notifications/${requestId}`,boundReceipt(id,requestId)); },
  };
}
