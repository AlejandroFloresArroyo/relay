// Transfers and searches of the `files` tool on the app's side (#87, protocol/remoteFiles.ts); the
// screens are #88. One chunk at a time, so memory and connections stay bounded whatever the size,
// and a size the phone does not know is never read whole first. A transfer that did not complete
// never reports completion: an interrupted one is cancelled on the Servidor and starts again from
// byte 0 when the person asks, with no partial resume. A search reconnects from the last frame it
// holds and acknowledges each frame once delivered.
import { REMOTE_ID_PATTERN, REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type {
  RemoteFileDownload, RemoteFileEntry, RemoteFileSearchEvent, RemoteFileSearchMatch, RemoteFileSearchProgress, RemoteFileSearchRequest, RemoteFileVersion,
} from '../../../protocol/remoteFiles.ts';
import type { RemoteClient } from './remoteClient.ts';
import { RemoteFailure } from './remoteClient.ts';

/** What really happened. `completed` with `null`: the upload was published but its answer was lost; list the folder again. */
export type Outcome<T> = { state: 'completed'; value: T } | { state: 'cancelled' } | { state: 'failed'; error: unknown };
export interface Progress { done: number; total: number | null }

const CHUNK = REMOTE_LIMITS.transferChunkBytes;
const OPERATION = new RegExp(REMOTE_ID_PATTERN);
const BACKOFF_MS = [1000, 2000, 5000, 10_000];
const unexpected = () => new RemoteFailure('unexpected', { status: 200 });
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function operationId(value: unknown): string {
  if (!object(value) || typeof value.id !== 'string' || !OPERATION.test(value.id) || !value.id.startsWith('op_')) throw unexpected();
  return value.id;
}

function entry(value: unknown): RemoteFileEntry {
  if (!object(value) || typeof value.name !== 'string' || typeof value.type !== 'string' || !count(value.size) || !object(value.version)) throw unexpected();
  return value as unknown as RemoteFileEntry; // the fields the app reads are checked above
}

/** Ends what the Servidor still holds for an operation that did not complete here, and answers what it says happened. */
export async function release(client: () => RemoteClient, id: string | null): Promise<unknown> {
  if (!id) return null;
  try { return (await client().request('POST', `/v1/remote/operations/${id}/cancel`) as { state?: unknown }).state; } catch { return null; }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  return promise;
}

export interface UploadSource {
  /** Up to `length` bytes from `offset`; fewer only at the end, none past it. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** When known: the Servidor checks free space first and needs every byte. */
  size?: number;
}

/**
 * A phone file to `directory/name`. An existing name is replaced only with `replace`, the listed
 * version the person confirmed overwriting. Once the commit is sent it is not cancelled.
 */
export async function uploadFile(client: () => RemoteClient, target: { directory: string; name: string; replace?: RemoteFileVersion }, source: UploadSource,
  options: { signal: AbortSignal; onProgress?: (progress: Progress) => void }): Promise<Outcome<RemoteFileEntry | null>> {
  const { signal } = options;
  let id: string | null = null;
  try {
    id = operationId(await client().request('POST', '/v1/remote/files/uploads', {
      directory: target.directory, name: target.name, ...(source.size === undefined ? {} : { size: source.size }),
    }));
    for (let offset = 0; ;) {
      const bytes = await source.read(offset, CHUNK);
      if (signal.aborted) throw signal.reason;
      if (bytes.length > CHUNK) throw new Error('A read past the chunk size.');
      if (bytes.length > 0) await client().chunk('PUT', `/v1/remote/files/uploads/${id}/${offset}`, bytes, signal);
      offset += bytes.length;
      options.onProgress?.({ done: offset, total: source.size ?? null });
      if (bytes.length < CHUNK || offset === source.size) break;
    }
    if (signal.aborted) throw signal.reason;
    return { state: 'completed', value: entry(await client().request('POST', `/v1/remote/files/uploads/${id}/commit`, target.replace ? { replace: target.replace } : {})) };
  } catch (error) {
    // The Servidor says what happened: a commit whose answer was lost may have published.
    const state = await release(client, id);
    if (state === 'completed') return { state: 'completed', value: null };
    return signal.aborted ? { state: 'cancelled' } : { state: 'failed', error };
  }
}

/** A Servidor file, chunk by chunk, to `sink`. Completed only once its last byte was written there; else discard what the sink holds. */
export async function downloadFile(client: () => RemoteClient, path: string, sink: (bytes: Uint8Array, offset: number) => Promise<void>,
  options: { signal: AbortSignal; onProgress?: (progress: Progress) => void }): Promise<Outcome<RemoteFileDownload>> {
  const { signal } = options;
  let id: string | null = null;
  try {
    const download = await client().request('POST', '/v1/remote/files/downloads', { path });
    id = operationId(download);
    if (!object(download) || !count(download.size)) throw unexpected();
    const size = download.size;
    for (let offset = 0; offset < size;) {
      if (signal.aborted) throw signal.reason;
      const bytes = await client().chunk('GET', `/v1/remote/files/downloads/${id}/${offset}`, undefined, signal);
      // Exactly the chunk asked for: anything shorter is an incomplete download, never a complete one.
      if (!(bytes instanceof Uint8Array) || bytes.length !== Math.min(CHUNK, size - offset)) throw unexpected();
      await sink(bytes, offset);
      offset += bytes.length;
      options.onProgress?.({ done: offset, total: size });
    }
    return { state: 'completed', value: download as unknown as RemoteFileDownload }; // id and size checked above
  } catch (error) {
    await release(client, id);
    return signal.aborted ? { state: 'cancelled' } : { state: 'failed', error };
  }
}

function searchEvent(data: string): RemoteFileSearchEvent {
  let event: unknown;
  try { event = JSON.parse(data); } catch { throw unexpected(); }
  if (!object(event) || !count(event.seq) || !count(event.folders) || !count(event.files) || !count(event.unreadable)) throw unexpected();
  if (event.type === 'results' && Array.isArray(event.matches) && event.matches.every((match) => object(match) && typeof match.path === 'string' && object(match.entry))) {
    return event as unknown as RemoteFileSearchEvent;
  }
  if (event.type === 'end' && ['completed', 'cancelled', 'failed'].includes(event.state as string) && typeof event.truncated === 'boolean') return event as unknown as RemoteFileSearchEvent;
  throw unexpected();
}

/**
 * Search by name, or by content with `content: true`. Matches arrive through `onResults` as the
 * Servidor finds them; the outcome says how it ended. A lost stream resumes from the last frame.
 */
export async function searchFiles(client: () => RemoteClient, request: RemoteFileSearchRequest, options: {
  signal: AbortSignal; onResults: (matches: RemoteFileSearchMatch[], progress: RemoteFileSearchProgress) => void; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<Outcome<RemoteFileSearchProgress & { truncated: boolean }>> {
  const { signal } = options;
  const wait = options.wait ?? sleep;
  let id: string | null = null;
  try {
    id = operationId(await client().request('POST', '/v1/remote/files/search', request));
    let last = 0;
    let end: Extract<RemoteFileSearchEvent, { type: 'end' }> | null = null;
    for (let failures = 0; !end;) {
      if (signal.aborted) throw signal.reason;
      const before = last;
      let acks = Promise.resolve();
      let lost: unknown = null;
      try {
        await client().stream(`/v1/remote/operations/${id}/events`, last, (data) => {
          if (end) return;
          const event = searchEvent(data);
          // The Puente never skips: anything else is not this search's stream.
          if (event.seq !== last + 1) throw unexpected();
          last = event.seq;
          if (event.type === 'end') end = event;
          else options.onResults(event.matches, { folders: event.folders, files: event.files, unreadable: event.unreadable });
          // Delivered, so acknowledged: that frees the Servidor's window. A lost ack is sent again by reconnecting.
          const seq = event.seq;
          acks = acks.then(() => client().request('POST', `/v1/remote/operations/${id}/ack`, { seq })).then(() => {}, () => {});
        }, signal);
      } catch (error) {
        if (!(error instanceof RemoteFailure) || error.kind !== 'no_response') throw error;
        lost = error;
      }
      await acks;
      if (end || signal.aborted) continue;
      // Closed or lost before the end: again from the last frame held, waiting longer while nothing arrives.
      failures = last > before ? 0 : failures + 1;
      if (failures > BACKOFF_MS.length) throw lost ?? unexpected();
      if (failures > 0) await wait(BACKOFF_MS[failures - 1]!, signal);
    }
    const finished: Extract<RemoteFileSearchEvent, { type: 'end' }> = end;
    if (finished.state === 'cancelled') return { state: 'cancelled' };
    if (finished.state === 'failed') return { state: 'failed', error: new RemoteFailure('remote', { code: 'remote_unavailable' }) };
    return { state: 'completed', value: { folders: finished.folders, files: finished.files, unreadable: finished.unreadable, truncated: finished.truncated } };
  } catch (error) {
    await release(client, id);
    return signal.aborted ? { state: 'cancelled' } : { state: 'failed', error };
  }
}
