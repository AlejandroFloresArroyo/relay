// Frozen shared preparation contract; feature-specific defaults live in unavailable{issue}.test.ts.
import { CHAT_ERROR_STATUS, type RunEvent } from '../../../protocol/protocol.ts';
import { applyRunEvent, type ChatItem } from './transcript.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';

test('responseError preserves every G1 chat code, its status and safe message', async () => {
  for (const [code, status] of Object.entries(CHAT_ERROR_STATUS)) {
    const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'fixture', fetch: (async () => new Response(JSON.stringify({ error: { code, message: 'Fixture message' } }), { status })) as typeof fetch });
    await assert.rejects(client.agents(), (e: unknown) => e instanceof RelayError && e.code === code && e.status === status && e.message === 'Fixture message', code);
  }
});

test('unknown run events preserve transcript items and approval evidence', () => {
  const items: ChatItem[] = [{ kind: 'assistant', id: 'a1', text: 'Respuesta', at: 1 }, { kind: 'tool', id: 't1', tool: 'terminal', preview: 'Fixture', status: 'waiting', durationSeconds: null, result: null, at: 1, approval: { id: 'approval', runId: 'r1' } }];
  for (const type of ['future.event', 'run.steered', 'run.connection']) {
    assert.equal(applyRunEvent(items, { type } as RunEvent, 2, 'r1'), items, type);
  }
});
