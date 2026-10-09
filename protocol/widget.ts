import type { AgentStatus } from './protocol.ts';

// GET /v1/widget (X-Relay-Protocol: 2, device key): the home-screen projection and nothing else.
// No command, message, model, path, detail or approval identity ever enters it.
export const WIDGET_SCHEMA = 1;
/**
 * How long an observation counts as current when nothing renews it (push or the 15-minute job).
 * The phone refuses longer readings: raise WidgetReading.TTL_MS (relay-widget module) with it.
 */
export const WIDGET_OBSERVATION_TTL_MS = 30 * 60 * 1000;
export const WIDGET_MAX_AGENTS = 3;
export const WIDGET_MAX_COUNT = 999;
/** Allowed names only, never a free-text channel; anything else is replaced by a generic word. */
export const WIDGET_LABEL_PATTERN = /^[\p{L}\p{N} _. -]{1,24}$/u;
export const WIDGET_LABEL_SECRET = /(?:rly1_|sk-|bearer|token|secret|api.?key|password)/i;
export interface WidgetProjection {
  schema: 1;
  observedAt: number; // Puente epoch ms of the reading
  expiresAt: number; // Puente epoch ms: observedAt + TTL, or the first counted Aprobación expiry if earlier
  count: number; // Aprobaciones with a known, future expiry
  agents: { label: string; state: AgentStatus }[];
}
// Silent signal on the private UnifiedPush channel: it only says "the projection changed".
export interface WidgetSignal {
  schema: 1;
  kind: 'widget';
  registrationId: string;
}
/** Coalescing window: at most one signal burst per window, with a trailing one for later changes. */
export const WIDGET_SIGNAL_INTERVAL_MS = 10_000;
