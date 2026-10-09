import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { AppUpdates, AppUpdateError } from '../src/appUpdate.ts';

const bytes = Buffer.from('abc');
const metadata = { schemaVersion: 1, applicationId: 'io.github.fixture.relay', versionCode: 2, versionName: '2.0', byteLength: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', signerSha256: 'a'.repeat(64), builtAtMs: 1791028800000, sourceCommit: 'b'.repeat(40) };
const context = () => ({ deviceId: 'synthetic-phone', guard() {}, signal: new AbortController().signal });
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve('app-update-fixture-')); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const published = path.join(root, 'published'); const privateRoot = path.join(root, 'private');
  const slots = path.join(privateRoot, 'app-update');
  await fs.mkdir(published, { mode: 0o700 }); await fs.mkdir(privateRoot, { mode: 0o700 }); await fs.mkdir(slots, { mode: 0o700 });
  const service = new AppUpdates({ root: published, privateRoot }); t.after(() => service.close());
  async function publish(data: unknown = metadata, apk = bytes) {
    await fs.writeFile(path.join(published, 'relay.apk'), apk, { mode: 0o600 });
    await fs.writeFile(path.join(published, 'release.json'), JSON.stringify(data), { mode: 0o600 });
  }
  return { root, published, privateRoot, slots, service, publish };
}
test('explicit publication yields metadata and the exact retained snapshot after original replacement', async t => {
  const f = await fixture(t); await f.publish();
  const manifest = await f.service.manifest(context()); assert.equal(manifest.state, 'published');
  if (manifest.state !== 'published') throw new Error('Missing fixture publication');
  assert.equal(manifest.artifact.sha256, metadata.sha256); assert.match(manifest.revision, /^[a-f0-9]{64}$/);
  const download = await f.service.download('"' + manifest.revision + '"', context());
  await fs.rename(path.join(f.published, 'relay.apk'), path.join(f.published, 'old.apk'));
  await fs.writeFile(path.join(f.published, 'relay.apk'), 'REPLACED', { mode: 0o600 });
  const actual = Buffer.alloc(3); await download.file.read(actual, 0, 3, 0);
  assert.deepEqual(actual, bytes); assert.equal(createHash('sha256').update(actual).digest('hex'), metadata.sha256);
  await download.release();
});

test('hash is verified from the retained snapshot, including a corrupted filesystem write', async t => {
  const f = await fixture(t); await f.publish();
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && Boolean(args[1] & 64)) {
      const write = file.write.bind(file);
      t.mock.method(file, 'write', async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const corrupted = Buffer.from(buffer); corrupted[offset] = 120;
        return write(corrupted, offset, length, position);
      });
    }
    return file;
  });
  await assert.rejects(f.service.manifest(context()), AppUpdateError);
});

