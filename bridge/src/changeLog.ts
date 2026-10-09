import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { REMOTE_ID_PATTERN } from '../../protocol/protocol.ts';

export interface ChangeRecord {
  id: string;
  at: string;
  actor: { kind: 'server' } | { kind: 'device'; id: string; name: string };
  action: string;
  target: { kind: 'device' | 'ip' | 'agent' | 'server' | 'conversation' | 'run' | 'preset' | 'environment' | 'operation' | 'app'; id: string };
  details?: { blockedUntil: number } | { file: 'memory' | 'user' | 'soul'; previous: boolean } | { itemId: string; requestId: string } | { profile: true; previous: boolean };
}

export type ChangeInput = Omit<ChangeRecord, 'id' | 'at'>;
export type StateIO = Pick<typeof fs, 'open' | 'lstat' | 'realpath' | 'rename' | 'unlink'>;

export class StateError extends Error {
  constructor(message = 'Relay state is unavailable or invalid.') {
    super(message);
    this.name = 'StateError';
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

export function isDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
}

export function exactObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

const CHAT_CHANGE_ACTIONS: readonly string[] = [
  'conversation.create.requested',
  'conversation.create.succeeded',
  'conversation.create.failed',
  'conversation.create.uncertain',
  'conversation.rename.requested',
  'conversation.rename.succeeded',
  'conversation.rename.failed',
  'conversation.rename.uncertain',
  'conversation.delete.requested',
  'conversation.delete.succeeded',
  'conversation.delete.failed',
  'conversation.delete.uncertain',
  'conversation.model.changed',
  'conversation.personality.changed',
  'run.steer.requested',
  'run.steer.accepted',
  'run.steer.rejected',
  'run.steer.uncertain',
  'run.stop.requested',
  'run.stop.succeeded',
  'run.stop.uncertain',
];

function isChatTargetId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const pair: unknown = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string' && id.length > 0
      && id.length <= 256 && id !== '.' && id !== '..' && !/[\x00-\x1f\x7f/\\]/.test(id)) && JSON.stringify(pair) === value;
  } catch { return false; }
}

