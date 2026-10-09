// The navigation hooks of 3.1 (ADR 0007): tab switches, Servidor destinations and the return.
import { router, useFocusEffect, useLocalSearchParams, useNavigationContainerRef, type Href } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useRef, useSyncExternalStore } from 'react';
import { BackHandler } from 'react-native';

import { returnFor, type NavState, type Target, type TabKey } from '@/core/navigation';
import { useApp } from './app';

/**
 * Shows a tab from anywhere. `dismissTo` pops back to the tabs when they are under the current
 * screen; `navigate` from a stack screen would push a second set of tabs on top.
 */
export function goToTab(key: TabKey) { router.dismissTo(`/${key}` as Href); }

/** A destination of one Servidor (Herram., Tablero, Trabajo, Tareas): it becomes the selected one, then its tab shows. */
export function useOpenSection() {
  const { selectServer } = useApp();
  return useCallback((serverId: string, tab: TabKey) => { selectServer(serverId); goToTab(tab); }, [selectServer]);
}

/** `/work/[server]` and `/jobs/[server]`: external entries that select their Servidor and show its tab. */
export function ServerEntry({ tab }: { tab: 'work' | 'jobs' }) {
  const { server } = useLocalSearchParams<{ server: string }>();
  const open = useOpenSection();
  const { ready } = useApp();
  // Not <Redirect>: it would put a second set of tabs on top of the stack.
  const enter = useEffectEvent(() => { if (server) open(server, tab); });
  useEffect(() => { if (ready) enter(); }, [ready, server]);
  return null;
}

export type ReturnLink = { label: string; go: () => void };

/**
 * The return of the screen in front, «‹ <label>», computed from the router's own state (see
 * `returnFor`). `inner` overrides it for a subpage the screen draws itself (for instance, a
 * ficha's Aprobaciones page returning to its identity). Usable outside the navigator (the tools
 * host); `useReturn` also owns Android's back key.
 */
export function useReturnLink(inner?: ReturnLink | null): ReturnLink | null {
  const app = useApp();
  const root = useRootState();
  const found = returnFor(root, {
    agent: (server, agent) => app.snapshot(server).agents.find(a => a.id === agent)?.name ?? agent,
    server: server => app.servers.find(s => s.id === server)?.name ?? server,
  });
  // With no Servidor every parent is a tab, and the tabs send back to /connect: no return, the back key leaves Relay.
  if (!inner && app.servers.length === 0) return null;
  return inner ?? (found && {
    label: found.label,
    go: found.action === 'back' ? () => router.back() : () => {
      if (found.select) app.selectServer(found.select);
      router.dismissTo(target(found.href));
    },
  });
}

/** `useReturnLink` for a screen of the navigator: while it is focused, Android's back key runs the same `go`. */
export function useReturn(inner?: ReturnLink | null): ReturnLink | null {
  const link = useReturnLink(inner);
  const latest = useRef(link);
  useEffect(() => { latest.current = link; });
  // One listener per focus, reading the action from the ref: re-subscribing on each render would
  // put it above listeners registered later, like the Conversación panel's close-on-back.
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!latest.current) return false;
      latest.current.go();
      return true;
    });
    return () => subscription.remove();
  }, []));
  return link;
}

/**
 * The navigation container's whole state, re-read on every change. Not `useRootNavigationState`:
 * that one only reads at render, and throws outside a route (the tools host and the rail are).
 */
function useRootState(): NavState | undefined {
  const container = useNavigationContainerRef();
  const read = () => (container.isReady() ? container.getRootState() as NavState : undefined);
  // getRootState rebuilds the state on each call: keep one snapshot until the container says it changed.
  return useSyncExternalStore(
    useCallback((changed: () => void) => {
      const unsubscribe = container.addListener('state', () => { rootSnapshot = { state: read() }; changed(); });
      return () => { unsubscribe(); rootSnapshot = null; };
    }, [container]),
    () => (rootSnapshot ??= { state: read() }).state,
  );
}
let rootSnapshot: { state: NavState | undefined } | null = null;

const target = (href: Target) => (href.params ? { pathname: href.pathname, params: href.params } : href.pathname) as Href;
