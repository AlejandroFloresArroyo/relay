import { act } from '@testing-library/react-native';
import { binary, controlledFetch, requests, respond, streamCount, streamFixture } from '../support/transport';

test('transport fixtures record protocol and cursor headers and supply binary bytes', async () => {
  const bytes = new Uint8Array([0, 255, 1]);
  respond('http://fixture.ts.net', '/file', binary(bytes, 'application/octet-stream'));
  const response = await controlledFetch('http://fixture.ts.net/file', { headers: { 'X-Relay-Protocol': '2', 'Last-Event-ID': '0' } });
  expect(requests[0].headers.get('X-Relay-Protocol')).toBe('2');
  expect(requests[0].headers.get('Last-Event-ID')).toBe('0');
  expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});

test('SSE fixtures explicitly close or fail pending reads and retire streams', async () => {
  for (const mode of ['close', 'fail']) {
    const stream = streamFixture();
    respond('http://fixture.ts.net', '/events', stream.reply);
    await controlledFetch('http://fixture.ts.net/events');
    const read = stream.reader.read();
    if (mode === 'close') {
      await act(async () => { stream.close(); });
      await expect(read).resolves.toEqual({ done: true, value: undefined });
    } else {
      const result = expect(read).rejects.toThrow('Fixture SSE failure');
      await act(async () => { stream.fail(new Error('Fixture SSE failure')); });
      await result;
    }
    expect(streamCount()).toBe(0);
  }
});


test('graceful SSE close drains every queued frame before EOF', async () => {
  const stream = streamFixture();
  respond('http://fixture.ts.net', '/events', stream.reply);
  await controlledFetch('http://fixture.ts.net/events');
  const frames = ['data: {"type":"message.delta","delta":"Fixture"}\n\n', 'data: {"type":"run.completed","output":"Fixture"}\n\n'];
  for (const frame of frames) stream.emit(frame);
  stream.close();
  for (const frame of frames) await expect(stream.reader.read()).resolves.toEqual({ done: false, value: new TextEncoder().encode(frame) });
  await expect(stream.reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(streamCount()).toBe(0);
});

test.each(['fail', 'abort'])('SSE %s rejects immediately even with a queued frame', async (mode) => {
  const stream = streamFixture();
  const controller = new AbortController();
  respond('http://fixture.ts.net', '/events', stream.reply);
  await controlledFetch('http://fixture.ts.net/events', { signal: controller.signal });
  stream.emit('data: {"type":"run.completed"}\n\n');
  if (mode === 'fail') stream.fail();
  else controller.abort();
  await expect(stream.reader.read()).rejects.toThrow(mode === 'fail' ? 'Fixture SSE failure' : 'Fixture stream aborted');
  expect(streamCount()).toBe(0);
});


test.each(['close', 'fail', 'abort'])('SSE emit throws after %s without changing the terminal read', async (mode) => {
  const stream = streamFixture();
  const controller = new AbortController();
  respond('http://fixture.ts.net', '/events', stream.reply);
  await controlledFetch('http://fixture.ts.net/events', { signal: controller.signal });
  if (mode === 'close') stream.close();
  else if (mode === 'fail') stream.fail();
  else controller.abort();
  expect(() => stream.emit('late')).toThrow('Fixture stream is stopped');
  if (mode === 'close') await expect(stream.reader.read()).resolves.toEqual({ done: true, value: undefined });
  else await expect(stream.reader.read()).rejects.toThrow(mode === 'fail' ? 'Fixture SSE failure' : 'Fixture stream aborted');
  expect(streamCount()).toBe(0);
});

test('SSE emit throws after observed EOF while preserving the pre-close frame', async () => {
  const stream = streamFixture();
  respond('http://fixture.ts.net', '/events', stream.reply);
  await controlledFetch('http://fixture.ts.net/events');
  const frame = 'data: {"type":"run.completed","output":"Fixture"}\n\n';
  stream.emit(frame);
  stream.close();
  await expect(stream.reader.read()).resolves.toEqual({ done: false, value: new TextEncoder().encode(frame) });
  await expect(stream.reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(() => stream.emit('late')).toThrow('Fixture stream is stopped');
  await expect(stream.reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(streamCount()).toBe(0);
});
