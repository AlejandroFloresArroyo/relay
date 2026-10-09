import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRunEvent } from '../../../protocol/protocol.ts';
import { createBridgeClient } from './bridgeClient.ts';

const origin = 'http://turn-fixture.ts.net:17651';
test('runEvents resumes at the supplied cursor and drops replayed or repeated sequence ids across chunks', async () => {
  const events: ChatRunEvent[] = [];
  let headers = new Headers();
  const frames = [
    'id: 7\ndata: {"type":"message.delta","text":"old"}\n\n',
    'id: 8\ndata: {"type":"message.delta","text":"nuevo"}\n',
    '\nid: 8\ndata: {"type":"message.delta","text":"duplicado"}\n\n',
    'id: 6\ndata: {"type":"run.steered","requestId":"old","accepted":true}\n\n',
    'id: 9\ndata: {"type":"run.completed","output":"nuevo","pendingSteer":"sin entregar"}\n\n',
  ];
  const client = createBridgeClient({ baseUrl: origin, key: 'fixture-key', fetch: (async (_url, options) => {
    headers = new Headers(options?.headers);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close();
    } }));
  }) as typeof fetch });
  await client.runEvents('r1', (event) => events.push(event), undefined, 7);
  assert.equal(headers.get('Last-Event-ID'), '7');
  assert.equal(headers.get('X-Relay-Protocol'), '2');
  assert.deepEqual(events, [{ type: 'message.delta', text: 'nuevo' }, { type: 'run.completed', output: 'nuevo', pendingSteer: 'sin entregar' }]);
});

test('a new subscription or empty snapshot delivers event zero once instead of losing the first response', async () => {
  for (const cursor of [undefined, -1]) {
    const events: ChatRunEvent[] = [];
    const client = createBridgeClient({ baseUrl: origin, key: 'fixture-key', fetch: (async (_url, options) => {
      if (new Headers(options?.headers).get('Last-Event-ID') === '-1') {
        return new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'Invalid cursor' } }), { status: 400 });
      }
      return new Response('id: 0\ndata: {"type":"message.delta","text":"Primer texto"}\n\nid: 0\ndata: {"type":"message.delta","text":"Duplicado"}\n\nid: 1\ndata: {"type":"run.completed","output":"Primer texto"}\n\n');
    }) as typeof fetch });
    await client.runEvents('r1', (event) => events.push(event), undefined, cursor);
    assert.deepEqual(events, [
      { type: 'message.delta', text: 'Primer texto' },
      { type: 'run.completed', output: 'Primer texto' },
    ]);
  }
});
