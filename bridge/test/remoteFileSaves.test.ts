// The editor's read and save on a real disk: whole reads of regular files, saves in chunks committed
// next to the version read, profiles kept first, and nothing published without its record.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { REMOTE_FILE_OPERATION_IDLE_MS, REMOTE_FILE_SAVES_PER_DEVICE, REMOTE_FILE_SAVES_TOTAL, type RemoteFileContentVersion } from '../../protocol/remoteFiles.ts';
import type { TextFormat } from '../../protocol/textCodec.ts';
import type { FileWriteContext, RemoteFileSystem } from '../src/remote/ports.ts';
import { lab, ok, rejects, snapshot } from '../support/filesLab.ts';

const root = process.getuid?.() === 0;
const UTF8: TextFormat = { encoding: 'utf-8', bom: false };
const MiB = REMOTE_LIMITS.transferChunkBytes;

/** Opens a save, sends its bytes in chunks and commits it. */
async function save(files: RemoteFileSystem, file: string, bytes: Buffer, version: RemoteFileContentVersion, format = UTF8, context: FileWriteContext = ok) {
  const { id } = files.startSave({ size: bytes.length }, context);
  for (let offset = 0; offset < bytes.length; offset += MiB) files.saveChunk(id, String(offset), bytes.subarray(offset, offset + MiB), context);
  return { id, saved: await files.commitSave(id, { path: file, version, format }, context) };
}

const temporaries = (directory: string) => fs.readdirSync(directory).filter((name) => name.startsWith('.relay-save-'));
const other = (id: string): FileWriteContext => ({ ...ok, deviceId: id, actor: { kind: 'device', id, name: 'tablet' } });

test('the editor reads a regular file whole, where it really is, with the version it saves against', async (t) => {
  const { home, files } = lab(t);
  const a = path.join(home, 'docs', 'a.txt');
  fs.symlinkSync(a, path.join(home, 'link-a'));
  const stat = fs.statSync(a, { bigint: true });
  const read = files.read({ path: path.join(home, 'link-a') });
  assert.deepEqual(read, {
    path: path.join(home, 'link-a'), realPath: a, bytes: Buffer.from('hello').toString('base64'), protection: null,
    version: { dev: String(stat.dev), ino: String(stat.ino), size: 5, mtimeNs: String(stat.mtimeNs), sha256: createHash('sha256').update('hello').digest('hex') },
  });
  // 5 MiB measured on the bytes on disk.
  const limit = path.join(home, 'limit.txt');
  fs.writeFileSync(limit, Buffer.alloc(REMOTE_LIMITS.editableTextBytes, 0x61));
  assert.equal(Buffer.from(files.read({ path: limit }).bytes, 'base64').length, REMOTE_LIMITS.editableTextBytes);
  fs.appendFileSync(limit, 'a');
  await rejects('remote_too_large', () => files.read({ path: limit }));
});

test('an entry swapped after its check is never read: a FIFO does not wait, a link is not followed, another file is a conflict', async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  /** Runs `swap` on the real path right after the read's lstat saw the regular file: the window before the open. */
  const afterCheck = (name: string, swap: (real: string) => void) => {
    fs.writeFileSync(path.join(docs, name), 'checked');
    const lstat = fs.lstatSync;
    const mocked = t.mock.method(fs, 'lstatSync', ((entry: string, options: fs.StatSyncOptions) => {
      const stat = lstat(entry, options);
      if (typeof entry === 'string' && entry.startsWith('/proc/self/fd/') && entry.endsWith(`/${name}`)) {
        mocked.mock.restore();
        swap(path.join(fs.readlinkSync(path.dirname(entry)), name));
      }
      return stat;
    }) as typeof fs.lstatSync);
    return path.join(docs, name);
  };
  // A FIFO: opening it must not wait for a writer. One comes after 3 s, so waiting shows as time, not a hang.
  const fifo = afterCheck('fifo', (real) => {
    fs.unlinkSync(real);
    execFileSync('mkfifo', [real]);
    const writer = spawn('sh', ['-c', 'sleep 3; : > "$1"', 'sh', real], { stdio: 'ignore' });
    t.after(() => writer.kill());
  });
  const started = performance.now();
  await rejects('remote_conflict', () => files.read({ path: fifo }), 'fifo');
  assert.ok(performance.now() - started < 2000, 'the FIFO was opened without waiting');
  // A link to the very file, moved aside: following it would read the same object.
  const link = afterCheck('link', (real) => { fs.renameSync(real, `${real}.moved`); fs.symlinkSync(`${real}.moved`, real); });
  await rejects('remote_not_found', () => files.read({ path: link }), 'link');
  // Another regular file under the same name.
  const other = afterCheck('other', (real) => { fs.renameSync(real, `${real}.old`); fs.writeFileSync(real, 'replacement'); });
  await rejects('remote_conflict', () => files.read({ path: other }), 'other file');
});

