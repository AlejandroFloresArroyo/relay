// ProfileWriteGuard on a real disk: a write inside a Hermes profile keeps the previous version and is
// recorded before its effect; what cannot be kept, a profile itself or a folder holding one is
// refused. The Puente state is never written. Synthetic profiles only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import type { ChangeRecord } from '../src/changeLog.ts';
import { within } from '../src/remote/profileWriteGuard.ts';
import { exists, lab, needsNamespaces, ok, PHONE, rejects, revoked, snapshot, withBinds } from '../support/filesLab.ts';

const root = process.getuid?.() === 0;
const last = (records: ChangeRecord[]) => records.at(-1)!;

test('the Hermes home, a profile, the profiles folder and any folder holding them are never moved or deleted from Relay', async (t) => {
  const { base, home, hermes, external, files, version, records } = lab(t);
  fs.symlinkSync(hermes, path.join(home, 'to-hermes'));
  const p1 = path.join(hermes, 'profiles', 'p1');
  const protectedBefore = [snapshot(hermes), snapshot(external)];
  const homeBefore = snapshot(home);
  const attempts: [string, () => unknown][] = [
    ['delete a profile', () => files.delete({ path: p1, version: version(p1), confirm: true }, ok)],
    ['delete the profile link', () => files.delete({ path: path.join(hermes, 'profiles', 'p2'), version: version(path.join(hermes, 'profiles', 'p2')), confirm: true }, ok)],
    ['delete the profile kept elsewhere', () => files.delete({ path: external, version: version(external), confirm: true }, ok)],
    ['delete the profiles folder', () => files.delete({ path: path.join(hermes, 'profiles'), version: version(path.join(hermes, 'profiles')), confirm: true }, ok)],
    ['delete the Hermes home', () => files.delete({ path: hermes, version: version(hermes), confirm: true }, ok)],
    ['delete a folder that contains it', () => files.delete({ path: home, version: version(home), confirm: true }, ok)],
    ['rename a profile', () => files.move({ path: p1, version: version(p1), directory: path.join(hermes, 'profiles'), name: 'p3' }, ok)],
    ['move a folder that contains it', () => files.move({ path: home, version: version(home), directory: base, name: 'home2' }, ok)],
    ['rename the Hermes home through a link', () => files.move({ path: path.join(home, 'to-hermes', 'profiles'), version: version(path.join(hermes, 'profiles')), directory: hermes, name: 'other' }, ok)],
  ];
  for (const [label, attempt] of attempts) await rejects('remote_profile_protected', attempt, label);
  assert.deepEqual([snapshot(hermes), snapshot(external)], protectedBefore);
  assert.deepEqual(snapshot(home), homeBefore);
  assert.deepEqual(records(), []);
  // Deleting an outside link to it touches only the link.
  await files.delete({ path: path.join(home, 'to-hermes'), version: version(path.join(home, 'to-hermes')), confirm: true }, ok);
  assert.deepEqual([exists(path.join(home, 'to-hermes')), snapshot(hermes)], [false, protectedBefore[0]]);
});

