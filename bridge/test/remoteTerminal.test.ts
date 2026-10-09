// Terminals through the real Puente, the real supervisor and its socket (protocol/remoteTerminal.ts).
// Only the PTY is the double (supervisor/support/fakeHost.ts): what the program writes, what it reads,
// its size and whether the supervisor stopped reading it.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { lab, NOW, PHONE, TABLET, until } from '../support/remote_lab.ts';

const LIMITS = { frameBytes: 1024, windowBytes: 4096, ringBytes: 16_384, stalledMs: 30_000 };

async function terminalLab(t: Parameters<typeof lab>[0], options: Parameters<typeof lab>[1] = {}) {
  const context = await lab(t, { stream: LIMITS, ...options });
  const puente = await context.puente();
  const created = await puente.create(PHONE, `request-${Math.random().toString(36).slice(2, 10)}`);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.id as string;
  const pty = context.host.ptys.get(context.unit(id))!;
  return { ...context, ...puente, id, pty };
}

test('a device opens a terminal with its shell and folder, reads its output, types and resizes it', async (t) => {
  const { output, type, terminal, call, id, pty, logs, list, host, unit } = await terminalLab(t);
  assert.deepEqual((await call(PHONE, 'GET', '/v1/remote/shells', undefined, 'terminal/1')).json.shells, ['/bin/sh']);
  assert.deepEqual((await list(PHONE))[0], { id, kind: 'terminal', ownership: 'own', createdAt: NOW, state: 'running', exitCode: null, endedAt: null, terminal: { shell: '/bin/sh', cwd: os.tmpdir() } });
  assert.equal(host.cwds.get(unit(id)), os.tmpdir());

  const stream = await output(PHONE, id);
  assert.equal(stream.status, 200);
  await until(() => stream.events.length > 0, 'the open event');
  assert.partialDeepStrictEqual(stream.events[0], { type: 'open', inputSeq: 0 });
  pty.output(Buffer.from('secret-output-7f3a'));
  await until(() => stream.bytes().toString() === 'secret-output-7f3a', 'the output frame');
  assert.deepEqual((await type(PHONE, id, 'echo secret-input-91c2\r')).json, { inputSeq: 1 });
  assert.deepEqual(pty.written.map(String), ['echo secret-input-91c2\r']);
  assert.deepEqual((await terminal(PHONE, id, 'resize', { cols: 120, rows: 40 })).json, { ok: true });
  assert.deepEqual((await terminal(PHONE, id, 'resize', { cols: 120, rows: 40, redraw: true })).json, { ok: true });
  assert.deepEqual(pty.sizes, [[120, 40], [120, 39], [120, 40]]);
  const channel = stream.channel();
  assert.deepEqual((await terminal(PHONE, id, 'ack', { channel, seq: stream.lastSeq() })).json, { ok: true });
  stream.close();
  await stream.ended;
  await until(() => logs.some((line) => line.startsWith('GET /v1/remote/terminals/:id/output 200')), 'the stream log line');

  // Method, route label and status only: no ID, no key, no input and no output.
  for (const secret of [id, PHONE.key, 'secret-output', 'secret-input', Buffer.from('secret-input').toString('base64').slice(0, 12), channel]) {
    assert.ok(logs.every((line) => !line.includes(secret)), `${secret} reached the log:\n${logs.join('\n')}`);
  }
  for (const label of ['POST /v1/remote/terminals/:id/input 200', 'POST /v1/remote/terminals/:id/resize 200', 'POST /v1/remote/terminals/:id/ack 200', 'GET /v1/remote/shells 200']) {
    assert.ok(logs.some((line) => line.startsWith(label)), `${label} missing:\n${logs.join('\n')}`);
  }
});

