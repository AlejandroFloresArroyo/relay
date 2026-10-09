// The file explorer service on a real disk: temporary trees, a synthetic Hermes home, real FIFOs,
// sockets and links. Nothing here touches the real home or ~/.hermes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { REMOTE_FILES_LIST_MAX } from '../../protocol/remoteFiles.ts';
import { exists, lab, needsNamespaces, ok, PHONE, rejects, revoked, snapshot, withBinds } from '../support/filesLab.ts';

const root = process.getuid?.() === 0;

test('the home is the entry point; dot entries only on request; each entry says type, size, permissions and versions as strings', async (t) => {
  const { home, files } = lab(t);
  fs.symlinkSync('docs', path.join(home, 'to-docs'));
  fs.symlinkSync('nowhere', path.join(home, 'broken'));
  const listed = await files.list({});
  assert.equal(listed.path, home);
  assert.equal(listed.realPath, home);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.entries.map((candidate) => candidate.name), ['broken', 'docs', 'to-docs']);
  assert.deepEqual((await files.list({ hidden: true })).entries.map((candidate) => candidate.name), ['.hermes', '.hidden', 'broken', 'docs', 'to-docs']);

  const file = path.join(home, 'docs', 'a.txt');
  fs.chmodSync(file, 0o640);
  const stat = fs.lstatSync(file, { bigint: true });
  const [listedFile] = (await files.list({ path: path.join(home, 'docs') })).entries;
  assert.deepEqual(listedFile, {
    name: 'a.txt', nameUtf8: true, type: 'file', size: 5, mode: 0o640, uid: Number(stat.uid), gid: Number(stat.gid),
    mtime: Number(stat.mtimeNs / 1_000_000n),
    version: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) },
  });
  const link = listed.entries.find((candidate) => candidate.name === 'to-docs')!;
  assert.equal(link.type, 'symlink');
  assert.deepEqual(link.link, { target: 'docs', realPath: path.join(home, 'docs'), type: 'directory' });
  assert.deepEqual(listed.entries.find((candidate) => candidate.name === 'broken')!.link, { target: 'nowhere', realPath: null, type: null });
  // Entering a link lists its destination, and says where that really is.
  const through = await files.list({ path: path.join(home, 'to-docs') });
  assert.deepEqual([through.path, through.realPath, through.entries.map((candidate) => candidate.name)], [path.join(home, 'to-docs'), path.join(home, 'docs'), ['a.txt']]);
});

test('special files are identified, never treated as regular, and nothing blocks on them', async (t) => {
  const { home, files, entry } = lab(t);
  const fifo = path.join(home, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(home, 'sock'), resolve));
  t.after(() => server.close());
  assert.equal((await entry(home, 'pipe')).type, 'fifo');
  assert.equal((await entry(home, 'sock')).type, 'socket');
  assert.equal((await files.list({ path: '/dev' })).entries.find((candidate) => candidate.name === 'null')?.type, 'char_device');
  // Opening a FIFO without a writer would block forever: listing or reading it answers at once.
  await rejects('remote_not_found', () => files.list({ path: fifo }));
  await rejects('remote_invalid_request', () => files.read({ path: fifo }));
  await rejects('remote_invalid_request', () => files.read({ path: path.join(home, 'sock') }));
  await rejects('remote_invalid_request', () => files.read({ path: '/dev/null' }));
  await rejects('remote_invalid_request', () => files.read({ path: path.join(home, 'docs') }));
  await rejects('remote_not_found', () => files.create({ directory: fifo, name: 'x', type: 'file' }, ok));
  await rejects('remote_exists', () => files.create({ directory: home, name: 'pipe', type: 'file' }, ok));
  await files.move({ path: fifo, version: (await entry(home, 'pipe')).version, directory: path.join(home, 'docs'), name: 'pipe' }, ok);
  assert.equal((await entry(path.join(home, 'docs'), 'pipe')).type, 'fifo');
  await files.delete({ path: path.join(home, 'docs', 'pipe'), version: (await entry(path.join(home, 'docs'), 'pipe')).version, confirm: true }, ok);
  await files.delete({ path: path.join(home, 'sock'), version: (await entry(home, 'sock')).version, confirm: true }, ok);
  assert.deepEqual([exists(path.join(home, 'docs', 'pipe')), exists(path.join(home, 'sock'))], [false, false]);
});

