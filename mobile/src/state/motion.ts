import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener, isWindowFocused } from './windowFocus';

// One subscription for every piece of machinery on screen: the window's focus through the shared
// point and the system's «reducir movimiento», heard only while some piece listens.
const listeners = new Set<() => void>();
let reduceMotion = false;
let windowFocused = true;
let stop: (() => void) | null = null;

function update(change: { reduceMotion?: boolean; windowFocused?: boolean }) {
  reduceMotion = change.reduceMotion ?? reduceMotion;
  windowFocused = change.windowFocused ?? windowFocused;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!stop) {
    let live = true;
    windowFocused = isWindowFocused();
    const blur = addWindowFocusListener('blur', () => update({ windowFocused: false }));
    const focus = addWindowFocusListener('focus', () => update({ windowFocused: true }));
    const changed = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => update({ reduceMotion: enabled }));
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (live) update({ reduceMotion: enabled }); }, () => {});
    stop = () => { live = false; blur.remove(); focus.remove(); changed?.remove(); };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}

const StillContext = createContext(false);
/** Holds the machinery inside it at rest, as «reducir movimiento» would: the demo shows both. */
export const StillMotion = StillContext.Provider;

/**
 * Whether continuous machinery may move: on a screen in front, with the app visible (LockGate's
 * visibility already follows AppState) and its window focused, and «reducir movimiento» off.
 * Otherwise every piece holds its rest pose.
 */
export function useMotion(): boolean {
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const allowed = useSyncExternalStore(subscribe, () => windowFocused && !reduceMotion);
  const visible = useChatVisible();
  const still = useContext(StillContext);
  return visible && focused && allowed && !still;
}
