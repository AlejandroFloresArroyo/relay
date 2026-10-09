import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import { createDemoServerFiles } from './demoServerFiles.ts';
import { filesApi } from './remoteFiles.ts';
import { RemoteFailure } from './remoteClient.ts';
import { openText } from './textDocument.ts';

test('the demo Servidor answers through the real files core: every state of the tool is reachable', async () => {
  const api = filesApi(createDemoServerFiles());
  const home = await api.list(null, false);
  assert.equal(home.path, '/home/user');
  assert.ok(!home.entries.some((entry) => entry.name.startsWith('.')));
  assert.deepEqual(['enlace-proyectos', 'enlace-roto', 'cola-trabajos'].map((name) => home.entries.find((entry) => entry.name === name)?.type), ['symlink', 'symlink', 'fifo']);
  assert.equal((await api.list('/home/user/.hermes', true)).protection, 'profile');
  assert.equal((await api.list('/home/user/enlace-proyectos', false)).realPath, '/home/user/proyectos');

  const limit = await api.read('/home/user/limite-5mib.log');
  assert.equal(limit.bytes.length, REMOTE_LIMITS.editableTextBytes);
  assert.equal(openText(limit.bytes).kind, 'opened');

  const plan = await api.read('/home/user/conflicto.md');
  const bytes = new TextEncoder().encode('# Plan\nMi cambio.\n');
  await assert.rejects(api.save(plan.path, plan.version, bytes, { encoding: 'utf-8', bom: false }), (error) => error instanceof RemoteFailure && error.code === 'remote_conflict');
  const again = await api.read(plan.path);
  assert.ok(await api.save(plan.path, again.version, bytes, { encoding: 'utf-8', bom: false }));
});
