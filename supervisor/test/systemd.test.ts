// Real processes under the systemd user manager and cgroup v2. Every unit is named relay-test-<random>
// and removed afterwards. Skipped, with the reason, where there is no user manager or node-pty.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SUPERVISOR_KEY_FILE } from '../../protocol/supervisor.ts';
import type { ChannelEvent } from '../../protocol/supervisor.ts';
import type { StreamLimits } from '../src/terminal.ts';
import { openSupervisor } from '../src/supervisor.ts';
import { managerCgroup, systemdHost } from '../src/systemdHost.ts';
import { auth, connect } from '../support/rawClient.ts';

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./fixtures/environment.sh', import.meta.url));
const WRITER = fileURLToPath(new URL('./fixtures/writer.sh', import.meta.url));
const FIRST = fileURLToPath(new URL('./fixtures/first.sh', import.meta.url));
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const DEVICE = '00000000-0000-4000-8000-000000000001';
const TAG = `relay-test-${randomBytes(4).toString('hex')}`;
const PIDS = ['main', 'nohup', 'setsid', 'double', 'stubborn', 'polite'] as const;

async function skipReason(): Promise<string | false> {
  try { await run('systemctl', ['--user', 'show-environment'], { timeout: 3000 }); } catch { return 'no systemd user manager in this session'; }
  if (!managerCgroup(await fs.readFile('/proc/self/cgroup', 'utf8'))) return 'this process is not under the systemd user manager (cgroup v2)';
  try { await import('node-pty'); } catch { return 'node-pty is not installed: run npm run setup in supervisor/'; }
  return false;
}
const skip = await skipReason();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-supervisor-real-'));
// The shells these tests may open: the fixtures and the system's own.
const SHELLS = path.join(root, 'shells');
await fs.writeFile(SHELLS, [FIXTURE, WRITER, FIRST, '/bin/sh', '/bin/bash'].join('\n'));
const strays: number[] = [];
after(async () => {
  // Everything this file started: its units, the processes it read, its directories.
  await run('systemctl', ['--user', 'stop', `${TAG}*`]).catch(() => {});
  await run('systemctl', ['--user', 'reset-failed', `${TAG}*`]).catch(() => {});
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await fs.rm(root, { recursive: true, force: true });
  const { stdout } = await run('systemctl', ['--user', 'list-units', '--all', '--no-legend', `${TAG}*`]).catch(() => ({ stdout: '' }));
  assert.equal(stdout.trim(), '', 'no test unit is left behind');
});

// Zombies count as gone: they no longer run.
function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z'; } catch { return false; }
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

type Pids = Record<(typeof PIDS)[number], number>;
async function readPids(out: string): Promise<Pids> {
  await until(() => fs.access(path.join(out, 'ready')).then(() => true, () => false), 'the environment is ready');
  const pids = {} as Pids;
  for (const name of PIDS) pids[name] = Number(await fs.readFile(path.join(out, name), 'utf8'));
  strays.push(...Object.values(pids));
  return pids;
}

const cgroupOf = (pid: number) => fs.readFile(`/proc/${pid}/cgroup`, 'utf8').then((text) => text.trim().replace(/^0::/, ''));
const active = (unit: string) => run('systemctl', ['--user', 'is-active', unit]).then(() => true, () => false);

