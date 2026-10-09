import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { APP_UPDATE_MAX_BYTES, APP_UPDATE_METADATA_MAX_BYTES } from '../../protocol/appUpdate.ts';
import type { AppUpdateArtifact, AppUpdatePublication } from '../../protocol/appUpdate.ts';

export class AppUpdateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = 'app_update_invalid', status = 503) {
    super(code === 'app_update_changed' ? 'La actualización cambió; revisa la versión de nuevo.'
      : code === 'app_update_busy' ? 'La descarga está ocupada. Reintenta más tarde.'
      : code === 'app_update_precondition' ? 'Revisa la actualización antes de descargarla.'
      : code === 'app_update_unavailable' ? 'No hay una actualización publicada.'
      : 'La publicación de Relay no está disponible.');
    this.code = code; this.status = status;
  }
}
function invalid(): never { throw new AppUpdateError(); }
interface Pin { file: FileHandle; stat: BigIntStats; name: string }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const version = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const BLOCK_BYTES = 64 * 1024;

export function validRoot(root: string): boolean {
  return path.isAbsolute(root) && root !== '/' && path.resolve(root) === root && root.length <= 4096
    && root.split('/').length <= 64 && !/[\x00-\x1f\x7f]/.test(root);
}
class Directory {
  pins: Pin[] = [];
  get fd() { return this.pins.at(-1)!.file.fd; }
  // `privateChild` names a directory the Puente creates 0700 under a parent that need only be
  // owned and not group/other writable, so a readable state root still yields private storage.
  async open(root: string, guard: () => void, privateChild?: string) {
    if (process.platform !== 'linux' || !validRoot(root)) invalid();
    for (const name of ['/', ...root.split('/').filter(Boolean)]) {
      guard();
      const file = await fs.open(this.pins.length ? `/proc/self/fd/${this.fd}/${name}` : '/', directoryFlags);
      this.pins.push({ file, name, stat: undefined as unknown as BigIntStats }); guard();
      const stat = await file.stat({ bigint: true }); this.pins.at(-1)!.stat = stat; guard();
      if (!stat.isDirectory() || (stat.mode & 0o022n) !== 0n) invalid();
    }
    if (privateChild) {
      if (this.pins.at(-1)!.stat.uid !== BigInt(process.getuid!())) invalid();
      const candidate = `/proc/self/fd/${this.fd}/${privateChild}`;
      try { await fs.mkdir(candidate, { mode: 0o700 }); } catch (error) { guard(); if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      guard(); const file = await fs.open(candidate, directoryFlags);
      this.pins.push({ file, name: privateChild, stat: undefined as unknown as BigIntStats }); guard();
      const stat = await file.stat({ bigint: true }); this.pins.at(-1)!.stat = stat; guard();
      if (!stat.isDirectory()) invalid();
    }
    const leaf = this.pins.at(-1)!.stat;
    if (leaf.uid !== BigInt(process.getuid!()) || (leaf.mode & 0o077n) !== 0n) invalid();
  }
  async verify(guard: () => void) {
    for (let i = 0; i < this.pins.length; i++) {
      const pin = this.pins[i]; guard();
      const file = await fs.open(i ? `/proc/self/fd/${this.pins[i - 1].file.fd}/${pin.name}` : '/', directoryFlags);
      try {
        guard(); const entry = await file.stat({ bigint: true }); guard();
        const held = await pin.file.stat({ bigint: true }); guard();
        if (!same(pin.stat, entry) || !same(pin.stat, held)) invalid();
      } finally { await file.close(); }
    }
  }
  async close() { for (const pin of this.pins.reverse()) await pin.file.close(); this.pins = []; }
}
// Cleanup is confined to a descriptor-pinned reservation owned by this snapshot.
// Replaced names and unrecognized contents are retained, never recursively reclaimed.
async function removeReservation(name: string, held: FileHandle, identity: BigIntStats, file?: FileHandle) {
  let entry: FileHandle | undefined;
  try {
    if (!same(identity, await held.stat({ bigint: true }))) return;
    // Free only our pinned APK bytes even if the reservation name was moved.
    if (file) {
      const own = await file.stat({ bigint: true });
      const apk = `/proc/self/fd/${held.fd}/relay.apk`;
      try { if (same(own, await fs.lstat(apk, { bigint: true }))) await fs.unlink(apk); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { entry = await fs.open(name, directoryFlags); }
    catch (error) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
    if (!same(identity, await entry.stat({ bigint: true }))) return;
    // Recheck after awaits; rmdir cannot recursively remove replacement contents.
    try { if (!same(identity, await fs.lstat(name, { bigint: true }))) return; await fs.rmdir(name); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } finally { await entry?.close(); }
}
function publication(value: unknown): AppUpdatePublication {
  const names = ['applicationId', 'versionCode', 'versionName', 'byteLength', 'sha256', 'signerSha256', 'builtAtMs', 'sourceCommit', 'schemaVersion'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== names.length || names.some(name => !Object.hasOwn(v, name)) || v.schemaVersion !== 1
    || typeof v.applicationId !== 'string' || v.applicationId.length > 200 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v.applicationId)
    || !Number.isInteger(v.versionCode) || Number(v.versionCode) < 1 || Number(v.versionCode) > 2147483647
    || typeof v.versionName !== 'string' || v.versionName.length < 1 || v.versionName.length > 128 || /[\x00-\x1f\x7f]/.test(v.versionName)
    || !Number.isSafeInteger(v.byteLength) || Number(v.byteLength) < 1 || Number(v.byteLength) > APP_UPDATE_MAX_BYTES
    || !Number.isSafeInteger(v.builtAtMs) || Number(v.builtAtMs) < 0
    || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)
    || typeof v.signerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.signerSha256)
    || typeof v.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(v.sourceCommit)) invalid();
  return v as unknown as AppUpdatePublication;
}
export interface Snapshot {
  file: FileHandle; artifact: AppUpdateArtifact; revision: string; identity: string;
  dispose(): Promise<void>;
}
export class PublicationReader {
  private directory = new Directory();
  private files = new Map<string, Pin>();
  artifact?: AppUpdateArtifact;
  revision = '';
  identity = '';
  constructor(root: string) { this.root = root; }
  private root: string;
  async open(guard: () => void): Promise<boolean> {
    try {
      await this.directory.open(this.root, guard); guard();
      for (const [name, limit] of [['relay.apk', APP_UPDATE_MAX_BYTES], ['release.json', APP_UPDATE_METADATA_MAX_BYTES]] as const) {
        guard(); let file: FileHandle;
        try { file = await fs.open(`/proc/self/fd/${this.directory.fd}/${name}`, fileFlags); }
        catch (error) { guard(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const pin = { file, name, stat: undefined as unknown as BigIntStats }; this.files.set(name, pin); guard();
        pin.stat = await file.stat({ bigint: true }); guard();
        if (!pin.stat.isFile() || pin.stat.nlink !== 1n || pin.stat.size < 1n || pin.stat.size > BigInt(limit)
          || pin.stat.uid !== BigInt(process.getuid!()) || (pin.stat.mode & 0o077n) !== 0n) invalid();
      }
      await this.verify(guard); guard();
      if (this.files.size === 0) return false;
      if (this.files.size !== 2) invalid();
      const metadata = this.files.get('release.json')!;
      const buffer = Buffer.alloc(Number(metadata.stat.size)); let position = 0;
      while (position < buffer.length) {
        guard(); const result = await metadata.file.read(buffer, position, buffer.length - position, position); guard();
        if (result.bytesRead === 0) invalid(); position += result.bytesRead;
      }
      const parsed = publication(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(buffer)));
      const { schemaVersion: _schema, ...artifact } = parsed;
      if (artifact.byteLength !== Number(this.files.get('relay.apk')!.stat.size)) invalid();
      this.artifact = artifact;
      const canonical = Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b)));
      this.revision = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      this.identity = [...this.files.values()].map(p => [p.stat.dev, p.stat.ino, p.stat.size, p.stat.mtimeNs, p.stat.ctimeNs, p.stat.mode].join(':')).join('|');
      await this.verify(guard); guard(); return true;
    } catch (error) { guard(); if (error instanceof AppUpdateError) throw error; return invalid(); }
  }
  async verify(guard: () => void) {
    await this.directory.verify(guard); guard();
    for (const name of ['relay.apk', 'release.json']) {
      const pin = this.files.get(name); let entry: FileHandle | undefined;
      try {
        guard(); entry = await fs.open(`/proc/self/fd/${this.directory.fd}/${name}`, fileFlags); guard();
        if (!pin) invalid();
        const stat = await entry.stat({ bigint: true }); guard();
        const held = await pin.file.stat({ bigint: true }); guard();
        if (!version(pin.stat, stat) || !version(pin.stat, held)) invalid();
      } catch (error) { guard(); if (!pin && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      finally { await entry?.close(); }
    }
  }
  async snapshot(privateRoot: string, guard: () => void): Promise<Snapshot> {
    const privateDirectory = new Directory(); let temporary: string | undefined; let file: FileHandle | undefined; let snapshotDirectory: FileHandle | undefined; let reservationIdentity: BigIntStats | undefined; let transferred = false;
    try {
      await privateDirectory.open(privateRoot, guard, 'app-update'); guard();
      // Two fixed exclusive reservations also bound leftovers across interrupted instances.
      // Existing slots are never inspected, reused or removed by a new instance.
      for (const name of ['app-update-slot-0', 'app-update-slot-1']) {
        guard();
        try { const candidate = `/proc/self/fd/${privateDirectory.fd}/${name}`; await fs.mkdir(candidate, { mode: 0o700 }); temporary = candidate; guard(); break; }
        catch (error) { guard(); if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!temporary) throw new AppUpdateError('app_update_busy', 429);
      snapshotDirectory = await fs.open(temporary, directoryFlags); guard();
      reservationIdentity = await snapshotDirectory.stat({ bigint: true }); guard();
      file = await fs.open(`/proc/self/fd/${snapshotDirectory.fd}/relay.apk`, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); guard();
      const source = this.files.get('relay.apk')!; const buffer = Buffer.alloc(BLOCK_BYTES); let position = 0;
      const hash = createHash('sha256');
      while (position < Number(source.stat.size)) {
        guard(); const result = await source.file.read(buffer, 0, Math.min(buffer.length, Number(source.stat.size) - position), position); guard();
        if (result.bytesRead === 0) invalid();
        let written = 0;
        while (written < result.bytesRead) {
          guard(); const resultWrite = await file.write(buffer, written, result.bytesRead - written, position + written); guard();
          if (resultWrite.bytesWritten === 0) invalid();
          written += resultWrite.bytesWritten;
        }
        position += result.bytesRead;
      }
      const stat = await file.stat({ bigint: true }); guard();
      if (stat.size !== BigInt(this.artifact!.byteLength) || stat.nlink !== 1n || !stat.isFile()) invalid();
      for (let offset = 0; offset < Number(stat.size);) {
        guard(); const read = await file.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset); guard();
        if (!read.bytesRead) invalid(); hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true }); guard();
      if (!version(stat, after) || hash.digest('hex') !== this.artifact!.sha256) invalid();
      await this.verify(guard); guard(); await privateDirectory.verify(guard); guard();
      const retained = file, directory = temporary, heldDirectory = snapshotDirectory, reservation = reservationIdentity!; transferred = true; file = undefined; temporary = undefined; snapshotDirectory = undefined;
      return { file: retained, artifact: this.artifact!, revision: this.revision, identity: this.identity,
        async dispose() { try { await removeReservation(directory, heldDirectory, reservation, retained); } finally { try { await retained.close(); } finally { try { await heldDirectory.close(); } finally { await privateDirectory.close(); } } } } };
    } catch (error) { guard(); if (error instanceof AppUpdateError) throw error; return invalid(); }
    finally {
      if (!transferred) {
        try { if (temporary && snapshotDirectory && reservationIdentity) await removeReservation(temporary, snapshotDirectory, reservationIdentity, file); }
        finally { try { await file?.close(); } finally { try { await snapshotDirectory?.close(); } finally { await privateDirectory.close(); } } }
      }
    }
  }
  async close() { for (const pin of this.files.values()) await pin.file.close(); await this.directory.close(); }
}