function validateInput(input: unknown): asserts input is ChangeInput {
  if (!exactObject(input, ['actor', 'action', 'target'], ['details'])) throw new StateError();
  const { actor, target, action } = input;
  const serverActor = exactObject(actor, ['kind']) && actor.kind === 'server';
  const deviceActor = exactObject(actor, ['kind', 'id', 'name']) && actor.kind === 'device' && isUuid(actor.id) && isDeviceName(actor.name);
  if ((!serverActor && !deviceActor) || !exactObject(target, ['kind', 'id'])) throw new StateError();
  // Only producers with a specified, content-free schema may add actions here.
  if (typeof action === 'string' && /^personality\.preset\.(create|update|delete)\.(requested|succeeded)$/.test(action)) {
    if (!deviceActor || target.kind !== 'preset' || !isUuid(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && /^personality\.soul\.apply\.(requested|recorded)$/.test(action)) {
    if (!deviceActor || target.kind !== 'agent' || typeof target.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (action === 'device.paired') {
    if (!deviceActor || target.kind !== 'device' || target.id !== actor.id || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (action === 'device.revoked') {
    if (!serverActor || target.kind !== 'device' || !isUuid(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (action === 'notification.registration.requested') {
    if ((!deviceActor && !serverActor) || target.kind !== 'device' || !isUuid(target.id) || (deviceActor && target.id !== actor.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (action === 'auth.rate_limited') {
    if (!serverActor || target.kind !== 'ip' || typeof target.id !== 'string' || !net.isIP(target.id)
      || !exactObject(input.details, ['blockedUntil']) || !isTimestamp(input.details.blockedUntil)) throw new StateError();
  } else if (typeof action === 'string' && ['agent.mode.queued', 'agent.mode.cancelled', 'agent.mode.requested', 'agent.mode.succeeded', 'agent.rule.add.requested', 'agent.rule.add.succeeded', 'agent.rule.remove.requested', 'agent.rule.remove.succeeded'].includes(action)) {
    if (!deviceActor || target.kind !== 'agent' || !isChatTargetId(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && /^(server\.(pause|resume)|gateway\.(start|stop|restart))\.(requested|succeeded|failed)$/.test(action)) {
    if (!deviceActor || target.kind !== 'server' || target.id !== 'local' || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (action === 'agent.tools.enable.requested' || action === 'agent.tools.disable.requested') {
    if (!deviceActor || target.kind !== 'agent' || typeof target.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && /^job\.(create|edit|delete|pause|resume|run)\.requested$/.test(action)) {
    if (!deviceActor || target.kind !== 'agent' || !isChatTargetId(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && /^(kanban\.(create|update|comment)\.succeeded|kanban\.notify\.(requested|accepted|rejected|uncertain))$/.test(action)) {
    if (!deviceActor || target.kind !== 'server' || target.id !== 'local'
      || !exactObject(input.details, ['itemId', 'requestId']) || !isUuid(input.details.itemId)
      || typeof input.details.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.details.requestId)) throw new StateError();
  } else if (typeof action === 'string' && CHAT_CHANGE_ACTIONS.includes(action)) {
    const kind = action.startsWith('conversation.') ? 'conversation' : 'run';
    if (!deviceActor || target.kind !== kind || !isChatTargetId(target.id) || Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && ['agent.memory.edit.requested', 'agent.memory.delete.requested', 'agent.soul.edit.requested', 'agent.memory.edit.succeeded', 'agent.memory.delete.succeeded', 'agent.soul.edit.succeeded'].includes(action)) {
    if (!deviceActor || target.kind !== 'agent' || typeof target.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.id)) throw new StateError();
    if (action.endsWith('.requested')) {
      if (!exactObject(input.details, ['file', 'previous']) || typeof input.details.previous !== 'boolean'
        || (action.startsWith('agent.soul.') ? input.details.file !== 'soul' : !['memory', 'user'].includes(String(input.details.file)))) throw new StateError();
    } else if (Object.hasOwn(input, 'details')) throw new StateError();
  } else if (typeof action === 'string' && /^remote\.file\.(create|write|move|rename|delete)$/.test(action)) {
    // ADR 0006: never the path. A write into a Hermes profile says whether its previous version was
    // kept, in remote-file-<record id>.previous next to this log.
    if (!deviceActor || target.kind !== 'server' || target.id !== 'local' || (Object.hasOwn(input, 'details')
      && (!exactObject(input.details, ['profile', 'previous']) || input.details.profile !== true || typeof input.details.previous !== 'boolean'))) throw new StateError();
  } else if (typeof action === 'string' && /^remote\.(environment\.(created|terminate_requested|terminated|terminate_failed|lost|discarded)|browser\.(connected|disconnected)|web\.(registered|unregistered|authorized|cancelled|expired))$/.test(action)) {
    // ADR 0006: actor, date, action and target only.
    const [kind, prefix] = action.startsWith('remote.web.') ? ['app', 'app'] : ['environment', 'env'];
    if (target.kind !== kind || typeof target.id !== 'string' || !new RegExp(REMOTE_ID_PATTERN).test(target.id) || !target.id.startsWith(`${prefix}_`)
      || Object.hasOwn(input, 'details')) throw new StateError();
  } else {
    throw new StateError();
  }
}

export function validateChangeRecord(value: unknown): asserts value is ChangeRecord {
  if (!exactObject(value, ['id', 'at', 'actor', 'action', 'target'], ['details']) || !isUuid(value.id)
    || typeof value.at !== 'string') throw new StateError();
  const at = Date.parse(value.at);
  if (!isTimestamp(at) || new Date(at).toISOString() !== value.at) throw new StateError();
  const { id: _id, at: _at, ...input } = value;
  validateInput(input);
  if (value.action === 'auth.rate_limited' && (value.details as { blockedUntil: number }).blockedUntil < at) throw new StateError();
}

export function makeChangeRecord(input: ChangeInput, at: number, newId: () => string): ChangeRecord {
  const copy = structuredClone(input);
  validateInput(copy);
  if (!isTimestamp(at)) throw new StateError();
  const record = { id: newId(), at: new Date(at).toISOString(), ...copy };
  validateChangeRecord(record);
  return record;
}

export async function checkStateDirectory(directory: string, io: StateIO = fs): Promise<void> {
  try {
    const stat = await io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o022) !== 0 || await io.realpath(directory) !== path.resolve(directory)) throw new StateError();
  } catch {
    throw new StateError('Relay state directory must be owned by this user, writable only by this user, and not a symbolic link.');
  }
}

function checkFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new StateError();
  if ((stat.mode & 0o7177) !== 0) throw new StateError('Relay state files require private permissions; repair them to 0600.');
}

export async function openPrivateFile(file: string, flags: number, create: boolean, io: StateIO = fs): Promise<{ handle: FileHandle; created: boolean }> {
  await checkStateDirectory(path.dirname(file), io);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    try {
      // Nonblocking prevents an unexpected FIFO from hanging before fstat can reject it.
      handle = await io.open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      handle = await io.open(file, flags | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600);
      created = true;
    }
    checkFile(await handle.stat());
    return { handle, created };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof StateError) throw error;
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new StateError();
  }
}

export async function syncStateDirectory(directory: string, io: StateIO = fs): Promise<void> {
  const handle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createChangeLog(options: { file: string; now?: () => number; newId?: () => string; io?: StateIO }) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const io = options.io ?? fs;
  let queue: Promise<void> = Promise.resolve();
  let loaded = false;
  const records = new Map<string, string>();

  async function recover(): Promise<void> {
    if (loaded) return;
    const { handle, created } = await openPrivateFile(options.file, constants.O_RDWR | constants.O_APPEND, true, io);
    try {
      const bytes = await handle.readFile();
      const end = bytes.lastIndexOf(10) + 1;
      const recovered = new Map<string, string>();
      for (const line of new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, end)).split('\n').slice(0, -1)) {
        const record: unknown = JSON.parse(line);
        validateChangeRecord(record);
        if (recovered.has(record.id)) throw new StateError();
        recovered.set(record.id, JSON.stringify(record));
      }
      // Validate all complete lines before discarding the final incomplete write.
      if (end !== bytes.length) await handle.truncate(end);
      await handle.sync();
      if (created) await syncStateDirectory(path.dirname(options.file), io);
      records.clear();
      for (const [id, record] of recovered) records.set(id, record);
      loaded = true;
    } finally {
      await handle.close();
    }
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const operation = queue.then(fn).catch((error: unknown) => {
      loaded = false; // An append/fsync outcome can be uncertain: re-read before retrying.
      throw error instanceof StateError ? error : new StateError();
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  }

  async function append(record: ChangeRecord): Promise<void> {
    validateChangeRecord(record);
    await recover();
    const serialized = JSON.stringify(record);
    const previous = records.get(record.id);
    if (previous !== undefined) {
      if (previous !== serialized) throw new StateError();
      return;
    }
    const { handle } = await openPrivateFile(options.file, constants.O_WRONLY | constants.O_APPEND, false, io);
    try {
      await handle.writeFile(`${serialized}\n`, 'utf8');
      await handle.sync();
      records.set(record.id, serialized);
    } finally {
      await handle.close();
    }
  }

  return {
    ready: () => enqueue(recover),
    appendCommitted(record: ChangeRecord): Promise<void> {
      const copy = structuredClone(record);
      return enqueue(() => append(copy));
    },
    appendChange(input: ChangeInput): Promise<ChangeRecord> {
      const copy = structuredClone(input);
      return enqueue(async () => {
        const record = makeChangeRecord(copy, now(), newId);
        await append(record);
        return record;
      });
    },
  };
}

export type ChangeLog = ReturnType<typeof createChangeLog>;
