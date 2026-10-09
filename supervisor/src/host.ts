// The native boundary of the supervisor: PTY, systemd and cgroup v2. The real one is systemdHost.ts;
// tests use support/fakeHost.ts.
import type { ToolAvailability } from '../../protocol/protocol.ts';

/** The PTY master as the supervisor uses it: raw bytes both ways (`encoding: null`). */
export interface PtyIo {
  onData(listener: (chunk: Buffer) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Stops reading the master: once the kernel buffer fills, the program blocks in write. */
  pause(): void;
  resume(): void;
}

export interface Launched extends PtyIo {
  /** Main process: its exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  /** Closes the PTY master: the kernel hangs up the session with SIGHUP. */
  hangUp(): void;
}

/**
 * A browser's CDP pipe (`--remote-debugging-pipe`, fds 3 and 4), held only by the supervisor: never a
 * debugging port another local process could reach. One CDP message per string.
 */
export interface LaunchedBrowser {
  /** Main process: its exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  /** Closes the pipe: the browser saves its profile and exits. */
  hangUp(): void;
}

export interface Host {
  availability(): Promise<ToolAvailability>;
  /** Starts argv in `cwd` on a PTY inside the cgroup of `unit`; resolves once the main process is inside it. */
  launch(unit: string, argv: string[], cwd: string): Promise<Launched>;
  /** Starts argv with `env` and a CDP pipe inside the cgroup of `unit`; resolves once the main process is inside it. */
  launchBrowser(unit: string, argv: string[], env: NodeJS.ProcessEnv): Promise<LaunchedBrowser>;
  /** Processes left in the cgroup of `unit`; none once it is gone. */
  processes(unit: string): Promise<number[]>;
  /** SIGTERM to every process in the cgroup. */
  terminate(unit: string): Promise<void>;
  /** `cgroup.kill`: SIGKILL to the whole cgroup, whatever left its session or process group. */
  kill(unit: string): Promise<void>;
}
