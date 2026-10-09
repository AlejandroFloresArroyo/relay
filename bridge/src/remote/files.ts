// The `files` tool (#85, #86, #87, ADR 0006 «Explorador» and «Perfiles de Hermes»): the Server's files
// with the Puente account's permissions, distinct from the files an Agent announces in a Conversación.
// Linux only. Every operation works on folder descriptors pinned through /proc/self/fd, never through a
// shell. Every effect runs inside ProfileWriteGuard.write and nowhere else: it keeps what a profile
// loses and records the operation, then calls `run`, which is synchronous on purpose. From its last
// check to the effect nothing else in the Puente runs, and a revocation is seen by `guard` in that step.
// Long operations (saves, transfers, searches) have op_ IDs, caps, an idle limit, and end at revocation.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REMOTE_ID_PATTERN, REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { RemoteErrorCode, RemoteOperation, RemoteOperationState, ToolAvailability } from '../../../protocol/protocol.ts';
import {
  REMOTE_FILE_OPERATION_IDLE_MS, REMOTE_FILE_SAVES_PER_DEVICE, REMOTE_FILE_SAVES_TOTAL, REMOTE_FILE_SEARCH_QUERY_BYTES, REMOTE_FILE_SEARCHES_PER_DEVICE,
  REMOTE_FILE_SEARCHES_TOTAL, REMOTE_FILE_TRANSFERS_PER_DEVICE, REMOTE_FILE_TRANSFERS_TOTAL, REMOTE_FILES_LIST_MAX,
} from '../../../protocol/remoteFiles.ts';
import type { RemoteFileContentVersion, RemoteFileEntry, RemoteFileSave, RemoteFileType, RemoteFileUpload, RemoteFileVersion } from '../../../protocol/remoteFiles.ts';
import { decodeText, validTextFormat } from '../../../protocol/textCodec.ts';
import { exactObject } from '../changeLog.ts';
import type { ChangeLog } from '../changeLog.ts';
import { names, startSearch } from './fileSearch.ts';
import type { Search } from './fileSearch.ts';
import type { FileWriteContext, RemoteFileSystem } from './ports.ts';
import { createProfileWriteGuard, mountOf } from './profileWriteGuard.ts';
import { RemoteError } from './routes.ts';

/** The `files` contract this build serves. */
export const FILES_CAPABILITY = { version: 1, minAppVersion: 1 } as const;

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
// O_NONBLOCK too: a FIFO where a folder or a file was expected must never wait for a writer.
const FOLDER_FLAGS = O_RDONLY | O_DIRECTORY | O_NONBLOCK;
const EDITABLE = REMOTE_LIMITS.editableTextBytes;

// Fixed codes only: an fs err.message carries paths and reaches neither the client nor the log.
const ERRNO: Record<string, RemoteErrorCode> = {
  ENOENT: 'remote_not_found', ENOTDIR: 'remote_not_found', ELOOP: 'remote_not_found',
  EACCES: 'remote_permission_denied', EPERM: 'remote_permission_denied', EROFS: 'remote_permission_denied',
  EEXIST: 'remote_exists', ENOTEMPTY: 'remote_exists', EISDIR: 'remote_conflict',
  EXDEV: 'remote_cross_device', ENOSPC: 'remote_no_space', EDQUOT: 'remote_no_space',
  EINVAL: 'remote_invalid_request', ENAMETOOLONG: 'remote_invalid_request', EFBIG: 'remote_too_large',
};

/** An fs failure as a fixed remote error. */
function fixed(error: unknown): RemoteError {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  return new RemoteError(Object.hasOwn(ERRNO, code) ? ERRNO[code]! : 'remote_unavailable');
}

/** One fs call; its failure becomes a fixed remote error. `guard` stays outside, so revocation passes through. */
function sys<T>(call: () => T): T {
  try { return call(); } catch (error) { throw fixed(error); }
}

const invalid = (): never => { throw new RemoteError('remote_invalid_request'); };
const conflict = (): never => { throw new RemoteError('remote_conflict'); };
/** #114: what could end a note's line, ASCII controls and the Unicode line breaks (NEL, LS, PS) included. */
const BREAKS_LINE = /[\x00-\x1f\x7f\u0085\u2028\u2029]/;

function validName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !/[/\0]/.test(value) && Buffer.byteLength(value) <= 255;
}

/** Absolute and canonical: no empty, '.' or '..' component and no trailing '/'. */
function canonical(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || Buffer.byteLength(value) > 4096) return invalid();
  if (value !== '/' && !value.slice(1).split('/').every(validName)) return invalid();
  return value;
}

/** A path whose last component is an entry: never the root. */
function entryPath(value: unknown): string {
  const file = canonical(value);
  return file === '/' ? invalid() : file;
}

const decimal = (field: unknown) => typeof field === 'string' && /^\d{1,40}$/.test(field);

function validVersion(value: unknown): value is RemoteFileVersion {
  return exactObject(value, ['dev', 'ino', 'mtimeNs', 'ctimeNs']) && Object.values(value).every(decimal);
}

function validContentVersion(value: unknown): value is RemoteFileContentVersion {
  return exactObject(value, ['dev', 'ino', 'size', 'mtimeNs', 'sha256']) && decimal(value.dev) && decimal(value.ino) && decimal(value.mtimeNs)
    && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= EDITABLE
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
}

