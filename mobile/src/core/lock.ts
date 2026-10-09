// When the app locks and when it asks for the fingerprint. Kept free of React so the rules can be
// tested: a prompt at the wrong moment (for instance right after saving the first server) is the
// kind of thing that only shows up on a real phone.

export interface LockState {
  locked: boolean;
  /** when the app went to the background, if it is there now */
  leftAt: number | null;
}

export type LockEvent =
  | { type: 'unlocked' }
  | { type: 'background'; now: number }
  | { type: 'idle'; enabled: boolean }
  | { type: 'foreground'; now: number; enabled: boolean; delayMs: number };

/** AHORA applies on leaving the app; positive delays also show the design's idle warning. */
export function idleLockCountdown(lastActivityAt: number, now: number, delayMs: number, enabled: boolean): number | null {
  if (!enabled || delayMs === 0) return null;
  const remaining = Math.max(0, Math.ceil((lastActivityAt + delayMs - now) / 1000));
  return remaining <= 8 ? remaining : null;
}

/**
 * Decided once, when the app launches. There is deliberately no event for "the lock was just
 * enabled": turning it on mid-session (saving the first server does) must neither lock nor
 * prompt, so the caller freezes this value at mount and never feeds a later one in.
 */
export function lockAtLaunch(enabled: boolean): LockState {
  return { locked: enabled, leftAt: null };
}

/** `prompt` tells the caller to show the biometric dialog now. */
export function lockReduce(state: LockState, event: LockEvent): { state: LockState; prompt: boolean } {
  switch (event.type) {
    case 'unlocked':
      return { state: { ...state, locked: false }, prompt: false };
    case 'background':
      return { state: { ...state, leftAt: event.now }, prompt: false };
    case 'idle':
      return { state: { ...state, locked: state.locked || event.enabled }, prompt: false };
    case 'foreground': {
      if (state.leftAt == null) return { state, prompt: false };
      const expired = event.enabled && event.now - state.leftAt >= event.delayMs;
      return { state: { locked: state.locked || expired, leftAt: null }, prompt: expired };
    }
  }
}

export interface LockGateConfig { enabled: boolean; delayMs: number }
export interface LockGateState extends LockGateConfig {
  lock: LockState;
  atLaunch: boolean;
  prompt: boolean;
  lockedAt: number;
  reason: string;
}
export type LockGateEvent = { type: 'unlocked' } | { type: 'idle'; now?: number } | { type: 'background'; now: number } | { type: 'foreground'; now: number };

export function createLockGate(config: LockGateConfig, now = 0): LockGateState {
  return { ...config, atLaunch: config.enabled, lock: lockAtLaunch(config.enabled), prompt: config.enabled, lockedAt: now, reason: 'AL ABRIR LA APP' };
}

/** Settings and the first Servidor affect future events, never the frozen launch decision. */
export function configureLockGate(state: LockGateState, config: LockGateConfig): LockGateState {
  return { ...state, ...config };
}

export function lockGateEvent(state: LockGateState, event: LockGateEvent): { state: LockGateState; prompt: boolean } {
  const input: LockEvent = event.type === 'foreground' ? { type: 'foreground', now: event.now, enabled: state.enabled, delayMs: state.delayMs }
    : event.type === 'idle' ? { type: 'idle', enabled: state.enabled } : event;
  const next = lockReduce(state.lock, input);
  const newlyLocked = !state.lock.locked && next.state.locked;
  return { state: {
    ...state, lock: next.state, prompt: event.type === 'unlocked' ? false : state.prompt || next.prompt,
    lockedAt: newlyLocked && 'now' in event ? event.now ?? state.lockedAt : state.lockedAt,
    reason: newlyLocked ? event.type === 'idle' ? 'POR INACTIVIDAD' : 'AL SALIR DE LA APP' : state.reason,
  }, prompt: next.prompt };
}

/** Props consumed directly by the gate so locked content is hidden visually and to accessibility. */
export function lockGateView(state: LockGateState, previewLocked: boolean) {
  const showLock = (state.lock.locked && state.enabled) || previewLocked;
  return { showLock, contentProps: {
    style: { flex: 1, display: showLock ? 'none' as const : 'flex' as const },
    importantForAccessibility: showLock ? 'no-hide-descendants' as const : 'auto' as const,
  } };
}

export type LockGateAction = LockGateEvent | { type: 'configured'; enabled: boolean; delayMs: number } | { type: 'prompted' };

/** React only delivers events and executes the prompt selected here; it owns no lock decisions. */
export function lockGateReducer(state: LockGateState, action: LockGateAction): LockGateState {
  if (action.type === 'configured') return configureLockGate(state, { enabled: action.enabled, delayMs: action.delayMs });
  if (action.type === 'prompted') return { ...state, prompt: false };
  return lockGateEvent(state, action).state;
}
