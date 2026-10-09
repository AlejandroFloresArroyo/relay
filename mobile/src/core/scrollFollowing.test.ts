import assert from 'node:assert/strict';
import test from 'node:test';
import { followChatScroll, initialScrollFollowing } from './scrollFollowing.ts';

const position = (offset: number) => ({ type: 'position' as const, offset, viewport: 600, content: 2200 });
test('sending follows the newest message until the next user drag and the final position can restore following', () => {
  let state = followChatScroll(initialScrollFollowing, { type: 'drag' });
  state = followChatScroll(state, position(400));
  assert.equal(state.following, false);
  state = followChatScroll(state, { type: 'follow' });
  state = followChatScroll(state, position(450));
  assert.equal(state.following, true);
  state = followChatScroll(state, { type: 'drag' });
  state = followChatScroll(state, position(1490));
  assert.equal(state.following, false);
  state = followChatScroll(state, position(1600));
  assert.equal(state.following, true);
});