test('the Puente never decodes: a UTF-8 character split by the PTY or by the input frames passes whole', async (t) => {
  const { output, type, id, pty } = await terminalLab(t);
  const stream = await output(PHONE, id);
  const text = Buffer.from('año 😀');
  pty.output(text.subarray(0, 2));
  pty.output(text.subarray(2, 6));
  pty.output(text.subarray(6));
  await until(() => stream.bytes().length === text.length, 'three frames');
  assert.ok(stream.bytes().equals(text));
  assert.equal(stream.events.filter((event) => event.type === 'output').length, 3, 'one frame per read, cut inside characters');
  const ene = Buffer.from('ñ');
  await type(PHONE, id, ene.subarray(0, 1));
  await type(PHONE, id, ene.subarray(1));
  assert.equal(Buffer.concat(pty.written).toString('utf8'), 'ñ');
});

test('another device cannot read, type into, resize nor confirm a terminal it does not own', async (t) => {
  const { output, type, terminal, id, pty } = await terminalLab(t);
  const mine = await output(PHONE, id);
  await until(() => mine.events.length > 0, 'the owner stream');
  const channel = mine.channel();
  const foreign = await output(TABLET, id);
  assert.deepEqual([foreign.status, foreign.json?.error.code], [404, 'remote_not_found']);
  for (const response of [
    await type(TABLET, id, 'rm -rf ~\r', 1),
    await terminal(TABLET, id, 'resize', { cols: 10, rows: 10 }),
    await terminal(TABLET, id, 'ack', { channel, seq: 0 }),
  ]) {
    assert.deepEqual([response.status, response.json.error.code], [404, 'remote_not_found']);
  }
  assert.deepEqual([pty.written, pty.sizes], [[], []]);
  pty.output(Buffer.from('still mine'));
  await until(() => mine.bytes().toString() === 'still mine', 'the owner keeps its stream');
});

test('revoking the device cuts its open stream at once, refuses to reconnect and ends its terminal', async (t) => {
  const context = await lab(t, { stream: LIMITS });
  // A program that survives every signal: the stream must be cut by the revocation itself, not by
  // the program ending.
  context.host.main = { ignoresHangUp: true, ignoresTerm: true, unkillable: true };
  const { output, type, create } = await context.puente();
  const id = (await create(PHONE, 'request-revoke-stream')).json.id as string;
  const pty = context.host.ptys.get(context.unit(id))!;
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the stream');
  await context.revoke(PHONE);
  await Promise.race([stream.ended, sleep(1000).then(() => assert.fail('the open stream survived the revocation'))]);
  const frames = stream.events.length;
  pty.output(Buffer.from('after revocation'));
  await sleep(20);
  assert.equal(stream.events.length, frames, 'nothing after the revocation');
  const again = await output(PHONE, id);
  assert.deepEqual([again.status, again.json?.error.code], [403, 'device_revoked']);
  assert.deepEqual((await type(PHONE, id, 'x')).json.error.code, 'device_revoked');
  assert.deepEqual(pty.written, []);
  await until(() => context.host.signals.includes(`${context.unit(id)} KILL`), 'its own terminal is being ended');
});

test('a revocation during the attach never opens the stream and leaves no channel', async (t) => {
  const context = await lab(t, { stream: LIMITS });
  const detached: string[] = [];
  const { create, output } = await context.puente((real) => ({
    ...real,
    attach: async (target, channel, after) => { await real.attach(target, channel, after); await context.revoke(PHONE); },
    detach: async (target, channel) => { detached.push(channel); await real.detach(target, channel); },
  }));
  // The stream opens on a freshly created terminal; the revocation lands between attach and the guard.
  const id = (await create(PHONE, 'request-attach-race')).json.id as string;
  const stream = await output(PHONE, id);
  assert.deepEqual([stream.status, stream.json?.error.code], [403, 'device_revoked']);
  await until(() => detached.length === 1, 'the channel was detached');
});

test('input sent before a revocation but read after it is refused and never typed', async (t) => {
  const { id, pty, revoke, base } = await terminalLab(t);
  const body = JSON.stringify({ seq: 1, data: Buffer.from('echo late\r').toString('base64') });
  const { promise, resolve } = Promise.withResolvers<{ status: number; body: string }>();
  const request = http.request(`${base}/v1/remote/terminals/${id}/input`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PHONE.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'terminal/1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (response) => {
    let text = '';
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode!, body: text }));
  });
  request.write(body.slice(0, 10));
  await sleep(20);
  await revoke(PHONE);
  request.end(body.slice(10));
  const answer = await promise;
  assert.equal(answer.status, 403);
  assert.equal(JSON.parse(answer.body).error.code, 'device_revoked');
  assert.deepEqual(pty.written, []);
});

