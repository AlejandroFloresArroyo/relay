// Rows of Ajustes and Avisos (D-04, D-19): switch rows with their LED, and radio rows.
// They sit inside a `ListBlock`, which draws the rules between them.
import { Pressable, View } from 'react-native';

import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { Lamp } from './kit';
import { T } from './primitives';

/** The 46×26 switch of K-1: ink track when on, the field's well when off, the knob always 20. */
/** The switch's track and knob, for a switch that is not a `SwitchRow`. */
export function SwitchTrack({ on }: { on: boolean }) {
  const { K, mode } = usePalette();
  return <View style={{ width: 46, height: 26, borderRadius: 13, backgroundColor: on ? K.ink : K.field, boxShadow: 'inset 0px 1px 3px rgba(0,0,0,0.25)' }}>
    <View style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: 10, backgroundColor: mode === 'dark' ? K.block : '#F7F6F2', boxShadow: '0px 1px 3px rgba(0,0,0,0.35)' }} />
  </View>;
}

/**
 * Fila con interruptor: title, optional description, the LED (green when on) and the switch.
 * `dim` is for what the Puente does not offer; `readOnly` draws the switch without a gesture.
 */
export function SwitchRow({ title, description, on, onChange, disabled = false, dim = false, readOnly = false, accessibilityLabel }: {
  title: string; description?: string; on: boolean; onChange?: (next: boolean) => void; disabled?: boolean; dim?: boolean; readOnly?: boolean; accessibilityLabel?: string;
}) {
  const { K } = usePalette();
  const content = <>
    <View style={{ flex: 1, gap: 2 }}>
      <T {...TYPE.body} c={K.ink}>{title}</T>
      {description ? <T {...TYPE.secondary} c={K.inkSecondary}>{description}</T> : null}
    </View>
    <Lamp testID="switch-led" tone={on ? 'green' : 'off'} size={6} />
    <SwitchTrack on={on} />
  </>;
  const row = { minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: dim ? 0.45 : 1 } as const;
  return readOnly
    ? <View accessible accessibilityRole="switch" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ checked: on, disabled: true }} style={row}>{content}</View>
    : <Pressable role="switch" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange?.(!on)} style={row}>{content}</Pressable>;
}

/** Fila de selección única: a ring that takes the orange LED when chosen. */
export function RadioRow({ title, description, checked, onPress }: { title: string; description?: string; checked: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="radio" accessibilityLabel={title} accessibilityState={{ checked }} onPress={onPress}
    style={{ minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
    <View style={{ flex: 1, gap: 2 }}>
      <T {...TYPE.body} c={K.ink}>{title}</T>
      {description ? <T {...TYPE.secondary} c={K.inkSecondary}>{description}</T> : null}
    </View>
    <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', boxShadow: `inset 0px 0px 0px 2px ${checked ? K.accent : K.inkTertiary}` }}>
      {checked ? <Lamp tone="orange" size={10} /> : null}
    </View>
  </Pressable>;
}
