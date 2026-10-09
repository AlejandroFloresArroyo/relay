import { StyleSheet, type ViewStyle } from 'react-native';
import { screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

// reanimated runs its JS implementation under Jest (see resolver.cjs): the UI thread's frames are
// requestAnimationFrame on the harness's fake clock, so `jest.advanceTimersByTime` moves animations.

/** What an animated view shows now: its style with reanimated's current values on top. */
export function animatedStyle(view: ReactTestInstance): ViewStyle {
  return StyleSheet.flatten([view.props.style, view.props.jestAnimatedStyle?.value]);
}

/** Every view on screen that reanimated drives, in render order. */
export function animatedViews(): ReactTestInstance[] {
  return screen.UNSAFE_root.findAll(node => typeof node.type === 'string' && node.props.jestAnimatedStyle !== undefined);
}
