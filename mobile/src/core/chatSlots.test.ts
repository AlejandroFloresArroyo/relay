import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSubmit, inactiveDictation, inactiveImages } from '../screens/chat/chatSlots.ts';

const ready = { draft: 'Mensaje', hasAttachment: false, listening: false, running: false, chatOff: false };
test('canSubmit requires text or an attachment', () => {
  assert.equal(canSubmit(ready), true);
  assert.equal(canSubmit({ ...ready, draft: '' }), false);
  assert.equal(canSubmit({ ...ready, draft: '  \n ' }), false);
  assert.equal(canSubmit({ ...ready, draft: '', hasAttachment: true }), true);
});
test('canSubmit blocks listening even with text or an attachment', () => {
  assert.equal(canSubmit({ ...ready, listening: true }), false);
  assert.equal(canSubmit({ ...ready, draft: '', hasAttachment: true, listening: true }), false);
});
test('canSubmit blocks running and unavailable chat', () => {
  assert.equal(canSubmit({ ...ready, running: true }), false);
  assert.equal(canSubmit({ ...ready, chatOff: true }), false);
});
test('inactive slots preserve request identity and permit only nonempty text', () => {
  const request = { input: 'Mensaje', sessionId: 'fixture-conversation' };
  assert.equal(inactiveImages.prepareSend(request), request);
  assert.equal(inactiveImages.hasAttachment, false);
  assert.equal(inactiveDictation.listening, false);
  assert.equal(canSubmit({ ...ready, hasAttachment: inactiveImages.hasAttachment, listening: inactiveDictation.listening }), true);
});
