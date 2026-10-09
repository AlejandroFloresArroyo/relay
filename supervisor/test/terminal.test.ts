// The output ring, the window and the input order of one terminal (ADR 0006 «Salida de terminal y
// control de flujo»). The PTY is a double: what it would deliver and whether reading is paused.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChannelEvent } from '../../protocol/supervisor.ts';
import { SupervisorFailure } from '../src/supervisor.ts';
import { TerminalStream, type StreamLimits } from '../src/terminal.ts';
import { FakePty } from '../support/fakeHost.ts';

const LIMITS = { frameBytes: 8, windowBytes: 16, ringBytes: 32, stalledMs: 40 };

function setup(t: TestContext, limits: Partial<StreamLimits> = LIMITS) {
  const pty = new FakePty();
  const events: ChannelEvent[] = [];
  const stream = new TerminalStream(pty, (event) => events.push(event), limits);
  t.after(() => stream.close());
  const frames = (channel = 'chan') => events.filter((event) => event.channel === channel && event.type === 'output') as Extract<ChannelEvent, { type: 'output' }>[];
  const bytes = (channel = 'chan') => Buffer.concat(frames(channel).map((frame) => Buffer.from(frame.data, 'base64')));
  const last = (channel = 'chan') => frames(channel).at(-1)?.seq ?? 0;
  return { pty, stream, events, frames, bytes, last };
}

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { if (error instanceof SupervisorFailure) return error.code; throw error; }
  return 'ok';
};

test('raw bytes pass untouched in numbered frames: a UTF-8 character split by the PTY stays whole', (t) => {
  const { pty, stream, events, frames, bytes } = setup(t);
  stream.attach('chan', 0);
  const text = Buffer.from('añ😀b', 'utf8');
  pty.output(text.subarray(0, 2));
  pty.output(text.subarray(2, 4));
  pty.output(text.subarray(4));
  assert.deepEqual(events[0], { channel: 'chan', type: 'opened', inputSeq: 0 });
  assert.deepEqual(frames().map((frame) => frame.seq), [1, 2, 3]);
  assert.ok(Buffer.from(frames()[0]!.data, 'base64').equals(text.subarray(0, 2)), 'the frame ends in the middle of ñ');
  assert.equal(bytes().toString('utf8'), 'añ😀b');
});

test('a chunk larger than a frame becomes ordered frames of at most frameBytes', (t) => {
  const { pty, stream, frames, bytes } = setup(t, { ...LIMITS, windowBytes: 64, ringBytes: 64 });
  stream.attach('chan', 0);
  pty.output(Buffer.from('0123456789abcdefghij'));
  assert.deepEqual(frames().map((frame) => Buffer.from(frame.data, 'base64').length), [8, 8, 4]);
  assert.equal(bytes().toString(), '0123456789abcdefghij');
});

test('at most a window is unconfirmed; an ack sends the rest', (t) => {
  const { pty, stream, bytes, last } = setup(t);
  stream.attach('chan', 0);
  pty.output(Buffer.from('a'.repeat(24)));
  assert.equal(bytes().length, 16, 'the window holds 16 bytes');
  stream.ack('chan', last());
  assert.equal(bytes().length, 24);
});

test('with an active channel reading pauses instead of discarding, and resumes without loss', (t) => {
  const { pty, stream, bytes, last, events } = setup(t);
  stream.attach('chan', 0);
  const written = Buffer.from('x'.repeat(30) + 'y'.repeat(30));
  for (let i = 0; i < written.length; i += 6) pty.output(written.subarray(i, i + 6));
  assert.equal(pty.paused, true, 'the program waits: the ring is full of unconfirmed bytes');
  assert.equal(pty.delivered < written.length, true, 'the program is blocked in write');
  while (bytes().length < written.length) stream.ack('chan', last());
  assert.equal(pty.paused, false);
  assert.ok(bytes().equals(written), 'every byte, in order');
  assert.equal(events.some((event) => event.type === 'gap'), false);
});

test('a channel that confirms nothing while reading is paused is stalled: reading resumes and it gets a gap', async (t) => {
  const { pty, stream, events, last } = setup(t);
  stream.attach('chan', 0);
  for (let i = 0; i < 10; i++) pty.output(Buffer.from('z'.repeat(8)));
  assert.equal(pty.paused, true);
  await sleep(LIMITS.stalledMs * 2);
  assert.equal(pty.paused, false, 'the program never stops because nobody looks');
  assert.equal(pty.delivered, 80);
  stream.ack('chan', last());
  assert.deepEqual(events.find((event) => event.type === 'gap'), { channel: 'chan', type: 'gap', from: 3, to: 6 }, 'the loss is visible');
});

test('without a channel the program keeps running and the ring keeps the newest; a late reader gets a gap first', (t) => {
  const { pty, stream, events, frames, bytes } = setup(t);
  for (let i = 0; i < 10; i++) pty.output(Buffer.from(String(i).repeat(8)));
  assert.equal(pty.paused, false);
  stream.attach('chan', 2);
  const gap = events.find((event) => event.type === 'gap');
  assert.deepEqual(gap, { channel: 'chan', type: 'gap', from: 3, to: 6 });
  assert.equal(frames()[0]!.seq, 7);
  assert.equal(bytes().toString(), '6666666677777777', 'then the ring, within the window');
});