test('an explicitly empty publication is honest; partial and invalid updates never fall back to cached bytes', async t => {
  const f = await fixture(t); assert.deepEqual(await f.service.manifest(context()), { state: 'unpublished' });
  await f.publish(); const first = await f.service.manifest(context()); assert.equal(first.state, 'published');
  await fs.unlink(path.join(f.published, 'release.json'));
  await assert.rejects(f.service.manifest(context()), AppUpdateError);
  await fs.unlink(path.join(f.published, 'relay.apk'));
  assert.deepEqual(await f.service.manifest(context()), { state: 'unpublished' });
});
for (const [field, values] of Object.entries({ schemaVersion: [0, '1'], applicationId: ['', '../escape', 'x'.repeat(201)], versionCode: [0, -1, 2147483648, 2.5, '2'],
  versionName: ['', 'x'.repeat(129), 'line\n'], byteLength: [0, 268435457, '3', 3.1], sha256: ['A'.repeat(64), 'x'], signerSha256: ['A'.repeat(64), 'x'],
  builtAtMs: [-1, 1.5, '1791028800000', Number.MAX_SAFE_INTEGER + 1], sourceCommit: ['a'.repeat(39), 'G'.repeat(40)], extra: ['private-path'] })) {
  test(`strict metadata rejects invalid ${field} without exposing its contents`, async t => {
    const f = await fixture(t);
    for (const value of values) {
      await f.publish({ ...metadata, [field]: value });
      await assert.rejects(f.service.manifest(context()), error => error instanceof AppUpdateError && error.message === 'La publicación de Relay no está disponible.');
    }
  });
}
for (const name of ['relay.apk', 'release.json']) for (const link of ['symlink', 'hardlink']) {
  test(`${link} ${name} is rejected`, async t => {
    const f = await fixture(t); await f.publish(); const original = path.join(f.published, name), outside = path.join(f.root, 'outside');
    await fs.rename(original, outside);
    if (link === 'symlink') await fs.symlink(outside, original); else await fs.link(outside, original);
    await assert.rejects(f.service.manifest(context()), AppUpdateError);
  });
}
test('symlinked publication directory, writable ancestors and public permissions fail closed', async t => {
  const f = await fixture(t); await f.publish();
  await fs.rename(f.published, f.published + '-original'); await fs.symlink(f.published + '-original', f.published);
  await assert.rejects(f.service.manifest(context()), AppUpdateError);
  await fs.unlink(f.published); await fs.rename(f.published + '-original', f.published);
  await fs.chmod(f.root, 0o770); await assert.rejects(f.service.manifest(context()), AppUpdateError); await fs.chmod(f.root, 0o700);
  await fs.chmod(f.published, 0o755); await assert.rejects(f.service.manifest(context()), AppUpdateError); await fs.chmod(f.published, 0o700);
  await fs.chmod(path.join(f.published, 'relay.apk'), 0o644); await assert.rejects(f.service.manifest(context()), AppUpdateError);
});
test('oversize sparse APK and metadata are rejected before any bytes are read', async t => {
  const f = await fixture(t); await f.publish(); const apk = path.join(f.published, 'relay.apk');
  await fs.truncate(apk, 268435457); const open = fs.open.bind(fs); let read = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); t.mock.method(file, 'read', async () => { read = true; throw new Error('Must reject before reading'); }); return file;
  });
  await assert.rejects(f.service.manifest(context()), AppUpdateError); assert.equal(read, false);
  await fs.truncate(apk, 3); await fs.truncate(path.join(f.published, 'release.json'), 16385);
  await assert.rejects(f.service.manifest(context()), AppUpdateError); assert.equal(read, false);
});
for (const attack of ['source-swap', 'metadata-change', 'ancestor-swap', 'source-grow'] as const) {
  test(`${attack} during copy cannot publish a mixed or escaped snapshot`, async t => {
    const f = await fixture(t); await f.publish(); const open = fs.open.bind(fs); let attacked = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && !(args[1] & 64)) {
        const read = file.read.bind(file);
        t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
          const result = await read(...params);
          if (!attacked) {
            attacked = true;
            if (attack === 'source-swap') { await fs.rename(path.join(f.published, 'relay.apk'), path.join(f.published, 'old.apk')); await fs.writeFile(path.join(f.published, 'relay.apk'), 'xyz', { mode: 0o600 }); }
            if (attack === 'metadata-change') await fs.writeFile(path.join(f.published, 'release.json'), JSON.stringify({ ...metadata, versionCode: 3 }));
            if (attack === 'source-grow') await fs.appendFile(path.join(f.published, 'relay.apk'), 'new bytes');
            if (attack === 'ancestor-swap') { await fs.rename(f.published, f.published + '-old'); await fs.symlink(f.published + '-old', f.published); }
          }
          return result;
        });
      }
      return file;
    });
    await assert.rejects(f.service.manifest(context()), AppUpdateError); assert.equal(attacked, true);
    assert.deepEqual(await fs.readdir(f.slots), []);
  });
}
test('exact If-Match and per-device/global admission preserve one download and bounded snapshots', async t => {
  const f = await fixture(t); await f.publish(); const first = await f.service.manifest(context());
  if (first.state !== 'published') throw new Error('Missing fixture publication');
  for (const value of [undefined, '*', 'W/"' + first.revision + '"', first.revision, '"' + first.revision + '","' + first.revision + '"'])
    await assert.rejects(f.service.download(value, context()), e => e instanceof AppUpdateError && e.status === 428);
  const downloads: Awaited<ReturnType<AppUpdates['download']>>[] = [];
  t.after(async () => { for (const download of downloads) await download.release(); });
  for (let i = 0; i < 4; i++) downloads.push(await f.service.download('"' + first.revision + '"', { ...context(), deviceId: String(i) }));
  await assert.rejects(f.service.download('"' + first.revision + '"', { ...context(), deviceId: '0' }), e => e instanceof AppUpdateError && e.status === 429);
  await assert.rejects(f.service.download('"' + first.revision + '"', context()), e => e instanceof AppUpdateError && e.status === 429);
  await f.publish({ ...metadata, versionCode: 3 }); const second = await f.service.manifest(context()); assert.equal(second.state, 'published');
  await assert.rejects(f.service.download('"' + first.revision + '"', { ...context(), deviceId: '0' }), AppUpdateError);
  await f.publish({ ...metadata, versionCode: 4 });
  await assert.rejects(f.service.manifest(context()), e => e instanceof AppUpdateError && e.status === 429);
  for (const download of downloads) { await download.release(); await download.release(); }
  const third = await f.service.manifest(context()); assert.equal(third.state, 'published');
  await assert.rejects(f.service.download('"' + first.revision + '"', context()), e => e instanceof AppUpdateError && e.status === 412);
});

