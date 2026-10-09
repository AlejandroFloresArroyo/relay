import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { exactObject, isTimestamp, validateChangeRecord, type ChangeRecord } from './changeLog.ts';
import {
  ACTIVITY_ACTIONS, ACTIVITY_RESULTS, ACTIVITY_CATEGORIES, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, ACTIVITY_MAX_BYTES, ACTIVITY_MAX_ROWS,
  ACTIVITY_MAX_LINE_BYTES, ACTIVITY_CURSOR_TTL_MS, ACTIVITY_ERROR_MESSAGES, ACTIVITY_ERROR_STATUS,
  type ActivityAction, type ActivityCategory, type ActivityErrorCode, type ActivityItem, type ActivityPage,
  type ActivityQuery, type ActivityResult,
} from '../../protocol/activity.ts';

export class ActivityError extends Error {
  readonly code: ActivityErrorCode;
  readonly status: number;
  constructor(code: ActivityErrorCode) { super(ACTIVITY_ERROR_MESSAGES[code]); this.code = code; this.status = ACTIVITY_ERROR_STATUS[code]; }
}
const unavailable = () => new ActivityError('activity_unavailable');
const exceeded = () => new ActivityError('activity_limit_exceeded');
type ActivityIO = Pick<typeof fs, 'open' | 'lstat'>;
interface Pin { handle: FileHandle; stat: BigIntStats; file: string }
interface Identity { dev: bigint; ino: bigint; ancestors: string }
interface Source { items: ActivityItem[]; identity: Identity; prefixBytes: number; digest: string }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const version = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function project(record: ChangeRecord): ActivityItem {
  const parts = record.action.split('.');
  const suffix = parts.pop()!;
  let action: ActivityAction;
  let result: ActivityResult;
  switch (record.action) {
    case 'device.paired': action = 'device.pair'; result = 'recorded'; break;
    case 'device.revoked': action = 'device.revoke'; result = 'recorded'; break;
    case 'auth.rate_limited': action = 'auth.rate_limit'; result = 'recorded'; break;
    case 'agent.mode.queued': action = 'agent.mode.queue'; result = 'requested'; break;
    case 'agent.mode.cancelled': action = 'agent.mode.cancel'; result = 'requested'; break;
    case 'conversation.personality.changed': action = 'conversation.personality.change'; result = 'recorded'; break;
    case 'conversation.model.changed': action = 'conversation.model.change'; result = 'recorded'; break;
    default:
      action = (parts.join('.') === 'agent.mode' ? 'agent.mode.apply' : parts.join('.')) as ActivityAction;
      result = suffix as ActivityResult;
  }
  if (!ACTIVITY_ACTIONS.includes(action) || !ACTIVITY_RESULTS.includes(result)) throw unavailable();
  const category: ActivityCategory = action.startsWith('agent.') || action.startsWith('personality.') ? 'configuration' : action.startsWith('job.') || action.startsWith('kanban.') ? 'tasks'
    : action.startsWith('conversation.') || action.startsWith('run.') ? 'conversations' : 'server';
  const paired = record.target.kind === 'conversation' || record.target.kind === 'run'
    || record.action.startsWith('agent.mode.') || record.action.startsWith('agent.rule.') || record.action.startsWith('job.');
  const pair = paired ? JSON.parse(record.target.id) as [string, string] : null;
  const agentId = pair?.[0] ?? (record.target.kind === 'agent' ? record.target.id : null);
  const conversationId = record.target.kind === 'conversation' && ['succeeded', 'changed'].includes(suffix)
    && !record.action.startsWith('conversation.delete.') ? pair![1] : null;
  return { id: record.id, at: Date.parse(record.at), actor: record.actor.kind === 'server' ? { kind: 'server' } : { kind: 'device', id: record.actor.id },
    action, category, result, scope: agentId === null ? { kind: 'server' } : { kind: 'agent', agentId }, conversationId };
}

