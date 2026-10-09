// A temporary disk for the file explorer tests: a home, a synthetic Hermes home with a profile inside
// and one kept elsewhere through a link, a folder outside, and the Puente state with a real
// changes.jsonl. Nothing here touches the real home or ~/.hermes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { REMOTE_ERROR_MESSAGES, type RemoteErrorCode } from '../../protocol/protocol.ts';
import type { RemoteFileEntry, RemoteFileVersion } from '../../protocol/remoteFiles.ts';
import { createChangeLog, type ChangeRecord, type StateIO } from '../src/changeLog.ts';
import { createRemoteFileSystem } from '../src/remote/files.ts';
import type { FileWriteContext } from '../src/remote/ports.ts';
import { RemoteError } from '../src/remote/routes.ts';

export const PHONE = { kind: 'device', id: '00000000-0000-4000-8000-000000000001', name: 'phone' } as const;
export const ok: FileWriteContext = { guard() {}, actor: PHONE, deviceId: PHONE.id };
export const revoked: FileWriteContext = { ...ok, guard() { throw new Error('device_revoked'); } };

function* walkDirectories(directory: string): Generator<string> {
  yield directory;
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const name of names) if (name.isDirectory()) yield* walkDirectories(path.join(directory, name.name));
}

export function lab(t: TestContext, options: { now?: () => number } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-files-')));
  t.after(() => {
    for (const directory of walkDirectories(base)) try { fs.chmodSync(directory, 0o700); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  });
  const home = path.join(base, 'home');
  const hermes = path.join(home, '.hermes');
  const outside = path.join(base, 'outside');
  const external = path.join(base, 'external-profile');
  const state = path.join(base, 'relay-state');
  const config = path.join(home, '.config', 'relay');
  const changes = path.join(state, 'changes.jsonl');
  for (const directory of [path.join(hermes, 'profiles', 'p1'), path.join(home, 'docs'), outside, external]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(hermes, 'SOUL.md'), 'default soul');
  fs.writeFileSync(path.join(hermes, 'profiles', 'p1', 'SOUL.md'), 'p1 soul');
  fs.writeFileSync(path.join(external, 'SOUL.md'), 'p2 soul');
  fs.symlinkSync(external, path.join(hermes, 'profiles', 'p2'));
  fs.writeFileSync(path.join(home, 'docs', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(home, '.hidden'), '');
  fs.writeFileSync(path.join(outside, 'f'), 'outside file');
  fs.writeFileSync(changes, '', { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'devices.json'), 'devices.json of the Puente', { mode: 0o600 });
  // `during` runs once, the next time changes.jsonl is opened: while a write waits for its record.
  let during: (() => void) | null = null;
  const io: StateIO = { ...fsp, open: async (...args: Parameters<typeof fsp.open>) => { const run = during; during = null; run?.(); return fsp.open(...args); } };
  const changeLog = createChangeLog({ file: changes, io });
  const make = (hermesHome: string) => createRemoteFileSystem({ home, hermesHome, stateDirectory: state, changeLog, now: options.now });
  const files = make(hermes);
  const entry = async (directory: string, name: string, hidden = true): Promise<RemoteFileEntry> => {
    const found = (await files.list({ path: directory, hidden })).entries.find((candidate) => candidate.name === name);
    assert.ok(found, `${name} listed`);
    return found;
  };
  // What a listing says of the entry itself (lstat), read directly so a test can name it inline.
  const version = (file: string): RemoteFileVersion => {
    const stat = fs.lstatSync(file, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
  };
  const records = (): ChangeRecord[] => fs.readFileSync(changes, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ChangeRecord);
  const backups = () => fs.readdirSync(state).filter((name) => name.endsWith('.previous')).sort();
  const kept = (record: ChangeRecord) => fs.readFileSync(path.join(state, `remote-file-${record.id}.previous`), 'utf8');
  return {
    base, home, hermes, outside, external, state, config, changes, files, make, entry, version, records, backups, kept,
    during: (run: () => void) => { during = run; },
  };
}

/** Every name, type, link target and content under a directory: equal before and after means untouched. */
export function snapshot(directory: string): string[] {
  const lines: string[] = [];
  const visit = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) lines.push(`${file} -> ${fs.readlinkSync(file)}`);
      else if (stat.isDirectory()) { lines.push(`${file}/ ${stat.ino}`); visit(file); }
      else lines.push(`${file} ${stat.ino} ${fs.readFileSync(file, 'utf8')}`);
    }
  };
  visit(directory);
  return lines;
}

/** Synchronous or not, the operation fails with exactly that fixed error. */
export async function rejects(code: RemoteErrorCode, run: () => unknown, message: string = code): Promise<void> {
  await assert.rejects(async () => run(), (error: unknown) => {
    assert.ok(error instanceof RemoteError, `${message}: ${String(error)}`);
    assert.equal(error.code, code, message);
    assert.equal(error.message, REMOTE_ERROR_MESSAGES[code], message);
    return true;
  });
}

export const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch { return false; } };

/** Unprivileged user and mount namespaces: binds that exist only inside one child process. */
const userNamespaces = (() => { try { execFileSync('unshare', ['-rm', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } })();
export const needsNamespaces = userNamespaces ? false : 'needs unprivileged user and mount namespaces (unshare -rm)';

/**
 * Runs `body` in a child whose own mount namespace has `binds` ([source, target] pairs), with `files`,
 * `context`, `version(path)`, `attempt(run)` (the error code or 'done') and `save(path, text)` in scope.
 * Its return value comes back through JSON. The binds exist only for the child; what it changes through them is real.
 */
export function withBinds(where: { home: string; hermes: string; state: string; changes: string }, binds: [string, string][], body: string): unknown {
  const script = `import { createRemoteFileSystem } from ${JSON.stringify(new URL('../src/remote/files.ts', import.meta.url).href)};
    import { createChangeLog } from ${JSON.stringify(new URL('../src/changeLog.ts', import.meta.url).href)};
    import fs from 'node:fs';
    const files = createRemoteFileSystem({ home: ${JSON.stringify(where.home)}, hermesHome: ${JSON.stringify(where.hermes)}, stateDirectory: ${JSON.stringify(where.state)}, changeLog: createChangeLog({ file: ${JSON.stringify(where.changes)} }) });
    const context = { guard() {}, actor: ${JSON.stringify(PHONE)}, deviceId: ${JSON.stringify(PHONE.id)} };
    const version = (file) => { const stat = fs.lstatSync(file, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }; };
    const attempt = async (run) => { try { await run(); return 'done'; } catch (error) { return error.code ?? String(error); } };
    const save = async (file, text) => {
      const bytes = Buffer.from(text);
      const { id } = files.startSave({ size: bytes.length }, context);
      files.saveChunk(id, '0', bytes, context);
      return files.commitSave(id, { path: file, version: files.read({ path: file }).version, format: { encoding: 'utf-8', bom: false } }, context);
    };
    console.log(JSON.stringify(await (async () => { ${body} })()));`;
  return JSON.parse(execFileSync('unshare', ['-rm', 'sh', '-c', 'while [ $# -gt 1 ]; do mount --bind "$1" "$2" || exit 1; shift 2; done; exec node --input-type=module -e "$1"',
    'sh', ...binds.flat(), script], { encoding: 'utf8' }));
}