test('losing the transport ends nothing; Last-Event-ID resumes exactly; a new stream replaces the old one', async (t) => {
  const { output, id, pty, host } = await terminalLab(t);
  const first = await output(PHONE, id);
  pty.output(Buffer.from('one'));
  await until(() => first.bytes().toString() === 'one', 'first frame');
  const held = first.lastSeq();
  first.close();
  await first.ended;
  pty.output(Buffer.from('two'));
  await sleep(20);
  assert.deepEqual(host.signals, [], 'closing the stream terminates nothing');
  const second = await output(PHONE, id, String(held));
  await until(() => second.bytes().toString() === 'two', 'only what came after');
  assert.equal(second.events.some((event) => event.type === 'gap'), false);
  const third = await output(PHONE, id, String(second.lastSeq()));
  await second.ended;
  assert.deepEqual(second.events.at(-1), { type: 'closed', reason: 'replaced' });
  pty.output(Buffer.from('three'));
  await until(() => third.bytes().toString() === 'three', 'the new stream continues');
});

// Each of these leaves no reader: the program must get all of its 200 000 bytes read, never wait in
// write for a channel that is gone (the ring is 16 KiB, so a channel still attached pauses it).
const released = (pty: { paused: boolean; delivered: number }) => () => !pty.paused && pty.delivered === 200_000;

test('closing the stream releases the program: it never waits for a reader that left', async (t) => {
  const { output, id, pty } = await terminalLab(t);
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the open event');
  stream.close();
  await stream.ended;
  pty.output(Buffer.alloc(200_000, 0x78));
  await until(released(pty), 'the program runs on without the stream');
});

test('a Puente that goes away does not leave its channel holding the program', async (t) => {
  const { output, id, pty, client } = await terminalLab(t);
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the open event');
  client.close();
  await stream.ended;
  pty.output(Buffer.alloc(200_000, 0x78));
  await until(released(pty), 'the program runs on without the Puente');
});