test('strange names are plain bytes: no shell ever sees them', async (t) => {
  const { home, files, entry } = lab(t);
  const strange = path.join(home, 'strange');
  await files.create({ directory: home, name: 'strange', type: 'directory' }, ok);
  const names = ['-rf', ' spaced ', 'line\nbreak', '$(touch pwned)', '`touch pwned`', '*', '; rm -rf ~', 'ñandú 🎉', 'back\\slash', '"quoted"', "'", '.dot', 'a'.repeat(255)];
  for (const name of names) assert.equal((await files.create({ directory: strange, name, type: 'file' }, ok)).name, name);
  assert.deepEqual((await files.list({ path: strange, hidden: true })).entries.map((candidate) => candidate.name).sort(), [...names].sort());
  for (const name of names) {
    const moved = await files.move({ path: path.join(strange, name), version: (await entry(strange, name)).version, directory: strange, name: `${name.slice(0, 250)}.old` }, ok);
    await files.delete({ path: path.join(strange, moved.name), version: moved.version, confirm: true }, ok);
  }
  assert.deepEqual(fs.readdirSync(strange), []);
  assert.equal(exists(path.join(home, 'pwned')) || exists(path.join(process.cwd(), 'pwned')), false);
});

test('a name that is not UTF-8 is listed but never confused with another file', async (t) => {
  const { home, files } = lab(t);
  const raw = Buffer.concat([Buffer.from(`${home}/`), Buffer.from([0x61, 0xff, 0x62])]);
  fs.writeFileSync(raw, 'raw bytes');
  const listed = (await files.list({ path: home })).entries.find((candidate) => !candidate.nameUtf8)!;
  assert.equal(listed.name, 'a\uFFFDb');
  await rejects('remote_not_found', () => files.delete({ path: path.join(home, listed.name), version: listed.version, confirm: true }, ok));
  // A real file with the replacement character is a different file: its version does not match.
  fs.writeFileSync(path.join(home, 'a\uFFFDb'), 'decoy');
  await rejects('remote_conflict', () => files.delete({ path: path.join(home, listed.name), version: listed.version, confirm: true }, ok));
  await rejects('remote_conflict', () => files.move({ path: path.join(home, listed.name), version: listed.version, directory: home, name: 'c' }, ok));
  assert.equal(fs.readFileSync(raw, 'utf8'), 'raw bytes');
  assert.equal(fs.readFileSync(path.join(home, 'a\uFFFDb'), 'utf8'), 'decoy');
});

test('requests carry canonical absolute paths and single names, nothing else', async (t) => {
  const { home, files, version, records } = lab(t);
  const a = path.join(home, 'docs', 'a.txt');
  const good = version(a);
  const paths: unknown[] = ['docs', '', '/a/../b', `${home}/docs/../docs`, '/a/./b', '/a//b', `${home}/`, `${home}\0`, `/${'a'.repeat(256)}`, `/${'a/'.repeat(2100)}a`, 7, null, ['/']];
  for (const bad of paths) {
    const label = JSON.stringify(bad);
    await rejects('remote_invalid_request', () => files.list({ path: bad }), `list ${label}`);
    await rejects('remote_invalid_request', () => files.read({ path: bad }), `read ${label}`);
    await rejects('remote_invalid_request', () => files.create({ directory: bad, name: 'x', type: 'file' }, ok), `create ${label}`);
    await rejects('remote_invalid_request', () => files.delete({ path: bad, version: good, confirm: true }, ok), `delete ${label}`);
    await rejects('remote_invalid_request', () => files.move({ path: bad, version: good, directory: home, name: 'x' }, ok), `move ${label}`);
    await rejects('remote_invalid_request', () => files.move({ path: a, version: good, directory: bad, name: 'x' }, ok), `move to ${label}`);
  }
  for (const name of ['', '.', '..', 'a/b', 'a\0b', 'é'.repeat(128), 3]) {
    await rejects('remote_invalid_request', () => files.create({ directory: home, name, type: 'file' }, ok), `name ${JSON.stringify(name)}`);
    await rejects('remote_invalid_request', () => files.move({ path: a, version: good, directory: home, name }, ok), `name ${JSON.stringify(name)}`);
  }
  await rejects('remote_invalid_request', () => files.delete({ path: '/', version: good, confirm: true }, ok));
  await rejects('remote_invalid_request', () => files.move({ path: '/', version: good, directory: home, name: 'x' }, ok));
  await rejects('remote_invalid_request', () => files.read({ path: '/' }));
  await rejects('remote_invalid_request', () => files.read({ path: a, extra: 1 }));
  await rejects('remote_invalid_request', () => files.list({ path: home, hidden: 'yes' }));
  await rejects('remote_invalid_request', () => files.list({ path: home, extra: 1 }));
  await rejects('remote_invalid_request', () => files.list(null));
  await rejects('remote_invalid_request', () => files.create({ directory: home, name: 'x', type: 'symlink' }, ok));
  await rejects('remote_invalid_request', () => files.delete({ path: a, version: good, confirm: false }, ok));
  await rejects('remote_invalid_request', () => files.delete({ path: a, version: { ...good, ino: 12 }, confirm: true }, ok));
  await rejects('remote_invalid_request', () => files.delete({ path: a, version: { ...good, mtimeNs: '1e18' }, confirm: true }, ok));
  await rejects('remote_invalid_request', () => files.delete({ path: a, version: { ...good, extra: '1' }, confirm: true }, ok));
  assert.equal(fs.readFileSync(a, 'utf8'), 'hello');
  // Refused before anything is recorded.
  assert.deepEqual(records(), []);
});

