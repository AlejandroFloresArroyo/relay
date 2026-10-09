// Navigation of 3.1 (ADR 0007): the eight tabs, where each place belongs on a wide window, the
// return each screen shows and the APROB. badge of the phone bar. Pure: the router's state comes in.

export const TABS = [
  { key: 'agents', short: 'AGENTES', name: 'Agentes', icon: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 20c1-4 4-6 8-6s7 2 8 6' },
  { key: 'tools', short: 'HERRAM.', name: 'Herramientas', icon: 'M4 7l5 5-5 5M12 18h8' },
  { key: 'board', short: 'TABLERO', name: 'Tablero', icon: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z' },
  { key: 'work', short: 'TRABAJO', name: 'Trabajo', icon: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v7h-4z' },
  { key: 'jobs', short: 'TAREAS', name: 'Tareas', icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2' },
  { key: 'approvals', short: 'APROB.', name: 'Aprobaciones', icon: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6zM8 12l3 3 5-6' },
  { key: 'servers', short: 'SERVID.', name: 'Servidores', icon: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01' },
  { key: 'settings', short: 'AJUSTES', name: 'Ajustes', icon: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];
const tabName = (key: string) => TABS.find(t => t.key === key)?.name;

export type Destination = { active: TabKey; list: 'agents' | 'servers' | null; fullWidth?: true };
/** Which tab a window place belongs to and which list goes beside it. Presentation only: route params and write authorization stay with the mounted screen. */
export function relayDestination(pathname: string): Destination | null {
  const [first = '', ...rest] = pathname.split('/').filter(Boolean);
  const nested = rest.length > 0;
  if (first === 'chat' || first === 'agent') return nested ? { active: 'agents', list: 'agents' } : null;
  if (['usage', 'presets', 'app-update'].includes(first)) return nested ? { active: 'servers', list: 'servers' } : null;
  // Herramientas keeps its two panels and the ficha (T-2) its gauges: the whole width, no list.
  if (first === 'tools') return { active: 'tools', list: null, fullWidth: true };
  if (first === 'server') return nested ? { active: 'servers', list: null, fullWidth: true } : null;
  if (first === 'notices') return nested ? { active: 'approvals', list: null } : null;
  if (first === 'notifications') return nested ? { active: 'settings', list: null } : null;
  if (first === 'widget-preview' || first === 'machinery-preview') return { active: 'settings', list: null };
  if (['work', 'jobs'].includes(first) || (TABS.some(t => t.key === first) && !nested)) return { active: first as TabKey, list: null };
  return null;
}

// A minimal structural copy of React Navigation's state: route names include groups and params can be arrays.
export type NavRoute = { name: string; key?: string; params?: object; state?: Partial<NavState> };
export type NavState = { index: number; routes: NavRoute[]; history?: unknown[] };
export type Names = { agent(server: string, agent: string): string; server(server: string): string };
export type Target = { pathname: string; params?: Record<string, string> };
export type Return = { label: string; action: 'back' } | { label: string; action: 'parent'; href: Target; select?: string };

const param = (route: NavRoute, key: string) => {
  const value = (route.params as Record<string, unknown> | undefined)?.[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
};

function focusedTab(route: NavRoute): string {
  const state = route.state;
  return state?.routes?.[state.index ?? 0]?.name ?? 'agents';
}

/** How a place is named when it is the origin of a return. */
function placeLabel(route: NavRoute, names: Names): string | undefined {
  const server = param(route, 'server'), agent = param(route, 'agent');
  if (route.name === '(tabs)') return tabName(focusedTab(route));
  if (/^(chat|agent)\/\[server\]\/\[agent\]$/.test(route.name)) return names.agent(server, agent);
  if (/^agent\/\[server\]\/\[agent\]\//.test(route.name)) return names.agent(server, agent);
  return ({
    'tools/[server]': 'Herramientas', 'server/[server]': names.server(server), 'usage/[server]': 'Uso', 'presets/[server]': 'Presets',
    'app-update/[server]': 'Actualización APK', 'jobs/[server]/[agent]/[job]': 'Tarea', 'notifications/[server]': 'Avisos',
    'notices/[server]/[notice]': 'Aviso', 'widget-preview': 'Widget', 'machinery-preview': 'Maquinaria', connect: 'Agregar Servidor',
  } as Record<string, string>)[route.name];
}

/** The place above `route` in the hierarchy, where a return goes when nothing real is under it. */
function parentOf(route: NavRoute, names: Names): Extract<Return, { action: 'parent' }> | null {
  const server = param(route, 'server'), agent = param(route, 'agent');
  const tab = (key: TabKey, select?: string) => ({ label: tabName(key)!, action: 'parent' as const, href: { pathname: `/${key}` }, ...(select ? { select } : {}) });
  if (/^(chat|agent)\/\[server\]\/\[agent\]$/.test(route.name)) return tab('agents');
  if (/^agent\/\[server\]\/\[agent\]\//.test(route.name)) return { label: names.agent(server, agent), action: 'parent', href: { pathname: '/agent/[server]/[agent]', params: { server, agent } } };
  if (['usage/[server]', 'presets/[server]', 'app-update/[server]'].includes(route.name)) return { label: names.server(server), action: 'parent', href: { pathname: '/server/[server]', params: { server } } };
  const parents: Record<string, [TabKey, boolean]> = {
    'tools/[server]': ['tools', true], 'jobs/[server]/[agent]/[job]': ['jobs', true], 'server/[server]': ['servers', false],
    'notifications/[server]': ['settings', false], 'notices/[server]/[notice]': ['approvals', false],
    'widget-preview': ['settings', false], 'machinery-preview': ['settings', false], connect: ['servers', false],
  };
  const parent = parents[route.name];
  return parent ? tab(parent[0], parent[1] && server ? server : undefined) : null;
}

/**
 * The return of the screen on top of the root stack, from the router's own state: the entry under
 * it, or the previous tab for Herram. An external entry (`entry: '1'`) or a screen with nothing
 * real under it returns to its parent in the hierarchy instead, so no screen is a dead end.
 */
export function returnFor(container: NavState | undefined, names: Names): Return | null {
  let root = container;
  // expo-router mounts the app's root stack inside its own `__root` slot.
  while (root?.routes?.[root.index]?.name === '__root') root = root.routes[root.index].state as NavState | undefined;
  const current = root?.routes?.[root.index];
  if (!current) return null;
  if (current.name === '(tabs)') {
    if (focusedTab(current) !== 'tools') return null;
    const tabs = current.state;
    const history = (tabs?.history ?? []) as { key?: string }[];
    const previous = history.length > 1 ? tabs?.routes?.find(r => r.key === history[history.length - 2]?.key) : undefined;
    const label = previous ? tabName(previous.name) : undefined;
    return label ? { label, action: 'back' } : { label: 'Agentes', action: 'parent', href: { pathname: '/agents' } };
  }
  const origin = param(current, 'entry') === '1' ? undefined : root!.routes[root!.index - 1];
  const label = origin ? placeLabel(origin, names) : undefined;
  return label ? { label, action: 'back' } : parentOf(current, names);
}

// The phone bar: keys of 66 every 72 from a 12 margin; APROB. is the sixth.
const BAR = { margin: 12, stride: 72, key: 66, count: TABS.length } as const;
const APPROVALS_LEFT = BAR.margin + TABS.findIndex(t => t.key === 'approvals') * BAR.stride;
const APPROVALS_RIGHT = APPROVALS_LEFT + BAR.key;
const BAR_WIDTH = 2 * BAR.margin + BAR.count * BAR.stride - (BAR.stride - BAR.key);

/** Whether the APROB. key is not wholly inside the bar scrolled to `x` with `viewport` width. */
export function approvalsHidden(x: number, viewport: number): boolean {
  return APPROVALS_LEFT < x || APPROVALS_RIGHT > x + viewport;
}
/** The scroll that brings APROB. into view with its margin, never past the content. */
export function revealApprovals(viewport: number): number {
  return Math.max(0, Math.min(APPROVALS_RIGHT + BAR.margin - viewport, BAR_WIDTH - viewport));
}
