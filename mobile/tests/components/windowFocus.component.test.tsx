import { useEffect, useState } from 'react';
import { AppState, Platform, Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { addWindowFocusListener, isWindowFocused } from '@/state/windowFocus';
import { emitAppBlur, emitAppFocus } from '../support/native';

function Probe() {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const blur = addWindowFocusListener('blur', () => setFocused(false));
    const focus = addWindowFocusListener('focus', () => setFocused(true));
    return () => { blur.remove(); focus.remove(); };
  }, []);
  return <Text>{focused ? 'CON FOCO' : 'SIN FOCO'}</Text>;
}

test('Android hears the window losing and regaining focus through AppState and answers its current state', () => {
  render(<Probe />);
  act(() => emitAppBlur()); expect(screen.getByText('SIN FOCO')).toBeVisible(); expect(isWindowFocused()).toBe(false);
  act(() => emitAppFocus()); expect(screen.getByText('CON FOCO')).toBeVisible(); expect(isWindowFocused()).toBe(true);
});

test('web hears the browser window and never asks react-native-web for blur or focus', () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'web');
  const browser = new EventTarget();
  const target = window as unknown as Record<'addEventListener' | 'removeEventListener', unknown>;
  const original = { addEventListener: target.addEventListener, removeEventListener: target.removeEventListener };
  Object.assign(target, { addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser) });
  const view = render(<Probe />);
  try {
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    act(() => { browser.dispatchEvent(new Event('blur')); }); expect(screen.getByText('SIN FOCO')).toBeVisible(); expect(isWindowFocused()).toBe(false);
    act(() => { browser.dispatchEvent(new Event('focus')); }); expect(screen.getByText('CON FOCO')).toBeVisible(); expect(isWindowFocused()).toBe(true);
  } finally {
    view.unmount(); Object.assign(target, original); platform.restore();
  }
});
