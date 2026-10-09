// ADR 0006 «Perfiles de Hermes»: the single boundary between remote file operations and the disk.
// Every effect of files.ts runs inside write(), which classifies the real paths it changes, keeps
// the previous version of what it replaces or removes inside a Hermes profile, records the operation
// in changes.jsonl and only then lets the effect run. A backup or a record that fails publishes nothing.
// The Hermes home, a profile, the profiles folder or a folder containing any of them is never moved
// or deleted from Relay. The Puente's own state (devices.json, changes.jsonl) and ~/.config/relay are
// refused always (#85 P1).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeChangeRecord, openPrivateFile, syncStateDirectory } from '../changeLog.ts';
import type { ChangeLog, ChangeRecord } from '../changeLog.ts';
import type { RemoteFileProtection } from '../../../protocol/remoteFiles.ts';
import { RemoteError } from './routes.ts';

export type RemoteFileAction = 'create' | 'write' | 'move' | 'rename' | 'delete';

export interface ProfileWrite<T> {
  action: RemoteFileAction;
  actor: ChangeRecord['actor'];
  /** The revocation check: before anything is kept or recorded, and again by `run` right before the effect. */
  guard: () => void;
  /** Real paths the effect changes: links already followed, parent folders read from their pinned descriptors. */
  paths: string[];
  /** The real path whose content the effect replaces or removes, if any. */
  replaced?: string;
  /** Checks that would refuse the operation anyway, said before anything is kept or recorded. */
  before?: () => void;
  /**
   * Only when `replaced` is inside a profile: its content, or null when nothing is lost (an empty
   * folder). Throws remote_profile_protected for what cannot be kept.
   */
  previous: () => Buffer | null;
  /** Synchronous: checks again what it acts on, calls `guard` and applies. Nothing awaits in between. */
  run: () => T;
}

export interface ProfileWriteGuard {
  write<T>(write: ProfileWrite<T>): Promise<T>;
  /** What write() would refuse for these real paths, refused now: before an upload lays its first byte. */
  check(paths: string[]): void;
  /** Where a write to this real path lands, for the person to see; null also when the guard cannot tell. */
  zone(target: string): RemoteFileProtection;
}

const MISSING: Record<string, true> = { ENOENT: true, ENOTDIR: true, ELOOP: true };

/** A path that cannot be resolved protects nothing; one that cannot be read leaves the guard blind. */
function real(file: string | Buffer): string | null {
  try { return fs.realpathSync.native(file); } catch (error) {
    if (MISSING[(error as NodeJS.ErrnoException).code ?? '']) return null;
    throw new RemoteError('remote_unavailable');
  }
}

/** A configured folder at both ends: its own name, even if it is a link or missing, and where it really is. */
function ends(configured: string): string[] {
  const parent = real(path.dirname(configured));
  const target = real(configured);
  return [configured, ...(parent ? [path.join(parent, path.basename(configured))] : []), ...(target ? [target] : [])];
}

// A root ending in '/' is the root of its disk (or the whole tree): everything below starts with it.
export const within = (root: string, target: string) => target.startsWith(root.endsWith('/') ? root : `${root}/`);
/** On a root or a folder that contains it: that would move or delete the root itself. */
const holds = (roots: string[], target: string) => roots.some((root) => target === root || target === '/' || within(target, root));

/** The mount a descriptor is on. st_dev is not enough: a bind of a folder on the same disk keeps it. */
export function mountOf(fd: number): string {
  let id: string | undefined;
  try { id = /^mnt_id:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]; } catch {}
  if (id === undefined) throw new RemoteError('remote_unavailable');
  return id;
}

interface Mount { device: string; root: string; point: string }

