// Acceptance, scenario 3 of docs/relay-v3.md §7: create, move, transfer, delete and edit text;
// confirmations, a link against its destination, a concurrent conflict and the mandatory backup of
// Hermes profiles; an incomplete transfer never shows as finished. The real Puente over HTTP with the
// real file service on a throwaway home whose `.hermes` is a fixture (support/acceptance_lab.ts); the
// editor's side is the codec the app shares (protocol/textCodec.ts). Details and races are in
// remoteFiles, remoteFileSaves, remoteFileProfiles, remoteFileTransfers, remoteFileSearch and
// remoteFilesHttp tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { RemoteFileEntry, RemoteFileList, RemoteFileSearchEvent } from '../../../protocol/remoteFiles.ts';
import { decodeText, detectText, encodeText, type TextFormat } from '../../../protocol/textCodec.ts';
import { acceptanceLab, assertLogsClean, PHONE, SKIP, until, type Device } from '../../support/acceptance_lab.ts';
import { snapshot } from '../../support/filesLab.ts';

/** The fields of the files routes' answers this scenario reads (protocol/remoteFiles.ts). */
interface Reply {
  id: string; state: string; name: string; type: string; path: string; realPath: string; bytes: string;
  version: unknown; protection: string | null; entries: RemoteFileEntry[]; error?: { code: string };
}
interface Answer { status: number; json: Reply }
/** What these helpers use of a lab Puente (support/acceptance_lab.ts). */
interface Puente {
  base: string;
  headers(device: Device, capability: string): Record<string, string>;
  call(device: Device, method: string, route: string, body?: unknown, capability?: string): Promise<Answer>;
}
interface LabFiles { dirs: { relay: string }; logs: readonly string[]; supervisorOutput: readonly string[] }

const CHUNK = REMOTE_LIMITS.transferChunkBytes;
const UTF8: TextFormat = { encoding: 'utf-8', bom: false };
const files = (puente: Puente, route: string, body?: unknown) => puente.call(PHONE, 'POST', `/v1/remote/${route}`, body, 'files/1');
const failure = (answer: Answer) => [answer.status, answer.json?.error?.code];
const isLink = async (file: string) => (await fs.lstat(file)).isSymbolicLink();
const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

