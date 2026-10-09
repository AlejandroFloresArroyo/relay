// The sheet (hoja) and the toast of Relay 3.1 (G-1).
import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useChatVisible } from '@/state/chatVisibility';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { useBottomInset, useSheetBounds } from './chrome';
import { Lamp } from './kit';
import { M, T } from './primitives';

export const SHEET_MOTION = { duration: 300, easing: Easing.bezier(0.2, 1, 0.3, 1) };
/** Dragged further than this by its grip, a sheet closes; at this or less it comes back. */
export const SHEET_CLOSE_DRAG = 110;

/**
 * Hoja: grip, title (Hanken 20/800), optional mono subtitle and `aside` (a «Cancelar» link), the
 * content and the primary `action` at the bottom (D-0-3, D-22). It slides in over a .55 veil that
 * clears as it goes down. Dragging the grip more than 110 px, tapping the veil or Android's back
 * call `onClose`, which must set `visible` to false; the sheet then slides out from where it is.
 * A native Modal is its own window that LockGate cannot hide, so while Relay is locked or not
 * visible the sheet is not shown; the parent keeps `visible` and it returns after unlock.
 */
export function Sheet({ visible, onClose, title, subtitle, aside, action, children }: {
  visible: boolean; onClose: () => void; title: string; subtitle?: string; aside?: ReactNode; action?: ReactNode; children?: ReactNode;
}) {
  const { K } = usePalette();
  const { height: window } = useWindowDimensions();
  const bounds = useSheetBounds();
  const bottom = useBottomInset(8);
  const [mounted, setMounted] = useState(visible);
  const shown = useChatVisible();
  if (visible && !mounted) setMounted(true);
  const drop = useSharedValue(window);
  const height = useSharedValue(window);
  useEffect(() => {
    drop.set(visible ? withTiming(0, SHEET_MOTION) : withTiming(window, SHEET_MOTION, done => { if (done) scheduleOnRN(setMounted, false); }));
  }, [visible, window, drop]);
  const grip = Gesture.Pan().withTestId('sheet-grip')
    .onUpdate(event => { drop.set(Math.max(0, event.translationY)); })
    .onEnd(event => {
      if (event.translationY > SHEET_CLOSE_DRAG) scheduleOnRN(onClose);
      else drop.set(withTiming(0, SHEET_MOTION));
    });
  const veil = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(1 - drop.get() / Math.max(height.get(), 1), 0), 1) }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: drop.get() }] }));
  return <Modal transparent visible={mounted && shown} animationType="none" statusBarTranslucent onRequestClose={onClose}>
    <GestureHandlerRootView style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: K.sheetBackdrop }, veil]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar" onPress={onClose} style={{ flex: 1 }} />
      </Animated.View>
      <Animated.View testID="sheet" accessibilityViewIsModal onLayout={event => { height.set(event.nativeEvent.layout.height); }} style={[bounds, {
        marginHorizontal: 8, marginBottom: bottom, maxHeight: bounds.maxHeight - bottom, borderRadius: 24, backgroundColor: K.block, boxShadow: K.shadowSheet, paddingHorizontal: 16, paddingBottom: 16,
      }, slide]}>
        <GestureDetector gesture={grip}>
          <View style={{ paddingTop: 8, paddingBottom: 12 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: K.ledOff, alignSelf: 'center' }} />
            <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T {...TYPE.subtitle} ls={-0.015} c={K.ink} accessibilityRole="header">{title}</T>
                {subtitle ? <M s={9.5} ls={0.06} c={K.inkTertiary}>{subtitle}</M> : null}
              </View>
              {aside}
            </View>
          </View>
        </GestureDetector>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 12 }}>{children}</ScrollView>
        {action ? <View style={{ paddingTop: 12, flexDirection: 'row', gap: 8 }}>{action}</View> : null}
      </Animated.View>
    </GestureHandlerRootView>
  </Modal>;
}

const TOAST_LIFE = 2000;

/** Toast: 44 high at the bottom, ink with a green LED. It springs in over .22 s and is gone at 2 s, when `onHide` runs. */
export function Toast({ message, onHide, bottom }: { message: string; onHide: () => void; bottom?: number }) {
  const { K } = usePalette();
  const inset = useBottomInset(16);
  const shown = useSharedValue(0);
  const hide = useEffectEvent(onHide);
  useEffect(() => {
    shown.set(0);
    shown.set(withTiming(1, { duration: 220, easing: Easing.bezier(0.2, 0.9, 0.3, 1.2) }));
    const timer = setTimeout(hide, TOAST_LIFE);
    return () => { clearTimeout(timer); };
  }, [message, shown]);
  // It rises from below the screen's edge; the easing overshoots a little before it settles.
  const rise = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - shown.get()) * 64 }] }));
  return <Animated.View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[{
    position: 'absolute', left: 12, right: 12, bottom: bottom ?? inset, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 14, backgroundColor: K.toast, flexDirection: 'row', alignItems: 'center', gap: 10, pointerEvents: 'none',
  }, rise]}>
    <Lamp tone="green" />
    <T {...TYPE.body} c={K.onScreenBright} style={{ flex: 1 }}>{message}</T>
  </Animated.View>;
}
