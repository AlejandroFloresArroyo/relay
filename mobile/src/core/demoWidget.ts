import type { WidgetView } from './widget.ts';
export const DEMO_WIDGET_STATES = [['current', 'Lectura reciente'], ['empty', 'Sin pendientes'], ['stale', 'Sin lectura reciente'], ['neutral', 'Sin lectura']] as const;
export type DemoWidgetState = typeof DEMO_WIDGET_STATES[number][0];
/** The widget follows one Servidor: atlas shows dev and research; ops lives in homelab. */
export const DEMO_WIDGET_SERVERS = [['atlas', 'atlas'], ['homelab', 'homelab']] as const;
export type DemoWidgetServer = typeof DEMO_WIDGET_SERVERS[number][0];
const AGENTS = {
  atlas: [{ label: 'dev', state: 'busy' }, { label: 'research', state: 'on' }],
  homelab: [{ label: 'ops', state: 'err' }],
} as const;
export function demoWidget(state: DemoWidgetState, now: number, server: DemoWidgetServer = 'atlas'): WidgetView {
  const label = server.toUpperCase(); const agents = [...AGENTS[server]];
  if (state === 'neutral') return { state: 'neutral', label, observedAt: null, count: null, agents: [] };
  if (state === 'stale') return { state: 'stale', label, observedAt: now - 45 * 60_000, count: null, agents };
  return { state: 'current', label, observedAt: now - 45_000, count: state === 'empty' ? 0 : 1, agents };
}
