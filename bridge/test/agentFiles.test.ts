import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { FakeHermes } from '../support/fake_hermes.ts';
import { openArtifact } from '../src/agentFiles.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { HermesError } from '../src/hermes.ts';
import { AGENT_FILE_MAX_BYTES } from '../../protocol/protocol.ts';
import type { ConversationFiles } from '../../protocol/protocol.ts';

const KEY = `rly1_${Buffer.alloc(32, 42).toString('base64url')}`;
const headers = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2' };
async function setup(t: TestContext, now?: () => number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-files-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const directory = path.join(root, 'private'); const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(artifacts); const file = path.join(artifacts, 'report.md'); await fs.writeFile(file, 'Private artifact bytes');
  const store = await createDeviceStore({ directory });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000042', name: 'phone', pairedAt: Date.now(), revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  hermes.seedConversation('default', { id: 'conversation', sessionId: 'conversation', sessionIds: ['conversation'], source: 'cli', createdSource: 'cli', title: null, kind: 'interactive', hidden: false, archived: false, startedAt: 1700000000000, lastActiveAt: 1700000000000, messageCount: 2, preview: null });
  let announcements = [{ messageId: 'assistant-1', path: file }];
  hermes.media = {
    async announcements(profile, sessionId, messageId) { assert.equal(profile, 'default'); assert.equal(sessionId, 'conversation'); return announcements.filter((entry) => messageId === undefined || entry.messageId === messageId); },
    async validate(_profile, candidate) {
      let stat;
      try { stat = await fs.stat(candidate, { bigint: true }); } catch { throw new HermesError('file_not_found', 'Missing'); }
      return { path: path.resolve(candidate), name: path.basename(candidate), mimeType: 'text/markdown', size: Number(stat.size), identity: { dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) } };
    },
  };
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } });
  const logs: string[] = [];
  const server = createApp({ now, config: { corsOrigins: [] }, hermes, runs, store, pairing: createPairing({ store, origin: async () => 'http://fixture.example.ts.net:8650', serverName: 'fixture' }), tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = '/v1/agents/default/conversations/conversation/files';
  const call = (suffix = '', customHeaders = headers) => fetch(base + route + suffix, { headers: customHeaders });
  return { root, directory, artifacts, file, store, hermes, logs, route, call, base, setAnnouncements: (entries: typeof announcements) => { announcements = entries; } };
}

test('announced files expose metadata and opaque IDs, download exact bytes, and never accept client paths', async (t) => {
  const { call, file, logs } = await setup(t);
  const listed = await call(); assert.equal(listed.status, 200);
  const page = await listed.json() as ConversationFiles;
  assert.equal(page.files[0].name, 'report.md'); assert.equal(page.files[0].status, 'ready'); assert.equal(page.files[0].messageId, 'assistant-1');
  assert.doesNotMatch(JSON.stringify(page), new RegExp(file));
  assert.match(page.files[0].id, /^[a-f0-9-]{36}$/);
  const downloaded = await call(`/${page.files[0].id}`); assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), 'Private artifact bytes');
  assert.equal(downloaded.headers.get('content-type'), 'text/markdown');
  assert.equal((await call('?path=' + encodeURIComponent(file))).status, 400);
  assert.equal((await call('/' + encodeURIComponent(file))).status, 404);
  assert.doesNotMatch(logs.join('\n'), /Private artifact bytes|report.md|artifacts/);
});

test('download revalidates announcements, Conversation scope, protocol and revoked devices', async (t) => {
  const { call, setAnnouncements, store } = await setup(t);
  const id = ((await (await call()).json()) as ConversationFiles).files[0].id;
  assert.equal((await call('/unannounced')).status, 404);
  assert.equal((await call('', { Authorization: headers.Authorization } as typeof headers)).status, 426);
  setAnnouncements([]); assert.equal((await call(`/${id}`)).status, 404);
  await store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
  assert.equal((await call(`/${id}`)).status, 403);
});