test('a listing stops at REMOTE_FILES_LIST_MAX entries in byte order and says so, however many there are', async (t) => {
  const { home, files } = lab(t);
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  // Past twice the cap: the names kept while reading are trimmed on the way and stay the first ones.
  const total = 2 * REMOTE_FILES_LIST_MAX + 1;
  for (let index = total - 1; index >= 0; index--) fs.writeFileSync(path.join(many, String(index).padStart(5, '0')), '');
  const over = await files.list({ path: many });
  assert.deepEqual([over.entries.length, over.entries[0]?.name, over.entries.at(-1)?.name, over.truncated], [REMOTE_FILES_LIST_MAX, '00000', String(REMOTE_FILES_LIST_MAX - 1).padStart(5, '0'), true]);
  for (let index = REMOTE_FILES_LIST_MAX; index < total; index++) fs.unlinkSync(path.join(many, String(index).padStart(5, '0')));
  const exact = await files.list({ path: many });
  assert.deepEqual([exact.entries.length, exact.truncated], [REMOTE_FILES_LIST_MAX, false]);
});

test('reading a large folder\'s names lets the Puente answer other work in between', async (t) => {
  const { home, files } = lab(t);
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  // Dot names, so the listing is only the reading of names: nothing to describe afterwards.
  for (let index = 0; index < 3000; index++) fs.closeSync(fs.openSync(path.join(many, `.${index}`), 'w'));
  let turns = 0;
  let listing = true;
  const turn = () => { if (listing) { turns++; setImmediate(turn); } };
  setImmediate(turn);
  const listed = await files.list({ path: many });
  listing = false;
  assert.equal(listed.entries.length, 0);
  assert.ok(turns >= 5, `the event loop turned ${turns} times while 3000 names were read`);
});

test('a folder deleted while still open has no path that leads back to it', async (t) => {
  const { home, files } = lab(t);
  const gone = path.join(home, 'gone');
  fs.mkdirSync(gone);
  const fd = fs.openSync(gone, 'r');
  t.after(() => fs.closeSync(fd));
  fs.rmdirSync(gone);
  await rejects('remote_not_found', () => files.list({ path: `/proc/self/fd/${fd}` }));
});

test('create makes files and folders, never replaces anything, and enters links in the path', async (t) => {
  const { home, outside, files } = lab(t);
  const created = await files.create({ directory: home, name: 'new.txt', type: 'file' }, ok);
  assert.deepEqual([created.name, created.type, created.size], ['new.txt', 'file', 0]);
  assert.equal((await files.create({ directory: home, name: 'folder', type: 'directory' }, ok)).type, 'directory');
  await rejects('remote_exists', () => files.create({ directory: home, name: 'new.txt', type: 'file' }, ok));
  await rejects('remote_exists', () => files.create({ directory: home, name: 'folder', type: 'file' }, ok));
  await rejects('remote_exists', () => files.create({ directory: home, name: 'new.txt', type: 'directory' }, ok));
  // A dangling link is an existing entry: its destination is not created through it.
  fs.symlinkSync(path.join(outside, 'created-through-link'), path.join(home, 'dangling'));
  await rejects('remote_exists', () => files.create({ directory: home, name: 'dangling', type: 'file' }, ok));
  assert.equal(exists(path.join(outside, 'created-through-link')), false);
  fs.symlinkSync(outside, path.join(home, 'to-outside'));
  await files.create({ directory: path.join(home, 'to-outside'), name: 'inside', type: 'file' }, ok);
  assert.equal(fs.lstatSync(path.join(outside, 'inside')).isFile(), true);
  await rejects('remote_not_found', () => files.create({ directory: path.join(home, 'missing'), name: 'x', type: 'file' }, ok));
});

