import { ACTIVITY_ACTIONS, ACTIVITY_CATEGORIES, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, ACTIVITY_RESULTS, type ActivityItem, type ActivityPage, type ActivityQuery } from '../../../protocol/activity.ts';
import { RelayError } from './client.ts';
export const ACTIVITY_VISIBLE_LIMIT = 500;
export const ACTIVITY_RESPONSE_BYTES = 256 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
export const activityAgentId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(v) && v !== '.' && v !== '..';
export const activityReferenceId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(v) && v !== '.' && v !== '..';
const cursor = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && /^[\x21-\x7e]+$/.test(v);
function invalid(): never { throw new RelayError('activity_unavailable', 'La respuesta del Puente sobre la Actividad no es válida.'); }
export function activityQueryPath(query: ActivityQuery = {}): string {
  const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT
    || query.agentId !== undefined && !activityAgentId(query.agentId)
    || query.category !== undefined && !ACTIVITY_CATEGORIES.includes(query.category)
    || query.failuresOnly !== undefined && typeof query.failuresOnly !== 'boolean'
    || query.cursor !== undefined && !cursor(query.cursor)) throw new RelayError('invalid_activity_query', 'El filtro de Actividad no es válido.');
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.agentId) params.set('agentId', query.agentId);
  if (query.category) params.set('category', query.category);
  if (query.failuresOnly) params.set('failuresOnly', 'true');
  if (query.cursor) params.set('cursor', query.cursor);
  return '/v1/activity?' + params.toString();
}
/** Copy the allowlist; extra transport fields never reach the screen or memory cache. */
export function parseActivityPage(value: unknown, query: ActivityQuery = {}): ActivityPage {
  if (!record(value) || !date(value.capturedAt) || !Array.isArray(value.items)
    || value.items.length > (query.limit ?? ACTIVITY_DEFAULT_LIMIT)
    || value.nextCursor !== null && !cursor(value.nextCursor)) return invalid();
  const ids = new Set<string>();
  const items: ActivityItem[] = value.items.map(raw => {
    if (!record(raw) || !activityReferenceId(raw.id) || ids.has(raw.id) || !date(raw.at)
      || !ACTIVITY_ACTIONS.includes(raw.action as ActivityItem['action'])
      || !ACTIVITY_CATEGORIES.includes(raw.category as ActivityItem['category'])
      || !ACTIVITY_RESULTS.includes(raw.result as ActivityItem['result'])
      || !record(raw.actor) || !record(raw.scope)
      || raw.conversationId !== null && !activityReferenceId(raw.conversationId)) return invalid();
    ids.add(raw.id);
    const actor = raw.actor.kind === 'server' ? { kind: 'server' as const }
      : raw.actor.kind === 'device' && activityReferenceId(raw.actor.id) ? { kind: 'device' as const, id: raw.actor.id } : invalid();
    const scope = raw.scope.kind === 'server' ? { kind: 'server' as const }
      : raw.scope.kind === 'agent' && activityAgentId(raw.scope.agentId) ? { kind: 'agent' as const, agentId: raw.scope.agentId } : invalid();
    // These producers have no free-form targets or inferred confirmation outcomes.
    if (String(raw.action).startsWith('personality.preset.') && (raw.category !== 'configuration' || scope.kind !== 'server'
      || raw.conversationId !== null || !['requested', 'succeeded'].includes(String(raw.result)))
      || raw.action === 'personality.soul.apply' && (raw.category !== 'configuration' || scope.kind !== 'agent'
        || raw.conversationId !== null || !['requested', 'recorded'].includes(String(raw.result)))
      || raw.action === 'conversation.personality.change' && (raw.category !== 'conversations' || scope.kind !== 'agent'
        || raw.conversationId === null || raw.result !== 'recorded')
      || raw.action === 'notification.registration' && (raw.category !== 'server' || scope.kind !== 'server'
        || raw.conversationId !== null || raw.result !== 'requested')) return invalid();
    if (query.failuresOnly && !['failed', 'rejected', 'uncertain'].includes(raw.result as string)) return invalid();
    if (query.agentId && (scope.kind !== 'agent' || scope.agentId !== query.agentId)
      || query.category && raw.category !== query.category || raw.conversationId !== null && scope.kind !== 'agent') return invalid();
    return { id: raw.id, at: raw.at, actor, scope, action: raw.action as ActivityItem['action'], category: raw.category as ActivityItem['category'], result: raw.result as ActivityItem['result'], conversationId: raw.conversationId as string | null };
  });
  return { items, capturedAt: value.capturedAt, nextCursor: value.nextCursor as string | null };
}

/** Preserve each Server snapshot's order; clocks on different Servers are not comparable. */
export function appendActivityPage(previous: ActivityPage, next: ActivityPage): ActivityPage {
  if (previous.capturedAt !== next.capturedAt) throw new RelayError('activity_cursor_expired', 'La consulta de Actividad cambió. Actualiza para continuar.');
  if (next.nextCursor !== null && next.nextCursor === previous.nextCursor) return invalid();
  const ids = new Set(previous.items.map(item => item.id));
  const added = next.items.filter(item => !ids.has(item.id));
  if (next.nextCursor && added.length === 0) return invalid();
  const items = [...previous.items, ...added].slice(0, ACTIVITY_VISIBLE_LIMIT);
  return { items, capturedAt: previous.capturedAt, nextCursor: items.length >= ACTIVITY_VISIBLE_LIMIT ? null : next.nextCursor };
}
