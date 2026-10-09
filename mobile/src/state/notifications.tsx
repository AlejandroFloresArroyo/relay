import * as SecureStore from 'expo-secure-store';
import { router, useFocusEffect } from 'expo-router';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useCallback } from 'react';
import { createNotificationCache, notificationCacheKey, notificationLegacyCacheScope } from '@/core/notificationCache';
import { createPrivateNotificationFetch } from '@/core/notificationTransport';
import { createNotificationClient, notificationOpenTarget } from '@/core/notifications';
import { notificationNative, notificationCacheScope } from '@/native/notifications';
import { DEMO, useApp } from './app';
import type { RelayClient } from '@/core/client';
import type { ServerEntry } from './app';
import { createNotificationDemoClient } from '@/core/notificationDemo';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';

type RetirementCapture = (serverId: string) => () => boolean;
const RetirementContext = createContext<RetirementCapture | null>(null);
const CacheContext = createContext<ReturnType<typeof createNotificationCache> | null>(null);
// Only mounted providers are retained; late authorized retirement reaches a replacement provider.
const mountedCaches = new Set<ReturnType<typeof createNotificationCache>>();
function retireScope(cache: ReturnType<typeof createNotificationCache>, scope: string) {
  for (const consumer of new Set([cache, ...mountedCaches])) void consumer.revoke(scope).catch(() => {});
}
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => createNotificationCache({
    read: scope => SecureStore.getItemAsync(notificationCacheKey(scope)),
    write: (scope, value) => SecureStore.setItemAsync(notificationCacheKey(scope), value),
    remove: scope => SecureStore.deleteItemAsync(notificationCacheKey(scope)),
  }));
  useLayoutEffect(() => {
    mountedCaches.add(cache);
    return () => { mountedCaches.delete(cache); };
  }, [cache]);
  const app = useApp();
  const previous = useRef(new Map<string, string | null>());
  const legacy = useRef(new Set<string>());
  const owners = useRef(new Map<string, {client: RelayClient; server: ServerEntry}>());
  const captureRetirement = useCallback((serverId: string) => {
    const owner = owners.current.get(serverId);
    if (!owner || !notificationNative?.forgetIfCurrent) return () => false;
    const scope = notificationCacheScope(owner.server);
    let generation: number;
    try { generation = notificationNative.status(serverId).generation; } catch { return () => false; }
    return () => {
      // Retirement belongs to the captured pairing/enrollment, independently of UI visibility.
      if (owners.current.get(serverId) !== owner) return false;
      try {
        const raw = JSON.stringify({serverId,url:owner.server.url,key:owner.server.key,deviceId:owner.server.deviceId ?? ''});
        if (!notificationNative?.forgetIfCurrent(raw,generation)) return false;
        if (scope) retireScope(cache, scope);
        return true;
      } catch { return false; }
    };
  }, [cache]);
  // This runs outside LockGate: polling revocation must retire pending writes even while hidden.
  useLayoutEffect(() => {
    if (!app.ready) return;
    for (const server of app.servers) {
      const client = app.clientFor(server.id);
      if (owners.current.get(server.id)?.client !== client) owners.current.set(server.id,{client,server});
    }
    for (const id of owners.current.keys()) if (!app.servers.some(server => server.id === id)) owners.current.delete(id);
    const scopes = new Map(app.servers.map(server => [server.id, notificationCacheScope(server)]));
    for (const [id, scope] of previous.current) if (scope && scopes.get(id) !== scope) retireScope(cache, scope);
    previous.current = scopes;
    if (DEMO) return;
    const nativeScopes = app.servers.map(server => {
      const old = notificationLegacyCacheScope(server);
      if (!legacy.current.has(old)) { legacy.current.add(old); void cache.revoke(old).catch(() => {}); }
      const snapshot = app.snapshot(server.id);
      const revoked = app.snapshotClient(server.id) === app.clientFor(server.id) && snapshot.connectionUrl === server.url && snapshot.down?.action === 'pair';
      const scope = scopes.get(server.id);
      if (revoked && scope) retireScope(cache, scope);
      return { serverId: server.id, url: server.url, key: server.key, deviceId: server.deviceId ?? '', revoked };
    });
    try { notificationNative?.reconcile(JSON.stringify(nativeScopes)); } catch { /* Native actions fail closed. */ }
  }, [app, cache]);
  useEffect(() => {
    if (DEMO || !app.ready || !notificationNative) return;
    const check = () => {
      if (AppState.currentState !== 'active') return;
      try {
        const open = notificationOpenTarget(notificationNative?.takeOpen());
        if (open && app.servers.some(server => server.id === open.serverId && (app.snapshotClient(server.id) !== app.clientFor(server.id) || app.snapshot(server.id).down?.action !== 'pair'))) {
          app.closeApproval();
          // An external entry: its Servidor becomes the selected one, and the approval returns to its parent.
          app.selectServer(open.serverId);
          if (open.kind === 'approval') router.push({ pathname: '/notices/[server]/[notice]', params: { server: open.serverId, notice: open.noticeId, entry: '1' } });
          else router.dismissTo(open.pathname);
        }
      } catch { /* Unknown native gestures never authorize a decision. */ }
    };
    check(); const timer = setInterval(check, 500); return () => clearInterval(timer);
  }, [app]);
  return <RetirementContext.Provider value={captureRetirement}><CacheContext.Provider value={cache}>{children}</CacheContext.Provider></RetirementContext.Provider>;
}
export function useNotificationCache() {
  const cache = useContext(CacheContext);
  if (!cache) throw new Error('NotificationProvider required');
  return cache;
}
/** Each captured operation belongs to one visible, focused pairing generation for at most 60 s. */
export function useNotificationSession(serverId: string, resource: string) {
  const app = useApp();
  const cache = useNotificationCache();
  const retire = useContext(RetirementContext);
  if (!retire) throw new Error('NotificationProvider required');
  const captureRetirement = useCallback(() => retire(serverId), [retire, serverId]);
  const server = app.servers.find(item => item.id === serverId);
  const snapshot = app.snapshot(serverId);
  const ownsSnapshot = !!server && app.snapshotClient(serverId) === app.clientFor(serverId) && snapshot.connectionUrl === server.url;
  const visible = useChatVisible();
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const state = useRef({ generation: 0, alive: false, visible: false });
  const identity = JSON.stringify([serverId, server?.url, server?.deviceId, server?.key, resource]);
  const cacheScope = server ? notificationCacheScope(server) : null;
  const retired = useSyncExternalStore(cache.subscribe,
    useCallback(() => !DEMO && !!cacheScope && cache.retired(cacheScope), [cache, cacheScope]),
    () => false);
  const blocked = !server?.deviceId || retired || (ownsSnapshot && (snapshot.down?.action === 'pair' || (snapshot.protocol && snapshot.protocol.kind !== 'compatible')));
  const client = useMemo(() => server ? (DEMO ? createNotificationDemoClient(resource) : createNotificationClient({ baseUrl: server.url, key: server.key, deviceId: server.deviceId, fetch: createPrivateNotificationFetch({serverId:server.id,url:server.url,key:server.key,deviceId:server.deviceId ?? ''},notificationNative ? (...args)=>notificationNative!.request(...args) : null) })) : null, [server, resource]);
  useLayoutEffect(() => {
    const current = state.current; current.generation++;
    current.visible = visible && focused && foreground && !blocked;
    return () => { current.generation++; current.visible = false; };
  }, [identity, client, visible, focused, foreground, blocked]);
  useEffect(() => {
    const current = state.current; current.alive = true;
    return () => { current.alive = false; current.visible = false; current.generation++; };
  }, []);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { try { notificationNative?.invalidateRequests(); } catch { /* Fail closed. */ } state.current.generation++; state.current.visible = false; setFocused(false); };
  }, [setFocused]));
  useEffect(() => {
    const hide = () => { try { notificationNative?.invalidateRequests(); } catch { /* Requests fail closed. */ } state.current.generation++; state.current.visible = false; setForeground(false); };
    const change = AppState.addEventListener('change', value => { if (value !== 'active') hide(); else setForeground(true); });
    const blur = addWindowFocusListener('blur', hide);
    const focus = addWindowFocusListener('focus', () => setForeground(AppState.currentState === 'active'));
    return () => { change.remove(); blur.remove(); focus.remove(); };
  }, []);
  const capture = useCallback(() => {
    const generation = state.current.generation; const started = Date.now();
    return () => state.current.alive && state.current.visible && state.current.generation === generation && AppState.currentState === 'active' && Date.now() >= started && Date.now() - started < 60000 && (DEMO || !cacheScope || !cache.retired(cacheScope));
  }, [cache, cacheScope]);
  const diagnosis = ownsSnapshot ? snapshot.down : null;
  const shown = visible && focused && foreground && !blocked;
  return useMemo(() => ({server,client,capture,captureRetirement,visible:shown,blocked,diagnosis}), [server,client,capture,captureRetirement,shown,blocked,diagnosis]);
}
