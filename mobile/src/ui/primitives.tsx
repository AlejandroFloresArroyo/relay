import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useId, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type TextProps,
  type TextStyle,
} from 'react-native';
import Svg, { Defs, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';

import { F, type MonoWeight, type SansWeight } from '@/theme/tokens';

const nativeDriver = Platform.OS !== 'web';

// ---------------------------------------------------------------- text

interface TypeProps extends TextProps {
  s?: number;
  c?: string;
  /** letter-spacing in em, as written in the prototype */
  ls?: number;
  /** line-height as a multiplier, as written in the prototype */
  lh?: number;
  /** text-shadow glow color (--tgo / --tgg / --tgr) */
  glow?: string | false;
}

// react-native-web wants the CSS shorthand; native still takes the three separate props.
const glowStyle = (color: string): TextStyle =>
  Platform.OS === 'web'
    ? ({ textShadow: `0px 0px 7px ${color}` } as unknown as TextStyle)
    : { textShadowColor: color, textShadowRadius: 7, textShadowOffset: { width: 0, height: 0 } };

function typeStyle(family: string, { s = 14, c, ls, lh, glow }: TypeProps): TextStyle {
  return {
    fontFamily: family,
    fontSize: s,
    color: c,
    ...(ls != null ? { letterSpacing: ls * s } : null),
    ...(lh != null ? { lineHeight: lh * s } : null),
    ...(glow ? glowStyle(glow) : null),
  };
}

/** Hanken Grotesk. */
export function T({ w = '400', style, s, c, ls, lh, glow, ...rest }: TypeProps & { w?: SansWeight }) {
  const { K } = usePalette();
  return <Text {...rest} style={[typeStyle(F.sans[w], { s, c: c ?? K.ink, ls, lh, glow }), style]} />;
}

/** Martian Mono. */
export function M({ w = '400', style, s = 10, c, ls, lh, glow, ...rest }: TypeProps & { w?: MonoWeight }) {
  const { K } = usePalette();
  return <Text {...rest} style={[typeStyle(F.mono[w], { s, c: c ?? K.ink, ls, lh, glow }), style]} />;
}

// ---------------------------------------------------------------- motion

/** ri-spin: the 9px ring next to "ACTIVIDAD". */
export function Spinner() {
  const { K } = usePalette();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: nativeDriver }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      style={{
        width: 9,
        height: 9,
        borderRadius: 4.5,
        borderWidth: 1.5,
        borderColor: K.spinnerTrack,
        borderTopColor: K.accent,
        transform: [{ rotate: v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }}
    />
  );
}

// ---------------------------------------------------------------- textures

const svgId = (raw: string) => raw.replace(/[^a-zA-Z0-9]/g, '');

/** --scan: 1px line at 3.5% white every 3px. */
export function Scanlines() {
  const id = `scan${svgId(useId())}`;
  return (
    <Svg width="100%" height="100%" style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
      <Defs>
        <Pattern id={id} x="0" y="0" width="3" height="3" patternUnits="userSpaceOnUse">
          <Rect x="0" y="2" width="3" height="1" fill="#fff" fillOpacity={0.035} />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** The halftone screen laid over image slots: radial-gradient(transparent <inner>, <color> <outer>) tiled. */
export function Dither({
  tile,
  inner,
  outer,
  color,
  opacity = 1,
  multiply,
}: {
  tile: number;
  inner: number;
  outer: number;
  color: string;
  opacity?: number;
  multiply?: boolean;
}) {
  const raw = svgId(useId());
  const pid = `dp${raw}`;
  const gid = `dg${raw}`;
  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }, multiply ? { mixBlendMode: 'multiply' } : null]}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id={gid} cx={tile / 2} cy={tile / 2} r={outer} gradientUnits="userSpaceOnUse">
            <Stop offset={inner / outer} stopColor={color} stopOpacity={0} />
            <Stop offset={1} stopColor={color} stopOpacity={opacity} />
          </RadialGradient>
          <Pattern id={pid} x="0" y="0" width={tile} height={tile} patternUnits="userSpaceOnUse">
            <Rect x="0" y="0" width={tile} height={tile} fill={`url(#${gid})`} />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${pid})`} />
      </Svg>
    </View>
  );
}