test('deleting or moving out of a profile keeps the previous version first and records it, without its path', async (t) => {
  const { home, hermes, external, files, version, records, kept, changes } = lab(t);
  fs.symlinkSync(hermes, path.join(home, 'to-hermes'));
  const p1 = path.join(hermes, 'profiles', 'p1');
  // ADR 0006 case 1: a link from outside to SOUL.md.
  fs.symlinkSync(path.join(hermes, 'SOUL.md'), path.join(home, 'soul-link'));
  fs.writeFileSync(path.join(hermes, 'notes.md'), 'notes');
  const cases: [string, () => Promise<unknown>, string, string][] = [
    ['delete SOUL.md through an outside link to the Hermes home', () => files.delete({ path: path.join(home, 'to-hermes', 'SOUL.md'), version: version(path.join(hermes, 'SOUL.md')), confirm: true }, ok), 'remote.file.delete', 'default soul'],
    ['delete in a profile kept elsewhere', () => files.delete({ path: path.join(external, 'SOUL.md'), version: version(path.join(external, 'SOUL.md')), confirm: true }, ok), 'remote.file.delete', 'p2 soul'],
    ['rename inside a profile', () => files.move({ path: path.join(p1, 'SOUL.md'), version: version(path.join(p1, 'SOUL.md')), directory: p1, name: 'SOUL.old' }, ok), 'remote.file.rename', 'p1 soul'],
    ['move a profile file out', () => files.move({ path: path.join(hermes, 'notes.md'), version: version(path.join(hermes, 'notes.md')), directory: home, name: 'notes.md' }, ok), 'remote.file.move', 'notes'],
  ];
  for (const [label, run, action, previous] of cases) {
    await run();
    const record = last(records());
    assert.deepEqual([record.actor, record.action, record.target, record.details], [PHONE, action, { kind: 'server', id: 'local' }, { profile: true, previous: true }], label);
    assert.equal(kept(record), previous, label);
    assert.equal((fs.statSync(path.join(path.dirname(changes), `remote-file-${record.id}.previous`)).mode & 0o777), 0o600, label);
  }
  assert.deepEqual([exists(path.join(hermes, 'SOUL.md')), exists(path.join(external, 'SOUL.md')), fs.readFileSync(path.join(p1, 'SOUL.old'), 'utf8'), fs.readFileSync(path.join(home, 'notes.md'), 'utf8')], [false, false, 'p1 soul', 'notes']);
  // The outside link was never followed into a delete of itself: it is dangling now, not gone.
  assert.equal(fs.lstatSync(path.join(home, 'soul-link')).isSymbolicLink(), true);
  assert.doesNotMatch(fs.readFileSync(changes, 'utf8'), /SOUL|soul|notes|hermes|profiles/);
});

test('creating in a profile or moving into one is recorded as a profile write with nothing to keep', async (t) => {
  const { base, home, hermes, external, files, make, version, records, backups } = lab(t);
  fs.symlinkSync(hermes, path.join(home, 'to-hermes'));
  fs.writeFileSync(path.join(home, 'docs', 'move-me'), 'outsider');
  const p1 = path.join(hermes, 'profiles', 'p1');
  const writes: [string, () => Promise<unknown>, string][] = [
    ['create in the Hermes home', () => files.create({ directory: hermes, name: 'new', type: 'file' }, ok), 'remote.file.create'],
    ['create in a profile', () => files.create({ directory: p1, name: 'skills', type: 'directory' }, ok), 'remote.file.create'],
    ['create in a profile kept elsewhere', () => files.create({ directory: external, name: 'new', type: 'file' }, ok), 'remote.file.create'],
    ['create through an outside link', () => files.create({ directory: path.join(home, 'to-hermes'), name: 'other', type: 'file' }, ok), 'remote.file.create'],
    ['create a new profile', () => files.create({ directory: path.join(hermes, 'profiles'), name: 'p3', type: 'directory' }, ok), 'remote.file.create'],
    // ADR 0006 case 4: a file moved into a profile.
    ['move a file into a profile through a link', () => files.move({ path: path.join(home, 'docs', 'move-me'), version: version(path.join(home, 'docs', 'move-me')), directory: path.join(home, 'to-hermes', 'profiles', 'p1'), name: 'move-me' }, ok), 'remote.file.move'],
    ['delete an empty folder in a profile', () => files.delete({ path: path.join(p1, 'skills'), version: version(path.join(p1, 'skills')), confirm: true }, ok), 'remote.file.delete'],
  ];
  for (const [label, run, action] of writes) {
    await run();
    assert.deepEqual([last(records()).action, last(records()).details], [action, { profile: true, previous: false }], label);
  }
  assert.deepEqual(backups(), []);
  assert.deepEqual([fs.readFileSync(path.join(p1, 'move-me'), 'utf8'), exists(path.join(hermes, 'profiles', 'p3')), exists(path.join(hermes, 'other'))], ['outsider', true, true]);

  // A profiles folder that is a link out of the Hermes home is a profile where it really is.
  const linkedHermes = path.join(base, 'hermes-linked-profiles');
  const registry = path.join(base, 'elsewhere-profiles');
  fs.mkdirSync(registry);
  fs.mkdirSync(linkedHermes);
  fs.symlinkSync(registry, path.join(linkedHermes, 'profiles'));
  const linked = make(linkedHermes);
  await linked.create({ directory: registry, name: 'new-profile', type: 'directory' }, ok);
  assert.deepEqual(last(records()).details, { profile: true, previous: false });
  await rejects('remote_profile_protected', () => linked.delete({ path: path.join(linkedHermes, 'profiles'), version: version(path.join(linkedHermes, 'profiles')), confirm: true }, ok));
  assert.deepEqual(fs.readdirSync(registry), ['new-profile']);
});

