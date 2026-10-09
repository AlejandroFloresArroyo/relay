import { usePalette } from '@/theme/ThemeProvider';
import { useRef, useState } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { RelayClient } from '@/core/client';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { useControlScope } from '@/state/useControlScope';
import { useApp, usePoll } from '@/state/app';
import { RADIUS, TYPE } from '@/theme/tokens';

import { Keycap } from '@/ui/kit';
import { HoldKey } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** The lid opens once lifted past this share of its height (G-1). */
const LID_OPENS = 0.55;
/** Ink on the orange paused face, the same in both themes. */
const FIXED_INK = '#1A1A19';

/**
 * Pausa general (F-4, G-1): lift the striped lid (it opens from 55 %), then hold the red button
 * 1 s in 50 ms / 5 % steps. Pausing asks for no fingerprint; resuming does.
 */
export function ServerPauseControl({ client, name, down, wide = false }: { client: RelayClient; name: string; down: boolean; wide?: boolean }) {
  const { K } = usePalette();
  const control = usePoll(() => client.serverControl(), [client], down ? null : 5000);
  const { refresh } = useApp();
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState<'pause' | 'resume' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);
  const paused = control.data?.paused === true;
  const remotePending = control.data?.phase === 'pending';
  const unconfirmed = control.data?.phase === 'failed' || paused && control.data?.hermesPaused !== true;
  const unavailable = down || !!control.error || !control.data;
  const blocked = unavailable || pending !== null || remotePending;
  const scope = useControlScope(client, !unavailable);
  const act = async (action: 'pause' | 'resume') => {
    if (busy.current || unavailable || remotePending) return;
    const current = scope.begin();
    if (!current) return;
    busy.current = true; setPending(action); setFailure(null);
    try {
      const confirmed = action !== 'resume' || await confirmWithFingerprint('Reanudar el Servidor con huella');
      if (!current()) return;
      if (!confirmed) {
        setFailure('No se confirmó la huella. El Servidor sigue en pausa.'); return;
      }
      const result = await (action === 'pause' ? client.pauseServer() : client.resumeServer());
      // The strip, Agentes and chat read the shared snapshot; refresh it now instead of on the next poll.
      if (current()) { control.setData(result); setArmed(false); refresh(); }
    } catch {
      if (!current()) return;
      setFailure('El cambio quedó sin confirmar. Revisa el estado y reintenta.'); control.reload();
    } finally { busy.current = false; setPending(null); }
  };
  const size = wide ? 96 : 80;
  const title = pending ? pending === 'pause' ? 'PAUSANDO…' : 'REANUDANDO…' : unavailable ? 'SIN RESPUESTA' : remotePending ? 'PENDIENTE…'
    : unconfirmed ? 'PAUSA SIN CONFIRMAR' : paused ? 'EN PAUSA' : `Pausar ${name}`;
  const phrase = paused ? 'Relay no admite Turnos nuevos. Reanudar requiere huella.'
    : armed ? 'Mantén el botón rojo 1 s para pausar.'
      : wide ? 'Levanta la tapa para armar el botón. Hermes retiene trabajo nuevo y tareas mientras dura la pausa.' : 'Levanta la tapa para armar el botón.';
  return <View style={{ padding: 12, gap: 12, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      {paused
        ? <View style={{ width: size, height: size, borderRadius: 16, backgroundColor: K.accent, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 8, height: 26, borderRadius: 2, backgroundColor: FIXED_INK }} /><View style={{ width: 8, height: 26, borderRadius: 2, backgroundColor: FIXED_INK }} />
        </View>
        : armed
          ? <HoldKey accessibilityLabel="Mantener para pausar el Servidor" stepped disabled={blocked} onComplete={() => { void act('pause'); }}
            style={{ width: size, height: size, borderRadius: 16, paddingHorizontal: 0, backgroundColor: K.danger }}>
            <M {...TYPE.label} c={K.onScreenBright}>PAUSA</M>
          </HoldKey>
          : <PauseLid size={size} disabled={blocked} onOpen={() => setArmed(true)} />}
      <View style={{ flex: 1, gap: 4 }}>
        <M s={9.5} ls={0.08} c={K.inkTertiary}>PAUSA GENERAL</M>
        <T {...TYPE.block} c={K.ink}>{title}</T>
        <T {...TYPE.secondary} c={K.inkSecondary}>{phrase}</T>
      </View>
    </View>
    {paused ? <Keycap label="Reanudar con huella" disabled={blocked} onPress={() => { void act('resume'); }} /> : null}
    {armed && !paused ? <Keycap variant="link" label="Cerrar tapa" disabled={pending !== null} onPress={() => setArmed(false)} /> : null}
    {unconfirmed ? <T {...TYPE.secondary} c={K.inkSecondary}>Relay bloquea Turnos nuevos. No se confirmó la pausa completa de Hermes; revisa y reintenta.</T> : null}
    {failure || control.data?.phase === 'failed' ? <T {...TYPE.secondary} c={K.dangerText}>{failure ?? 'La pausa no se confirmó por completo. Reintenta pausar antes de reanudar.'}</T> : null}
    {control.data?.phase === 'failed' && !pending ? <Keycap label="Reintentar" accessibilityLabel="Repetir la pausa general" onPress={() => { void act('pause'); }} /> : null}
  </View>;
}

// RN draws CSS gradients from `experimental_backgroundImage`; react-native-web takes the CSS property.
// The orange stripe is the accent at 40 %, the same in both themes.
const stripes = (light: string) => {
  const css = `repeating-linear-gradient(-45deg, rgba(242,154,26,0.4) 0px, rgba(242,154,26,0.4) 6px, ${light} 6px, ${light} 12px)`;
  return (Platform.OS === 'web' ? { backgroundImage: css } : { experimental_backgroundImage: css }) as ViewStyle;
};

/** The striped lid over the red button: dragged up, it follows the finger and opens past 55 %; short of it, it falls back. */
function PauseLid({ size, disabled, onOpen }: { size: number; disabled: boolean; onOpen: () => void }) {
  const { K } = usePalette();
  const lift = useSharedValue(0);
  const pan = Gesture.Pan().withTestId('pause-lid').enabled(!disabled)
    .onUpdate(event => { lift.set(Math.min(Math.max(-event.translationY, 0), size)); })
    .onEnd(event => {
      if (Math.min(Math.max(-event.translationY, 0), size) / size >= LID_OPENS) scheduleOnRN(onOpen);
      else lift.set(withTiming(0, { duration: 200 }));
    });
  const raised = useAnimatedStyle(() => ({ transform: [{ translateY: -lift.get() }] }));
  return <View style={{ width: size, height: size, borderRadius: 16, backgroundColor: K.field, boxShadow: K.shadowField, opacity: disabled ? 0.45 : 1 }}>
    <GestureDetector gesture={pan}>
      {/* A screen reader cannot drag: its activation lifts the lid; the 1 s hold still follows. */}
      <Animated.View accessible accessibilityRole="button" accessibilityLabel="Levantar tapa de Pausa general" accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={() => { if (!disabled) onOpen(); }}
        style={[{ flex: 1, borderRadius: 16, overflow: 'hidden', boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 6 }, stripes(K.key), raised]}>
        <View style={{ paddingHorizontal: 4, borderRadius: 4, backgroundColor: K.key }}><M s={9.5} w="600" c={K.ink}>↑ LEVANTAR</M></View>
      </Animated.View>
    </GestureDetector>
  </View>;
}