test('terminating reaches all of its own cgroup and nothing outside it', { skip }, async () => {
  const out = await fs.mkdtemp(path.join(root, 'out-'));
  const escape = `${TAG}-escape`;
  // Work that existed before, like a tmux server started from the desktop.
  const before = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  before.unref();
  strays.push(before.pid!);
  await fs.writeFile(path.join(out, 'escape'), escape);
  const supervisor = await openSupervisor({
    directory: path.join(root, 'state-a'), host: await systemdHost(), unitPrefix: TAG, shellsFile: SHELLS,
    timing: { terminateGraceMs: 500, terminateGiveUpMs: 3000 },
  });
  try {
    const { environment } = await supervisor.register({ id: 'env_realAAAAAAAAAAAAAAAAAA', deviceId: DEVICE, kind: 'terminal', requestId: 'request-real-a', createdAt: Date.now(), terminal: { shell: FIXTURE, cwd: out } });
    assert.equal((await supervisor.launch(environment.id)).state, 'running');
    const pids = await readPids(out);
    const scope = `/app.slice/${TAG}-${environment.id}.scope`;
    for (const name of PIDS) assert.ok((await cgroupOf(pids[name])).endsWith(scope), `${name} runs in the environment's own cgroup`);
    assert.ok(!(await cgroupOf(process.pid)).endsWith(scope), 'the supervisor is not in it');
    await until(() => active(`${escape}.service`), 'the escaping unit started');

    const started = Date.now();
    const ended = await supervisor.terminate(environment.id);
    assert.deepEqual([ended.state, ended.exitCode, ended.terminationError], ['exited', null, undefined]);
    assert.ok(Date.now() - started >= 500, 'the process that ignores SIGTERM needed cgroup.kill after the grace');
    for (const name of PIDS) assert.equal(alive(pids[name]), false, `${name} ended: setsid, nohup and double fork do not escape the cgroup`);
    await fs.access(path.join(out, 'term')).catch(() => assert.fail('SIGTERM reached the cgroup before cgroup.kill'));
    assert.equal(await active(`${TAG}-${environment.id}.scope`), false);
    // Outside the cgroup: what existed before survives; what left through systemd is out of reach.
    assert.equal(alive(before.pid!), true);
    assert.equal(await active(`${escape}.service`), true);
  } finally {
    await supervisor.close();
  }
});

