import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, AUTH } from '../support/appUpdateFixture.ts';
test('authenticated protocol-bound manifest and exact If-Match download have fixed headers and no audit of reads', async t => {
  const f = await fixture(t); await f.publish();
  const result = await f.call(); assert.equal(result.status, 200);
  const manifest = JSON.parse(result.body); assert.equal(manifest.state, 'published');
  assert.equal(result.headers.get('etag'), '"' + manifest.revision + '"');
  const downloaded = await f.call('/apk', { ...AUTH, 'If-Match': result.headers.get('etag')! });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.body, 'abc');
  assert.equal(downloaded.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(downloaded.headers.get('content-length'), '3'); assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.match(downloaded.headers.get('content-disposition')!, /filename="relay.apk"/);
  assert.doesNotMatch(f.logs.join('\n'), /abc|release.json|published|Bearer|rly1_/);
});
test('a readable 0755 state directory serves the APK through a private app-update child created 0700', async t => {
  const f = await fixture(t); await f.publish(); await fs.chmod(f.privateRoot, 0o755);
  const result = await f.call(); assert.equal(result.status, 200);
  const downloaded = await f.call('/apk', { ...AUTH, 'If-Match': result.headers.get('etag')! });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.body, 'abc');
  assert.equal((await fs.stat(f.privateRoot)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(f.privateRoot, 'app-update'))).mode & 0o777, 0o700);
  await fs.chmod(path.join(f.privateRoot, 'app-update'), 0o750); await f.publish(Buffer.from('next'), { versionCode: 3 });
  assert.equal((await f.call()).status, 503, 'A widened private child must fail closed');
});

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { hashDeviceKey } from '../src/auth.ts';
import { AppUpdates } from '../src/appUpdate.ts';
import type { TestContext } from 'node:test';

