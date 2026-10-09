import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';

// How the lab opens a terminal. `node-pty` and `node-pty-beta` are the candidates; `pipe` is the
// control without a PTY (plain child_process pipes) that the tests must reject.
export const backend = process.env.PTY_BACKEND ?? 'node-pty';

export interface Term {
  pid: number;
  onData(listener: (data: string | Buffer) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface OpenOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  // null: raw Buffers, so a test can see where chunk boundaries fall.
  encoding?: null;
}

const modules: Record<string, string> = { 'node-pty': 'node-pty', 'node-pty-beta': 'node-pty-beta' };

export function open(file: string, args: string[], options: OpenOptions): Term {
  if (backend === 'pipe') return openPipe(file, args, options);
  const name = modules[backend];
  if (!name) throw new Error(`unknown PTY_BACKEND ${backend}`);
  const pty = createRequire(import.meta.url)(name);
  return pty.spawn(file, args, { name: 'xterm-256color', ...options });
}

function openPipe(file: string, args: string[], options: OpenOptions): Term {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env, stdio: 'pipe' });
  if (options.encoding !== null) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
  }
  return {
    pid: child.pid ?? -1,
    onData(listener) {
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
    },
    onExit(listener) {
      child.on('exit', (code, signal) =>
        listener({ exitCode: code ?? 0, signal: signal ? constants.signals[signal] : undefined }));
    },
    write(data) { child.stdin.write(data); },
    // Pipes have no window size: this is exactly what a PTY adds.
    resize() {},
    kill(signal) { child.kill((signal ?? 'SIGHUP') as NodeJS.Signals); },
  };
}
