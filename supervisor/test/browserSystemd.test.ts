// A real Chrome or Chromium as a dedicated browser (#92, pending H4 of #78): inside its environment's
// scope, on the CDP pipe the supervisor holds (no debugging port), with its own profile and HOME, kept
// across Puente reconnections, ended with its environment and lost when the supervisor stops. Pages
// are synthetic, served on 127.0.0.1 with an ephemeral port. Skipped, with the reason, without a
// systemd user manager or a browser (RELAY_TEST_BROWSER, or chromium / google-chrome-stable on PATH).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SUPERVISOR_KEY_FILE } from '../../protocol/supervisor.ts';
import { managerCgroup } from '../src/systemdHost.ts';
import { auth, connect, type Line } from '../support/rawClient.ts';

const run = promisify(execFile);
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const DEVICE = '00000000-0000-4000-8000-000000000001';
const TAG = `relay-test-${randomBytes(4).toString('hex')}`;
const CHANNEL = 'b'.repeat(22);

function findBrowser(): string | null {
  if (process.env.RELAY_TEST_BROWSER) return process.env.RELAY_TEST_BROWSER;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/google-chrome-stable']) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}
const BROWSER = findBrowser();

async function skipReason(): Promise<string | false> {
  try { await run('systemctl', ['--user', 'show-environment'], { timeout: 3000 }); } catch { return 'no systemd user manager in this session'; }
  if (!managerCgroup(await fs.readFile('/proc/self/cgroup', 'utf8'))) return 'this process is not under the systemd user manager (cgroup v2)';
  if (!BROWSER) return 'no Chrome or Chromium: set RELAY_TEST_BROWSER';
  return false;
}
const skip = await skipReason();

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-real-'));
after(async () => {
  await run('systemctl', ['--user', 'stop', `${TAG}*`]).catch(() => {});
  await run('systemctl', ['--user', 'reset-failed', `${TAG}*`]).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  const { stdout } = await run('systemctl', ['--user', 'list-units', '--all', '--no-legend', `${TAG}*`]).catch(() => ({ stdout: '' }));
  assert.equal(stdout.trim(), '', 'no test unit is left behind');
});

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}
const alive = (pid: number) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z'; } catch { return false; } };
const scope = (id: string) => `/sys/fs/cgroup${managerCgroup(readFileSync('/proc/self/cgroup', 'utf8'))}/app.slice/${TAG}-${id}.scope/cgroup.procs`;
const procs = async (id: string) => (await fs.readFile(scope(id), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);

/** Inodes of the TCP sockets in LISTEN state, from the kernel's socket tables. */
function listeningInodes(): Set<string> {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A') inodes.add(fields[9]!);
    }
  }
  return inodes;
}
function socketInodes(pid: number): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ''; } })
      .map((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1]).filter((inode): inode is string => inode !== undefined);
  } catch { return []; }
}

/** The pages: a field, a download, an alert and a file chooser at fixed places, and what they report. */
async function site() {
  const seen: string[] = [];
  const cookies: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    cookies.push(req.headers.cookie ?? '');
    if (url.pathname === '/file') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="informe.txt"' }); res.end('descargado'); return; }
    if (url.pathname !== '/') { seen.push(`${url.pathname} ${url.searchParams.get('v') ?? ''}`); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'session=dedicated; Max-Age=3600; Path=/' });
    res.end(`<!doctype html><meta charset=utf-8><style>body{margin:0}*{position:absolute;left:0;width:200px;height:40px;margin:0}</style>
<input id=t style=top:0 oninput="fetch('/typed?v='+encodeURIComponent(this.value))">
<a id=dl style=top:50px href=/file download>bajar</a>
<button style=top:100px onclick="fetch('/answer?v='+confirm('¿Seguro?'))">preguntar</button>
<input type=file id=f style=top:150px onchange="fetch('/picked?v='+this.files[0].name)">`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen, cookies };
}

/** A Puente on the supervisor socket: responses by ID, channel lines collected. */
async function puente(runtime: string) {
  for (let attempt = 0; ; attempt++) {
    const key = await fs.readFile(path.join(runtime, SUPERVISOR_KEY_FILE), 'utf8').catch(() => '');
    const client = connect(runtime);
    if ((await client.next())?.type === 'hello') {
      client.send(auth(key));
      if ((await client.next())?.type === 'ready') {
        const channel: Line[] = [];
        const responses = new Map<number, Line>();
        let next = 1;
        void (async () => {
          for (let line = await client.next(); line; line = await client.next()) {
            if (line.type === 'response') responses.set(line.id as number, line);
            else if (typeof line.channel === 'string') channel.push(line);
          }
        })();
        const ask = async (operation: Record<string, unknown>) => {
          const id = next++;
          client.send({ ...operation, id });
          await until(() => responses.has(id), `answer to ${String(operation.op)}`, 30_000);
          return responses.get(id)!;
        };
        return { ask, channel, close: () => client.socket.destroy() };
      }
    }
    client.socket.destroy();
    if (attempt > 100) throw new Error('the supervisor did not answer');
    await sleep(100);
  }
}

