import assert from 'node:assert/strict';
import test from 'node:test';
import { TERMINAL_INPUT_BYTES } from '../../../protocol/remoteTerminal.ts';
import { RemoteFailure } from './remoteClient.ts';
import { createTerminalSession, type TerminalPort } from './terminalSession.ts';

const CHANNEL_A = 'A'.repeat(22);
const CHANNEL_B = 'B'.repeat(22);
const b64 = (text: string) => Buffer.from(text).toString('base64');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A port whose streams, answers and waits the test drives by hand. */
function fakePort() {
  const calls: unknown[][] = [];
  const streams: { lastEventId: number; send: (event: unknown) => void; end: (error?: unknown) => void; signal: AbortSignal }[] = [];
  const answers: { call: unknown[]; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const waits: { ms: number; resolve: () => void }[] = [];
  const answer = (...call: unknown[]) => {
    calls.push(call);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    answers.push({ call, resolve, reject });
    return promise;
  };
  const port: TerminalPort = {
    stream(lastEventId, onData, signal) {
      calls.push(['stream', lastEventId]);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => resolve(), { once: true });
      // Like remoteStream: an event the session refuses ends the stream with that error.
      const send = (event: unknown) => { try { onData(JSON.stringify(event)); } catch (error) { reject(error); } };
      streams.push({ lastEventId, signal, send, end: (error) => (error ? reject(error) : resolve()) });
      return promise;
    },
    ack: (channel, seq) => answer('ack', channel, seq),
    input: (seq, data) => answer('input', seq, data),
    resize: (cols, rows, redraw) => answer('resize', cols, rows, redraw),
  };
  const wait = (ms: number, signal: AbortSignal) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    waits.push({ ms, resolve });
    signal.addEventListener('abort', () => resolve(), { once: true });
    return promise;
  };
  /** Answers the oldest unanswered call of `kind`. */
  const reply = async (kind: string, value: unknown = { ok: true }) => {
    const index = answers.findIndex((a) => a.call[0] === kind);
    assert.ok(index >= 0, `no ${kind} waiting`);
    const [{ resolve }] = answers.splice(index, 1);
    resolve(value);
    await flush();
  };
  const fail = async (kind: string, error: unknown) => {
    const index = answers.findIndex((a) => a.call[0] === kind);
    assert.ok(index >= 0, `no ${kind} waiting`);
    const [{ reject }] = answers.splice(index, 1);
    reject(error);
    await flush();
  };
  return { port, calls, streams, wait, waits, reply, fail, of: (kind: string) => calls.filter((c) => c[0] === kind) };
}

test('output resumes from the last frame held and is acknowledged only once the view wrote it', async () => {
  const p = fakePort();
  const session = createTerminalSession(p.port, { wait: p.wait });
  assert.equal(p.streams[0]!.lastEventId, 0);
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 0 });
  assert.deepEqual(session.link(), { state: 'connected' });
  p.streams[0]!.send({ type: 'output', seq: 1, data: b64('uno ') });
  p.streams[0]!.send({ type: 'output', seq: 2, data: b64('dos ') });
  assert.deepEqual(await session.pull(), [b64('uno '), b64('dos ')]);
  await flush();
  assert.deepEqual(p.of('ack'), [], 'handed to the view is not written yet');

  p.streams[0]!.send({ type: 'output', seq: 3, data: b64('tres') });
  assert.deepEqual(await session.pull(), [b64('tres')]);
  assert.deepEqual(p.of('ack'), [['ack', CHANNEL_A, 2]]);

  // The connection drops: the program is left alone and the stream reopens after the last frame received.
  p.streams[0]!.end(new RemoteFailure('no_response'));
  await flush();
  assert.deepEqual(session.link(), { state: 'reconnecting', message: 'Sin respuesta' });
  assert.equal(p.waits.length, 1);
  p.waits[0]!.resolve();
  await flush();
  assert.equal(p.streams[1]!.lastEventId, 3);
  p.streams[1]!.send({ type: 'open', channel: CHANNEL_B, inputSeq: 0 });
  // A replayed frame is never written twice.
  p.streams[1]!.send({ type: 'output', seq: 3, data: b64('tres') });
  p.streams[1]!.send({ type: 'output', seq: 4, data: b64('cuatro') });
  const next = session.pull();
  assert.deepEqual(await next, [b64('cuatro')]);
  await p.reply('ack');
  // Frame 3 was written on the old channel: the new one already starts after it, so nothing is acked
  // until the view writes frame 4.
  void session.pull();
  await flush();
  assert.deepEqual(p.of('ack').slice(1), [['ack', CHANNEL_B, 4]]);
  session.close();
});

test('a gap asks the program to repaint at the current size; a new channel resyncs the size', async () => {
  const p = fakePort();
  const session = createTerminalSession(p.port, { wait: p.wait });
  session.resize(80, 24);
  assert.deepEqual(p.of('resize'), [], 'no size before a channel');
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 0 });
  assert.deepEqual(p.of('resize'), [['resize', 80, 24, false]]);
  await p.reply('resize');
  session.resize(80, 24);
  assert.equal(p.of('resize').length, 1, 'the same size is not sent again');
  p.streams[0]!.send({ type: 'gap', from: 1, to: 40 });
  assert.deepEqual(p.of('resize')[1], ['resize', 80, 24, true]);
  await p.reply('resize');
  p.streams[0]!.send({ type: 'output', seq: 41, data: b64('x') });
  p.streams[0]!.end();
  await flush();
  p.waits[0]!.resolve();
  await flush();
  assert.equal(p.streams[1]!.lastEventId, 41);
  p.streams[1]!.send({ type: 'open', channel: CHANNEL_B, inputSeq: 0 });
  assert.deepEqual(p.of('resize')[2], ['resize', 80, 24, false]);
  session.close();
});

