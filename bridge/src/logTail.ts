import fs, { constants } from 'node:fs';
import path from 'node:path';
import { HermesError } from './hermes.ts';

// Walk from open directory descriptors so a swapped parent cannot redirect a read.
export function readLogTail(file: string, maxBytes: number): string {
  let directory: number | undefined; let handle: number | undefined;
  try {
    directory = fs.openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parts = path.resolve(file).split('/').filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fs.closeSync(directory); directory = next;
    }
    handle = fs.openSync(`/proc/self/fd/${directory}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error();
    // A bounded suffix cannot reveal whether it starts inside a quoted credential.
    // Refuse source content rather than treating the first newline as a safe boundary.
    if (stat.size > maxBytes) throw new Error();
    const length = Math.min(stat.size, maxBytes); const buffer = Buffer.alloc(length);
    const count = fs.readSync(handle, buffer, 0, length, stat.size - length);
    return buffer.subarray(0, count).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new HermesError('upstream', 'No se pudieron leer los logs del Agente. Reintenta.');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (directory !== undefined) fs.closeSync(directory);
  }
}
