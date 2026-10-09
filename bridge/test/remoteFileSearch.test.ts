// Searching by name and by content on a real disk (#87): no links followed, no loops, no special
// files read, results in frames that wait for acks, cancellation and reconnection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { REMOTE_FILE_SEARCH_MATCHES_MAX, REMOTE_FILE_SEARCH_QUERY_BYTES, type RemoteFileSearchEvent } from '../../protocol/remoteFiles.ts';
import type { RemoteFileSystem } from '../src/remote/ports.ts';
import { lab, needsNamespaces, ok, rejects, withBinds } from '../support/filesLab.ts';

const root = process.getuid?.() === 0;

/** A stream of a search's frames, as the server would write them. */
function watch(files: RemoteFileSystem, id: string, lastEventId?: string) {
  const events: RemoteFileSearchEvent[] = [];
  let ended = false;
  const stop = files.events(id, lastEventId, ok).start((event) => { events.push(event); }, () => { ended = true; });
  return { events, ended: () => ended, stop };
}

async function until(done: () => boolean, label: string): Promise<void> {
  for (const started = Date.now(); !done();) {
    if (Date.now() - started > 15_000) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}

/** Runs a search to its end, acking every frame, and answers its matches and its end frame. */
async function search(files: RemoteFileSystem, body: unknown) {
  const { id } = files.startSearch(body, ok);
  const stream = watch(files, id);
  await until(() => stream.events.some((event) => event.type === 'end'), 'search end');
  const end = stream.events.at(-1)!;
  assert.equal(end.type, 'end');
  files.ack(id, { seq: end.seq }, ok);
  const paths = stream.events.flatMap((event) => event.type === 'results' ? event.matches.map((match) => match.path) : []).sort();
  return { id, paths, end: end as Extract<RemoteFileSearchEvent, { type: 'end' }>, events: stream.events, ended: stream.ended() };
}

test('by name: folders and subfolders, without case, dot entries on request, and never through a link', async (t) => {
  const { home, outside, files } = lab(t);
  const docs = path.join(home, 'docs');
  fs.mkdirSync(path.join(docs, 'sub', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'Report-A.md'), '');
  fs.writeFileSync(path.join(docs, 'sub', 'reports', 'REPORT.txt'), '');
  fs.writeFileSync(path.join(docs, '.report-hidden'), '');
  fs.writeFileSync(path.join(outside, 'report-outside'), '');
  fs.symlinkSync(outside, path.join(docs, 'to-outside'));
  // A link back to an ancestor: followed, it would never end.
  fs.symlinkSync(home, path.join(docs, 'sub', 'report-loop'));
  const found = await search(files, { path: docs, query: 'rePort' });
  assert.deepEqual(found.paths, ['Report-A.md', 'sub/report-loop', 'sub/reports', 'sub/reports/REPORT.txt'].map((name) => path.join(docs, name)));
  assert.deepEqual([found.end.state, found.end.truncated, found.end.folders, found.end.unreadable, found.ended], ['completed', false, 3, 0, true]);
  const loop = found.events.flatMap((event) => event.type === 'results' ? event.matches : []).find((match) => match.path.endsWith('report-loop'))!;
  assert.deepEqual([loop.entry.type, loop.entry.link?.realPath], ['symlink', home]);
  assert.deepEqual(files.cancel(found.id, ok), { id: found.id, state: 'completed' });
  assert.ok((await search(files, { path: docs, query: 'report', hidden: true })).paths.includes(path.join(docs, '.report-hidden')));

  for (const body of [{ path: docs, query: '' }, { path: docs, query: 'a/b' }, { path: docs, query: 'a\0' }, { path: docs, query: 'x'.repeat(REMOTE_FILE_SEARCH_QUERY_BYTES + 1) },
    { path: docs, query: 'x', content: false }, { path: docs, query: 'x', hidden: 'yes' }, { path: 'docs', query: 'x' }, { path: docs, query: 7 }, { path: docs, query: 'x', extra: 1 }]) {
    await rejects('remote_invalid_request', () => files.startSearch(body, ok), JSON.stringify(body));
  }
  await rejects('remote_not_found', () => files.startSearch({ path: path.join(home, 'missing'), query: 'x' }, ok));
});

test('by content: text across read boundaries, binary skipped, special files never opened, unreadable ones counted', async (t) => {
  const { home, files } = lab(t);
  const tree = path.join(home, 'tree');
  fs.mkdirSync(tree);
  // The query straddles the 64 KiB reads.
  fs.writeFileSync(path.join(tree, 'boundary.log'), Buffer.concat([Buffer.alloc(65_536 - 3, 0x61), Buffer.from('aguja en el pajar')]));
  fs.writeFileSync(path.join(tree, 'aguja-in-the-name-only.txt'), 'nothing here');
  fs.writeFileSync(path.join(tree, 'binary.bin'), Buffer.concat([Buffer.from([0]), Buffer.from('aguja')]));
  fs.writeFileSync(path.join(tree, 'utf8.txt'), 'una aguja con ñ');
  execFileSync('mkfifo', [path.join(tree, 'aguja.fifo')]);
  fs.mkdirSync(path.join(tree, 'aguja-folder'));
  if (!root) { fs.writeFileSync(path.join(tree, 'locked.txt'), 'aguja'); fs.chmodSync(path.join(tree, 'locked.txt'), 0); }
  const found = await search(files, { path: tree, query: 'aguja', content: true });
  assert.deepEqual(found.paths, [path.join(tree, 'boundary.log'), path.join(tree, 'utf8.txt')]);
  assert.deepEqual([found.end.state, found.end.unreadable], ['completed', root ? 0 : 1]);
  assert.deepEqual((await search(files, { path: tree, query: 'con ñ', content: true })).paths, [path.join(tree, 'utf8.txt')]);
});

test('results wait for acks past the window, never dropped, stop at the match cap, and resume after a reconnection', async (t) => {
  const { home, files } = lab(t);
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index <= REMOTE_FILE_SEARCH_MATCHES_MAX; index++) fs.writeFileSync(path.join(many, `match-${String(index).padStart(5, '0')}`), '');
  const { id } = files.startSearch({ path: many, query: 'match' }, ok);
  const first = watch(files, id);
  // Without acks the walk stops once a window is unacknowledged, and never ends on its own.
  const sent = () => first.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
  await until(() => sent() >= REMOTE_LIMITS.channelWindowBytes || first.ended(), 'a window sent');
  const paused = first.events.length;
  await sleep(300);
  assert.equal(first.events.length, paused, 'nothing more without an ack');
  assert.ok(sent() < REMOTE_LIMITS.channelWindowBytes + 100_000, `${sent()} bytes before pausing`);
  assert.equal(first.events.some((event) => event.type === 'end'), false);
  assert.deepEqual(first.events.map((event) => event.seq), first.events.map((_, index) => index + 1));

  // A reconnection from the last seq held replaces the first stream and goes on from there.
  const held = first.events[2]!.seq;
  const second = watch(files, id, String(held));
  assert.equal(first.ended(), true);
  assert.equal(second.events[0]!.seq, held + 1);
  await rejects('remote_invalid_request', () => files.events(id, String(first.events.length + 1), ok));
  await rejects('remote_invalid_request', () => files.ack(id, { seq: first.events.length + 1 }, ok));
  // Acking resumes it; every match arrives once, up to the cap, which the end frame says.
  for (let acked = 0; !second.events.some((event) => event.type === 'end');) {
    const last = second.events.at(-1)?.seq ?? held;
    if (last > acked) { files.ack(id, { seq: last }, ok); acked = last; }
    await sleep(5);
  }
  const matches = [...first.events.slice(0, 3), ...second.events].flatMap((event) => event.type === 'results' ? event.matches.map((match) => match.path) : []);
  assert.equal(matches.length, REMOTE_FILE_SEARCH_MATCHES_MAX);
  assert.equal(new Set(matches).size, matches.length);
  const end = second.events.at(-1)!;
  assert.deepEqual([end.type, end.type === 'end' && end.state, end.type === 'end' && end.truncated, second.ended()], ['end', 'completed', true, true]);
});

