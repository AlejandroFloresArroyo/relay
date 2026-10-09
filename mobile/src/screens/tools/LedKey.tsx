import { Pressable, View } from 'react-native';

import { usePalette } from '@/theme/ThemeProvider';
import { ledGlow } from '@/theme/tokens';
import { M } from '@/ui/primitives';

export type LedKeyLook = 'idle' | 'active' | 'sticky';

/**
 * A key of the tools with its LED above the label (F-5): the tool bar's keys and the terminal's special keys.
 * `active` is the chosen tool (inverted, orange LED); `sticky` is a Ctrl or Alt waiting for the next key
 * (orange face, glow and the PEGADA caption).
 */
export function LedKey({ label, accessibilityLabel, look, onPress, width, radius = 10, size = 11, weight = '600', caption, ink }: {
  label: string; accessibilityLabel: string; look: LedKeyLook; onPress: () => void; width?: number; radius?: number;
  size?: number; weight?: '400' | '600'; caption?: string; ink?: string;
}) {
  const { K } = usePalette();
  const face = {
    idle: { backgroundColor: K.key, text: ink ?? K.ink, led: K.ledOff, shadow: K.shadowKey },
    active: { backgroundColor: K.ink, text: K.block, led: K.accent, shadow: '0px 2px 3px rgba(0,0,0,0.2)' },
    sticky: { backgroundColor: K.accent, text: K.onAccent, led: K.onAccent, shadow: K.shadowPrimary },
  }[look];
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected: look !== 'idle' }}
    hitSlop={{ left: 2, right: 2 }} onPress={onPress}
    style={{ width, flex: width ? undefined : 1, minHeight: 48, borderRadius: radius, backgroundColor: face.backgroundColor, boxShadow: face.shadow, alignItems: 'center', justifyContent: 'center', gap: 5 }}>
    <View style={{ width: 14, height: 3, borderRadius: 1, backgroundColor: face.led, boxShadow: look === 'idle' ? undefined : ledGlow(face.led) }} />
    <M s={size} w={weight} ls={0} c={face.text} numberOfLines={1}>{label}</M>
    {caption ? <M s={9.5} w="600" ls={0} c={face.text} style={{ position: 'absolute', bottom: 2 }}>{caption}</M> : null}
  </Pressable>;
}
