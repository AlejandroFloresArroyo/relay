import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';
import { AGENT_FILE_MAX_BYTES } from '../../../protocol/protocol.ts';

test('file listing and binary download keep authorization in headers, reject redirects and stream chunks to the private sink', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/files?limit=50&offset=0')) return Response.json({ files: [], nextOffset: null });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' } });
  };
  const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'private-fixture', fetch: fakeFetch as typeof fetch });
  assert.deepEqual(await client.conversationFiles('agent', 'conversation'), { files: [], nextOffset: null });
  const chunks: number[][] = [];
  assert.deepEqual(await client.downloadConversationFile('agent', 'conversation', 'opaque-id', async (chunk) => { chunks.push([...chunk]); }), { bytes: 3, mimeType: 'application/octet-stream' });
  assert.deepEqual(chunks, [[1, 2], [3]]);
  for (const call of calls) {
    assert.doesNotMatch(call.url, /private-fixture|Bearer/); assert.equal(call.init?.redirect, 'error');
    const headers = new Headers(call.init?.headers); assert.equal(headers.get('Authorization'), 'Bearer private-fixture'); assert.equal(headers.get('X-Relay-Protocol'), '2');
  }
});

test('oversized metadata and streaming overflow stop before writing over 50 MB', async () => {
  let writes = 0;
  for (const declared of [true, false]) {
    const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'fixture', fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(AGENT_FILE_MAX_BYTES)); controller.enqueue(new Uint8Array([1])); controller.close(); } }), { headers: declared ? { 'Content-Length': String(AGENT_FILE_MAX_BYTES + 1) } : {} })) as typeof fetch });
    await assert.rejects(client.downloadConversationFile('a', 'c', 'f', async () => { writes++; }), (error: unknown) => error instanceof RelayError && error.code === 'file_too_large');
    assert.equal(writes, declared ? 0 : 1);
  }
});

test('revoked and unpaired downloads never write bytes or carry credentials to another origin', async () => {
  let writes = 0, fetches = 0;
  const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'fixture', fetch: (async () => { fetches++; return Response.json({ error: { code: 'device_revoked', message: 'Revoked' } }, { status: 403 }); }) as typeof fetch });
  await assert.rejects(client.downloadConversationFile('a', 'c', 'f', async () => { writes++; }), (error: unknown) => error instanceof RelayError && error.code === 'device_revoked');
  const unpaired = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: '', pairingRequired: true, fetch: (async () => { fetches++; throw new Error('Must not fetch'); }) as typeof fetch });
  await assert.rejects(unpaired.downloadConversationFile('a', 'c', 'f', async () => { writes++; }), (error: unknown) => error instanceof RelayError && error.code === 'pairing_required');
  assert.equal(writes, 0); assert.equal(fetches, 1);
});