test('the account permissions apply, with no elevation', { skip: root ? 'running as root' : false }, async (t) => {
  const { home, files, version } = lab(t);
  const locked = path.join(home, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'f'), 'kept');
  const f = version(path.join(locked, 'f'));
  fs.chmodSync(locked, 0o555);
  await rejects('remote_permission_denied', () => files.create({ directory: locked, name: 'x', type: 'file' }, ok));
  await rejects('remote_permission_denied', () => files.delete({ path: path.join(locked, 'f'), version: f, confirm: true }, ok));
  await rejects('remote_permission_denied', () => files.move({ path: path.join(locked, 'f'), version: f, directory: home, name: 'f' }, ok));
  fs.chmodSync(path.join(locked, 'f'), 0o000);
  await rejects('remote_permission_denied', () => files.read({ path: path.join(locked, 'f') }));
  fs.chmodSync(locked, 0o000);
  await rejects('remote_permission_denied', () => files.list({ path: locked }));
  await rejects('remote_permission_denied', () => files.create({ directory: '/', name: `relay-${process.pid}`, type: 'file' }, ok));
  fs.chmodSync(locked, 0o700);
  fs.chmodSync(path.join(locked, 'f'), 0o600);
  assert.equal(fs.readFileSync(path.join(locked, 'f'), 'utf8'), 'kept');
});

test('delete needs confirmation and the version read, and removes a link but never its destination', async (t) => {
  const { home, outside, files, version } = lab(t);
  const a = path.join(home, 'docs', 'a.txt');
  await rejects('remote_confirmation_required', () => files.delete({ path: a, version: version(a) }, ok));
  assert.equal(exists(a), true);
  const before = version(a);
  fs.appendFileSync(a, ' world');
  await rejects('remote_conflict', () => files.delete({ path: a, version: before, confirm: true }, ok));
  // A stale selection is reported before asking for confirmation.
  await rejects('remote_conflict', () => files.delete({ path: a, version: before }, ok));
  assert.equal(fs.readFileSync(a, 'utf8'), 'hello world');
  const gone = version(a);
  fs.rmSync(a);
  await rejects('remote_not_found', () => files.delete({ path: a, version: gone, confirm: true }, ok));

  fs.symlinkSync(path.join(outside, 'f'), path.join(home, 'to-file'));
  fs.symlinkSync(outside, path.join(home, 'to-outside'));
  await files.delete({ path: path.join(home, 'to-file'), version: version(path.join(home, 'to-file')), confirm: true }, ok);
  await files.delete({ path: path.join(home, 'to-outside'), version: version(path.join(home, 'to-outside')), confirm: true }, ok);
  assert.deepEqual([exists(path.join(home, 'to-file')), exists(path.join(home, 'to-outside')), fs.readFileSync(path.join(outside, 'f'), 'utf8')], [false, false, 'outside file']);
  // Entering the link acts on its destination.
  fs.symlinkSync(outside, path.join(home, 'to-outside'));
  await files.delete({ path: path.join(home, 'to-outside', 'f'), version: version(path.join(outside, 'f')), confirm: true }, ok);
  assert.equal(exists(path.join(outside, 'f')), false);
});

test('deleting a folder takes its content, and links inside it lose only themselves', async (t) => {
  const { home, outside, files, version } = lab(t);
  const tree = path.join(home, 'tree');
  fs.mkdirSync(path.join(tree, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a', 'b', 'c', 'deep.txt'), 'deep');
  fs.writeFileSync(Buffer.concat([Buffer.from(`${tree}/a/`), Buffer.from([0xfe, 0xff])]), 'not utf-8');
  execFileSync('mkfifo', [path.join(tree, 'a', 'pipe')]);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(tree, 'sock'), resolve));
  t.after(() => server.close());
  fs.symlinkSync(outside, path.join(tree, 'a', 'to-outside'));
  fs.symlinkSync(path.join(outside, 'f'), path.join(tree, 'to-file'));
  const outsideBefore = snapshot(outside);
  await files.delete({ path: tree, version: version(tree), confirm: true }, ok);
  assert.equal(exists(tree), false);
  assert.deepEqual(snapshot(outside), outsideBefore);
});

test('deleting a folder never crosses into another mount, not even a bind of a profile on the same disk', { skip: needsNamespaces }, (t) => {
  const laboratory = lab(t);
  const { home, hermes, outside } = laboratory;
  const p1 = path.join(hermes, 'profiles', 'p1');
  const [disk, profile] = [path.join(home, 'tree1', 'disk'), path.join(home, 'tree2', 'profile')];
  for (const directory of [disk, profile]) fs.mkdirSync(directory, { recursive: true });
  const before = [snapshot(outside), snapshot(hermes)];
  const results = withBinds(laboratory, [[outside, disk], [p1, profile]], `const results = [];
    for (const target of ${JSON.stringify([disk, path.dirname(disk), path.dirname(profile)])}) results.push(await attempt(() => files.delete({ path: target, version: version(target), confirm: true }, context)));
    return results;`);
  assert.deepEqual(results, ['remote_conflict', 'remote_conflict', 'remote_conflict']);
  assert.deepEqual([snapshot(outside), snapshot(hermes)], before);
});

