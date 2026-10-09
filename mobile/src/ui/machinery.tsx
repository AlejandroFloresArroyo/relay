// Machinery and light of Relay 3.1 (S-15), animated on the UI thread with reanimated.
// Continuous pieces (Lights, Sweep, VoiceBox, a live Needle) move only while `useMotion` allows it
// and otherwise hold their rest pose. Repeated pieces share one clock per period.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing, cancelAnimation, makeMutable, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import type { GaugeReading, Light } from '@/core/machinery';
import { useMotion } from '@/state/motion';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, ledGlow } from '@/theme/tokens';
import { M, Scanlines } from './primitives';

export type Tone = Exclude<Light, 'off'>;

// Colors drawn on a recessed screen or in light itself: the same in both themes.
const ORANGE = '#F29A1A';
const RED = '#E5533D';
const ON_SCREEN_RULE = '#3A3936';
const ODOMETER_CELL = '#2A2927';
const VOICE_WINDOW_ON_SCREEN = '#0C0C0B';
const DATA_NEEDLE = '#ECEAE5';

// CSS timing functions, as the canvas declares them.
const STANDARD = Easing.bezierFn(0.4, 0, 0.2, 1);
const EASE_IN_OUT = Easing.bezierFn(0.42, 0, 0.58, 1);
const EASE_OUT = Easing.bezierFn(0, 0, 0.58, 1);
const THERE_AND_BACK = [0, 0.5, 1];

/** The value of CSS keyframes at `progress` (0–1): `easing` runs inside each segment, as in CSS. */
function keyframes(progress: number, stops: readonly number[], values: readonly number[], easing: (t: number) => number): number {
  'worklet';
  let i = 1;
  while (i < stops.length - 1 && progress > stops[i]) i++;
  const t = Math.min(Math.max((progress - stops[i - 1]) / (stops[i] - stops[i - 1]), 0), 1);
  return values[i - 1] + (values[i] - values[i - 1]) * easing(t);
}

/** Where a piece delayed by `delay` (fraction of its period) is on its cycle when the shared clock reads `clock`. */
function phase(clock: number, delay: number): number {
  'worklet';
  return (((clock - delay) % 1) + 1) % 1;
}

// RN draws CSS gradients from `experimental_backgroundImage`; react-native-web takes the CSS property.
const gradient = (css: string) => (Platform.OS === 'web' ? { backgroundImage: css } : { experimental_backgroundImage: css }) as ViewStyle;

// One clock per period, 0 → 1 on repeat while any piece needs it: 30 rows of lights run one animation.
const clocks = new Map<number, { time: SharedValue<number>; users: number }>();
function clockFor(period: number) {
  let clock = clocks.get(period);
  if (!clock) clocks.set(period, clock = { time: makeMutable(0), users: 0 });
  return clock;
}
function useClock(period: number, running: boolean): SharedValue<number> {
  useEffect(() => {
    if (!running) return;
    const clock = clockFor(period);
    // Plain statements: React Compiler 1.0 lowers `users++ === 0` as `++users === 0`, and the clock never started.
    clock.users += 1;
    if (clock.users === 1) clock.time.set(withRepeat(withTiming(1, { duration: period, easing: Easing.linear }), -1));
    return () => {
      clock.users -= 1;
      if (clock.users > 0) return;
      cancelAnimation(clock.time); clock.time.set(0);
    };
  }, [period, running]);
  return clockFor(period).time;
}

// ---------------------------------------------------------------- foquitos

const LIGHTS_PERIOD = 3200;
const GLOW_STOPS = [0, 0.45, 0.7, 1];
const LENS: Record<Tone, { lens: string; filament: string; halo: string }> = {
  orange: {
    lens: 'radial-gradient(circle at 50% 45%, #7A4A10, #3A2206 75%)',
    filament: '#FFF0D6',
    halo: 'radial-gradient(circle, rgba(242,154,26,0.75) 0%, rgba(242,154,26,0) 70%)',
  },
  red: {
    lens: 'radial-gradient(circle at 50% 45%, #7A2418, #3A0E08 75%)',
    filament: '#FFE2DA',
    halo: 'radial-gradient(circle, rgba(255,106,85,0.75) 0%, rgba(255,106,85,0) 70%)',
  },
};

