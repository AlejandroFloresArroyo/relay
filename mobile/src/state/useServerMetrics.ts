import { useEffect, useEffectEvent, useState } from 'react';

import { METRICS_CAPABILITY_NAME, type ServerMetrics } from '../../../protocol/protocol';
import type { RelayClient } from '@/core/client';
import { negotiate } from '@/core/remoteCapabilities';
import { APP_METRICS_CAPABILITY, readServerMetrics } from '@/core/serverMetrics';

export type MetricsView =
  | { state: 'loading' }
  | { state: 'not_advertised' }
  /** `metrics` is the last good reading (none yet: null); `stale` once a later reading failed. */
  | { state: 'reading'; metrics: ServerMetrics | null; stale: boolean };

const METRICS_INTERVAL_MS = 5000;

/**
 * The ficha's CPU, MEM and DISCO: read at once and every 5 s while `visible` (the ficha in front
 * and Relay in the foreground), never otherwise. `health` is the Servidor's last /health body.
 */
export function useServerMetrics(client: RelayClient, health: unknown, visible: boolean): MetricsView {
  const offered = health == null ? null : negotiate(health, METRICS_CAPABILITY_NAME, APP_METRICS_CAPABILITY).state === 'available';
  // Tagged with its client, so another Servidor or a new pairing never shows this one's reading.
  const [last, setLast] = useState<{ client: RelayClient; metrics: ServerMetrics | null; stale: boolean } | null>(null);
  const read = useEffectEvent(() => readServerMetrics(health, client));
  useEffect(() => {
    if (!visible || !offered) return;
    let alive = true;
    const run = async () => {
      const result = await read();
      if (!alive || result.state === 'not_advertised') return;
      setLast(previous => result.state === 'reading' ? { client, metrics: result.metrics, stale: false }
        : { client, metrics: previous?.client === client ? previous.metrics : null, stale: true });
    };
    void run();
    const timer = setInterval(() => { void run(); }, METRICS_INTERVAL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [client, visible, offered]);
  if (offered === false) return { state: 'not_advertised' };
  return last?.client === client ? { state: 'reading', metrics: last.metrics, stale: last.stale } : { state: 'loading' };
}