test('move and rename act on the entry itself and never replace a destination', async (t) => {
  const { base, home, outside, files, entry, version } = lab(t);
  const docs = path.join(home, 'docs');
  const a = path.join(docs, 'a.txt');
  const ino = version(a).ino;
  const renamed = await files.move({ path: a, version: version(a), directory: docs, name: 'b.txt' }, ok);
  assert.deepEqual([renamed.name, renamed.version.ino, exists(a)], ['b.txt', ino, false]);
  const moved = await files.move({ path: path.join(docs, 'b.txt'), version: renamed.version, directory: home, name: 'b.txt' }, ok);
  assert.deepEqual([moved.version.ino, fs.readFileSync(path.join(home, 'b.txt'), 'utf8')], [ino, 'hello']);

  fs.writeFileSync(path.join(docs, 'taken'), 'taken');
  await rejects('remote_exists', () => files.move({ path: path.join(home, 'b.txt'), version: version(path.join(home, 'b.txt')), directory: docs, name: 'taken' }, ok));
  fs.mkdirSync(path.join(home, 'empty'));
  fs.mkdirSync(path.join(home, 'full'));
  fs.writeFileSync(path.join(home, 'full', 'x'), 'x');
  await rejects('remote_exists', () => files.move({ path: path.join(home, 'full'), version: version(path.join(home, 'full')), directory: home, name: 'empty' }, ok));
  await rejects('remote_exists', () => files.move({ path: path.join(home, 'b.txt'), version: version(path.join(home, 'b.txt')), directory: home, name: 'b.txt' }, ok));
  assert.deepEqual([fs.readFileSync(path.join(docs, 'taken'), 'utf8'), fs.readdirSync(path.join(home, 'empty')), fs.readdirSync(path.join(home, 'full'))], ['taken', [], ['x']]);

  // A link moves as a link: its destination stays where it is.
  fs.symlinkSync(path.join(outside, 'f'), path.join(home, 'to-file'));
  await files.move({ path: path.join(home, 'to-file'), version: version(path.join(home, 'to-file')), directory: docs, name: 'to-file' }, ok);
  assert.equal((await entry(docs, 'to-file')).type, 'symlink');
  assert.equal(fs.readFileSync(path.join(docs, 'to-file'), 'utf8'), 'outside file');
  assert.equal(fs.lstatSync(path.join(outside, 'f')).isFile(), true);
  // Entering a link in the destination moves into its real folder.
  fs.symlinkSync(outside, path.join(home, 'to-outside'));
  await files.move({ path: path.join(home, 'b.txt'), version: version(path.join(home, 'b.txt')), directory: path.join(home, 'to-outside'), name: 'b.txt' }, ok);
  assert.equal(fs.readFileSync(path.join(outside, 'b.txt'), 'utf8'), 'hello');

  await rejects('remote_invalid_request', () => files.move({ path: path.join(home, 'full'), version: version(path.join(home, 'full')), directory: path.join(home, 'full'), name: 'inside' }, ok));
  assert.equal(exists(path.join(base, 'home', 'full', 'x')), true);
});

test('a move to another filesystem is refused, not copied', async (t) => {
  const { home, files, version } = lab(t);
  let shm: string;
  try { shm = fs.mkdtempSync('/dev/shm/relay-files-'); } catch { t.skip('no /dev/shm'); return; }
  t.after(() => fs.rmSync(shm, { recursive: true, force: true }));
  if (fs.statSync(shm).dev === fs.statSync(home).dev) { t.skip('/dev/shm shares the filesystem of the temporary folder'); return; }
  const a = path.join(home, 'docs', 'a.txt');
  await rejects('remote_cross_device', () => files.move({ path: a, version: version(a), directory: shm, name: 'a.txt' }, ok));
  assert.deepEqual([fs.readFileSync(a, 'utf8'), fs.readdirSync(shm)], ['hello', []]);
});