/** Mount ID → its device and the folder of that device it shows, from /proc/self/mountinfo (octal escapes undone). */
function mounts(): Map<string, Mount> {
  const table = new Map<string, Mount>();
  let text: string;
  try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { throw new RemoteError('remote_unavailable'); }
  for (const line of text.split('\n')) {
    const [id, , device, root, point] = line.split(' ').map((field) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
    if (id && device && root && point) table.set(id, { device, root, point });
  }
  return table;
}

/**
 * Where a folder really is on its device, whatever mount shows it: `<major:minor>:<path on the device>`.
 * A bind of a profile, of a folder inside one or of the Puente state has another path but the same
 * location (#86 H1). Null when the folder does not exist.
 */
function located(folder: string, table: Map<string, Mount>): string | null {
  let fd: number;
  try { fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK); } catch (error) {
    if (MISSING[(error as NodeJS.ErrnoException).code ?? '']) return null;
    throw new RemoteError('remote_unavailable');
  }
  try {
    const mount = table.get(mountOf(fd));
    let shown: string;
    try { shown = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { throw new RemoteError('remote_unavailable'); }
    if (!mount || (shown !== mount.point && !within(mount.point, shown))) throw new RemoteError('remote_unavailable');
    return `${mount.device}:${path.posix.join(mount.root, shown.slice(mount.point.length))}`;
  } finally { fs.closeSync(fd); }
}

export function createProfileWriteGuard(options: {
  hermesHome: string; bridgeDirectories: string[]; stateDirectory: string; changeLog: ChangeLog; now?: () => number;
}): ProfileWriteGuard {
  const configured = path.resolve(options.hermesHome);
  const bridge = options.bridgeDirectories.map((directory) => path.resolve(directory));
  const now = options.now ?? Date.now;
  // Read again on every write: the Hermes home or a profile link may appear or move at any time.
  function roots(): string[] {
    const found = ends(configured);
    const home = real(configured);
    if (!home) return found;
    // The registry itself, where it really is: a new profile there is a profile write too.
    const registry = real(path.join(home, 'profiles'));
    if (registry) found.push(registry);
    let names: Buffer[] = [];
    try { names = fs.readdirSync(path.join(home, 'profiles'), { encoding: 'buffer' }); } catch (error) {
      if (!MISSING[(error as NodeJS.ErrnoException).code ?? '']) throw new RemoteError('remote_unavailable');
    }
    // Each profile by its name in the registry and where it really is.
    // ponytail: profiles linked elsewhere are covered; a link deeper inside a profile (a SOUL.md that
    // points out) is not, so writing through it from outside is an ordinary write.
    for (const name of names) {
      if (registry) found.push(path.join(registry, name.toString()));
      const target = real(Buffer.concat([Buffer.from(`${home}/profiles/`), name]));
      if (target) found.push(target);
    }
    return found;
  }
  /** Throws for what is never written from Relay; true when the write lands inside a profile. */
  function classify(paths: string[]): boolean {
    // Each path and each root also by its location on disk, so no mount can show one under another name.
    const table = mounts();
    const targets = paths.flatMap((target) => {
      const folder = located(path.dirname(target), table);
      return folder ? [target, path.posix.join(folder, path.basename(target))] : [target];
    });
    const profiles = roots();
    profiles.push(...profiles.flatMap((root) => located(root, table) ?? []));
    if (targets.some((target) => holds(profiles, target))) throw new RemoteError('remote_profile_protected');
    const state = bridge.flatMap(ends);
    state.push(...state.flatMap((root) => located(root, table) ?? []));
    if (targets.some((target) => holds(state, target) || state.some((root) => within(root, target)))) throw new RemoteError('remote_bridge_protected');
    return targets.some((target) => profiles.some((root) => within(root, target)));
  }
  /** agentMemory.ts keeps memory-<id>.previous the same way: private, exclusive, synced, before the record. */
  async function keep(file: string, bytes: Buffer): Promise<void> {
    const { handle, created } = await openPrivateFile(file, fs.constants.O_WRONLY | fs.constants.O_EXCL, true);
    try {
      if (!created || (await handle.stat()).nlink !== 1) throw new Error('not a new private file');
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await syncStateDirectory(options.stateDirectory);
  }
  return {
    async write(write) {
      write.guard();
      const profile = classify(write.paths);
      write.before?.();
      const kept = profile && write.replaced !== undefined && classify([write.replaced]) ? write.previous() : null;
      const record = makeChangeRecord({
        actor: write.actor, action: `remote.file.${write.action}`, target: { kind: 'server', id: 'local' },
        ...(profile ? { details: { profile: true, previous: kept !== null } } : {}),
      }, now(), randomUUID);
      try {
        if (kept) await keep(path.join(options.stateDirectory, `remote-file-${record.id}.previous`), kept);
      } catch { throw new RemoteError('remote_unavailable'); }
      write.guard();
      try { await options.changeLog.appendCommitted(record); } catch { throw new RemoteError('remote_unavailable'); }
      // The disk may have changed while the record was written: what was kept must still be what is replaced.
      if (classify(write.paths) !== profile) throw new RemoteError('remote_conflict');
      return write.run();
    },
    check(paths) { classify(paths); },
    zone(target) {
      try { return classify([target]) ? 'profile' : null; } catch (error) {
        if (error instanceof RemoteError && (error.code === 'remote_profile_protected' || error.code === 'remote_bridge_protected')) {
          return error.code === 'remote_profile_protected' ? 'profile' : 'bridge';
        }
        return null;
      }
    },
  };
}
