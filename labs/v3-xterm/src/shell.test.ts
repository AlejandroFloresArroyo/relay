import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeShell, fnv1a, OutputQueue } from './shell.ts';

function drain(queue: OutputQueue, shell: FakeShell, chunk = 4096) {
  let out = '';
  for (;;) {
    shell.pump();
    const part = queue.take(chunk);
    if (!part) return out;
    out += part;
  }
}

test('a flood never grows the queue past its high-water mark plus one line', () => {
  const queue = new OutputQueue(8192);
  const shell = new FakeShell(queue, { cols: 80, rows: 24 });
  shell.input('flood 5000\r');
  shell.pump();
  assert.ok(queue.size <= 8192 + 128, `queue ${queue.size}`);
  const out = drain(queue, shell);
  assert.ok(queue.max <= 8192 + 128, `max ${queue.max}`);
  const end = out.match(/END lines=(\d+) bytes=(\d+) hash=([0-9a-f]+)/);
  assert.ok(end, 'END line');
  assert.equal(end[1], '5000');
  // The END line describes every flood line before it, byte for byte.
  const body = out.slice(out.indexOf('000000 '), out.indexOf('END lines='));
  assert.equal(String(body.length), end[2]);
  assert.equal(fnv1a(0x811c9dc5, body).toString(16), end[3]);
});

test('Ctrl-C stops a flood and reaches the shell while output is backed up', () => {
  const queue = new OutputQueue(4096);
  const shell = new FakeShell(queue, { cols: 80, rows: 24 });
  shell.input('flood 1000000\r');
  shell.pump();
  shell.input('\x03');
  const out = drain(queue, shell);
  assert.match(out, /\^C/);
  assert.doesNotMatch(out, /END lines=/);
  assert.equal(shell.interrupts, 1);
});

test('the line discipline applies backspace per code point and reports the line', () => {
  const queue = new OutputQueue(4096);
  const shell = new FakeShell(queue, { cols: 80, rows: 24 });
  const lines: string[] = [];
  shell.onLine = (line) => lines.push(line);
  shell.input('añ😀\x7f');
  shell.input('o ¿qué?\r');
  assert.deepEqual(lines, ['año ¿qué?']);
});

test('size reports what the terminal last announced', () => {
  const queue = new OutputQueue(4096);
  const shell = new FakeShell(queue, { cols: 80, rows: 24 });
  shell.resize({ cols: 41, rows: 17 });
  shell.input('size\r');
  assert.match(drain(queue, shell), /SIZE cols=41 rows=17/);
});
