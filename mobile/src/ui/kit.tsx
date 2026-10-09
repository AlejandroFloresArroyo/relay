// Base pieces of Relay 3.1 (K-1): keys, returns, LEDs, list blocks and the segmented control.
import { Children, type ReactNode } from 'react';
import { Image, Pressable, View, useWindowDimensions, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE, ledGlow } from '@/theme/tokens';
import { Dither, M, T } from './primitives';

/** A dark LED inside a recessed screen, the same in both themes. */
const LED_OFF_ON_SCREEN = '#3A3936';
/** A key inside a recessed screen (D-11), the same in both themes. */
const KEY_ON_SCREEN = '#2A2927';

// ---------------------------------------------------------------- LED

export type LampTone = 'green' | 'orange' | 'red' | 'off';

/** A K-1 LED: lit ones glow; `onScreen` darkens an unlit one for a recessed screen. */
export function Lamp({ tone, size = 7, onScreen = false, testID }: { tone: LampTone; size?: number; onScreen?: boolean; testID?: string }) {
  const { K } = usePalette();
  const color = { green: K.ok, orange: K.accent, red: K.danger, off: onScreen ? LED_OFF_ON_SCREEN : K.ledOff }[tone];
  return <View testID={testID} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, boxShadow: tone === 'off' ? undefined : ledGlow(color) }} />;
}

export type TrioState = 'on' | 'busy' | 'err' | 'off';

/** ON / BSY / ERR: 7 px LEDs over Mono 9.5; only the Agente's current one is lit and inked. */
export function LedTrio({ state }: { state: TrioState }) {
  const { K } = usePalette();
  const cells = [['on', 'ON', 'green'], ['busy', 'BSY', 'orange'], ['err', 'ERR', 'red']] as const;
  const spoken = { on: 'encendido', busy: 'ocupado', err: 'con error', off: 'apagado' }[state];
  return <View accessible accessibilityLabel={`Estado: ${spoken}`} style={{ flexDirection: 'row', gap: 6 }}>
    {cells.map(([key, label, tone]) => <View key={key} style={{ alignItems: 'center', gap: 3 }}>
      <Lamp tone={state === key ? tone : 'off'} />
      <M s={9.5} c={state === key ? K.ink : K.inkTertiary}>{label}</M>
    </View>)}
  </View>;
}

// ---------------------------------------------------------------- keys

export type KeycapVariant = 'normal' | 'primary' | 'dark' | 'danger' | 'link' | 'screen';

/**
 * Tecla: sinks 1 px and takes the pressed shadow in 80 ms. Labels in sentence case.
 * `primary` is the orange key, `dark` the inverted one, `danger` red text, `link` the orange text
 * link («Reintentar»), `screen` the dark key inside a recessed screen. Touch zone at least 48.
 */