test('a real dedicated browser: own scope and profile, pipe only, kept across Puentes, ended with its environment', { skip, timeout: 120_000 }, async () => {
  const pages = await site();
  const runtime = path.join(root, 'run');
  const state = path.join(root, 'state');
  const downloads = path.join(root, 'Downloads');
  const upload = path.join(root, 'subida.txt');
  await fs.writeFile(upload, 'x');
  const start = (n: number) => run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${TAG}-supervisor-${n}`, process.execPath, MAIN,
    '--runtime', runtime, '--state', state, '--unit-prefix', TAG, '--browser', BROWSER!, '--downloads', downloads]);
  // The account's own browser, as a stand-in: another Chromium on another profile, outside any environment.
  const habitualProfile = await fs.mkdtemp(path.join(root, 'habitual-'));
  const habitual = spawn(BROWSER!, ['--headless', `--user-data-dir=${habitualProfile}`, '--no-first-run', 'about:blank'], { detached: true, stdio: 'ignore' });
  habitual.unref();
  after(() => { try { process.kill(-habitual.pid!, 'SIGKILL'); } catch { /* gone */ } });

  await start(1);
  let bridge = await puente(runtime);
  const env = { id: 'env_browserAAAAAAAAAAAAAAA', deviceId: DEVICE, kind: 'browser_dedicated', requestId: 'request-browser-1', createdAt: Date.now() };
  const target = { environmentId: env.id, deviceId: DEVICE };
  assert.equal((await bridge.ask({ op: 'register', environment: env })).ok, true);
  assert.partialDeepStrictEqual(await bridge.ask({ op: 'launch', environmentId: env.id }), { ok: true, environment: { state: 'running' } });

  // Every process of the browser is in the environment's scope; none listens on TCP; it runs on the
  // pipe, its own profile and its own HOME.
  const pids = await procs(env.id);
  assert.ok(pids.length > 1, 'the browser and its children run in the scope');
  const unitCgroup = (await run('systemctl', ['--user', 'show', '-P', 'ControlGroup', `${TAG}-supervisor-1.service`])).stdout.trim();
  for (const pid of pids) assert.notEqual(readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().replace(/^0::/, ''), unitCgroup);
  const listening = listeningInodes();
  for (const pid of pids) assert.deepEqual(socketInodes(pid).filter((inode) => listening.has(inode)), [], `process ${pid} listens on TCP`);
  // A page can take this much memory and this many tasks, never the Server's.
  const scopeDirectory = path.dirname(scope(env.id));
  assert.deepEqual([readFileSync(`${scopeDirectory}/memory.max`, 'utf8').trim(), readFileSync(`${scopeDirectory}/pids.max`, 'utf8').trim()], [String(4 * 1024 ** 3), '2048']);
  // Chromium rewrites every command line into one string. The main process is the one without
  // --type=, besides its crash handler. It is in the scope: it did not move itself to a scope of its
  // own over the session bus.
  const cmdline = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  const main = pids.find((pid) => !cmdline(pid).includes('--type=') && !cmdline(pid).includes('crashpad'));
  assert.ok(main, 'the main browser process stays in the environment scope');
  const profile = path.join(state, 'browsers', DEVICE, 'profile');
  assert.ok(cmdline(main).includes(` --user-data-dir=${profile} `) && cmdline(main).includes(' --remote-debugging-pipe '), cmdline(main));
  // Nothing of the account's own browser configuration (a launcher flags file, its extensions).
  assert.ok(!/--load-extension|--password-store=gnome/.test(cmdline(main)), cmdline(main));
  for (const pid of pids) assert.ok(!cmdline(pid).includes('--remote-debugging-port'));
  // Its environment is overwritten with the command line; the crash database shows its own config home.
  assert.ok(pids.some((pid) => cmdline(pid).includes(`--database=${path.join(state, 'browsers', DEVICE, 'home', '.config')}/`)));

  // Tabs, a view with real frames, input at the coordinates of the page.
  const tab = ((await bridge.ask({ op: 'openTab', ...target, url: pages.url })).tab as { id: string }).id;
  await until(() => pages.cookies.length > 0, 'the page loaded');
  assert.equal((await bridge.ask({ op: 'attach', ...target, channel: CHANNEL, after: 0 })).ok, true);
  assert.equal((await bridge.ask({ op: 'view', ...target, channel: CHANNEL, view: { tab, width: 400, height: 600, scale: 1, quality: 50 } })).ok, true);
  await until(() => bridge.channel.some((line) => line.type === 'frame'), 'a frame');
  const frame = bridge.channel.find((line) => line.type === 'frame')!;
  assert.ok(Buffer.from(frame.data as string, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');
  assert.deepEqual(frame.viewport, { width: 400, height: 600 });
  assert.equal((await bridge.ask({ op: 'ack', ...target, channel: CHANNEL, seq: frame.seq })).ok, true);
  await bridge.ask({ op: 'act', ...target, tab, action: { type: 'tap', x: 20, y: 20 } });
  await bridge.ask({ op: 'act', ...target, tab, action: { type: 'text', text: 'ñ✓' } });
  await until(() => pages.seen.includes('/typed ñ✓'), 'typed into the field');

  // A confirm dialog is reported and answered from Relay.
  await bridge.ask({ op: 'act', ...target, tab, action: { type: 'tap', x: 20, y: 120 } });
  await until(() => bridge.channel.some((line) => line.type === 'tabs' && (line.tabs as { dialog: unknown }[]).some((each) => each.dialog !== null)), 'dialog');
  assert.equal((await bridge.ask({ op: 'act', ...target, tab, action: { type: 'tap', x: 1, y: 1 } })).code, 'conflict');
  assert.equal((await bridge.ask({ op: 'act', ...target, tab, action: { type: 'dialog', accept: true } })).ok, true);
  await until(() => pages.seen.includes('/answer true'), 'the answer reached the page');

  // A file chooser filled with a file of the Server; a download kept on the Server.
  await bridge.ask({ op: 'act', ...target, tab, action: { type: 'tap', x: 20, y: 170 } });
  await until(() => bridge.channel.some((line) => line.type === 'tabs' && (line.tabs as { fileChooser: unknown }[]).some((each) => each.fileChooser !== null)), 'file chooser');
  assert.equal((await bridge.ask({ op: 'act', ...target, tab, action: { type: 'files', paths: [upload] } })).ok, true);
  await until(() => pages.seen.includes('/picked subida.txt'), 'the page got the file');
  await bridge.ask({ op: 'act', ...target, tab, action: { type: 'tap', x: 20, y: 70 } });
  await until(() => bridge.channel.some((line) => line.type === 'download'), 'download');
  assert.partialDeepStrictEqual(bridge.channel.find((line) => line.type === 'download'), { name: 'informe.txt', path: path.join(downloads, 'informe.txt') });
  assert.equal(await fs.readFile(path.join(downloads, 'informe.txt'), 'utf8'), 'descargado');

  // The Puente goes away and comes back: the same process, the same tabs, nothing launched.
  bridge.close();
  bridge = await puente(runtime);
  assert.ok(((await bridge.ask({ op: 'tabs', ...target })).tabs as { url: string }[]).some((each) => each.url === pages.url));
  assert.equal(alive(main), true);

  // Terminating ends every process of the browser and nothing else; the profile stays.
  assert.partialDeepStrictEqual(await bridge.ask({ op: 'terminate', environmentId: env.id }), { ok: true, environment: { state: 'exited' } });
  for (const pid of pids) assert.equal(alive(pid), false, `browser process ${pid}`);
  assert.equal(alive(habitual.pid!), true, 'the account\'s own browser is untouched');
  await fs.access(profile);

  // The device's next browser opens on the same profile: its login (cookie) is still there.
  const again = { ...env, id: 'env_browserBBBBBBBBBBBBBBB', requestId: 'request-browser-2' };
  await bridge.ask({ op: 'register', environment: again });
  assert.partialDeepStrictEqual(await bridge.ask({ op: 'launch', environmentId: again.id }), { ok: true, environment: { state: 'running' } });
  const count = pages.cookies.length;
  await bridge.ask({ op: 'openTab', environmentId: again.id, deviceId: DEVICE, url: pages.url });
  await until(() => pages.cookies.length > count, 'reloaded');
  assert.ok(pages.cookies.slice(count).includes('session=dedicated'));

  // Stopping the supervisor closes the pipe and the browser ends; at the next start it is lost and
  // nothing is relaunched.
  const secondPids = await procs(again.id);
  bridge.close();
  await run('systemctl', ['--user', 'stop', `${TAG}-supervisor-1.service`]);
  await until(() => secondPids.every((pid) => !alive(pid)), 'the browser ended with its pipe');
  await start(2);
  bridge = await puente(runtime);
  assert.partialDeepStrictEqual(((await bridge.ask({ op: 'list' })).environments as { id: string }[]).find((each) => each.id === again.id), { state: 'lost' });
  assert.deepEqual(await procs(again.id), []);
  bridge.close();
  await run('systemctl', ['--user', 'stop', `${TAG}-supervisor-2.service`]);
});
