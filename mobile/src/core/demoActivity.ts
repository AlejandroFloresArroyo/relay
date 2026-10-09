import { ACTIVITY_ERROR_MESSAGES, ACTIVITY_CURSOR_TTL_MS, type ActivityItem, type ActivityPage, type ActivityQuery } from '../../../protocol/activity.ts';
import { activityQueryPath, parseActivityPage } from './activity.ts';
import { RelayError } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
export const DEMO_ACTIVITY_SCENARIOS = [
  { id: 'normal', name: 'Normal' }, { id: 'composition', name: 'Personalidad y Avisos' }, { id: 'loading', name: 'Cargando' }, { id: 'empty', name: 'Vacío' },
  { id: 'error', name: 'Error' }, { id: 'offline', name: 'Sin conexión' }, { id: 'partial', name: 'Parcial' },
  { id: 'unsupported', name: 'Actualizar Puente' }, { id: 'busy', name: 'Puente ocupado' },
  { id: 'expired', name: 'Cursor caducado' }, { id: 'clock-skew', name: 'Relojes distintos' },
] as const;
export type DemoActivityScenario = typeof DEMO_ACTIVITY_SCENARIOS[number]['id'];
const scenarios = new Map<string, DemoActivityScenario>(); let epoch = 0;
export const demoActivityScenario = (serverId: string): DemoActivityScenario => scenarios.get(serverId) ?? 'normal';
export function setDemoActivityScenario(serverId: string, scenario: DemoActivityScenario) { scenarios.set(serverId, scenario); epoch++; }
export function resetDemoActivity() { scenarios.clear(); epoch++; }
function rows(serverId: string, capturedAt: number): ActivityItem[] {
  const actions: ActivityItem['action'][] = ['job.run', 'run.steer', 'conversation.create', 'run.stop', 'run.steer', 'conversation.model.change', 'agent.memory.edit', 'gateway.restart', 'agent.rule.add'];
  const results: ActivityItem['result'][] = ['requested', 'accepted', 'failed', 'uncertain', 'rejected', 'recorded', 'succeeded', 'succeeded', 'succeeded'];
  return actions.map((action, index) => {
    const server = action.startsWith('server.') || action.startsWith('gateway.');
    const agentId = index % 2 ? 'research' : 'dev';
    return { id: 'demo-event-' + (100 - index), at: capturedAt - index * 5 * 60000 - (index >= 5 ? 3 * 86400000 : 0),
      actor: server ? { kind: 'server' } : { kind: 'device', id: index % 2 ? 'demo-other-device' : 'demo-' + serverId + '-device' },
      action, category: server ? 'server' : action.startsWith('job.') ? 'tasks' : action.startsWith('agent.') ? 'configuration' : 'conversations',
      result: results[index], scope: server ? { kind: 'server' } : { kind: 'agent', agentId },
      conversationId: action === 'conversation.model.change' ? 'demo-conv-' + serverId + '-' + agentId : null };
  });
}
function compositionRows(serverId: string, capturedAt: number): ActivityItem[] {
  const outcomes: [ActivityItem['action'], ActivityItem['result']][] = [
    ['personality.preset.create', 'requested'], ['personality.preset.create', 'succeeded'],
    ['personality.preset.update', 'requested'], ['personality.preset.update', 'succeeded'],
    ['personality.preset.delete', 'requested'], ['personality.preset.delete', 'succeeded'],
    ['personality.soul.apply', 'requested'], ['personality.soul.apply', 'recorded'],
    ['conversation.personality.change', 'recorded'], ['notification.registration', 'requested'],
  ];
  return outcomes.map(([action, result], index) => {
    const agent = action === 'personality.soul.apply' || action === 'conversation.personality.change';
    return { id: 'demo-composition-' + (100 - index), at: capturedAt - index * 60000,
      actor: { kind: 'device', id: 'demo-' + serverId + '-device' }, action, result,
      category: action === 'notification.registration' ? 'server' : action === 'conversation.personality.change' ? 'conversations' : 'configuration',
      scope: agent ? { kind: 'agent', agentId: 'dev' } : { kind: 'server' },
      conversationId: action === 'conversation.personality.change' ? 'demo-conv-' + serverId + '-dev' : null };
  });
}
function filtered(serverId: string, capturedAt: number, query: ActivityQuery, composition = false): ActivityItem[] {
  return (composition ? compositionRows(serverId, capturedAt) : rows(serverId, capturedAt)).filter(item => (!query.agentId || item.scope.kind === 'agent' && item.scope.agentId === query.agentId)
    && (!query.category || item.category === query.category)
    && (!query.failuresOnly || ['failed', 'rejected', 'uncertain'].includes(item.result)));
}
export function demoActivityLastKnown(serverId: string, query: ActivityQuery, now: number): ActivityPage {
  const capturedAt = now - 9 * 60 * 60000;
  return parseActivityPage({ items: filtered(serverId, capturedAt, query).slice(0, query.limit ?? 50), capturedAt, nextCursor: null }, query);
}
export function createDemoActivity(serverId: string, now: () => number) {
  return async (query: ActivityQuery = {}): Promise<ActivityPage> => {
    activityQueryPath(query);
    const scenario = demoActivityScenario(serverId);
    const connectionError = demoConnectionError(serverId); if (connectionError) throw connectionError;
    if (scenario === 'offline' || scenario === 'partial' && serverId === 'homelab') throw new RelayError('unreachable', 'Demo offline');
    if (scenario === 'error') throw new RelayError('activity_unavailable', ACTIVITY_ERROR_MESSAGES.activity_unavailable);
    if (scenario === 'busy') throw new RelayError('activity_busy', ACTIVITY_ERROR_MESSAGES.activity_busy, 503);
    if (scenario === 'unsupported') throw new RelayError('activity_unavailable', 'Actualiza el Puente para consultar Actividad.', 404);
    if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 1500));
    const filter = activityQueryPath({ ...query, cursor: undefined });
    const serverNow = now() + (scenario === 'clock-skew' && serverId === 'homelab' ? 2 * 86400000 : 0);
    let capturedAt = serverNow; let offset = 0;
    if (query.cursor) {
      let stored: { server: string; filter: string; capturedAt: number; offset: number; epoch: number };
      try { stored = JSON.parse(decodeURIComponent(query.cursor)); } catch { throw new RelayError('invalid_activity_query', ACTIVITY_ERROR_MESSAGES.invalid_activity_query); }
      if (stored.server !== serverId || stored.filter !== filter || !Number.isSafeInteger(stored.offset) || stored.offset < 0 || !Number.isSafeInteger(stored.capturedAt)) throw new RelayError('invalid_activity_query', ACTIVITY_ERROR_MESSAGES.invalid_activity_query);
      if (stored.epoch !== epoch || scenario === 'expired' || serverNow - stored.capturedAt >= ACTIVITY_CURSOR_TTL_MS) throw new RelayError('activity_cursor_expired', ACTIVITY_ERROR_MESSAGES.activity_cursor_expired, 409);
      capturedAt = stored.capturedAt; offset = stored.offset;
    }
    const all = scenario === 'empty' ? [] : filtered(serverId, capturedAt, query, scenario === 'composition');
    const limit = query.limit ?? (scenario === 'expired' ? 3 : 50);
    const items = all.slice(offset, offset + limit);
    const nextCursor = offset + items.length < all.length ? encodeURIComponent(JSON.stringify({ server: serverId, filter, capturedAt, offset: offset + items.length, epoch })) : null;
    return parseActivityPage({ items, capturedAt, nextCursor }, query);
  };
}