const sameObject = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const matches = (stat: BigIntStats, version: RemoteFileVersion) => String(stat.dev) === version.dev && String(stat.ino) === version.ino
  && String(stat.mtimeNs) === version.mtimeNs && String(stat.ctimeNs) === version.ctimeNs;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const contentVersion = (stat: BigIntStats, bytes: Buffer): RemoteFileContentVersion => ({
  dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), sha256: sha256(bytes),
});
const sameContent = (read: Content, version: RemoteFileContentVersion) => {
  const current = contentVersion(read.stat, read.bytes);
  return current.dev === version.dev && current.ino === version.ino && current.size === version.size && current.mtimeNs === version.mtimeNs && current.sha256 === version.sha256;
};

/** An entry of a pinned folder: the kernel resolves the descriptor, then exactly that one name. */
function at(fd: number, name: string | Buffer): string | Buffer {
  return typeof name === 'string' ? `/proc/self/fd/${fd}/${name}` : Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), name]);
}

function join(folder: string, name: string): string {
  return folder === '/' ? `/${name}` : `${folder}/${name}`;
}

function kind(stat: BigIntStats): RemoteFileType {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice()) return 'char_device';
  if (stat.isBlockDevice()) return 'block_device';
  return 'unknown';
}

interface Folder { fd: number; real: string }

/** Where a pinned folder really is now. A folder deleted or moved has no real path that leads back to it. */
function pinned(fd: number): string {
  const real = sys(() => fs.readlinkSync(`/proc/self/fd/${fd}`));
  return sameObject(fs.fstatSync(fd, { bigint: true }), sys(() => fs.lstatSync(real, { bigint: true }))) ? real : conflict();
}

/** Opens a folder following links, as entering them does, and reads where it really is from its descriptor. */
function openFolder(folder: string): Folder {
  const fd = sys(() => fs.openSync(folder, FOLDER_FLAGS));
  try { return { fd, real: pinned(fd) }; } catch (error) { fs.closeSync(fd); throw error; }
}

/** After an await: the folder is still where it was classified. */
function stillAt(folder: Folder): void {
  if (pinned(folder.fd) !== folder.real) conflict();
}

interface Selected { folder: Folder; name: string; real: string; stat: BigIntStats }

/** The entry a client chose, itself and not where a link points, only if it is still what it read. */
function select(file: string, version: RemoteFileVersion): Selected {
  const folder = openFolder(path.dirname(file));
  const name = path.basename(file);
  try {
    const stat = sys(() => fs.lstatSync(at(folder.fd, name), { bigint: true }));
    if (!matches(stat, version)) conflict();
    return { folder, name, real: join(folder.real, name), stat };
  } catch (error) { fs.closeSync(folder.fd); throw error; }
}

/** A file to read or write: a link anywhere in the path, the last one too, is followed to where it really is. */
function resolveFile(file: string): Omit<Selected, 'stat'> {
  const real = sys(() => fs.realpathSync.native(file));
  if (real === '/') invalid();
  const folder = openFolder(path.dirname(real));
  if (folder.real !== path.dirname(real)) { fs.closeSync(folder.fd); conflict(); }
  return { folder, name: path.basename(real), real };
}

interface Content { bytes: Buffer; stat: BigIntStats }

/**
 * A regular file's bytes through its pinned folder: checked by lstat before opening, opened without
 * following a link nor waiting on a FIFO, and checked again by fstat. A file that changes while it
 * is read is no version of it.
 */
