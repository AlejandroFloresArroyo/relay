// The acceptance laboratory of V3 (#97, docs/relay-v3.md §7): every component real, in throwaway
// directories. The supervisor is its own process (`supervisor/src/main.ts`, as relay-supervisor.service
// runs it) on the systemd user manager, cgroup v2 and node-pty; each environment is a real
// `<tag>-<id>.scope`. The Puente is createApp wired as `main.ts` wires it, so it can stop and start
// again while the supervisor keeps its PTYs. Doubles: Hermes (FakeHermes: no real Hermes, profile or
// secret is read) and the Tailscale Service publisher, which needs the tailnet console (docs/v3-install.md).
// Skipped, with the reason, without a user manager under cgroup v2 or without node-pty.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SUPERVISOR_KEY_FILE } from '../../protocol/supervisor.ts';
import { managerCgroup } from '../../supervisor/src/systemdHost.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp, type AppDeps } from '../src/server.ts';
import { BROWSER_CAPABILITY } from '../src/remote/browsers.ts';
import { ENVIRONMENTS_CAPABILITY } from '../src/remote/environments.ts';
import { createRemoteFileSystem, FILES_CAPABILITY } from '../src/remote/files.ts';
import type { ExtensionLink } from '../src/remote/habitualBrowser.ts';
import { createLinuxSockets } from '../src/remote/linuxSockets.ts';
import type { RemoteTools } from '../src/remote/ports.ts';
import { createSupervisorClient } from '../src/remote/supervisorClient.ts';
import { TERMINAL_CAPABILITY } from '../src/remote/terminals.ts';
import { WEB_CAPABILITY } from '../src/remote/web.ts';
import { FakeHermes } from './fake_hermes.ts';
import { simulatedPublisher } from './fake_web.ts';
import { downloadFile, openStream, PHONE, TABLET, until, uploadFile, type Device, type OutputStream } from './remote_lab.ts';

export { PHONE, TABLET, until, type Device, type OutputStream };
const run = promisify(execFile);
const SUPERVISOR = fileURLToPath(new URL('../../supervisor/src/main.ts', import.meta.url));

const HTTP_LINE = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD) \S+ \d{3} \d+ms$/;
const WEB_LINE = /^web app_[A-Za-z0-9_-]{16,} [A-Z]+ \d{3}$/;
/**
 * The logs of a whole scenario (ADR 0006 «Errores y registros», «Fails silently»): the Puente writes
 * method, route label and status, and its web listeners app ID, method and status; neither carries
 * any of `secrets` (keys, codes, cookies, typed text, paths, contents, URLs) nor an entity ID in a route.
 */
export function assertLogsClean(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    if (!HTTP_LINE.test(line) && !WEB_LINE.test(line)) throw new Error(`log line outside the contract: ${line}`);
    if (HTTP_LINE.test(line) && /\b(env|term|op|app|acc)_[A-Za-z0-9_-]{16,}/.test(line)) throw new Error(`log line names an ID: ${line}`);
    for (const secret of secrets) if (secret && line.includes(secret)) throw new Error(`log line carries a secret: ${line}`);
  }
}

async function skipReason(): Promise<string | false> {
  try { await run('systemctl', ['--user', 'show-environment'], { timeout: 3000 }); } catch { return 'no systemd user manager in this session'; }
  if (!managerCgroup(await fs.readFile('/proc/self/cgroup', 'utf8'))) return 'this process is not under the systemd user manager (cgroup v2)';
  // Loaded as the supervisor loads it: a native module this machine may not have built.
  try { createRequire(SUPERVISOR)('node-pty'); } catch { return 'node-pty is not installed: run npm run setup in supervisor/'; }
  return false;
}
export const SKIP = await skipReason();