test('a search cancelled, or of a revoked device, stops and says so', async (t) => {
  const { home, files } = lab(t);
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index < 3000; index++) fs.writeFileSync(path.join(many, `m-${index}`), '');
  const cancelled = files.startSearch({ path: many, query: 'm-' }, ok);
  const stream = watch(files, cancelled.id);
  assert.deepEqual(files.cancel(cancelled.id, ok), { id: cancelled.id, state: 'cancelled' });
  await until(stream.ended, 'cancelled stream ends');
  const end = stream.events.at(-1)!;
  assert.deepEqual([end.type, end.type === 'end' && end.state], ['end', 'cancelled']);
  // Stopped, not walked to the end and then called cancelled.
  assert.ok(end.files < 3000, `walked ${end.files} files after the cancel`);

  const revoked = files.startSearch({ path: many, query: 'm-' }, ok);
  const watched = watch(files, revoked.id);
  files.retain(new Set());
  await until(watched.ended, 'revoked stream ends');
  await rejects('remote_not_found', () => files.events(revoked.id, undefined, ok));
  await rejects('remote_not_found', () => files.cancel(revoked.id, { ...ok, deviceId: '00000000-0000-4000-8000-000000000002' }));
});

test('a content search cancelled while it reads a file stops reading it', async (t) => {
  const { home, files } = lab(t);
  const big = path.join(home, 'big');
  fs.mkdirSync(big);
  // Text past the binary probe, then a hole of 1 GiB, and the query only at the very end.
  const file = path.join(big, 'huge.txt');
  fs.writeFileSync(file, 'x'.repeat(8192));
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, 'aguja', 1024 ** 3);
  fs.closeSync(fd);
  const { id } = files.startSearch({ path: big, query: 'aguja', content: true }, ok);
  const stream = watch(files, id);
  // Cancelled once the walk holds the file open, that is, while it reads it.
  await until(() => fs.readdirSync('/proc/self/fd').some((open) => { try { return fs.readlinkSync(`/proc/self/fd/${open}`) === file; } catch { return false; } }), 'the file is being read');
  files.cancel(id, ok);
  await until(stream.ended, 'cancelled stream ends');
  const end = stream.events.at(-1)!;
  assert.deepEqual([end.type, end.type === 'end' && end.state], ['end', 'cancelled']);
  assert.deepEqual(stream.events.flatMap((event) => event.type === 'results' ? event.matches : []), [], 'the file was read to the end after the cancel');
});

test('pseudo filesystems are not searched', async (t) => {
  const { files } = lab(t);
  const found = await search(files, { path: '/proc', query: 'status' });
  assert.deepEqual([found.paths, found.end.state, found.end.folders], [[], 'completed', 0]);
});

test('a bind mount of an ancestor inside the tree is walked once, never in a loop', { skip: needsNamespaces }, (t) => {
  const laboratory = lab(t);
  const docs = path.join(laboratory.home, 'docs');
  const mount = path.join(docs, 'sub', 'again');
  fs.mkdirSync(mount, { recursive: true });
  const found = withBinds(laboratory, [[docs, mount]], `const { id } = files.startSearch({ path: ${JSON.stringify(docs)}, query: 'a.txt' }, context);
    const paths = [];
    const { promise, resolve } = Promise.withResolvers();
    files.events(id, undefined, context).start((event) => {
      if (event.type === 'results') paths.push(...event.matches.map((match) => match.path));
      else resolve(event.state);
    }, () => {});
    return { paths, state: await promise };`);
  assert.deepEqual(found, { paths: [path.join(docs, 'a.txt')], state: 'completed' });
});
