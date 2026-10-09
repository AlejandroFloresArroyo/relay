// The Servidor selector (ADR 0007): header switch, rail keys and the Servidores sheet, plus the
// ServerSection that feeds the selected Servidor to the per-Servidor tabs.
import { Fragment, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { agentActivity, serverLight } from '@/core/machinery';
import { useApp } from '@/state/app';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { ServerSwitch } from './headers';
import { Lamp, type LampTone } from './kit';
import { ShellNavigationContext } from './layoutContext';
import { RecessedScreen, Sweep } from './machinery';
import { M, T } from './primitives';
import { CompactStatusContext } from './ServerConnectionStatus';
import { Sheet, Toast } from './sheet';
import { StateRow } from './states';

const SHAKE_MS = 400;

// The selector's toast lives at the root (`SelectorToast`) so it outlives the sheet and any screen.
let toast: { id: number; text: string } | null = null;
const toastListeners = new Set<() => void>();
function setToast(text: string | null) {
  toast = text === null ? null : { id: (toast?.id ?? 0) + 1, text };
  for (const listener of toastListeners) listener();
}
function subscribeToast(listener: () => void) {
  toastListeners.add(listener);
  return () => { toastListeners.delete(listener); };
}

/** Mounted once under a full-window parent: the selector's «<name> sin respuesta». */
export function SelectorToast() {
  const current = useSyncExternalStore(subscribeToast, () => toast);
  return current ? <Toast key={current.id} message={current.text} onHide={() => { setToast(null); }} /> : null;
}

/** A Servidor's LED: green answering, red not answering, off while unknown. */
export function serverLed(reachable: boolean | null): LampTone {
  return reachable === true ? 'green' : reachable === false ? 'red' : 'off';
}

/** The selected Servidor's key; pressing it opens the Servidores sheet. */
export function ServerSelector({ variant }: { variant: 'header' | 'rail' | 'railCollapsed' }) {
  const { K } = usePalette();
  const { servers, selectedServer, selectServer, snapshot } = useApp();
  const [open, setOpen] = useState(false);
  const [shaking, setShaking] = useState<string | null>(null);
  // The sheet closes when the unanswered row's shake ends.
  useEffect(() => {
    if (!shaking) return;
    const timer = setTimeout(() => { setShaking(null); setOpen(false); }, SHAKE_MS);
    return () => { clearTimeout(timer); };
  }, [shaking]);
  const server = servers.find(s => s.id === selectedServer);
  if (!server) return null;
  const snap = snapshot(server.id);
  const led = serverLed(snap.reachable);
  const show = () => { setOpen(true); };
  const choose = (id: string, name: string) => {
    selectServer(id);
    if (snapshot(id).reachable === false) { setShaking(id); setToast(`${name} sin respuesta`); } else setOpen(false);
  };
  // A Servidor that stopped answering keeps its last Agentes in the snapshot; its key goes dark.
  const light = snap.reachable === false ? 'off' : serverLight(snap.agents.map(agentActivity));
  const key = variant === 'header' ? <ServerSwitch name={server.name} led={led} onPress={show} />
    : variant === 'railCollapsed' ? <Pressable accessibilityRole="button" accessibilityLabel={`Servidor ${server.name}`} onPress={show}
      style={{ width: 72, height: 48, borderRadius: 14, backgroundColor: K.screen, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      <Lamp tone={led} />
      <M s={9.5} c={K.onScreenBright}>{server.name.slice(0, 2).toUpperCase()}</M>
    </Pressable>
    : <Pressable accessibilityRole="button" accessibilityLabel={`Servidor ${server.name}`} onPress={show}>
      <RecessedScreen radius={14} style={{ width: 200, minHeight: 68, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center', gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Lamp tone={led} size={8} />
          <View style={{ flex: 1 }}>
            <M s={9.5} ls={0.06} c={K.onScreenLabel}>SERVIDOR</M>
            <T s={15} w="700" c={K.onScreenBright} numberOfLines={1}>{server.name}</T>
          </View>
          <T s={16} c={K.accent}>⇕</T>
        </View>
        {light !== 'off' ? <View testID="server-sweep"><Sweep tone={light} /></View> : null}
      </RecessedScreen>
    </Pressable>;
  return <>
    {key}
    <Sheet visible={open} onClose={() => { setOpen(false); }} title="Servidores">
      <View style={{ borderRadius: 20, backgroundColor: K.field, paddingHorizontal: 12 }}>
        {servers.map((s, i) => <ServerChoice key={s.id} name={s.name} reachable={snapshot(s.id).reachable} shaking={shaking === s.id}
          first={i === 0} onPress={() => { choose(s.id, s.name); }} />)}
      </View>
    </Sheet>
  </>;
}

function ServerChoice({ name, reachable, shaking, first, onPress }: { name: string; reachable: boolean | null; shaking: boolean; first: boolean; onPress: () => void }) {
  const { K } = usePalette();
  const shift = useSharedValue(0);
  useEffect(() => {
    if (!shaking) return;
    const step = (to: number) => withTiming(to, { duration: SHAKE_MS / 4, reduceMotion: ReduceMotion.System });
    shift.set(withSequence(step(-6), step(6), step(-6), step(0)));
  }, [shaking, shift]);
  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: shift.get() }] }));
  const status = reachable === true ? 'EN LÍNEA' : reachable === false ? 'SIN RESPUESTA' : 'CONECTANDO…';
  return <Animated.View style={[{ borderTopWidth: first ? 0 : 1, borderTopColor: K.line }, shake]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${name}, ${status}`} onPress={onPress}
      style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Lamp tone={serverLed(reachable)} size={8} />
      <T {...TYPE.body} c={K.ink} style={{ flex: 1 }}>{name}</T>
      <M s={9.5} w="600" ls={0.06} c={reachable === false ? K.dangerText : K.inkTertiary}>{status}</M>
    </Pressable>
  </Animated.View>;
}

/** The selector for a root header's right slot: on phone the header key; on tablet the rail has it. */
export function HeaderServerSelector() {
  const shell = useContext(ShellNavigationContext);
  return shell ? null : <ServerSelector variant="header" />;
}

/** The compact «SIN RESPUESTA» row of an unresponsive Servidor, for under a section's header. */
export function ServerDown({ serverId }: { serverId: string }) {
  const { servers, snapshot, refresh } = useApp();
  const server = servers.find(s => s.id === serverId);
  if (!server || snapshot(serverId).reachable !== false) return null;
  return <View style={{ paddingVertical: 8 }}><StateRow name={server.name} kind="unreachable" onRetry={() => { refresh(serverId); }} /></View>;
}

/**
 * A per-Servidor tab's body: the screen takes the top inset (phone) and builds its own header with
 * `HeaderServerSelector` and `ServerDown`; `children(id)` is re-keyed when the selection changes.
 */
export function ServerSection({ children }: { children: (serverId: string) => ReactNode }) {
  const { K } = usePalette();
  const { servers, selectedServer } = useApp();
  const shell = useContext(ShellNavigationContext);
  const server = servers.find(s => s.id === selectedServer);
  if (!server) return null;
  const body = <CompactStatusContext.Provider value={true}>
    <Fragment key={server.id}>{children(server.id)}</Fragment>
  </CompactStatusContext.Provider>;
  return <View style={{ flex: 1, backgroundColor: shell ? undefined : K.background }}>{body}</View>;
}
