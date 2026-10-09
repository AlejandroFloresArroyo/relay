import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBoardWebReader } from '../src/boardWebReader.ts';
const hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
async function fixture(t: import('node:test').TestContext) {
  const home = await fs.mkdtemp(path.resolve('board-web-fixture-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = Buffer.from('<!doctype html><script src="counter.js"></script><button id="count">Contar</button>');
  const script = Buffer.from('document.getElementById("count").onclick = function () { this.textContent = "1"; };');
  const manifest = { schemaVersion: 1, entry: 'index.html', files: [
    { name: 'counter.js', mime: 'application/javascript', bytes: script.length, sha256: hash(script) },
    { name: 'index.html', mime: 'text/html', bytes: source.length, sha256: hash(source) },
  ] };
  const revision = hash(JSON.stringify(manifest)); const root = path.join(home, 'relay-board-web', 'counter', revision);
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'index.html'), source); await fs.writeFile(path.join(root, 'counter.js'), script);
  const reader = createBoardWebReader(() => home);
  return { home, root, source, script, manifest, revision, reader };
}
test('a complete immutable bundle snapshot matches its canonical manifest revision and exact declared assets', async t => {
  const f = await fixture(t); const snapshot = await f.reader.snapshot('synthetic', 'counter', f.revision, () => {});
  assert.equal(snapshot.revision, f.revision); assert.deepEqual(snapshot.manifest, f.manifest);
  assert.deepEqual(snapshot.assets.get('index.html'), f.source); assert.equal(snapshot.byteLength, f.source.length + f.script.length);
  await fs.writeFile(path.join(f.root, 'index.html'), 'changed source');
  assert.deepEqual(snapshot.assets.get('index.html'), f.source);
  await assert.rejects(snapshot.verify(() => {}));
  await snapshot.dispose();
  await assert.rejects(f.reader.snapshot('synthetic', 'counter', f.revision, () => {}));
});

for (const attack of ['symlink', 'hardlink', 'directory-swap', 'asset-grow', 'manifest-change', 'revocation'] as const) {
  test(`${attack} cannot expose a partial or changed web bundle`, async t => {
    const f = await fixture(t); const open = fs.open.bind(fs); let attacked = false, revoked = false;
    if (attack === 'symlink' || attack === 'hardlink') {
      const asset = path.join(f.root, 'counter.js'), outside = path.join(f.home, 'outside.js'); await fs.rename(asset, outside);
      if (attack === 'symlink') await fs.symlink(outside, asset); else await fs.link(outside, asset);
    } else t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith('/counter.js')) {
        const read = file.read.bind(file); t.mock.method(file, 'read', async (...params: Parameters<typeof file.read>) => {
          const result = await read(...params);
          if (!attacked) {
            attacked = true;
            if (attack === 'directory-swap') { await fs.rename(f.root, f.root + '-old'); await fs.mkdir(f.root); }
            if (attack === 'asset-grow') await fs.appendFile(path.join(f.root, 'counter.js'), 'changed');
            if (attack === 'manifest-change') await fs.writeFile(path.join(f.root, 'manifest.json'), '{}');
            if (attack === 'revocation') revoked = true;
          }
          return result;
        });
      }
      return file;
    });
    await assert.rejects(f.reader.snapshot('synthetic', 'counter', f.revision, () => { if (revoked) throw new Error('synthetic-revoked'); }));
    if (!['symlink', 'hardlink'].includes(attack)) assert.equal(attacked, true);
  });
}
test('declared limits reject sparse assets before reading bytes and invalid ids never resolve a home', async t => {
  const f = await fixture(t); await fs.truncate(path.join(f.root, 'index.html'), 262145);
  const open = fs.open.bind(fs); let read = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args); if (String(args[0]).endsWith('/index.html')) t.mock.method(file, 'read', async () => { read = true; throw new Error('Must reject before read'); }); return file;
  });
  await assert.rejects(f.reader.snapshot('synthetic', 'counter', f.revision, () => {})); assert.equal(read, false);
  let homes = 0; const reader = createBoardWebReader(() => { homes++; return f.home; });
  for (const bundle of ['../counter', 'http://synthetic.test', 'a'.repeat(65), 'a%2fb']) await assert.rejects(reader.snapshot('synthetic', bundle, f.revision, () => {}));
  assert.equal(homes, 0);
});

test('strict manifest rejects extra fields, wrong MIME, duplicate names and every declared size bound', async t => {
  const { parseBoardWebManifest } = await import('../../protocol/boardWebValidation.ts'); const f = await fixture(t);
  const file = f.manifest.files[1];
  for (const manifest of [
    { ...f.manifest, url: 'https://synthetic.invalid' }, { ...f.manifest, entry: 'counter.js' },
    { ...f.manifest, files: [{ ...file, mime: 'text/plain' }] },
    { ...f.manifest, files: [file, file] }, { ...f.manifest, files: [{ ...file, path: '../outside' }] },
    { ...f.manifest, files: [{ ...file, bytes: 262145 }] }, { ...f.manifest, files: [{ ...file, bytes: 1.5 }] },
    { ...f.manifest, files: [{ ...file, name: 'a%2fb.html' }] },
    { ...f.manifest, files: Array.from({ length: 33 }, (_, i) => ({ ...file, name: i ? `a${i}.js` : 'index.html' })) },
    { ...f.manifest, files: Array.from({ length: 5 }, (_, i) => ({ ...file, name: i ? `a${i}.js` : 'index.html', mime: i ? 'application/javascript' : 'text/html', bytes: 262144 })) },
  ]) assert.equal(parseBoardWebManifest(manifest), null);
  assert.deepEqual(parseBoardWebManifest({ ...f.manifest, files: [...f.manifest.files].reverse() }), f.manifest);
  await fs.writeFile(path.join(f.root, 'manifest.json'), ' '.repeat(16385));
  await assert.rejects(f.reader.snapshot('synthetic', 'counter', f.revision, () => {}));
});
test('every bundle directory open refuses to follow symlinks (O_NOFOLLOW)', async t => {
  const f = await fixture(t); const open = fs.open; const flags: number[] = [];
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { if (typeof args[1] === 'number' && args[1] & constants.O_DIRECTORY) flags.push(args[1]); return open(...args); });
  const snapshot = await f.reader.snapshot('synthetic', 'counter', f.revision, () => {}); await snapshot.dispose();
  assert.ok(flags.length > 0); for (const flag of flags) assert.ok(flag & constants.O_NOFOLLOW, 'directory opened without O_NOFOLLOW');
});
