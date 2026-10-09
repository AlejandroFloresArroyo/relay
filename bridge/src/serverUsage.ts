import path from 'node:path';
import { readUsageSessions } from './hermes_store.ts';
import type { ServerUsage, UsageAmount, UsagePeriod } from '../../protocol/serverUsage.ts';

const fields = ['conversations', 'tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'estimatedCostUsd'] as const;
const empty = (): UsageAmount => ({ conversations: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0 });
const unknown = (): UsageAmount => ({ conversations: null, tokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, estimatedCostUsd: null });
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local calendar arithmetic deliberately preserves 23/25-hour Server days. Wire times are ms; SQL times are seconds. */
export function usageWindow(now: number, period: UsagePeriod) {
  if (!Number.isSafeInteger(now) || now < 0 || !['day','week','month'].includes(period)) throw new Error('Invalid usage window');
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) throw new Error('Invalid usage window');
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (period === 'month') start.setDate(1);
  const days: { day: string; from: number; until: number }[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= now) {
    const from = cursor.getTime() / 1000; const day = dayOf(cursor);
    cursor.setDate(cursor.getDate() + 1);
    days.push({ day, from, until: cursor.getTime() / 1000 });
  }
  return { from: start.getTime() / 1000, until: cursor.getTime() / 1000, days };
}

export function totalUsage(values: UsageAmount[], knownOnly = false): UsageAmount {
  const result = empty();
  for (const key of fields) {
    const known = values.map(value => value[key]).filter(value => value !== null);
    const sum = known.reduce((a, b) => a + b, 0);
    result[key] = (!knownOnly && known.length !== values.length) || (values.length > 0 && known.length === 0) || !Number.isFinite(sum) || (key !== 'estimatedCostUsd' && !Number.isSafeInteger(sum)) ? null : sum;
  }
  return result;
}

function number(value: unknown, integer: boolean): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || value < 0 || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) throw new Error('Invalid usage value');
  return value;
}
function rowsFor(root: string, id: string, now: number, window: ReturnType<typeof usageWindow>) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Invalid agent');
  const home = id === 'default' ? root : path.join(root, 'profiles', id);
  return readUsageSessions(home).flatMap(row => {
    const at = number(row.startedAt, false);
    if (at === null || at > 100_000_000_000) throw new Error('Invalid usage timestamp');
    if (at < window.from || at >= window.until || at > now / 1000) return [];
    const inputTokens = number(row.inputTokens, true), outputTokens = number(row.outputTokens, true);
    const rawCost = number(row.estimatedCostUsd, false);
    const costKnown = row.costStatus === 'estimated' || row.costStatus === 'actual' || row.costStatus === 'included';
    const estimatedCostUsd = costKnown ? rawCost : null;
    const model = typeof row.model === 'string' && row.model.trim() && row.model !== 'unknown' ? row.model : null;
    if (model && model.length > 256) throw new Error('Invalid model');
    const amount: UsageAmount = { conversations: 1, inputTokens, outputTokens, cacheReadTokens: number(row.cacheReadTokens, true),
      tokens: inputTokens === null || outputTokens === null ? null : number(inputTokens + outputTokens, true), estimatedCostUsd };
    return [{ day: dayOf(new Date(at * 1000)), model, amount }];
  });
}

export function readServerUsage(root: string, profiles: { id: string; name: string }[], now: number, period: UsagePeriod): ServerUsage {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || profiles.length > 128) throw new Error('Usage unavailable');
  const window = usageWindow(now, period);
  const all: ReturnType<typeof rowsFor> = [];
  const agents: ServerUsage['agents'] = profiles.map(profile => {
    try {
      const rows = rowsFor(root, profile.id, now, window);
      if (all.length + rows.length > 50000 || new Set([...all,...rows].map(r=>r.model)).size > 512) throw new Error('Usage response limit');
      all.push(...rows);
      return { ...profile, status: 'ok', amount: totalUsage(rows.map(r => r.amount)), totalsKnown: totalUsage(rows.map(r => r.amount), true) };
    } catch (error) {
      return { ...profile, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'error', amount: unknown(), totalsKnown: unknown() };
    }
  });
  const partial = agents.some(a => a.status !== 'ok');
  const amounts = all.map(r => r.amount);
  return {
    period, capturedAt: now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    from: window.from * 1000, until: window.until * 1000, basis: 'conversation_started_at', modelBasis: 'session_recorded_model', includesAuxiliary: false, partial,
    total: partial ? unknown() : totalUsage(amounts), totalsKnown: totalUsage([...amounts, ...(partial ? [unknown()] : [])], true), agents,
    models: [...new Set(all.map(r => r.model))].sort().map(model => {
      const amounts = all.filter(r => r.model === model).map(r => r.amount);
      return { model, amount: totalUsage(amounts), totalsKnown: totalUsage(amounts, true) };
    }),
    daily: window.days.map(({ day }) => {
      const amounts = all.filter(r => r.day === day).map(r => r.amount);
      return { day, amount: partial ? unknown() : totalUsage(amounts), totalsKnown: totalUsage([...amounts, ...(partial ? [unknown()] : [])], true) };
    }),
  };
}
