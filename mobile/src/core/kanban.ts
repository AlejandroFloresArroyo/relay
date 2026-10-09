import { KANBAN_COLUMNS, KANBAN_MAX_BLOCKERS_PER_ITEM, KANBAN_TITLE_MAX_CHARS, type KanbanColumn, type KanbanItem, type KanbanItemsPage, type KanbanCommentsPage, type KanbanItemDetail, type KanbanNotifyReceipt, type KanbanComment } from '../../../protocol/kanban.ts';
export const WORK_COLUMNS: Record<KanbanColumn, string> = { todo: 'Por hacer', in_progress: 'En curso', review: 'Revisión', blocked: 'Bloqueado', done: 'Hecho' };
export type WorkDraft = Pick<KanbanItem, 'title' | 'agentId' | 'column' | 'blockedBy'>;
export function validateWorkDraft(draft: WorkDraft, agents: string[], items: KanbanItem[], self?: string): string | null {
  if (!draft.title.trim() || /[\x00-\x1f\x7f]/.test(draft.title)) return 'Escribe un título sin caracteres de control.';
  if (draft.title.trim().length > KANBAN_TITLE_MAX_CHARS) return 'El título admite hasta 200 caracteres.';
  if (draft.agentId !== null && !agents.includes(draft.agentId)) return 'El Agente debe pertenecer a este Servidor.';
  if (!KANBAN_COLUMNS.includes(draft.column)) return 'Elige una columna.';
  if (draft.blockedBy.length > KANBAN_MAX_BLOCKERS_PER_ITEM) return 'Admite hasta 16 dependencias.';
  if (new Set(draft.blockedBy).size !== draft.blockedBy.length) return 'No repitas dependencias.';
  if (self && draft.blockedBy.includes(self)) return 'Un elemento no puede depender de sí mismo.';
  if (draft.blockedBy.some(id => !items.some(item => item.id === id))) return 'La dependencia debe pertenecer a este Servidor.';
  if (draft.column === 'blocked' && !draft.blockedBy.length) return 'Selecciona el elemento que lo bloquea.';
  const seen = new Set<string>();
  const reachesSelf = (id: string): boolean => {
    if (id === self) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return items.find(item => item.id === id)?.blockedBy.some(reachesSelf) ?? false;
  };
  if (self && draft.blockedBy.some(reachesSelf)) return 'Las dependencias no pueden formar un ciclo.';
  return null;
}

