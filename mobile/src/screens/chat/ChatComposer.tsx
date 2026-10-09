import { usePalette } from '@/theme/ThemeProvider';
import type { ReactNode } from 'react';
import { Platform, Pressable, TextInput, View, type TextStyle } from 'react-native';
import { F } from '@/theme/tokens';
import Svg, { Path } from 'react-native-svg';
import { Lamp } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { MicIcon, SendIcon } from '@/ui/icons';

const noOutline = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null;
/** Ink on the orange keys, the same in both themes. */
export interface ChatComposerProps {
  dictationActive?: boolean;
  attachmentControl?: ReactNode; attachmentPreview?: ReactNode; dictationControl?: ReactNode;
  disabled: boolean; sendBlocked: boolean; busy: boolean; hasAttachment: boolean; draft: string;
  onDraftChange: (draft: string) => void; onSend: () => void; onStop: () => void; onSteer: () => void;
  placeholder: string; bottom: number; typing: boolean;
  stopping?: boolean; steering?: boolean; stopBlocked?: boolean; workingLabel?: string;
}
/** Compositor (F-2): «+» 48, the radius-24 field and the orange 48 microphone, which sends once there is text. */
export function ChatComposer({ dictationActive = false, attachmentControl, attachmentPreview, dictationControl, disabled, sendBlocked, busy, hasAttachment, draft, onDraftChange, onSend, onStop, onSteer, placeholder, bottom, typing, stopping = false, steering = false, stopBlocked = false, workingLabel }: ChatComposerProps) {
  const { K } = usePalette();
  const blocked = disabled || sendBlocked || stopping;
  return (<>
    {attachmentPreview}
    <View style={{ marginHorizontal: 12, marginBottom: typing ? 8 : bottom, paddingTop: 6, gap: 8 }}>
      {busy ? <View style={{ paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Lamp tone="orange" />
        <M s={9.5} ls={0.06} c={K.ink} style={{ flex: 1 }}>{workingLabel ?? 'AGENTE TRABAJANDO'}</M>
        <M s={9.5} c={K.inkSecondary}>{draft.trim() ? 'REDIRIGIR · DETENER' : 'ESCRIBE PARA REDIRIGIR'}</M>
      </View> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {dictationActive ? <M s={9.5} c={K.inkSecondary} ls={0.06} lh={1.7} style={{ flex: 1 }}>MANTÉN PULSADO · ‹ DESLIZA PARA CANCELAR</M> : null}
        <View style={dictationActive ? { display: 'none' } : undefined} aria-hidden={dictationActive} accessibilityElementsHidden={dictationActive} importantForAccessibility={dictationActive ? 'no-hide-descendants' : 'auto'}>
        {!busy ? attachmentControl ?? <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: K.key, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center' }}><T s={22} c={K.ink}>+</T></View> : null}
        </View>
        <View aria-hidden={dictationActive} accessibilityElementsHidden={dictationActive} importantForAccessibility={dictationActive ? 'no-hide-descendants' : 'auto'} style={{ display: dictationActive ? 'none' : 'flex', flex: 1, minHeight: 48, borderRadius: 24, backgroundColor: K.field, boxShadow: K.shadowField, paddingHorizontal: 16, justifyContent: 'center' }}>
          <TextInput value={draft} onChangeText={onDraftChange}
            onSubmitEditing={() => { if (!blocked && !steering) { if (busy) { if (draft.trim()) onSteer(); } else onSend(); } }}
            editable={!disabled && !stopping} placeholder={placeholder} placeholderTextColor={K.inkTertiary} returnKeyType="send"
            style={[{ fontFamily: F.sans['400'], fontSize: 15, color: K.ink, padding: 0 }, noOutline]} />
        </View>
        {busy ? <>
          {draft.trim() ? <Pressable accessibilityRole="button" accessibilityLabel="Redirigir" accessibilityState={{ disabled: blocked || steering }} disabled={blocked || steering} onPress={onSteer}
            style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: K.ink, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center', opacity: blocked || steering ? 0.5 : 1 }}>
            <Svg width={19} height={19} viewBox="0 0 24 24"><Path d="M4 7h10a6 6 0 0 1 0 12H9M8 3L4 7l4 4" stroke={K.accent} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>
          </Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Detener" accessibilityState={{ disabled: disabled || stopping || stopBlocked }} disabled={disabled || stopping || stopBlocked} onPress={onStop}
            style={{ height: 48, paddingHorizontal: 14, borderRadius: 24, backgroundColor: K.accent, boxShadow: K.shadowPrimary, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled || stopping || stopBlocked ? 0.5 : 1 }}>
            <View style={{ width: 11, height: 11, borderRadius: 2, backgroundColor: K.onAccent }} />
            <M s={10} w="600" ls={0.06} c={K.onAccent}>{stopping ? 'DETENIENDO…' : 'DETENER'}</M>
          </Pressable>
        </> : dictationControl ?? <Pressable disabled={blocked} onPress={onSend} accessibilityRole="button" accessibilityState={{ disabled: blocked }} accessibilityLabel={draft.trim() || hasAttachment ? 'Enviar' : 'Dictar'}
          style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: K.accent, boxShadow: K.shadowPrimary, alignItems: 'center', justifyContent: 'center', opacity: blocked ? 0.5 : 1 }}>
          {draft.trim() || hasAttachment ? <SendIcon color={K.onAccent} /> : <MicIcon color={K.onAccent} />}
        </Pressable>}
      </View>
    </View>
  </>);
}
