// Uploads and downloads on a real disk (#87): larger than a chunk, any size, never whole in memory,
// published only when complete, cancelled and revoked without leaving anything behind.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { REMOTE_FILE_TRANSFERS_PER_DEVICE } from '../../protocol/remoteFiles.ts';
import type { FileWriteContext, RemoteFileSystem } from '../src/remote/ports.ts';
import { lab, needsNamespaces, ok, PHONE, rejects, snapshot, withBinds } from '../support/filesLab.ts';

const root = process.getuid?.() === 0;
const MiB = REMOTE_LIMITS.transferChunkBytes;
const umask = (() => { const mask = process.umask(0o022); process.umask(mask); return mask; })();

/** A payload of `length` bytes that differ from one chunk to the next. */
const payload = (length: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 7 + (index >> 20)) & 0xff));
const temporaries = (directory: string) => fs.readdirSync(directory).filter((name) => name.startsWith('.relay-upload-'));
const other = (id: string): FileWriteContext => ({ ...ok, deviceId: id, actor: { kind: 'device', id, name: 'tablet' } });

/** Starts an upload and sends every chunk; the commit is the caller's. */
function send(files: RemoteFileSystem, directory: string, name: string, bytes: Buffer, size?: number, context = ok) {
  const { id } = files.startUpload({ directory, name, ...(size === undefined ? {} : { size }) }, context);
  for (let offset = 0; offset < bytes.length; offset += MiB) files.uploadChunk(id, String(offset), bytes.subarray(offset, offset + MiB), context);
  return id;
}

/** Every chunk of a download, in order, and the state its cancel answers afterwards. */
function receive(files: RemoteFileSystem, file: string, context = ok) {
  const download = files.startDownload({ path: file }, context);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < download.size; offset += MiB) chunks.push(files.downloadChunk(download.id, String(offset), context));
  return { download, bytes: Buffer.concat(chunks) };
}

test('an upload larger than a chunk, of unknown size, appears whole under its name only at the commit', async (t) => {
  const { home, files, records, changes } = lab(t);
  const docs = path.join(home, 'docs');
  const bytes = payload(2 * MiB + 12_345);
  const id = send(files, docs, 'big.bin', bytes);
  // Until the commit the name does not exist; the bytes wait in a private temporary file there.
  const [temporary] = temporaries(docs);
  assert.ok(temporary);
  assert.deepEqual([fs.existsSync(path.join(docs, 'big.bin')), fs.statSync(path.join(docs, temporary)).mode & 0o777, fs.statSync(path.join(docs, temporary)).size], [false, 0o600, bytes.length]);
  const entry = await files.commitUpload(id, {}, ok);
  assert.deepEqual([entry.name, entry.type, entry.size, entry.mode], ['big.bin', 'file', bytes.length, 0o666 & ~umask]);
  assert.ok(fs.readFileSync(path.join(docs, 'big.bin')).equals(bytes));
  assert.deepEqual(temporaries(docs), []);
  assert.deepEqual(files.cancel(id, ok), { id, state: 'completed' });
  assert.deepEqual(records().map((record) => [record.action, record.target]), [['remote.file.create', { kind: 'server', id: 'local' }]]);
  assert.doesNotMatch(fs.readFileSync(changes, 'utf8'), /big|docs|op_/);
});

test('a declared size is checked against free space and the chunks, and the commit needs all of it', async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  await rejects('remote_no_space', () => files.startUpload({ directory: docs, name: 'huge', size: 2 ** 52 }, ok));
  assert.deepEqual(temporaries(docs), []);
  const { id } = files.startUpload({ directory: docs, name: 'four', size: 4 }, ok);
  await rejects('remote_too_large', () => files.uploadChunk(id, '0', Buffer.from('12345'), ok));
  files.uploadChunk(id, '0', Buffer.from('12'), ok);
  // A retried chunk lands again; a gap or a non-canonical offset is refused.
  files.uploadChunk(id, '0', Buffer.from('12'), ok);
  for (const offset of ['3', '02', '-1', '1e1', '']) await rejects('remote_invalid_request', () => files.uploadChunk(id, offset, Buffer.from('3'), ok), offset);
  await rejects('remote_invalid_request', () => files.commitUpload(id, {}, ok));
  assert.equal(fs.existsSync(path.join(docs, 'four')), false);
  files.uploadChunk(id, '2', Buffer.from('34'), ok);
  await files.commitUpload(id, {}, ok);
  assert.equal(fs.readFileSync(path.join(docs, 'four'), 'utf8'), '1234');
  for (const body of [{ directory: docs }, { directory: docs, name: 'a/b' }, { directory: docs, name: 'x', size: -1 }, { directory: docs, name: 'x', size: 1.5 }, { directory: 'docs', name: 'x' }, { directory: docs, name: 'x', extra: 1 }]) {
    await rejects('remote_invalid_request', () => files.startUpload(body, ok), JSON.stringify(body));
  }
});

