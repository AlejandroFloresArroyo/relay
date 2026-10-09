import { createHash } from 'node:crypto';
import { exactObject, isUuid, isDeviceName } from './changeLog.ts';
import * as p from '../../protocol/kanban.ts';
import type { KanbanColumn, KanbanItem, KanbanDeviceAuthor, KanbanNotifyReceipt } from '../../protocol/kanban.ts';
export class KanbanError extends Error {
  readonly status: number;
  readonly code: p.KanbanErrorCode;
  constructor(code: p.KanbanErrorCode) {
    super(({ kanban_invalid_request: 'La solicitud de Trabajo no es válida.', kanban_not_found: 'El elemento ya no está disponible.',
      kanban_agent_unavailable: 'El Agente no está disponible en este Servidor.', kanban_conflict: 'Trabajo cambió o la solicitud ya corresponde a otra operación.',
      kanban_dependency_blocked: 'Completa las dependencias antes de avisar al Agente.', kanban_notification_busy: 'Este elemento tiene un aviso pendiente o un Turno sin resultado confirmado.',
      kanban_notification_uncertain: 'El aviso quedó sin confirmar. No se enviará otra vez.', server_paused: 'Pausa general: reanuda el Servidor antes de avisar al Agente.',
      kanban_store_unavailable: 'El registro privado de Trabajo no está disponible.', kanban_store_full: 'El registro privado de Trabajo está lleno; no se borró el historial.',
    } satisfies Record<p.KanbanErrorCode, string>)[code]);
    this.code = code; this.status = p.KANBAN_ERROR_STATUS[code];
  }
}
export const invalid = () => new KanbanError('kanban_invalid_request');
export const unavailable = () => new KanbanError('kanban_store_unavailable');
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const requestId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
export const agentId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);
export const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= p.KANBAN_MIN_TIMESTAMP_MS && Number(v) <= p.KANBAN_MAX_TIMESTAMP_MS;
export const column = (v: unknown): v is KanbanColumn => p.KANBAN_COLUMNS.includes(v as KanbanColumn);
export const title = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= p.KANBAN_TITLE_MAX_CHARS && !/[\x00-\x1f\x7f]/.test(v);
export const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
export const blockers = (v: unknown): v is string[] => Array.isArray(v) && v.length <= p.KANBAN_MAX_BLOCKERS_PER_ITEM && v.every(isUuid) && new Set(v).size === v.length;
export const author = (v: unknown): v is KanbanDeviceAuthor => exactObject(v, ['kind', 'id', 'name']) && v.kind === 'device' && isUuid(v.id) && isDeviceName(v.name);
export function itemRevision(item: Omit<KanbanItem, 'revision'> | KanbanItem): string {
  const { id, number, title, agentId, column, blockedBy, commentCount, createdAt, updatedAt } = item;
  return digest({ id, number, title, agentId, column, blockedBy, commentCount, createdAt, updatedAt });
}
export function validItem(v: unknown): v is KanbanItem {
  return exactObject(v, ['id', 'number', 'revision', 'title', 'agentId', 'column', 'blockedBy', 'commentCount', 'createdAt', 'updatedAt'])
    && isUuid(v.id) && Number.isSafeInteger(v.number) && Number(v.number) > 0 && revision(v.revision) && title(v.title)
    && (v.agentId === null || agentId(v.agentId)) && column(v.column) && blockers(v.blockedBy)
    && Number.isSafeInteger(v.commentCount) && Number(v.commentCount) >= 0 && Number(v.commentCount) <= p.KANBAN_MAX_COMMENTS_PER_ITEM
    && timestamp(v.createdAt) && timestamp(v.updatedAt) && v.updatedAt >= v.createdAt
    && (v.column !== 'blocked' || v.blockedBy.length > 0) && itemRevision(v as unknown as KanbanItem) === v.revision;
}
export function graph(items: KanbanItem[]): void {
  const map = new Map(items.map(item => [item.id, item]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id) || !map.has(id)) throw invalid();
    if (visited.has(id)) return;
    visiting.add(id); for (const blocker of map.get(id)!.blockedBy) visit(blocker);
    visiting.delete(id); visited.add(id);
  };
  for (const item of items) visit(item.id);
}
export function validNotification(v: unknown): v is KanbanNotifyReceipt {
  if (!exactObject(v, ['requestId','itemId','itemRevision','agentId','requestedBy','requestedAt','updatedAt','state','conversationId','runId','errorCode'], v && typeof v === 'object' && 'state' in v && v.state === 'started' ? ['turn'] : [])
    || !requestId(v.requestId) || !isUuid(v.itemId) || !revision(v.itemRevision) || !agentId(v.agentId) || !author(v.requestedBy)
    || !timestamp(v.requestedAt) || !timestamp(v.updatedAt) || v.updatedAt < v.requestedAt) return false;
  const reference = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(id);
  if (v.conversationId !== null && !reference(v.conversationId) || v.runId !== null && !reference(v.runId)) return false;
  if (v.state === 'pending') return v.runId === null && v.errorCode === null;
  if (v.state === 'rejected') return v.runId === null && ['server_paused','agent_unavailable','configuration_conflict','conversation_unavailable','dependency_blocked','upstream_rejected'].includes(String(v.errorCode));
  if (v.state === 'uncertain') return v.errorCode === 'kanban_notification_uncertain';
  return v.state === 'started' && reference(v.conversationId) && reference(v.runId) && v.errorCode === null && Object.hasOwn(v,'turn')
    && (v.turn === null || exactObject(v.turn,['phase','observedAt']) && ['queued','running','waiting_for_approval','stopping','completed','failed','cancelled','unknown'].includes(String(v.turn.phase)) && timestamp(v.turn.observedAt));
}
export function parseMutation(kind: 'create' | 'update' | 'comment' | 'notify', value: unknown): Record<string, unknown> & { requestId: string } {
  const required = { create: ['requestId','title','agentId','column','blockedBy'], update: ['requestId','revision'], comment: ['requestId','revision','text'], notify: ['requestId','revision','agentId','input'] }[kind];
  if (!exactObject(value, required, kind === 'update' ? ['title','agentId','column','blockedBy'] : []) || !requestId(value.requestId)) throw invalid();
  if (kind !== 'create' && !revision(value.revision)) throw invalid();
  if (kind === 'update' && Object.keys(value).length < 3) throw invalid();
  if (Object.hasOwn(value,'title')) { if (typeof value.title !== 'string') throw invalid(); value = { ...value, title: value.title.trim() }; }
  const body = value as Record<string, unknown> & { requestId: string };
  if (Object.hasOwn(body,'title') && !title(body.title) || Object.hasOwn(body,'column') && !column(body.column)
    || Object.hasOwn(body,'blockedBy') && !blockers(body.blockedBy)
    || Object.hasOwn(body,'agentId') && !(kind !== 'notify' && body.agentId === null) && !agentId(body.agentId)
    || kind === 'comment' && !text(body.text,p.KANBAN_COMMENT_MAX_BYTES) || kind === 'notify' && !text(body.input,p.KANBAN_NOTIFY_INPUT_MAX_BYTES)) throw invalid();
  return body;
}
