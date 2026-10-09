import { useEffect, useEffectEvent, useRef } from 'react';

import type { BarKey } from '@/core/terminalInput';

/** A tap on the native key bar. `serial` grows with every tap, so a page knows which ones it has pressed. */
export interface KeyTap { key: BarKey; serial: number }

/** How many taps the native side keeps in the prop: older ones were pressed long ago. */
export const KEY_TAPS_KEPT = 8;

/** The list after one more tap. */
export const withTap = (taps: readonly KeyTap[], key: BarKey): KeyTap[] => [...taps.slice(-(KEY_TAPS_KEPT - 1)), { key, serial: (taps.at(-1)?.serial ?? 0) + 1 }];

/**
 * Presses every tap after the last one handled, in order, so two taps that arrive in one update are
 * both pressed. A new page starts after the last tap it is given and never replays it.
 */
export function useKeyTaps(taps: readonly KeyTap[], press: (key: BarKey) => void) {
  const handled = useRef(taps.at(-1)?.serial ?? 0);
  const apply = useEffectEvent(press);
  useEffect(() => {
    for (const tap of taps) {
      if (tap.serial <= handled.current) continue;
      handled.current = tap.serial;
      apply(tap.key);
    }
  }, [taps]);
}
