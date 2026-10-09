import { useCallback, useEffect, useState } from 'react';

import { LIST_WIDTHS_KEY, parseWidths, type ListWidths } from '@/core/relayLayout';
import { DEMO } from './app';
import { load, save } from './storage';

/** The tablet list widths remembered by section: read once, saved on every change; in memory in the demo. */
export function useListWidths(): [ListWidths, (next: ListWidths) => void] {
  const [widths, setWidths] = useState<ListWidths>({});
  useEffect(() => {
    if (DEMO) return;
    let live = true;
    // A width chosen before the read finishes wins over the stored one.
    void load(LIST_WIDTHS_KEY).then(raw => { if (live) setWidths(chosen => ({ ...parseWidths(raw), ...chosen })); });
    return () => { live = false; };
  }, []);
  const update = useCallback((next: ListWidths) => {
    setWidths(next);
    if (!DEMO) void save(LIST_WIDTHS_KEY, JSON.stringify(next));
  }, []);
  return [widths, update];
}
