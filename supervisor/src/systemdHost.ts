// The real native boundary (ADR 0006 «Qué termina terminar»): each environment is a transient scope
// of the systemd user manager, `systemd-run --user --scope`, started on a node-pty PTY. systemd-run
// moves itself into the new scope and execs the program, so the PTY's main process and everything it
// starts live in that cgroup, apart from the supervisor's own unit. Without a cgroup v2 user manager
// there is no terminal: never a fallback to process groups or sessions, which setsid escapes.
import { execFile, spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import type { ToolAvailability } from '../../protocol/protocol.ts';
import type { Host, Launched, LaunchedBrowser } from './host.ts';

/** A CDP message larger than this is dropped whole: nothing Relay asks for comes near it. */
const CDP_MESSAGE_CHARS = 32 * 1024 * 1024;
/** What a dedicated browser's scope may take: its pages never take the Server's memory nor its tasks. */
const BROWSER_SCOPE = ['--property=MemoryMax=4G', '--property=TasksMax=2048'];

const run = promisify(execFile);

/** `<manager cgroup>` from `0::/user.slice/user-1000.slice/user@1000.service/…` of this process. */
export function managerCgroup(procSelfCgroup: string): string | null {
  return /^0::(\/(?:[^/\n]+\/)*user@\d+\.service)(?:\/|$)/m.exec(procSelfCgroup)?.[1] ?? null;
}

export async function systemdHost(options: { launchTimeoutMs?: number } = {}): Promise<Host> {
  const manager = managerCgroup(await fs.readFile('/proc/self/cgroup', 'utf8').catch(() => ''));
  const cgroup = (unit: string) => `/sys/fs/cgroup${manager}/app.slice/${unit}.scope`;

  async function processes(unit: string): Promise<number[]> {
    try {
      return (await fs.readFile(`${cgroup(unit)}/cgroup.procs`, 'utf8')).split('\n').filter(Boolean).map(Number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Waits until `pid` is inside the cgroup of `unit`; false if it ended or the wait timed out. */
  async function inside(unit: string, pid: number | undefined, ended: () => boolean): Promise<boolean> {
    const deadline = performance.now() + (options.launchTimeoutMs ?? 5000);
    while (pid === undefined || !(await processes(unit)).includes(pid)) {
      if (ended() || performance.now() > deadline) return false;
      await sleep(10);
    }
    return true;
  }

  return {
    async availability(): Promise<ToolAvailability> {
      try {
        if (!manager) throw new Error();
        await fs.access('/sys/fs/cgroup/cgroup.controllers');
        await run('systemd-run', ['--version'], { timeout: 3000 });
      } catch {
        return { state: 'unavailable', reason: 'unsupported_platform' };
      }
      try {
        // Dynamic on purpose: a native module that did not build or load is `dependency_missing`,
        // reported to the Puente, instead of a supervisor that cannot start at all.
        await import('node-pty');
      } catch {
        return { state: 'unavailable', reason: 'dependency_missing' };
      }
      return { state: 'available' };
    },

    async launch(unit: string, argv: string[], cwd: string): Promise<Launched> {
      if (!manager) throw new Error('No systemd user manager.');
      const { spawn } = await import('node-pty');
      // encoding null: raw bytes both ways, never decoded here (#76 saw reads cut inside a character).
      const term = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', `--unit=${unit}`, '--', ...argv], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd, env: { ...process.env, TERM: 'xterm-256color' }, encoding: null,
      });
      // Read from the start: what the program writes while launch waits for its cgroup waits here for
      // the stream. Past a ring of it, reading pauses and the program blocks in write.
      const early: Buffer[] = [];
      let earlyBytes = 0;
      let listener: ((chunk: Buffer) => void) | null = null;
      // With encoding null node-pty hands out Buffers, though IPty types them as strings.
      term.onData((chunk) => {
        const data = chunk as unknown as Buffer;
        if (listener) return listener(data);
        early.push(data);
        if ((earlyBytes += data.length) >= REMOTE_LIMITS.terminalRingBytes) term.pause();
      });
      const exited = Promise.withResolvers<number | null>();
      let ended = false;
      term.onExit(({ exitCode, signal }) => { ended = true; exited.resolve(signal ? null : exitCode); });
      // The record was written before this; wait until the main process is inside its own cgroup.
      if (!(await inside(unit, term.pid, () => ended))) {
        if (!ended) term.kill('SIGKILL');
        throw new Error('The environment did not start in its own cgroup.');
      }
      // destroy() exists on the Unix terminal but is missing from IPty: it closes the master fd.
      const master = term as typeof term & { destroy(): void };
      return {
        exited: exited.promise,
        hangUp: () => master.destroy(),
        onData: (next) => {
          listener = next;
          if (earlyBytes >= REMOTE_LIMITS.terminalRingBytes) term.resume();
          for (const chunk of early.splice(0)) next(chunk);
        },
        write: (data) => term.write(data),
        resize: (cols, rows) => term.resize(cols, rows),
        pause: () => term.pause(),
        resume: () => term.resume(),
      };
    },

    async launchBrowser(unit: string, argv: string[], env: NodeJS.ProcessEnv): Promise<LaunchedBrowser> {
      if (!manager) throw new Error('No systemd user manager.');
      // systemd-run keeps fds 3 and 4 across its exec: the browser reads CDP on 3 and writes on 4.
      // Its own output may carry URLs: it is never read nor logged.
      const child = spawnProcess('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', `--unit=${unit}`, ...BROWSER_SCOPE, '--', ...argv], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env,
      });
      const exited = Promise.withResolvers<number | null>();
      let ended = false;
      child.on('error', () => { ended = true; exited.resolve(null); });
      child.on('exit', (code, signal) => { ended = true; exited.resolve(signal ? null : code); });
      const toBrowser = child.stdio[3] as NodeJS.WritableStream & { destroy(): void };
      const fromBrowser = child.stdio[4] as NodeJS.ReadableStream & { destroy(): void };
      for (const stream of [toBrowser, fromBrowser]) stream.on('error', () => {});
      if (!(await inside(unit, child.pid, () => ended))) {
        if (!ended) child.kill('SIGKILL');
        throw new Error('The environment did not start in its own cgroup.');
      }
      let listener: (message: string) => void = () => {};
      let buffer = '';
      let skipping = false;
      fromBrowser.setEncoding('utf8');
      fromBrowser.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\0')) !== -1) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (skipping) skipping = false; else listener(message);
        }
        if (buffer.length > CDP_MESSAGE_CHARS) { buffer = ''; skipping = true; }
      });
      return {
        exited: exited.promise,
        send: (message) => { toBrowser.write(`${message}\0`); },
        onMessage: (next) => { listener = next; },
        hangUp: () => { toBrowser.destroy(); fromBrowser.destroy(); },
      };
    },

    processes,

    async terminate(unit: string): Promise<void> {
      for (const pid of await processes(unit)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    },

    async kill(unit: string): Promise<void> {
      try {
        await fs.writeFile(`${cgroup(unit)}/cgroup.kill`, '1');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
