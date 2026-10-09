// The `metrics` capability: CPU, memory and the Hermes disk of the whole machine, read with Node and
// /proc behind a reader the tests replace. Errors never leave here with their text: server.ts answers
// a fixed message, because an fs error carries the Hermes path.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { CapabilityAdvertisement, ServerMetrics } from '../../protocol/protocol.ts';

export const METRICS_CAPABILITY: CapabilityAdvertisement = { version: 1, minAppVersion: 1 };

/** Summed over every CPU, in the units of os.cpus(). */
export interface CpuTimes { idle: number; total: number }
/** The fs.statfs fields used, in blocks. */
export interface DiskBlocks { blocks: number; bfree: number; bavail: number }
export interface SystemReader {
  /** False where any of the reads below cannot work: the Puente then does not advertise metrics. */
  supported: boolean;
  cpu(): CpuTimes;
  /** The text of /proc/meminfo. */
  meminfo(): Promise<string>;
  statfs(path: string): Promise<DiskBlocks>;
}

export function createSystemReader(platform: NodeJS.Platform = process.platform): SystemReader {
  return {
    supported: platform === 'linux' && existsSync('/proc/meminfo') && os.cpus().length > 0,
    cpu() {
      let idle = 0, total = 0;
      for (const { times } of os.cpus()) { idle += times.idle; total += times.user + times.nice + times.sys + times.idle + times.irq; }
      return { idle, total };
    },
    meminfo: () => fs.readFile('/proc/meminfo', 'utf8'),
    statfs: (path) => fs.statfs(path),
  };
}

export interface Metrics { read(): Promise<Omit<ServerMetrics, 'measuredAt'>> }

/** Two CPU samples this far apart when there is no recent one; a sample older than RECENT_MS is not compared against. */
const SAMPLE_MS = 250;
const RECENT_MS = 15_000;

function percent(part: number, whole: number): number {
  const value = (100 * part) / whole;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Metric out of range.');
  return Math.round(value * 10) / 10;
}

function kilobytes(meminfo: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
  if (!match) throw new Error('Unreadable meminfo.');
  return Number(match[1]);
}

/** Null when the reader does not work on this platform. */
export function createMetrics(deps: { reader: SystemReader; hermesHome: string; monotonic?: () => number; wait?: (ms: number) => Promise<void> }): Metrics | null {
  const { reader, hermesHome } = deps;
  if (!reader.supported) return null;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: (CpuTimes & { at: number }) | null = null;

  async function cpuPercent(): Promise<number> {
    const at = monotonic();
    let before = last && at - last.at >= SAMPLE_MS && at - last.at <= RECENT_MS ? last : null;
    if (!before) { before = { ...reader.cpu(), at }; await wait(SAMPLE_MS); }
    const after = { ...reader.cpu(), at: monotonic() };
    last = after;
    const total = after.total - before.total;
    return percent(total - (after.idle - before.idle), total);
  }

  async function memoryPercent(): Promise<number> {
    const meminfo = await reader.meminfo();
    const total = kilobytes(meminfo, 'MemTotal');
    return percent(total - kilobytes(meminfo, 'MemAvailable'), total);
  }

  async function diskPercent(): Promise<number> {
    const { blocks, bfree, bavail } = await reader.statfs(hermesHome);
    const used = blocks - bfree;
    return percent(used, used + bavail);
  }

  return {
    async read() {
      const [cpu, memory, disk] = await Promise.all([cpuPercent(), memoryPercent(), diskPercent()]);
      return { cpuPercent: cpu, memoryPercent: memory, diskPercent: disk };
    },
  };
}