/** The first of the dedicated browser programs this machine has (docs/v3-install.md «Matriz probada»). */
export async function labBrowser(): Promise<string | null> {
  for (const candidate of [process.env.RELAY_TEST_BROWSER, '/usr/bin/chromium', '/usr/bin/google-chrome-stable']) {
    if (candidate && await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

export interface PuenteOptions extends Pick<AppDeps, 'now' | 'monotonic' | 'timer'>, Partial<Pick<AppDeps, 'tailnet'>> {
  /** The habitual browser's extension link (habitualBrowser.ts); none: not_configured. */
  habitual?: ExtensionLink | null;
  /** Where a phone reaches it (a lab Puente on the tailnet address for an emulator); loopback and an ephemeral port by default. */
  listen?: { host: string; port: number; origin: string };
}

export async function acceptanceLab(t: TestContext, options: { browser?: string | null } = {}) {
  const tag = `relay-acc-${randomBytes(4).toString('hex')}`;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relay-acceptance-')));
  const dirs = {
    root, runtime: path.join(root, 'run'), state: path.join(root, 'supervisor'), relay: path.join(root, 'relay'),
    /** The Puente account's home for the files tool, with a Hermes directory of fixtures. */
    home: path.join(root, 'home'), downloads: path.join(root, 'home', 'Downloads'), tmux: path.join(root, 'tmux'),
  };
  const hermesHome = path.join(dirs.home, '.hermes');
  await fs.mkdir(dirs.relay, { mode: 0o700 });
  await fs.mkdir(path.join(hermesHome, 'profiles', 'coding'), { recursive: true });
  await fs.mkdir(dirs.downloads, { recursive: true });
  await fs.mkdir(dirs.tmux, { mode: 0o700 });
  await fs.writeFile(path.join(hermesHome, 'SOUL.md'), 'Alma de prueba\n');
  await fs.writeFile(path.join(hermesHome, 'profiles', 'coding', 'SOUL.md'), 'Alma de coding\n');
  const shells = path.join(root, 'shells');
  await fs.writeFile(shells, ['/bin/sh', '/bin/bash', '/usr/bin/bash'].join('\n'));

  const store = await createDeviceStore({ directory: dirs.relay });
  await store.mutate((draft) => {
    for (const [device, name] of [[PHONE, 'phone'], [TABLET, 'tablet']] as const) {
      draft.devices.push({ id: device.id, name, pairedAt: Date.now(), revokedAt: null, keyHash: hashDeviceKey(device.key).toString('hex') });
    }
  });

  /** Every line any Puente of this lab and the supervisor wrote: the logs a person would read. */
  const logs: string[] = [];
  const supervisorOutput: string[] = [];
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await run('systemctl', ['--user', 'stop', `${tag}*`]).catch(() => {});
    await run('systemctl', ['--user', 'reset-failed', `${tag}*`]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    const { stdout } = await run('systemctl', ['--user', 'list-units', '--all', '--no-legend', `${tag}*`]).catch(() => ({ stdout: '' }));
    if (stdout.trim()) throw new Error(`test units left behind: ${stdout}`);
  });

  let supervisor: ChildProcess | null = null;
  /** relay-supervisor as its unit runs it; the Puente reaches it through its private socket. */
  async function startSupervisor() {
    await fs.rm(path.join(dirs.runtime, SUPERVISOR_KEY_FILE), { force: true });
    const args = [SUPERVISOR, '--runtime', dirs.runtime, '--state', dirs.state, '--unit-prefix', tag, '--shells', shells, '--downloads', dirs.downloads];
    if (options.browser) args.push('--browser', options.browser);
    // Terminals inherit this environment: the lab's home, so no rc file or tmux server of the person is read.
    const child = spawn(process.execPath, args, { env: { ...process.env, HOME: dirs.home, TMUX_TMPDIR: dirs.tmux }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = Promise.withResolvers<void>();
    for (const output of [child.stdout!, child.stderr!]) {
      output.setEncoding('utf8');
      output.on('data', (text: string) => {
        supervisorOutput.push(...text.split('\n').filter(Boolean));
        if (text.includes('relay-supervisor listening')) ready.resolve();
      });
    }
    child.once('exit', (code) => ready.reject(new Error(`the supervisor exited with ${code}: ${supervisorOutput.join(' | ')}`)));
    await ready.promise;
    supervisor = child;
  }
  /** Its unit stopping: SIGTERM, and it closes its PTY masters. */
  async function stopSupervisor() {
    const child = supervisor;
    supervisor = null;
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  closers.push(stopSupervisor);
  await startSupervisor();

  const publisher = simulatedPublisher();
  const headers = (device: Device, capability: string) => ({ Authorization: `Bearer ${device.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': capability });

  /** One Puente process, wired as main.ts with RELAY_SUPERVISOR_DIR, RELAY_REMOTE_FILES=1 and RELAY_REMOTE_WEB=1. */
  async function puente(extra: PuenteOptions = {}) {
    const client = createSupervisorClient({ runtimeDirectory: dirs.runtime });
    const remote: RemoteTools = {
      environments: { capability: ENVIRONMENTS_CAPABILITY, port: client },
      terminal: { capability: TERMINAL_CAPABILITY, port: client },
      files: { capability: FILES_CAPABILITY, port: createRemoteFileSystem({ home: dirs.home, hermesHome, stateDirectory: dirs.relay, changeLog: store.changeLog }) },
      web: { capability: WEB_CAPABILITY, port: { apps: createLinuxSockets(), publisher } },
      browser: { capability: BROWSER_CAPABILITY, port: { dedicated: client.browser, habitual: extra.habitual ?? null } },
    };
    const hermes = new FakeHermes();
    const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
    const pairing = createPairing({ store, origin: async () => extra.listen?.origin ?? 'http://arch.example.ts.net:8650', serverName: 'arch' });
    const server = createApp({
      config: { corsOrigins: [] }, store, pairing,
      peerAddress: () => '100.64.0.1', hermes, runs, tailnet: extra.tailnet ?? { whois: async () => null }, hostname: 'arch', version: '9.9.9',
      now: extra.now, monotonic: extra.monotonic, timer: extra.timer, log: (line) => logs.push(line), remote,
    });
    const listening = Promise.withResolvers<void>();
    server.listen(extra.listen?.port ?? 0, extra.listen?.host ?? '127.0.0.1', listening.resolve);
    await listening.promise;
    const base = `http://${extra.listen?.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
    const streams: OutputStream[] = [];
    let closed = false;
    /** The Puente stopping: its connections and its supervisor channel go; the supervisor stays. */
    const close = () => {
      if (closed) return;
      closed = true;
      for (const stream of streams) stream.close();
      runs.close(); server.closeAllConnections(); server.close(); client.close();
    };
    closers.push(close);
    async function call(device: Device, method: string, route: string, body?: unknown, capability = 'environments/1') {
      const response = await fetch(base + route, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...headers(device, capability), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    }
    async function stream(device: Device, route: string, capability: string, lastEventId?: string) {
      const opened = await openStream(base + route, { ...headers(device, capability), ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) });
      streams.push(opened);
      return opened;
    }
    const inputSeqs = new Map<string, number>();
    return {
      base, call, close, client, stream, headers, pairing, hermes,
      health: async () => (await fetch(`${base}/health`)).json(),
      list: async (device: Device) => (await call(device, 'GET', '/v1/remote/environments')).json.environments as { id: string; kind: string; ownership: string; state: string; exitCode: number | null }[],
      openTerminal: async (device: Device, requestId: string, shell = '/bin/bash', cwd = dirs.home) => {
        const created = await call(device, 'POST', '/v1/remote/environments', { requestId, kind: 'terminal', shell, cwd });
        if (created.status !== 200 && created.status !== 201) throw new Error(`terminal not created: ${created.status} ${JSON.stringify(created.json)}`);
        return created.json.id as string;
      },
      terminate: (device: Device, id: string) => call(device, 'POST', `/v1/remote/environments/${id}/terminate`, { confirm: true }),
      output: (device: Device, id: string, lastEventId?: string) => stream(device, `/v1/remote/terminals/${id}/output`, 'terminal/1', lastEventId),
      /** Keys as the app sends them: raw bytes, the terminal's own input seq. */
      type: async (device: Device, id: string, text: string) => {
        const seq = (inputSeqs.get(id) ?? 0) + 1;
        inputSeqs.set(id, seq);
        return call(device, 'POST', `/v1/remote/terminals/${id}/input`, { seq, data: Buffer.from(text).toString('base64') }, 'terminal/1');
      },
      /** The app's view after a stream reopened: continue from the terminal's applied input seq. */
      resumeInput: (id: string, seq: number) => { inputSeqs.set(id, seq); },
      resize: (device: Device, id: string, cols: number, rows: number) => call(device, 'POST', `/v1/remote/terminals/${id}/resize`, { cols, rows }, 'terminal/1'),
      ack: (device: Device, id: string, channel: string, seq: number) => call(device, 'POST', `/v1/remote/terminals/${id}/ack`, { channel, seq }, 'terminal/1'),
      browser: (device: Device, method: string, route: string, body?: unknown) => call(device, method, `/v1/remote/browsers/${route}`, body, 'browser/1'),
      frames: (device: Device, id: string) => stream(device, `/v1/remote/browsers/${id}/frames`, 'browser/1'),
      upload: (device: Device, folder: string, name: string, bytes: Buffer) => uploadFile(base, headers(device, 'files/1'), folder, name, bytes),
      download: (device: Device, file: string) => downloadFile(base, headers(device, 'files/1'), file),
    };
  }

  const revoke = (device: Device) => store.mutate((draft) => { draft.devices.find((candidate) => candidate.id === device.id)!.revokedAt = Date.now(); });
  /** cgroup.procs of an environment's scope: what terminating must empty. */
  const scopeProcs = async (id: string) => {
    const cgroup = managerCgroup(await fs.readFile('/proc/self/cgroup', 'utf8'));
    const file = `/sys/fs/cgroup${cgroup}/app.slice/${tag}-${id}.scope/cgroup.procs`;
    return (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  };
  const changes = async () => (await fs.readFile(path.join(dirs.relay, 'changes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { action: string; actor: { kind: string; id?: string }; target: { kind: string; id?: string } });
  return { tag, dirs, hermesHome, store, publisher, logs, supervisorOutput, puente, revoke, scopeProcs, changes, startSupervisor, stopSupervisor, closers };
}
