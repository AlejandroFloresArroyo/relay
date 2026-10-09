// The durable ownership record (ADR 0006 «Identidad y pertenencia»): written atomically before any
// process starts. A file that does not read back exactly is never replaced by an empty one: the
// supervisor refuses to start, so no environment loses its owner and none is adopted.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validEnvironmentRecord } from '../../protocol/supervisor.ts';
import type { EnvironmentRecord } from '../../protocol/supervisor.ts';

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const REGISTRY_FILE = 'environments.json';

export class RegistryError extends Error {
  constructor() {
    super('The environment registry is unreadable; it was left untouched.');
    this.name = 'RegistryError';
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new RegistryError();
}

/** Missing file: no environment yet. Anything else that does not validate entirely is an error. */
export async function loadRegistry(directory: string): Promise<EnvironmentRecord[]> {
  await privateDirectory(directory);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path.join(directory, REGISTRY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new RegistryError();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new RegistryError();
    const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await handle.readFile()));
    if (!plain(value) || value.version !== 1 || !Array.isArray(value.environments) || Object.keys(value).length !== 2) throw new RegistryError();
    const records = value.environments as unknown[];
    if (!records.every(validEnvironmentRecord)) throw new RegistryError();
    const ids = new Set(records.map((record) => record.id));
    const requests = new Set(records.map((record) => `${record.deviceId}\0${record.requestId}`));
    if (ids.size !== records.length || requests.size !== records.length) throw new RegistryError();
    return records;
  } catch {
    throw new RegistryError();
  } finally {
    await handle.close();
  }
}

/** Temporary file in the same directory, fsync, rename, fsync of the directory. */
export async function saveRegistry(directory: string, records: EnvironmentRecord[]): Promise<void> {
  const temporary = path.join(directory, `.${REGISTRY_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, environments: records })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, path.join(directory, REGISTRY_FILE));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  const dir = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
