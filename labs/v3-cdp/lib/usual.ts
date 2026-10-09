// The "usual" browser of the lab: a test browser with the lab extension, its native host and a fake
// Puente listening on a Unix socket. The oracle (a CDP pipe) stands in for the person at the computer
// and for reading state; production has no such pipe into the usual browser.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachPage, launch, until, type Browser, type Page } from './browser.ts';

const LAB = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(LAB, 'extension');
const HOST_NAME = 'com.relay.lab';
/** 'flag': --load-extension. 'cdp': Extensions.loadUnpacked over the pipe (needs --enable-unsafe-extension-debugging). */
const LOAD = process.env.RELAY_LAB_EXT_LOAD === 'cdp' ? 'cdp' : 'flag';

/** Chrome derives an unpacked extension's ID from the manifest key: SHA-256 of the key, first 32 hex digits mapped to a-p. */
function extensionId() {
  const key = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')).key;
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Messages from the extension are untyped JSON; tests assert on the fields they use.
type Json = any;

export class Connection {
  #next = 1;
  #pending = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();
  #events: Json[] = [];
  #waiters = new Set<{ match(e: Json): boolean; resolve(e: Json): void }>();
  #socket: Socket;

  constructor(socket: Socket, onHello: (hello: Json) => void) {
    this.#socket = socket;
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.event === 'hello') return onHello(msg);
      if (msg.event) {
        this.#events.push(msg);
        for (const w of this.#waiters) if (w.match(msg)) (this.#waiters.delete(w), w.resolve(msg));
        return;
      }
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.result);
      else p?.reject(new Error(msg.error));
    });
  }

  request(message: Json, timeoutMs = 15_000) {
    const id = this.#next++;
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
    const timer = setTimeout(() => (this.#pending.delete(id), reject(new Error(`no reply to ${message.op} in ${timeoutMs} ms`))), timeoutMs);
    this.#pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    this.#socket.write(`${JSON.stringify({ ...message, id })}\n`);
    return promise;
  }

  /** Resolves with the first event, past or future, that matches. */
  event(match: (e: Json) => boolean, timeoutMs = 10_000) {
    const seen = this.#events.find(match);
    if (seen) return Promise.resolve(seen);
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
    const waiter = { match, resolve: (e: Json) => (clearTimeout(timer), resolve(e)) };
    const timer = setTimeout(() => (this.#waiters.delete(waiter), reject(new Error(`no matching event in ${timeoutMs} ms`))), timeoutMs);
    this.#waiters.add(waiter);
    return promise;
  }

  drop() {
    this.#socket.destroy();
  }
}

class FakePuente {
  #accepted: ((c: Connection) => void)[] = [];
  #hello = Promise.withResolvers<Json>();
  hello = this.#hello.promise;
  connection = this.nextConnection();
  server = createServer((socket) => {
    const conn = new Connection(socket, (h) => this.#hello.resolve(h));
    this.#accepted.shift()?.(conn);
  });
  socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  nextConnection() {
    const { promise, resolve } = Promise.withResolvers<Connection>();
    this.#accepted.push(resolve);
    return promise;
  }
}

export type Usual = {
  browser: Browser;
  home: string;
  extensionId: string;
  puente: FakePuente;
  /** The person opens a tab; returns its chrome.tabs id. */
  localTab(url: string): Promise<number>;
  /** The person shares a tab (stands in for the toolbar click). */
  userShares(tabId: number): Promise<void>;
  localTypes(tabId: number, text: string): Promise<void>;
  localNavigates(tabId: number, url: string): Promise<void>;
  localCloses(tabId: number): Promise<void>;
  /** Real DevTools window on the tab (Target.openDevTools stands in for F12; synthetic keys do not reach browser shortcuts). */
  localOpensDevtools(tabId: number): Promise<void>;
  evalInTab(tabId: number, expression: string): Promise<Json>;
  inWorker(expression: string): Promise<Json>;
  tabUrls(): Promise<string[]>;
  devtoolsCount(): Promise<number>;
  alive(): boolean;
  close(): Promise<void>;
};

async function evaluate(page: Page, expression: string) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

export async function launchUsual({ args = [] }: { args?: string[] } = {}): Promise<Usual> {
  const root = mkdtempSync(join(tmpdir(), 'relay-lab-usual-'));
  const profileDir = join(root, 'profile');
  const id = extensionId();
  const puente = new FakePuente(join(root, 'puente.sock'));
  puente.server.listen(puente.socketPath);
  await once(puente.server, 'listening');

  const wrapper = join(root, 'host.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(LAB, 'host/relay-lab-host.ts')}" "${puente.socketPath}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  mkdirSync(join(profileDir, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(
    join(profileDir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
    JSON.stringify({ name: HOST_NAME, description: 'Relay lab adapter', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }),
  );

  const dispose = () => {
    puente.server.close();
    rmSync(root, { recursive: true, force: true });
  };
  const browser = await launch({
    transport: 'pipe',
    mode: 'headful',
    profile: profileDir,
    args: [
      ...(LOAD === 'flag' ? [`--load-extension=${EXTENSION}`, `--disable-extensions-except=${EXTENSION}`] : ['--enable-unsafe-extension-debugging']),
      ...args,
    ],
  }).catch((error) => {
    dispose();
    throw error;
  });
  const cdp = browser.cdp;
  const close = async () => {
    await browser.close();
    dispose();
  };
  try {
    if (LOAD === 'cdp') {
      const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION });
      if (loaded.id !== id) throw new Error(`loaded ${loaded.id}, expected ${id}`);
    }
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error('no hello within 15 s')), 15_000);
    await Promise.race([puente.hello, timeout]).finally(() => clearTimeout(timer));
  } catch (error) {
    await close();
    throw new Error(`extension or native host did not come up: ${(error as Error).message}\n${browser.stderr().slice(-2000)}`);
  }

  const pages = new Map<string, Page>();
  const pageOf = async (targetId: string) => {
    if (!pages.has(targetId)) pages.set(targetId, await attachPage(cdp, targetId));
    return pages.get(targetId)!;
  };
  let worker: Page | null = null;
  const inWorker = async (expression: string) => {
    if (!worker) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const sw = targetInfos.find((t: Json) => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      worker = await attachPage(cdp, sw.targetId);
    }
    return evaluate(worker, expression);
  };
  const targetOf = async (tabId: number) =>
    (await inWorker(`chrome.debugger.getTargets().then((ts) => ts.find((t) => t.tabId === ${tabId})?.id)`)) as string;

  return {
    browser,
    home: browser.home,
    extensionId: id,
    puente,
    async localTab(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const page = await pageOf(targetId);
      await until(async () => (await evaluate(page, 'document.readyState')) === 'complete');
      return inWorker(`relayTabIdOf(${JSON.stringify(targetId)})`);
    },
    async userShares(tabId) {
      await inWorker(`relayShareTab(${tabId})`);
    },
    async localTypes(tabId, text) {
      await (await pageOf(await targetOf(tabId))).send('Input.insertText', { text });
    },
    async localNavigates(tabId, url) {
      await (await pageOf(await targetOf(tabId))).send('Page.navigate', { url });
    },
    async localCloses(tabId) {
      await cdp.send('Target.closeTarget', { targetId: await targetOf(tabId) });
    },
    async localOpensDevtools(tabId) {
      await cdp.send('Target.openDevTools', { targetId: await targetOf(tabId) });
    },
    async evalInTab(tabId, expression) {
      return evaluate(await pageOf(await targetOf(tabId)), expression);
    },
    inWorker,
    async tabUrls() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.filter((t: Json) => t.type === 'page').map((t: Json) => t.url);
    },
    async devtoolsCount() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.filter((t: Json) => t.url.startsWith('devtools://')).length;
    },
    alive: () => browser.proc.exitCode === null && browser.proc.signalCode === null,
    close,
  };
}