/** Foquitos: 13 lenses across the strip; light is born in the center lens and spreads outwards. */
export function Lights({ tone }: { tone: Tone }) {
  const moving = useMotion();
  const clock = useClock(LIGHTS_PERIOD, moving);
  return <View style={{ height: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
    {Array.from({ length: 13 }, (_, i) => <Lens key={i} tone={tone} delay={(140 * Math.abs(i - 6)) / LIGHTS_PERIOD} clock={clock} moving={moving} />)}
  </View>;
}

function Lens({ tone, delay, clock, moving }: { tone: Tone; delay: number; clock: SharedValue<number>; moving: boolean }) {
  // At rest a lens stays lit: halo and filament at their peak.
  const halo = useAnimatedStyle(() => {
    const at = phase(clock.get(), delay);
    return moving
      ? { opacity: keyframes(at, GLOW_STOPS, [0, 1, 0.55, 0], STANDARD), transform: [{ scale: keyframes(at, GLOW_STOPS, [0.4, 1, 0.85, 0.4], STANDARD) }] }
      : { opacity: 1, transform: [{ scale: 1 }] };
  });
  const filament = useAnimatedStyle(() => ({ opacity: moving ? keyframes(phase(clock.get(), delay), GLOW_STOPS, [0.35, 1, 0.7, 0.35], STANDARD) : 1 }));
  return <View style={[{
    width: 6, height: 6, borderRadius: 3, alignItems: 'center', justifyContent: 'center',
    boxShadow: 'inset 0px 0px 0px 1px rgba(0,0,0,0.45), inset 0px 1px 1px rgba(255,255,255,0.12)',
  }, gradient(LENS[tone].lens)]}>
    <Animated.View style={[{ position: 'absolute', left: -3, top: -3, width: 12, height: 12, borderRadius: 6 }, gradient(LENS[tone].halo), halo]} />
    <Animated.View style={[{ width: 2, height: 2, borderRadius: 1, backgroundColor: LENS[tone].filament }, filament]} />
  </View>;
}

// ---------------------------------------------------------------- barrido

/** Barrido: there and back across its track, 1.6 s orange (Turno en curso), 1 s red (Decisión). One per screen, inside a RecessedScreen. */
export function Sweep({ tone }: { tone: Tone }) {
  const { K } = usePalette();
  const moving = useMotion();
  const clock = useClock(tone === 'red' ? 1000 : 1600, moving);
  const color = tone === 'red' ? RED : ORANGE;
  // The 24 % head rests centered.
  const head = useAnimatedStyle(() => ({ left: `${moving ? keyframes(clock.get(), THERE_AND_BACK, [0, 80, 0], EASE_IN_OUT) : 38}%` }));
  return <View style={{ height: 6, borderRadius: 3, backgroundColor: tone === 'red' ? K.sweepTrackDanger : K.sweepTrackAccent }}>
    <Animated.View style={[{
      position: 'absolute', top: 0, width: '24%', height: 6, borderRadius: 3, boxShadow: `0px 0px ${tone === 'red' ? 10 : 8}px ${color}`,
    }, gradient(`linear-gradient(90deg, ${color}00, ${color} 50%, ${color}00)`), head]} />
  </View>;
}

// ---------------------------------------------------------------- caja de voz

const VOICE_COLUMNS = [{ period: 700, delay: 0 }, { period: 550, delay: 180 }, { period: 800, delay: 90 }];

/**
 * Caja de voz: three glowing columns while the Agente writes; stands in for the word «escribiendo».
 * Its window is the screen color on a block (F-1) and a deeper #0C0C0B inside a RecessedScreen (`onScreen`, S-15).
 */
export function VoiceBox({ onScreen = false }: { onScreen?: boolean }) {
  const { K } = usePalette();
  const moving = useMotion();
  return <View accessible accessibilityLabel="Escribiendo" style={{
    width: 30, height: 20, borderRadius: 5, backgroundColor: onScreen ? VOICE_WINDOW_ON_SCREEN : K.screen,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2,
  }}>
    {VOICE_COLUMNS.map(column => <VoiceColumn key={column.period} {...column} moving={moving} />)}
  </View>;
}

function VoiceColumn({ period, delay, moving }: { period: number; delay: number; moving: boolean }) {
  const clock = useClock(period, moving);
  // At rest, half height.
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: moving ? keyframes(phase(clock.get(), delay / period), THERE_AND_BACK, [0.15, 1, 0.15], EASE_IN_OUT) : 0.5 }],
  }));
  return <Animated.View style={[{ width: 5, height: 14, paddingTop: 2, gap: 1 }, style]}>
    {[0, 1, 2].map(cell => <View key={cell} style={{ height: 3, borderRadius: 1, backgroundColor: ORANGE, boxShadow: `0px 0px 4px ${ORANGE}` }} />)}
  </Animated.View>;
}

// ---------------------------------------------------------------- aguja

// 9 marks over the 100° arc around the pivot (56, 70) of a 112×80 dial; the last two are red.
const NEEDLE_TICKS = Array.from({ length: 9 }, (_, i) => {
  const a = ((-50 + i * 12.5) * Math.PI) / 180;
  return { x1: 56 + 46 * Math.sin(a), y1: 70 - 46 * Math.cos(a), x2: 56 + 54 * Math.sin(a), y2: 70 - 54 * Math.cos(a), red: i >= 7 };
});

