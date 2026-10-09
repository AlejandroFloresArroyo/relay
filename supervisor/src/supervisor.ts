// Environments and their ownership (ADR 0006 «Vida de un entorno» and «Qué termina terminar»).
// The supervisor never decides who owns what: it keeps the device the Puente gave it, launches only
// what has a durable record, and only ever signals the cgroup of a recorded environment. Terminal
// operations name the device that asks, and a terminal of another device answers like a missing one.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import type { ToolAvailability } from '../../protocol/protocol.ts';
import type { BrowserAction, BrowserActionResult, BrowserTab, BrowserView } from '../../protocol/remoteBrowser.ts';
import type { TerminalShells } from '../../protocol/remoteTerminal.ts';
import { validTerminalPath } from '../../protocol/supervisor.ts';
import type { ChannelEvent, EnvironmentRecord, RegisterInput, SupervisorErrorCode, SupervisorEvent, TerminalTarget } from '../../protocol/supervisor.ts';
import { DedicatedBrowser } from './browser.ts';
import type { Host, Launched } from './host.ts';
import { loadRegistry, saveRegistry } from './registry.ts';
import { TerminalStream, type StreamLimits } from './terminal.ts';

export class SupervisorFailure extends Error {
  code: SupervisorErrorCode;
  constructor(code: SupervisorErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface SupervisorOptions {
  /** Private state directory with the registry. */
  directory: string;
  host: Host;
  /** Prefix of every unit: `<prefix>-<environment id>.scope`. Tests use relay-test-…. */
  unitPrefix: string;
  /** The installed shells a terminal may run; /etc/shells unless a test lists its own. */
  shellsFile?: string;
  /** The Chrome or Chromium of dedicated browsers; without it there is none on this Server. */
  browser?: string;
  /** Where finished downloads stay on the Server; ~/Downloads unless set. */
  downloads?: string;
  now?: () => number;
  timing?: Partial<Record<'terminateGraceMs' | 'terminateGiveUpMs' | 'terminateRetryMs' | 'pollMs' | 'sweepMs', number>>;
  limits?: Partial<Record<'liveEnvironmentsPerDevice' | 'liveEnvironmentsTotal' | 'endedEnvironmentsPerDevice', number>>;
  stream?: Partial<StreamLimits>;
}

const OUTBOX_LIMIT = 1000;

/**
 * Headless, on the CDP pipe and never a port (any local process of any account could reach a port),
 * with no keyring: the profile is the one --user-data-dir names, nothing of the account's own browser.
 */
const BROWSER_FLAGS = ['--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--password-store=basic', 'about:blank'];

export interface Supervisor {
  availability(): Promise<ToolAvailability>;
  list(): EnvironmentRecord[];
  register(input: RegisterInput): Promise<{ environment: EnvironmentRecord; created: boolean }>;
  launch(id: string): Promise<EnvironmentRecord>;
  terminate(id: string): Promise<EnvironmentRecord>;
  discard(id: string): Promise<void>;
  shells(): Promise<TerminalShells>;
  attach(target: TerminalTarget, channel: string, after: number): void;
  ack(target: TerminalTarget, channel: string, seq: number): void;
  detach(target: TerminalTarget, channel: string): void;
  input(target: TerminalTarget, seq: number, data: Buffer): number;
  resize(target: TerminalTarget, cols: number, rows: number, redraw: boolean): void;
  /** Whether a dedicated browser can be launched here: the host, then the browser program. */
  browserStatus(): Promise<ToolAvailability>;
  tabs(target: TerminalTarget): BrowserTab[];
  openTab(target: TerminalTarget, url: string | null): Promise<BrowserTab>;
  closeTab(target: TerminalTarget, tab: string): Promise<void>;
  act(target: TerminalTarget, tab: string, action: BrowserAction): Promise<BrowserActionResult>;
  view(target: TerminalTarget, channel: string, view: BrowserView): Promise<void>;
  /** The Puente went away: every channel is detached and its programs keep running. */
  detachAll(): void;
  /** Channel streams go only to the connected Puente. */
  onChannel(listener: (event: ChannelEvent) => void): void;
  /** Events wait here until a Puente is connected to log them. */
  takeEvents(): SupervisorEvent[];
  onEvent(listener: () => void): void;
  /** Stops timers and terminations in flight; nothing is written after it. Environments keep running, their records stay. */
  close(): Promise<void>;
}

/** Entries of the shells file that exist and can run, in its order. */
export async function installedShells(file: string): Promise<string[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const shells: string[] = [];
  for (const line of new Set(text.split('\n').map((entry) => entry.trim()))) {
    if (!validTerminalPath(line)) continue;
    const runs = await fs.stat(line).then((stat) => stat.isFile(), () => false) && await fs.access(line, constants.X_OK).then(() => true, () => false);
    if (runs) shells.push(line);
  }
  return shells;
}

/** An existing folder the account may enter. */
async function enterable(cwd: string): Promise<void> {
  let stat;
  try { stat = await fs.stat(cwd); } catch (error) {
    throw new SupervisorFailure((error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission' : 'not_found');
  }
  if (!stat.isDirectory()) throw new SupervisorFailure('not_found');
  await fs.access(cwd, constants.X_OK).catch(() => { throw new SupervisorFailure('permission'); });
}

export async function openSupervisor(options: SupervisorOptions): Promise<Supervisor> {
  const { host, directory } = options;
  const now = options.now ?? Date.now;
  const timing = { terminateGraceMs: REMOTE_LIMITS.terminateGraceMs, terminateGiveUpMs: REMOTE_LIMITS.terminateGiveUpMs, terminateRetryMs: REMOTE_LIMITS.terminateRetryMs, pollMs: 50, sweepMs: 1000, ...options.timing };
  const limits = { liveEnvironmentsPerDevice: REMOTE_LIMITS.liveEnvironmentsPerDevice, liveEnvironmentsTotal: REMOTE_LIMITS.liveEnvironmentsTotal, endedEnvironmentsPerDevice: REMOTE_LIMITS.endedEnvironmentsPerDevice, ...options.limits };
  const records = new Map((await loadRegistry(directory)).map((record) => [record.id, record]));
  /** How to hang up each running main process: the PTY master or the browser's CDP pipe. */
  const mains = new Map<string, { hangUp(): void }>();
  const browsers = new Map<string, DedicatedBrowser>();
  const downloads = options.downloads ?? path.join(os.homedir(), 'Downloads');
  /** Output and input of each terminal while its program runs, and until its last frame is delivered. */
  const streams = new Map<string, TerminalStream>();
  let channelListener: (event: ChannelEvent) => void = () => {};
  const shellsFile = options.shellsFile ?? '/etc/shells';
  /** Main process outcome seen while a termination was running. */
  const mainExit = new Map<string, number | null>();
  const chains = new Map<string, Promise<unknown>>();
  const retries = new Map<string, NodeJS.Timeout>();
  const outbox: SupervisorEvent[] = [];
  let notify: () => void = () => {};
  let saving: Promise<void> = Promise.resolve();
  let closed = false;

  const unit = (id: string) => `${options.unitPrefix}-${id}`;

  function persist(): Promise<void> {
    // close() waits for the writes already queued; none starts after it.
    if (closed) return Promise.reject(new SupervisorFailure('unavailable'));
    const write = saving.then(() => saveRegistry(directory, [...records.values()]));
    saving = write.catch(() => {});
    return write;
  }

  function emit(action: SupervisorEvent['action'], environmentId: string): void {
    outbox.push({ type: 'event', action, environmentId });
    if (outbox.length > OUTBOX_LIMIT) outbox.shift();
    notify();
  }

  /** One operation at a time per environment: a termination waits for its launch, never races it. */
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    chains.set(id, tail);
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
    return run;
  }

  async function emptyWithin(id: string, ms: number): Promise<boolean> {
    const deadline = performance.now() + ms;
    for (;;) {
      // A closed supervisor stops here: what it was terminating keeps running, resumed at the next start.
      if (closed) throw new SupervisorFailure('unavailable');
      if ((await host.processes(unit(id))).length === 0) return true;
      if (performance.now() >= deadline) return false;
      await sleep(timing.pollMs);
    }
  }

  /** Over the limit, the oldest ended record goes; its processes had already ended. */
  function evict(deviceId: string): void {
    const ended = [...records.values()].filter((record) => record.deviceId === deviceId && record.endedAt !== null)
      .sort((a, b) => a.endedAt! - b.endedAt!);
    while (ended.length > limits.endedEnvironmentsPerDevice) {
      const oldest = ended.shift()!;
      records.delete(oldest.id);
      emit('discarded', oldest.id);
    }
  }

  async function finish(record: EnvironmentRecord): Promise<EnvironmentRecord> {
    record.state = 'exited';
    if (mainExit.has(record.id)) record.exitCode = mainExit.get(record.id)!;
    record.endedAt = now();
    delete record.terminationError;
    mains.delete(record.id);
    mainExit.delete(record.id);
    evict(record.deviceId);
    // The cgroup is empty whether or not the disk takes it.
    emit('terminated', record.id);
    await persist();
    return record;
  }

  function scheduleRetry(id: string): void {
    if (closed || retries.has(id)) return;
    retries.set(id, setTimeout(() => {
      retries.delete(id);
      void serial(id, async () => {
        const record = records.get(id);
        if (!record || record.endedAt !== null || record.state !== 'terminating') return;
        await host.kill(unit(id));
        if (await emptyWithin(id, timing.terminateGiveUpMs)) await finish(record);
        else scheduleRetry(id);
      }).catch(() => scheduleRetry(id));
    }, timing.terminateRetryMs).unref());
  }

  /**
   * SIGHUP by closing the master and SIGTERM to the cgroup; cgroup.kill after the grace. A browser
   * gets the grace on its closed pipe alone: it saves its profile then, and its cookies are written
   * by its network process, which a SIGTERM to every process at once would end first.
   */
  async function drive(record: EnvironmentRecord): Promise<EnvironmentRecord> {
    record.state = 'terminating';
    delete record.terminationError;
    // Recorded so a restart resumes it, but the signals never wait on a disk that fails.
    await persist().catch(() => {});
    mains.get(record.id)?.hangUp();
    if (record.kind !== 'browser_dedicated') await host.terminate(unit(record.id));
    if (await emptyWithin(record.id, timing.terminateGraceMs)) return finish(record);
    await host.kill(unit(record.id));
    if (await emptyWithin(record.id, timing.terminateGiveUpMs - timing.terminateGraceMs)) return finish(record);
    // Never exited while a process remains.
    return failed(record);
  }

  /** A termination that could not finish stays terminating and is retried, whatever stopped it. */
  async function failed(record: EnvironmentRecord): Promise<EnvironmentRecord> {
    if (record.endedAt !== null) return record;
    record.terminationError = 'processes_remaining';
    await persist().catch(() => {});
    emit('terminate_failed', record.id);
    scheduleRetry(record.id);
    return record;
  }

  function watch(id: string, launched: { exited: Promise<number | null> }): void {
    void launched.exited.then((code) => {
      mainExit.set(id, code);
      return serial(id, async () => {
        const record = records.get(id);
        if (!record || record.state !== 'running') return;
        record.exitCode = code;
        mains.delete(id);
        mainExit.delete(id);
        if ((await host.processes(unit(id))).length === 0) {
          record.state = 'exited';
          record.endedAt = now();
          evict(record.deviceId);
        }
        await persist();
      });
    }).catch(() => {});
  }

  /** Environments whose main process is gone end when their cgroup empties. */
  async function sweep(): Promise<void> {
    for (const record of records.values()) {
      if (record.endedAt !== null || mains.has(record.id) || (record.state !== 'running' && record.state !== 'lost')) continue;
      await serial(record.id, async () => {
        if (record.endedAt !== null || mains.has(record.id) || (record.state !== 'running' && record.state !== 'lost')) return;
        if ((await host.processes(unit(record.id))).length > 0) return;
        if (record.state === 'running') record.state = 'exited';
        record.endedAt = now();
        evict(record.deviceId);
        await persist();
      }).catch(() => {});
    }
  }

  // Recovery: this process holds no PTY from before. A recorded environment with processes left in
  // its cgroup stays `lost` and alive (endedAt null) until it empties or is terminated; one with none
  // (the Server restarted) is lost and ended. Nothing is relaunched and nothing unrecorded is touched.
  let changed = false;
  for (const record of records.values()) {
    if (record.endedAt !== null) continue;
    changed = true;
    if (record.state === 'terminating') { void serial(record.id, () => drive(record).catch(() => failed(record))); continue; }
    record.state = 'lost';
    if ((await host.processes(unit(record.id))).length === 0) record.endedAt = now();
    emit('lost', record.id);
  }
  for (const deviceId of new Set([...records.values()].map((record) => record.deviceId))) evict(deviceId);
  if (changed) await persist();
  const sweeper = setInterval(() => { void sweep(); }, timing.sweepMs).unref();

  const live = (record: EnvironmentRecord) => record.endedAt === null && record.ownership === 'own';

  /** The record of `target`; one of another device or of another kind answers like a missing one. */
  function owned(target: TerminalTarget, kind: EnvironmentRecord['kind']): EnvironmentRecord {
    const record = records.get(target.environmentId);
    if (!record || record.deviceId !== target.deviceId || record.kind !== kind) throw new SupervisorFailure('not_found');
    return record;
  }
  const isBrowser = (target: TerminalTarget) => records.get(target.environmentId)?.kind === 'browser_dedicated';
  function browser(target: TerminalTarget): DedicatedBrowser {
    const running = browsers.get(owned(target, 'browser_dedicated').id);
    if (!running || running.done) throw new SupervisorFailure('ended');
    return running;
  }

  /** The terminal of `target`; one of another device answers like a missing one. */
  function terminal(target: TerminalTarget): TerminalStream {
    const record = owned(target, 'terminal');
    const stream = streams.get(record.id);
    if (!stream) throw new SupervisorFailure('ended');
    return stream;
  }
  /** An ended terminal is forgotten once no channel is left to deliver to. */
  function release(id: string): void {
    const stream = streams.get(id);
    if (!stream?.done) return;
    stream.close();
    streams.delete(id);
  }

  async function browserStatus(): Promise<ToolAvailability> {
    const hosted = await host.availability();
    if (hosted.state !== 'available') return hosted;
    const runs = options.browser !== undefined && await fs.access(options.browser, constants.X_OK).then(() => true, () => false);
    return runs ? { state: 'available' } : { state: 'unavailable', reason: 'dependency_missing' };
  }

  /**
   * One profile per device in the supervisor's private state directory, with its own HOME and XDG
   * folders: logins stay for the device's next browser, and nothing of the account's own browser
   * (profile, keyring, certificate store, configuration) is read or copied.
   */
  async function startBrowser(record: EnvironmentRecord): Promise<{ running: DedicatedBrowser; launched: { exited: Promise<number | null>; hangUp(): void } }> {
    const root = path.join(directory, 'browsers', record.deviceId);
    const profile = path.join(root, 'profile');
    const home = path.join(root, 'home');
    const staging = path.join(root, 'downloads');
    // Partial downloads of an earlier browser of the device (crashed, ended mid-download) go now: the
    // device has no other live browser (register), so nothing else writes there.
    await fs.rm(staging, { recursive: true, force: true });
    for (const folder of [profile, home, staging]) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    // Without a session bus: Chrome would otherwise move its main process to a scope of its own
    // (app-org.chromium.Chromium-<pid>.scope, components/dbus/xdg/systemd.cc), out of the cgroup that
    // terminating ends. The own XDG folders also keep the launcher's chromium-flags.conf unread.
    const env = {
      ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'), DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    };
    const launched = await host.launchBrowser(unit(record.id), [options.browser!, `--user-data-dir=${profile}`, ...BROWSER_FLAGS], env);
    const running = new DedicatedBrowser(launched, { staging, downloads }, (event) => channelListener(event));
    try {
      await running.start();
    } catch (error) {
      launched.hangUp();
      throw error;
    }
    return { running, launched };
  }

  return {
    availability(): Promise<ToolAvailability> { return host.availability(); },
    list(): EnvironmentRecord[] { return [...records.values()].map((record) => structuredClone(record)); },

    async register(input: RegisterInput): Promise<{ environment: EnvironmentRecord; created: boolean }> {
      const same = () => [...records.values()].find((record) => record.deviceId === input.deviceId && record.requestId === input.requestId);
      const answer = (previous: EnvironmentRecord) => {
        if (previous.kind !== input.kind || previous.terminal?.shell !== input.terminal?.shell || previous.terminal?.cwd !== input.terminal?.cwd) throw new SupervisorFailure('conflict');
        return { environment: structuredClone(previous), created: false };
      };
      const known = same();
      if (known) return answer(known);
      // A terminal record without its shell and folder would not load back: refuse it here too.
      if ((input.kind === 'terminal') !== (input.terminal !== undefined)) throw new SupervisorFailure('invalid');
      if (input.terminal) {
        if (!(await installedShells(shellsFile)).includes(input.terminal.shell)) throw new SupervisorFailure('invalid');
        await enterable(input.terminal.cwd);
      }
      // The habitual browser is shared work: it is never launched here.
      if (input.kind === 'browser_habitual') throw new SupervisorFailure('invalid');
      if (input.kind === 'browser_dedicated' && (await browserStatus()).state !== 'available') throw new SupervisorFailure('unavailable');
      // From here to records.set nothing awaits: another register of the same device, started
      // meanwhile, is seen by these checks, never past them.
      const raced = same();
      if (raced) return answer(raced);
      const all = [...records.values()];
      // One browser per device profile: Chrome would hand a second launch on it to the first.
      if (input.kind === 'browser_dedicated' && all.some((record) => record.kind === 'browser_dedicated' && record.deviceId === input.deviceId && record.endedAt === null)) {
        throw new SupervisorFailure('limit');
      }
      if (records.has(input.id)) throw new SupervisorFailure('conflict');
      if (all.filter((record) => live(record) && record.deviceId === input.deviceId).length >= limits.liveEnvironmentsPerDevice
        || all.filter(live).length >= limits.liveEnvironmentsTotal) throw new SupervisorFailure('limit');
      const record: EnvironmentRecord = { ...input, ownership: 'own', state: 'starting', exitCode: null, endedAt: null };
      records.set(record.id, record);
      try {
        await persist();
      } catch {
        // Without its durable record, it never launches.
        records.delete(record.id);
        throw new SupervisorFailure('unavailable');
      }
      return { environment: structuredClone(record), created: true };
    },

    launch(id: string): Promise<EnvironmentRecord> {
      return serial(id, async () => {
        const record = records.get(id);
        if (!record) throw new SupervisorFailure('not_found');
        if (record.state !== 'starting') return structuredClone(record);
        let launched: { exited: Promise<number | null>; hangUp(): void };
        try {
          if (record.kind === 'browser_dedicated') {
            const started = await startBrowser(record);
            launched = started.launched;
            browsers.set(id, started.running);
            void launched.exited.then(() => { browsers.delete(id); });
          } else {
            if (!record.terminal) throw new Error('Only terminals and dedicated browsers launch here.');
            const pty: Launched = await host.launch(unit(id), [record.terminal.shell], record.terminal.cwd);
            const stream = new TerminalStream(pty, (event) => channelListener(event), options.stream);
            streams.set(id, stream);
            void pty.exited.then(() => { stream.exited(); release(id); });
            launched = pty;
          }
        } catch {
          // A launch can fail after its program started something in the cgroup: that ends like any
          // termination. Unknown counts as left: never exited while a process may remain.
          if (await host.processes(unit(id)).then((pids) => pids.length > 0, () => true)) await drive(record).catch(() => failed(record));
          else {
            record.state = 'exited';
            record.endedAt = now();
            evict(record.deviceId);
            await persist();
          }
          throw new SupervisorFailure('launch_failed');
        }
        mains.set(id, launched);
        record.state = 'running';
        watch(id, launched);
        await persist();
        return structuredClone(record);
      });
    },

    terminate(id: string): Promise<EnvironmentRecord> {
      return serial(id, async () => {
        const record = records.get(id);
        if (!record) throw new SupervisorFailure('not_found');
        // Idempotent: an ended one answers its real final state; a failed one is retried now.
        if (record.endedAt !== null) return structuredClone(record);
        return structuredClone(await drive(record).catch(() => failed(record)));
      });
    },

    discard(id: string): Promise<void> {
      return serial(id, async () => {
        const record = records.get(id);
        if (!record) throw new SupervisorFailure('not_found');
        if (record.endedAt === null) throw new SupervisorFailure('alive');
        records.delete(id);
        await persist();
      });
    },

    async shells(): Promise<TerminalShells> {
      const shells = await installedShells(shellsFile);
      const own = os.userInfo().shell;
      return { shells, defaultShell: own && shells.includes(own) ? own : null, home: os.homedir() };
    },
    attach(target, channel, after) {
      if (isBrowser(target)) return browser(target).attach(channel);
      terminal(target).attach(channel, after);
      release(target.environmentId);
    },
    ack(target, channel, seq) {
      if (isBrowser(target)) return browser(target).ack(channel, seq);
      terminal(target).ack(channel, seq);
      release(target.environmentId);
    },
    detach(target, channel) {
      if (isBrowser(target)) return browser(target).detach(channel);
      terminal(target).detach(channel);
      release(target.environmentId);
    },
    input(target, seq, data) { return terminal(target).input(seq, data); },
    resize(target, cols, rows, redraw) { terminal(target).resize(cols, rows, redraw); },
    browserStatus,
    tabs(target) { return browser(target).list(); },
    openTab(target, url) { return browser(target).open(url); },
    closeTab(target, tab) { return browser(target).close(tab); },
    act(target, tab, action) { return browser(target).act(tab, action); },
    view(target, channel, view) { return browser(target).view(channel, view); },
    detachAll() {
      for (const [id, stream] of streams) {
        stream.detachAny();
        release(id);
      }
      for (const running of browsers.values()) running.detachAny();
    },
    onChannel(listener) { channelListener = listener; },

    /** Events wait here until a Puente is connected to log them. */
    takeEvents(): SupervisorEvent[] { return outbox.splice(0); },
    onEvent(listener: () => void): void { notify = listener; },

    /** Stops timers and terminations in flight; nothing is written after it. Environments keep running, their records stay. */
    async close(): Promise<void> {
      closed = true;
      clearInterval(sweeper);
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      for (const stream of streams.values()) stream.close();
      await saving;
    },
  };
}