test('a save goes in chunks and replaces the file atomically with its owner, group and permission bits', async (t) => {
  const { home, files, records } = lab(t);
  const file = path.join(home, 'docs', 'big.txt');
  const original = Buffer.from('línea\r\n'.repeat(400_000));
  fs.writeFileSync(file, original);
  fs.chmodSync(file, 0o640);
  const before = fs.statSync(file);
  const opened = files.read({ path: file });
  const changed = Buffer.concat([original, Buffer.from('añadida\n')]);
  const { saved } = await save(files, file, changed, opened.version);
  assert.ok(changed.length > 2 * MiB);
  const after = fs.statSync(file);
  assert.deepEqual([fs.readFileSync(file).equals(changed), after.mode & 0o7777, after.uid, after.gid], [true, 0o640, before.uid, before.gid]);
  // A new file renamed into place, never written where the old one was.
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual(saved, { path: file, realPath: file, version: files.read({ path: file }).version });
  assert.deepEqual(temporaries(path.dirname(file)), []);
  assert.deepEqual(records().map((record) => [record.action, record.details]), [['remote.file.write', undefined]]);

  // Saving again from the version the save answered needs nothing else; the same bytes stay the same bytes.
  const utf16 = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x62, 0x00, 0x0a, 0x00]);
  await save(files, file, utf16, saved.version, { encoding: 'utf-16le', bom: true });
  await save(files, file, utf16, files.read({ path: file }).version, { encoding: 'utf-16le', bom: true });
  assert.deepEqual(fs.readFileSync(file), utf16);
});

test('chunks land at or before what arrived, never past the declared size, and a commit needs every byte in its format', async (t) => {
  const { home, files } = lab(t);
  const file = path.join(home, 'docs', 'a.txt');
  const { version } = files.read({ path: file });
  await rejects('remote_too_large', () => files.startSave({ size: REMOTE_LIMITS.editableTextBytes + 1 }, ok));
  for (const size of [-1, 1.5, '3', null]) await rejects('remote_invalid_request', () => files.startSave({ size }, ok), String(size));
  const { id } = files.startSave({ size: 6 }, ok);
  assert.deepEqual(files.saveChunk(id, '0', Buffer.from('wor'), ok), { id, size: 6, received: 3 });
  // A retried chunk lands again; a gap or a non-canonical offset is refused.
  assert.equal(files.saveChunk(id, '0', Buffer.from('wor'), ok).received, 3);
  for (const offset of ['4', '03', '-1', '1e3', '']) await rejects('remote_invalid_request', () => files.saveChunk(id, offset, Buffer.from('x'), ok), offset);
  await rejects('remote_too_large', () => files.saveChunk(id, '3', Buffer.from('ld!!'), ok));
  await rejects('remote_invalid_request', () => files.commitSave(id, { path: file, version, format: UTF8 }, ok), 'incomplete');
  files.saveChunk(id, '3', Buffer.from('ld!'), ok);
  // Not text in the format the commit says: no UTF-16 BOM at the start.
  await rejects('remote_invalid_request', () => files.commitSave(id, { path: file, version, format: { encoding: 'utf-16le', bom: true } }, ok));
  await rejects('remote_invalid_request', () => files.commitSave(id, { path: file, version, format: { encoding: 'latin1', bom: false } }, ok));
  await rejects('remote_invalid_request', () => files.commitSave(id, { path: file, version: { ...version, size: '5' }, format: UTF8 }, ok));
  // ADR 0006 case 2: `..` is refused, never normalized.
  await rejects('remote_invalid_request', () => files.commitSave(id, { path: `${path.dirname(file)}/../docs/a.txt`, version, format: UTF8 }, ok));
  const invalidUtf8 = files.startSave({ size: 1 }, ok);
  files.saveChunk(invalidUtf8.id, '0', Buffer.from([0xc3]), ok);
  await rejects('remote_invalid_request', () => files.commitSave(invalidUtf8.id, { path: file, version, format: UTF8 }, ok));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  await files.commitSave(id, { path: file, version, format: UTF8 }, ok);
  assert.equal(fs.readFileSync(file, 'utf8'), 'world!');
  // A committed save is over.
  await rejects('remote_ended', () => files.saveChunk(id, '0', Buffer.from('x'), ok));
  await rejects('remote_ended', () => files.commitSave(id, { path: file, version, format: UTF8 }, ok));
});

