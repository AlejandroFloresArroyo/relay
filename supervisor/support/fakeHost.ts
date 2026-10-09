// Double for the native boundary (src/host.ts): environments are lists of fake processes per unit.
// Signals follow the real rules: SIGHUP and SIGTERM end what does not ignore them, cgroup.kill ends
// everything except what a test marks unkillable.
import type { ToolAvailability } from '../../protocol/protocol.ts';
import type { Host, Launched, LaunchedBrowser, PtyIo } from '../src/host.ts';
import { FakeBrowser } from './fakeBrowser.ts';

/** A PTY master: what the program writes waits in the kernel buffer while reading is paused. */
export class FakePty implements PtyIo {
  paused = false;
  /** Bytes the supervisor has read. */
  delivered = 0;
  written: Buffer[] = [];
  sizes: [number, number][] = [];
  private listeners: ((chunk: Buffer) => void)[] = [];
  private pending: Buffer[] = [];

  /** The program writes `chunk`. */
  output(chunk: Buffer): void {
    this.pending.push(chunk);
    this.flush();
  }

  onData(listener: (chunk: Buffer) => void): void { this.listeners.push(listener); }
  write(data: Buffer): void { this.written.push(Buffer.from(data)); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  pause(): void { this.paused = true; }
  resume(): void {
    this.paused = false;
    this.flush();
  }

  private flush(): void {
    while (!this.paused && this.pending.length > 0) {
      const chunk = this.pending.shift()!;
      this.delivered += chunk.length;
      for (const listener of this.listeners) listener(chunk);
    }
  }
}

export interface FakeProcess { pid: number; main: boolean; ignoresHangUp?: boolean; ignoresTerm?: boolean; unkillable?: boolean }
export type ProcessTraits = Omit<FakeProcess, 'pid' | 'main'>;

let nextPid = 10_000;

export class FakeHost implements Host {
  units = new Map<string, FakeProcess[]>();
  /** Every unit ever launched, in order. */
  launched: string[] = [];
  /** The PTY of each unit and the folder it started in. */
  ptys = new Map<string, FakePty>();
  cwds = new Map<string, string>();
  /** The browser of each unit. */
  browsers = new Map<string, FakeBrowser>();
  signals: string[] = [];
  state: ToolAvailability = { state: 'available' };
  /** Traits of the main process and extra processes of the next launches. */
  main: ProcessTraits = {};
  children: ProcessTraits[] = [];
  /** Runs inside launch before the process exists; a test can hold it there. */
  beforeLaunch: (unit: string) => Promise<void> = async () => {};
  failLaunch = false;
  private exits = new Map<string, (code: number | null) => void>();

  async availability(): Promise<ToolAvailability> { return this.state; }

  async launch(unit: string, _argv: string[], cwd: string): Promise<Launched> {
    await this.beforeLaunch(unit);
    if (this.failLaunch || this.units.has(unit)) throw new Error('launch failed');
    this.launched.push(unit);
    this.cwds.set(unit, cwd);
    this.units.set(unit, [{ pid: nextPid++, main: true, ...this.main }, ...this.children.map((traits) => ({ pid: nextPid++, main: false, ...traits }))]);
    const { promise, resolve } = Promise.withResolvers<number | null>();
    this.exits.set(unit, resolve);
    const pty = new FakePty();
    this.ptys.set(unit, pty);
    return Object.assign(pty, {
      exited: promise,
      hangUp: () => { this.signals.push(`${unit} HUP`); this.remove(unit, (p) => !p.ignoresHangUp); },
    });
  }

  async launchBrowser(unit: string, argv: string[], env: NodeJS.ProcessEnv): Promise<LaunchedBrowser> {
    await this.beforeLaunch(unit);
    if (this.failLaunch || this.units.has(unit)) throw new Error('launch failed');
    this.launched.push(unit);
    this.units.set(unit, [{ pid: nextPid++, main: true, ...this.main }, ...this.children.map((traits) => ({ pid: nextPid++, main: false, ...traits }))]);
    const browser = new FakeBrowser(argv, env);
    this.browsers.set(unit, browser);
    // A signal that ends the main process ends the browser; the browser ending (its pipe closed, a
    // crash) takes its renderers with it.
    const exit = browser.exit.bind(browser);
    this.exits.set(unit, exit);
    browser.exit = (code) => { exit(code); this.remove(unit, (p) => !p.ignoresHangUp, code); };
    browser.hangUp = () => { this.signals.push(`${unit} PIPE`); browser.exit(0); };
    return browser;
  }

  async processes(unit: string): Promise<number[]> { return (this.units.get(unit) ?? []).map((p) => p.pid); }
  async terminate(unit: string): Promise<void> { this.signals.push(`${unit} TERM`); this.remove(unit, (p) => !p.ignoresTerm); }
  async kill(unit: string): Promise<void> { this.signals.push(`${unit} KILL`); this.remove(unit, (p) => !p.unkillable); }

  /** The main process ends on its own with `code`; other processes stay. */
  exit(unit: string, code: number): void {
    this.units.set(unit, (this.units.get(unit) ?? []).filter((p) => !p.main));
    this.exits.get(unit)?.(code);
    this.cleanup(unit);
  }

  /** Processes that were not started by the supervisor, as a previous tmux or another program. */
  outside(unit: string, count = 1): void {
    this.units.set(unit, Array.from({ length: count }, () => ({ pid: nextPid++, main: false })));
  }

  /** Simulates a Server restart: every process is gone. */
  reboot(): void { this.units.clear(); this.exits.clear(); }

  private remove(unit: string, dies: (p: FakeProcess) => boolean, code: number | null = null): void {
    const before = this.units.get(unit) ?? [];
    const main = before.find((p) => p.main);
    this.units.set(unit, before.filter((p) => !dies(p)));
    if (main && dies(main)) this.exits.get(unit)?.(code);
    this.cleanup(unit);
  }

  private cleanup(unit: string): void {
    if (this.units.get(unit)?.length === 0) this.units.delete(unit);
  }
}
