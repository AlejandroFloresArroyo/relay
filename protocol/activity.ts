// Additive read capability; existing protocol versions and routes remain unchanged.
export const ACTIVITY_PATH = '/v1/activity';
export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 100;
export const ACTIVITY_CURSOR_TTL_MS = 10 * 60 * 1000;
export const ACTIVITY_MAX_BYTES = 16 * 1024 * 1024;
export const ACTIVITY_MAX_ROWS = 50_000;
export const ACTIVITY_MAX_LINE_BYTES = 8 * 1024;

export const ACTIVITY_CATEGORIES = ['configuration', 'conversations', 'tasks', 'server'] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];
export const ACTIVITY_ACTIONS = [
  'device.pair', 'device.revoke', 'auth.rate_limit',
  'agent.mode.queue', 'agent.mode.cancel', 'agent.mode.apply',
  'agent.rule.add', 'agent.rule.remove', 'agent.tools.enable', 'agent.tools.disable',
  'agent.memory.edit', 'agent.memory.delete', 'agent.soul.edit',
  'personality.preset.create', 'personality.preset.update', 'personality.preset.delete', 'personality.soul.apply',
  'notification.registration',
  'conversation.personality.change', 'conversation.create', 'conversation.rename', 'conversation.delete', 'conversation.model.change',
  'run.steer', 'run.stop',
  'job.create', 'job.edit', 'job.delete', 'job.pause', 'job.resume', 'job.run',
  'kanban.create', 'kanban.update', 'kanban.comment', 'kanban.notify',
  'server.pause', 'server.resume', 'gateway.start', 'gateway.stop', 'gateway.restart',
] as const;
export type ActivityAction = typeof ACTIVITY_ACTIONS[number];
export const ACTIVITY_RESULTS = ['requested', 'succeeded', 'failed', 'uncertain', 'accepted', 'rejected', 'recorded'] as const;
export type ActivityResult = typeof ACTIVITY_RESULTS[number];
export type ActivityActor = { kind: 'server' } | { kind: 'device'; id: string };
export type ActivityScope = { kind: 'server' } | { kind: 'agent'; agentId: string };

export interface ActivityItem {
  id: string;
  at: number;
  actor: ActivityActor;
  action: ActivityAction;
  category: ActivityCategory;
  result: ActivityResult;
  scope: ActivityScope;
  // A recorded reference, not proof that the Conversation still exists; no message anchor.
  conversationId: string | null;
}
export interface ActivityQuery {
  limit?: number;
  cursor?: string;
  agentId?: string;
  category?: ActivityCategory;
  // Includes failed, rejected and uncertain; retain each result's distinct meaning.
  failuresOnly?: boolean;
}
export interface ActivityPage {
  items: ActivityItem[];
  // Stable across pages of one snapshot. Dates are Server UTC milliseconds.
  capturedAt: number;
  nextCursor: string | null;
}
export const ACTIVITY_ERROR_STATUS = {
  invalid_activity_query: 400,
  activity_cursor_expired: 409,
  activity_unavailable: 503,
  activity_limit_exceeded: 503,
  activity_busy: 503,
} as const;
export type ActivityErrorCode = keyof typeof ACTIVITY_ERROR_STATUS;
export const ACTIVITY_ERROR_MESSAGES = {
  invalid_activity_query: 'El filtro de Actividad no es válido.',
  activity_cursor_expired: 'La consulta de Actividad caducó. Actualiza para continuar.',
  activity_unavailable: 'No se pudo leer el registro de Actividad del Puente. Reintenta.',
  activity_limit_exceeded: 'El registro de Actividad supera el límite de consulta. No se borró ningún registro.',
  activity_busy: 'Hay demasiadas consultas de Actividad abiertas. Reintenta en unos minutos.',
} as const satisfies Record<ActivityErrorCode, string>;