test('input goes one frame at a time in order, a paste is split but never cut, and a lost answer is resolved by the next open', async () => {
  const p = fakePort();
  const session = createTerminalSession(p.port, { wait: p.wait });
  session.write('antes');
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 7 });
  assert.deepEqual(p.of('input'), [], 'typed before the connection: dropped, never sent later');

  session.write('ls');
  session.write(' -l\r');
  assert.deepEqual(p.of('input'), [['input', 8, b64('ls')]]);
  await p.reply('input', { inputSeq: 8 });
  assert.deepEqual(p.of('input')[1], ['input', 9, b64(' -l\r')]);
  await p.reply('input', { inputSeq: 9 });

  // 65 537 bytes: three frames, and the first boundary falls inside an «ñ».
  const paste = 'z' + 'ñ'.repeat(TERMINAL_INPUT_BYTES);
  session.write(paste);
  await p.reply('input', { inputSeq: 10 });
  // The answer to frame 11 is lost: the stream reopens and the frame is sent again with the same seq.
  await p.fail('input', new RemoteFailure('no_response'));
  await flush();
  assert.ok(p.streams[0]!.signal.aborted);
  p.streams[1]!.send({ type: 'open', channel: CHANNEL_B, inputSeq: 10 });
  const sent = p.of('input');
  assert.equal(sent.at(-1)![1], 11);
  assert.equal(sent.at(-1)![2], sent.at(-2)![2]);
  // This time it had been applied before the answer was lost: the next open says so and it is dropped.
  await p.fail('input', new RemoteFailure('no_response'));
  await flush();
  p.streams[2]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 11 });
  assert.equal(p.of('input').at(-1)![1], 12);
  await p.reply('input', { inputSeq: 12 });
  const frames = p.of('input').filter((c, i, all) => all.findLastIndex((d) => d[1] === c[1]) === i).slice(2);
  assert.deepEqual(frames.map((c) => c[1]), [10, 11, 12]);
  assert.equal(Buffer.concat(frames.map((c) => Buffer.from(c[2] as string, 'base64'))).toString(), paste);
  for (const frame of frames) assert.ok(Buffer.from(frame[2] as string, 'base64').length <= TERMINAL_INPUT_BYTES);
  session.close();
});

test('a program that ended, a lost terminal and a replaced stream are final until asked; nothing reconnects', async () => {
  const p = fakePort();
  const exited = createTerminalSession(p.port, { wait: p.wait });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 0 });
  p.streams[0]!.send({ type: 'output', seq: 1, data: b64('bye') });
  p.streams[0]!.send({ type: 'closed', reason: 'exited' });
  p.streams[0]!.end();
  await flush();
  assert.deepEqual(exited.link(), { state: 'exited' });
  assert.deepEqual(await exited.pull(), [b64('bye')], 'the last output still reaches the view');
  assert.equal(p.streams.length, 1);

  const q = fakePort();
  const lost = createTerminalSession(q.port, { wait: q.wait });
  q.streams[0]!.end(new RemoteFailure('remote', { code: 'remote_ended' }));
  await flush();
  assert.deepEqual(lost.link(), { state: 'ended', message: 'Ya terminó.' });
  assert.equal(q.streams.length, 1);

  const r = fakePort();
  const replaced = createTerminalSession(r.port, { wait: r.wait });
  r.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 0 });
  r.streams[0]!.send({ type: 'output', seq: 1, data: b64('a') });
  r.streams[0]!.send({ type: 'closed', reason: 'replaced' });
  r.streams[0]!.end();
  await flush();
  assert.deepEqual(replaced.link(), { state: 'replaced' });
  assert.equal(r.streams.length, 1);
  replaced.reconnect();
  await flush();
  assert.equal(r.streams[1]!.lastEventId, 1);
  replaced.close();
});

test('closing disconnects and sends nothing more; a malformed event stops instead of guessing', async () => {
  const p = fakePort();
  const session = createTerminalSession(p.port, { wait: p.wait });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A, inputSeq: 0 });
  p.streams[0]!.send({ type: 'output', seq: 1, data: b64('a') });
  const before = p.calls.length;
  const pulled = await session.pull();
  assert.equal(pulled.length, 1);
  const idle = session.pull();
  session.close();
  assert.deepEqual(await idle, []);
  assert.ok(p.streams[0]!.signal.aborted);
  session.write('x');
  session.resize(100, 30);
  await flush();
  assert.deepEqual(p.calls.slice(before).filter((c) => c[0] !== 'ack'), []);
  assert.equal(p.streams.length, 1);
  assert.deepEqual(session.link(), { state: 'closed' });

  const q = fakePort();
  const bad = createTerminalSession(q.port, { wait: q.wait });
  q.streams[0]!.send({ type: 'open', channel: '../x', inputSeq: 0 });
  await flush();
  assert.equal(bad.link().state, 'failed');
  assert.equal(q.streams.length, 1);
});
