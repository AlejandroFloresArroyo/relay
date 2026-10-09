import { readUsageSessions } from './hermes_store.ts';
import type { AgentUsage, UsageAmount } from '../../protocol/agentDetails.ts';
import { AgentDetailsError } from './agentDetailsError.ts';
const dayOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/** Calendar windows use the Server timezone and retain DST boundaries, never days*86400000. */
export function usageWindow(capturedAt: number, days = 7, offsetDays = 0) {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0 || !Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(offsetDays) || offsetDays < 0 || offsetDays > 365) throw new AgentDetailsError('agent_security_invalid');
  const end = new Date(capturedAt); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() - offsetDays);
  const first = new Date(end); first.setDate(first.getDate() - days + 1);
  const bins: string[] = []; const cursor = new Date(first);
  for (let i = 0; i < days; i++) { bins.push(dayOf(cursor)); cursor.setDate(cursor.getDate() + 1); }
  return { first: first.getTime() / 1000, end: offsetDays === 0 ? capturedAt / 1000 : cursor.getTime() / 1000 - 0.001, bins };
}
const empty = (): UsageAmount => ({ tokens: 0, estimatedCostUsd: 0, conversations: 0 });
export function readAgentUsage(home: string, capturedAt: number): AgentUsage {
  const window = usageWindow(capturedAt); const byDay = new Map<string, UsageAmount>();
  try {
    for (const row of readUsageSessions(home, window)) {
      if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) throw new Error();
      const day = dayOf(new Date(row.startedAt * 1000));
      const input = row.inputTokens ?? 0, output = row.outputTokens ?? 0, rawCost = row.estimatedCostUsd;
      if (!window.bins.includes(day) || typeof input !== 'number' || typeof output !== 'number' ||
          !Number.isSafeInteger(input + output) || input + output < 0 ||
          (rawCost !== null && (typeof rawCost !== 'number' || !Number.isFinite(rawCost) || rawCost < 0))) throw new Error();
      const costKnown = row.costStatus === 'estimated' || row.costStatus === 'actual' || row.costStatus === 'included';
      const cost = costKnown ? rawCost : null;
      const previous = byDay.get(day) ?? empty();
      const tokens = previous.tokens + input + output;
      const estimatedCostUsd = previous.estimatedCostUsd === null || cost === null ? null : previous.estimatedCostUsd + cost;
      if (!Number.isSafeInteger(tokens) || (estimatedCostUsd !== null && !Number.isFinite(estimatedCostUsd))) throw new Error();
      byDay.set(day, { tokens, estimatedCostUsd, conversations: previous.conversations + 1 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AgentDetailsError('agent_details_unavailable');
  }
  const daily = window.bins.map((day) => ({ day, ...(byDay.get(day) ?? empty()) }));
  const total = daily.reduce<UsageAmount>((sum, value) => ({ tokens: sum.tokens + value.tokens, conversations: sum.conversations + value.conversations,
    estimatedCostUsd: sum.estimatedCostUsd === null || value.estimatedCostUsd === null ? null : sum.estimatedCostUsd + value.estimatedCostUsd }), empty());
  return { capturedAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, basis: 'conversation_started_at', includesAuxiliary: false, today: byDay.get(window.bins.at(-1)!) ?? empty(), last7days: total, daily };
}
