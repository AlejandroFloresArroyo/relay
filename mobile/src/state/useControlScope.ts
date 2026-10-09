import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useChatVisible } from './chatVisibility';

// A control decision belongs to one uninterrupted visible client scope. Returning to that
// scope cannot revive a fingerprint or confirmation captured before it was hidden.
export function useControlScope(identity: unknown, connected: boolean) {
  const contentVisible = useChatVisible();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [revision, invalidate] = useReducer((value: number) => value + 1, 0);
  const scope = useRef({ generation: 0, alive: false, visible: false });
  const visible = contentVisible && focused && active && connected;
  useLayoutEffect(() => {
    const current = scope.current;
    current.alive = true; current.visible = visible;
    return () => {
      current.generation++; current.alive = false; current.visible = false;
    };
  }, [identity, visible, revision]);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => {
      scope.current.generation++; scope.current.visible = false; invalidate(); setFocused(false);
    };
  }, []));
  useLayoutEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { scope.current.generation++; scope.current.visible = false; invalidate(); }
      setActive(state === 'active');
    });
    return () => sub.remove();
  }, []);
  const begin = () => {
    if (!scope.current.alive || !scope.current.visible || AppState.currentState !== 'active') return null;
    const generation = scope.current.generation;
    const startedAt = Date.now();
    return () => {
      const elapsed = Date.now() - startedAt;
      return scope.current.alive && scope.current.visible && scope.current.generation === generation
        && AppState.currentState === 'active' && elapsed >= 0 && elapsed < 60000;
    };
  };
  return { visible, revision, begin };
}
