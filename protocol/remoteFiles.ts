// The `files` remote tool: the Server's file explorer (#85, ADR 0006 «Explorador»), distinct from
// the files an Agent announces in a Conversación. Paths travel only in JSON bodies, never in the URL:
// every route is a POST under /v1/remote/files/ with X-Relay-Capability: files/<v>, except the PUT
// of a save's bytes. Types and constants only.
import type { TextFormat } from './textCodec.ts';

/** The entry itself: a symbolic link is 'symlink', whatever it points to. */
export type RemoteFileType = 'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'char_device' | 'block_device' | 'unknown';

/**
 * What a client read of an entry. Operations send it back and the Puente compares it right before the
 * effect: anything else answers remote_conflict. Device, inode and nanosecond times exceed 2^53, so
 * they travel as decimal strings (review N4).
 */
export interface RemoteFileVersion { dev: string; ino: string; mtimeNs: string; ctimeNs: string }

export interface RemoteFileEntry {
  /** One path component. Not UTF-8 on disk: shown with U+FFFD, `nameUtf8: false`, and Relay cannot address it. */
  name: string;
  nameUtf8: boolean;
  type: RemoteFileType;
  size: number;
  /** Permission bits, `mode & 0o7777`. */
  mode: number;
  uid: number;
  gid: number;
  /** Unix milliseconds, for display only; `version` carries the exact value. */
  mtime: number;
  version: RemoteFileVersion;
  /** Only for 'symlink'. `realPath` and `type` are null when the link is broken or unreadable. */
  link?: { target: string; realPath: string | null; type: RemoteFileType | null };
}

// Paths are absolute and canonical: no empty, '.' or '..' component, no trailing '/'. A symbolic link
// inside a path is entered and the operation acts on its destination; the last component of a delete
// or a move is the entry itself, so deleting a link removes the link and never its destination.

/** POST /v1/remote/files/list. No `path`: the Puente account's home. `hidden` lists dot entries. */
export interface RemoteFileListRequest { path?: string; hidden?: boolean }
/**
 * Where a write in the listed folder (or to the read file) lands, by its real path: inside a Hermes
 * profile ('profile': the Puente keeps the previous version and records the change), in the Puente's
 * own state ('bridge': never written from Relay), or neither (null). Shown to the person; the Puente
 * classifies every write again on its own.
 */
export type RemoteFileProtection = 'profile' | 'bridge' | null;
/** Entries in byte order of their names, at most REMOTE_FILES_LIST_MAX; `truncated` says more exist. */
export interface RemoteFileList { path: string; realPath: string; entries: RemoteFileEntry[]; truncated: boolean; protection: RemoteFileProtection }
export const REMOTE_FILES_LIST_MAX = 5000;

/** POST /v1/remote/files/create: never replaces anything (remote_exists). Answers the new entry. */
export interface RemoteFileCreateRequest { directory: string; name: string; type: 'file' | 'directory' }
/** POST /v1/remote/files/move: a rename when `directory` is the entry's own. Never replaces (remote_exists). */
export interface RemoteFileMoveRequest { path: string; version: RemoteFileVersion; directory: string; name: string }
/** POST /v1/remote/files/delete: a directory goes with its whole content. Without `confirm`, remote_confirmation_required. */
export interface RemoteFileDeleteRequest { path: string; version: RemoteFileVersion; confirm?: true }

// The editor (#86). A text of at most REMOTE_LIMITS.editableTextBytes is read whole and saved through
// chunks, never in a JSON body: open a save, send its bytes, commit with the version read. A link is
// read and written where it really is, never replaced. Writes inside a Hermes profile keep the
// previous version first; every write is recorded in changes.jsonl as remote.file.<action>.

/**
 * What the editor read. Identity, size, nanosecond mtime as a decimal string (N4) and the SHA-256 of
 * the bytes. A commit is compared with it right before the rename: anything else is remote_conflict.
 */
export interface RemoteFileContentVersion { dev: string; ino: string; size: number; mtimeNs: string; sha256: string }

/** POST /v1/remote/files/read: only a regular file, opened without following a link nor waiting on a FIFO. */
export interface RemoteFileReadRequest { path: string }
/** `bytes` in base64, exactly as on disk: the app decodes them with protocol/textCodec.ts. */
export interface RemoteFileText { path: string; realPath: string; version: RemoteFileContentVersion; bytes: string; protection: RemoteFileProtection }

/** POST /v1/remote/files/saves: the encoded size, at most REMOTE_LIMITS.editableTextBytes. Kept in the Puente's memory only. */
export interface RemoteFileSaveRequest { size: number }
/** `id` is an op_ ID of this device. PUT /v1/remote/files/saves/:id/:offset sends application/octet-stream bytes, at most REMOTE_LIMITS.transferChunkBytes, at or before `received`. */
export interface RemoteFileSave { id: string; size: number; received: number }
/**
 * POST /v1/remote/files/saves/:id/commit, once every byte arrived. `format` is how the bytes are
 * text; they must decode in it. The file must still be `version`: overwriting after a conflict is a
 * commit with the version read again, which the app shows and the person confirms.
 */
