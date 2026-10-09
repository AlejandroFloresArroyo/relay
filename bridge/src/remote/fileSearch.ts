// A file search (#87, protocol/remoteFiles.ts «Search»): by name in a folder and its subfolders, or
// by text content, without an index. It runs on async fs calls, so the Puente keeps answering while it
// walks (review of #85, P3). It never follows a link, so no cycle of links can form; a folder that is
// one of its own ancestors (a bind mount of a parent) is skipped, and so are pseudo filesystems.
// Only regular files are read, opened without following a link nor waiting on a FIFO. Results go out
// as frames with seqs; while a window of them is unacknowledged the walk waits, so none is dropped.
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import { REMOTE_FILE_SEARCH_MATCHES_MAX } from '../../../protocol/remoteFiles.ts';
import type { RemoteFileEntry, RemoteFileSearchEvent, RemoteFileSearchMatch, RemoteFileSearchProgress } from '../../../protocol/remoteFiles.ts';
import { exactObject } from '../changeLog.ts';
import { RemoteError, RemoteStream } from './routes.ts';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const READ_BYTES = 65_536;
const BINARY_PROBE = 8192;
const BATCH = 64;
const PROGRESS_MS = 500;
// Kernel-generated trees: endless, changing, and some files there block or act when read.
// proc, sysfs, devpts, debugfs, tracefs, securityfs, cgroup, cgroup2, bpf, pstore, configfs, fusectl,
// binfmt_misc, efivarfs, mqueue.
const PSEUDO = new Set([0x9fa0, 0x62656572, 0x1cd1, 0x64626720, 0x74726163, 0x73636673, 0x27e0eb, 0x63677270,
  0xcafe4a11, 0x6165676c, 0x62656570, 0x65735543, 0x42494e4d, 0xde5e81e4, 0x19800202]);

const at = (fd: number, name: Buffer) => Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
const join = (folder: string, name: string) => folder === '/' ? `/${name}` : `${folder}/${name}`;

// An upload's temporary file (files.ts `startUpload`): partial bytes, never shown nor found, also when
// a crash of the Puente left it behind.
const UPLOAD_TEMPORARY = /^\.relay-upload-[0-9a-f]{24}$/;

/**
 * A pinned folder's names as raw bytes, read in batches through the thread pool, without upload
 * temporaries. @types/node types `encoding` as text only; Node also accepts 'buffer' and then gives
 * Buffer names.
 */
export async function* names(fd: number, bufferSize: number): AsyncGenerator<Buffer> {
  const dir = await fsp.opendir(`/proc/self/fd/${fd}`, { encoding: 'buffer' as BufferEncoding, bufferSize });
  // for await closes the folder however the loop ends.
  for await (const dirent of dir) {
    const name = dirent.name as unknown as Buffer;
    if (name[0] !== 0x2e || !UPLOAD_TEMPORARY.test(name.toString('latin1'))) yield name;
  }
}
class Stopped extends Error {}

export interface SearchOptions {
  /** The pinned folder: the search owns its descriptor and closes it when it ends. */
  root: { fd: number; real: string };
  query: string;
  content: boolean;
  hidden: boolean;
  describe: (fd: number, name: Buffer, stat: BigIntStats) => Promise<RemoteFileEntry>;
  /** False once the operation is no longer running: cancelled, revoked or forgotten. */
  running: () => boolean;
  /** The walk ended by itself; answers the operation's final state. */
  finished: () => 'completed' | 'cancelled' | 'failed';
  now: () => number;
}

export interface Search {
  /** A stream from `lastEventId` on: frames up to it count as acknowledged. Replaces the previous one. */
  open(lastEventId: unknown): RemoteStream<RemoteFileSearchEvent>;
  ack(body: unknown): { ok: true };
  /** Wakes a waiting walk so it sees it no longer runs. */
  wake(): void;
}

