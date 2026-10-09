export type TailscaleButtonState = 'ready' | 'opening' | 'fallback';
type TailscaleButtonEvent = { type: 'press' } | { type: 'result'; opened: boolean };

export function describeTailscaleButton(state: TailscaleButtonState): { label: string; disabled: boolean } {
  return { label: state === 'fallback' ? 'Volver a detectar' : 'Abrir Tailscale', disabled: state === 'opening' };
}

export function transitionTailscaleButton(state: TailscaleButtonState, event: TailscaleButtonEvent): {
  state: TailscaleButtonState;
  effect: 'open' | 'retry' | null;
} {
  if (event.type === 'press') {
    if (state === 'ready') return { state: 'opening', effect: 'open' };
    if (state === 'fallback') return { state, effect: 'retry' };
  } else if (state === 'opening') {
    return { state: event.opened ? 'ready' : 'fallback', effect: null };
  }
  return { state, effect: null };
}
