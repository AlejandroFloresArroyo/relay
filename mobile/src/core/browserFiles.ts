// Phone files for a page of the Server's browser (ADR 0006 «Lo que fijó la integración de #92 con #87
// y #96»): a file chooser only takes Servidor paths, so the phone's file is uploaded first with the
// files transfer (#87) and the `files` action then names it. Downloads stay on the Servidor and come
// to the phone with the same transfer (`downloadFile`).
import type { RemoteClient } from './remoteClient.ts';
import { RemoteFailure } from './remoteClient.ts';
import { uploadFile, type Outcome, type Progress, type UploadSource } from './remoteTransfers.ts';

/** The first name nothing in the folder has: «nombre (2).ext», as the dedicated browser names its downloads. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${extension}`;
    if (!taken.has(next)) return next;
  }
}

/**
 * A phone file into the Puente account's home folder, under a free name, so it never replaces anything;
 * completed with its Servidor path. ponytail: a home with more than REMOTE_FILES_LIST_MAX entries may hide
 * a taken name; the commit then refuses to replace it and the upload fails visibly.
 */
export async function uploadPhoneFile(client: () => RemoteClient, source: UploadSource & { name: string },
  options: { signal: AbortSignal; onProgress?: (progress: Progress) => void }): Promise<Outcome<string>> {
  let home: { path: string; names: Set<string> };
  try {
    const listing = await client().request('POST', '/v1/remote/files/list', {});
    const path = typeof listing === 'object' && listing !== null && 'path' in listing ? listing.path : null;
    const entries = typeof listing === 'object' && listing !== null && 'entries' in listing ? listing.entries : null;
    if (typeof path !== 'string' || !path.startsWith('/') || !Array.isArray(entries)) throw new RemoteFailure('unexpected', { status: 200 });
    home = { path, names: new Set(entries.flatMap((each: unknown) => typeof each === 'object' && each !== null && 'name' in each && typeof each.name === 'string' ? [each.name] : [])) };
  } catch (error) {
    return options.signal.aborted ? { state: 'cancelled' } : { state: 'failed', error };
  }
  const name = freeName(source.name, home.names);
  const outcome = await uploadFile(client, { directory: home.path, name }, source, options);
  if (outcome.state !== 'completed') return outcome;
  // A commit whose answer was lost still published under the name asked for.
  return { state: 'completed', value: `${home.path === '/' ? '' : home.path}/${outcome.value?.name ?? name}` };
}