test('copy deadline detaches consumers while a filesystem read is still pending', async t => {
  const f = await fixture(t); await f.publish(); const open = fs.open.bind(fs);
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && !(args[1] & 64)) {
      const read = file.read.bind(file); t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => { enter(); await held; return read(...params); });
    }
    return file;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.service.manifest(context()); await entered;
  const result = pending.then(() => 'published', () => 'rejected'); t.mock.timers.tick(30_000);
  const observed = await Promise.race([result, Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()).then(() => 'still-pending')]);
  release(); await result; assert.equal(observed, 'rejected');
});

test('snapshots awaiting removal still occupy their disk slot and are disposed only once', async t => {
  const f = await fixture(t); await f.publish(); const first = await f.service.manifest(context());
  if (first.state !== 'published') throw new Error('Missing fixture publication');
  const old = await f.service.download('"' + first.revision + '"', context());
  await f.publish({ ...metadata, versionCode: 3 }); await f.service.manifest(context());
  const rm = fs.rmdir.bind(fs); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; }); let blocked = false;
  t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
    if (!blocked && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).includes('/app-update-')) { blocked = true; enter(); await held; }
    return rm(...args);
  });
  const removing = old.release(); await entered;
  await f.publish({ ...metadata, versionCode: 4 }); const next = f.service.manifest(context());
  await new Promise(resolve => setTimeout(resolve, 20));
  const slots = (await fs.readdir(f.slots)).length;
  release(); await removing; await next; assert.ok(slots <= 2, 'A disposing snapshot must count against the two-slot disk budget');
});

test('revocation after the source is closed cannot return metadata from an already completed copy', async t => {
  const f = await fixture(t); await f.publish(); const open = fs.open.bind(fs); let firstSource = true, revoked = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (firstSource && String(args[0]).endsWith('/relay.apk') && typeof args[1] === 'number' && !(args[1] & 64)) {
      firstSource = false; const close = file.close.bind(file);
      t.mock.method(file, 'close', async () => { await close(); revoked = true; });
    }
    return file;
  });
  await assert.rejects(f.service.manifest({ ...context(), guard() { if (revoked) throw new Error('synthetic-revoked-context'); } }), /synthetic-revoked-context/);
});