test('authorization, protocol, absent publication and unsupported inputs are checked before private reads', async t => {
  const f = await fixture(t); await f.publish();
  assert.equal((await f.call('', {})).status, 401);
  assert.equal((await f.call('', { Authorization: AUTH.Authorization })).status, 426);
  assert.equal((await f.call('', { ...AUTH, 'X-Relay-Protocol': '999' })).status, 426);
  assert.equal((await f.call('/apk', { ...AUTH, 'If-Match': '"' + 'a'.repeat(64) + '"', 'X-Relay-Protocol': '999' })).status, 426);
  for (const suffix of ['?path=/private', '/apk?url=http://invalid.test']) assert.equal((await f.call(suffix)).status, 400);
  assert.equal((await f.call('/apk', { ...AUTH, Range: 'bytes=0-1' })).status, 400);
  assert.equal((await f.call('/apk')).status, 428);
  const disabled = await fixture(t, false); assert.equal((await disabled.call()).status, 404);
  await fs.unlink(path.join(f.published, 'relay.apk')); await fs.unlink(path.join(f.published, 'release.json'));
  assert.deepEqual(JSON.parse((await f.call()).body), { state: 'unpublished' });
  await f.publish(); await fs.unlink(path.join(f.published, 'release.json'));
  const failed = await f.call(); assert.equal(failed.status, 503); assert.doesNotMatch(failed.body, /published|release.json|app-update-http-/);
});
test('a changed publication returns 412 rather than silently sending a different APK', async t => {
  const f = await fixture(t); await f.publish(); const first = await f.call();
  await f.publish(Buffer.from('next'), { versionCode: 3 });
  const stale = await f.call('/apk', { ...AUTH, 'If-Match': first.headers.get('etag')! });
  assert.equal(stale.status, 412); assert.equal(JSON.parse(stale.body).error.code, 'app_update_changed');
  const next = await f.call(); assert.notEqual(next.headers.get('etag'), first.headers.get('etag'));
  assert.equal((await f.call('/apk', { ...AUTH, 'If-Match': next.headers.get('etag')! })).body, 'next');
});
function pausedSource(t: TestContext) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  // The build closes its source handles last, after any partial snapshot cleanup: that is when it has finished.
  const sourceClosed = Promise.withResolvers<void>();
  const open = fs.open.bind(fs); let reads = 0, writes = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number') {
      if (!(args[1] & 64)) {
        const read = file.read.bind(file), close = file.close.bind(file); let copied = false;
        t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
          reads++; copied = true; const result = await read(...params); enter(); await held; return result;
        });
        t.mock.method(file, 'close', async () => { await close(); if (copied) sourceClosed.resolve(); });
      } else {
        const write = file.write.bind(file);
        t.mock.method(file, 'write', async (...params: Parameters<typeof file.write>) => { writes++; return write(...params); });
      }
    }
    return file;
  });
  return { entered, release, sourceClosed: sourceClosed.promise, reads: () => reads, writes: () => writes };
}
// Only for negative checks: a released read reaches its next guarded write within microtasks.
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
for (const endpoint of ['', '/apk']) test(`revocation while ${endpoint || 'manifest'} waits for the source returns no metadata or APK bytes`, async t => {
  const f = await fixture(t); await f.publish(); const first = await f.call();
  await f.publish(Buffer.from('fresh'), { versionCode: 3 }); const paused = pausedSource(t);
  const pending = f.call(endpoint, { ...AUTH, 'If-Match': first.headers.get('etag')! });
  await paused.entered;
  await f.store.mutate(s => { s.devices[0].revokedAt = 1791028800001; });
  const result = await pending; assert.equal(result.status, 403); assert.doesNotMatch(result.body, /fresh|revision|artifact/);
  paused.release(); await flush(); assert.equal(paused.writes(), 0);
  assert.doesNotMatch(f.logs.join('\n'), /fresh|release.json|revokedAt|rly1_/);
});
test('one revoked consumer detaches immediately while the valid consumer shares a single snapshot build', async t => {
  const f = await fixture(t); await f.publish(); const paused = pausedSource(t);
  const secondKey = `rly1_${Buffer.alloc(32, 72).toString('base64url')}`;
  await f.store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000072', name: 'second fixture', pairedAt: 1791028800000, revokedAt: null, keyHash: hashDeviceKey(secondKey).toString('hex') }); });
  const joined = Promise.withResolvers<void>(); const manifest = AppUpdates.prototype.manifest; let consumers = 0;
  // manifest() registers its consumer on the shared build before its first await.
  t.mock.method(AppUpdates.prototype, 'manifest', function (this: AppUpdates, ...args: Parameters<AppUpdates['manifest']>) {
    const result = manifest.apply(this, args); if (++consumers === 2) joined.resolve(); return result;
  });
  const first = f.call(); await paused.entered;
  const second = f.call('', { ...AUTH, Authorization: `Bearer ${secondKey}` }); await joined.promise;
  await f.store.mutate(s => { s.devices[0].revokedAt = 1791028800001; });
  assert.equal((await first).status, 403); paused.release();
  const result = await second; assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).artifact.byteLength, 3);
  assert.equal(paused.reads(), 1); assert.equal(paused.writes(), 1);
});
test('last disconnect cancels the copy before any private write and cleans the partial snapshot', async t => {
  const f = await fixture(t); await f.publish(); const paused = pausedSource(t);
  // The server aborts the build from its synchronous close handling; the next macrotask follows it.
  const closed = Promise.withResolvers<void>();
  f.server.once('request', (_req, res) => res.once('close', () => setImmediate(closed.resolve)));
  const request = http.get(f.base + '/v1/app-update', { headers: AUTH }); request.on('error', () => {});
  await paused.entered; request.destroy(); await closed.promise; paused.release(); await paused.sourceClosed;
  assert.equal(paused.writes(), 0); assert.deepEqual(await fs.readdir(path.join(f.privateRoot, 'app-update')), []);
});

