// Gestures of Relay 3.1 (G-1): pull to refresh and the swipe row.
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useMotion } from '@/state/motion';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { Lamp } from './kit';
import { M } from './primitives';

/** The pull reloads from here (after resistance) and says «SUELTA PARA RECARGAR». */
const PULL_READY = 60;
const PULL_MAX = 96;
const PULL_RESISTANCE = 0.5;
/** While it loads, the content stays this far down so the blinking LED shows. */
const PULL_HOLD = 48;
const PULL_BACK = { duration: 300, easing: Easing.bezier(0.2, 1, 0.3, 1) };

/**
 * Recargar: a scroll view that, pulled down from its top, follows the finger at half speed up to
 * 96 px. From 60 px it says «SUELTA PARA RECARGAR»; letting go there calls `onRefresh` and the orange
 * LED blinks (1 s cycle) until its promise settles. `onRefresh` shows its own errors and never rejects.
 */
export function PullToRefresh({ onRefresh, style, contentContainerStyle, children }: {
  onRefresh: () => Promise<void>; style?: StyleProp<ViewStyle>; contentContainerStyle?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  const { K } = usePalette();
  const moving = useMotion();
  const [phase, setPhase] = useState<'pulling' | 'ready' | 'loading'>('pulling');
  const pull = useSharedValue(0);
  const ready = useSharedValue(false);
  const busy = useSharedValue(false);
  const atTop = useSharedValue(true);
  // Armed only if the list is at its top when the finger starts: travel that scrolls the list back up never counts.
  const armed = useSharedValue(false);
  const blink = useSharedValue(0);
  const refresh = async () => {
    setPhase('loading');
    try { await onRefresh(); } finally {
      busy.set(false); ready.set(false); setPhase('pulling');
      pull.set(withTiming(0, PULL_BACK));
    }
  };
  const scroll = Gesture.Native();
  const pan = Gesture.Pan().withTestId('pull-to-refresh').activeOffsetY(10).failOffsetY(-10).simultaneousWithExternalGesture(scroll)
    .onStart(() => { armed.set(atTop.get()); })
    .onUpdate(event => {
      if (busy.get() || !armed.get()) return;
      const next = Math.min(PULL_MAX, Math.max(0, event.translationY * PULL_RESISTANCE));
      pull.set(next);
      const nowReady = next >= PULL_READY;
      if (nowReady === ready.get()) return;
      ready.set(nowReady);
      scheduleOnRN(setPhase, nowReady ? 'ready' : 'pulling');
    })
    .onEnd(() => {
      if (busy.get()) return;
      if (!ready.get()) { pull.set(withTiming(0, PULL_BACK)); return; }
      busy.set(true);
      pull.set(withTiming(PULL_HOLD, PULL_BACK));
      scheduleOnRN(refresh);
    });
  useEffect(() => {
    if (phase !== 'loading' || !moving) return;
    blink.set(withRepeat(withTiming(1, { duration: 1000, easing: Easing.linear }), -1));
    return () => { cancelAnimation(blink); blink.set(0); };
  }, [phase, moving, blink]);
  const lower = useAnimatedStyle(() => ({ transform: [{ translateY: pull.get() }] }));
  const gap = useAnimatedStyle(() => ({ height: pull.get() }));
  // Lit for the first half of each second, at .25 for the second half.
  const led = useAnimatedStyle(() => ({ opacity: blink.get() < 0.5 ? 1 : 0.25 }));
  return <View style={[{ flex: 1, overflow: 'hidden' }, style]}>
    <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, overflow: 'hidden' }, gap]}>
      <Animated.View testID="pull-led" style={led}><Lamp tone={phase === 'pulling' ? 'off' : 'orange'} /></Animated.View>
      {phase === 'pulling' ? null : <M {...TYPE.label} c={K.accentText}>{phase === 'ready' ? 'SUELTA PARA RECARGAR' : 'CARGANDO…'}</M>}
    </Animated.View>
    <GestureDetector gesture={pan}>
      <Animated.View testID="pull-content" style={[{ flex: 1 }, lower]}>
        <GestureDetector gesture={scroll}>
          <ScrollView contentContainerStyle={contentContainerStyle} scrollEventThrottle={16} onScroll={event => { atTop.set(event.nativeEvent.contentOffset.y <= 0); }}>
            {children}
          </ScrollView>
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  </View>;
}

const SWIPE_THRESHOLD = 90;
const SWIPE_SPRING = { duration: 320, easing: Easing.bezier(0.2, 1.3, 0.4, 1) };

export type SwipeAction = { label: string; onAction: () => void };

/**
 * Fila deslizable: dragged 90 px or more towards a side that has an action, it calls that action
 * and springs back; short of that it springs back and nothing happens. A side without an action
 * does not move. The row never acts by itself: the screen's action may ask for confirmation.
 * `testID` names the row and its gesture, one per row on screen.
 */
export function SwipeRow({ swipeRight, swipeLeft, testID = 'swipe-row', children }: {
  swipeRight?: SwipeAction; swipeLeft?: SwipeAction; testID?: string; children: ReactNode;
}) {
  const { K } = usePalette();
  const shift = useSharedValue(0);
  const toRight = swipeRight?.onAction;
  const toLeft = swipeLeft?.onAction;
  const pan = Gesture.Pan().withTestId(testID).enabled(Boolean(toRight || toLeft))
    .activeOffsetX(toRight && toLeft ? [-10, 10] : toRight ? 10 : -10).failOffsetY([-10, 10])
    .onUpdate(event => { shift.set(Math.min(toRight ? Infinity : 0, Math.max(toLeft ? -Infinity : 0, event.translationX))); })
    .onEnd(event => {
      if (toRight && event.translationX >= SWIPE_THRESHOLD) scheduleOnRN(toRight);
      if (toLeft && event.translationX <= -SWIPE_THRESHOLD) scheduleOnRN(toLeft);
      shift.set(withTiming(0, SWIPE_SPRING));
    });
  const block = K.block;
  // At rest the row is see-through, so the block's own highlight shows; moving, it covers its action.
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: shift.get() }], backgroundColor: shift.get() === 0 ? 'transparent' : block }));
  const reveal = useAnimatedStyle(() => ({ opacity: shift.get() === 0 ? 0 : 1 }));
  const actions = [swipeRight && { name: 'swipeRight', label: swipeRight.label }, swipeLeft && { name: 'swipeLeft', label: swipeLeft.label }].filter(action => !!action);
  return <View style={{ overflow: 'hidden' }} accessibilityActions={actions}
    onAccessibilityAction={event => (event.nativeEvent.actionName === 'swipeRight' ? toRight : toLeft)?.()}>
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }, reveal]}>
      {swipeRight ? <M {...TYPE.label} c={K.accentText}>{swipeRight.label.toUpperCase()}</M> : <View />}
      {swipeLeft ? <M {...TYPE.label} c={K.accentText}>{swipeLeft.label.toUpperCase()}</M> : null}
    </Animated.View>
    <GestureDetector gesture={pan}>
      <Animated.View testID={testID} style={slide}>{children}</Animated.View>
    </GestureDetector>
  </View>;
}
