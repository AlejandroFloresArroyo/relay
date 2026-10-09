import { DECISION_HISTORY_LIMIT, DECISION_COMMAND_PREVIEW_LENGTH } from '../../../protocol/protocol.ts';
import type { DecisionHistory, DecisionRecord } from '../../../protocol/protocol.ts';
import { RelayError } from './client.ts';
export type DecisionActorFilter = 'all' | DecisionRecord['actor'];
export function filterDecisions<T extends DecisionRecord & {agentScope?:string}>(records: T[], agent: string, actor: DecisionActorFilter, origin: 'all'|'relay'|'other') {
  return records.filter(record => (agent === 'all' || (record.agentScope ?? record.agentId) === agent) && (actor === 'all' || record.actor === actor) && (origin === 'all' || record.origin === origin));
}
export function parseDecisionHistory(value: unknown): DecisionHistory {
  if (!value || typeof value !== 'object' || !('decisions' in value) || !Array.isArray(value.decisions) || !('capturedAt' in value) || typeof value.capturedAt !== 'number' || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0)
    throw new RelayError('decision_history_unavailable','El historial de Decisiones no es válido.');
  for (const record of value.decisions) {
    if (!record || typeof record !== 'object' || !['id','agentId','agentName','sessionId','command','source','originLabel'].every(key => typeof record[key] === 'string' && record[key].length > 0)
      || !['person','guardian','expired','unknown'].includes(record.actor) || !['approved','rejected','expired','executed'].includes(record.outcome) || !['decision','result'].includes(record.timeKind)
      || (record.actor === 'unknown') !== (record.outcome === 'executed') || (record.actor === 'expired') !== (record.outcome === 'expired') || record.actor === 'guardian' && record.outcome !== 'approved'
      || !['relay','other'].includes(record.origin) || !Number.isSafeInteger(record.at) || record.at < 0 || ![null,'once','session','always','deny'].includes(record.choice)
      || ('commandTruncated' in record && typeof record.commandTruncated !== 'boolean')
      || !['runId','approvalId','toolCallId'].every(key => record[key] === null || typeof record[key] === 'string'))
      throw new RelayError('decision_history_unavailable','El historial de Decisiones no es válido.');
  }
  if ('uncertain' in value && (!Array.isArray(value.uncertain) || value.uncertain.some(record => !record || typeof record !== 'object' || !['id','agentId','agentName','command'].every(key => typeof record[key] === 'string' && record[key].length > 0) || !Number.isSafeInteger(record.at) || record.at < 0 || record.origin !== 'relay' || !['once','session','always','deny'].includes(record.choice))))
    throw new RelayError('decision_history_unavailable','El historial de Decisiones no es válido.');
  const history = value as DecisionHistory;
  if ('window' in value && (!history.window || typeof history.window !== 'object' || Array.isArray(history.window) || Object.keys(history.window).length !== 2 || !Object.hasOwn(history.window,'limit') || !Object.hasOwn(history.window,'total') || !Number.isSafeInteger(history.window.limit) || history.window.limit < 1 || !Number.isSafeInteger(history.window.total) || history.window.total < history.decisions.length || history.decisions.length > history.window.limit))
    throw new RelayError('decision_history_unavailable','El historial de Decisiones no es válido.');
  return { decisions: recentDecisions(history.decisions).map(record => record.command.length > DECISION_COMMAND_PREVIEW_LENGTH
      ? {...record,command:record.command.slice(0,DECISION_COMMAND_PREVIEW_LENGTH-1).replace(/[\uD800-\uDBFF]$/, '')+'…',commandTruncated:true} : {...record}),
    capturedAt:history.capturedAt, ...(history.uncertain ? {uncertain:history.uncertain}:{}),
    window:{limit:DECISION_HISTORY_LIMIT,total:history.window?.total ?? history.decisions.length} };
}
/** Keep a bounded selection without sorting or copying an entire legacy history. */
export function recentDecisions<T extends DecisionRecord>(records: readonly T[]): T[] {
  const recent: T[] = [];
  for (const record of records) {
    let low=0, high=recent.length;
    while (low < high) {
      const middle=(low+high)>>>1, other=recent[middle];
      if (other.at > record.at || other.at === record.at && other.id.localeCompare(record.id) <= 0) low=middle+1;
      else high=middle;
    }
    if (low >= DECISION_HISTORY_LIMIT) continue;
    recent.splice(low,0,record);
    if (recent.length > DECISION_HISTORY_LIMIT) recent.pop();
  }
  return recent;
}
