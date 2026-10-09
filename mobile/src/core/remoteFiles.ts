// The explorer and the editor of the `files` tool on the app's side (#88, protocol/remoteFiles.ts).
// What the Puente answers is checked here before it reaches a screen or a request path: a listing
// with one entry the app cannot read is refused whole, never shown with entries missing. Deleting
// always carries its confirmation: the screen calls `remove` only after the person confirmed.
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type {
  RemoteFileContentVersion, RemoteFileEntry, RemoteFileProtection, RemoteFileSaved, RemoteFileType, RemoteFileVersion,
} from '../../../protocol/remoteFiles.ts';
import type { TextFormat } from '../../../protocol/textCodec.ts';
import { RemoteFailure, type RemoteClient } from './remoteClient.ts';
import { operationId, release } from './remoteTransfers.ts';

export interface FolderListing { path: string; realPath: string; entries: RemoteFileEntry[]; truncated: boolean; protection: RemoteFileProtection }
export interface OpenedFile { path: string; realPath: string; version: RemoteFileContentVersion; bytes: Uint8Array; protection: RemoteFileProtection }

export interface FilesApi {
  /** null: the Puente account's home folder. */
  list(path: string | null, hidden: boolean): Promise<FolderListing>;
  create(directory: string, name: string, type: 'file' | 'directory'): Promise<RemoteFileEntry>;
  /** A rename when `directory` is the entry's own folder. */
  move(path: string, version: RemoteFileVersion, directory: string, name: string): Promise<RemoteFileEntry>;
  /** Only after the person confirmed: a folder goes with its content, a link loses only the link. */
  remove(path: string, version: RemoteFileVersion): Promise<void>;
  read(path: string): Promise<OpenedFile>;
  /** null: saved, but its answer was lost; read the file again for its version. */
  save(path: string, version: RemoteFileContentVersion, bytes: Uint8Array, format: TextFormat): Promise<RemoteFileSaved | null>;
}

const TYPES: Record<RemoteFileType, true> = { file: true, directory: true, symlink: true, fifo: true, socket: true, char_device: true, block_device: true, unknown: true };
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const unexpected = () => new RemoteFailure('unexpected', { status: 200 });
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const decimal = (value: unknown) => typeof value === 'string' && DECIMAL.test(value);
const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/');
const type = (value: unknown): value is RemoteFileType => typeof value === 'string' && Object.hasOwn(TYPES, value);

function protection(value: unknown): RemoteFileProtection {
  return value === 'profile' || value === 'bridge' ? value : null;
}

function version(value: unknown): RemoteFileVersion {
  if (!plain(value) || !decimal(value.dev) || !decimal(value.ino) || !decimal(value.mtimeNs) || !decimal(value.ctimeNs)) throw unexpected();
  return { dev: value.dev as string, ino: value.ino as string, mtimeNs: value.mtimeNs as string, ctimeNs: value.ctimeNs as string };
}