test('compare-and-save next to the commit: a change since the editor read it, or during the commit, is a conflict and the draft stays', async (t) => {
  const { home, files, during } = lab(t);
  const file = path.join(home, 'docs', 'a.txt');
  const draft = Buffer.from('draft');
  const opened = files.read({ path: file }).version;
  const { id } = files.startSave({ size: draft.length }, ok);
  files.saveChunk(id, '0', draft, ok);

  // Changed on the Server after the editor read it.
  fs.writeFileSync(file, 'other');
  await rejects('remote_conflict', () => files.commitSave(id, { path: file, version: opened, format: UTF8 }, ok));
  assert.equal(fs.readFileSync(file, 'utf8'), 'other');
  // Changed after the commit's own check, while it waits for its record.
  const current = files.read({ path: file }).version;
  during(() => fs.writeFileSync(file, 'later'));
  await rejects('remote_conflict', () => files.commitSave(id, { path: file, version: current, format: UTF8 }, ok));
  assert.equal(fs.readFileSync(file, 'utf8'), 'later');
  // Replaced by another file with the same content.
  const replaced = files.read({ path: file }).version;
  fs.writeFileSync(`${file}.new`, 'later');
  fs.renameSync(`${file}.new`, file);
  await rejects('remote_conflict', () => files.commitSave(id, { path: file, version: replaced, format: UTF8 }, ok));
  assert.deepEqual(temporaries(path.dirname(file)), []);
  // The same size and modification time, other content: only the SHA-256 tells.
  fs.utimesSync(file, 1000, 1000);
  const stamped = files.read({ path: file }).version;
  fs.writeFileSync(file, 'LATER');
  fs.utimesSync(file, 1000, 1000);
  await rejects('remote_conflict', () => files.commitSave(id, { path: file, version: stamped, format: UTF8 }, ok), 'content only');
  // The same content touched: only the modification time tells.
  const touched = files.read({ path: file }).version;
  fs.utimesSync(file, 2000, 2000);
  await rejects('remote_conflict', () => files.commitSave(id, { path: file, version: touched, format: UTF8 }, ok), 'time only');
  assert.deepEqual([fs.readFileSync(file, 'utf8'), temporaries(path.dirname(file))], ['LATER', []]);

  // Overwriting is a commit of the same draft over the state read again, which the person confirmed.
  await files.commitSave(id, { path: file, version: files.read({ path: file }).version, format: UTF8 }, ok);
  assert.equal(fs.readFileSync(file, 'utf8'), 'draft');
});

test('a folder moved into a profile while the commit waits for its record is a conflict, never an unkept profile write', async (t) => {
  const { home, hermes, files, during, records, backups } = lab(t);
  const file = path.join(home, 'docs', 'a.txt');
  const moved = path.join(hermes, 'profiles', 'p1', 'docs');
  during(() => fs.renameSync(path.join(home, 'docs'), moved));
  await rejects('remote_conflict', () => save(files, file, Buffer.from('new'), files.read({ path: file }).version));
  assert.deepEqual([fs.readFileSync(path.join(moved, 'a.txt'), 'utf8'), temporaries(moved), backups()], ['hello', [], []]);
  assert.deepEqual(records().map((record) => record.details), [undefined]);
});

