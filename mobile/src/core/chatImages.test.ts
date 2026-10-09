import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareChatImage, imageRunRequest } from './chatImages.ts';

test('a large photo is reduced with its aspect ratio, copied locally, and included in the exact Conversation request', async () => {
  const attempts: unknown[] = []; const copied: string[] = [];
  const prepared = await prepareChatImage({ uri: 'file:///camera/photo.jpg', width: 4000, height: 3000 }, 'attachment-fixture', {
    async transform(_uri, size, quality) {
      attempts.push({ size, quality });
      return { uri: 'file:///cache/reduced.jpg', width: size.width, height: size.height, base64: attempts.length === 1 ? '/9j/' + 'AAAA'.repeat(700000) : '/9j/' };
    },
    async copy(uri) { copied.push(uri); return 'file:///documents/relay-images/attachment-fixture.jpg'; },
  });
  assert.deepEqual(attempts, [{ size: { width: 1600, height: 1200 }, quality: 0.82 }, { size: { width: 1280, height: 960 }, quality: 0.65 }]);
  assert.deepEqual(copied, ['file:///cache/reduced.jpg']);
  assert.equal(prepared.uri, 'file:///documents/relay-images/attachment-fixture.jpg');
  assert.deepEqual(imageRunRequest({ input: 'Describe', sessionId: 'conversation-1' }, prepared, 'message-fixture'), {
    input: 'Describe', sessionId: 'conversation-1', clientMessageId: 'message-fixture', images: [{ attachmentId: 'attachment-fixture', mimeType: 'image/jpeg', dataBase64: '/9j/', width: 1280, height: 960 }],
  });
});

test('a photo still over the budget after every reduction is refused without copying or exposing its content', async () => {
  let copied = false;
  await assert.rejects(prepareChatImage({ uri: 'file:///photo.jpg', width: 5000, height: 3000 }, 'image-fixture', {
    async transform(_uri, size) { return { uri: 'file:///reduced.jpg', ...size, base64: '/9j/' + 'AAAA'.repeat(700000) }; },
    async copy() { copied = true; return 'file:///documents/copied.jpg'; },
  }), (error: unknown) => error instanceof Error && error.message === 'La imagen sigue siendo demasiado grande. Elige otra imagen más pequeña.' && !error.message.includes('/9j/'));
  assert.equal(copied, false);
});