export function startSearch(options: SearchOptions): Search {
  const { root, content, hidden } = options;
  const needle = Buffer.from(options.query);
  const lower = options.query.toLowerCase();
  const progress: RemoteFileSearchProgress = { folders: 0, files: 0, unreadable: 0 };
  const frames: { seq: number; event: RemoteFileSearchEvent; bytes: number }[] = [];
  let seq = 0;
  let unacked = 0;
  let pending: RemoteFileSearchMatch[] = [];
  let found = 0;
  let truncated = false;
  let flushedAt = options.now();
  let ended = false;
  let resume: (() => void) | null = null;
  // The open stream, if any: a holder, since it changes from other requests' closures.
  const live: { channel: { send: (event: RemoteFileSearchEvent, id?: number) => void; end: () => void } | null } = { channel: null };

  function emit(event: RemoteFileSearchEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    frames.push({ seq: event.seq, event, bytes });
    unacked += bytes;
    live.channel?.send(event, event.seq);
  }
  function check(): void {
    if (!options.running()) throw new Stopped();
  }
  async function flush(): Promise<void> {
    emit({ type: 'results', seq: ++seq, matches: pending, ...progress });
    pending = [];
    flushedAt = options.now();
    // Backpressure, never loss: the walk waits for acks while a window is unacknowledged.
    while (unacked >= REMOTE_LIMITS.channelWindowBytes) {
      check();
      const { promise, resolve } = Promise.withResolvers<void>();
      resume = resolve;
      await promise;
    }
  }
  async function checkpoint(): Promise<void> {
    check();
    if (pending.length >= BATCH || options.now() - flushedAt >= PROGRESS_MS) await flush();
  }
  async function match(fd: number, name: Buffer, stat: BigIntStats, path: string): Promise<void> {
    let entry: RemoteFileEntry;
    try { entry = await options.describe(fd, name, stat); } catch { progress.unreadable++; return; }
    pending.push({ path, entry });
    if (++found >= REMOTE_FILE_SEARCH_MATCHES_MAX) { truncated = true; throw new Stopped(); }
  }
  /** The query's bytes inside a regular file, read in pieces; a NUL early on marks it binary. */
  async function contains(fd: number, name: Buffer, stat: BigIntStats): Promise<boolean> {
    let handle: fsp.FileHandle;
    try { handle = await fsp.open(at(fd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { progress.unreadable++; return false; }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return false;
      // Never past the size it had: a file that keeps growing ends the read all the same.
      const size = Number(opened.size);
      const buffer = Buffer.alloc(READ_BYTES + needle.length);
      let carry = 0;
      for (let position = 0; position < size && options.running();) {
        const { bytesRead } = await handle.read(buffer, carry, Math.min(READ_BYTES, size - position), position);
        if (bytesRead === 0) break;
        if (position === 0 && buffer.subarray(0, Math.min(BINARY_PROBE, bytesRead)).includes(0)) return false;
        const window = carry + bytesRead;
        if (buffer.subarray(0, window).includes(needle)) return true;
        // A match may span two reads: the tail shorter than the query goes first in the next one.
        carry = Math.min(needle.length - 1, window);
        buffer.copyWithin(0, window - carry, window);
        position += bytesRead;
      }
      return false;
    } catch { progress.unreadable++; return false; } finally { await handle.close().catch(() => {}); }
  }
  /** A subfolder, pinned without following a link; skipped when it is an ancestor or a pseudo filesystem. */
  async function enter(fd: number, name: Buffer, stat: BigIntStats, path: string, ancestors: Set<string>): Promise<void> {
    let handle: fsp.FileHandle;
    try { handle = await fsp.open(at(fd, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK); } catch { progress.unreadable++; return; }
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) { progress.unreadable++; return; }
      await visit(handle.fd, path, opened, ancestors);
    } finally { await handle.close().catch(() => {}); }
  }
  async function visit(fd: number, path: string, stat: BigIntStats, ancestors: Set<string>): Promise<void> {
    const key = `${stat.dev}:${stat.ino}`;
    if (ancestors.has(key)) return;
    let type: number;
    try { type = Number((await fsp.statfs(`/proc/self/fd/${fd}`)).type); } catch { progress.unreadable++; return; }
    if (PSEUDO.has(type)) return;
    progress.folders++;
    ancestors.add(key);
    try {
      for await (const name of names(fd, 64)) {
        await checkpoint();
        if (!hidden && name[0] === 0x2e) continue;
        let entry: BigIntStats;
        try { entry = await fsp.lstat(at(fd, name), { bigint: true }); } catch { progress.unreadable++; continue; }
        const child = join(path, name.toString('utf8'));
        if (entry.isDirectory()) {
          if (!content && name.toString('utf8').toLowerCase().includes(lower)) await match(fd, name, entry, child);
          await enter(fd, name, entry, child, ancestors);
          continue;
        }
        progress.files++;
        if (content ? entry.isFile() && await contains(fd, name, entry) : name.toString('utf8').toLowerCase().includes(lower)) await match(fd, name, entry, child);
      }
    } catch (error) {
      // A folder that cannot be opened or read counts as unreadable, and the walk goes on.
      if (error instanceof Stopped) throw error;
      progress.unreadable++;
    } finally { ancestors.delete(key); }
  }

  void (async () => {
    let failed = false;
    try {
      await visit(root.fd, root.real, await fsp.stat(`/proc/self/fd/${root.fd}`, { bigint: true }), new Set());
    } catch (error) {
      failed = !(error instanceof Stopped);
    } finally {
      fs.close(root.fd, () => {});
    }
    // A search stopped at the match cap, or that walked everything, completed; one cancelled did not.
    const state = failed ? 'failed' : options.running() ? options.finished() : 'cancelled';
    ended = true;
    if (pending.length > 0) emit({ type: 'results', seq: ++seq, matches: pending, ...progress });
    emit({ type: 'end', seq: ++seq, state, truncated, ...progress });
    live.channel?.end();
  })();

  return {
    open(lastEventId) {
      const after = lastEventId === undefined ? 0
        : typeof lastEventId === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(lastEventId) ? Number(lastEventId) : NaN;
      if (!Number.isSafeInteger(after) || after > seq) throw new RemoteError('remote_invalid_request');
      acknowledge(after);
      live.channel?.end();
      const stream = new RemoteStream<RemoteFileSearchEvent>((send, end) => {
        const own = { send, end };
        live.channel = own;
        for (const frame of frames) send(frame.event, frame.seq);
        if (ended) end();
        return () => { if (live.channel === own) live.channel = null; };
      });
      return stream;
    },
    ack(body) {
      if (!exactObject(body, ['seq']) || !Number.isSafeInteger(body.seq) || (body.seq as number) < 0 || (body.seq as number) > seq) {
        throw new RemoteError('remote_invalid_request');
      }
      acknowledge(body.seq as number);
      return { ok: true };
    },
    wake() { resume?.(); },
  };

  function acknowledge(upTo: number): void {
    while (frames.length > 0 && frames[0]!.seq <= upTo) unacked -= frames.shift()!.bytes;
    if (unacked < REMOTE_LIMITS.channelWindowBytes) resume?.();
  }
}