// Linux descriptor-relative traversal pins every ancestor: no path is followed through a symlink.
// The reader never invokes the writer's recovery, creation, truncation or backup paths.
async function source(directory: string, io: ActivityIO, guard: () => void, previous?: Source): Promise<Source> {
  const pins: Pin[] = [];
  const handles: FileHandle[] = [];
  const open = async (file: string, flags: number) => {
    const handle = await io.open(file, flags);
    handles.push(handle); guard();
    return handle;
  };
  const wait = async <T>(operation: Promise<T>): Promise<T> => { const result = await operation; guard(); return result; };
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    guard();
    if (process.platform !== 'linux' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory.split('/').length > 64) throw unavailable();
    let current = '/';
    let handle = await open(current, directoryFlags);
    pins.push({ handle, stat: await wait(handle.stat({ bigint: true })), file: current });
    for (const component of directory.split('/').filter(Boolean)) {
      current = path.join(current, component);
      handle = await open(`/proc/self/fd/${handle.fd}/${component}`, directoryFlags);
      const stat = await wait(handle.stat({ bigint: true }));
      pins.push({ handle, stat, file: current });
      if (!stat.isDirectory()) throw unavailable();
    }
    const parent = pins.at(-1)!;
    if (parent.stat.uid !== BigInt(process.getuid!()) || (parent.stat.mode & 0o022n) !== 0n) throw unavailable();
    handle = await open(`/proc/self/fd/${handle.fd}/changes.jsonl`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await wait(handle.stat({ bigint: true }));
    const file = path.join(directory, 'changes.jsonl');
    pins.push({ handle, stat, file });
    if (!stat.isFile() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7177n) !== 0n || stat.nlink !== 1n) throw unavailable();
    const identity = { dev: stat.dev, ino: stat.ino, ancestors: pins.slice(0, -1).map(pin => `${pin.stat.dev}:${pin.stat.ino}`).join('/') };
    if (previous && (identity.dev !== previous.identity.dev || identity.ino !== previous.identity.ino || identity.ancestors !== previous.identity.ancestors || stat.size < BigInt(previous.prefixBytes))) throw unavailable();
    const length = previous ? previous.prefixBytes : Number(stat.size);
    if (length > ACTIVITY_MAX_BYTES) throw exceeded();
    const bytes = Buffer.alloc(length);
    for (let position = 0; position < length;) {
      const { bytesRead } = await wait(handle.read(bytes, position, Math.min(65536, length - position), position));
      if (bytesRead === 0) throw unavailable();
      position += bytesRead;
    }
    for (const pin of pins) {
      const held = await wait(pin.handle.stat({ bigint: true }));
      const entry = await wait(io.lstat(pin.file, { bigint: true }));
      if (!same(pin.stat, held) || !same(pin.stat, entry) || entry.isSymbolicLink()
        || (pin.stat.isDirectory() ? entry.mode !== pin.stat.mode : !version(pin.stat, held) || !version(pin.stat, entry))) throw unavailable();
    }
    const prefixBytes = previous ? length : bytes.lastIndexOf(10) + 1;
    if (length - prefixBytes > ACTIVITY_MAX_LINE_BYTES) throw exceeded();
    const digest = hash(bytes.subarray(0, prefixBytes));
    if (previous) {
      if (digest !== previous.digest) throw unavailable();
      return previous;
    }
    const items: ActivityItem[] = [];
    const ids = new Set<string>();
    for (let start = 0; start < prefixBytes;) {
      const end = bytes.indexOf(10, start);
      if (end - start > ACTIVITY_MAX_LINE_BYTES || items.length >= ACTIVITY_MAX_ROWS) throw exceeded();
      const record: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(start, end)));
      validateChangeRecord(record);
      if (ids.has(record.id)) throw unavailable();
      ids.add(record.id); items.push(project(record)); start = end + 1;
    }
    items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { items, identity, prefixBytes, digest };
  } catch (error) {
    guard();
    throw error instanceof ActivityError ? error : unavailable();
  } finally {
    for (const handle of handles.reverse()) { await handle.close().catch(() => {}); try { guard(); } catch { /* Close every held descriptor before propagating revocation. */ } }
    guard();
  }
}
const MAX_SNAPSHOTS = 4;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
interface Filters { agentId: string | null; category: ActivityCategory | null; failuresOnly: boolean }
interface Snapshot { source: Source; items: ActivityItem[]; deviceId: string; filters: string; capturedAt: number; memory: number }
function normalize(query: ActivityQuery): { limit: number; cursor?: string; filters: Filters } {
  if (!exactObject(query as unknown, [], ['limit', 'cursor', 'agentId', 'category', 'failuresOnly'])) throw new ActivityError('invalid_activity_query');
  const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT
    || query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{70}$/.test(query.cursor))
    || query.agentId !== undefined && (typeof query.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(query.agentId))
    || query.category !== undefined && !ACTIVITY_CATEGORIES.includes(query.category)
    || query.failuresOnly !== undefined && typeof query.failuresOnly !== 'boolean') throw new ActivityError('invalid_activity_query');
  return { limit, cursor: query.cursor, filters: { agentId: query.agentId ?? null, category: query.category ?? null, failuresOnly: query.failuresOnly ?? false } };
}
export function activityQuery(parameters: URLSearchParams): ActivityQuery {
  for (const key of parameters.keys()) {
    if (!['limit', 'cursor', 'agentId', 'category', 'failuresOnly'].includes(key) || parameters.getAll(key).length !== 1) throw new ActivityError('invalid_activity_query');
  }
  const query: ActivityQuery = {};
  if (parameters.has('limit')) {
    const value = parameters.get('limit')!;
    if (!/^[1-9][0-9]{0,2}$/.test(value)) throw new ActivityError('invalid_activity_query');
    query.limit = Number(value);
  }
  if (parameters.has('cursor')) query.cursor = parameters.get('cursor')!;
  if (parameters.has('agentId')) query.agentId = parameters.get('agentId')!;
  if (parameters.has('category')) query.category = parameters.get('category') as ActivityCategory;
  if (parameters.has('failuresOnly')) {
    const value = parameters.get('failuresOnly');
    if (value !== 'true' && value !== 'false') throw new ActivityError('invalid_activity_query');
    query.failuresOnly = value === 'true';
  }
  normalize(query);
  return query;
}
export function createActivityReader(options: { directory: string; now?: () => number; io?: ActivityIO }) {
  const snapshots = new Map<string, Snapshot>();
  const key = randomBytes(32); // Process-local cursor MAC; no persisted or production key.
  const now = options.now ?? Date.now;
  let busy = false;
  const mac = (payload: Buffer) => createHmac('sha256', key).update(payload).digest();
  function cursor(id: string, offset: number): string {
    const payload = Buffer.alloc(20);
    Buffer.from(id, 'hex').copy(payload); payload.writeUInt32BE(offset, 16);
    return Buffer.concat([payload, mac(payload)]).toString('base64url');
  }
  return {
    async list(query: ActivityQuery, deviceId: string, guard: () => void): Promise<ActivityPage> {
      guard();
      const parsed = normalize(query);
      const filters = JSON.stringify(parsed.filters);
      const capturedAt = now();
      if (!isTimestamp(capturedAt)) throw unavailable();
      for (const [id, entry] of snapshots) if (capturedAt >= entry.capturedAt + ACTIVITY_CURSOR_TTL_MS || capturedAt < entry.capturedAt) snapshots.delete(id);
      if (busy) throw new ActivityError('activity_busy');
      busy = true;
      try {
        let id: string, snapshot: Snapshot, offset = 0;
        if (parsed.cursor) {
          const bytes = Buffer.from(parsed.cursor, 'base64url');
          if (bytes.length !== 52 || bytes.toString('base64url') !== parsed.cursor || !timingSafeEqual(bytes.subarray(20), mac(bytes.subarray(0, 20)))) throw new ActivityError('activity_cursor_expired');
          id = bytes.subarray(0, 16).toString('hex'); offset = bytes.readUInt32BE(16);
          const found = snapshots.get(id);
          if (!found) throw new ActivityError('activity_cursor_expired');
          if (found.deviceId !== deviceId || found.filters !== filters) throw new ActivityError('invalid_activity_query');
          snapshot = found;
          await source(options.directory, options.io ?? fs, guard, snapshot.source); guard();
        } else {
          if (snapshots.size >= MAX_SNAPSHOTS) throw new ActivityError('activity_busy');
          const data = await source(options.directory, options.io ?? fs, guard); guard();
          const items = data.items.filter(item => (!parsed.filters.agentId || item.scope.kind === 'agent' && item.scope.agentId === parsed.filters.agentId)
            && (!parsed.filters.category || item.category === parsed.filters.category)
            && (!parsed.filters.failuresOnly || item.result === 'failed' || item.result === 'rejected' || item.result === 'uncertain'));
          const memory = data.items.reduce((sum, item) => sum + 512 + 2 * Buffer.byteLength(JSON.stringify(item)), 1024);
          if (memory > MAX_RETAINED_BYTES) throw exceeded();
          if (memory + [...snapshots.values()].reduce((sum, entry) => sum + entry.memory, 0) > MAX_RETAINED_BYTES) throw new ActivityError('activity_busy');
          id = randomBytes(16).toString('hex'); snapshot = { source: data, items, deviceId, filters, capturedAt, memory };
          if (items.length > parsed.limit) snapshots.set(id, snapshot);
        }
        const finishedAt = now();
        if (!isTimestamp(finishedAt) || finishedAt < snapshot.capturedAt || finishedAt >= snapshot.capturedAt + ACTIVITY_CURSOR_TTL_MS) throw new ActivityError('activity_cursor_expired');
        if (offset >= snapshot.items.length && offset !== 0) throw new ActivityError('activity_cursor_expired');
        const items = structuredClone(snapshot.items.slice(offset, offset + parsed.limit));
        guard();
        return { items, capturedAt: snapshot.capturedAt, nextCursor: offset + items.length < snapshot.items.length ? cursor(id, offset + items.length) : null };
      } finally { busy = false; }
    },
  };
}
export type ActivityReader = ReturnType<typeof createActivityReader>;
