import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteFileEntry, RemoteFileType } from '../../../protocol/remoteFiles.ts';
import { addFile, attachable, chatFilesOffered, overConversation } from './chatFiles.ts';

test('a release counts over the Conversación only inside the column to the left of the panel', () => {
  const at = (dx: number) => overConversation({ inset: 10, grabX: 20, dx, column: 400 });
  assert.equal(at(-31), true, 'just left of the panel');
  assert.equal(at(-30), false, 'x = 0 is the panel edge');
  assert.equal(at(-430), true, 'x = -column still counts');
  assert.equal(at(-431), false, 'past the column');
  assert.equal(at(5), false, 'over the panel');
  assert.equal(overConversation({ inset: 10, grabX: 20, dx: -50, column: 0 }), false, 'no layout yet');
  assert.equal(overConversation({ inset: 10, grabX: Number.NaN, dx: -50, column: 400 }), false);
});

test('only UTF-8 regular files, or links to one, can be attached', () => {
  type Row = Pick<RemoteFileEntry, 'name' | 'nameUtf8' | 'type' | 'link'>;
  const entry = (type: RemoteFileType, extra: Partial<Row> = {}): Row => ({ name: 'a', nameUtf8: true, type, ...extra });
  for (const type of ['directory', 'fifo', 'socket', 'char_device', 'block_device', 'unknown'] as const) assert.equal(attachable(entry(type)), false, type);
  assert.equal(attachable(entry('file')), true);
  assert.equal(attachable(entry('file', { nameUtf8: false })), false);
  assert.equal(attachable(entry('symlink', { link: { target: 'b', realPath: '/b', type: 'file' } })), true);
  assert.equal(attachable(entry('symlink', { link: { target: 'b', realPath: '/b', type: 'directory' } })), false);
  assert.equal(attachable(entry('symlink', { link: { target: 'b', realPath: null, type: null } })), false);
});

test('a file is added once, up to five', () => {
  assert.deepEqual(addFile([], '/a'), ['/a']);
  assert.deepEqual(addFile(['/a'], '/a'), ['/a']);
  const five = ['/1', '/2', '/3', '/4', '/5'];
  assert.equal(addFile(five, '/6'), null, 'full');
});

test('chat_files is offered only by a Puente that advertises a compatible version', () => {
  assert.equal(chatFilesOffered({ capabilities: { chat_files: { version: 1, minAppVersion: 1 } } }), true);
  assert.equal(chatFilesOffered({ capabilities: {} }), false, 'an old Puente');
  assert.equal(chatFilesOffered({ capabilities: { chat_files: { version: 2, minAppVersion: 2 } } }), false, 'needs a newer app');
  assert.equal(chatFilesOffered(null), false);
});