test('cancelling an upload, or its device being revoked, removes its temporary file and publishes nothing', async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  const before = snapshot(home);
  const cancelled = send(files, docs, 'half.bin', payload(MiB + 1));
  assert.equal(temporaries(docs).length, 1);
  assert.deepEqual(files.cancel(cancelled, ok), { id: cancelled, state: 'cancelled' });
  assert.deepEqual(files.cancel(cancelled, ok), { id: cancelled, state: 'cancelled' });
  await rejects('remote_ended', () => files.uploadChunk(cancelled, String(MiB + 1), Buffer.from('x'), ok));
  await rejects('remote_ended', () => files.commitUpload(cancelled, {}, ok));
  assert.deepEqual(snapshot(home), before);

  // Revocation: every transfer of the device ends at once and its temporary files go; others stay.
  const tablet = other('00000000-0000-4000-8000-000000000002');
  const revoked = send(files, docs, 'revoked.bin', payload(MiB + 1));
  const download = files.startDownload({ path: path.join(home, 'docs', 'a.txt') }, ok);
  const kept = send(files, docs, 'kept.bin', Buffer.from('tablet'), undefined, tablet);
  files.retain(new Set([tablet.deviceId]));
  assert.equal(temporaries(docs).length, 1);
  await rejects('remote_not_found', () => files.uploadChunk(revoked, '0', Buffer.from('x'), ok));
  await rejects('remote_not_found', () => files.downloadChunk(download.id, '0', ok));
  await files.commitUpload(kept, {}, tablet);
  assert.deepEqual([fs.existsSync(path.join(docs, 'revoked.bin')), fs.readFileSync(path.join(docs, 'kept.bin'), 'utf8'), temporaries(docs)], [false, 'tablet', []]);
});

test('a revocation while the commit waits for its record publishes nothing and leaves no temporary file', async (t) => {
  const { home, files, during } = lab(t);
  const docs = path.join(home, 'docs');
  const id = send(files, docs, 'late.bin', Buffer.from('late'));
  during(() => files.retain(new Set()));
  await rejects('remote_cancelled', () => files.commitUpload(id, {}, ok));
  assert.deepEqual([fs.existsSync(path.join(docs, 'late.bin')), temporaries(docs)], [false, []]);
});

test('a folder moved into a profile while the commit waits for its record publishes nothing there', async (t) => {
  const { home, hermes, files, during, version } = lab(t);
  const p1 = path.join(hermes, 'profiles', 'p1');
  const docs = path.join(home, 'docs');
  const created = send(files, docs, 'new.txt', Buffer.from('mine'));
  during(() => fs.renameSync(docs, path.join(p1, 'moved')));
  await rejects('remote_conflict', () => files.commitUpload(created, {}, ok));
  assert.equal(fs.existsSync(path.join(p1, 'moved', 'new.txt')), false);

  // A replacement there would overwrite a profile file without keeping its previous version.
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'a.txt'), 'before');
  const seen = version(path.join(notes, 'a.txt'));
  const replacing = send(files, notes, 'a.txt', Buffer.from('after'));
  during(() => fs.renameSync(notes, path.join(p1, 'notes')));
  await rejects('remote_conflict', () => files.commitUpload(replacing, { replace: seen }, ok));
  assert.equal(fs.readFileSync(path.join(p1, 'notes', 'a.txt'), 'utf8'), 'before');
});