test('under systemd the supervisor keeps environments across Puente reconnections; its own stop loses only the PTY', { skip }, async () => {
  const out = await fs.mkdtemp(path.join(root, 'out-'));
  const runtime = path.join(root, 'run-b');
  const state = path.join(root, 'state-b');
  const start = (n: number) => run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${TAG}-supervisor-${n}`, process.execPath, MAIN,
    '--runtime', runtime, '--state', state, '--unit-prefix', TAG, '--shells', SHELLS]);
  const puente = async () => {
    for (let attempt = 0; ; attempt++) {
      const key = await fs.readFile(path.join(runtime, SUPERVISOR_KEY_FILE), 'utf8').catch(() => '');
      const client = connect(runtime);
      if ((await client.next())?.type === 'hello') {
        client.send(auth(key));
        if ((await client.next())?.type === 'ready') return client;
      }
      client.socket.destroy();
      if (attempt > 100) throw new Error('the supervisor did not answer');
      await sleep(100);
    }
  };
  const request = { id: 'env_unitAAAAAAAAAAAAAAAAAA', deviceId: DEVICE, kind: 'terminal', requestId: 'request-real-b', createdAt: Date.now(), terminal: { shell: FIXTURE, cwd: out } };

  await start(1);
  const first = await puente();
  first.send({ id: 1, op: 'register', environment: request });
  assert.equal((await first.reply())?.created, true);
  first.send({ id: 2, op: 'launch', environmentId: request.id });
  assert.partialDeepStrictEqual(await first.reply(), { ok: true, environment: { state: 'running' } });
  const pids = await readPids(out);
  const unitCgroup = (await run('systemctl', ['--user', 'show', '-P', 'ControlGroup', `${TAG}-supervisor-1.service`])).stdout.trim();
  assert.notEqual(await cgroupOf(pids.main), unitCgroup, 'the environment is not in the supervisor unit');

  // The Puente goes away and comes back: same environment, same process, nothing new launched.
  first.socket.destroy();
  const second = await puente();
  second.send({ id: 1, op: 'register', environment: { ...request, id: 'env_unitBBBBBBBBBBBBBBBBBB' } });
  assert.partialDeepStrictEqual(await second.reply(), { ok: true, created: false, environment: { id: request.id, state: 'running' } });
  second.send({ id: 2, op: 'list' });
  assert.equal(((await second.reply())?.environments as unknown[]).length, 1);
  assert.equal(alive(pids.main), true);
  second.socket.destroy();

  // An orderly stop of the supervisor (SIGTERM, process.exit) closes the PTY master: the main
  // process gets SIGHUP; what ignores it stays in the environment's cgroup, outside the unit.
  await run('systemctl', ['--user', 'stop', `${TAG}-supervisor-1.service`]);
  await until(() => !alive(pids.main), 'the main process ended with its PTY');
  for (const name of ['nohup', 'setsid', 'stubborn'] as const) assert.equal(alive(pids[name]), true, `${name} survives the supervisor`);

  // Next start: lost and still alive, never relaunched; terminating it ends the whole cgroup.
  await start(2);
  const third = await puente();
  third.send({ id: 1, op: 'list' });
  const lines = [await third.next(), await third.next()];
  assert.deepEqual(lines.find((line) => line?.type === 'event'), { type: 'event', action: 'lost', environmentId: request.id });
  assert.partialDeepStrictEqual(lines.find((line) => line?.type === 'response'), { environments: [{ id: request.id, state: 'lost', endedAt: null }] });
  third.send({ id: 2, op: 'terminate', environmentId: request.id });
  assert.partialDeepStrictEqual(await third.reply(), { ok: true, environment: { state: 'exited', exitCode: null } });
  for (const name of PIDS) assert.equal(alive(pids[name]), false, name);
  third.socket.destroy();
  await run('systemctl', ['--user', 'stop', `${TAG}-supervisor-2.service`]);
});

/** One real terminal in its own scope, with its channel stream collected. */
async function terminalLab(name: string, shell: string, cwd: string, stream?: Partial<StreamLimits>) {
  const supervisor = await openSupervisor({
    directory: path.join(root, `state-${name}`), host: await systemdHost(), unitPrefix: TAG, shellsFile: SHELLS, stream,
    timing: { terminateGraceMs: 500, terminateGiveUpMs: 3000 },
  });
  const events: ChannelEvent[] = [];
  supervisor.onChannel((event) => events.push(event));
  const id = `env_${name.padEnd(22, 'A')}`;
  await supervisor.register({ id, deviceId: DEVICE, kind: 'terminal', requestId: `request-${name}`, createdAt: Date.now(), terminal: { shell, cwd } });
  await supervisor.launch(id);
  const target = { environmentId: id, deviceId: DEVICE };
  const frames = () => events.filter((event) => event.type === 'output').map((event) => Buffer.from(event.data, 'base64'));
  const output = () => Buffer.concat(frames());
  let inputSeq = 0;
  const type = (text: string | Buffer) => supervisor.input(target, ++inputSeq, Buffer.from(text));
  const close = async () => {
    await supervisor.terminate(id).catch(() => {});
    await supervisor.close();
  };
  return { supervisor, events, target, frames, output, type, close };
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

test('a real PTY: what the program writes the moment it starts is frame 1, never lost', { skip }, async () => {
  // It writes while launch still waits to see it in its cgroup; several launches, so the race shows.
  for (let round = 0; round < 5; round++) {
    const lab = await terminalLab(`first${round}`, FIRST, root);
    try {
      lab.supervisor.attach(lab.target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
      await until(() => lab.output().includes('FIRST-OUTPUT-LINE'), `round ${round}: the program's first line`, 3000);
      const first = lab.events.find((event) => event.type === 'output' || event.type === 'gap');
      assert.ok(first?.type === 'output' && first.seq === 1 && Buffer.from(first.data, 'base64').includes('FIRST-OUTPUT-LINE'), `round ${round}: ${JSON.stringify(first)}`);
    } finally {
      await lab.close();
    }
  }
});