async function list(puente: Puente, directory: string, hidden = true): Promise<RemoteFileList> {
  const listed = await files(puente, 'files/list', { path: directory, hidden });
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  return listed.json as unknown as RemoteFileList;
}
async function entry(puente: Puente, directory: string, name: string): Promise<RemoteFileEntry> {
  const found = (await list(puente, directory)).entries.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is listed`);
  return found;
}
/** A raw chunk as the app sends it: application/octet-stream at an offset. */
async function put(puente: Puente, route: string, bytes: Uint8Array): Promise<Answer> {
  const response = await fetch(puente.base + route, {
    method: 'PUT', body: new Uint8Array(bytes), headers: { ...puente.headers(PHONE, 'files/1'), 'Content-Type': 'application/octet-stream' },
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function read(puente: Puente, file: string) {
  const answer = await files(puente, 'files/read', { path: file });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return { ...answer.json, bytes: Buffer.from(answer.json.bytes, 'base64') };
}
/** Opens a save and sends every byte; the commit is the caller's, with the version it read. */
async function startSave(puente: Puente, bytes: Uint8Array): Promise<string> {
  const started = await files(puente, 'files/saves', { size: bytes.length });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    assert.equal((await put(puente, `/v1/remote/files/saves/${started.json.id}/${offset}`, bytes.subarray(offset, offset + CHUNK))).status, 200);
  }
  return started.json.id;
}
const commit = (puente: Puente, id: string, file: string, version: unknown, format: TextFormat) => files(puente, `files/saves/${id}/commit`, { path: file, version, format });
/** The editor's side: decode in the file's format, edit, encode back in it without ever substituting. */
function edit(bytes: Uint8Array, format: TextFormat, change: (text: string) => string) {
  const text = decodeText(bytes, format);
  assert.notEqual(text, null, 'the file reads in its format');
  return encodeText(change(text!), format);
}
async function changeLines(lab: LabFiles) {
  return (await fs.readFile(path.join(lab.dirs.relay, 'changes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; action: string; target: { kind: string; id?: string }; details?: { profile: boolean; previous: boolean } });
}
/** What the person may never find in a log line, the supervisor's output or changes.jsonl. */
async function assertClean(lab: LabFiles, secrets: string[]) {
  assertLogsClean(lab.logs, secrets);
  for (const line of lab.supervisorOutput) for (const secret of secrets) assert.ok(!line.includes(secret), line);
  const changes = await fs.readFile(path.join(lab.dirs.relay, 'changes.jsonl'), 'utf8').catch(() => '');
  for (const secret of secrets) assert.ok(!changes.includes(secret), `changes.jsonl carries ${secret}`);
}

test('scenario 3a: list, create, rename, move and delete with confirmation; a link is listed with its destination and only the link goes', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  const puente = await lab.puente();
  const home = lab.dirs.home;

  // The home as the explorer opens it: dot entries only when asked.
  const plain = await files(puente, 'files/list', {});
  assert.equal(plain.status, 200);
  assert.equal(plain.json.path, home);
  assert.ok(!plain.json.entries.some((found: RemoteFileEntry) => found.name === '.hermes'));
  assert.equal((await entry(puente, home, '.hermes')).type, 'directory');
  assert.equal((await list(puente, lab.hermesHome)).protection, 'profile', 'the explorer warns before writing in Hermes');

  // Create a folder and a file in it; the same name again replaces nothing.
  const folder = path.join(home, 'informe-acc');
  assert.equal((await files(puente, 'files/create', { directory: home, name: 'informe-acc', type: 'directory' })).status, 200);
  const created = await files(puente, 'files/create', { directory: folder, name: 'borrador-acc.txt', type: 'file' });
  assert.deepEqual([created.status, created.json.name, created.json.type], [200, 'borrador-acc.txt', 'file']);
  await fs.writeFile(path.join(folder, 'borrador-acc.txt'), 'texto-del-borrador\n');
  assert.deepEqual(failure(await files(puente, 'files/create', { directory: folder, name: 'borrador-acc.txt', type: 'file' })), [409, 'remote_exists']);
  assert.equal(await fs.readFile(path.join(folder, 'borrador-acc.txt'), 'utf8'), 'texto-del-borrador\n', 'creating never empties an existing file');

  // Rename in place, then move to another folder; a move onto an existing name replaces nothing.
  const draft = await entry(puente, folder, 'borrador-acc.txt');
  assert.equal((await files(puente, 'files/move', { path: path.join(folder, 'borrador-acc.txt'), version: draft.version, directory: folder, name: 'final-acc.txt' })).status, 200);
  const archive = path.join(home, 'archivo-acc');
  await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, 'final-acc.txt'), 'ocupante-previo\n');
  const renamed = await entry(puente, folder, 'final-acc.txt');
  const before = snapshot(home);
  assert.deepEqual(failure(await files(puente, 'files/move', { path: path.join(folder, 'final-acc.txt'), version: renamed.version, directory: archive, name: 'final-acc.txt' })), [409, 'remote_exists']);
  assert.deepEqual(snapshot(home), before, 'a refused move changes nothing');
  assert.equal((await files(puente, 'files/move', { path: path.join(folder, 'final-acc.txt'), version: renamed.version, directory: archive, name: 'movido-acc.txt' })).status, 200);
  assert.equal(await fs.readFile(path.join(archive, 'movido-acc.txt'), 'utf8'), 'texto-del-borrador\n');
  assert.equal(await exists(path.join(folder, 'final-acc.txt')), false);

  // Deleting a file or a folder with content asks first; unconfirmed, nothing changes.
  const moved = await entry(puente, archive, 'movido-acc.txt');
  const full = await entry(puente, home, 'archivo-acc');
  const unconfirmed = snapshot(home);
  assert.deepEqual(failure(await files(puente, 'files/delete', { path: path.join(archive, 'movido-acc.txt'), version: moved.version })), [428, 'remote_confirmation_required']);
  assert.deepEqual(failure(await files(puente, 'files/delete', { path: archive, version: full.version })), [428, 'remote_confirmation_required']);
  assert.deepEqual(snapshot(home), unconfirmed, 'nothing deleted without confirmation');
  assert.equal((await files(puente, 'files/delete', { path: path.join(archive, 'movido-acc.txt'), version: moved.version, confirm: true })).status, 200);
  assert.equal(await exists(path.join(archive, 'movido-acc.txt')), false);
  const stillFull = await entry(puente, home, 'archivo-acc');
  assert.equal((await files(puente, 'files/delete', { path: archive, version: stillFull.version, confirm: true })).status, 200);
  assert.equal(await exists(archive), false, 'the folder went with its content');

  // Links: listed as links with their destination; entering one lists the destination.
  const target = path.join(home, 'destino-acc');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'nota-acc.txt'), 'nota-original\n');
  await fs.symlink('destino-acc', path.join(home, 'enlace-carpeta-acc'));
  await fs.symlink('destino-acc/nota-acc.txt', path.join(home, 'enlace-nota-acc'));
  await fs.symlink('no-existe-acc', path.join(home, 'enlace-roto-acc'));
  const toFolder = await entry(puente, home, 'enlace-carpeta-acc');
  assert.deepEqual([toFolder.type, toFolder.link], ['symlink', { target: 'destino-acc', realPath: target, type: 'directory' }]);
  const toNote = await entry(puente, home, 'enlace-nota-acc');
  assert.deepEqual([toNote.type, toNote.link], ['symlink', { target: 'destino-acc/nota-acc.txt', realPath: path.join(target, 'nota-acc.txt'), type: 'file' }]);
  assert.deepEqual((await entry(puente, home, 'enlace-roto-acc')).link, { target: 'no-existe-acc', realPath: null, type: null });
  const through = await list(puente, path.join(home, 'enlace-carpeta-acc'));
  assert.deepEqual([through.realPath, through.entries.map((found) => found.name)], [target, ['nota-acc.txt']]);

  // Saving through the link writes its destination and the link stays a link.
  const opened = await read(puente, path.join(home, 'enlace-nota-acc'));
  assert.equal(opened.realPath, path.join(target, 'nota-acc.txt'));
  const saveId = await startSave(puente, Buffer.from('nota-editada\n'));
  assert.equal((await commit(puente, saveId, path.join(home, 'enlace-nota-acc'), opened.version, UTF8)).status, 200);
  assert.equal(await fs.readFile(path.join(target, 'nota-acc.txt'), 'utf8'), 'nota-editada\n');
  assert.ok(await isLink(path.join(home, 'enlace-nota-acc')));
  // An upload onto the link overwrites only with the confirmed version, writes the destination, keeps the link.
  const upload = await files(puente, 'files/uploads', { directory: home, name: 'enlace-nota-acc', size: 14 });
  assert.equal((await put(puente, `/v1/remote/files/uploads/${upload.json.id}/0`, Buffer.from('nota-subida-x\n'))).status, 200);
  assert.deepEqual(failure(await files(puente, `files/uploads/${upload.json.id}/commit`, {})), [428, 'remote_confirmation_required']);
  assert.equal(await fs.readFile(path.join(target, 'nota-acc.txt'), 'utf8'), 'nota-editada\n', 'nothing overwritten unconfirmed');
  const confirmed = await entry(puente, home, 'enlace-nota-acc');
  assert.equal((await files(puente, `files/uploads/${upload.json.id}/commit`, { replace: confirmed.version })).status, 200);
  assert.equal(await fs.readFile(path.join(target, 'nota-acc.txt'), 'utf8'), 'nota-subida-x\n');
  assert.ok(await isLink(path.join(home, 'enlace-nota-acc')));

  // Deleting a link removes the link, never its destination.
  for (const name of ['enlace-carpeta-acc', 'enlace-nota-acc']) {
    const link = await entry(puente, home, name);
    assert.equal((await files(puente, 'files/delete', { path: path.join(home, name), version: link.version, confirm: true })).status, 200);
    assert.equal(await exists(path.join(home, name)), false);
  }
  assert.deepEqual(await fs.readdir(target), ['nota-acc.txt']);
  assert.equal(await fs.readFile(path.join(target, 'nota-acc.txt'), 'utf8'), 'nota-subida-x\n');

  // Every write in changes.jsonl, without path or content; the unconfirmed and refused ones are not effects.
  const actions = (await changeLines(lab)).map((record) => record.action);
  for (const action of ['create', 'write', 'move', 'rename', 'delete']) assert.ok(actions.includes(`remote.file.${action}`), `${action} recorded: ${actions}`);
  assert.ok((await changeLines(lab)).every((record) => record.target.kind === 'server' && record.target.id === 'local'));

  await assertClean(lab, [PHONE.key, lab.dirs.root, 'informe-acc', 'borrador-acc', 'final-acc', 'archivo-acc', 'movido-acc', 'destino-acc', 'enlace-', 'nota-acc',
    'texto-del-borrador', 'ocupante-previo', 'nota-original', 'nota-editada', 'nota-subida', 'no-existe-acc']);
});

test('scenario 3b: the editor keeps encoding, BOM and line endings, blocks lossy saves, refuses over 5 MiB and never overwrites a concurrent change unasked', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  const puente = await lab.puente();
  const folder = path.join(lab.dirs.home, 'textos-acc');
  await fs.mkdir(folder);
  // Windows-1252 differs from Latin-1 in 0x80–0x9F: «€» is 0x80 and «–» is 0x96.
  const cases: { name: string; format: TextFormat; text: string; encode: (text: string) => Buffer }[] = [
    { name: 'utf8-acc.txt', format: UTF8, text: 'Señal ✓ línea\nsegunda-acc\n', encode: (text) => Buffer.from(text) },
    { name: 'utf16le-acc.txt', format: { encoding: 'utf-16le', bom: true }, text: 'Ñandú\r\nsegunda-acc\r\n', encode: (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) },
    { name: 'utf16be-acc.txt', format: { encoding: 'utf-16be', bom: true }, text: 'Ñandú\nsegunda-acc\n', encode: (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]) },
    { name: 'latin1-acc.txt', format: { encoding: 'iso-8859-1', bom: false }, text: 'Año\nsegunda-acc\n', encode: (text) => Buffer.from(text, 'latin1') },
    { name: 'cp1252-acc.txt', format: { encoding: 'windows-1252', bom: false }, text: 'Café – €5\r\nsegunda-acc\r\n', encode: (text) => Buffer.from(text.replace('€', '\x80').replace('–', '\x96'), 'latin1') },
  ];
  for (const sample of cases) {
    const file = path.join(folder, sample.name);
    await fs.writeFile(file, sample.encode(sample.text));
    const opened = await read(puente, file);
    // With a BOM the format is certain; an 8-bit one is a guess among the offered formats the person picks.
    const detection = detectText(opened.bytes);
    assert.ok(detection.candidates.some((candidate) => isDeepStrictEqual(candidate, sample.format)), sample.name);
    assert.equal(detection.certain, sample.format.bom, sample.name);
    const edited = edit(opened.bytes, sample.format, (text) => text.replace('segunda-acc', 'editada-acc'));
    assert.ok(edited instanceof Uint8Array, sample.name);
    const saved = await commit(puente, await startSave(puente, edited), file, opened.version, sample.format);
    assert.equal(saved.status, 200, `${sample.name}: ${JSON.stringify(saved.json)}`);
    assert.deepEqual(await fs.readFile(file), sample.encode(sample.text.replace('segunda-acc', 'editada-acc')), `${sample.name} keeps its encoding, BOM and line endings`);
  }

  // The Puente never writes bytes that do not read back in the format they claim.
  const cp1252File = path.join(folder, 'cp1252-acc.txt');
  const cp1252Now = await fs.readFile(cp1252File);
  const notUtf8 = await commit(puente, await startSave(puente, Buffer.from([0x43, 0x61, 0x66, 0xe9])), cp1252File, (await read(puente, cp1252File)).version, UTF8);
  assert.deepEqual(failure(notUtf8), [400, 'remote_invalid_request']);
  assert.deepEqual(await fs.readFile(cp1252File), cp1252Now);

  // A character Latin-1 cannot hold blocks the save; the person can switch to UTF-8 instead.
  const latin1File = path.join(folder, 'latin1-acc.txt');
  const latin1 = await read(puente, latin1File);
  const addPrice = (text: string) => `${text}cuesta 5 €\n`;
  assert.deepEqual(edit(latin1.bytes, { encoding: 'iso-8859-1', bom: false }, addPrice), { unrepresentable: 'Año\neditada-acc\ncuesta 5 '.length });
  const asUtf8 = encodeText(addPrice(decodeText(latin1.bytes, { encoding: 'iso-8859-1', bom: false })!), UTF8);
  assert.ok(asUtf8 instanceof Uint8Array);
  assert.equal((await commit(puente, await startSave(puente, asUtf8), latin1File, latin1.version, UTF8)).status, 200);
  assert.deepEqual(await fs.readFile(latin1File), Buffer.from('Año\neditada-acc\ncuesta 5 €\n'));

  // 5 MiB of encoded bytes: a bigger file does not open, and a save is measured encoded (3 MiB of
  // text is 6 MiB in UTF-16), so it does not start.
  const big = path.join(folder, 'grande-acc.txt');
  await fs.writeFile(big, Buffer.alloc(REMOTE_LIMITS.editableTextBytes + 1, 0x61));
  assert.deepEqual(failure(await files(puente, 'files/read', { path: big })), [413, 'remote_too_large']);
  const wide = encodeText('a'.repeat(3 * 1024 * 1024), { encoding: 'utf-16le', bom: true });
  assert.ok(wide instanceof Uint8Array && wide.length > REMOTE_LIMITS.editableTextBytes);
  assert.deepEqual(failure(await files(puente, 'files/saves', { size: wide.length })), [413, 'remote_too_large']);

  // Concurrent change: the save is refused, the disk keeps the other change; overwriting is a commit
  // with the version read again, which the app shows and the person confirms.
  const shared = path.join(folder, 'conflicto-acc.txt');
  await fs.writeFile(shared, 'version-original\n');
  const first = await read(puente, shared);
  await fs.writeFile(shared, 'cambio-externo\n');
  const mine = Buffer.from('mi-borrador\n');
  const saveId = await startSave(puente, mine);
  assert.deepEqual(failure(await commit(puente, saveId, shared, first.version, UTF8)), [409, 'remote_conflict']);
  assert.equal(await fs.readFile(shared, 'utf8'), 'cambio-externo\n');
  assert.deepEqual((await fs.readdir(folder)).filter((name) => name.startsWith('.relay-')), [], 'no temporary left by the refused save');
  const again = await read(puente, shared);
  assert.equal(again.bytes.toString(), 'cambio-externo\n', 'what the app shows before the person confirms');
  assert.equal((await commit(puente, saveId, shared, again.version, UTF8)).status, 200);
  assert.equal(await fs.readFile(shared, 'utf8'), 'mi-borrador\n');

  await assertClean(lab, [PHONE.key, lab.dirs.root, 'textos-acc', '-acc.txt', 'segunda-acc', 'editada-acc', 'Ñandú', 'Señal', 'cuesta 5', 'version-original', 'cambio-externo', 'mi-borrador']);
});

test('scenario 3c: Hermes profiles keep the previous version of every write and are never moved from Relay', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  const puente = await lab.puente();
  const home = lab.dirs.home;
  const soul = path.join(lab.hermesHome, 'SOUL.md');
  const coding = path.join(lab.hermesHome, 'profiles', 'coding');
  /** The backup the guard kept for the last profile write: remote-file-<record id>.previous in the Puente's state. */
  const lastBackup = async (action: string) => {
    const record = (await changeLines(lab)).filter((change) => change.action === `remote.file.${action}`).at(-1);
    assert.deepEqual(record?.details, { profile: true, previous: true });
    return fs.readFile(path.join(lab.dirs.relay, `remote-file-${record!.id}.previous`), 'utf8');
  };
  // Saving the default profile's SOUL.md keeps what it replaces.
  const opened = await read(puente, soul);
  assert.equal(opened.protection, 'profile');
  assert.equal((await commit(puente, await startSave(puente, Buffer.from('Alma editada-acc\n')), soul, opened.version, UTF8)).status, 200);
  assert.equal(await fs.readFile(soul, 'utf8'), 'Alma editada-acc\n');
  assert.equal(await lastBackup('write'), 'Alma de prueba\n');

  // A link from outside into a profile: the profile is read and saved, its version kept, the link stays.
  const link = path.join(home, 'alma-enlace-acc');
  await fs.symlink(path.join(coding, 'SOUL.md'), link);
  const throughLink = await read(puente, link);
  assert.deepEqual([throughLink.realPath, throughLink.protection], [path.join(coding, 'SOUL.md'), 'profile']);
  assert.equal((await commit(puente, await startSave(puente, Buffer.from('Coding editado-acc\n')), link, throughLink.version, UTF8)).status, 200);
  assert.equal(await fs.readFile(path.join(coding, 'SOUL.md'), 'utf8'), 'Coding editado-acc\n');
  assert.equal(await lastBackup('write'), 'Alma de coding\n');
  assert.ok(await isLink(link));

  // `..` is refused, never normalized: neither read, saved nor moved.
  const dotted = path.join(lab.hermesHome, 'profiles') + '/../SOUL.md';
  const before = [await fs.readdir(lab.dirs.relay), (await changeLines(lab)).length];
  assert.deepEqual(failure(await files(puente, 'files/read', { path: dotted })), [400, 'remote_invalid_request']);
  const current = await read(puente, soul);
  assert.deepEqual(failure(await commit(puente, await startSave(puente, Buffer.from('por-puntos-acc\n')), dotted, current.version, UTF8)), [400, 'remote_invalid_request']);
  assert.deepEqual(failure(await files(puente, 'files/move', { path: dotted, version: (await entry(puente, lab.hermesHome, 'SOUL.md')).version, directory: home, name: 'robado-acc.md' })), [400, 'remote_invalid_request']);
  assert.equal(await fs.readFile(soul, 'utf8'), 'Alma editada-acc\n');

  // A profile, the profiles folder, the Hermes home and a folder above it are never moved nor deleted.
  const untouched = snapshot(home);
  const profileEntry = await entry(puente, path.join(lab.hermesHome, 'profiles'), 'coding');
  assert.deepEqual(failure(await files(puente, 'files/move', { path: coding, version: profileEntry.version, directory: path.join(lab.hermesHome, 'profiles'), name: 'coding-acc' })), [403, 'remote_profile_protected']);
  const hermesEntry = await entry(puente, home, '.hermes');
  assert.deepEqual(failure(await files(puente, 'files/move', { path: lab.hermesHome, version: hermesEntry.version, directory: lab.dirs.downloads, name: 'hermes-acc' })), [403, 'remote_profile_protected']);
  const homeEntry = await entry(puente, lab.dirs.root, 'home');
  assert.deepEqual(failure(await files(puente, 'files/move', { path: home, version: homeEntry.version, directory: lab.dirs.root, name: 'casa-acc' })), [403, 'remote_profile_protected']);
  const registry = await entry(puente, lab.hermesHome, 'profiles');
  assert.deepEqual(failure(await files(puente, 'files/delete', { path: path.join(lab.hermesHome, 'profiles'), version: registry.version, confirm: true })), [403, 'remote_profile_protected']);
  assert.deepEqual(snapshot(home), untouched, 'nothing moved nor deleted');
  assert.deepEqual([await fs.readdir(lab.dirs.relay), (await changeLines(lab)).length], before, 'refusals keep and record nothing');

  // Moving a file into a profile is a profile write with nothing to keep; deleting it from there keeps it.
  await fs.writeFile(path.join(home, 'notas-perfil-acc.md'), 'notas-para-el-perfil\n');
  const loose = await entry(puente, home, 'notas-perfil-acc.md');
  assert.equal((await files(puente, 'files/move', { path: path.join(home, 'notas-perfil-acc.md'), version: loose.version, directory: coding, name: 'notas-perfil-acc.md' })).status, 200);
  assert.deepEqual((await changeLines(lab)).at(-1)?.details, { profile: true, previous: false });
  const inProfile = await entry(puente, coding, 'notas-perfil-acc.md');
  assert.equal((await files(puente, 'files/delete', { path: path.join(coding, 'notas-perfil-acc.md'), version: inProfile.version, confirm: true })).status, 200);
  assert.equal(await lastBackup('delete'), 'notas-para-el-perfil\n');

  await assertClean(lab, [PHONE.key, lab.dirs.root, 'SOUL', 'Alma', 'Coding editado', 'alma-enlace', 'por-puntos', 'robado-acc', 'coding-acc', 'hermes-acc', 'casa-acc', 'notas-perfil', 'notas-para-el-perfil']);
});

test('scenario 3d: transfers arrive whole or not at all; cancelled, interrupted and incomplete ones never show as finished; search with cancellation', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  let puente = await lab.puente();
  const folder = path.join(lab.dirs.home, 'transferencias-acc');
  await fs.mkdir(folder);
  const payload = Buffer.alloc(2 * CHUNK + 12_345);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 7) & 0xff;
  const temporaries = async () => (await fs.readdir(folder)).filter((name) => name.startsWith('.relay-upload-'));
  const listedNames = async () => (await list(puente, folder)).entries.map((found) => found.name);

  // Several chunks up and back down, byte for byte.
  const published = await puente.upload(PHONE, folder, 'datos-acc.bin', payload);
  assert.equal(published, path.join(folder, 'datos-acc.bin'));
  assert.ok((await fs.readFile(published)).equals(payload));
  assert.ok((await puente.download(PHONE, published)).equals(payload));
  assert.deepEqual(await temporaries(), []);

  // An upload in flight is only a hidden temporary: never listed, never under its name.
  const partial = await files(puente, 'files/uploads', { directory: folder, name: 'parcial-acc.bin', size: payload.length });
  assert.equal(partial.status, 200);
  assert.equal((await put(puente, `/v1/remote/files/uploads/${partial.json.id}/0`, payload.subarray(0, CHUNK))).status, 200);
  assert.equal((await temporaries()).length, 1);
  assert.deepEqual(await listedNames(), ['datos-acc.bin']);
  // Committing before every byte arrived publishes nothing.
  assert.deepEqual(failure(await files(puente, `files/uploads/${partial.json.id}/commit`, {})), [400, 'remote_invalid_request']);
  assert.equal(await exists(path.join(folder, 'parcial-acc.bin')), false);
  // Cancelled: the temporary goes, the name never appears, the upload takes nothing more.
  assert.deepEqual((await files(puente, `operations/${partial.json.id}/cancel`)).json, { id: partial.json.id, state: 'cancelled' });
  assert.deepEqual(await temporaries(), []);
  assert.deepEqual(failure(await put(puente, `/v1/remote/files/uploads/${partial.json.id}/${CHUNK}`, payload.subarray(CHUNK, 2 * CHUNK))), [410, 'remote_ended']);
  assert.deepEqual(failure(await files(puente, `files/uploads/${partial.json.id}/commit`, {})), [410, 'remote_ended']);
  assert.deepEqual(await fs.readdir(folder), ['datos-acc.bin']);

  // A download is complete only once its last chunk was served: cancelled halfway, it says so.
  const halfway = await files(puente, 'files/downloads', { path: published });
  assert.equal((await fetch(`${puente.base}/v1/remote/files/downloads/${halfway.json.id}/0`, { headers: puente.headers(PHONE, 'files/1') })).status, 200);
  assert.deepEqual((await files(puente, `operations/${halfway.json.id}/cancel`)).json, { id: halfway.json.id, state: 'cancelled' });

  // The Puente stops mid-upload: the new one shows no file under that name and forgets the upload;
  // the app starts again from byte 0 and that one completes.
  const interrupted = await files(puente, 'files/uploads', { directory: folder, name: 'interrumpido-acc.bin', size: payload.length });
  assert.equal((await put(puente, `/v1/remote/files/uploads/${interrupted.json.id}/0`, payload.subarray(0, CHUNK))).status, 200);
  puente.close();
  puente = await lab.puente();
  assert.equal(await exists(path.join(folder, 'interrumpido-acc.bin')), false);
  assert.deepEqual(await listedNames(), ['datos-acc.bin'], 'neither the name nor the leftover temporary is listed');
  assert.deepEqual(failure(await put(puente, `/v1/remote/files/uploads/${interrupted.json.id}/${CHUNK}`, payload.subarray(CHUNK, 2 * CHUNK))), [404, 'remote_not_found']);
  const retried = await puente.upload(PHONE, folder, 'interrumpido-acc.bin', payload);
  assert.ok((await fs.readFile(retried)).equals(payload));
  assert.deepEqual(await listedNames(), ['datos-acc.bin', 'interrumpido-acc.bin']);

  // Search by name and by content over the event stream, without temporaries.
  await fs.writeFile(path.join(folder, 'apunte-acc.txt'), 'frase-buscada-acc dentro\n');
  const findAll = async (body: object) => {
    const started = await files(puente, 'files/search', body);
    assert.deepEqual([started.status, started.json.state], [200, 'running']);
    const stream = await puente.stream(PHONE, `/v1/remote/operations/${started.json.id}/events`, 'files/1');
    const events = stream.events as unknown as RemoteFileSearchEvent[];
    await until(() => events.some((event) => event.type === 'end'), 'the search ended', 30_000);
    stream.close();
    assert.deepEqual(events.at(-1), { ...events.at(-1), type: 'end', state: 'completed', truncated: false });
    return events.flatMap((event) => event.type === 'results' ? event.matches.map((match) => match.path) : []).sort();
  };
  assert.deepEqual(await findAll({ path: lab.dirs.home, query: 'INTERRUMPIDO-ACC', hidden: true }), [path.join(folder, 'interrumpido-acc.bin')]);
  assert.deepEqual(await findAll({ path: lab.dirs.home, query: 'frase-buscada-acc', content: true }), [path.join(folder, 'apunte-acc.txt')]);
  // A search that waits for acks (more matches than its window) is cancelled and says so.
  const many = path.join(lab.dirs.home, 'muchos-acc');
  await fs.mkdir(many);
  await Promise.all(Array.from({ length: 5001 }, (_, index) => fs.writeFile(path.join(many, `coincide-acc-${index}`), '')));
  const search = await files(puente, 'files/search', { path: many, query: 'coincide-acc' });
  const stream = await puente.stream(PHONE, `/v1/remote/operations/${search.json.id}/events`, 'files/1');
  const events = stream.events as unknown as RemoteFileSearchEvent[];
  await until(() => events.length > 3, 'first search frames', 30_000);
  assert.deepEqual((await files(puente, `operations/${search.json.id}/cancel`)).json, { id: search.json.id, state: 'cancelled' });
  assert.ok(!events.some((event) => event.type === 'end' && event.state === 'completed'));
  stream.close();

  // Uploads recorded as creations, without path, name or content.
  assert.deepEqual((await changeLines(lab)).map((record) => record.action), ['remote.file.create', 'remote.file.create']);
  await assertClean(lab, [PHONE.key, lab.dirs.root, 'transferencias-acc', 'datos-acc', 'parcial-acc', 'interrumpido', 'INTERRUMPIDO', 'apunte-acc', 'frase-buscada', 'muchos-acc', 'coincide-acc']);
});