function contentVersion(value: unknown): RemoteFileContentVersion {
  if (!plain(value) || !decimal(value.dev) || !decimal(value.ino) || !count(value.size) || !decimal(value.mtimeNs)
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw unexpected();
  return { dev: value.dev as string, ino: value.ino as string, size: value.size, mtimeNs: value.mtimeNs as string, sha256: value.sha256 };
}

function entry(value: unknown): RemoteFileEntry {
  if (!plain(value) || typeof value.name !== 'string' || typeof value.nameUtf8 !== 'boolean' || !type(value.type) || !count(value.size)
    || !count(value.mode) || !count(value.uid) || !count(value.gid) || !Number.isSafeInteger(value.mtime)) throw unexpected();
  const read: RemoteFileEntry = {
    name: value.name, nameUtf8: value.nameUtf8, type: value.type, size: value.size, mode: value.mode, uid: value.uid, gid: value.gid,
    mtime: value.mtime as number, version: version(value.version),
  };
  if (value.type !== 'symlink') return read;
  const link = value.link;
  if (!plain(link) || typeof link.target !== 'string' || !(link.realPath === null || absolute(link.realPath)) || !(link.type === null || type(link.type))) throw unexpected();
  return { ...read, link: { target: link.target, realPath: link.realPath, type: link.type } };
}

function saved(value: unknown): RemoteFileSaved {
  if (!plain(value) || !absolute(value.path) || !absolute(value.realPath)) throw unexpected();
  return { path: value.path, realPath: value.realPath, version: contentVersion(value.version) };
}

/** Base64 to bytes in one pass, without Buffer: a 5 MiB text never builds an intermediate array. */
function base64(text: string): Uint8Array {
  let binary: string;
  try { binary = atob(text); } catch { throw unexpected(); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Built from a function that gives a client right before each request. */
export function filesApi(client: () => RemoteClient): FilesApi {
  return {
    async list(path, hidden) {
      const body = await client().request('POST', '/v1/remote/files/list', path === null ? { hidden } : { path, hidden });
      if (!plain(body) || !absolute(body.path) || !absolute(body.realPath) || !Array.isArray(body.entries) || typeof body.truncated !== 'boolean') throw unexpected();
      return { path: body.path, realPath: body.realPath, entries: body.entries.map(entry), truncated: body.truncated, protection: protection(body.protection) };
    },
    create: async (directory, name, kind) => entry(await client().request('POST', '/v1/remote/files/create', { directory, name, type: kind })),
    move: async (path, current, directory, name) => entry(await client().request('POST', '/v1/remote/files/move', { path, version: current, directory, name })),
    async remove(path, current) { await client().request('POST', '/v1/remote/files/delete', { path, version: current, confirm: true }); },
    async read(path) {
      const body = await client().request('POST', '/v1/remote/files/read', { path });
      if (!plain(body) || !absolute(body.path) || !absolute(body.realPath) || typeof body.bytes !== 'string') throw unexpected();
      const read = contentVersion(body.version);
      const bytes = base64(body.bytes);
      if (bytes.length !== read.size) throw unexpected();
      return { path: body.path, realPath: body.realPath, version: read, bytes, protection: protection(body.protection) };
    },
    async save(path, read, bytes, format) {
      let id: string | null = null;
      try {
        id = operationId(await client().request('POST', '/v1/remote/files/saves', { size: bytes.length }));
        const signal = new AbortController().signal;
        for (let offset = 0; offset < bytes.length; offset += REMOTE_LIMITS.transferChunkBytes) {
          await client().chunk('PUT', `/v1/remote/files/saves/${id}/${offset}`, bytes.subarray(offset, offset + REMOTE_LIMITS.transferChunkBytes), signal);
        }
        return saved(await client().request('POST', `/v1/remote/files/saves/${id}/commit`, { path, version: read, format }));
      } catch (error) {
        // A refused commit leaves the save open: release it. Overwriting after a conflict is a new save.
        if (await release(client, id) === 'completed') return null;
        throw error;
      }
    },
  };
}

/** `name` inside `directory`, both absolute and canonical. */
export function childPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

/** The folder that holds `path`; null for the root. */
export function parentPath(path: string): string | null {
  if (path === '/') return null;
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** Why `name` cannot be a new name, or null when it is one valid path component. */
export function nameProblem(name: string): string | null {
  if (name === '') return 'Escribe un nombre.';
  if (name === '.' || name === '..') return 'Ese nombre no es válido.';
  if (name.includes('/') || name.includes('\0')) return 'El nombre no puede llevar «/».';
  if (new TextEncoder().encode(name).length > 255) return 'El nombre es demasiado largo.';
  return null;
}

const LETTER: Partial<Record<RemoteFileType, string>> = { directory: 'd', symlink: 'l', fifo: 'p', socket: 's', char_device: 'c', block_device: 'b' };

/** «drwxr-xr-x», as `ls -l` shows it, set-ID and sticky bits included. */
export function permissions(mode: number, kind: RemoteFileType): string {
  const triplet = (bits: number, special: boolean, mark: string) =>
    `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${special ? (bits & 1 ? mark : mark.toUpperCase()) : bits & 1 ? 'x' : '-'}`;
  return (LETTER[kind] ?? '-') + triplet(mode >> 6, (mode & 0o4000) !== 0, 's') + triplet(mode >> 3, (mode & 0o2000) !== 0, 's') + triplet(mode, (mode & 0o1000) !== 0, 't');
}
