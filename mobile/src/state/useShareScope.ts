import { useLayoutEffect, useRef, useState } from 'react';
import { addWindowFocusListener } from './windowFocus';
import { useControlScope } from './useControlScope';
// Android's notification shade can blur a still-active Activity.
export function useShareScope(identity: unknown, connected = true) {
  const [focused, setFocused] = useState(true);
  const generation = useRef({ revision: 0, focused: true });
  const control = useControlScope(identity, connected && focused);
  useLayoutEffect(() => {
    const generationState = generation.current;
    const blur = addWindowFocusListener('blur', () => { generationState.focused = false; generationState.revision++; setFocused(false); });
    const focus = addWindowFocusListener('focus', () => { generationState.focused = true; setFocused(true); });
    return () => { generationState.focused = false; generationState.revision++; blur.remove(); focus.remove(); };
  }, []);
  return { ...control, begin() {
    if (!generation.current.focused) return null;
    const permission = control.begin(); const captured = generation.current.revision;
    return permission ? () => generation.current.focused && generation.current.revision === captured && permission() : null;
  } };
}