test('an upload\'s temporary file, or one a crash left behind, is never listed nor found', async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  send(files, docs, 'filling.bin', Buffer.from('partial'));
  fs.writeFileSync(path.join(docs, `.relay-upload-${'0'.repeat(24)}`), 'left by a crash', { mode: 0o600 });
  fs.writeFileSync(path.join(docs, '.relay-upload-notes'), 'a name of the person');
  assert.equal(temporaries(docs).length, 3);
  const listed = (await files.list({ path: docs, hidden: true })).entries.map((entry) => entry.name).sort();
  assert.deepEqual(listed, ['.relay-upload-notes', 'a.txt']);
  const { id } = files.startSearch({ path: docs, query: 'relay-upload', hidden: true }, ok);
  const matches: string[] = [];
  const ended = Promise.withResolvers<void>();
  files.events(id, undefined, ok).start((event) => {
    if (event.type === 'results') matches.push(...event.matches.map((match) => match.entry.name));
    else ended.resolve();
  }, () => {});
  await ended.promise;
  assert.deepEqual(matches, ['.relay-upload-notes']);
});

test('an existing name is replaced only with the version the person confirmed, keeping its owner and permission bits', async (t) => {
  const { home, outside, files, version } = lab(t);
  const docs = path.join(home, 'docs');
  const a = path.join(docs, 'a.txt');
  fs.chmodSync(a, 0o640);
  const seen = version(a);
  const id = send(files, docs, 'a.txt', Buffer.from('nuevo'));
  // A refused commit leaves the upload open.
  await rejects('remote_confirmation_required', () => files.commitUpload(id, {}, ok));
  await rejects('remote_conflict', () => files.commitUpload(id, { replace: { ...seen, mtimeNs: '1' } }, ok));
  assert.equal(fs.readFileSync(a, 'utf8'), 'hello');
  const replaced = await files.commitUpload(id, { replace: seen }, ok);
  assert.deepEqual([fs.readFileSync(a, 'utf8'), replaced.mode, temporaries(docs)], ['nuevo', 0o640, []]);
  assert.notEqual(replaced.version.ino, seen.ino);

  // A name that appears after the person looked is not overwritten without confirming it.
  const late = send(files, docs, 'appears.txt', Buffer.from('mine'));
  fs.writeFileSync(path.join(docs, 'appears.txt'), 'theirs');
  await rejects('remote_confirmation_required', () => files.commitUpload(late, {}, ok));
  fs.unlinkSync(path.join(docs, 'appears.txt'));
  await rejects('remote_conflict', () => files.commitUpload(late, { replace: seen }, ok));
  await files.commitUpload(late, {}, ok);
  assert.equal(fs.readFileSync(path.join(docs, 'appears.txt'), 'utf8'), 'mine');

  // Through a link the destination is written and the link stays a link; a folder is never replaced.
  fs.symlinkSync(path.join(outside, 'f'), path.join(docs, 'to-f'));
  const linked = send(files, docs, 'to-f', Buffer.from('through the link'));
  await files.commitUpload(linked, { replace: version(path.join(docs, 'to-f')) }, ok);
  assert.deepEqual([fs.readFileSync(path.join(outside, 'f'), 'utf8'), fs.lstatSync(path.join(docs, 'to-f')).isSymbolicLink(), temporaries(docs)], ['through the link', true, []]);
  fs.mkdirSync(path.join(docs, 'folder'));
  const folder = send(files, docs, 'folder', Buffer.from('x'));
  await rejects('remote_exists', () => files.commitUpload(folder, { replace: version(path.join(docs, 'folder')) }, ok));
  files.cancel(folder, ok);
  assert.deepEqual(temporaries(docs), []);
});

test('replacing a file with other links or of another account is refused before anything changes', { skip: root ? 'running as root' : false }, async (t) => {
  const { home, files, version } = lab(t);
  const docs = path.join(home, 'docs');
  fs.linkSync(path.join(docs, 'a.txt'), path.join(home, 'hard'));
  const id = send(files, docs, 'a.txt', Buffer.from('x'));
  await rejects('remote_not_replaceable', () => files.commitUpload(id, { replace: version(path.join(docs, 'a.txt')) }, ok));
  assert.equal(fs.readFileSync(path.join(home, 'hard'), 'utf8'), 'hello');
});