/**
 * Aguja on a 112×80 dial. It moves to a new reading in 400 ms ease-out; a `live` one also swings
 * ±2° every 6 s so it reads as alive. At rest it points at its reading. A `data` needle (CPU, MEM,
 * DISCO in F-4) is light and turns orange in its red zone; the others are orange and turn red.
 */
export function Needle({ reading, live = false, data = false }: { reading: GaugeReading; live?: boolean; data?: boolean }) {
  const moving = useMotion();
  const swing = useClock(6000, moving && live);
  const angle = useSharedValue(reading.angle);
  useEffect(() => {
    angle.set(moving ? withTiming(reading.angle, { duration: 400, easing: EASE_OUT }) : reading.angle);
  }, [angle, moving, reading.angle]);
  const needle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.get() + (moving && live ? keyframes(swing.get(), THERE_AND_BACK, [-2, 2, -2], EASE_IN_OUT) : 0)}deg` }],
  }));
  const color = data ? (reading.red ? ORANGE : DATA_NEEDLE) : reading.red ? RED : ORANGE;
  return <View style={{ width: 112, height: 80 }}>
    <Svg width={112} height={80} style={StyleSheet.absoluteFill}>
      {NEEDLE_TICKS.map(({ red, ...line }, i) => <Line key={i} {...line} stroke={red ? RED : '#5F5D58'} strokeWidth={1.5} />)}
    </Svg>
    {/* The arm turns about its own center, the pivot: the needle is its upper 54 px (52 above the pivot, 2 below). */}
    <Animated.View style={[{ position: 'absolute', left: 55, top: 18, width: 2, height: 104 }, needle]}>
      <View style={{ height: 54, backgroundColor: color, boxShadow: `0px 0px 6px ${color}` }} />
    </Animated.View>
  </View>;
}

// ---------------------------------------------------------------- tornillos y regla

/** Four screws 7 px from the corners of a radius-20 command block (bloque de mando); its parent positions them. */
export function Screws() {
  const { K, mode } = usePalette();
  // #D6D3CC (K.line) on light; on dark, K-1's dark LED-off #3A3936 (K.ledOff).
  const screw = { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: mode === 'dark' ? K.ledOff : K.line, boxShadow: 'inset 0px 1px 1px rgba(0,0,0,0.28)' } as const;
  return <>
    <View style={[screw, { top: 7, left: 7 }]} /><View style={[screw, { top: 7, right: 7 }]} />
    <View style={[screw, { bottom: 7, left: 7 }]} /><View style={[screw, { bottom: 7, right: 7 }]} />
  </>;
}

/** Regla grabada: 1 px marks with 3 px gaps, 7 px every sixth, 4 px on even ones, 2 px otherwise. At most one per screen. */
export function EngravedRule({ onScreen = false }: { onScreen?: boolean }) {
  const { K } = usePalette();
  const id = `rule${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return <Svg width="100%" height={7}>
    <Defs>
      <Pattern id={id} x="0" y="0" width={24} height={7} patternUnits="userSpaceOnUse">
        {[7, 2, 4, 2, 4, 2].map((h, i) => <Rect key={i} x={i * 4} y={(7 - h) / 2} width={1} height={h} fill={onScreen ? ON_SCREEN_RULE : K.ledOff} />)}
      </Pattern>
    </Defs>
    <Rect x="0" y="0" width="100%" height={7} fill={`url(#${id})`} />
  </Svg>;
}

// ---------------------------------------------------------------- cuentakilómetros

/** Cuentakilómetros: each digit in its cell rolls up in 280 ms when it changes; separators and units sit without a cell. */
export function Odometer({ value }: { value: string }) {
  const { K } = usePalette();
  const chars = [...value];
  return <View accessible accessibilityLabel={value} style={{ flexDirection: 'row', gap: 2 }}>
    {/* Keyed from the right, so a value growing a digit keeps the units' cells. */}
    {chars.map((char, i) => /\d/.test(char)
      ? <OdometerDigit key={chars.length - i} digit={char} />
      : <View key={chars.length - i} style={{ width: 16, height: 24, alignItems: 'center', justifyContent: 'center' }}>
        <M s={13} w="600" c={K.onScreenLabel}>{char}</M>
      </View>)}
  </View>;
}

function OdometerDigit({ digit }: { digit: string }) {
  const moving = useMotion();
  // Each change mounts a fresh roll, so only a new digit rolls and motion coming back never replays it.
  const [shown, setShown] = useState({ from: digit, to: digit, change: 0, animate: false });
  if (shown.to !== digit) setShown({ from: shown.to, to: digit, change: shown.change + 1, animate: moving });
  return <View style={{ width: 16, height: 24, borderRadius: 3, backgroundColor: ODOMETER_CELL, overflow: 'hidden' }}>
    <OdometerRoll key={shown.change} from={shown.from} to={shown.to} animate={shown.animate} />
  </View>;
}