test('a concurrent rename or symlink swap after the selection is caught next to the effect', async (t) => {
  const { home, outside, files, version } = lab(t);
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'f'), 'selected');
  const selected = version(path.join(work, 'f'));
  // Renamed away and replaced by another file with the same name.
  fs.renameSync(path.join(work, 'f'), path.join(work, 'f.old'));
  fs.writeFileSync(path.join(work, 'f'), 'replacement');
  await rejects('remote_conflict', () => files.delete({ path: path.join(work, 'f'), version: selected, confirm: true }, ok));
  await rejects('remote_conflict', () => files.move({ path: path.join(work, 'f'), version: selected, directory: home, name: 'f' }, ok));
  assert.deepEqual([fs.readFileSync(path.join(work, 'f'), 'utf8'), fs.readFileSync(path.join(work, 'f.old'), 'utf8'), exists(path.join(home, 'f'))], ['replacement', 'selected', false]);

  // The parent folder swapped for a link to somewhere else that has an entry with the same name.
  fs.rmSync(path.join(work, 'f'));
  fs.renameSync(path.join(work, 'f.old'), path.join(work, 'f'));
  const again = version(path.join(work, 'f'));
  fs.renameSync(work, `${work}.old`);
  fs.symlinkSync(outside, work);
  await rejects('remote_conflict', () => files.delete({ path: path.join(work, 'f'), version: again, confirm: true }, ok));
  await rejects('remote_conflict', () => files.move({ path: path.join(work, 'f'), version: again, directory: home, name: 'g' }, ok));
  assert.deepEqual([fs.readFileSync(path.join(outside, 'f'), 'utf8'), fs.readFileSync(path.join(`${work}.old`, 'f'), 'utf8')], ['outside file', 'selected']);

  // The selected folder itself swapped for a link: deleting acts on the link only if it was selected.
  fs.mkdirSync(path.join(home, 'd'));
  const folder = version(path.join(home, 'd'));
  fs.rmdirSync(path.join(home, 'd'));
  fs.symlinkSync(outside, path.join(home, 'd'));
  await rejects('remote_conflict', () => files.delete({ path: path.join(home, 'd'), version: folder, confirm: true }, ok));
  assert.equal(fs.readFileSync(path.join(outside, 'f'), 'utf8'), 'outside file');
});

test('a change while the operation waits for its record is caught before the effect', async (t) => {
  const { home, hermes, files, version, during, records } = lab(t);
  const a = path.join(home, 'docs', 'a.txt');
  // The file itself changes.
  during(() => fs.appendFileSync(a, ' changed'));
  await rejects('remote_conflict', () => files.delete({ path: a, version: version(a), confirm: true }, ok));
  assert.equal(fs.readFileSync(a, 'utf8'), 'hello changed');
  // Its folder moves into a profile: what was classified as an ordinary write would land in one.
  during(() => fs.renameSync(path.join(home, 'docs'), path.join(hermes, 'profiles', 'p1', 'docs')));
  await rejects('remote_conflict', () => files.move({ path: a, version: version(a), directory: home, name: 'a.txt' }, ok));
  assert.equal(fs.readFileSync(path.join(hermes, 'profiles', 'p1', 'docs', 'a.txt'), 'utf8'), 'hello changed');
  // So does the folder of a file being deleted.
  const b = path.join(home, 'notes', 'b.txt');
  fs.mkdirSync(path.dirname(b));
  fs.writeFileSync(b, 'b');
  during(() => fs.renameSync(path.dirname(b), path.join(hermes, 'profiles', 'p1', 'notes')));
  await rejects('remote_conflict', () => files.delete({ path: b, version: version(b), confirm: true }, ok));
  assert.equal(fs.readFileSync(path.join(hermes, 'profiles', 'p1', 'notes', 'b.txt'), 'utf8'), 'b');
  // The destination folder is replaced by a link to a profile.
  fs.mkdirSync(path.join(home, 'target'));
  during(() => { fs.renameSync(path.join(home, 'target'), path.join(home, 'target.old')); fs.symlinkSync(hermes, path.join(home, 'target')); });
  await rejects('remote_conflict', () => files.create({ directory: path.join(home, 'target'), name: 'new', type: 'file' }, ok));
  assert.deepEqual([fs.existsSync(path.join(hermes, 'new')), fs.readdirSync(path.join(home, 'target.old'))], [false, []]);
  // The folder stays put but becomes a profile: Hermes registers it while the record is written.
  during(() => fs.symlinkSync(path.join(home, 'target.old'), path.join(hermes, 'profiles', 'p9')));
  await rejects('remote_conflict', () => files.create({ directory: path.join(home, 'target.old'), name: 'new', type: 'file' }, ok));
  assert.deepEqual(fs.readdirSync(path.join(home, 'target.old')), []);
  // The destination folder of a move, or the folder of a create, is itself moved into a profile:
  // its old path is gone, so only the pinned folder can tell.
  const p1 = path.join(hermes, 'profiles', 'p1');
  const c = path.join(home, 'c.txt');
  fs.writeFileSync(c, 'c');
  fs.mkdirSync(path.join(home, 'dest'));
  during(() => fs.renameSync(path.join(home, 'dest'), path.join(p1, 'dest')));
  await rejects('remote_conflict', () => files.move({ path: c, version: version(c), directory: path.join(home, 'dest'), name: 'c.txt' }, ok));
  assert.deepEqual([fs.readFileSync(c, 'utf8'), fs.readdirSync(path.join(p1, 'dest')), records().at(-1)!.details], ['c', [], undefined]);
  fs.mkdirSync(path.join(home, 'made'));
  during(() => fs.renameSync(path.join(home, 'made'), path.join(p1, 'made')));
  await rejects('remote_conflict', () => files.create({ directory: path.join(home, 'made'), name: 'new', type: 'file' }, ok));
  assert.deepEqual([fs.readdirSync(path.join(p1, 'made')), records().at(-1)!.details], [[], undefined]);
});