test('uploading into a profile keeps the previous version first; the Puente state is refused before a byte lands', async (t) => {
  const { home, hermes, state, config, files, version, records, kept } = lab(t);
  const p1 = path.join(hermes, 'profiles', 'p1');
  const id = send(files, p1, 'SOUL.md', Buffer.from('alma subida'));
  await files.commitUpload(id, { replace: version(path.join(p1, 'SOUL.md')) }, ok);
  const record = records().at(-1)!;
  assert.deepEqual([fs.readFileSync(path.join(p1, 'SOUL.md'), 'utf8'), record.action, record.details, kept(record)], ['alma subida', 'remote.file.write', { profile: true, previous: true }, 'p1 soul']);
  // The same backup ceiling as every profile write: a file it cannot keep is done on the computer.
  fs.writeFileSync(path.join(p1, 'big.db'), Buffer.alloc(REMOTE_LIMITS.editableTextBytes + 1));
  const big = send(files, p1, 'big.db', Buffer.from('small'));
  await rejects('remote_profile_protected', () => files.commitUpload(big, { replace: version(path.join(p1, 'big.db')) }, ok));
  assert.equal(fs.statSync(path.join(p1, 'big.db')).size, REMOTE_LIMITS.editableTextBytes + 1);
  files.cancel(big, ok);
  // A new file in a profile is a profile write with nothing to keep.
  await files.commitUpload(send(files, p1, 'notes.md', Buffer.from('n')), {}, ok);
  assert.deepEqual(records().at(-1)!.details, { profile: true, previous: false });

  fs.mkdirSync(config, { recursive: true });
  const before = [snapshot(state), snapshot(config)];
  for (const directory of [state, config]) await rejects('remote_bridge_protected', () => files.startUpload({ directory, name: 'x' }, ok), directory);
  await rejects('remote_profile_protected', () => files.startUpload({ directory: path.join(hermes, 'profiles'), name: 'p1' }, ok));
  assert.deepEqual([snapshot(state), snapshot(config), temporaries(path.join(hermes, 'profiles'))], [...before, []]);
  assert.equal(fs.existsSync(path.join(home, 'docs', 'x')), false);
});

test('a download larger than a chunk arrives whole, and completes only with its last chunk', async (t) => {
  const { home, outside, files } = lab(t);
  const file = path.join(home, 'docs', 'big.bin');
  const bytes = payload(2 * MiB + 7);
  fs.writeFileSync(file, bytes);
  fs.symlinkSync(file, path.join(outside, 'to-big'));
  const download = files.startDownload({ path: path.join(outside, 'to-big') }, ok);
  assert.deepEqual([download.path, download.realPath, download.size], [path.join(outside, 'to-big'), file, bytes.length]);
  const first = files.downloadChunk(download.id, '0', ok);
  assert.equal(first.length, MiB);
  // A retried chunk is served again; until the last one the download is still running.
  assert.ok(files.downloadChunk(download.id, '0', ok).equals(first));
  const second = files.downloadChunk(download.id, String(MiB), ok);
  assert.deepEqual(files.cancel(download.id, ok), { id: download.id, state: 'cancelled' });
  await rejects('remote_ended', () => files.downloadChunk(download.id, String(2 * MiB), ok));
  assert.equal(second.length, MiB);

  const whole = receive(files, file);
  assert.ok(whole.bytes.equals(bytes));
  assert.deepEqual(files.cancel(whole.download.id, ok), { id: whole.download.id, state: 'completed' });
  for (const offset of [String(bytes.length), '01', 'x']) await rejects('remote_invalid_request', () => files.downloadChunk(files.startDownload({ path: file }, ok).id, offset, ok), offset);

  // An empty file is complete at once.
  fs.writeFileSync(path.join(home, 'empty'), '');
  const empty = files.startDownload({ path: path.join(home, 'empty') }, ok);
  assert.deepEqual([empty.size, files.cancel(empty.id, ok).state], [0, 'completed']);
});

test('a file that changes while it downloads fails the download instead of arriving mixed', async (t) => {
  const { home, files } = lab(t);
  const file = path.join(home, 'docs', 'growing.log');
  fs.writeFileSync(file, payload(MiB + 10));
  const download = files.startDownload({ path: file }, ok);
  files.downloadChunk(download.id, '0', ok);
  fs.appendFileSync(file, 'more');
  await rejects('remote_conflict', () => files.downloadChunk(download.id, String(MiB), ok));
  assert.deepEqual(files.cancel(download.id, ok), { id: download.id, state: 'failed' });
});

test('special files are never downloaded and nothing waits on them', async (t) => {
  const { home, files } = lab(t);
  const fifo = path.join(home, 'pipe');
  execFileSync('mkfifo', [fifo]);
  for (const special of [fifo, '/dev/zero', home]) await rejects('remote_invalid_request', () => files.startDownload({ path: special }, ok), special);
  await rejects('remote_not_found', () => files.startDownload({ path: path.join(home, 'missing') }, ok));
});