function OdometerRoll({ from, to, animate }: { from: string; to: string; animate: boolean }) {
  const { K } = usePalette();
  // 0 shows the previous digit, 1 the current one, which rises from below. A rolling one starts at 0 on
  // its first frame, so the new digit never flashes in before the roll.
  const roll = useSharedValue(animate ? 0 : 1);
  useEffect(() => {
    if (animate) roll.set(withTiming(1, { duration: 280 }));
  }, [roll, animate]);
  const column = useAnimatedStyle(() => ({ transform: [{ translateY: -24 * roll.get() }] }));
  return <Animated.View style={column}>
    {[from, to].map((char, i) => <View key={i} style={{ height: 24, alignItems: 'center', justifyContent: 'center' }}>
      <M s={13} w="600" c={K.onScreenBright}>{char}</M>
    </View>)}
  </Animated.View>;
}

// ---------------------------------------------------------------- tecla que se mantiene

/**
 * A key that acts only when held: its strip of 6 LEDs fills left to right over 1 s and then
 * `onComplete` runs, once per hold. Letting go earlier, or the key turning `disabled` mid-hold,
 * empties the strip in 150 ms and nothing runs. `stepped` fills in 50 ms / 5 % steps (Pausa
 * general); `primary` is the orange key with an ink strip (F-3).
 * A screen reader cannot hold, so activating it there asks to confirm in a dialog instead, and only
 * «Confirmar» runs `onComplete`.
 */
export function HoldKey({ accessibilityLabel, onComplete, stepped = false, disabled = false, primary = false, style, children }: {
  accessibilityLabel: string; onComplete: () => void; stepped?: boolean; disabled?: boolean; primary?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  const { K } = usePalette();
  const progress = useSharedValue(0);
  const enabled = useRef(!disabled);
  const hold = () => {
    progress.set(withTiming(1, { duration: 1000, easing: stepped ? Easing.steps(20, false) : Easing.linear }, finished => {
      if (finished) scheduleOnRN(onComplete);
    }));
  };
  // A new animation interrupts the fill, whose callback then reports unfinished.
  const release = () => { progress.set(withTiming(0, { duration: 150, easing: Easing.linear })); };
  useEffect(() => {
    enabled.current = !disabled;
    if (disabled && progress.get() > 0) progress.set(withTiming(0, { duration: 150, easing: Easing.linear }));
  }, [disabled, progress]);
  const confirm = () => {
    if (!enabled.current) return;
    Alert.alert(`¿${accessibilityLabel}?`, 'Con el lector de pantalla, confirmar sustituye a mantener la tecla 1 s.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Confirmar', onPress: () => { if (enabled.current) onComplete(); } },
    ]);
  };
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled}
    accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') confirm(); }}
    onPressIn={hold} onPressOut={release} style={[{
      minHeight: 48, borderRadius: RADIUS.key, backgroundColor: primary ? K.accent : K.key, boxShadow: primary ? K.shadowPrimary : K.shadowKey,
      alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16, opacity: disabled ? 0.45 : 1,
    }, style]}>
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {Array.from({ length: 6 }, (_, i) => <HoldLed key={i} index={i} progress={progress} primary={primary} />)}
    </View>
    {children}
  </Pressable>;
}

// On the orange key the strip is ink, the unlit ones at .3 (F-3).
const HOLD_INK = '#1A1A19';

function HoldLed({ index, progress, primary }: { index: number; progress: SharedValue<number>; primary: boolean }) {
  const { K } = usePalette();
  // Each LED takes its sixth of the fill.
  const lit = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(progress.get() * 6 - index, 0), 1) }));
  return <View style={{ width: 6, height: 3, borderRadius: 1, backgroundColor: primary ? 'rgba(26,26,25,0.3)' : K.ledOff }}>
    <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 1 }, primary ? { backgroundColor: HOLD_INK } : { backgroundColor: ORANGE, boxShadow: ledGlow(ORANGE) }, lit]} />
  </View>;
}

// ---------------------------------------------------------------- pantalla empotrada

/** Pantalla empotrada: recessed display with scanlines; `rim` lights its edge. Radius 12–16. */
export function RecessedScreen({ rim = false, radius = RADIUS.screen, style, children }: {
  rim?: boolean; radius?: number; style?: StyleProp<ViewStyle>; children?: ReactNode;
}) {
  const { K } = usePalette();
  return <View style={[{ backgroundColor: K.screen, borderRadius: radius, boxShadow: rim ? `${K.shadowScreen}, ${K.shadowAccentRim}` : K.shadowScreen }, style]}>
    <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', pointerEvents: 'none' }]}><Scanlines /></View>
    {children}
  </View>;
}
