import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { backend, open, type OpenOptions } from '../src/backend.ts';

const probe = fileURLToPath(new URL('../src/probe.ts', import.meta.url));
const owner = fileURLToPath(new URL('../src/owner.ts', import.meta.url));
// Everything the lab creates lives here; no user profile, rc file or credential is read.
const tmp = mkdtempSync(join(tmpdir(), 'relay-pty-'));
const env = { PATH: process.env.PATH ?? '', TERM: 'xterm-256color', LANG: 'C.UTF-8', HOME: tmp };
const started: number[] = [];

// Zombies count as gone: only the parent can reap them, and they no longer run.
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(50);
  }
}

function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`no exit after ${ms} ms`); })]);
}

function start(file: string, args: string[], options: Partial<OpenOptions> = {}) {
  const term = open(file, args, { cols: 80, rows: 24, cwd: tmp, env, ...options });
  started.push(term.pid);
  let output = '';
  const chunks: Buffer[] = [];
  term.onData((data) => {
    if (typeof data === 'string') output += data;
    else chunks.push(data);
  });
  const { promise: exit, resolve } = Promise.withResolvers<{ exitCode: number; signal?: number }>();
  term.onExit(resolve);
  const waitFor = (pattern: RegExp, ms = 5000) =>
    until(() => pattern.test(output), ms, `${pattern} in ${JSON.stringify(output.slice(-300))}`)
      .then(() => output.match(pattern) as RegExpMatchArray);
  return { term, chunks, exit, waitFor, output: () => output };
}