test('reads of one byte to a channel that confirms each one: the ring keeps at most ringFrames frames, and a gap says so', (t) => {
  const { pty, stream, events, frames, last } = setup(t, { ...LIMITS, windowBytes: 1024, ringBytes: 1024, ringFrames: 4 });
  stream.attach('chan', 0);
  for (let i = 0; i < 10; i++) {
    pty.output(Buffer.from(String(i)));
    stream.ack('chan', last());
  }
  assert.equal(last(), 10, 'every byte was its own frame');
  stream.attach('again', 0);
  assert.deepEqual(events.find((event) => event.channel === 'again' && event.type === 'gap'), { channel: 'again', type: 'gap', from: 1, to: 6 });
  assert.deepEqual(frames('again').map((frame) => frame.seq), [7, 8, 9, 10]);
});

test('reads of one byte to a channel that confirms nothing: reading pauses at ringFrames frames, without loss', (t) => {
  const { pty, stream, events, bytes, last } = setup(t, { ...LIMITS, windowBytes: 1024, ringBytes: 1024, ringFrames: 4 });
  stream.attach('chan', 0);
  for (let i = 0; i < 4; i++) pty.output(Buffer.from(String(i)));
  assert.equal(pty.paused, true, 'four unconfirmed frames fill the ring though it holds 4 of 1024 bytes');
  stream.ack('chan', last());
  assert.equal(pty.paused, false);
  for (let i = 4; i < 10; i++) pty.output(Buffer.from(String(i)));
  stream.ack('chan', last());
  assert.equal(bytes().toString(), '0123456789');
  assert.equal(events.some((event) => event.type === 'gap'), false);
});

test('reconnecting after the last seq held resumes exactly there', (t) => {
  const { pty, stream, frames, last } = setup(t);
  stream.attach('chan', 0);
  pty.output(Buffer.from('first'));
  const held = last();
  stream.detach('chan');
  pty.output(Buffer.from('second'));
  stream.attach('again', held);
  assert.deepEqual(frames('again').map((frame) => Buffer.from(frame.data, 'base64').toString()), ['second']);
  assert.equal(frames('again')[0]!.seq, held + 1);
});

test('a new channel replaces the previous one, whose acks and detach no longer count', (t) => {
  const { pty, stream, events, last } = setup(t);
  stream.attach('old', 0);
  stream.attach('new', 0);
  assert.deepEqual(events.filter((event) => event.type === 'closed'), [{ channel: 'old', type: 'closed', reason: 'replaced' }]);
  pty.output(Buffer.from('a'.repeat(16)));
  stream.ack('old', 2);
  stream.detach('old');
  pty.output(Buffer.from('b'.repeat(8)));
  assert.equal(last('new'), 2, 'the window of the new channel is still full');
  assert.equal(last('old'), 0);
});

test('acks out of order are ignored; an ack beyond what was sent and a resume point beyond the last are refused', (t) => {
  const { pty, stream, last } = setup(t);
  assert.equal(code(() => stream.attach('chan', 1)), 'invalid');
  stream.attach('chan', 0);
  pty.output(Buffer.from('a'.repeat(16)));
  stream.ack('chan', 2);
  stream.ack('chan', 1);
  pty.output(Buffer.from('b'.repeat(8)));
  assert.equal(last(), 3, 'the older ack did not shrink the window');
  assert.equal(code(() => stream.ack('chan', 9)), 'invalid');
  assert.equal(code(() => stream.ack('chan', 0)), 'ok');
});

test('input applies in order: a retry is ignored, a hole is refused, a split UTF-8 character arrives whole', (t) => {
  const { pty, stream } = setup(t);
  const ene = Buffer.from('ñ');
  assert.equal(stream.input(1, ene.subarray(0, 1)), 1);
  assert.equal(stream.input(1, ene.subarray(0, 1)), 1, 'a retry of the same seq');
  assert.equal(code(() => stream.input(3, Buffer.from('x'))), 'conflict');
  assert.equal(stream.input(2, ene.subarray(1)), 2);
  assert.equal(Buffer.concat(pty.written).toString('utf8'), 'ñ');
  stream.attach('chan', 0);
  assert.equal(stream.inputSeq, 2);
});

test('resize sets the size; redraw makes the program repaint at the same size', (t) => {
  const { pty, stream } = setup(t);
  stream.resize(100, 30, false);
  stream.resize(100, 30, true);
  assert.deepEqual(pty.sizes, [[100, 30], [100, 29], [100, 30]]);
});

test('when the program ends the channel gets every frame and then closed', (t) => {
  const { pty, stream, events, last } = setup(t);
  stream.attach('chan', 0);
  pty.output(Buffer.from('a'.repeat(24)));
  stream.exited();
  assert.equal(events.some((event) => event.type === 'closed'), false, 'frames are still pending');
  assert.equal(code(() => stream.input(1, Buffer.from('x'))), 'ended');
  stream.ack('chan', last());
  assert.deepEqual(events.at(-1), { channel: 'chan', type: 'closed', reason: 'exited' });
});
