import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS, PAIRING_TTL_MS } from '../../protocol/protocol.ts';
import { checkStateDirectory, createChangeLog, exactObject, isDeviceName, isTimestamp, isUuid, makeChangeRecord, openPrivateFile, StateError, syncStateDirectory, validateChangeRecord } from './changeLog.ts';
import type { ChangeInput, ChangeRecord, StateIO } from './changeLog.ts';

export interface DeviceState {
  schemaVersion: 1;
  devices: Array<{ id: string; name: string; pairedAt: number; revokedAt: number | null; keyHash: string }>;
  pendingPairing: { codeHash: string; createdAt: number; expiresAt: number } | null;
  failedAttempts: Array<{ ip: string; failures: number[]; blockedUntil: number | null }>;
  auditOutbox: ChangeRecord[];
}

interface StoreOptions {
  directory: string;
  now?: () => number;
  newId?: () => string;
  io?: StateIO;
  onFatal?: () => void;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validateState(value: unknown): asserts value is DeviceState {
  if (!exactObject(value, ['schemaVersion', 'devices', 'pendingPairing', 'failedAttempts', 'auditOutbox'])
    || value.schemaVersion !== 1 || !Array.isArray(value.devices) || !Array.isArray(value.failedAttempts)
    || !Array.isArray(value.auditOutbox)) throw new StateError();
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const device of value.devices) {
    if (!exactObject(device, ['id', 'name', 'pairedAt', 'revokedAt', 'keyHash']) || !isUuid(device.id)
      || !isDeviceName(device.name) || !isTimestamp(device.pairedAt) || !isHash(device.keyHash)
      || (device.revokedAt !== null && (!isTimestamp(device.revokedAt) || device.revokedAt < device.pairedAt))
      || ids.has(device.id) || hashes.has(device.keyHash)) throw new StateError();
    ids.add(device.id);
    hashes.add(device.keyHash);
  }
  const pending = value.pendingPairing;
  if (pending !== null && (!exactObject(pending, ['codeHash', 'createdAt', 'expiresAt']) || !isHash(pending.codeHash)
    || !isTimestamp(pending.createdAt) || !isTimestamp(pending.expiresAt)
    || pending.expiresAt !== pending.createdAt + PAIRING_TTL_MS)) throw new StateError();
  const ips = new Set<string>();
  if (value.failedAttempts.length > 4096) throw new StateError();
  for (const entry of value.failedAttempts) {
    if (!exactObject(entry, ['ip', 'failures', 'blockedUntil']) || typeof entry.ip !== 'string' || !net.isIP(entry.ip)
      || ips.has(entry.ip) || !Array.isArray(entry.failures) || entry.failures.length === 0 || entry.failures.length > AUTH_FAILURE_LIMIT) throw new StateError();
    const failures = entry.failures;
    if (!failures.every((at: unknown, index: number) => isTimestamp(at) && (index === 0 || at >= failures[index - 1]))
      || (entry.blockedUntil !== null && (!isTimestamp(entry.blockedUntil) || entry.blockedUntil < failures.at(-1)))) throw new StateError();
    ips.add(entry.ip);
  }
  const eventIds = new Set<string>();
  for (const record of value.auditOutbox) {
    validateChangeRecord(record);
    if (eventIds.has(record.id)) throw new StateError();
    eventIds.add(record.id);
  }
}

function purgeExpiredAttempts(state: DeviceState, at: number): void {
  state.failedAttempts = state.failedAttempts.filter((entry) => {
    if (entry.blockedUntil !== null) return at < entry.blockedUntil;
    entry.failures = entry.failures.filter((failure) => failure > at - AUTH_FAILURE_WINDOW_MS);
    return entry.failures.length > 0;
  });
}

export async function createDeviceStore(options: StoreOptions) {
  const directory = path.resolve(options.directory);
  const file = path.join(directory, 'devices.json');
  const io = options.io ?? fs;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const log = createChangeLog({ file: path.join(directory, 'changes.jsonl'), now, newId, io });
  let fatal = false;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  await checkStateDirectory(directory, io);

  async function commit(next: DeviceState): Promise<void> {
    validateState(next);
    const temporary = path.join(directory, `.devices.json.${randomBytes(16).toString('hex')}.tmp`);
    let renameStarted = false;
    try {
      const existing = await openPrivateFile(file, constants.O_RDONLY, false, io).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      await existing?.handle.close();
      const handle = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // From this point an I/O failure can leave a different state on disk.
      renameStarted = true;
      await io.rename(temporary, file);
      await syncStateDirectory(directory, io);
    } catch {
      if (renameStarted) {
        fatal = true;
        try { options.onFatal?.(); } catch { /* The state error remains content-free. */ }
      }
      throw new StateError();
    } finally {
      await io.unlink(temporary).catch(() => {});
    }
  }

  let state: DeviceState;
  let needsInitialization = false;
  try {
    const opened = await openPrivateFile(file, constants.O_RDONLY, false, io).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (opened) {
      try {
        state = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await opened.handle.readFile())) as DeviceState;
        validateState(state);
      } finally {
        await opened.handle.close();
      }
    } else {
      state = { schemaVersion: 1, devices: [], pendingPairing: null, failedAttempts: [], auditOutbox: [] };
      needsInitialization = true;
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError();
  }
  await log.ready();
  if (needsInitialization) await commit(state);

  async function drainOutbox(): Promise<void> {
    if (state.auditOutbox.length === 0) return;
    for (const record of state.auditOutbox) await log.appendCommitted(record);
    const next = structuredClone(state);
    next.auditOutbox = [];
    await commit(next);
    state = next;
  }

  await drainOutbox();
  const startupTime = now();
  if (!isTimestamp(startupTime)) throw new StateError();
  const purged = structuredClone(state);
  purgeExpiredAttempts(purged, startupTime);
  if (JSON.stringify(purged) !== JSON.stringify(state)) {
    await commit(purged);
    state = purged;
  }

  function ensureHealthy(): void {
    if (fatal) throw new StateError('Relay state commit is uncertain; close the service and recover from disk.');
  }

  return {
    directory,
    changeLog: log,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot(): DeviceState {
      ensureHealthy();
      return structuredClone(state);
    },
    mutate<T>(fn: (draft: DeviceState, transaction: { now: number; addChange: (input: ChangeInput) => ChangeRecord }) => T): Promise<T> {
      const operation = queue.then(async () => {
        ensureHealthy();
        await drainOutbox();
        const at = now();
        if (!isTimestamp(at)) throw new StateError();
        const draft = structuredClone(state);
        purgeExpiredAttempts(draft, at);
        const result = fn(draft, {
          now: at,
          addChange(input) {
            const record = makeChangeRecord(input, at, newId);
            draft.auditOutbox.push(record);
            return structuredClone(record);
          },
        });
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new StateError('Relay state mutations must be synchronous.');
        const next = structuredClone(draft);
        if (JSON.stringify(next) !== JSON.stringify(state)) await commit(next);
        state = next;
        for (const listener of listeners) listener();
        await drainOutbox();
        return result;
      });
      queue = operation.then(() => {}, () => {});
      return operation;
    },
  };
}

export type DeviceStore = Awaited<ReturnType<typeof createDeviceStore>>;
