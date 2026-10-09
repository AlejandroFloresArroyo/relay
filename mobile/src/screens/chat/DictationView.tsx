import { usePalette } from '@/theme/ThemeProvider';
import { useRef } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';

import { TEXT_GLOW } from '@/theme/tokens';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { MicIcon } from '@/ui/icons';
import type { DictationPhase } from './useDictation';

/** Ink on the orange microphone, the same in both themes. */

interface Props {
  phase: DictationPhase; text: string; elapsed: number; disabled: boolean;
  onBegin(): void; onRelease(): void; onCancel(): void;
}
export function DictationButton({ disabled, large, onBegin, onRelease, onCancel }: Pick<Props, 'disabled' | 'onBegin' | 'onRelease' | 'onCancel'> & { large?: boolean }) {
  const { K } = usePalette();
  const origin = useRef(0);
  return <Pressable accessibilityRole="button" accessibilityLabel="Dictar" accessibilityHint="Mantén pulsado para dictar; suelta para revisar. Desliza a la izquierda para cancelar." accessibilityState={{ disabled }} disabled={disabled}
    onPressIn={(event) => { origin.current = event.nativeEvent.pageX; onBegin(); }} onPressOut={onRelease}
    onTouchMove={(event) => { if (event.nativeEvent.pageX < origin.current - 60) onCancel(); }}
    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'activate') onBegin(); if (event.nativeEvent.actionName === 'stop') onRelease(); if (event.nativeEvent.actionName === 'cancel') onCancel(); }}
    accessibilityActions={[{ name: 'activate', label: 'Empezar dictado' }, { name: 'stop', label: 'Terminar dictado' }, { name: 'cancel', label: 'Cancelar dictado' }]}
    style={{ width: large ? 68 : 48, height: large ? 68 : 48, borderRadius: 34, backgroundColor: disabled && !large ? K.field : K.accent, boxShadow: disabled && !large ? undefined : K.shadowPrimary, alignItems: 'center', justifyContent: 'center', opacity: disabled && !large ? 0.5 : 1 }}><MicIcon size={large ? 26 : 20} color={disabled && !large ? K.ink : K.onAccent} /></Pressable>;
}
export function DictationNotice({ phase }: { phase: DictationPhase }) {
  const { K } = usePalette();
  if (!['model-missing', 'permission-missing', 'error', 'blocked'].includes(phase)) return null;
  const denied = phase === 'permission-missing';
  const red = denied || phase === 'error';
  return <RecessedScreen radius={20} style={{ marginHorizontal: 12, marginBottom: 8, padding: 20, gap: 12 }}>
    <View style={{ flexDirection: 'row', gap: 6 }}><Lamp tone="off" size={9} onScreen /><Lamp tone="off" size={9} onScreen /><Lamp tone={red ? 'red' : 'off'} size={9} onScreen /></View>
    <M accessibilityRole="alert" s={13} w="600" ls={0.08} c={red ? K.dangerTextOnScreen : K.onScreenBright} glow={red ? TEXT_GLOW.danger : undefined}>{denied ? 'SIN PERMISO DE MICRÓFONO' : phase === 'model-missing' ? 'FALTA EL MODELO DE VOZ' : phase === 'blocked' ? 'MICRÓFONO SIN RESPUESTA' : 'NO SE PUDO DICTAR'}</M>
    <T s={15} lh={1.45} c={K.onScreen}>{denied ? 'Relay no tiene permiso para usar el micrófono.' : phase === 'model-missing' ? 'El micrófono no graba hasta que el teléfono tenga instalado el modelo de voz en español.' : phase === 'blocked' ? 'El micrófono sigue cerrándose. Si no se recupera, cierra y vuelve a abrir Relay.' : 'El dictado se interrumpió. Mantén pulsado el micrófono para reintentar.'}</T>
    {denied ? <Keycap variant="screen" label="Abrir ajustes" accessibilityLabel="Abrir ajustes" onPress={() => { void Linking.openSettings().catch(() => {}); }} style={{ alignSelf: 'flex-start' }} /> : null}
  </RecessedScreen>;
}
export function DictationView({ phase, text, elapsed }: Pick<Props, 'phase' | 'text' | 'elapsed'>) {
  const { K } = usePalette();
  return <View style={{ marginHorizontal: 12, marginBottom: 8, gap: 10 }}>
    <RecessedScreen rim radius={20} style={{ paddingVertical: 14, paddingHorizontal: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><Lamp tone="orange" />
        <M s={9.5} ls={0.08} c={K.accent} style={{ flex: 1 }}>{phase === 'finishing' ? 'TERMINANDO…' : phase === 'checking' ? 'COMPROBANDO…' : 'DICTANDO'}</M>
        <M s={9.5} c={K.onScreen}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</M>
      </View>
      <ScrollView style={{ maxHeight: 150 }}><T s={15} lh={1.45} c={K.onScreenBright} accessibilityLiveRegion="polite">{text || 'Habla para dictar…'}</T></ScrollView>
      <M s={9.5} ls={0.05} lh={1.6} c={K.onScreenLabel}>EL RECONOCIMIENTO OCURRE EN EL TELÉFONO. EL AUDIO NO SALE DEL DISPOSITIVO.</M>
    </RecessedScreen>
  </View>;
}
