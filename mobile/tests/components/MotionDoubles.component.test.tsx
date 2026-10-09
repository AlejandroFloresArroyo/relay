import { useState } from 'react';
import { Text } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { act, render, screen } from '@testing-library/react-native';
import { drag, longPress } from '../support/gestures';
import { animatedStyle, animatedViews } from '../support/motion';

// The reanimated and gesture-handler doubles, driven the way the 3.1 screens will drive them.
function Row() {
  const [seen, setSeen] = useState<string[]>([]);
  const offset = useSharedValue(0);
  const pan = Gesture.Pan().withTestId('fila').runOnJS(true)
    .onUpdate(event => { setSeen(list => [...list, `x=${event.translationX}`]); })
    .onEnd(event => { offset.set(withTiming(event.translationX, { duration: 300 })); });
  const hold = Gesture.LongPress().withTestId('mantener').runOnJS(true)
    .onStart(event => { setSeen(list => [...list, `mantenida ${event.duration} ms`]); });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  return <GestureHandlerRootView>
    <GestureDetector gesture={Gesture.Simultaneous(pan, hold)}>
      <Animated.View style={style}><Text>{seen.join(' · ') || 'quieta'}</Text></Animated.View>
    </GestureDetector>
  </GestureHandlerRootView>;
}

test('a drag arrives step by step and its release animates on the fake clock', () => {
  render(<Row />);
  drag('fila', [{ x: 20 }, { x: 60 }, { x: 120 }]);
  expect(screen.getByText('x=20 · x=60 · x=120')).toBeVisible();
  const [row] = animatedViews();
  expect(animatedStyle(row).transform).toEqual([{ translateX: 0 }]);
  act(() => { jest.advanceTimersByTime(150); });
  const halfway = (animatedStyle(row).transform as { translateX: number }[])[0].translateX;
  expect(halfway).toBeGreaterThan(0); expect(halfway).toBeLessThan(120);
  act(() => { jest.advanceTimersByTime(200); });
  expect(animatedStyle(row).transform).toEqual([{ translateX: 120 }]);
});

test('a long press reaches the gesture with how long it was held', () => {
  render(<Row />);
  longPress('mantener', 1000);
  expect(screen.getByText('mantenida 1000 ms')).toBeVisible();
});
