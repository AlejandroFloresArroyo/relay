import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoTerminals } from './demoTerminal.ts';
import { createTerminalSession, type TerminalLink } from './terminalSession.ts';
import { readTerminal } from './terminals.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const text = (frames: string[]) => frames.map((frame) => Buffer.from(frame, 'base64').toString()).join('');

test('the demo has one terminal per state the tool shows, through the real session', async () => {
  const { api, port } = createDemoTerminals();
  const list = await api.list();
  // Every demo terminal is a valid one as the app reads it from a Puente.
  for (const terminal of list) assert.deepEqual(readTerminal({ ...terminal, kind: 'terminal', terminal: { shell: terminal.shell, cwd: terminal.cwd } }), terminal);
  assert.deepEqual(list.map((t) => t.state), ['running', 'running', 'running', 'exited', 'lost', 'running']);

  const live = list.filter((t) => t.state === 'running');
  const sessions = live.map((terminal) => createTerminalSession(port(terminal.id), { wait: () => new Promise(() => {}) }));
  await flush();
  const links: TerminalLink['state'][] = sessions.map((session) => session.link().state);
  assert.deepEqual(links, ['reconnecting', 'replaced', 'failed', 'connected']);

  const shell = sessions.at(-1)!;
  assert.match(text(await shell.pull()), /412 pruebas/);
  shell.write('ls\r');
  await flush();
  assert.match(text(await shell.pull()), /README\.md/);

  const created = await api.create('demo-request', '/bin/bash', '/home/user');
  assert.equal(created.state, 'running');
  assert.equal((await api.terminate(live.at(-1)!.id)).state, 'exited');
  await flush();
  assert.equal(shell.link().state, 'exited');
  for (const session of sessions) session.close();
});

test('npm test writes a line at a time and then gives the prompt back; closing the stream stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createDemoTerminals().port(`env_demo${'relay'.padEnd(22, '0')}`);
  const seen: string[] = [];
  const stop = new AbortController();
  const stream = relay.stream(0, (data) => {
    const event = JSON.parse(data) as { type: string; data?: string };
    if (event.type === 'output') seen.push(Buffer.from(event.data!, 'base64').toString());
  }, stop.signal);
  await flush();
  await relay.input(1, Buffer.from('npm test\r').toString('base64'));
  const before = seen.length;
  t.mock.timers.tick(700);
  assert.match(seen.slice(before).join(''), /orders\.test\.ts/);
  for (let i = 0; i < 8; i++) t.mock.timers.tick(700);
  assert.match(seen.slice(before).join(''), /Tests {2}29 passed[\s\S]*ale@atlas/);
  // A second run, cut off by closing the stream, writes nothing more.
  await relay.input(2, Buffer.from('npm test\r').toString('base64'));
  stop.abort();
  await stream;
  const after = seen.length;
  t.mock.timers.tick(10_000);
  assert.equal(seen.length, after);
});