test('what a profile write cannot keep is done on the computer', async (t) => {
  const { home, hermes, files, version, records, backups } = lab(t);
  const p1 = path.join(hermes, 'profiles', 'p1');
  fs.mkdirSync(path.join(p1, 'skills', 'one'), { recursive: true });
  fs.writeFileSync(path.join(p1, 'skills', 'one', 'SKILL.md'), 'skill');
  fs.symlinkSync('/etc/hostname', path.join(p1, 'linked'));
  fs.writeFileSync(path.join(hermes, 'state.db'), Buffer.alloc(REMOTE_LIMITS.editableTextBytes + 1));
  fs.writeFileSync(path.join(hermes, 'limit.txt'), Buffer.alloc(REMOTE_LIMITS.editableTextBytes, 0x61));
  const before = snapshot(hermes);
  await rejects('remote_profile_protected', () => files.delete({ path: path.join(p1, 'skills'), version: version(path.join(p1, 'skills')), confirm: true }, ok), 'a folder with content');
  await rejects('remote_profile_protected', () => files.move({ path: path.join(p1, 'skills'), version: version(path.join(p1, 'skills')), directory: home, name: 'skills' }, ok), 'moving a folder with content out');
  await rejects('remote_profile_protected', () => files.delete({ path: path.join(p1, 'linked'), version: version(path.join(p1, 'linked')), confirm: true }, ok), 'a link');
  await rejects('remote_profile_protected', () => files.delete({ path: path.join(hermes, 'state.db'), version: version(path.join(hermes, 'state.db')), confirm: true }, ok), 'over the size it can keep');
  assert.deepEqual(snapshot(hermes), before);
  assert.deepEqual([records(), backups()], [[], []]);
  // At the limit it is kept.
  await files.delete({ path: path.join(hermes, 'limit.txt'), version: version(path.join(hermes, 'limit.txt')), confirm: true }, ok);
  assert.equal(backups().length, 1);
});

test('a previous version that cannot be kept publishes nothing', { skip: root ? 'running as root' : false }, async (t) => {
  const { hermes, state, files, version, records, backups } = lab(t);
  const soul = path.join(hermes, 'SOUL.md');
  // The state folder refuses the backup: the write stops there, before the record and the effect.
  fs.chmodSync(state, 0o500);
  await rejects('remote_unavailable', () => files.delete({ path: soul, version: version(soul), confirm: true }, ok));
  fs.chmodSync(state, 0o700);
  assert.deepEqual([fs.readFileSync(soul, 'utf8'), records(), backups()], ['default soul', [], []]);
});

test('a device revoked before the previous version is kept leaves no backup, and one revoked while it is kept leaves no record', async (t) => {
  const { hermes, files, version, records, backups } = lab(t);
  const soul = path.join(hermes, 'SOUL.md');
  await assert.rejects(files.delete({ path: soul, version: version(soul), confirm: true }, revoked), /device_revoked/);
  assert.deepEqual([backups(), records()], [[], []]);
  // The first check passes; the revocation lands while the backup is written.
  let checks = 0;
  const whileKept = { ...ok, guard() { if (++checks > 1) throw new Error('device_revoked'); } };
  await assert.rejects(files.delete({ path: soul, version: version(soul), confirm: true }, whileKept), /device_revoked/);
  assert.deepEqual([fs.readFileSync(soul, 'utf8'), records()], ['default soul', []]);
});

