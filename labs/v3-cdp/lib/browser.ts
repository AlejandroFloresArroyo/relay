// Launches a test browser with an ephemeral HOME and profile, and speaks CDP over the pipe or the port.
import { once } from 'node:events';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

const LAB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFT_VERSION: string = JSON.parse(readFileSync(join(LAB, 'package.json'), 'utf8')).config.chrome;

function systemVersion(path: string) {
  return execFileSync(path, ['--version'], { encoding: 'utf8' }).match(/(\d+\.\d+\.\d+\.\d+)/)![1];
}

const CONFIGS = {
  cft: () => ({ path: join(LAB, `.browsers/chrome/linux-${CFT_VERSION}/chrome-linux64/chrome`), version: CFT_VERSION }),
  chromium: () => ({ path: '/usr/bin/chromium', version: systemVersion('/usr/bin/chromium') }),
  chrome: () => ({ path: '/usr/bin/google-chrome-stable', version: systemVersion('/usr/bin/google-chrome-stable') }),
};
const name = (process.env.RELAY_LAB_BROWSER ?? 'cft') as keyof typeof CONFIGS;
if (!CONFIGS[name]) throw new Error(`RELAY_LAB_BROWSER must be one of ${Object.keys(CONFIGS).join(', ')}`);
export const BROWSER = { name, ...CONFIGS[name]() };

export { sleep };

/** Polls `check` until it is truthy; real browsers expose no event for most of what the tests wait on. */
export async function until(check: () => Promise<unknown>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`until: timed out after ${timeoutMs} ms`);
    await sleep(100);
  }
}

// CDP results and events are untyped JSON from the browser; tests assert on the fields they use.
type Json = any;
type Message = { id?: number; method?: string; params?: Json; result?: Json; error?: { message: string }; sessionId?: string };

export class Cdp {
  #next = 1;
  #pending = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();
  #listeners = new Set<(m: Message) => void>();
  #write: (text: string) => void;
  #shut: () => void;
  closed = false;

  private constructor(write: (text: string) => void, shut: () => void) {
    this.#write = write;
    this.#shut = shut;
  }

  static pipe(out: Writable, input: Readable) {
    const cdp = new Cdp((text) => out.write(`${text}\0`), () => (out.destroy(), input.destroy()));
    let buffer = '';
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        cdp.#receive(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    input.on('close', () => cdp.#closed());
    input.on('error', () => cdp.#closed());
    return cdp;
  }

  static connect(url: string) {
    const { promise, resolve, reject } = Promise.withResolvers<Cdp>();
    const ws = new WebSocket(url);
    const cdp = new Cdp((text) => ws.send(text), () => ws.close());
    ws.onopen = () => resolve(cdp);
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    ws.onmessage = (e) => cdp.#receive(String(e.data));
    ws.onclose = () => cdp.#closed();
    return promise;
  }

  #receive(text: string) {
    const msg: Message = JSON.parse(text);
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    for (const fn of this.#listeners) fn(msg);
  }

  #closed() {
    this.closed = true;
    for (const p of this.#pending.values()) p.reject(new Error('CDP connection closed'));
    this.#pending.clear();
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(method: string, fn: (params: Json) => void, sessionId?: string) {
    const listener = (m: Message) => {
      if (m.method === method && m.sessionId === sessionId) fn(m.params);
    };
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitEvent(method: string, match: (params: Json) => boolean = () => true, timeoutMs = 10_000, sessionId?: string) {
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
    const off = this.on(
      method,
      (params) => {
        if (!match(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      },
      sessionId,
    );
    const timer = setTimeout(() => (off(), reject(new Error(`no ${method} within ${timeoutMs} ms`))), timeoutMs);
    return promise;
  }

  close() {
    this.#shut();
  }
}

export type Page = {
  targetId: string;
  send(method: string, params?: Json): Promise<Json>;
  on(method: string, fn: (params: Json) => void): () => void;
  waitEvent(method: string, match?: (params: Json) => boolean, timeoutMs?: number): Promise<Json>;
};

export async function attachPage(cdp: Cdp, targetId: string): Promise<Page> {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    targetId,
    send: (method, params = {}) => cdp.send(method, params, sessionId),
    on: (method, fn) => cdp.on(method, fn, sessionId),
    waitEvent: (method, match, timeoutMs) => cdp.waitEvent(method, match, timeoutMs, sessionId),
  };
}

export type LaunchOptions = {
  transport: 'pipe' | 'port';
  /** 'default' launches without --user-data-dir (the synthetic HOME's default profile); a path reuses that profile. */
  profile?: 'ephemeral' | 'default' | string;
  keepProfile?: boolean;
  /** 'headful' runs the full browser UI on an invisible surface (--ozone-platform=headless): no
   * separate headless profile, real windows and DevTools. */
  mode?: 'headless' | 'headful';
  args?: string[];
};

export type Browser = {
  proc: ChildProcess;
  /** Synthetic HOME; the usual config dirs and Downloads live under it. */
  home: string;
  /** '' when launched on the default profile. */
  profileDir: string;
  /** null with the pipe transport, or when the browser refused the port. */
  wsUrl: string | null;
  exited: Promise<number | null>;
  readonly cdp: Cdp;
  stderr(): string;
  newPage(url: string): Promise<Page>;
  reconnect(): Promise<Cdp>;
  close(): Promise<void>;
};

export async function launch(opts: LaunchOptions): Promise<Browser> {
  const root = mkdtempSync(join(tmpdir(), 'relay-lab-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const profile = opts.profile ?? 'ephemeral';
  const profileDir = profile === 'ephemeral' ? join(root, 'profile') : profile === 'default' ? '' : profile;
  const args = [
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    ...(opts.mode === 'headful' ? ['--ozone-platform=headless', '--window-size=1280,800'] : ['--headless']),
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    opts.transport === 'pipe' ? '--remote-debugging-pipe' : '--remote-debugging-port=0',
    ...(opts.args ?? []),
    'about:blank',
  ];
  const proc: ChildProcess = spawn(BROWSER.path, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') },
  });
  let stderr = '';
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (d: string) => (stderr += d));
  const exited = once(proc, 'exit').then(([code]) => code as number | null);

  let wsUrl: string | null = null;
  let cdp: Cdp;
  if (opts.transport === 'pipe') {
    cdp = Cdp.pipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  } else {
    await until(async () => /DevTools listening on|remote debugging|non-default/i.test(stderr) || proc.exitCode !== null, 10_000).catch(() => {});
    wsUrl = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? null;
    cdp = wsUrl ? await Cdp.connect(wsUrl) : Cdp.pipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  }

  return {
    proc,
    home,
    profileDir,
    wsUrl,
    exited,
    get cdp() {
      return cdp;
    },
    stderr: () => stderr,
    async newPage(url: string) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const page = await attachPage(cdp, targetId);
      await until(async () => (await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value === 'complete');
      return page;
    },
    async reconnect() {
      if (!wsUrl) throw new Error('reconnect needs the port transport');
      cdp = await Cdp.connect(wsUrl);
      return cdp;
    },
    async close() {
      cdp.close();
      if (proc.exitCode === null && proc.signalCode === null) {
        process.kill(-proc.pid!, 'SIGTERM');
        await Promise.race([exited, sleep(5000)]);
        if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid!, 'SIGKILL');
      }
      await exited;
      rmSync(opts.keepProfile ? home : root, { recursive: true, force: true });
    },
  };
}