test('a folder moved into a profile while the temporary is written is a conflict, never an unkept profile write', async (t) => {
  const { home, hermes, files, records, backups } = lab(t);
  const file = path.join(home, 'docs', 'a.txt');
  const moved = path.join(hermes, 'profiles', 'p1', 'docs');
  const open = fs.openSync;
  let done = false;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (!done && String(args[0]).includes('/.relay-save-')) { done = true; fs.renameSync(path.join(home, 'docs'), moved); }
    return fd;
  });
  await rejects('remote_conflict', () => save(files, file, Buffer.from('new'), files.read({ path: file }).version));
  assert.deepEqual([done, fs.readFileSync(path.join(moved, 'a.txt'), 'utf8'), temporaries(moved), backups()], [true, 'hello', [], []]);
  assert.deepEqual(records().map((record) => record.details), [undefined]);
});

test('the temporary is written only after the classification, the backup and the record', async (t) => {
  const { hermes, state, files, records, backups } = lab(t);
  const open = fs.openSync;
  // Records and backups on disk at the moment each temporary is created.
  const created: [number, number][] = [];
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes('/.relay-save-')) created.push([records().length, backups().length]);
    return open(...args);
  });
  const devices = path.join(state, 'devices.json');
  await rejects('remote_bridge_protected', () => save(files, devices, Buffer.from('x'), files.read({ path: devices }).version));
  const soul = path.join(hermes, 'SOUL.md');
  await save(files, soul, Buffer.from('nueva'), files.read({ path: soul }).version);
  assert.deepEqual(created, [[1, 1]]);
});

test('a commit never changes what a rename cannot replace as it was', { skip: root ? 'running as root' : false }, async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  const a = path.join(docs, 'a.txt');
  const bytes = Buffer.from('new');
  // Another hard link: renaming would split it from the file it shares.
  fs.linkSync(a, path.join(home, 'hard'));
  await rejects('remote_not_replaceable', () => save(files, a, bytes, files.read({ path: a }).version));
  fs.unlinkSync(path.join(home, 'hard'));
  // A folder that does not admit the temporary: never written in place.
  fs.chmodSync(docs, 0o555);
  await rejects('remote_permission_denied', () => save(files, a, bytes, files.read({ path: a }).version));
  fs.chmodSync(docs, 0o755);
  // A FIFO at the path is not a file to replace, and the commit does not wait on it.
  execFileSync('mkfifo', [path.join(docs, 'pipe')]);
  await rejects('remote_invalid_request', () => save(files, path.join(docs, 'pipe'), bytes, files.read({ path: a }).version));
  assert.deepEqual([fs.readFileSync(a, 'utf8'), fs.readFileSync(path.join(home, 'docs', 'a.txt'), 'utf8'), temporaries(docs)], ['hello', 'hello', []]);
});

test('saving through a link to SOUL.md writes the profile where it really is, after keeping its previous version', async (t) => {
  const { home, hermes, state, files, records, kept, backups, changes } = lab(t);
  const soul = path.join(hermes, 'SOUL.md');
  const link = path.join(home, 'soul-link');
  fs.symlinkSync(soul, link);
  const opened = files.read({ path: link });
  assert.equal(opened.realPath, soul);
  const { saved } = await save(files, link, Buffer.from('nueva alma'), opened.version);
  assert.deepEqual([fs.readFileSync(soul, 'utf8'), fs.readlinkSync(link), saved.realPath], ['nueva alma', soul, soul]);
  const record = records().at(-1)!;
  assert.deepEqual([record.action, record.details, kept(record)], ['remote.file.write', { profile: true, previous: true }, 'default soul']);
  assert.doesNotMatch(fs.readFileSync(changes, 'utf8'), /alma|soul|SOUL/);

  // A backup that cannot be written stops the save before its record and its effect.
  if (!root) {
    fs.chmodSync(state, 0o500);
    await rejects('remote_unavailable', () => save(files, soul, Buffer.from('otra'), files.read({ path: soul }).version));
    fs.chmodSync(state, 0o700);
  }
  // So does a record that cannot be written: changes.jsonl no longer private.
  fs.chmodSync(changes, 0o640);
  await rejects('remote_unavailable', () => save(files, soul, Buffer.from('otra'), files.read({ path: soul }).version));
  fs.chmodSync(changes, 0o600);
  assert.deepEqual([fs.readFileSync(soul, 'utf8'), temporaries(hermes), records().length], ['nueva alma', [], 1]);
  assert.equal(backups().length, 2);
});