test('a Hermes home that is itself a link is protected at both ends', async (t) => {
  const { base, home, files, make, version, records } = lab(t);
  const real = path.join(base, 'data-hermes');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'SOUL.md'), 'linked soul');
  const link = path.join(home, '.hermes-link');
  fs.symlinkSync(real, link);
  const linked = make(link);
  await rejects('remote_profile_protected', () => linked.delete({ path: link, version: version(link), confirm: true }, ok));
  await rejects('remote_profile_protected', () => linked.move({ path: link, version: version(link), directory: home, name: 'renamed' }, ok));
  await rejects('remote_profile_protected', () => linked.delete({ path: real, version: version(real), confirm: true }, ok));
  assert.equal(fs.readlinkSync(link), real);
  await linked.create({ directory: real, name: 'x', type: 'file' }, ok);
  assert.deepEqual(last(records()).details, { profile: true, previous: false });
  // A Hermes home that does not exist yet cannot be created from Relay either.
  const missing = make(path.join(home, 'not-yet'));
  await rejects('remote_profile_protected', () => missing.create({ directory: home, name: 'not-yet', type: 'directory' }, ok));
  assert.equal((await files.list({ path: home })).entries.some((candidate) => candidate.name === 'not-yet'), false);
});

test('a profile reached through a bind mount is still a profile: kept, recorded or refused as where it really is', { skip: needsNamespaces }, (t) => {
  const laboratory = lab(t);
  const { home, hermes, state, records, kept } = laboratory;
  const p1 = path.join(hermes, 'profiles', 'p1');
  fs.mkdirSync(path.join(p1, 'memories'));
  fs.writeFileSync(path.join(p1, 'memories', 'MEMORY.md'), 'memory');
  // A space and a backslash in a mount point: /proc/self/mountinfo escapes them in octal.
  const [bound, memories, registry, bridge] = ['bound \\ here', 'mem', 'reg', 'st'].map((name) => path.join(home, name));
  for (const directory of [bound, memories, registry, bridge]) fs.mkdirSync(directory);
  const results = withBinds(laboratory, [[p1, bound], [path.join(p1, 'memories'), memories], [path.join(hermes, 'profiles'), registry], [state, bridge]], `return [
    await attempt(() => save(${JSON.stringify(path.join(bound, 'SOUL.md'))}, 'bound save')),
    await attempt(() => files.delete({ path: ${JSON.stringify(path.join(memories, 'MEMORY.md'))}, version: version(${JSON.stringify(path.join(memories, 'MEMORY.md'))}), confirm: true }, context)),
    await attempt(() => files.create({ directory: ${JSON.stringify(bound)}, name: 'new', type: 'file' }, context)),
    await attempt(() => files.delete({ path: ${JSON.stringify(path.join(registry, 'p1'))}, version: version(${JSON.stringify(path.join(registry, 'p1'))}), confirm: true }, context)),
    await attempt(() => files.create({ directory: ${JSON.stringify(bridge)}, name: 'new', type: 'file' }, context)),
    await attempt(() => save(${JSON.stringify(path.join(bridge, 'devices.json'))}, 'replaced')),
  ];`);
  assert.deepEqual(results, ['done', 'done', 'done', 'remote_profile_protected', 'remote_bridge_protected', 'remote_bridge_protected']);
  assert.deepEqual(records().map((record) => [record.action, record.details]), [
    ['remote.file.write', { profile: true, previous: true }], ['remote.file.delete', { profile: true, previous: true }], ['remote.file.create', { profile: true, previous: false }],
  ]);
  assert.deepEqual([kept(records()[0]!), kept(records()[1]!)], ['p1 soul', 'memory']);
  assert.deepEqual([fs.readFileSync(path.join(p1, 'SOUL.md'), 'utf8'), exists(path.join(p1, 'memories', 'MEMORY.md')), exists(path.join(p1, 'new'))], ['bound save', false, true]);
  assert.deepEqual([fs.readdirSync(state).filter((name) => !name.endsWith('.previous')).sort(), fs.readFileSync(path.join(state, 'devices.json'), 'utf8')], [['changes.jsonl', 'devices.json'], 'devices.json of the Puente']);
});