test('two reserved slots from an interrupted instance fail closed without scanning or allocating a third snapshot', async t => {
  const f = await fixture(t); await f.publish();
  for (const name of ['app-update-slot-0', 'app-update-slot-1']) {
    await fs.mkdir(path.join(f.slots, name), { mode: 0o700 });
    await fs.writeFile(path.join(f.slots, name, 'relay.apk'), 'previous-private-snapshot', { mode: 0o600 });
  }
  await assert.rejects(f.service.manifest(context()), e => e instanceof AppUpdateError && e.status === 429);
  assert.deepEqual((await fs.readdir(f.slots)).sort(), ['app-update-slot-0', 'app-update-slot-1']);
});

test('review: snapshot disposal never removes a replacement reservation owned by another instance',async t=>{
 const f=await fixture(t);await f.publish();
 assert.equal((await f.service.manifest(context())).state,'published');
 const originalSlot=path.join(f.slots,'app-update-slot-0');
 const originalIdentity=await fs.stat(originalSlot);
 // Synthetic local directory replacement; both services retain their own descriptors.
 await fs.rename(originalSlot,originalSlot+'.retired');
 const other=new AppUpdates({root:f.published,privateRoot:f.privateRoot});t.after(()=>other.close());
 assert.equal((await other.manifest(context())).state,'published');
 const replacementIdentity=await fs.stat(originalSlot);
 assert.notEqual(replacementIdentity.ino,originalIdentity.ino);
 await fs.writeFile(path.join(originalSlot,'other-instance-marker'),'synthetic-owned-by-other');
 await f.service.close();
 let survives=true;try{await fs.stat(path.join(originalSlot,'other-instance-marker'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')survives=false;else throw e;}
 console.log(JSON.stringify({originalInode:originalIdentity.ino,replacementInode:replacementIdentity.ino,replacementSurvives:survives}));
 assert.equal(survives,true,'Cleanup by stale slot name removed another instance reservation');
 await assert.rejects(fs.stat(path.join(originalSlot+'.retired','relay.apk')), { code: 'ENOENT' }, 'The descriptor-owned snapshot must not leak its byte budget after a rename');
 assert.equal((await other.manifest(context())).state,'published');
});

test('closing a renamed snapshot preserves an empty reservation while another instance opens it', async t => {
  const f = await fixture(t); await f.publish(); await f.service.manifest(context());
  const slot = path.join(f.slots, 'app-update-slot-0'); await fs.rename(slot, slot + '.retired');
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }); const held = new Promise<void>(r => { release = r; });
  const open = fs.open.bind(fs); let blocked = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!blocked && String(args[0]).endsWith('/app-update-slot-0')) { blocked = true; enter(); await held; }
    return open(...args);
  });
  const other = new AppUpdates({ root: f.published, privateRoot: f.privateRoot }); t.after(() => other.close());
  const pending = other.manifest(context()); const outcome = pending.then(value => value, error => error);
  await entered;
  try {
    await f.service.close();
    assert.equal((await fs.stat(slot)).isDirectory(), true, 'Do not reclaim another in-flight empty reservation');
    await assert.rejects(fs.stat(slot + '.retired/relay.apk'), { code: 'ENOENT' });
  } finally { release(); await outcome; }
  assert.equal((await pending).state, 'published');
});

test('reservation replacement during APK unlink is revalidated before removing the slot name', async t => {
  const f = await fixture(t); await f.publish(); await f.service.manifest(context());
  const slot = path.join(f.slots, 'app-update-slot-0'), unlink = fs.unlink.bind(fs); let replaced = false;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
    const result = await unlink(...args);
    if (!replaced && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/relay.apk')) {
      replaced = true; await fs.rename(slot, slot + '.retired'); await fs.mkdir(slot, { mode: 0o700 });
    }
    return result;
  });
  await f.service.close(); assert.equal(replaced, true); assert.equal((await fs.stat(slot)).isDirectory(), true);
});
test('the retained private APK snapshot is owner-only (0600) while held', async t => {
  const f = await fixture(t); await f.publish();
  const manifest = await f.service.manifest(context()); if (manifest.state !== 'published') throw new Error('Missing fixture publication');
  const download = await f.service.download('"' + manifest.revision + '"', context());
  assert.equal((await download.file.stat()).mode & 0o777, 0o600);
  await download.release();
});
