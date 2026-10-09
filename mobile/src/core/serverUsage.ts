import type { ServerUsage, UsageAmount, UsagePeriod } from '../../../protocol/serverUsage.ts';
export const USAGE_PERIODS: UsagePeriod[] = ['day','week','month'];
export const USAGE_LABELS: Record<UsagePeriod, string> = { day: 'Hoy', week: 'Semana', month: 'Mes' };
export const estimatedCost = (value: number | null) => value === null ? '—' : `≈ $${value.toFixed(2)}`;
export const usageTokens = (value: number | null) => value === null ? '—' : Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const usageCache = (source: string, report: ServerUsage) => JSON.stringify({ source, report });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function amount(value: unknown): value is UsageAmount {
  return record(value) && ['conversations','tokens','inputTokens','outputTokens','cacheReadTokens','estimatedCostUsd'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && (key === 'estimatedCostUsd' || Number.isSafeInteger(value[key]))));
}
export function validServerUsage(value: unknown, period: UsagePeriod): value is ServerUsage {
  if (!record(value) || value.period !== period || value.basis !== 'conversation_started_at' || value.modelBasis !== 'session_recorded_model' || value.includesAuxiliary !== false || typeof value.partial !== 'boolean') return false;
  if (!['capturedAt','from','until'].every(key => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) || typeof value.timezone !== 'string') return false;
  try { new Intl.DateTimeFormat('es', {timeZone:value.timezone}); } catch { return false; }
  if (Number(value.from) > Number(value.capturedAt) || Number(value.capturedAt) >= Number(value.until)) return false;
  const boundedText = (v: unknown) => typeof v === 'string' && v.length <= 256;
  return amount(value.total) && amount(value.totalsKnown)
    && Array.isArray(value.agents) && value.agents.length <= 128 && value.agents.every(a=>record(a) && boundedText(a.id) && boundedText(a.name) && ['ok','error','unavailable'].includes(String(a.status)) && amount(a.amount) && amount(a.totalsKnown))
    && Array.isArray(value.models) && value.models.length <= 512 && value.models.every(m=>record(m) && (m.model === null || boundedText(m.model)) && amount(m.amount) && amount(m.totalsKnown))
    && Array.isArray(value.daily) && value.daily.length > 0 && value.daily.length <= 31 && value.daily.every(d=>record(d) && typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && amount(d.amount) && amount(d.totalsKnown));
}
export function parseUsageCache(text: string | null, source: string, period: UsagePeriod): ServerUsage | null {
  if (!text || text.length > 512_000) return null;
  try { const value: unknown = JSON.parse(text); return record(value) && value.source === source && validServerUsage(value.report,period) ? value.report : null; } catch { return null; }
}
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
/** «2026-10-12» → «12 OCT». */
export function usageDay(day: string) { const [, month, date] = day.split('-').map(Number); return `${date} ${MONTHS[month - 1]}`; }
/** «12–14 OCT», or «30 OCT–2 NOV» across months; one day alone. */
export function usageRange(first: string, last: string) {
  if (first === last) return usageDay(last);
  const [, month1, date1] = first.split('-').map(Number); const [, month2] = last.split('-').map(Number);
  return month1 === month2 ? `${date1}–${usageDay(last)}` : `${usageDay(first)}–${usageDay(last)}`;
}
/** «14 OCT 12:00»: 24 h in the Servidor's own timezone. */
export function usageStamp(at: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.hour}:${parts.minute}`;
}
