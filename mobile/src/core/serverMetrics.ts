// The `metrics` capability (docs/relay-v3.1.md): whether a Puente offers it, asking for it and
// validating the answer, so the Servidor card can choose between its gauges, «Actualiza el Puente
// para ver CPU, MEM y DISCO» and the last reading marked as old.
import { METRICS_CAPABILITY_NAME } from '../../../protocol/protocol.ts';
import type { ServerMetrics } from '../../../protocol/protocol.ts';
import type { RelayClient } from './client.ts';
import { negotiate, type AppCapability } from './remoteCapabilities.ts';

/** The contract version this app implements: a code constant, never the APK version. */
export const APP_METRICS_CAPABILITY: AppCapability = { version: 1, minBridgeVersion: 1 };

export type MetricsReading =
  /** No compatible advertisement: an old Puente, or one whose system reader does not work there. */
  | { state: 'not_advertised' }
  | { state: 'reading'; metrics: ServerMetrics }
  /** Network failure, an error answer or an invalid reading: keep the last one, marked as old. */
  | { state: 'failure' };

const share = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

export function validServerMetrics(value: unknown): value is ServerMetrics {
  if (typeof value !== 'object' || value === null) return false;
  const reading = value as Record<string, unknown>;
  return share(reading.cpuPercent) && share(reading.memoryPercent) && share(reading.diskPercent)
    && typeof reading.measuredAt === 'number' && Number.isSafeInteger(reading.measuredAt) && reading.measuredAt >= 0;
}

/** `health` is the last /health body of this Servidor. Only an advertised Puente is asked. */
export async function readServerMetrics(health: unknown, client: Pick<RelayClient, 'metrics'>): Promise<MetricsReading> {
  // ponytail: a Puente that needs a newer app (update_app) also reads as not advertised; the card has no third text for it until a metrics v2 exists.
  if (negotiate(health, METRICS_CAPABILITY_NAME, APP_METRICS_CAPABILITY).state !== 'available' || !client.metrics) return { state: 'not_advertised' };
  let value: unknown;
  try { value = await client.metrics(); } catch { return { state: 'failure' }; }
  if (!validServerMetrics(value)) return { state: 'failure' };
  const { cpuPercent, memoryPercent, diskPercent, measuredAt } = value;
  return { state: 'reading', metrics: { cpuPercent, memoryPercent, diskPercent, measuredAt } };
}