export function Keycap({ label, onPress, variant = 'normal', disabled = false, accessibilityLabel, style }: {
  label: string; onPress: () => void; variant?: KeycapVariant; disabled?: boolean; accessibilityLabel?: string; style?: StyleProp<ViewStyle>;
}) {
  const { K } = usePalette();
  const ring = `0px 0px 0px 1px ${K.line}`;
  if (variant === 'link') {
    return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={[{ minHeight: 48, minWidth: 48, justifyContent: 'center', opacity: disabled ? 0.45 : 1 }, style]}>
      <T {...TYPE.body} c={K.accentText}>{label}</T>
    </Pressable>;
  }
  const face = {
    normal: { backgroundColor: K.key, ink: K.ink, shadow: `${K.shadowKey}, ${ring}` },
    primary: { backgroundColor: K.accent, ink: K.onAccent, shadow: K.shadowPrimary },
    dark: { backgroundColor: K.ink, ink: K.block, shadow: K.shadowKey },
    danger: { backgroundColor: K.key, ink: K.dangerText, shadow: `${K.shadowKey}, ${ring}` },
    screen: { backgroundColor: KEY_ON_SCREEN, ink: K.onScreenBright, shadow: 'inset 0px 1px 0px rgba(255,255,255,0.08), 0px 2px 3px rgba(0,0,0,0.5)' },
  }[variant];
  return <KeyFace onPress={onPress} disabled={disabled} accessibilityLabel={accessibilityLabel} shadow={face.shadow}
    touch={[{ minHeight: 48, minWidth: 48, opacity: disabled ? 0.45 : 1 }, style]}
    face={{ flexGrow: 1, minHeight: 48, borderRadius: RADIUS.keyLarge, backgroundColor: face.backgroundColor, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' }}>
    <T s={15} w="700" c={face.ink} style={{ textAlign: 'center' }}>{label}</T>
  </KeyFace>;
}

/** A key with one glyph: `+`, `⋯`, `>_`. `round` is the 48 circle; otherwise 40×40 radius 12, reaching 48 with its slop. */
export function IconKey({ glyph, accessibilityLabel, onPress, round = false, disabled = false }: { glyph: string; accessibilityLabel: string; onPress: () => void; round?: boolean; disabled?: boolean }) {
  const { K } = usePalette();
  const size = round ? 48 : 40;
  return <KeyFace onPress={onPress} disabled={disabled} accessibilityLabel={accessibilityLabel} shadow={K.shadowKey} hitSlop={round ? undefined : 4}
    touch={{ width: size, height: size, opacity: disabled ? 0.45 : 1 }}
    face={{ flex: 1, borderRadius: round ? size / 2 : 12, backgroundColor: K.key, alignItems: 'center', justifyContent: 'center' }}>
    <T s={round ? 22 : 18} c={K.ink}>{glyph}</T>
  </KeyFace>;
}

function KeyFace({ onPress, disabled = false, accessibilityLabel, hitSlop, touch, face, shadow, children }: {
  onPress: () => void; disabled?: boolean; accessibilityLabel?: string; hitSlop?: number; touch: StyleProp<ViewStyle>; face: ViewStyle; shadow: string; children: ReactNode;
}) {
  const { K } = usePalette();
  const pressed = K.shadowKeyPressed;
  const press = useSharedValue(0);
  const sink = useAnimatedStyle(() => ({ transform: [{ translateY: press.get() }], boxShadow: press.get() > 0.5 ? pressed : shadow }));
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} hitSlop={hitSlop} onPress={onPress}
    onPressIn={() => { press.set(withTiming(1, { duration: 80 })); }} onPressOut={() => { press.set(withTiming(0, { duration: 80 })); }} style={touch}>
    <Animated.View testID="keycap-face" style={[face, sink]}>{children}</Animated.View>
  </Pressable>;
}

/** Retorno «‹ <padre>»: the parent's name comes from navigation. */
export function BackLink({ to, onPress }: { to: string; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Volver a ${to}`} onPress={onPress}
    style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', alignSelf: 'flex-start' }}>
    <T {...TYPE.body} c={K.accentText}>‹ {to}</T>
  </Pressable>;
}

// ---------------------------------------------------------------- list blocks

/** Plaquita (`TERM`, `SOUL`, `MEM`…): a 24-high chip in place of an icon; on dark, the key color so it reads on the block. */
export function Plate({ label }: { label: string }) {
  const { K, mode } = usePalette();
  const { fontScale } = useWindowDimensions();
  // 32 wide at the default font (D-10, D-13_D-14), growing with the system font so nothing is cut: titles start at x=68 whatever the label. The longest label in src/ is four mono 9.5 characters (~27).
  return <View testID="plate" style={{ minHeight: 24, width: Math.ceil(32 * Math.max(1, fontScale)), paddingHorizontal: 0, borderRadius: RADIUS.chip, backgroundColor: mode === 'dark' ? K.key : K.ink, alignItems: 'center', justifyContent: 'center' }}>
    <M s={9.5} w="600" c={K.accent}>{label}</M>
  </View>;
}

/** Bloque: rows on a radius-20 block, 12 from the screen's sides, with a 1 px rule between them. */
export function ListBlock({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { K } = usePalette();
  const rows = Children.toArray(children);
  return <View testID="list-block" style={[{ marginHorizontal: 12, paddingHorizontal: 12, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, overflow: 'hidden' }, style]}>
    {rows.flatMap((row, i) => i > 0 ? [<View key={`rule${i}`} style={{ height: 1, backgroundColor: K.line }} />, row] : [row])}
  </View>;
}

export type RowTone = 'neutral' | 'accent' | 'ok' | 'danger';

/**
 * Fila de bloque, 56–80 high: optional plaquita, title (Hanken 15/600), a mono `meta` line or a
 * Hanken 13 `description`, a mono value on the right and «›» when it opens something.
 */
export function ListRow({ plate, title, meta, description, value, valueTone = 'neutral', chevron = false, onPress, disabled = false }: {
  plate?: string; title: string; meta?: string; description?: string; value?: string; valueTone?: RowTone; chevron?: boolean; onPress?: () => void; disabled?: boolean;
}) {
  const { K } = usePalette();
  const valueColor = { neutral: K.inkTertiary, accent: K.accentText, ok: K.okText, danger: K.dangerText }[valueTone];
  const content = <>
    {plate ? <Plate label={plate} /> : null}
    <View style={{ flex: 1, gap: 2 }}>
      <T {...TYPE.body} c={K.ink}>{title}</T>
      {meta ? <M s={9.5} ls={0.04} c={K.inkTertiary}>{meta}</M> : null}
      {description ? <T {...TYPE.secondary} c={K.inkSecondary}>{description}</T> : null}
    </View>
    {value ? <M s={9.5} w="600" c={valueColor} style={{ flexShrink: 1, textAlign: 'right' }}>{value}</M> : null}
    {chevron ? <T s={18} c={K.inkTertiary}>›</T> : null}
  </>;
  const row: ViewStyle = { minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: disabled ? 0.45 : 1 };
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={row}>{content}</Pressable>
    : <View style={row}>{content}</View>;
}

/** Cabecera de sección: Mono 9.5/600 caps, and optionally a link action on the right. */
export function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const { K } = usePalette();
  return <View style={{ minHeight: action ? 48 : undefined, paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12 }}>
    <M s={9.5} w="600" ls={0.08} c={K.inkTertiary} accessibilityRole="header">{title}</M>
    {action ? <Keycap variant="link" label={action.label} onPress={action.onPress} /> : null}
  </View>;
}

// ---------------------------------------------------------------- segmented

/** Segmentado (Agentes | Actividad, Hoy | Semana | Mes, Un panel | Dos paneles): the chosen one is inverted. */
export function Segmented<Option extends string>({ options, value, onChange }: { options: readonly Option[]; value: Option; onChange: (option: Option) => void }) {
  const { K } = usePalette();
  return <View style={{ flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: K.field, boxShadow: K.shadowField }}>
    {options.map(option => {
      const chosen = option === value;
      return <Pressable key={option} accessibilityRole="button" accessibilityLabel={option} accessibilityState={{ selected: chosen }} hitSlop={{ top: 4, bottom: 4 }} onPress={() => onChange(option)}
        style={{ flex: 1, minHeight: 40, minWidth: 48, paddingHorizontal: 8, borderRadius: 10, backgroundColor: chosen ? K.ink : undefined, alignItems: 'center', justifyContent: 'center' }}>
        <T {...TYPE.body} c={chosen ? K.block : K.inkSecondary} style={{ textAlign: 'center' }}>{option}</T>
      </Pressable>;
    })}
  </View>;
}

// ---------------------------------------------------------------- avatar

/** Image slot with the halftone screen. Empty slots are just the dark square. */
export function Avatar({ source, size = 46, faded }: { source?: ImageSourcePropType; size?: number; faded?: boolean }) {
  const { K } = usePalette();
  return <View style={{ width: size, height: size, borderRadius: 12, overflow: 'hidden', backgroundColor: K.avatarInk, opacity: faded ? 0.55 : 1 }}>
    {source ? <Image source={source} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, width: size, height: size }} /> : null}
    <Dither tile={2.5} inner={0.7} outer={1.1} color={K.avatarInk} opacity={0.85} multiply />
  </View>;
}