test('a mount at the root of the tree contains every path, and a folder never contains its name-sake sibling', () => {
  // Where / is one disk with the home in it (ext4, btrfs), every location is under the mount point '/'.
  assert.deepEqual([within('/', '/home/a'), within('/home', '/home/a'), within('/home', '/homes/a'), within('/home', '/home')], [true, true, false, false]);
});

test('the Puente state and ~/.config/relay are never created in, moved or deleted', async (t) => {
  const { base, home, state, config, changes, files, version } = lab(t);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'signing.properties'), 'private');
  fs.symlinkSync(state, path.join(home, 'to-state'));
  const before = [snapshot(state), snapshot(config)];
  const attempts: [string, () => unknown][] = [
    ['create in the state', () => files.create({ directory: state, name: 'new', type: 'file' }, ok)],
    ['create in the state through a link', () => files.create({ directory: path.join(home, 'to-state'), name: 'new', type: 'directory' }, ok)],
    ['create in ~/.config/relay', () => files.create({ directory: config, name: 'new', type: 'file' }, ok)],
    ['delete changes.jsonl', () => files.delete({ path: changes, version: version(changes), confirm: true }, ok)],
    ['delete devices.json', () => files.delete({ path: path.join(state, 'devices.json'), version: version(path.join(state, 'devices.json')), confirm: true }, ok)],
    ['delete the state', () => files.delete({ path: state, version: version(state), confirm: true }, ok)],
    ['delete ~/.config/relay', () => files.delete({ path: config, version: version(config), confirm: true }, ok)],
    ['delete ~/.config', () => files.delete({ path: path.dirname(config), version: version(path.dirname(config)), confirm: true }, ok)],
    ['move changes.jsonl out', () => files.move({ path: changes, version: version(changes), directory: base, name: 'changes.jsonl' }, ok)],
    ['move a file into the state', () => files.move({ path: path.join(home, 'docs', 'a.txt'), version: version(path.join(home, 'docs', 'a.txt')), directory: state, name: 'a.txt' }, ok)],
    ['rename ~/.config/relay', () => files.move({ path: config, version: version(config), directory: path.dirname(config), name: 'relay-old' }, ok)],
  ];
  for (const [label, attempt] of attempts) await rejects('remote_bridge_protected', attempt, label);
  assert.deepEqual([snapshot(state), snapshot(config)], before);
  assert.deepEqual((await files.list({ path: state })).entries.map((entry) => entry.name), ['changes.jsonl', 'devices.json']);
});

test('a listing and a read say where a write lands: a profile, the Puente state or neither', async (t) => {
  const { home, hermes, external, state, config, files } = lab(t);
  fs.mkdirSync(config, { recursive: true });
  fs.symlinkSync(hermes, path.join(home, 'to-hermes'));
  const zone = async (folder: string) => (await files.list({ path: folder, hidden: true })).protection;
  // The folder holding the Hermes home is not itself a profile; inside it, and through any link, it is.
  assert.deepEqual(await Promise.all([home, path.join(home, 'docs'), hermes, path.join(hermes, 'profiles'), path.join(hermes, 'profiles', 'p1'), path.join(hermes, 'profiles', 'p2'), external, path.join(home, 'to-hermes')].map(zone)),
    [null, null, 'profile', 'profile', 'profile', 'profile', 'profile', 'profile']);
  assert.deepEqual(await Promise.all([state, config].map(zone)), ['bridge', 'bridge']);
  assert.deepEqual([files.read({ path: path.join(home, 'docs', 'a.txt') }).protection, files.read({ path: path.join(home, 'to-hermes', 'SOUL.md') }).protection,
    files.read({ path: path.join(state, 'devices.json') }).protection], [null, 'profile', 'bridge']);
});