function readRegular(fd: number, name: string, tooLarge: RemoteErrorCode): Content {
  const entry = sys(() => fs.lstatSync(at(fd, name), { bigint: true }));
  if (!entry.isFile()) invalid();
  const file = sys(() => fs.openSync(at(fd, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
  try {
    const stat = fs.fstatSync(file, { bigint: true });
    if (!stat.isFile() || !sameObject(stat, entry)) conflict();
    if (stat.size > BigInt(EDITABLE)) throw new RemoteError(tooLarge);
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < bytes.length; length += read) read = sys(() => fs.readSync(file, bytes, length, bytes.length - length, length));
    const after = fs.fstatSync(file, { bigint: true });
    if (length !== Number(stat.size) || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) conflict();
    return { bytes: bytes.subarray(0, length), stat };
  } finally { fs.closeSync(file); }
}

/**
 * The content of an entry inside a profile before it is replaced, moved or deleted: a regular file
 * up to the editable size, or nothing for an empty folder. Anything else is done on the computer.
 * ponytail: the backup is capped at editableTextBytes; a bigger profile file (a database, a log) is
 * remote_profile_protected. Streaming the copy to the state folder lifts it if Relay needs it.
 */
function keepable(selected: Selected, version: RemoteFileVersion): Buffer | null {
  if (selected.stat.isDirectory()) {
    const fd = sys(() => fs.openSync(at(selected.folder.fd, selected.name), FOLDER_FLAGS | O_NOFOLLOW));
    try {
      if (sys(() => fs.readdirSync(`/proc/self/fd/${fd}`)).length > 0) throw new RemoteError('remote_profile_protected');
      return null;
    } finally { fs.closeSync(fd); }
  }
  if (!selected.stat.isFile()) throw new RemoteError('remote_profile_protected');
  const content = readRegular(selected.folder.fd, selected.name, 'remote_profile_protected');
  if (!matches(content.stat, version)) conflict();
  return content.bytes;
}

/** The owner, group and permission bits of the file a new content replaces. */
function adopt(fd: number, like: BigIntStats): void {
  // chown before chmod: it clears the set-ID bits. A group the account cannot give changes identity.
  try { fs.fchownSync(fd, Number(like.uid), Number(like.gid)); } catch { throw new RemoteError('remote_not_replaceable'); }
  sys(() => fs.fchmodSync(fd, Number(like.mode & 0o7777n)));
}

/** Renaming over a file with other links or of another account would change its identity. */
function replaceable(stat: BigIntStats): void {
  if (stat.nlink !== 1n || stat.uid !== BigInt(process.getuid?.() ?? -1)) throw new RemoteError('remote_not_replaceable');
}

/** The new content next to the file it replaces, with its owner, group and permission bits. */
function writeTemporary(folder: Folder, bytes: Buffer, like: BigIntStats): { name: string; stat: BigIntStats } {
  const name = `.relay-save-${randomBytes(12).toString('hex')}`;
  const fd = sys(() => fs.openSync(at(folder.fd, name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600));
  try {
    adopt(fd, like);
    for (let written = 0; written < bytes.length;) written += sys(() => fs.writeSync(fd, bytes, written));
    sys(() => fs.fsyncSync(fd));
    return { name, stat: fs.fstatSync(fd, { bigint: true }) };
  } catch (error) {
    try { fs.unlinkSync(at(folder.fd, name)); } catch {}
    throw error;
  } finally { fs.closeSync(fd); }
}

/** Async, so a link to a slow mount waits in the thread pool and not in the Puente (#85, P3). */
async function describe(fd: number, name: Buffer, stat: BigIntStats): Promise<RemoteFileEntry> {
  const text = name.toString('utf8');
  const entry: RemoteFileEntry = {
    name: text, nameUtf8: Buffer.from(text).equals(name), type: kind(stat), size: Number(stat.size), mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid), gid: Number(stat.gid), mtime: Number(stat.mtimeNs / 1_000_000n),
    version: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) },
  };
  if (stat.isSymbolicLink()) {
    const file = at(fd, name);
    let realPath: string | null = null;
    let type: RemoteFileType | null = null;
    try { realPath = await fsp.realpath(file); type = kind(await fsp.stat(file, { bigint: true })); } catch { realPath = null; type = null; }
    let target: Buffer;
    try { target = await fsp.readlink(file, { encoding: 'buffer' }); } catch (error) { throw fixed(error); }
    entry.link = { target: target.toString('utf8'), realPath, type };
  }
  return entry;
}

/**
 * A folder and everything in it, through descriptors: a subfolder swapped for a link while deleting
 * is never followed (O_NOFOLLOW), links inside lose only themselves, and another mount inside (a disk,
 * a share, a bind of a Hermes profile) is never entered: that is remote_conflict, before any of its content goes.
 * ponytail: synchronous and one descriptor per level: a huge tree blocks the Puente while it goes, and
 * one deeper than the descriptor limit stops half-deleted, as does one with a mount inside: what came
 * before the mount in the listing is already gone. An operation with progress (#87) if it matters.
 */