test('a revocation seen right before the effect leaves the disk as it was', async (t) => {
  const { home, files, version, during } = lab(t);
  const a = path.join(home, 'docs', 'a.txt');
  const before = snapshot(home);
  await assert.rejects(files.create({ directory: home, name: 'new', type: 'file' }, revoked), /device_revoked/);
  await assert.rejects(files.create({ directory: home, name: 'new', type: 'directory' }, revoked), /device_revoked/);
  await assert.rejects(files.move({ path: a, version: version(a), directory: home, name: 'moved' }, revoked), /device_revoked/);
  await assert.rejects(files.delete({ path: a, version: version(a), confirm: true }, revoked), /device_revoked/);
  await assert.rejects(files.delete({ path: path.join(home, 'docs'), version: version(path.join(home, 'docs')), confirm: true }, revoked), /device_revoked/);
  // Revoked while the record was being written: the check in the same step as the effect sees it.
  let revokedNow = false;
  const late = { ...ok, guard() { if (revokedNow) throw new Error('device_revoked'); } };
  during(() => { revokedNow = true; });
  await assert.rejects(files.delete({ path: a, version: version(a), confirm: true }, late), /device_revoked/);
  assert.deepEqual(snapshot(home), before);
});

test('every operation is recorded before its effect: who, when and which, never the path', async (t) => {
  const { home, files, version, records, backups, changes } = lab(t);
  const docs = path.join(home, 'docs');
  await files.create({ directory: docs, name: 'n', type: 'file' }, ok);
  await files.move({ path: path.join(docs, 'n'), version: version(path.join(docs, 'n')), directory: docs, name: 'm' }, ok);
  await files.move({ path: path.join(docs, 'm'), version: version(path.join(docs, 'm')), directory: home, name: 'm' }, ok);
  await files.delete({ path: path.join(home, 'm'), version: version(path.join(home, 'm')), confirm: true }, ok);
  await rejects('remote_exists', () => files.create({ directory: home, name: 'docs', type: 'directory' }, ok));
  assert.deepEqual(records().map(({ actor, action, target, details }) => ({ actor, action, target, details })), [
    { actor: PHONE, action: 'remote.file.create', target: { kind: 'server', id: 'local' }, details: undefined },
    { actor: PHONE, action: 'remote.file.rename', target: { kind: 'server', id: 'local' }, details: undefined },
    { actor: PHONE, action: 'remote.file.move', target: { kind: 'server', id: 'local' }, details: undefined },
    { actor: PHONE, action: 'remote.file.delete', target: { kind: 'server', id: 'local' }, details: undefined },
    // An attempt refused by the disk itself is still recorded: the record comes first.
    { actor: PHONE, action: 'remote.file.create', target: { kind: 'server', id: 'local' }, details: undefined },
  ]);
  assert.deepEqual(backups(), []);
  assert.doesNotMatch(fs.readFileSync(changes, 'utf8'), /docs|relay-files|"m"|"n"/);
});

test('a record that cannot be written publishes nothing', async (t) => {
  const { home, hermes, files, version, changes, backups } = lab(t);
  const before = [snapshot(home)];
  // A changes.jsonl that does not validate stops every write instead of being skipped.
  fs.writeFileSync(changes, 'not a record\n');
  const a = path.join(home, 'docs', 'a.txt');
  await rejects('remote_unavailable', () => files.create({ directory: home, name: 'new', type: 'file' }, ok));
  await rejects('remote_unavailable', () => files.move({ path: a, version: version(a), directory: home, name: 'a.txt' }, ok));
  await rejects('remote_unavailable', () => files.delete({ path: a, version: version(a), confirm: true }, ok));
  await rejects('remote_unavailable', () => files.delete({ path: path.join(hermes, 'SOUL.md'), version: version(path.join(hermes, 'SOUL.md')), confirm: true }, ok));
  assert.deepEqual([snapshot(home)], before);
  assert.equal(fs.readFileSync(changes, 'utf8'), 'not a record\n');
  // The previous version was kept before the record failed: an extra copy, never a lost one.
  assert.equal(backups().length, 1);
});

// ---- reference (#114): a file attached to a Turno by its path; no byte is read ----------------

test('reference accepts a regular file and answers its canonical and real path, a profile file too', (t) => {
  const { home, hermes, files } = lab(t);
  assert.deepEqual(files.reference({ path: path.join(home, 'docs', 'a.txt') }), { path: path.join(home, 'docs', 'a.txt'), realPath: path.join(home, 'docs', 'a.txt') });
  assert.deepEqual(files.reference({ path: path.join(hermes, 'SOUL.md') }).realPath, path.join(hermes, 'SOUL.md'));
});

