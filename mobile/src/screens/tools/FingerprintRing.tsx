import { useEffect } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useMotion } from '@/state/motion';
import { usePalette } from '@/theme/ThemeProvider';
import { ledGlow } from '@/theme/tokens';
import { FingerprintIcon } from '@/ui/icons';

const CYCLE_MS = 3200;
// RN draws CSS gradients from `experimental_backgroundImage`; react-native-web takes the CSS property.
const gradient = (css: string) => (Platform.OS === 'web' ? { backgroundImage: css } : { experimental_backgroundImage: css }) as ViewStyle;

/** The fingerprint ring of the gate (D-21): 80 round, lit orange, with the foquitos' 3.2 s halo while it waits. */
export function FingerprintRing() {
  const { K } = usePalette();
  const moving = useMotion();
  const halo = useSharedValue(0);
  useEffect(() => {
    if (!moving) { cancelAnimation(halo); halo.set(0.6); return; }
    halo.set(withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.bezierFn(0.4, 0, 0.2, 1) }), -1));
    return () => { cancelAnimation(halo); };
  }, [halo, moving]);
  // Opacity 0 → 1 → 0 and a scale swelling with it, once per cycle; at rest a still half halo.
  const glow = useAnimatedStyle(() => {
    const t = halo.get();
    const peak = moving ? 1 - Math.abs(2 * t - 1) : t;
    return { opacity: peak, transform: [{ scale: 0.6 + 0.4 * peak }] };
  });
  return <View accessible={false} style={{ width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: K.screen,
    boxShadow: `inset 0px 2px 6px rgba(0,0,0,0.6), 0px 0px 0px 1px rgba(242,154,26,0.35), ${ledGlow(K.accent)}` }}>
    <Animated.View style={[{ position: 'absolute', width: 80, height: 80, borderRadius: 40 }, gradient('radial-gradient(circle, rgba(242,154,26,0.4), rgba(242,154,26,0) 70%)'), glow]} />
    <FingerprintIcon size={40} color={K.accent} />
  </View>;
}
