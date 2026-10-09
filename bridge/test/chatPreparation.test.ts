// Frozen shared preparation contract; feature-specific defaults live in unavailable{issue}.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HermesError, unavailableChatPort } from '../src/hermes.ts';

test('shared unavailable port rejects with the typed adapter error', async () => {
  await assert.rejects(unavailableChatPort(), (e: unknown) => e instanceof HermesError && e.code === 'unavailable');
});