test('a real PTY: with reading paused the program blocks in write, then finishes without losing a byte', { skip }, async () => {
  const out = await fs.mkdtemp(path.join(root, 'out-'));
  const size = 4 * 1024 * 1024;
  await fs.writeFile(path.join(out, 'size'), String(size));
  const lab = await terminalLab('flow', WRITER, out, { frameBytes: 16_384, windowBytes: 65_536, ringBytes: 262_144, stalledMs: 60_000 });
  try {
    lab.supervisor.attach(lab.target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
    await fs.writeFile(path.join(out, 'go'), '');
    await sleep(2000);
    const held = lab.output().length;
    assert.equal(await exists(path.join(out, 'done')), false, 'without acks the program is still blocked in write after 2 s');
    assert.ok(held <= 65_536, `only a window was sent unconfirmed (${held} bytes)`);
    const started = Date.now();
    await until(async () => {
      const last = lab.events.filter((event) => event.type === 'output').at(-1);
      if (last?.type === 'output') lab.supervisor.ack(lab.target, 'AAAAAAAAAAAAAAAAAAAAAA', last.seq);
      return lab.output().length >= size && await exists(path.join(out, 'done'));
    }, 'the program finishes once the channel confirms', 30_000);
    const received = lab.output();
    assert.equal(lab.events.some((event) => event.type === 'gap'), false, 'nothing was dropped');
    assert.equal(received.length, size);
    assert.equal(received.every((byte) => byte === 0x78), true, 'every byte is the program\'s');
    console.log(`flow: ${size} bytes in ${Date.now() - started} ms with frame 16 KiB, window 64 KiB, ring 256 KiB`);
  } finally {
    await lab.close();
  }
});

test('a real PTY: UTF-8 split by the reads or by the input frames arrives whole', { skip }, async () => {
  const out = await fs.mkdtemp(path.join(root, 'out-'));
  const lab = await terminalLab('utf8', '/bin/bash', out);
  try {
    lab.supervisor.attach(lab.target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
    // 'echo ñ' with ñ cut between two input frames.
    lab.type(Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xc3]));
    lab.type(Buffer.from([0xb1, 0x0d]));
    await until(() => lab.output().includes(Buffer.from('ñ\r\n')), 'bash printed ñ');
    // The program writes the two bytes of ñ in two writes: two reads, two frames.
    lab.type("printf '\\303'; sleep 0.5; printf '\\261%s\\n' END\r");
    await until(() => lab.output().includes(Buffer.from('ñEND')), 'printf wrote ñ');
    const frames = lab.frames();
    const cut = frames.findIndex((frame, index) => frame.at(-1) === 0xc3 && frames[index + 1]?.[0] === 0xb1);
    assert.ok(cut >= 0, 'one frame ends inside ñ and the next one finishes it');
    assert.equal(lab.output().toString('utf8').includes('\ufffd'), false, 'nothing was decoded on the way');
  } finally {
    await lab.close();
  }
});

test('tmux inside the terminal: it draws, repaints on redraw, and ends with the environment; an outside tmux survives', { skip }, async () => {
  // Certifying tmux requires it: a missing tmux fails here instead of skipping.
  await run('tmux', ['-V']);
  const out = await fs.mkdtemp(path.join(root, 'out-'));
  const inner = `${TAG}-in`;
  const outer = `${TAG}-out`;
  // -f /dev/null: tmux's defaults, not the account's configuration.
  await run('tmux', ['-L', outer, '-f', '/dev/null', 'new-session', '-d', '-s', 'outside', 'sleep 300']);
  // kill-server leaves the socket file behind in tmux's directory: remove it too.
  for (const name of [outer, inner]) {
    after(async () => {
      await run('tmux', ['-L', name, 'kill-server']).catch(() => {});
      await fs.rm(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid!()}`, name), { force: true });
    });
  }
  const lab = await terminalLab('tmux', '/bin/bash', out);
  try {
    lab.supervisor.attach(lab.target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
    lab.supervisor.resize(lab.target, 100, 30, false);
    lab.type(`tmux -L ${inner} -f /dev/null new-session -s inside\r`);
    await until(() => lab.output().includes('[inside]'), 'the tmux status line');
    lab.type('echo RELAY_$((6*7))\r');
    await until(() => lab.output().includes('RELAY_42'), 'a command inside tmux');
    const before = lab.output().length;
    lab.supervisor.resize(lab.target, 100, 30, true);
    await until(() => lab.output().subarray(before).includes('RELAY_42'), 'tmux repainted the screen at the same size');

    // A client of a tmux that was already running outside the environment.
    lab.type(`TMUX= tmux -L ${outer} attach -t outside\r`);
    await until(async () => (await run('tmux', ['-L', outer, 'list-clients'])).stdout.trim() !== '', 'the outside tmux has the client');
    assert.equal((await lab.supervisor.terminate(lab.target.environmentId)).state, 'exited');
    await assert.rejects(run('tmux', ['-L', inner, 'has-session']), 'the tmux started inside ended with the environment');
    await run('tmux', ['-L', outer, 'has-session', '-t', 'outside']);
    assert.equal((await run('tmux', ['-L', outer, 'list-clients'])).stdout.trim(), '', 'only its client inside the environment ended');
  } finally {
    await lab.close();
  }
});