test('reference refuses what is not a canonical absolute path to one line', async (t) => {
  const { home, files } = lab(t);
  fs.writeFileSync(path.join(home, 'a\nb'), 'x');
  for (const body of [{ path: `${home}/docs/../docs/a.txt` }, { path: 'docs/a.txt' }, { path: `${home}/docs/a.txt/` }, { path: `${home}/a\nb` },
    { path: '/' }, { path: 7 }, {}, { path: `${home}/docs/a.txt`, extra: 1 }, null]) {
    await rejects('remote_invalid_request', () => files.reference(body), JSON.stringify(body));
  }
});

test('reference takes only regular files: folders, FIFOs, sockets and devices are refused at once', async (t) => {
  const { home, files } = lab(t);
  execFileSync('mkfifo', [path.join(home, 'pipe')]);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(home, 'sock'), resolve));
  t.after(() => server.close());
  for (const file of [path.join(home, 'docs'), path.join(home, 'pipe'), path.join(home, 'sock'), '/dev/null']) {
    await rejects('remote_invalid_request', () => files.reference({ path: file }), file);
  }
  await rejects('remote_not_found', () => files.reference({ path: path.join(home, 'missing.txt') }));
});

test('reference needs the file readable by the Puente account', { skip: root ? 'running as root' : false }, async (t) => {
  const { home, files } = lab(t);
  fs.writeFileSync(path.join(home, 'locked.txt'), 'x', { mode: 0o000 });
  await rejects('remote_permission_denied', () => files.reference({ path: path.join(home, 'locked.txt') }));
});

test('reference never accepts Puente data: the state folder and ~/.config/relay', async (t) => {
  const { state, config, files } = lab(t);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'relay.env'), 'RELAY_SECRET=x');
  await rejects('remote_bridge_protected', () => files.reference({ path: path.join(state, 'devices.json') }));
  await rejects('remote_bridge_protected', () => files.reference({ path: path.join(config, 'relay.env') }));
});

test('reference follows links and answers where they really lead; a link into Puente data, to a folder or nowhere is refused', async (t) => {
  const { home, state, files } = lab(t);
  fs.symlinkSync(path.join(home, 'docs', 'a.txt'), path.join(home, 'link.txt'));
  fs.symlinkSync(path.join(state, 'devices.json'), path.join(home, 'devices.txt'));
  fs.symlinkSync(path.join(home, 'docs'), path.join(home, 'folder-link'));
  fs.symlinkSync(path.join(home, 'gone.txt'), path.join(home, 'broken.txt'));
  assert.deepEqual(files.reference({ path: path.join(home, 'link.txt') }), { path: path.join(home, 'link.txt'), realPath: path.join(home, 'docs', 'a.txt') });
  await rejects('remote_bridge_protected', () => files.reference({ path: path.join(home, 'devices.txt') }));
  await rejects('remote_invalid_request', () => files.reference({ path: path.join(home, 'folder-link') }));
  await rejects('remote_not_found', () => files.reference({ path: path.join(home, 'broken.txt') }));
});

test('reference: a folder swapped for a link into Puente data while it is checked is a conflict, never the old answer', async (t) => {
  const { home, state, files } = lab(t);
  fs.mkdirSync(path.join(home, 'swap'));
  fs.writeFileSync(path.join(home, 'swap', 'devices.json'), 'ordinary');
  const original = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (file: string) => {
    const real = original(file);
    fs.renameSync(path.join(home, 'swap'), path.join(home, 'swap-old'));
    fs.symlinkSync(state, path.join(home, 'swap'));
    return real;
  });
  await rejects('remote_conflict', () => files.reference({ path: path.join(home, 'swap', 'devices.json') }));
});

test('reference refuses a clean link whose real path breaks the one-line note', async (t) => {
  const { home, files } = lab(t);
  fs.writeFileSync(path.join(home, 'a\nb'), 'x');
  fs.symlinkSync(path.join(home, 'a\nb'), path.join(home, 'ok.txt'));
  await rejects('remote_invalid_request', () => files.reference({ path: path.join(home, 'ok.txt') }));
});

test('reference refuses Unicode line breaks in the requested or the real path', async (t) => {
  const { home, files } = lab(t);
  for (const name of ['a\u2028b', 'a\u2029b', 'a\u0085b']) {
    fs.writeFileSync(path.join(home, name), 'x');
    fs.symlinkSync(path.join(home, name), path.join(home, `ok-${name.codePointAt(1)}.txt`));
    await rejects('remote_invalid_request', () => files.reference({ path: path.join(home, `ok-${name.codePointAt(1)}.txt`) }), `real ${name.codePointAt(1)}`);
    await rejects('remote_invalid_request', () => files.reference({ path: path.join(home, name) }), `requested ${name.codePointAt(1)}`);
  }
});