export interface RemoteFileCommitRequest { path: string; version: RemoteFileContentVersion; format: TextFormat }
export interface RemoteFileSaved { path: string; realPath: string; version: RemoteFileContentVersion }
/**
 * Open saves per device and in all.
 * POST /v1/remote/operations/:id/cancel (no body) cancels any file operation (save, upload, download,
 * search) and answers a RemoteOperation: 'cancelled', or what happened first ('completed', 'failed').
 */
export const REMOTE_FILE_SAVES_PER_DEVICE = 4;
export const REMOTE_FILE_SAVES_TOTAL = 16;
/** Any file operation untouched this long is cancelled and forgotten: memory, descriptors and temporary file. */
export const REMOTE_FILE_OPERATION_IDLE_MS = 600_000;

// Transfers (#87): any size, never held whole in the Puente's memory. Each chunk is one request of at
// most REMOTE_LIMITS.transferChunkBytes; the client sends the next one after the answer to the last,
// so the offset plays the seq and the answer the ack. An interrupted transfer is not resumed: the
// client cancels it and starts again from byte 0, and a transfer that did not complete is never shown
// as done. Uploads and downloads count together against these caps.
export const REMOTE_FILE_TRANSFERS_PER_DEVICE = 4;
export const REMOTE_FILE_TRANSFERS_TOTAL = 16;

/**
 * POST /v1/remote/files/uploads: a new file `name` in `directory`. The bytes go to a temporary
 * `.relay-upload-*` file in that folder and the commit publishes them with a rename, so nothing
 * partial ever carries the name. `size` when known: free space is checked first, a chunk past it is
 * remote_too_large and the commit needs all of it. Without it the commit publishes what arrived.
 */
export interface RemoteFileUploadRequest { directory: string; name: string; size?: number }
/** PUT /v1/remote/files/uploads/:id/:offset: application/octet-stream, at or before `received`, like a save's chunk. */
export interface RemoteFileUpload { id: string; size: number | null; received: number }
/**
 * POST /v1/remote/files/uploads/:id/commit. An entry already at the name is replaced only with
 * `replace`, the version of it the person confirmed overwriting (as listed): without it
 * remote_confirmation_required, with another one remote_conflict. A link is written where it really
 * points and stays a link. A refused commit leaves the upload open: commit again or cancel it.
 * Answers the published entry.
 */
export interface RemoteFileUploadCommit { replace?: RemoteFileVersion }

/** POST /v1/remote/files/downloads: a regular file, links followed, never a special file. */
export interface RemoteFileDownloadRequest { path: string }
/**
 * GET /v1/remote/files/downloads/:id/:offset answers application/octet-stream: at most
 * transferChunkBytes from `offset` (below `size`). The file changing while it downloads fails the
 * download with remote_conflict. It is complete, and the operation 'completed', once the chunk that
 * ends at `size` was served; never before.
 */
export interface RemoteFileDownload { id: string; path: string; realPath: string; size: number; version: RemoteFileVersion }

// Search (#87): by name in a folder and its subfolders, or by text content as a separate action, with
// progress and cancellation and no index. It never follows a link (no cycle can form), skips a folder
// already among its ancestors (a bind mount of a parent) and pseudo filesystems such as /proc and
// /sys, and reads only regular files. Names match case-insensitively; content matches the query's
// UTF-8 bytes exactly, and a file with a NUL byte in its first 8 KiB is binary and skipped.

/** POST /v1/remote/files/search. `content: true` searches the text inside files instead of names. Answers a RemoteOperation. */
export interface RemoteFileSearchRequest { path: string; query: string; content?: true; hidden?: boolean }
export const REMOTE_FILE_SEARCH_QUERY_BYTES = 256;
/** Matches per search; the end event says `truncated` when the search stopped there. */
export const REMOTE_FILE_SEARCH_MATCHES_MAX = 5000;
export const REMOTE_FILE_SEARCHES_PER_DEVICE = 2;
export const REMOTE_FILE_SEARCHES_TOTAL = 8;
export interface RemoteFileSearchMatch { path: string; entry: RemoteFileEntry }
/** Folders and files examined so far, and entries that could not be read (permissions, gone). */
export interface RemoteFileSearchProgress { folders: number; files: number; unreadable: number }
/**
 * GET /v1/remote/operations/:id/events: text/event-stream with `id: <seq>`, seqs from 1, and
 * Last-Event-ID as the last seq the client holds. POST /v1/remote/operations/:id/ack `{ seq }` frees
 * what it covers. The search waits while REMOTE_LIMITS.channelWindowBytes of frames are unacknowledged,
 * so nothing is ever dropped and there is no gap. A new stream replaces the previous one.
 */
export type RemoteFileSearchEvent =
  | ({ type: 'results'; seq: number; matches: RemoteFileSearchMatch[] } & RemoteFileSearchProgress)
  /** The last frame: 'completed' (`truncated` at REMOTE_FILE_SEARCH_MATCHES_MAX), 'cancelled' or 'failed'. */
  | ({ type: 'end'; seq: number; state: 'completed' | 'cancelled' | 'failed'; truncated: boolean } & RemoteFileSearchProgress);
export interface RemoteFileSearchAck { seq: number }
