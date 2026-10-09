import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';

test('models requests authenticate and encode identifiers; selection and reset use the exact model', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const catalog = { models: [{ provider: 'custom:lab', model: 'org/model', label: 'Modelo local' }], defaultModel: { provider: 'local', model: 'default' } };
  const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'fixture-key', fetch: (async (url, init) => {
    assert.equal(this, undefined);
    calls.push({ url: String(url), init: init! });
    return Response.json(init?.method === 'GET' ? catalog : { id: 'c /?', model: JSON.parse(String(init?.body)).model });
  }) as typeof fetch });
  assert.deepEqual(await client.models('a /?'), catalog);
  const model = { provider: 'custom:lab', model: 'org/model' };
  assert.deepEqual((await client.setConversationModel('a /?', 'c /?', { model })).model, model);
  assert.equal((await client.setConversationModel('a /?', 'c /?', { model: null })).model, null);
  assert.deepEqual(calls.map((call) => [call.url, call.init.method, call.init.body]), [
    ['http://fixture.ts.net/v1/agents/a%20%2F%3F/models', 'GET', undefined],
    ['http://fixture.ts.net/v1/agents/a%20%2F%3F/conversations/c%20%2F%3F/model', 'PUT', JSON.stringify({ model })],
    ['http://fixture.ts.net/v1/agents/a%20%2F%3F/conversations/c%20%2F%3F/model', 'PUT', JSON.stringify({ model: null })],
  ]);
  for (const call of calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer fixture-key');
    assert.equal(headers[CHAT_PROTOCOL_HEADER], String(PROTOCOL_VERSION));
  }
});

test('model read and save preserve server errors instead of reporting a saved selection', async () => {
  const client = createBridgeClient({ baseUrl: 'http://fixture.ts.net', key: 'fixture', fetch: (async () => Response.json({ error: 'model_unavailable', message: 'Modelo no disponible' }, { status: 409 })) as typeof fetch });
  await assert.rejects(client.models('a'), (error) => error instanceof RelayError && error.status === 409);
  await assert.rejects(client.setConversationModel('a', 'c', { model: null }), (error) => error instanceof RelayError && error.status === 409);
});