for (const stoppedAt of ['read', 'drain'] as const) test(`revocation during binary ${stoppedAt} closes the stream without its remaining bytes`, async t => {
  const f = await fixture(t); await f.publish(Buffer.alloc(512 * 1024, 97));
  const open = fs.open.bind(fs); let streaming = false;
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && (args[1] & 64)) {
      const read = file.read.bind(file);
      t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
        const result = await read(...params);
        if (streaming && stoppedAt === 'read' && Number((params as unknown as unknown[])[3]) === 65536) { enter(); await held; }
        return result;
      });
    }
    return file;
  });
  if (stoppedAt === 'drain') {
    const emit = http.ServerResponse.prototype.emit;
    t.mock.method(http.ServerResponse.prototype, 'emit', function (this: http.ServerResponse, event: string | symbol, ...args: unknown[]) {
      if (streaming && event === 'drain' && this.getHeader('Content-Type') === 'application/vnd.android.package-archive') { enter(); return false; }
      return emit.call(this, event, ...args);
    });
  }
  const manifest = await f.call(); streaming = true;
  let firstData!: () => void; const received = new Promise<void>(r => { firstData = r; });
  const chunks: Buffer[] = [];
  const closed = new Promise<void>(resolve => {
    const request = http.get(f.base + '/v1/app-update/apk', { headers: { ...AUTH, 'If-Match': manifest.headers.get('etag')! } }, response => {
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)); firstData(); });
      response.on('end', resolve); response.on('aborted', resolve); response.on('error', () => resolve());
    }); request.on('error', () => resolve());
  });
  await entered; await received; await f.store.mutate(s => { s.devices[0].revokedAt = 1791028800001; });
  await closed; release(); await flush();
  const body = Buffer.concat(chunks); assert.equal(body.length, 65536); assert.ok(body.every(byte => byte === 97));
  assert.doesNotMatch(f.logs.join('\n'), /Bearer|rly1_|app-update-http-/);
});

test('valid binary responses stream complete bounded chunks instead of dropping bytes at backpressure', async t => {
  const f = await fixture(t); const apk = Buffer.alloc(1024 * 1024 + 17, 83); await f.publish(apk);
  const manifest = await f.call();
  const response = await fetch(f.base + '/v1/app-update/apk', { headers: { ...AUTH, 'If-Match': manifest.headers.get('etag')! } });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), apk);
  const audit = await fs.readFile(path.join(f.privateRoot, 'changes.jsonl'), 'utf8').catch(() => '');
  assert.doesNotMatch(audit, /app.update|app_update|apk|download/);
});

test('a read failure after the binary headers destroys the connection instead of ending a short body', async t => {
  const f = await fixture(t); await f.publish(Buffer.alloc(192 * 1024, 97));
  const open = fs.open.bind(fs); let streaming = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && (args[1] & 64)) {
      const read = file.read.bind(file);
      t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
        if (streaming && Number((params as unknown as unknown[])[3]) === 65536) return { bytesRead: 0, buffer: params[0] };
        return read(...params);
      });
    }
    return file;
  });
  const manifest = await f.call(); streaming = true;
  let received = 0, complete: boolean | null = null;
  const closed = Promise.withResolvers<void>();
  const request = http.get(f.base + '/v1/app-update/apk', { headers: { ...AUTH, 'If-Match': manifest.headers.get('etag')! } }, response => {
    response.on('data', chunk => { received += chunk.length; });
    response.on('close', () => { complete = response.complete; closed.resolve(); });
  }); request.on('error', () => closed.resolve());
  // Real time on purpose: a short body that is merely ended leaves the client waiting on the
  // server keep-alive timeout (5 s); the bound only distinguishes that from an immediate close.
  const limit = Promise.withResolvers<string>(); const timer = setTimeout(limit.resolve, 1500, 'open');
  const outcome = await Promise.race([closed.promise.then(() => 'closed'), limit.promise]); clearTimeout(timer); request.destroy();
  assert.equal(outcome, 'closed', 'The client must not wait for bytes that will never come');
  assert.equal(complete, false); assert.equal(received, 65536);
});

test('a stalled binary read closes at the inactivity limit instead of retaining an open download', async t => {
  const f = await fixture(t); await f.publish(Buffer.alloc(128 * 1024, 97));
  const open = fs.open.bind(fs); let streaming = false;
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && (args[1] & 64)) {
      const read = file.read.bind(file);
      t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
        const result = await read(...params);
        if (streaming && Number((params as unknown as unknown[])[3]) === 65536) { enter(); await held; }
        return result;
      });
    }
    return file;
  });
  const manifest = await f.call(); streaming = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = false;
  const done = new Promise<void>(resolve => {
    const request = http.get(f.base + '/v1/app-update/apk', { headers: { ...AUTH, 'If-Match': manifest.headers.get('etag')! } }, response => {
      response.resume(); const end = () => { closed = true; resolve(); }; response.on('end', end); response.on('aborted', end); response.on('error', end);
    }); request.on('error', () => { closed = true; resolve(); });
  });
  await entered; t.mock.timers.tick(30_000);
  await new Promise(resolve => setImmediate(() => setImmediate(resolve))); await new Promise(resolve => setImmediate(resolve));
  const stopped = closed; release(); await done; assert.equal(stopped, true);
});
