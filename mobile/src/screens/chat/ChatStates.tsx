import { usePalette } from '@/theme/ThemeProvider';
import { View } from 'react-native';

import { TEXT_GLOW } from '@/theme/tokens';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** A state of the Conversación, with the unified anatomy (D-ES): three LEDs, mono title, one phrase, one action. */
export function ChatStatePanel({ title, children, error = false, offline = false, action, onAction, countdown }: {
  title: string; children: string; error?: boolean; offline?: boolean;
  action?: string; onAction?: () => void; countdown?: number | null;
}) {
  const { K } = usePalette();
  return <RecessedScreen radius={20} style={{ padding: 20, gap: 12, boxShadow: error ? `${K.shadowScreen}, 0px 0px 0px 1px rgba(229,83,61,0.3)` : K.shadowScreen }}>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Lamp size={9} tone={offline || error ? 'off' : 'green'} onScreen />
      <Lamp size={9} tone={offline ? 'orange' : 'off'} onScreen />
      <Lamp size={9} tone={error ? 'red' : 'off'} onScreen />
    </View>
    <M s={13} w="600" lh={1.35} ls={0.08} c={error ? K.dangerTextOnScreen : K.onScreenBright} glow={error ? TEXT_GLOW.danger : undefined}>{title}</M>
    <T s={15} lh={1.45} c={K.onScreen}>{children}</T>
    {countdown != null ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Lamp tone="orange" /><M s={9.5} ls={0.06} c={K.onScreenLabel}>REINTENTO AUTOMÁTICO EN {countdown} S</M></View> : null}
    {action && onAction ? <Keycap variant={offline ? 'primary' : 'screen'} label={action} onPress={onAction} style={{ alignSelf: 'flex-start' }} /> : null}
  </RecessedScreen>;
}

export function ChatLoading() {
  const { K } = usePalette();
  return <View accessibilityLabel="Cargando conversación…" style={{ gap: 12, paddingTop: 12 }}>
    <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8 }}><Lamp tone="orange" /><M s={9.5} c={K.inkSecondary} ls={0.06}>CARGANDO CONVERSACIÓN…</M></View>
    <View style={{ alignSelf: 'flex-end', width: '68%', height: 58, borderRadius: 20, backgroundColor: K.field }} />
    <View style={{ width: '58%', height: 12, borderRadius: 5, backgroundColor: K.field }} />
    <View style={{ height: 96, borderRadius: 20, backgroundColor: K.field, opacity: 0.8 }} />
    <View style={{ width: '84%', height: 12, borderRadius: 5, backgroundColor: K.field }} />
    <View style={{ width: '46%', height: 12, borderRadius: 5, backgroundColor: K.field }} />
    <View style={{ alignSelf: 'flex-end', width: '52%', height: 48, borderRadius: 20, backgroundColor: K.field }} />
  </View>;
}