export function utf8Size(text: string): number {
  let size = 0;
  for (const point of text) { const code = point.codePointAt(0)!; size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return size;
}
export function validateWorkText(text: string, limit: number): string | null {
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return 'Escribe texto sin caracteres de control.';
  return utf8Size(text) > limit ? `El texto admite hasta ${limit} bytes UTF-8.` : null;
}
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const workId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const workRevision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const workRequestId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
const agentId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
const integer = (v: unknown, max: number, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const timestamp = (v: unknown) => integer(v, 4102444800000, 946684800000);
const column = (v: unknown): v is KanbanColumn => KANBAN_COLUMNS.includes(v as KanbanColumn);
const title = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && !!v && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const cursor = (v: unknown) => v === null || typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
export function validWorkItem(v: unknown): v is KanbanItem {
  return record(v) && workId(v.id) && integer(v.number, Number.MAX_SAFE_INTEGER, 1) && workRevision(v.revision)
    && title(v.title) && (v.agentId === null || agentId(v.agentId)) && column(v.column)
    && Array.isArray(v.blockedBy) && v.blockedBy.length <= 16 && v.blockedBy.every(workId)
    && new Set(v.blockedBy).size === v.blockedBy.length && !v.blockedBy.includes(v.id)
    && (v.column !== 'blocked' || v.blockedBy.length > 0) && integer(v.commentCount, 200)
    && timestamp(v.createdAt) && timestamp(v.updatedAt) && (v.updatedAt as number) >= (v.createdAt as number);
}
export function validWorkPage(v: unknown): v is KanbanItemsPage {
  if (!record(v) || !Array.isArray(v.items) || v.items.length > 500 || !v.items.every(validWorkItem)
    || new Set(v.items.map(item => item.id)).size !== v.items.length || !record(v.counts)
    || !KANBAN_COLUMNS.every(key => integer((v.counts as Record<string, unknown>)[key], 500))
    || !workRevision(v.revision) || !timestamp(v.observedAt) || !cursor(v.nextCursor)) return false;
  const counts = v.counts as Record<KanbanColumn, number>;
  return KANBAN_COLUMNS.reduce((sum, key) => sum + counts[key], 0) <= 500
    && KANBAN_COLUMNS.every(key => (v.items as KanbanItem[]).filter(item => item.column === key).length <= counts[key]);
}
const boundedString = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const author = (v: unknown) => record(v) && v.kind === 'device' && boundedString(v.id) && boundedString(v.name, 200);
export function validWorkComment(v: unknown): v is KanbanComment {
  return record(v) && workId(v.id) && integer(v.number, 200, 1) && author(v.author) && typeof v.text === 'string'
    && validateWorkText(v.text, 4096) === null && timestamp(v.createdAt);
}
export function validWorkComments(v: unknown): v is KanbanCommentsPage {
  return record(v) && Array.isArray(v.comments) && v.comments.length <= 200 && v.comments.every(validWorkComment)
    && new Set(v.comments.map(comment => comment.id)).size === v.comments.length
    && v.comments.every((comment, index, list) => index === 0 || comment.number > list[index - 1].number)
    && workRevision(v.itemRevision) && timestamp(v.observedAt) && cursor(v.nextCursor);
}
export function validWorkReceipt(v: unknown): v is KanbanNotifyReceipt {
  if (!record(v) || !workRequestId(v.requestId) || !workId(v.itemId) || !workRevision(v.itemRevision) || !agentId(v.agentId)
    || !author(v.requestedBy) || !timestamp(v.requestedAt) || !timestamp(v.updatedAt)
    || (v.updatedAt as number) < (v.requestedAt as number) || !(v.conversationId === null || boundedString(v.conversationId))) return false;
  if (v.state === 'pending') return v.runId === null && v.errorCode === null;
  if (v.state === 'uncertain') return (v.runId === null || boundedString(v.runId)) && v.errorCode === 'kanban_notification_uncertain';
  if (v.state === 'rejected') return v.runId === null && ['server_paused','agent_unavailable','configuration_conflict','conversation_unavailable','dependency_blocked','upstream_rejected'].includes(v.errorCode as string);
  return v.state === 'started' && boundedString(v.conversationId) && boundedString(v.runId) && v.errorCode === null
    && (v.turn === null || record(v.turn) && ['queued','running','waiting_for_approval','stopping','completed','failed','cancelled','unknown'].includes(v.turn.phase as string) && timestamp(v.turn.observedAt));
}
export function validWorkDetail(v: unknown): v is KanbanItemDetail {
  const dependencies = (list: unknown) => Array.isArray(list) && list.length <= 500 && list.every(dep => record(dep) && workId(dep.id) && integer(dep.number, Number.MAX_SAFE_INTEGER, 1) && title(dep.title) && column(dep.column));
  return record(v) && validWorkItem(v.item) && dependencies(v.blockers) && dependencies(v.blocks)
    && (v.latestNotification === null || validWorkReceipt(v.latestNotification) && v.latestNotification.itemId === v.item.id)
    && timestamp(v.observedAt);
}
export function notificationLabel(receipt: KanbanNotifyReceipt | null): string {
  if (!receipt) return 'Sin aviso enviado';
  if (receipt.state === 'pending') return 'Aviso registrado · resultado pendiente';
  if (receipt.state === 'uncertain') return 'Resultado incierto · no se reenviará automáticamente';
  if (receipt.state === 'rejected') {
    const reasons={server_paused:'Pausa general',agent_unavailable:'Agente no disponible',configuration_conflict:'configuración en conflicto',conversation_unavailable:'Conversación no disponible',dependency_blocked:'dependencia pendiente',upstream_rejected:'rechazado por Hermes'};
    return `Aviso rechazado · ${reasons[receipt.errorCode]}`;
  }
  const phases: Record<string, string> = {queued:'en cola',running:'en curso',waiting_for_approval:'esperando Aprobación',unknown:'estado no disponible',stopping:'deteniendo',completed:'completado',failed:'fallido',cancelled:'cancelado'};
  return `Turno aceptado · ${receipt.turn ? phases[receipt.turn.phase] ?? 'estado no disponible' : 'estado no disponible'}`;
}
export type WorkPreferences = { column: KanbanColumn; compact: boolean };
export function parseWorkPreferences(raw: string | null): WorkPreferences {
  try { const v: unknown = JSON.parse(raw ?? 'null'); if (record(v) && column(v.column) && typeof v.compact === 'boolean') return {column:v.column,compact:v.compact}; } catch { /* Ignore malformed local preferences. */ }
  return {column:'todo',compact:false};
}
export function workCache(source: string, page: KanbanItemsPage): string { return JSON.stringify({version:1,source,page}); }
export function parseWorkCache(raw: string | null, source: string): KanbanItemsPage | null {
  try {
    if (!raw || utf8Size(raw) > 1048576) return null;
    const v: unknown = JSON.parse(raw);
    if (!record(v) || v.version !== 1 || v.source !== source || !validWorkPage(v.page) || v.page.nextCursor !== null) return null;
    const page = v.page;
    return KANBAN_COLUMNS.every(key => page.items.filter(item => item.column === key).length === page.counts[key]) ? page : null;
  } catch { return null; }
}
export interface WorkAttempt {itemId:string;requestId:string;itemRevision:string;agentId:string;requestedAt:number}
export function workAttempts(source:string, attempts:Record<string,WorkAttempt>): string {return JSON.stringify({version:1,source,attempts});}
export function parseWorkAttempts(raw:string|null, source:string): Record<string,WorkAttempt> {
 try {
  if (!raw || utf8Size(raw)>200000) return {};
  const v:unknown=JSON.parse(raw);
  if (!record(v)||v.version!==1||v.source!==source||!record(v.attempts)||Object.keys(v.attempts).length>500) return {};
  if (!Object.entries(v.attempts).every(([id,a])=>record(a)&&Object.keys(a).sort().join(',')==='agentId,itemId,itemRevision,requestId,requestedAt'&&workId(id)&&a.itemId===id&&workRequestId(a.requestId)&&workRevision(a.itemRevision)&&agentId(a.agentId)&&timestamp(a.requestedAt))) return {};
  return v.attempts as Record<string,WorkAttempt>;
 } catch {return {};}
}
/**
 * Where a Tarjeta lifted from `from` lands after `dx` of horizontal travel with columns `stride` apart; null off the board,
 * which cancels. With `vertical` (`dy` of travel, the card starting `at` from the board's top and `size` tall, in a
 * `board`-tall row; `board` 0 = not measured yet) its centre must also stay inside the board.
 */
export function dragTarget(from:KanbanColumn,dx:number,stride:number,vertical?:{dy:number;at:number;size:number;board:number}):KanbanColumn|null {
 if(!Number.isFinite(dx)||!(stride>0))return null;
 if(vertical&&vertical.board>0){const centre=vertical.at+vertical.size/2+vertical.dy;if(!(centre>=0&&centre<=vertical.board))return null;}
 return KANBAN_COLUMNS[KANBAN_COLUMNS.indexOf(from)+Math.round(dx/stride)] ?? null;
}
export function validateWorkNotification(body:import('../../../protocol/kanban.ts').KanbanNotifyRequest):string|null {
 const error=validateWorkText(body.input,64000);
 return error ?? (utf8Size(JSON.stringify(body))>80000?'El aviso codificado supera 80000 bytes.':null);
}
/** Where a swipe to the right sends a Tarjeta: the next column, skipping BLOQUEADO; HECHO has none. */
export function nextColumn(column: KanbanColumn): KanbanColumn | null {
 return ({todo:'in_progress',in_progress:'review',review:'done',blocked:'in_progress',done:null} as const)[column];
}
