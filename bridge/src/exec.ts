import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  input?: string;
}

// Runs a program with an argument vector (never through a shell) and resolves with its exit code
// and output. Rejects on spawn/input failure, timeout or an output limit violation.
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export const realExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        ...(options.input !== undefined ? { killSignal: 'SIGKILL' as const } : {}),
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('Program output limit exceeded.'));
        if (error.killed) return reject(new Error(`${file} timed out after ${options.timeoutMs} ms`));
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
        reject(new Error(`could not run ${file}: ${error.code ?? error.message}`));
      },
    );
    // Cancellation must also terminate a child that ignores SIGTERM.
    const abort = () => { child.kill('SIGKILL'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => options.signal?.removeEventListener('abort', abort));
    if (options.signal?.aborted) abort();
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        child.kill('SIGKILL');
        reject(new Error('Could not write program input.'));
      });
      child.stdin?.end(options.input);
    }
  });

export interface ExchangeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  commitPrepared?: (message: unknown, pid: number) => true;
}

/** Keep the kernel lock through retention and a synchronous Node replacement, then await native fsync. */
export async function execExchange(file: string, args: string[], input: unknown,
  respond: (message: unknown) => Promise<unknown>, options: ExchangeOptions = {}): Promise<unknown> {
  const { spawn } = await import('node:child_process');
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let pending = '', total = 0, stopping = false, busy = false, committed = false;
    let phase: 'initial' | 'retained' | 'committing' = 'initial';
    let final: unknown, failure: unknown;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => {
      if (stopping) return;
      stopping = true; failure = error;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      // The helper handles TERM to remove its private staged file and release flock.
      child.kill('SIGTERM');
      // KILL is only a backstop for a helper that ignores TERM: its exit is the signal, and a loaded
      // machine can take well over 100 ms to schedule that cleanup, which KILL would otherwise skip.
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKill.unref();
    };
    const cancel = () => stop(committed ? new Error('File replacement may have completed.')
      : options.signal?.reason ?? new Error('File exchange cancelled.'));
    const timer = setTimeout(() => stop(new Error('File exchange timed out.')), options.timeoutMs ?? 10_000);
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', () => stop(new Error('File exchange unavailable.')));
    child.stdin.on('error', () => stop(new Error('File exchange unavailable.')));
    child.stderr.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 12 * 1024 * 1024) stop(new Error('File exchange exceeded output bound.')); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopping) return;
      total += chunk.length;
      if (total > 12 * 1024 * 1024) return stop(new Error('File exchange exceeded output bound.'));
      pending += chunk.toString('utf8');
      const index = pending.indexOf('\n');
      if (index < 0) return;
      if (busy || pending.slice(index + 1).trim()) return stop(new Error('Invalid file exchange.'));
      const line = pending.slice(0,index); pending = pending.slice(index + 1);
      let message: any;
      try { message = JSON.parse(line); } catch { return stop(new Error('Invalid file exchange.')); }
      if (message?.phase === 'retain' && phase === 'initial') {
        busy = true;
        void respond(message.snapshot).then(reply => {
          busy = false;
          if (!stopping) { phase = 'retained'; child.stdin.write(JSON.stringify(reply) + '\n'); }
        }, stop);
      } else if (message?.phase === 'prepared' && phase === 'retained' && options.commitPrepared) {
        try {
          options.signal?.throwIfAborted();
          if (options.commitPrepared(message,child.pid!) !== true) throw new Error('Invalid synchronous file commit.');
        } catch (error) { return stop(error); }
        committed = true; phase = 'committing';
        child.stdin.end('{"committed":true}\n');
      } else if (message?.phase) { stop(new Error('Invalid file exchange.')); }
      else { final = message; }
    });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', cancel);
      if (stopping) reject(failure);
      else if (code === 0 && final !== undefined) resolve(final);
      else reject(new Error('File exchange failed.'));
      stopping = true;
    });
    child.stdin.write(JSON.stringify(input) + '\n');
  });
}