after(() => {
  const leaked = started.filter(alive);
  for (const pid of leaked) process.kill(pid, 'SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
  assert.deepEqual(leaked, [], 'every process the lab started is gone');
});

test(`[${backend}] shell interactivo: comandos, tty y código de salida`, async () => {
  const shell = start('bash', ['--norc', '--noprofile', '-i']);
  // The echo of the typed line shows $((40+2)); only the executed command prints 42.
  shell.term.write('tty; [ -t 0 ] && [ -t 1 ] && echo "TTY-SI$((40+2))"\r');
  await shell.waitFor(/\/dev\/pts\/\d+/);
  await shell.waitFor(/TTY-SI42/);
  shell.term.write('exit 7\r');
  assert.equal((await within(shell.exit)).exitCode, 7);
});

test(`[${backend}] isatty y tamaño inicial que ve el programa`, async () => {
  const run = start(process.execPath, [probe, 'tty'], { cols: 91, rows: 27 });
  const [line] = await run.waitFor(/\{.*\}/);
  assert.deepEqual(JSON.parse(line), { stdin: true, stdout: true, cols: 91, rows: 27 });
  assert.equal((await within(run.exit)).exitCode, 0);
});

test(`[${backend}] pantalla completa: resize con SIGWINCH y entrada UTF-8 dividida`, async () => {
  const screen = start(process.execPath, [probe, 'screen']);
  await screen.waitFor(/\x1b\[\?1049h/);
  await screen.waitFor(/SIZE 80x24/);
  screen.term.resize(120, 40);
  await screen.waitFor(/SIZE 120x40/);
  screen.term.resize(41, 13);
  await screen.waitFor(/SIZE 41x13/);
  // a ñ € 😀 = 61 c3b1 e282ac f09f9880; every write after the first ends inside a code point.
  const typed = Buffer.from('añ€😀');
  for (const [from, to] of [[0, 2], [2, 4], [4, 8], [8, 10]]) {
    screen.term.write(typed.subarray(from, to));
    await sleep(100);
  }
  screen.term.write('\r');
  const [, hex, reads, text] = await screen.waitFor(/GOT (\w+) READS (\d+) TXT (.*)\r/);
  assert.equal(hex, typed.toString('hex'));
  assert.ok(Number(reads) >= 4, `the program read the input in ${reads} pieces`);
  assert.equal(text, 'añ€😀');
  screen.term.write('q');
  await screen.waitFor(/\x1b\[\?1049lBYE/);
  assert.equal((await within(screen.exit)).exitCode, 0);
});

test(`[${backend}] salida UTF-8 dividida entre chunks`, async () => {
  const raw = start(process.execPath, [probe, 'utf8out'], { encoding: null });
  assert.equal((await within(raw.exit)).exitCode, 0);
  assert.ok(raw.chunks.some((chunk) => !isUtf8(chunk)), 'some chunk ends inside a code point');
  assert.equal(Buffer.concat(raw.chunks).toString('utf8'), 'ñ€😀\r\n');

  const decoded = start(process.execPath, [probe, 'utf8out']);
  assert.equal((await within(decoded.exit)).exitCode, 0);
  assert.equal(decoded.output(), 'ñ€😀\r\n');
});

test(`[${backend}] salida normal: volumen completo, códigos y señales`, async () => {
  const lines = 20000;
  const bulk = start(process.execPath, ['-e', `for (let i = 0; i < ${lines}; i++) process.stdout.write('linea ' + i + '\\n')`]);
  assert.equal((await within(bulk.exit, 15000)).exitCode, 0);
  const received = bulk.output().split('\r\n');
  assert.equal(received.filter((line) => /^linea \d+$/.test(line)).length, lines);
  assert.equal(received.at(-2), `linea ${lines - 1}`);

  assert.equal((await within(start('sh', ['-c', 'exit 5']).exit)).exitCode, 5);

  const sleeper = start('sleep', ['30']);
  sleeper.term.kill('SIGTERM');
  assert.equal((await within(sleeper.exit)).signal, 15);
});

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

test(`[${backend}] tmux dentro de la terminal sigue el tamaño`, { skip: !hasTmux && 'tmux no instalado' }, async () => {
  // Own socket directory: never touches the user's tmux server.
  const tmuxEnv = { ...env, TMUX_TMPDIR: tmp };
  try {
    const client = start('tmux', ['-f', '/dev/null', 'new-session', '-s', 'lab', process.execPath, probe, 'screen'], { env: tmuxEnv });
    await client.waitFor(/SIZE 80x23/, 10000);
    client.term.resize(100, 30);
    await client.waitFor(/SIZE 100x29/);
    client.term.write('q');
    assert.equal((await within(client.exit, 10000)).exitCode, 0);
  } finally {
    try { execFileSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' }); } catch { /* no server left */ }
  }
});

for (const mode of ['hold', 'hold-nohup']) {
  test(`[${backend}] muere el proceso dueño del PTY (${mode})`, async (t) => {
    const log = join(tmp, `${mode}.log`);
    const notes = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
    const holder = spawnChild(process.execPath, [owner, mode, log, tmp], {
      env: { PATH: env.PATH, PTY_BACKEND: backend },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    started.push(holder.pid ?? -1);
    let out = '';
    holder.stdout.on('data', (data) => { out += data; });
    await until(() => /PTY_PID \d+/.test(out), 5000, 'owner reports the PTY child');
    const child = Number(out.match(/PTY_PID (\d+)/)?.[1]);
    started.push(child);
    await until(() => (notes().match(/^tick /gm) ?? []).length >= 3, 5000, 'PTY child running');

    const gone = once(holder, 'exit');
    holder.kill('SIGKILL');
    await gone;
    await sleep(1000);
    t.diagnostic(`child ${child} alive=${alive(child)}; notes after owner death:\n${notes().split('\n').filter((line) => !line.startsWith('tick ')).join('\n')}`);

    if (mode === 'hold') {
      assert.equal(alive(child), false, 'the PTY child dies with its owner');
    } else {
      // Survives only as an orphan whose terminal is hung up: nothing can read or write it again.
      assert.equal(alive(child), true, 'a child that ignores SIGHUP keeps running');
      assert.match(notes(), /^sighup$/m);
      assert.match(notes(), /^stdout-error EIO$/m);
      process.kill(child, 'SIGKILL');
      await until(() => !alive(child), 3000, 'orphan killed');
    }
  });
}
