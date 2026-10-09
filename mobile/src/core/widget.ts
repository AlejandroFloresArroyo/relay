import { WIDGET_LABEL_PATTERN, WIDGET_LABEL_SECRET, type WidgetProjection } from '../../../protocol/widget.ts';
// The widget shows the Puente's dated projection (GET /v1/widget), read natively; it is never a command surface.
export type WidgetAgentState = WidgetProjection['agents'][number]['state'];
/** What the native widget renders, mirrored by the demo preview. */
export interface WidgetView {
  state: 'current' | 'stale' | 'neutral';
  label: string; observedAt: number | null; count: number | null; agents: { label: string; state: WidgetAgentState }[];
}
/** What the widget really does; the preview shows it and the native widget picker says the same (relay_widget_description). */
export const WIDGET_EXPLANATION = 'El widget sigue un solo Servidor, el que tienes elegido en Relay, y muestra hasta tres de sus Agentes; los de otros Servidores no salen. Se renueva con cada aviso o cada 15 minutos. Tocarlo abre Relay, nunca decide nada.';
export function widgetScope(id: string, deviceId = '', url = ''): string {
  // Scope aliases identify local navigation only; they are never authorization credentials.
  let a = 2166136261; let b = 5381;
  for (const char of `${id}\0${deviceId}\0${url}`) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
  return `w-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
/**
 * The Servidor the native widget follows, as JSON, or null to retire it. Names its pairing (the native
 * read uses the key already held by the Avisos snapshot) and never carries the key itself.
 */
export function widgetTarget(server: { id: string; name: string; url: string; deviceId?: string } | undefined, appearance: 'light' | 'dark', revoked: boolean): string | null {
  if (!server?.deviceId || revoked) return null;
  const label = WIDGET_LABEL_PATTERN.test(server.name) && !WIDGET_LABEL_SECRET.test(server.name) ? server.name : 'Servidor';
  return JSON.stringify({ serverId: server.id, deviceId: server.deviceId, url: server.url, scope: widgetScope(server.id, server.deviceId, server.url), label, appearance });
}
/** A widget intent can select a read surface after the gate; it cannot carry consent. */
export function widgetDestination(request: unknown, scope: string | null, visible: boolean): '/agents' | '/approvals' | null {
  if (!visible || !request || typeof request !== 'object' || Array.isArray(request)) return null;
  const value = request as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'scope' && key !== 'target')) return null;
  if (value.target !== 'agents' && value.target !== 'approvals') return null;
  if (value.scope !== scope || (scope !== null && !/^w-[0-9a-f]{16}$/.test(scope))) return null;
  if (scope === null && value.target !== 'agents') return null;
  return value.target === 'approvals' ? '/approvals' : '/agents';
}
