import { AppState, Platform } from 'react-native';

// The root layout always listens (ShareLauncher, WidgetBridge), so every blur and focus passes through here.
let focused = true;

/**
 * The one place that hears the window losing or regaining focus, independent of AppState changes.
 * Android: AppState blur/focus (the notification shade can blur a still-active Activity).
 * Web: react-native-web rejects those events, so the browser window's own focus answers.
 */
export function addWindowFocusListener(type: 'blur' | 'focus', listener: () => void): { remove(): void } {
  const handler = () => { focused = type === 'focus'; listener(); };
  if (Platform.OS !== 'web') return AppState.addEventListener(type, handler);
  window.addEventListener(type, handler);
  return { remove: () => window.removeEventListener(type, handler) };
}

/** Whether the window has focus, as last heard by addWindowFocusListener; focused until a blur arrives. */
export function isWindowFocused(): boolean {
  return focused;
}