test('a client that leaves while its attach is in flight leaves no channel holding the program', async (t) => {
  const context = await lab(t, { stream: LIMITS });
  const attaching = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const { create, base } = await context.puente((real) => ({
    ...real,
    attach: async (target, channel, after) => { await real.attach(target, channel, after); attaching.resolve(); await finish.promise; },
  }));
  const id = (await create(PHONE, 'request-orphan')).json.id as string;
  const pty = context.host.ptys.get(context.unit(id))!;
  const request = http.get(`${base}/v1/remote/terminals/${id}/output`, { headers: { Authorization: `Bearer ${PHONE.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'terminal/1' } });
  request.on('error', () => {});
  await attaching.promise;
  request.destroy();
  // The server's close for this response is not observable from here: give it time to go by.
  await sleep(50);
  finish.resolve();
  pty.output(Buffer.alloc(200_000, 0x78));
  await until(released(pty), 'the program runs on without the client');
});

test('a Puente restart keeps the terminal, its output seqs and its input order', async (t) => {
  const context = await lab(t, { stream: LIMITS });
  const first = await context.puente();
  const id = (await first.create(PHONE, 'request-restart')).json.id as string;
  const pty = context.host.ptys.get(context.unit(id))!;
  const before = await first.output(PHONE, id);
  pty.output(Buffer.from('before'));
  await until(() => before.bytes().length === 6, 'output before the restart');
  await first.type(PHONE, id, 'a', 1);
  first.close();
  pty.output(Buffer.from('during'));
  const second = await context.puente();
  const after = await second.output(PHONE, id, String(before.lastSeq()));
  await until(() => after.bytes().toString() === 'during', 'what came while the Puente was down');
  assert.partialDeepStrictEqual(after.events[0], { type: 'open', inputSeq: 1 });
  assert.deepEqual((await second.type(PHONE, id, 'a', 1)).json, { inputSeq: 1 }, 'a retry after the restart is not typed twice');
  assert.deepEqual(pty.written.map(String), ['a']);
});

test('messages out of order: input holes and duplicates, acks and resume points beyond what exists', async (t) => {
  const { output, type, terminal, id, pty } = await terminalLab(t);
  const hole = await type(PHONE, id, 'b', 2);
  assert.deepEqual([hole.status, hole.json.error.code], [409, 'remote_conflict']);
  assert.deepEqual((await type(PHONE, id, 'a', 1)).json, { inputSeq: 1 });
  assert.deepEqual((await type(PHONE, id, 'a', 1)).json, { inputSeq: 1 });
  assert.deepEqual((await type(PHONE, id, 'b', 2)).json, { inputSeq: 2 });
  assert.deepEqual(pty.written.map(String), ['a', 'b']);
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the stream');
  const channel = stream.channel();
  assert.equal((await terminal(PHONE, id, 'ack', { channel, seq: 5 })).json.error.code, 'remote_invalid_request');
  // Canonical decimal only: '0e0', '0x0' and '+0' are 0 to Number(), and 0 exists.
  for (const lastEventId of ['7', '-1', '01', 'x', '0e0', '0x0', '+0']) {
    const refused = await output(PHONE, id, lastEventId);
    assert.deepEqual([refused.status, refused.json?.error.code], [400, 'remote_invalid_request'], lastEventId);
  }
});

test('input frames are bounded and well formed; nothing travels in the URL', async (t) => {
  const { type, terminal, call, id, pty, logs } = await terminalLab(t);
  assert.equal((await type(PHONE, id, Buffer.alloc(32_769, 0x61))).json.error.code, 'remote_too_large');
  assert.deepEqual((await type(PHONE, id, Buffer.alloc(32_768, 0x61), 1)).json, { inputSeq: 1 });
  for (const body of [{ seq: 2, data: '' }, { seq: 2, data: 'no base64!' }, { seq: 0, data: 'YQ==' }, { seq: 2, data: 'YQ==', extra: 1 }, { seq: '2', data: 'YQ==' }]) {
    assert.equal((await terminal(PHONE, id, 'input', body)).json.error.code, 'remote_invalid_request', JSON.stringify(body));
  }
  for (const body of [{ cols: 0, rows: 10 }, { cols: 10, rows: 1001 }, { cols: 10, rows: 10, redraw: false }, { cols: 1.5, rows: 10 }]) {
    assert.equal((await terminal(PHONE, id, 'resize', body)).json.error.code, 'remote_invalid_request', JSON.stringify(body));
  }
  const query = await call(PHONE, 'GET', `/v1/remote/terminals/${id}/output?key=${PHONE.key}`, undefined, 'terminal/1');
  assert.deepEqual([query.status, query.json.error.code], [400, 'remote_invalid_request']);
  assert.ok(logs.every((line) => !line.includes(PHONE.key)));
  assert.equal(pty.written.length, 1);
});

test('output pressure through the Puente: the window bounds what is unconfirmed, the program waits, acks drain it all', async (t) => {
  const { output, terminal, id, pty } = await terminalLab(t);
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the stream');
  const channel = stream.channel();
  const written = Buffer.alloc(200_000);
  for (let i = 0; i < written.length; i++) written[i] = i % 251;
  for (let i = 0; i < written.length; i += 700) pty.output(written.subarray(i, i + 700));
  await until(() => stream.bytes().length > LIMITS.windowBytes - LIMITS.frameBytes, 'a window arrives');
  const held = stream.bytes().length;
  await sleep(30);
  assert.equal(stream.bytes().length, held, 'no more without an ack');
  assert.ok(held <= LIMITS.windowBytes, 'at most a window unconfirmed');
  assert.equal(pty.paused, true, 'the program waits instead of losing output');
  assert.ok(pty.delivered <= LIMITS.ringBytes + 700, 'the supervisor holds at most the ring and one read');
  while (stream.bytes().length < written.length) {
    const seen = stream.lastSeq();
    await terminal(PHONE, id, 'ack', { channel, seq: seen });
    await until(() => stream.lastSeq() > seen || stream.bytes().length === written.length, 'the next window');
  }
  assert.ok(stream.bytes().equals(written), 'every byte, in order');
  assert.equal(stream.events.some((event) => event.type === 'gap'), false);
  assert.equal(pty.paused, false);
});

test('with nobody reading the program keeps running; a late reader sees the loss as a gap', async (t) => {
  const { output, id, pty } = await terminalLab(t);
  for (let i = 0; i < 40; i++) pty.output(Buffer.alloc(1024, 0x30 + (i % 10)));
  assert.equal(pty.paused, false);
  const stream = await output(PHONE, id);
  await until(() => stream.bytes().length === LIMITS.windowBytes, 'the window of the ring');
  assert.deepEqual(stream.events.find((event) => event.type === 'gap'), { type: 'gap', from: 1, to: 24 });
  assert.equal(stream.events.find((event) => event.type === 'output' && event.seq === 25) !== undefined, true, 'then the ring');
});

test('when the program ends the stream delivers its last output and closes; then the terminal is gone', async (t) => {
  const { output, type, id, pty, host, unit } = await terminalLab(t);
  const stream = await output(PHONE, id);
  pty.output(Buffer.from('logout'));
  host.exit(unit(id), 0);
  await stream.ended;
  assert.equal(stream.bytes().toString(), 'logout');
  assert.deepEqual(stream.events.at(-1), { type: 'closed', reason: 'exited' });
  const again = await output(PHONE, id);
  assert.deepEqual([again.status, again.json?.error.code], [410, 'remote_ended']);
  assert.equal((await type(PHONE, id, 'x')).json.error.code, 'remote_ended');
});

test('a terminal needs an installed shell and a folder that exists and can be entered', async (t) => {
  const { call } = await (await lab(t)).puente();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-folder-'));
  const locked = path.join(folder, 'locked');
  await fs.mkdir(locked, { mode: 0o000 });
  t.after(async () => { await fs.chmod(locked, 0o700); await fs.rm(folder, { recursive: true, force: true }); });
  const cases: [{ shell: string; cwd: string }, number, string][] = [
    [{ shell: '/bin/bash-not-installed', cwd: folder }, 400, 'remote_invalid_request'],
    [{ shell: 'sh', cwd: folder }, 400, 'remote_invalid_request'],
    [{ shell: '/bin/sh', cwd: 'relative' }, 400, 'remote_invalid_request'],
    [{ shell: '/bin/sh', cwd: path.join(folder, 'missing') }, 404, 'remote_not_found'],
    [{ shell: '/bin/sh', cwd: locked }, 403, 'remote_permission_denied'],
  ];
  for (const [terminal, status, code] of cases) {
    const response = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: `request-${status}-${String(terminal.cwd).length}`, kind: 'terminal', ...terminal });
    assert.deepEqual([response.status, response.json.error.code], [status, code], JSON.stringify(terminal));
    assert.ok(!JSON.stringify(response.json).includes(folder), 'the error never echoes the path');
  }
  const missing = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'request-no-shell', kind: 'terminal' });
  assert.equal(missing.json.error.code, 'remote_invalid_request');
  const capability = await call(PHONE, 'GET', '/v1/remote/shells', undefined, 'environments/1');
  assert.equal(capability.json.error.code, 'remote_upgrade_required');
});

test('a supervisor that goes away ends the open streams; after its restart the terminal is lost, never replaced', async (t) => {
  const { output, id, stopSupervisor, startSupervisor, host, list } = await terminalLab(t);
  const stream = await output(PHONE, id);
  await until(() => stream.events.length > 0, 'the stream');
  await stopSupervisor();
  await stream.ended;
  await startSupervisor();
  const again = await output(PHONE, id);
  assert.deepEqual([again.status, again.json?.error.code], [410, 'remote_ended']);
  assert.equal((await list(PHONE))[0]!.state, 'lost');
  assert.equal(host.launched.length, 1, 'nothing was launched in its place');
});
