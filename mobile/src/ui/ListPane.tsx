import { useEffect } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { clampWidth, forgetWidth, listWidth, rememberWidth, type ListWidths } from '@/core/relayLayout';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { ServerListScreen } from '@/screens/ServerListScreen';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS } from '@/theme/tokens';

import { PaneInsetsContext, ShellNavigationContext } from './layoutContext';

/** Step of the handle's increment and decrement actions. */
const A11Y_STEP = 40;

/**
 * The tablet's recessed list (Agentes or Servidores) beside the detail. Its right edge resizes it:
 * drag within `bounds`, double tap for the default; the width is remembered per section. The shown
 * width is the remembered one clamped to the room left by the rail, never written back.
 */
export function ListPane({ section, bounds, widths, onWidths }: {
  section: 'agents' | 'servers'; bounds: { min: number; max: number }; widths: ListWidths; onWidths: (next: ListWidths) => void;
}) {
  const { K } = usePalette();
  const shown = clampWidth(listWidth(widths, section), bounds);
  const width = useSharedValue(shown);
  useEffect(() => { width.set(shown); }, [shown, width]);
  const sized = useAnimatedStyle(() => ({ width: width.get() }));
  const start = useSharedValue(shown);
  const commit = (next: number) => onWidths(rememberWidth(widths, section, clampWidth(next, bounds)));
  const reset = () => onWidths(forgetWidth(widths, section));
  const edge = Gesture.Exclusive(
    Gesture.Tap().numberOfTaps(2).withTestId('borde-lista-doble').runOnJS(true).onStart(reset),
    Gesture.Pan().withTestId('borde-lista').runOnJS(true)
      .onBegin(() => { start.set(width.get()); })
      .onUpdate(event => { width.set(clampWidth(start.get() + event.translationX, bounds)); })
      .onEnd(() => commit(width.get())),
  );
  return <Animated.View accessibilityLabel={section === 'agents' ? 'Lista de Agentes' : 'Lista de Servidores'}
    style={[{ borderRadius: RADIUS.listPane, overflow: 'hidden', backgroundColor: K.listPane, boxShadow: K.shadowListPane }, sized]}>
    <PaneInsetsContext.Provider value={true}><ShellNavigationContext.Provider value={true}>
      {section === 'agents' ? <AgentsScreen pane /> : <ServerListScreen />}
    </ShellNavigationContext.Provider></PaneInsetsContext.Provider>
    <GestureDetector gesture={edge}>
      <View accessible accessibilityRole="adjustable" accessibilityLabel="Ancho de la lista"
        accessibilityValue={{ min: bounds.min, max: bounds.max, now: Math.round(shown) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === 'activate') reset();
          else commit(shown + (nativeEvent.actionName === 'increment' ? A11Y_STEP : -A11Y_STEP));
        }}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 12 }} />
    </GestureDetector>
  </Animated.View>;
}