test('transfers belong to their device and are limited per device', async (t) => {
  const { home, files } = lab(t);
  const docs = path.join(home, 'docs');
  const tablet = other('00000000-0000-4000-8000-000000000002');
  const mine = files.startUpload({ directory: docs, name: 'mine' }, ok);
  await rejects('remote_not_found', () => files.uploadChunk(mine.id, '0', Buffer.from('x'), tablet));
  await rejects('remote_not_found', () => files.downloadChunk(mine.id, '0', ok));
  await rejects('remote_not_found', () => files.cancel(mine.id, tablet));
  for (let index = 1; index < REMOTE_FILE_TRANSFERS_PER_DEVICE; index++) files.startDownload({ path: path.join(docs, 'a.txt') }, ok);
  await rejects('remote_limit_reached', () => files.startUpload({ directory: docs, name: 'one-more' }, ok));
  assert.equal(temporaries(docs).length, 1);
  files.startUpload({ directory: docs, name: 'tablet' }, tablet);
  files.cancel(mine.id, ok);
  files.startUpload({ directory: docs, name: 'room-again' }, ok);
});

test('a full disk ends the upload with its fixed error and leaves neither the name nor the temporary file', { skip: needsNamespaces }, (t) => {
  const { home, state, changes } = lab(t);
  const small = path.join(home, 'small');
  fs.mkdirSync(small);
  // A 1 MiB tmpfs that exists only in the child's mount namespace: a real ENOSPC, no double.
  const script = `import { createRemoteFileSystem } from ${JSON.stringify(new URL('../src/remote/files.ts', import.meta.url).href)};
    import { createChangeLog } from ${JSON.stringify(new URL('../src/changeLog.ts', import.meta.url).href)};
    import fs from 'node:fs';
    const changeLog = createChangeLog({ file: ${JSON.stringify(changes)} });
    const files = createRemoteFileSystem({ home: ${JSON.stringify(home)}, hermesHome: ${JSON.stringify(path.join(home, '.hermes'))}, stateDirectory: ${JSON.stringify(state)}, changeLog });
    const context = { guard() {}, actor: ${JSON.stringify(PHONE)}, deviceId: ${JSON.stringify(PHONE.id)} };
    const { id } = files.startUpload({ directory: ${JSON.stringify(small)}, name: 'big.bin' }, context);
    const chunk = Buffer.alloc(${MiB}, 1);
    const results = [];
    for (let offset = 0; offset < 3 * chunk.length; offset += chunk.length) {
      try { files.uploadChunk(id, String(offset), chunk, context); results.push('ok'); } catch (error) { results.push(error.code + ' ' + error.message); break; }
    }
    results.push(files.cancel(id, context).state, JSON.stringify(fs.readdirSync(${JSON.stringify(small)})));
    console.log(JSON.stringify(results));`;
  const output = execFileSync('unshare', ['-rm', 'sh', '-c', 'mount -t tmpfs -o size=1m tmpfs "$1" && exec node --input-type=module -e "$2"', 'sh', small, script], { encoding: 'utf8' });
  // The first MiB fits; the second does not.
  assert.deepEqual(JSON.parse(output), ['ok', 'remote_no_space No queda espacio en el Servidor para esta operación.', 'failed', '[]']);
});

test('a bind of the Puente state or of a profile does not hide an upload destination', { skip: needsNamespaces }, (t) => {
  const laboratory = lab(t);
  const { home, hermes, state } = laboratory;
  const [stateBind, profileBind] = [path.join(home, 'docs', 'state-bind'), path.join(home, 'docs', 'profile-bind')];
  for (const directory of [stateBind, profileBind]) fs.mkdirSync(directory);
  const results = withBinds(laboratory, [[state, stateBind], [path.join(hermes, 'profiles'), profileBind]], `return [
      await attempt(() => files.startUpload({ directory: ${JSON.stringify(stateBind)}, name: 'x' }, context)),
      await attempt(() => files.startUpload({ directory: ${JSON.stringify(profileBind)}, name: 'p1' }, context)),
    ];`);
  assert.deepEqual(results, ['remote_bridge_protected', 'remote_profile_protected']);
  assert.deepEqual(fs.readdirSync(state).filter((name) => name.startsWith('.relay-upload-')), []);
});
