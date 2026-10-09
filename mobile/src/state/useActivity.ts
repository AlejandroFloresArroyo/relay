import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ActivityPage, ActivityQuery } from '../../../protocol/activity';
import { ACTIVITY_ERROR_MESSAGES } from '../../../protocol/activity';
import { appendActivityPage, activityQueryPath } from '@/core/activity';
import { RelayError, type RelayClient } from '@/core/client';
import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import { DEMO, useApp } from './app';
import { demoActivityLastKnown } from '@/core/demoActivity';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';
import { readActivity } from './activityReads';
// Only allowlisted readings, scoped to the actual paired client, live in volatile memory.
const known = new WeakMap<RelayClient, Map<string, ActivityPage>>();
const denied = new WeakMap<RelayClient, ConnectionDiagnosis>();
type Phase = 'loading' | 'ready' | 'offline' | 'error' | 'blocked';
interface Reading { stamp: string; client: RelayClient; scope: string; page: ActivityPage | null; phase: Phase; notice: string | null; diagnosis: ConnectionDiagnosis | null }
export function useActivity(serverId: string, query: ActivityQuery, refreshKey = 0) {
  const app = useApp(); const visible = useChatVisible();
  const server = app.servers.find(entry => entry.id === serverId);
  const client = server ? app.clientFor(serverId) : null;
  const snap = app.snapshot(serverId);
  const filter = activityQueryPath({ ...query, cursor: undefined });
  const scope = JSON.stringify([serverId, server?.url, server?.key, server?.deviceId, filter]);
  const protocol = snap.protocol?.kind ?? null;
  const rejected = snap.down?.action === 'pair' || !!client && denied.has(client);
  const connected = snap.reachable === true && protocol === 'compatible' && !rejected;
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const [reading, setReading] = useState<Reading | null>(null);
  const [revision, setRevision] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const presenting = visible && focused && foreground;
  const [visibility, setVisibility] = useState({ presenting, generation: 0 });
  // Render-phase adjustment prevents even a first commit from publishing an old cursor.
  if (visibility.presenting !== presenting) setVisibility({ presenting, generation: visibility.generation + 1 });
  const stamp = JSON.stringify([scope, revision, refreshKey, visible, focused, foreground, connected, protocol, visibility.generation]);
  const epoch = useRef(0); const shown = useRef(false); const busy = useRef(false);
  const cursors = useRef(new Set<string>());
  const identity = useRef({ client, scope, connected, stamp });
  useLayoutEffect(() => {
    epoch.current++; identity.current = { client, scope, connected, stamp };
    shown.current = visible && focused && foreground;
    // This ref is an epoch, not a view: cleanup must retire the latest reading.
    const lifetime = epoch;
    return () => { lifetime.current++; shown.current = false; identity.current = { client: null, scope, connected: false, stamp }; };
  }, [client, scope, connected, protocol, visible, focused, foreground, revision, refreshKey, stamp]);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { epoch.current++; shown.current = false; setFocused(false); };
  }, [setFocused]));
  useEffect(() => {
    let windowFocused = true;
    const retire = () => {
      epoch.current++; shown.current = false; setRevision(n => n + 1); setForeground(false);
    };
    const sub = AppState.addEventListener('change', status => {
      if (status !== 'active') retire();
      else setForeground(windowFocused);
    });
    const blur = addWindowFocusListener('blur', () => { windowFocused = false; retire(); });
    const focus = addWindowFocusListener('focus', () => { windowFocused = true; setForeground(AppState.currentState === 'active'); });
    return () => { sub.remove(); blur.remove(); focus.remove(); };
  }, []);
  useLayoutEffect(() => {
    if (!client) return;
    if (snap.down?.action === 'pair') { denied.set(client, snap.down); known.delete(client); }
    if (protocol !== null && protocol !== 'compatible') known.delete(client);
  }, [client, protocol, snap.down]);
  // A retained native gesture belongs to the rendered reading, even after focus returns.
  const canInteract = () => shown.current && identity.current.client === client && identity.current.scope === scope && identity.current.stamp === stamp && !!client && !denied.has(client);
  const capture = () => {
    const generation = epoch.current;
    return () => generation === epoch.current && canInteract() && identity.current.connected;
  };
  const remember = (page: ActivityPage) => {
    if (!client) return;
    let cache = known.get(client); if (!cache) { cache = new Map(); known.set(client, cache); }
    cache.delete(filter); cache.set(filter, { ...page, nextCursor: null });
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
  };
  const onDenial = (error: unknown): boolean => {
    if (!client) return false;
    const diagnosis: ConnectionDiagnosis = error instanceof RelayError && error.code === 'protocol_upgrade_required'
      ? { kind: 'known', label: 'Actualiza Relay para consultar Actividad.', hint: 'El Puente requiere una versión posterior del protocolo.', action: 'retry', automaticRetry: false }
      : classifyConnectionError(error);
    if (diagnosis.action !== 'pair' && !(error instanceof RelayError && error.code === 'protocol_upgrade_required')) return false;
    denied.set(client, diagnosis); known.delete(client);
    // An old client cannot update a replacement's reading. Filter/view epochs do not
    // weaken a denial of the same client; every queued consumer is notified as well.
    if (identity.current.client === client) { setMoreBusy(false); setRevision(n => n + 1); }
    return true;
  };
  const failure = (error: unknown, previous: ActivityPage | null): Reading | null => {
    if (!client) return null;
    const diagnosis = classifyConnectionError(error);
    const notice = error instanceof RelayError && [404, 405, 501].includes(error.status ?? 0) ? 'Actualiza el Puente para consultar Actividad.'
      : error instanceof RelayError && error.code in ACTIVITY_ERROR_MESSAGES ? ACTIVITY_ERROR_MESSAGES[error.code as keyof typeof ACTIVITY_ERROR_MESSAGES]
          : 'No se pudo consultar Actividad. Reintenta.';
    return { stamp, client, scope, page: previous && { ...previous, nextCursor: null }, phase: error instanceof RelayError && ['unreachable', 'timeout'].includes(error.code) ? 'offline' : 'error', notice, diagnosis: diagnosis.kind === 'known' ? diagnosis : null };
  };
  useEffect(() => {
    cursors.current.clear(); busy.current = false;
    if (!client || !visible || !focused || !foreground) return;
    const previous = known.get(client)?.get(filter) ?? (DEMO ? demoActivityLastKnown(serverId, query, Date.now()) : null);
    let cancelled = false;
    const current = capture();
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setMoreBusy(false);
      if (rejected) { setReading({ stamp, client, scope, page: null, phase: 'blocked', notice: null, diagnosis: denied.get(client) ?? snap.down }); return; }
      if (snap.reachable === false && protocol === null) { setReading({ stamp, client, scope, page: null, phase: 'offline', notice: null, diagnosis: snap.down }); return; }
      if (protocol !== 'compatible') { setReading({ stamp, client, scope, page: null, phase: 'loading', notice: null, diagnosis: null }); return; }
      if (!connected) { setReading({ stamp, client, scope, page: previous, phase: 'offline', notice: null, diagnosis: snap.down }); return; }
      setReading({ stamp, client, scope, page: previous, phase: 'loading', notice: null, diagnosis: null });
      try {
        const page = await readActivity(client, { ...query, cursor: undefined }, () => !cancelled && current(), onDenial);
        if (!page || cancelled || !current()) return;
        remember(page); setReading({ stamp, client, scope, page, phase: 'ready', notice: null, diagnosis: null });
      } catch (error) { if (!cancelled && current()) setReading(failure(error, previous)); }
    });
    return () => { cancelled = true; };
    // Query identity is canonicalized above; every lifecycle change starts a new snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scope, connected, protocol, rejected, visible, focused, foreground, revision, refreshKey]);
  const same = reading?.client === client && reading.scope === scope;
  const active = visible && focused && foreground && !rejected && protocol === 'compatible';
  const currentReading = same && reading.stamp === stamp;
  const phase = rejected ? 'blocked' : visible && focused && foreground && snap.reachable === false && protocol === null ? 'offline' : active && same ? !connected ? 'offline' : currentReading ? reading.phase : 'loading' : 'loading';
  const page = active && same && reading.page ? { ...reading.page, nextCursor: phase === 'ready' && currentReading ? reading.page.nextCursor : null } : null;
  const loadMore = async () => {
    if (busy.current || phase !== 'ready' || !page?.nextCursor || !client) return;
    const current = capture(); if (!current()) return;
    const cursor = page.nextCursor;
    if (cursors.current.has(cursor)) return;
    busy.current = true; setMoreBusy(true);
    try {
      const next = await readActivity(client, { ...query, cursor }, current, onDenial);
      if (!next || !current()) return;
      if (next.nextCursor && cursors.current.has(next.nextCursor)) throw new RelayError('activity_cursor_expired', ACTIVITY_ERROR_MESSAGES.activity_cursor_expired);
      const merged = appendActivityPage(page, next);
      cursors.current.add(cursor); remember(merged);
      setReading({ stamp, client, scope, page: merged, phase: 'ready', notice: null, diagnosis: null });
    } catch (error) { if (current()) setReading(failure(error, page)); }
    finally { if (current()) { busy.current = false; setMoreBusy(false); } }
  };
  return { server, page, phase, active, presenting, moreBusy, connected, protocol,
    notice: active && currentReading ? reading.notice : null,
    diagnosis: rejected ? client && denied.get(client) || snap.down : active && currentReading ? reading.diagnosis : null,
    loadMore, canInteract,
    refresh: () => { if (!canInteract()) return; epoch.current++; void app.refresh(serverId); setRevision(n => n + 1); } };
}