function removeTree(parent: number, name: string | Buffer, expected: BigIntStats, mount = mountOf(parent)): void {
  let fd: number;
  try { fd = fs.openSync(at(parent, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ELOOP' || code === 'ENOTDIR' ? conflict() : sys(() => { throw error; });
  }
  try {
    if (!sameObject(fs.fstatSync(fd, { bigint: true }), expected) || mountOf(fd) !== mount) conflict();
    for (const child of sys(() => fs.readdirSync(`/proc/self/fd/${fd}`, { encoding: 'buffer' }))) {
      const stat = sys(() => fs.lstatSync(at(fd, child), { bigint: true }));
      if (stat.isDirectory()) removeTree(fd, child, stat, mount);
      else sys(() => fs.unlinkSync(at(fd, child)));
    }
  } finally { fs.closeSync(fd); }
  sys(() => fs.rmdirSync(at(parent, name)));
}

type OperationType = 'save' | 'upload' | 'download' | 'search';

/** A long file operation of one device. `busy` while a request works on it: what it holds waits for that request. */
interface Operation {
  id: string; deviceId: string; type: OperationType; state: RemoteOperationState; busy: boolean; touched: number;
  /** Lets go of what it holds once it no longer runs: memory, descriptors, a temporary file. Idempotent. */
  release(): void;
}
/** A save's bytes wait in memory, at most editableTextBytes each, and never reach the disk unfinished. */
interface Save extends Operation { type: 'save'; size: number; bytes: Buffer; received: number }
/** An upload fills a private temporary file in its destination folder, pinned for the upload's whole life. */
interface Upload extends Operation {
  type: 'upload'; folder: Folder; name: string; temporary: string; fd: number;
  /** The permission bits a new file gets in that folder: 0o666 under the umask. */
  mode: number; size: number | null; received: number;
}
/** A download reads one open descriptor: the file it started on, wherever its name goes. */
interface Download extends Operation { type: 'download'; fd: number; size: number; mtimeNs: bigint }
interface SearchOperation extends Operation { type: 'search'; search: Search }

const EMPTY = Buffer.alloc(0);
// Running operations per device and in all, by what they hold: memory, descriptors and temporary files, walks.
const CAPS: Record<OperationType, { group: string; perDevice: number; total: number }> = {
  save: { group: 'save', perDevice: REMOTE_FILE_SAVES_PER_DEVICE, total: REMOTE_FILE_SAVES_TOTAL },
  upload: { group: 'transfer', perDevice: REMOTE_FILE_TRANSFERS_PER_DEVICE, total: REMOTE_FILE_TRANSFERS_TOTAL },
  download: { group: 'transfer', perDevice: REMOTE_FILE_TRANSFERS_PER_DEVICE, total: REMOTE_FILE_TRANSFERS_TOTAL },
  search: { group: 'search', perDevice: REMOTE_FILE_SEARCHES_PER_DEVICE, total: REMOTE_FILE_SEARCHES_TOTAL },
};
/** A chunk's offset: canonical decimal. */
const offsetOf = (value: string) => /^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : NaN;
const fsync = promisify(fs.fsync);

/** A finished temporary file under its new name, never over an entry that appeared meanwhile. */
function publish(folder: Folder, temporary: string, name: string): void {
  try { fs.linkSync(at(folder.fd, temporary), at(folder.fd, name)); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new RemoteError('remote_confirmation_required');
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw fixed(error);
    // ponytail: a filesystem without hard links (FAT, some FUSE) gets move's check and rename, with its
    // window: an entry created at the name in that instant is replaced. renameat2(RENAME_NOREPLACE) closes it.
    try { fs.lstatSync(at(folder.fd, name)); } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw fixed(missing);
      return sys(() => fs.renameSync(at(folder.fd, temporary), at(folder.fd, name)));
    }
    throw new RemoteError('remote_confirmation_required');
  }
  try { fs.unlinkSync(at(folder.fd, temporary)); } catch {}
}

/**
 * `stateDirectory` holds devices.json and changes.jsonl; it and `<home>/.config/relay` are never written.
 * Backups of profile writes go there too, as remote-file-<record id>.previous.
 */
export function createRemoteFileSystem(options: { home: string; hermesHome: string; stateDirectory: string; changeLog: ChangeLog; now?: () => number }): RemoteFileSystem {
  const now = options.now ?? Date.now;
  const profiles = createProfileWriteGuard({
    hermesHome: options.hermesHome, bridgeDirectories: [options.stateDirectory, path.join(options.home, '.config', 'relay')],
    stateDirectory: options.stateDirectory, changeLog: options.changeLog, now,
  });
  const operations = new Map<string, Operation>();

  /** Stops a running operation; what it holds goes now, or when the request working on it ends. */
  function end(operation: Operation, state: Exclude<RemoteOperationState, 'running'>): void {
    if (operation.state !== 'running') return;
    operation.state = state;
    if (!operation.busy) operation.release();
  }
  function settle(operation: Operation): void {
    operation.busy = false;
    operation.touched = now();
    if (operation.state !== 'running') operation.release();
  }
  /** An operation untouched for REMOTE_FILE_OPERATION_IDLE_MS is cancelled and forgotten. */
  function sweep(): void {
    const time = now();
    for (const [id, operation] of operations) {
      if (operation.busy || time - operation.touched <= REMOTE_FILE_OPERATION_IDLE_MS) continue;
      end(operation, 'cancelled');
      operations.delete(id);
    }
  }
  // Not only at the next start: an abandoned upload's temporary file goes within a minute of its idle time.
  setInterval(sweep, 60_000).unref();
  /** A new operation within its caps, checked against revocation right before it is registered. */
  function admit<T extends Operation>(type: T['type'], context: FileWriteContext, make: (base: Operation) => T): T {
    sweep();
    const { group, perDevice, total } = CAPS[type];
    const running = [...operations.values()].filter((operation) => operation.state === 'running' && CAPS[operation.type].group === group);
    if (running.length >= total || running.filter((operation) => operation.deviceId === context.deviceId).length >= perDevice) {
      throw new RemoteError('remote_limit_reached');
    }
    context.guard();
    const operation = make({
      id: `op_${randomBytes(16).toString('base64url')}`, deviceId: context.deviceId, type, state: 'running', busy: false, touched: now(), release() {},
    });
    operations.set(operation.id, operation);
    return operation;
  }
  /** Only this device's operations exist for it; an ID of another one, or of another kind, is answered like a missing one. */
  function own<T extends Operation>(id: string, context: FileWriteContext, type?: T['type']): T {
    const operation = new RegExp(REMOTE_ID_PATTERN).test(id) && id.startsWith('op_') ? operations.get(id) : undefined;
    if (!operation || operation.deviceId !== context.deviceId || (type !== undefined && operation.type !== type)) throw new RemoteError('remote_not_found');
    return operation as T;
  }
  /** Running, and no other request works on it. */
  function ready(operation: Operation): void {
    if (operation.state !== 'running') throw new RemoteError('remote_ended');
    if (operation.busy) conflict();
  }
  const view = (save: Save): RemoteFileSave => ({ id: save.id, size: save.size, received: save.received });
  const uploaded = (upload: Upload): RemoteFileUpload => ({ id: upload.id, size: upload.size, received: upload.received });

  return {
    async availability(): Promise<ToolAvailability> {
      return process.platform === 'linux' && fs.existsSync('/proc/self/fd') ? { state: 'available' } : { state: 'unavailable', reason: 'unsupported_platform' };
    },

    // Async and in pieces (review of #85, P3): a folder of millions of names, or a link to a hung
    // mount, waits in the thread pool while the Puente keeps answering, and memory stays bounded.
    async list(body) {
      if (!exactObject(body, [], ['path', 'hidden']) || (Object.hasOwn(body, 'hidden') && typeof body.hidden !== 'boolean')) return invalid();
      const requested = Object.hasOwn(body, 'path') ? canonical(body.path) : options.home;
      const folder = openFolder(requested);
      try {
        // Only the first REMOTE_FILES_LIST_MAX names in byte order are kept, however many there are.
        let kept: Buffer[] = [];
        let total = 0;
        try {
          for await (const name of names(folder.fd, 256)) {
            if (body.hidden !== true && name[0] === 0x2e) continue;
            total++;
            kept.push(name);
            if (kept.length >= 2 * REMOTE_FILES_LIST_MAX) kept = kept.sort(Buffer.compare).slice(0, REMOTE_FILES_LIST_MAX);
          }
        } catch (error) { throw fixed(error); }
        kept = kept.sort(Buffer.compare).slice(0, REMOTE_FILES_LIST_MAX);
        const entries: RemoteFileEntry[] = [];
        for (let index = 0; index < kept.length; index += 64) {
          const batch = await Promise.all(kept.slice(index, index + 64).map(async (name) => {
            let stat: BigIntStats;
            try { stat = await fsp.lstat(at(folder.fd, name), { bigint: true }); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // deleted while listing
              throw fixed(error);
            }
            return describe(folder.fd, name, stat);
          }));
          for (const entry of batch) if (entry) entries.push(entry);
        }
        // A new entry in this folder is where a create or an upload would land.
        return { path: requested, realPath: folder.real, entries, truncated: total > REMOTE_FILES_LIST_MAX, protection: profiles.zone(join(folder.real, 'relay-entry')) };
      } finally { fs.closeSync(folder.fd); }
    },

    read(body) {
      if (!exactObject(body, ['path'])) return invalid();
      const file = entryPath(body.path);
      const target = resolveFile(file);
      try {
        const content = readRegular(target.folder.fd, target.name, 'remote_too_large');
        return {
          path: file, realPath: target.real, version: contentVersion(content.stat, content.bytes), bytes: content.bytes.toString('base64'), protection: profiles.zone(target.real),
        };
      } finally { fs.closeSync(target.folder.fd); }
    },

    // #114: a file attached to a Turno by its path. Archivos' read rules, without reading a byte:
    // links followed, a regular file the account can open, never Puente data. check() throws when
    // it cannot classify; zone() would answer null there and let the file through.
    reference(body) {
      if (!exactObject(body, ['path'])) return invalid();
      const file = entryPath(body.path);
      if (BREAKS_LINE.test(file)) invalid(); // a note is one line
      const target = resolveFile(file);
      try {
        // The note carries the real path: a clean link to a multi-line name must not add lines either.
        if (BREAKS_LINE.test(target.real)) invalid();
        const entry = sys(() => fs.lstatSync(at(target.folder.fd, target.name), { bigint: true }));
        if (!entry.isFile()) invalid();
        const fd = sys(() => fs.openSync(at(target.folder.fd, target.name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
        try {
          const stat = fs.fstatSync(fd, { bigint: true });
          if (!stat.isFile() || !sameObject(stat, entry)) conflict();
        } finally { fs.closeSync(fd); }
        profiles.check([target.real]);
        return { path: file, realPath: target.real };
      } finally { fs.closeSync(target.folder.fd); }
    },

    async create(body, context) {
      if (!exactObject(body, ['directory', 'name', 'type']) || !validName(body.name) || (body.type !== 'file' && body.type !== 'directory')) return invalid();
      const { name, type } = body;
      const folder = openFolder(canonical(body.directory));
      try {
        const target = at(folder.fd, name);
        await profiles.write({
          action: 'create', actor: context.actor, guard: context.guard, paths: [join(folder.real, name)], previous: () => null,
          run: () => {
            stillAt(folder);
            context.guard();
            // Neither follows nor replaces anything: an existing entry, even a dangling link, is remote_exists.
            if (type === 'directory') sys(() => fs.mkdirSync(target, 0o777));
            else fs.closeSync(sys(() => fs.openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o666)));
          },
        });
        return await describe(folder.fd, Buffer.from(name), sys(() => fs.lstatSync(target, { bigint: true })));
      } finally { fs.closeSync(folder.fd); }
    },

    async move(body, context) {
      if (!exactObject(body, ['path', 'version', 'directory', 'name']) || !validVersion(body.version) || !validName(body.name)) return invalid();
      const { version, name } = body;
      const file = entryPath(body.path);
      const directory = canonical(body.directory);
      const source = select(file, version);
      try {
        const destination = openFolder(directory);
        try {
          const target = at(destination.fd, name);
          const real = join(destination.real, name);
          const free = () => {
            try { fs.lstatSync(target); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
              sys(() => { throw error; });
            }
            throw new RemoteError('remote_exists');
          };
          free();
          if (real.startsWith(`${source.real}/`)) invalid();
          await profiles.write({
            action: destination.real === source.folder.real ? 'rename' : 'move', actor: context.actor, guard: context.guard,
            paths: [source.real, real], replaced: source.real, previous: () => keepable(source, version),
            run: () => {
              stillAt(source.folder);
              stillAt(destination);
              if (!matches(sys(() => fs.lstatSync(at(source.folder.fd, source.name), { bigint: true })), version)) conflict();
              free();
              context.guard();
              // ponytail: Node has no renameat2(RENAME_NOREPLACE). An entry created at the destination in
              // the microseconds since the check above is replaced if it is a file or an empty folder.
              // A native helper with RENAME_NOREPLACE closes that window.
              sys(() => fs.renameSync(at(source.folder.fd, source.name), target));
            },
          });
          return await describe(destination.fd, Buffer.from(name), sys(() => fs.lstatSync(target, { bigint: true })));
        } finally { fs.closeSync(destination.fd); }
      } finally { fs.closeSync(source.folder.fd); }
    },

    async delete(body, context) {
      if (!exactObject(body, ['path', 'version'], ['confirm']) || !validVersion(body.version) || (Object.hasOwn(body, 'confirm') && body.confirm !== true)) return invalid();
      const { version, confirm } = body;
      const entry = select(entryPath(body.path), version);
      try {
        await profiles.write({
          action: 'delete', actor: context.actor, guard: context.guard, paths: [entry.real], replaced: entry.real,
          // A stale selection or a protected profile is said first: confirming would not help.
          before: () => { if (confirm !== true) throw new RemoteError('remote_confirmation_required'); },
          previous: () => keepable(entry, version),
          run: () => {
            stillAt(entry.folder);
            if (!matches(sys(() => fs.lstatSync(at(entry.folder.fd, entry.name), { bigint: true })), version)) conflict();
            context.guard();
            if (entry.stat.isDirectory()) removeTree(entry.folder.fd, entry.name, entry.stat);
            else sys(() => fs.unlinkSync(at(entry.folder.fd, entry.name)));
          },
        });
        return { ok: true };
      } finally { fs.closeSync(entry.folder.fd); }
    },

    startSave(body, context) {
      if (!exactObject(body, ['size']) || !Number.isSafeInteger(body.size) || (body.size as number) < 0) return invalid();
      const size = body.size as number;
      if (size > EDITABLE) throw new RemoteError('remote_too_large');
      // Memory stays under the caps times editableTextBytes.
      return view(admit('save', context, (base) => {
        const save: Save = { ...base, type: 'save', size, bytes: Buffer.alloc(size), received: 0, release: () => { save.bytes = EMPTY; } };
        return save;
      }));
    },

    saveChunk(id, offset, bytes, context) {
      const save = own<Save>(id, context, 'save');
      ready(save);
      // At or before what arrived: a retried chunk lands again, a gap is refused.
      const start = offsetOf(offset);
      if (!Number.isSafeInteger(start) || start > save.received) invalid();
      if (start + bytes.length > save.size) throw new RemoteError('remote_too_large');
      context.guard();
      bytes.copy(save.bytes, start);
      save.received = Math.max(save.received, start + bytes.length);
      save.touched = now();
      return view(save);
    },

    async commitSave(id, body, context) {
      const save = own<Save>(id, context, 'save');
      ready(save);
      if (!exactObject(body, ['path', 'version', 'format']) || !validContentVersion(body.version) || !validTextFormat(body.format)) return invalid();
      const { version, format } = body;
      // Every byte, and text in the format it says: the Puente never writes what the editor could not read back.
      if (save.received !== save.size || decodeText(save.bytes, format) === null) invalid();
      const file = entryPath(body.path);
      const bytes = save.bytes;
      save.busy = true;
      try {
        const target = resolveFile(file);
        try {
          const current = readRegular(target.folder.fd, target.name, 'remote_conflict');
          if (!sameContent(current, version)) conflict();
          replaceable(current.stat);
          let temporary: string | null = null;
          let renamed = false;
          try {
            const written = await profiles.write({
              action: 'write', actor: context.actor, guard: context.guard, paths: [target.real], replaced: target.real,
              // Read and compared with the version above, so the backup is exactly what the rename replaces.
              previous: () => current.bytes,
              run: () => {
                stillAt(target.folder);
                // Only now, classified, kept and recorded: nothing reaches a protected folder or a profile before that.
                const created = writeTemporary(target.folder, bytes, current.stat);
                temporary = created.name;
                // Compare-and-save next to the commit: a change since the editor read it, or since the check above, is a conflict.
                if (!sameContent(readRegular(target.folder.fd, target.name, 'remote_conflict'), version)) conflict();
                if (save.state !== 'running') throw new RemoteError('remote_cancelled');
                context.guard();
                // Writing the temporary took time: the folder must still be where it was classified (#86 review NH2).
                stillAt(target.folder);
                sys(() => fs.renameSync(at(target.folder.fd, created.name), at(target.folder.fd, target.name)));
                renamed = true;
                save.state = 'completed';
                return created.stat;
              },
            });
            // The rename happened: a folder that cannot be synced makes it less durable, not undone.
            try { fs.fsyncSync(target.folder.fd); } catch {}
            return { path: file, realPath: target.real, version: contentVersion(written, bytes) };
          } finally {
            if (!renamed && temporary !== null) try { fs.unlinkSync(at(target.folder.fd, temporary)); } catch {}
          }
        } finally { fs.closeSync(target.folder.fd); }
      } finally { settle(save); }
    },

    startUpload(body, context) {
      if (!exactObject(body, ['directory', 'name'], ['size']) || !validName(body.name)
        || (Object.hasOwn(body, 'size') && (!Number.isSafeInteger(body.size) || (body.size as number) < 0))) return invalid();
      const name = body.name;
      const size = Object.hasOwn(body, 'size') ? body.size as number : null;
      const folder = openFolder(canonical(body.directory));
      let upload: Upload;
      try {
        // The Puente's state, and what holds a profile, are refused before a byte lands there.
        profiles.check([join(folder.real, name)]);
        if (size !== null) {
          const space = sys(() => fs.statfsSync(`/proc/self/fd/${folder.fd}`, { bigint: true }));
          if (space.bavail * space.bsize < BigInt(size)) throw new RemoteError('remote_no_space');
        }
        upload = admit('upload', context, (base) => {
          const temporary = `.relay-upload-${randomBytes(12).toString('hex')}`;
          const fd = sys(() => fs.openSync(at(folder.fd, temporary), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666));
          try {
            // The mode a new file gets in this folder, kept for the commit; private while it fills.
            const mode = fs.fstatSync(fd).mode & 0o7777;
            sys(() => fs.fchmodSync(fd, 0o600));
            let released = false;
            return {
              ...base, type: 'upload', folder, name, temporary, fd, mode, size, received: 0,
              release: () => {
                if (released) return;
                released = true;
                fs.closeSync(fd);
                // Gone already once published.
                try { fs.unlinkSync(at(folder.fd, temporary)); } catch {}
                fs.closeSync(folder.fd);
              },
            };
          } catch (error) {
            fs.closeSync(fd);
            try { fs.unlinkSync(at(folder.fd, temporary)); } catch {}
            throw error;
          }
        });
      } catch (error) { fs.closeSync(folder.fd); throw error; }
      return uploaded(upload);
    },

    uploadChunk(id, offset, bytes, context) {
      const upload = own<Upload>(id, context, 'upload');
      ready(upload);
      const start = offsetOf(offset);
      if (!Number.isSafeInteger(start) || start > upload.received) invalid();
      if (upload.size !== null && start + bytes.length > upload.size) throw new RemoteError('remote_too_large');
      context.guard();
      try {
        for (let written = 0; written < bytes.length;) written += fs.writeSync(upload.fd, bytes, written, bytes.length - written, start + written);
      } catch (error) {
        // A full or failing disk ends the upload and its temporary file: the client starts again from byte 0.
        end(upload, 'failed');
        throw fixed(error);
      }
      upload.received = Math.max(upload.received, start + bytes.length);
      upload.touched = now();
      return uploaded(upload);
    },

    async commitUpload(id, body, context) {
      const upload = own<Upload>(id, context, 'upload');
      ready(upload);
      if (!exactObject(body, [], ['replace']) || (Object.hasOwn(body, 'replace') && !validVersion(body.replace))) return invalid();
      const replace = body.replace as RemoteFileVersion | undefined;
      if (upload.size !== null && upload.received !== upload.size) invalid();
      const { folder, name } = upload;
      /** The entry at the name is still what the person saw: none, or exactly the version they confirmed overwriting. */
      const seen = (): BigIntStats | null => {
        let stat: BigIntStats;
        try { stat = fs.lstatSync(at(folder.fd, name), { bigint: true }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fixed(error);
          return replace ? conflict() : null;
        }
        if (!replace) throw new RemoteError('remote_confirmation_required');
        return matches(stat, replace) ? stat : conflict();
      };
      upload.busy = true;
      let linked: Folder | null = null;
      try {
        try { await fsync(upload.fd); } catch (error) { end(upload, 'failed'); throw fixed(error); }
        stillAt(folder);
        const entry = seen();
        // A link is written where it really points and stays a link.
        let target = { folder, name, real: join(folder.real, name) };
        let current: BigIntStats | null = null;
        if (entry) {
          if (entry.isSymbolicLink()) {
            const resolved = resolveFile(target.real);
            linked = resolved.folder;
            target = resolved;
          }
          current = sys(() => fs.lstatSync(at(target.folder.fd, target.name), { bigint: true }));
          if (!current.isFile()) throw new RemoteError('remote_exists');
          replaceable(current);
          adopt(upload.fd, current);
        } else sys(() => fs.fchmodSync(upload.fd, upload.mode));
        const unchanged = (stat: BigIntStats) => sameObject(stat, current!) && stat.size === current!.size && stat.mtimeNs === current!.mtimeNs;
        await profiles.write({
          action: entry ? 'write' : 'create', actor: context.actor, guard: context.guard, paths: [target.real], replaced: entry ? target.real : undefined,
          previous: () => {
            const content = readRegular(target.folder.fd, target.name, 'remote_profile_protected');
            return unchanged(content.stat) ? content.bytes : conflict();
          },
          run: () => {
            stillAt(folder);
            if (linked) stillAt(linked);
            seen();
            if (current && !unchanged(sys(() => fs.lstatSync(at(target.folder.fd, target.name), { bigint: true })))) conflict();
            if (upload.state !== 'running') throw new RemoteError('remote_cancelled');
            context.guard();
            if (current) sys(() => fs.renameSync(at(folder.fd, upload.temporary), at(target.folder.fd, target.name)));
            else publish(folder, upload.temporary, name);
            upload.state = 'completed';
          },
        });
        // Published: a folder that cannot be synced makes it less durable, not undone.
        try { fs.fsyncSync(target.folder.fd); } catch {}
        return await describe(folder.fd, Buffer.from(name), sys(() => fs.lstatSync(at(folder.fd, name), { bigint: true })));
      } finally {
        if (linked) fs.closeSync(linked.fd);
        settle(upload);
      }
    },

    startDownload(body, context) {
      if (!exactObject(body, ['path'])) return invalid();
      const file = entryPath(body.path);
      const target = resolveFile(file);
      try {
        const entry = sys(() => fs.lstatSync(at(target.folder.fd, target.name), { bigint: true }));
        if (!entry.isFile()) invalid();
        const download = admit('download', context, (base) => {
          // Never a link, never waiting on a FIFO, and the same regular file the name showed.
          const fd = sys(() => fs.openSync(at(target.folder.fd, target.name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
          const stat = fs.fstatSync(fd, { bigint: true });
          if (!stat.isFile() || !sameObject(stat, entry)) { fs.closeSync(fd); conflict(); }
          let released = false;
          const opened: Download = {
            ...base, type: 'download', fd, size: Number(stat.size), mtimeNs: stat.mtimeNs,
            release: () => { if (!released) { released = true; fs.closeSync(fd); } },
          };
          return opened;
        });
        const stat = fs.fstatSync(download.fd, { bigint: true });
        if (download.size === 0) end(download, 'completed');
        return {
          id: download.id, path: file, realPath: target.real, size: download.size,
          version: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) },
        };
      } finally { fs.closeSync(target.folder.fd); }
    },

    downloadChunk(id, offset, context) {
      const download = own<Download>(id, context, 'download');
      ready(download);
      const start = offsetOf(offset);
      if (!Number.isSafeInteger(start) || start >= download.size) invalid();
      context.guard();
      const bytes = Buffer.alloc(Math.min(REMOTE_LIMITS.transferChunkBytes, download.size - start));
      let length = 0;
      let after: BigIntStats;
      try {
        for (let read = 1; read > 0 && length < bytes.length; length += read) read = fs.readSync(download.fd, bytes, length, bytes.length - length, start + length);
        after = fs.fstatSync(download.fd, { bigint: true });
      } catch (error) { end(download, 'failed'); throw fixed(error); }
      // A file that changes while it downloads has no version to arrive whole: the download is over.
      if (length !== bytes.length || after.size !== BigInt(download.size) || after.mtimeNs !== download.mtimeNs) { end(download, 'failed'); conflict(); }
      // Complete only once the chunk that ends at the size was served.
      if (start + length === download.size) end(download, 'completed');
      download.touched = now();
      return bytes;
    },

    startSearch(body, context) {
      if (!exactObject(body, ['path', 'query'], ['content', 'hidden']) || typeof body.query !== 'string' || body.query === ''
        || body.query.includes('\0') || Buffer.byteLength(body.query) > REMOTE_FILE_SEARCH_QUERY_BYTES
        || (Object.hasOwn(body, 'content') && body.content !== true) || (Object.hasOwn(body, 'hidden') && typeof body.hidden !== 'boolean')) return invalid();
      const query = body.query;
      const content = body.content === true;
      // A name never holds a '/'.
      if (!content && query.includes('/')) invalid();
      const root = openFolder(canonical(body.path));
      let operation: SearchOperation;
      try {
        operation = admit('search', context, (base) => {
          // The walk owns the root descriptor from here on and closes it when it ends.
          const search = startSearch({
            root, query, content, hidden: body.hidden === true, describe, now,
            running: () => operation.state === 'running',
            finished: () => { operation.state = 'completed'; return 'completed'; },
          });
          return { ...base, type: 'search', search, release: () => search.wake() };
        });
      } catch (error) { fs.closeSync(root.fd); throw error; }
      return { id: operation.id, state: operation.state };
    },

    events(id, lastEventId, context) {
      const operation = own<SearchOperation>(id, context, 'search');
      operation.touched = now();
      return operation.search.open(lastEventId);
    },

    ack(id, body, context) {
      const operation = own<SearchOperation>(id, context, 'search');
      operation.touched = now();
      return operation.search.ack(body);
    },

    cancel(id, context): RemoteOperation {
      const operation = own(id, context);
      context.guard();
      // What really happened: an operation that finished first stays completed (or failed).
      end(operation, 'cancelled');
      operation.touched = now();
      return { id: operation.id, state: operation.state };
    },

    retain(active) {
      for (const [id, operation] of operations) {
        if (active.has(operation.deviceId)) continue;
        // A revoked device's transfers end now and their temporary files go; a busy one lets go when its request ends.
        end(operation, 'cancelled');
        if (!operation.busy) operations.delete(id);
      }
    },
  };
}
