import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { router } from 'expo-router';
import { widgetDestination, widgetScope, widgetTarget } from '@/core/widget';
import { useApp } from '@/state/app';
import { usePalette } from '@/theme/ThemeProvider';
import { useChatVisible } from '@/state/chatVisibility';
import { widgetNative } from './widgetNative';
import { addWindowFocusListener } from './windowFocus';

/**
 * Outside LockGate: the widget keeps following the selected Servidor while Relay is locked, in the
 * background or closed (Ale, 2026-10-05). Revocation, removal or another pairing retire it at once.
 */
export function WidgetTarget() {
  const app = useApp();
  const { mode } = usePalette();
  const server = app.servers.find(value => value.id === app.selectedServer);
  const snapshot = server ? app.snapshot(server.id) : null;
  // The same evidence of revocation that retires the Avisos pairing, for this pairing's own poll only.
  const revoked = !!server && !!snapshot && app.snapshotClient(server.id) === app.clientFor(server.id) && snapshot.connectionUrl === server.url && snapshot.down?.action === 'pair';
  const raw = app.ready ? widgetTarget(server, mode, revoked) : undefined;
  // Passive effect: runs after NotificationProvider's layout effect has reconciled the new pairing.
  useEffect(() => { if (raw !== undefined) try { widgetNative?.target(raw); } catch { /* The widget falls back to its neutral shortcut. */ } }, [raw]);
  return null;
}

/** Mounted inside LockGate: a widget tap only selects a read surface after the gate, never consent. */
export function WidgetBridge() {
  const app = useApp();
  const visible = useChatVisible();
  const [focused, setFocused] = useState(AppState.currentState === 'active');
  const [request, setRequest] = useState(0);
  const server = app.servers.find(value => value.id === app.selectedServer);
  const snapshot = server ? app.snapshot(server.id) : null;
  const scope = server ? widgetScope(server.id, server.deviceId, server.url) : null;
  const allowed = visible && focused && app.ready;
  const authorized = !!snapshot && snapshot.down?.action !== 'pair' && snapshot.protocol?.kind === 'compatible' && !snapshot.protocolStale;
  useEffect(() => {
    const state = AppState.addEventListener('change', value => setFocused(value === 'active'));
    const blur = addWindowFocusListener('blur', () => setFocused(false));
    const focus = addWindowFocusListener('focus', () => setFocused(AppState.currentState === 'active'));
    const listener = widgetNative?.addListener('openRequested', () => setRequest(value => value + 1));
    return () => { state.remove(); blur.remove(); focus.remove(); listener?.remove(); };
  }, []);
  useEffect(() => {
    if (!allowed || !widgetNative || (server && snapshot?.reachable === null)) return;
    const inbound = widgetNative.takeOpenRequest();
    const destination = widgetDestination(inbound, authorized ? scope : null, allowed);
    // Both destinations are tab roots: `navigate` from a stack screen would push a second set of tabs.
    if (destination) router.dismissTo(destination);
  }, [request, allowed, scope, authorized, server, snapshot?.reachable]);
  return null;
}
