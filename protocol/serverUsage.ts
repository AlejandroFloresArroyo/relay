export type UsagePeriod = 'day' | 'week' | 'month';
export interface UsageAmount {
  conversations: number | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  estimatedCostUsd: number | null;
}
export interface ServerUsage {
  period: UsagePeriod;
  capturedAt: number;
  timezone: string;
  from: number;
  until: number;
  basis: 'conversation_started_at';
  modelBasis: 'session_recorded_model';
  includesAuxiliary: false;
  partial: boolean;
  total: UsageAmount;
  totalsKnown: UsageAmount;
  agents: { id: string; name: string; status: 'ok' | 'unavailable' | 'error'; amount: UsageAmount; totalsKnown: UsageAmount }[];
  models: { model: string | null; amount: UsageAmount; totalsKnown: UsageAmount }[];
  daily: { day: string; amount: UsageAmount; totalsKnown: UsageAmount }[];
}