test('a save belongs to its device, is limited, cancels, and expires when abandoned', async (t) => {
  let clock = 1_700_000_000_000;
  const { home, files, during } = lab(t, { now: () => clock });
  const file = path.join(home, 'docs', 'a.txt');
  const mine = files.startSave({ size: 1 }, ok);
  await rejects('remote_not_found', () => files.saveChunk(mine.id, '0', Buffer.from('x'), other('00000000-0000-4000-8000-000000000002')));
  await rejects('remote_not_found', () => files.cancel(mine.id, other('00000000-0000-4000-8000-000000000002')));
  await rejects('remote_not_found', () => files.cancel('op_missing', ok));
  for (let index = 1; index < REMOTE_FILE_SAVES_PER_DEVICE; index++) files.startSave({ size: 1 }, ok);
  await rejects('remote_limit_reached', () => files.startSave({ size: 1 }, ok));
  for (let device = 2; device <= REMOTE_FILE_SAVES_TOTAL / REMOTE_FILE_SAVES_PER_DEVICE; device++) {
    for (let index = 0; index < REMOTE_FILE_SAVES_PER_DEVICE; index++) files.startSave({ size: 1 }, other(`00000000-0000-4000-8000-00000000000${device}`));
  }
  await rejects('remote_limit_reached', () => files.startSave({ size: 1 }, other('00000000-0000-4000-8000-000000000009')));

  // Cancelling is idempotent and answers what happened; a cancelled save takes nothing more.
  assert.deepEqual(files.cancel(mine.id, ok), { id: mine.id, state: 'cancelled' });
  assert.deepEqual(files.cancel(mine.id, ok), { id: mine.id, state: 'cancelled' });
  await rejects('remote_ended', () => files.saveChunk(mine.id, '0', Buffer.from('x'), ok));
  // Cancelled while its commit waits for the record: nothing is written.
  clock += REMOTE_FILE_OPERATION_IDLE_MS + 1;
  const { id } = files.startSave({ size: 3 }, ok);
  files.saveChunk(id, '0', Buffer.from('new'), ok);
  during(() => files.cancel(id, ok));
  await rejects('remote_cancelled', () => files.commitSave(id, { path: file, version: files.read({ path: file }).version, format: UTF8 }, ok));
  assert.deepEqual([fs.readFileSync(file, 'utf8'), temporaries(path.dirname(file))], ['hello', []]);
  // A committed save stays completed.
  const done = await save(files, file, Buffer.from('new'), files.read({ path: file }).version);
  assert.deepEqual(files.cancel(done.id, ok), { id: done.id, state: 'completed' });
  // The abandoned ones went with the idle sweep, so there is room again.
  await rejects('remote_not_found', () => files.cancel(mine.id, ok));
});

test('a revocation during the commit leaves the file as it was and no temporary behind', async (t) => {
  const { home, files, during } = lab(t);
  const file = path.join(home, 'docs', 'a.txt');
  let revokedNow = false;
  const late: FileWriteContext = { ...ok, guard() { if (revokedNow) throw new Error('device_revoked'); } };
  const before = snapshot(home);
  during(() => { revokedNow = true; });
  await assert.rejects(save(files, file, Buffer.from('late'), files.read({ path: file }).version, UTF8, late), /device_revoked/);
  assert.deepEqual(snapshot(home), before);
});