test('traversal, symlink ancestors and hardlinks, private Puente files and over-limit files are blocked', async (t) => {
  const fixture = await setup(t);
  const link = path.join(fixture.artifacts, 'link.md'); await fs.symlink(fixture.file, link);
  const hard = path.join(fixture.artifacts, 'hard.md'); const hardTarget = path.join(fixture.artifacts, 'hard-target.md'); await fs.copyFile(fixture.file, hardTarget); await fs.link(hardTarget, hard);
  const linkedDirectory = path.join(fixture.root, 'linked'); await fs.symlink(fixture.artifacts, linkedDirectory);
  const huge = path.join(fixture.artifacts, 'huge.zip'); const handle = await fs.open(huge, 'w'); await handle.truncate(AGENT_FILE_MAX_BYTES + 1); await handle.close();
  const paths = [hard, link, path.join(linkedDirectory, 'report.md'), `${fixture.artifacts}/../artifacts/report.md`, path.join(fixture.directory, 'devices.json'), huge];
  for (const candidate of paths) {
    fixture.setAnnouncements([{ messageId: 'assistant-1', path: candidate }]);
    const response = await fixture.call(); assert.equal(response.status, 200);
    const record = ((await response.json()) as ConversationFiles).files[0];
    assert.equal(record.status, candidate === huge ? 'too_large' : 'blocked', candidate);
    const download = await fixture.call(`/${record.id}`); assert.equal(download.status, candidate === huge ? 413 : 403, candidate);
  }
});

test('missing files stay visible and a changed destination after validation is never served', async (t) => {
  const fixture = await setup(t);
  const id = ((await (await fixture.call()).json()) as ConversationFiles).files[0].id;
  const validate = fixture.hermes.media.validate;
  fixture.hermes.media.validate = async (profile, candidate) => { const result = await validate(profile, candidate); await fs.rename(candidate, candidate + '.previous'); await fs.writeFile(candidate, Buffer.alloc(result.size, 88)); return result; };
  const swapped = await fixture.call(`/${id}`); assert.equal(swapped.status, 403); assert.doesNotMatch(await swapped.text(), /Wrong swapped bytes/);
  fixture.hermes.media.validate = validate; await fs.unlink(fixture.file);
  const page = await (await fixture.call()).json() as ConversationFiles; assert.equal(page.files[0].status, 'missing');
});

 test('opaque tickets cannot cross existing Conversations or be delivered after revocation during policy validation', async (t) => {
  const fixture = await setup(t);
  const id = ((await (await fixture.call()).json()) as ConversationFiles).files[0].id;
  fixture.hermes.seedConversation('default', { id: 'other', sessionId: 'other', sessionIds: ['other'], source: 'cli', createdSource: 'cli', title: null, kind: 'interactive', hidden: false, archived: false, startedAt: 1700000000000, lastActiveAt: 1700000000000, messageCount: 0, preview: null });
  assert.equal((await fetch(fixture.base + '/v1/agents/default/conversations/other/files/' + id, { headers })).status, 404);
  const validate = fixture.hermes.media.validate;
  fixture.hermes.media.validate = async (profile, candidate) => {
    const result = await validate(profile, candidate);
    await fixture.store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
    return result;
  };
  const response = await fixture.call('/' + id); assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /Private artifact bytes/);
});

test('descriptor traversal refuses symlinks in both the file and its parents before policy checks', async (t) => {
  const fixture = await setup(t);
  const link = path.join(fixture.artifacts, 'symlink'); await fs.symlink(fixture.file, link);
  const parent = path.join(fixture.root, 'parent-link'); await fs.symlink(fixture.artifacts, parent);
  for (const candidate of [link, path.join(parent, 'report.md')]) {
    await assert.rejects(openArtifact(candidate, fixture.directory), (failure: unknown) => failure instanceof HermesError && failure.code === 'file_blocked');
  }
});

test('expired file tickets refresh the catalog without claiming a present artifact is missing', async (t) => {
  let now = 0; const fixture = await setup(t, () => now);
  const before = ((await (await fixture.call()).json()) as ConversationFiles).files[0];
  now = 600_000;
  const expired = await fixture.call('/' + before.id);
  assert.equal(expired.status, 404); const failure = await expired.json();
  assert.equal(failure.error.code, 'file_ticket_expired');
  assert.doesNotMatch(failure.error.message, /ya no está|no existe/);
  assert.equal((await fs.stat(fixture.file)).isFile(), true);
  const after = ((await (await fixture.call()).json()) as ConversationFiles).files[0];
  assert.notEqual(after.id, before.id); assert.equal(after.status, 'ready');
  const downloaded = await fixture.call('/' + after.id); assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'Private artifact bytes');
});
