// The habitual browser on the Puente's side (#93, ADR 0006 «Módulos», docs/relay-v3.md §6): a private
// Unix socket where the Relay extension's native messaging host (browserHost.ts) connects. The Puente
// asks and the extension answers; nothing the extension sends is ever a request or an authorization
// (#78 review H3: socket 0600 inside the Puente's state, the hello's origin checked against the
// installed extension, a second connection refused).
import { createHash, randomBytes } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { RemoteEnvironment, ToolAvailability } from '../../../protocol/protocol.ts';
import { BROWSER_DIALOG_TYPES, BROWSER_LIMITATIONS, BROWSER_LIMITS, browserUrl } from '../../../protocol/remoteBrowser.ts';
import type { BrowserAction, BrowserActionResult, BrowserDialogType, BrowserLimitation, BrowserTab, BrowserView } from '../../../protocol/remoteBrowser.ts';
import type { ChannelEvent, TerminalTarget } from '../../../protocol/supervisor.ts';
import type { ChangeRecord } from '../changeLog.ts';
import type { DeviceStore } from '../deviceStore.ts';
import type { BrowserController, HabitualBrowser } from './ports.ts';
import { RemoteError } from './routes.ts';

/**
 * The extension and the Puente each check the other speaks exactly this channel version. 2: a frame
 * answers its viewport in CSS pixels, a dialog its default prompt, and a prompt may be answered empty.
 * 3: a tab lists the file chooser Relay's tap opened, `files` fills it, and `downloads` hands over the
 * shared tabs' finished downloads.
 */
export const EXTENSION_PROTOCOL = 3;
/** Finished downloads the extension keeps until the Puente asks (bridge/extension/actions.js LIMITS.downloads). */
export const EXTENSION_DOWNLOADS = 20;
export const NATIVE_HOST_NAME = 'com.relay.browser';
/** Inside the Puente's state directory, 0700: the socket and the host wrapper the registration writes. */
export const BROWSER_DIRECTORY = 'browser';
export const EXTENSION_SOCKET_FILE = 'extension.sock';
export const HOST_WRAPPER_FILE = 'relay-browser-host';
/** A longer line from the host closes the connection. A frame is at most ≈933 000 base64 characters. */
export const EXTENSION_LINE_CHARS = 1_048_576;
/** Base64 of the largest frame (REMOTE_LIMITS.browserFrameBytes). */
const FRAME_CHARS = Math.ceil(700_000 / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Chrome's ID of an extension with a manifest `key`: SHA-256 of the key, first 32 hex digits mapped to a–p. */
export function extensionIdOf(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}
export const EXTENSION_DIRECTORY = new URL('../../extension/', import.meta.url);
/** The extension this Puente installs (bridge/extension): its ID is fixed by the manifest key. */
export const RELAY_EXTENSION_ID = extensionIdOf(JSON.parse(readFileSync(new URL('manifest.json', EXTENSION_DIRECTORY), 'utf8')).key);

/** What the extension answers when it cannot act, mapped to fixed remote errors; its text never travels. */
const FAILURES: Record<string, ConstructorParameters<typeof RemoteError>[0]> = {
  invalid: 'remote_invalid_request', not_shared: 'remote_not_found', limited: 'remote_browser_limited', no_chooser: 'remote_conflict',
  frame_too_large: 'remote_too_large', too_large: 'remote_too_large', frame_unavailable: 'remote_unavailable', failed: 'remote_unavailable',
};

export interface ExtensionLink extends HabitualBrowser { socketPath: string; close(): Promise<void> }

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * The extension's tab, rebuilt field by field as a public BrowserTab: a tab with anything more (cookies,
 * say) is refused, never passed on. The extension names tabs by number; the contract by string.
 */
function tab(value: unknown): BrowserTab | null {
  if (!plain(value) || !exact(value, ['tabId', 'title', 'url', 'createdByRelay', 'limitation', 'dialog', 'fileChooser'])) return null;
  const { tabId, title, url, createdByRelay, limitation, dialog, fileChooser } = value;
  if (!integer(tabId, 0, Number.MAX_SAFE_INTEGER) || typeof title !== 'string' || title.length > BROWSER_LIMITS.titleChars
    || typeof url !== 'string' || url.length > BROWSER_LIMITS.urlChars || typeof createdByRelay !== 'boolean') return null;
  if (limitation !== null && !BROWSER_LIMITATIONS.includes(limitation as never)) return null;
  if (dialog !== null && !(plain(dialog) && exact(dialog, ['type', 'message', 'defaultPrompt']) && BROWSER_DIALOG_TYPES.includes(dialog.type as never)
    && typeof dialog.message === 'string' && dialog.message.length <= BROWSER_LIMITS.textChars
    && typeof dialog.defaultPrompt === 'string' && dialog.defaultPrompt.length <= BROWSER_LIMITS.textChars)) return null;
  if (fileChooser !== null && !(plain(fileChooser) && exact(fileChooser, ['multiple']) && typeof fileChooser.multiple === 'boolean')) return null;
  return {
    id: String(tabId), url, title, limitation: limitation as BrowserLimitation | null, createdByRelay,
    dialog: dialog === null ? null : { type: dialog.type as BrowserDialogType, message: dialog.message as string, defaultPrompt: dialog.defaultPrompt as string },
    fileChooser: fileChooser === null ? null : { multiple: fileChooser.multiple as boolean },
  };
}

/** A finished download as the extension reports it: an absolute path of the Server and its last component. */
function download(value: unknown): { name: string; path: string } | null {
  if (!plain(value) || !exact(value, ['name', 'path'])) return null;
  const { name, path: file } = value;
  return typeof file === 'string' && file.startsWith('/') && !file.includes('\0') && file.isWellFormed() && Buffer.byteLength(file) <= BROWSER_LIMITS.pathBytes
    && typeof name === 'string' && name !== '' && name === path.basename(file) && Buffer.byteLength(name) <= 255
    ? { name, path: file } : null;
}

/** Each an existing regular file this account can read, as the dedicated browser's supervisor requires: what a chooser may be filled with. */
async function readableFiles(paths: string[]): Promise<void> {
  for (const file of paths) {
    let handle;
    try {
      // Non-blocking: a FIFO never holds the open.
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      throw new RemoteError((error as NodeJS.ErrnoException).code === 'EACCES' ? 'remote_permission_denied' : 'remote_not_found');
    }
    try {
      if (!(await handle.stat()).isFile()) throw new RemoteError('remote_invalid_request');
    } finally {
      await handle.close();
    }
  }
}

/** A public tab ID as the extension's tab number: anything else is a tab that does not exist. */
function tabNumber(id: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id))) throw new RemoteError('remote_not_found');
  return Number(id);
}

function actionResult(action: BrowserAction, value: unknown): BrowserActionResult | null {
  if (!plain(value)) return null;
  if (action.type === 'back' || action.type === 'forward') return exact(value, ['moved']) && typeof value.moved === 'boolean' ? { moved: value.moved } : null;
  return exact(value, []) ? {} : null;
}

function frameResult(value: unknown): { data: string; viewport: { width: number; height: number } } | null {
  if (!plain(value) || !exact(value, ['data', 'viewport'])) return null;
  const { data, viewport } = value;
  return typeof data === 'string' && data.length > 0 && data.length <= FRAME_CHARS && BASE64.test(data)
    && plain(viewport) && exact(viewport, ['width', 'height']) && integer(viewport.width, 1, BROWSER_LIMITS.coord) && integer(viewport.height, 1, BROWSER_LIMITS.coord)
    ? { data, viewport: { width: viewport.width, height: viewport.height } } : null;
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('The browser directory of the Puente must be a private directory of this user.');
  }
}

async function alive(file: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.createConnection(file);
  socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  return promise;
}

export async function listenExtension(options: {
  stateDirectory: string; extensionId?: string; log?: (line: string) => void; helloTimeoutMs?: number; requestTimeoutMs?: number;
}): Promise<ExtensionLink> {
  const directory = path.join(options.stateDirectory, BROWSER_DIRECTORY);
  const origin = `chrome-extension://${options.extensionId ?? RELAY_EXTENSION_ID}/`;
  const helloTimeoutMs = options.helloTimeoutMs ?? 5000;
  // Above the extension's own wait for a frame (Chromium can leave a capture unanswered).
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const log = options.log ?? (() => {});
  await privateDirectory(directory);
  const socketPath = path.join(directory, EXTENSION_SOCKET_FILE);
  if (await alive(socketPath)) throw new Error('Another Puente is already listening for the browser extension.');
  await fs.rm(socketPath, { force: true });

  /** The one connection, from its first byte: any other is refused while it lasts. */
  let current: net.Socket | null = null;
  let ready = false;
  let incompatible = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (line: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (current) {
      log('A second browser extension connection was refused.');
      socket.destroy();
      return;
    }
    current = socket;
    ready = false;
    const deadline = setTimeout(() => socket.destroy(), helloTimeoutMs);
    let buffer = '';
    socket.on('close', () => {
      clearTimeout(deadline);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new RemoteError('remote_unavailable')); }
      pending.clear();
      if (current === socket) { current = null; ready = false; }
    });
    // setEncoding keeps a UTF-8 character split between two reads whole.
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let line: unknown;
        try { line = JSON.parse(text); } catch { socket.destroy(); return; }
        if (!plain(line)) { socket.destroy(); return; }
        if (!ready) {
          // Chrome hands the host its caller's origin; only the extension this Puente installs is heard.
          if (!exact(line, ['type', 'extensionProtocol', 'origin']) || line.type !== 'hello' || line.origin !== origin) {
            log('A browser extension connection was refused.');
            socket.destroy();
            return;
          }
          if (line.extensionProtocol !== EXTENSION_PROTOCOL) {
            incompatible = true;
            log('A browser extension of another version was refused.');
            socket.destroy();
            return;
          }
          clearTimeout(deadline);
          ready = true;
          incompatible = false;
          log('Browser extension connected.');
          continue;
        }
        // Only answers to this Puente's own requests: anything else ends the connection.
        const entry = line.type === 'response' && typeof line.id === 'number' ? pending.get(line.id) : undefined;
        if (!entry) { socket.destroy(); return; }
        pending.delete(line.id as number);
        clearTimeout(entry.timer);
        entry.resolve(line);
      }
      if (buffer.length > EXTENSION_LINE_CHARS) socket.destroy();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  await fs.chmod(socketPath, 0o600);

  async function call(request: Record<string, unknown>): Promise<unknown> {
    const socket = current;
    if (!socket || !ready) throw new RemoteError('remote_unavailable');
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    // Without an answer the outcome is unknown: drop the connection, the extension reconnects.
    const timer = setTimeout(() => { pending.delete(id); reject(new RemoteError('remote_unavailable')); socket.destroy(); }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ id, ...request })}\n`);
    const response = await promise;
    if (response.ok === true && exact(response, ['type', 'id', 'ok', 'result'])) return response.result;
    const code = response.ok === false && typeof response.code === 'string' && Object.hasOwn(FAILURES, response.code) ? FAILURES[response.code]! : 'remote_unavailable';
    throw new RemoteError(code);
  }
  function invalidReply(): never {
    log('The browser extension sent an invalid reply.');
    throw new RemoteError('remote_unavailable');
  }

  let closing: Promise<void> | null = null;
  return {
    socketPath,
    async availability(): Promise<ToolAvailability> {
      if (current && ready) return { state: 'available' };
      if (incompatible) return { state: 'unavailable', reason: 'helper_incompatible' };
      // Registered for a browser (registerNativeHost) but not connected: the browser or the extension is not running.
      const registered = await fs.access(path.join(directory, HOST_WRAPPER_FILE)).then(() => true, () => false);
      return { state: 'unavailable', reason: registered ? 'helper_stopped' : 'not_configured' };
    },
    async tabs() {
      const result = await call({ op: 'tabs' });
      if (!Array.isArray(result) || result.length > BROWSER_LIMITS.habitualTabs) return invalidReply();
      const tabs = result.map(tab);
      return tabs.every((candidate) => candidate !== null) ? tabs as BrowserTab[] : invalidReply();
    },
    async open(url) {
      if (!browserUrl(url)) throw new RemoteError('remote_invalid_request');
      return tab(await call({ op: 'open', url })) ?? invalidReply();
    },
    async act(id, action) {
      const tabId = tabNumber(id);
      // Files of the Server, uploaded from the phone first with the files transfer (#87): the browser
      // reads them itself, so a path that is not a readable regular file never reaches it.
      if (action.type === 'files') await readableFiles(action.paths);
      return actionResult(action, await call({ op: 'act', tabId, action })) ?? invalidReply();
    },
    async frame(id, maxWidth, quality) {
      return frameResult(await call({ op: 'act', tabId: tabNumber(id), action: { type: 'frame', maxWidth, quality } })) ?? invalidReply();
    },
    async downloads() {
      const result = await call({ op: 'downloads' });
      if (!Array.isArray(result) || result.length > EXTENSION_DOWNLOADS) return invalidReply();
      const finished = result.map(download);
      return finished.every((candidate) => candidate !== null) ? finished as { name: string; path: string }[] : invalidReply();
    },
    async release() {
      // Nobody connected: the extension already let every tab go when its host lost the Puente.
      if (current && ready) await call({ op: 'release' });
    },
    /** Once: a second call never removes a socket another Puente has taken since. */
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        await closed.promise;
        await fs.rm(socketPath, { force: true });
      })();
      return closing;
    },
  };
}

/** Where each browser keeps its user-level native messaging hosts, under XDG_CONFIG_HOME. */
export const NATIVE_HOST_BROWSERS: Record<string, string> = {
  'google-chrome': 'google-chrome', chromium: 'chromium', 'chrome-for-testing': 'google-chrome-for-testing',
};

const shellQuoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function writeAtomically(file: string, content: string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, content, { mode, flag: 'wx' });
  await fs.rename(temporary, file);
}

/**
 * Registers the native messaging host for one browser: the wrapper inside the Puente's private browser
 * directory (it names the node binary, the host and the socket) and the browser's host manifest, which
 * lets only the Relay extension start it. Loading the extension itself is a step at the computer.
 */
export async function registerNativeHost(options: { stateDirectory: string; configHome: string; browser: string; nodePath: string; extensionId?: string }) {
  if (!Object.hasOwn(NATIVE_HOST_BROWSERS, options.browser)) throw new Error('Unknown browser.');
  const directory = path.join(options.stateDirectory, BROWSER_DIRECTORY);
  await privateDirectory(directory);
  const wrapper = path.join(directory, HOST_WRAPPER_FILE);
  const host = new URL('./browserHost.ts', import.meta.url).pathname;
  await writeAtomically(wrapper, `#!/bin/sh\nexec ${shellQuoted(options.nodePath)} ${shellQuoted(host)} ${shellQuoted(path.join(directory, EXTENSION_SOCKET_FILE))} "$@"\n`, 0o700);
  const hosts = path.join(options.configHome, NATIVE_HOST_BROWSERS[options.browser]!, 'NativeMessagingHosts');
  await fs.mkdir(hosts, { recursive: true, mode: 0o700 });
  const manifest = path.join(hosts, `${NATIVE_HOST_NAME}.json`);
  const extensionId = options.extensionId ?? RELAY_EXTENSION_ID;
  await writeAtomically(manifest, `${JSON.stringify({
    name: NATIVE_HOST_NAME, description: 'Relay: adaptador local entre la extensión y el Puente', path: wrapper, type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`, 0o600);
  return { manifest, wrapper, extensionId, extensionDirectory: EXTENSION_DIRECTORY.pathname };
}

type Actor = ChangeRecord['actor'];
interface Session { id: string; deviceId: string; requestId: string; createdAt: number; endedAt: number | null }
/** A connection's open stream: its view, the frame waiting for an ack and the last tab list it sent. */
interface Watch { session: Session; channel: string; view: BrowserView | null; seq: number; awaiting: number | null; busy: boolean; tabs: string; timer: NodeJS.Timeout | undefined }

/** The extension's widest frame (bridge/extension/actions.js LIMITS.frameMaxWidth) and its narrowest. */
const FRAME_WIDTH = { min: 64, max: 1600 } as const;

/**
 * Each device's connection to the habitual browser: an environment of kind 'browser_habitual' and
 * ownership 'shared', kept in memory (a Puente restart forgets it; the device connects again and the
 * extension still holds the person's choice). Ending one, by the device or by its revocation, ends its
 * stream, releases the extension's debuggers and keeps the browser and all its tabs. Its tabs, actions
 * and stream are the same BrowserController as a dedicated browser's (browsers.ts).
 */
export interface HabitualSessions extends BrowserController {
  has(id: string): boolean;
  list(deviceId: string): RemoteEnvironment[];
  create(deviceId: string, actor: Actor, requestId: string, guard: () => void): Promise<RemoteEnvironment>;
  terminate(deviceId: string, actor: Actor, id: string, guard: () => void): Promise<RemoteEnvironment>;
  discard(deviceId: string, actor: Actor, id: string, guard: () => void): Promise<{ ok: true }>;
  close(): void;
}

export function createHabitualSessions(options: {
  browser: HabitualBrowser; store: DeviceStore; now: () => number; log?: (line: string) => void;
  /** After a frame that failed, the next try; it also notices a limitation that cleared. */
  retryMs?: number;
}): HabitualSessions {
  const { browser, store, now } = options;
  const log = options.log ?? (() => {});
  const retryMs = options.retryMs ?? 1000;
  const sessions = new Map<string, Session>();
  /** One stream per connection, by session ID: another attach replaces it. */
  const watches = new Map<string, Watch>();
  const channelListeners: ((event: ChannelEvent) => void)[] = [];
  const emit = (event: ChannelEvent) => { for (const listener of channelListeners) listener(event); };

  const record = (actor: Actor, action: string, id: string) => store.changeLog.appendChange({ actor, action, target: { kind: 'environment', id } });
  const publicOf = (session: Session): RemoteEnvironment => ({
    id: session.id, kind: 'browser_habitual', ownership: 'shared', createdAt: session.createdAt,
    state: session.endedAt === null ? 'running' : 'exited', exitCode: null, endedAt: session.endedAt,
  });
  function own(deviceId: string, id: string): Session {
    const session = sessions.get(id);
    if (!session || session.deviceId !== deviceId) throw new RemoteError('remote_not_found');
    return session;
  }
  function live(target: TerminalTarget): Session {
    const session = own(target.deviceId, target.environmentId);
    if (session.endedAt !== null) throw new RemoteError('remote_ended');
    return session;
  }
  function watching(target: TerminalTarget, channel: string): Watch {
    const watch = watches.get(live(target).id);
    if (!watch || watch.channel !== channel) throw new RemoteError('remote_not_found');
    return watch;
  }
  function stop(watch: Watch, reason: 'replaced' | 'exited' | null): void {
    if (watches.get(watch.session.id) !== watch) return;
    clearTimeout(watch.timer);
    watches.delete(watch.session.id);
    if (reason) emit({ channel: watch.channel, type: 'closed', reason });
  }

  /**
   * The whole list again whenever it changed: a dialog, a file chooser, a limitation, a title, a tab
   * gone. Then the shared tabs' finished downloads, to every open stream: the browser is one for all
   * devices, and the extension hands each download over once.
   */
  async function sendTabs(watch: Watch): Promise<void> {
    const tabs = await browser.tabs().catch(() => null);
    if (tabs && watches.get(watch.session.id) === watch) {
      const text = JSON.stringify(tabs);
      if (text !== watch.tabs) {
        watch.tabs = text;
        emit({ channel: watch.channel, type: 'tabs', tabs });
      }
    }
    for (const { name, path: file } of await browser.downloads().catch(() => [])) {
      for (const open of watches.values()) emit({ channel: open.channel, type: 'download', name, path: file });
    }
  }

  /**
   * The next frame of the tab in view, once the previous one was acked: the extension captures one when
   * asked, so frames never queue. A frame that fails is tried again later; one over the limit is dropped
   * until the phone asks for a smaller view.
   */
  async function pull(watch: Watch): Promise<void> {
    const view = watch.view;
    if (!view || watch.busy || watch.awaiting !== null || watches.get(watch.session.id) !== watch) return;
    watch.busy = true;
    clearTimeout(watch.timer);
    try {
      const maxWidth = Math.min(FRAME_WIDTH.max, Math.max(FRAME_WIDTH.min, view.width * view.scale));
      const { data, viewport } = await browser.frame(view.tab, maxWidth, view.quality);
      if (watches.get(watch.session.id) === watch && watch.view === view) {
        watch.awaiting = ++watch.seq;
        emit({ channel: watch.channel, type: 'frame', seq: watch.seq, tab: view.tab, data, viewport });
      }
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'remote_too_large') {
        if (watch.view === view) watch.view = null;
        emit({ channel: watch.channel, type: 'oversized', tab: view.tab });
      } else if (watches.get(watch.session.id) === watch) {
        // ponytail: a fixed retry while the stream lasts; back off if a lost extension costs too much.
        watch.timer = setTimeout(() => void pull(watch), retryMs);
      }
    } finally {
      watch.busy = false;
    }
    await sendTabs(watch);
    // The phone changed the view meanwhile: that frame was dropped, the new one goes now.
    if (watch.view !== view) void pull(watch);
  }

  async function end(session: Session, actor: Actor): Promise<void> {
    if (session.endedAt !== null) return;
    session.endedAt = now();
    const watch = watches.get(session.id);
    if (watch) stop(watch, 'exited');
    const ended = [...sessions.values()].filter((candidate) => candidate.deviceId === session.deviceId && candidate.endedAt !== null);
    for (const old of ended.slice(0, Math.max(0, ended.length - REMOTE_LIMITS.endedEnvironmentsPerDevice))) sessions.delete(old.id);
    // Disconnect, never close: the extension detaches its debuggers and every tab stays.
    await browser.release().catch(() => log('The browser extension could not be released.'));
    await record(actor, 'remote.browser.disconnected', session.id).catch(() => log('Browser change could not be recorded.'));
  }

  // A revoked or removed device keeps no connection to the habitual browser.
  const unsubscribe = store.subscribe(() => {
    let active: Set<string>;
    try { active = new Set(store.snapshot().devices.filter((device) => device.revokedAt === null).map((device) => device.id)); } catch { return; }
    for (const session of sessions.values()) if (session.endedAt === null && !active.has(session.deviceId)) void end(session, { kind: 'server' });
  });

  return {
    has: (id) => sessions.has(id),
    list: (deviceId) => [...sessions.values()].filter((session) => session.deviceId === deviceId).map(publicOf),

    async create(deviceId, actor, requestId, guard) {
      const same = [...sessions.values()].find((session) => session.deviceId === deviceId && session.requestId === requestId);
      if (same) return publicOf(same);
      if ([...sessions.values()].some((session) => session.deviceId === deviceId && session.endedAt === null)) throw new RemoteError('remote_conflict');
      if ((await browser.availability()).state !== 'available') throw new RemoteError('remote_unavailable');
      const session: Session = { id: `env_${randomBytes(16).toString('base64url')}`, deviceId, requestId, createdAt: now(), endedAt: null };
      // In the index first, then the guard: a device revoked meanwhile never keeps it (ADR 0006 «Revocación»).
      sessions.set(session.id, session);
      try { guard(); } catch (error) { sessions.delete(session.id); throw error; }
      await record(actor, 'remote.browser.connected', session.id);
      return publicOf(session);
    },

    async terminate(deviceId, actor, id, guard) {
      const session = own(deviceId, id);
      guard();
      await end(session, actor);
      return publicOf(session);
    },

    async discard(deviceId, actor, id, guard) {
      const session = own(deviceId, id);
      if (session.endedAt === null) throw new RemoteError('remote_conflict');
      guard();
      sessions.delete(id);
      await record(actor, 'remote.environment.discarded', id);
      return { ok: true };
    },

    availability: () => browser.availability(),

    async tabs(target) {
      live(target);
      return browser.tabs();
    },

    async openTab(target, url) {
      live(target);
      // Only a page: a blank tab of the person's browser would be one Relay cannot show yet.
      if (url === null) throw new RemoteError('remote_unsupported');
      return browser.open(url);
    },

    async closeTab(target) {
      live(target);
      // Relay never closes a tab of the person's browser, not even one it opened.
      throw new RemoteError('remote_unsupported');
    },

    async act(target, tab, action) {
      live(target);
      return browser.act(tab, action);
    },

    async attach(target, channel) {
      const session = live(target);
      const previous = watches.get(session.id);
      if (previous) stop(previous, 'replaced');
      const watch: Watch = { session, channel, view: null, seq: 0, awaiting: null, busy: false, tabs: '', timer: undefined };
      watches.set(session.id, watch);
      emit({ channel, type: 'opened', inputSeq: 0 });
      void sendTabs(watch);
    },

    async view(target, channel, view) {
      const watch = watching(target, channel);
      // Like the dedicated browser: a tab that is not listed, or one Relay cannot control, is refused here.
      const shown = (await browser.tabs()).find((candidate) => candidate.id === view.tab);
      if (!shown) throw new RemoteError('remote_not_found');
      if (shown.limitation) throw new RemoteError('remote_browser_limited');
      if (watches.get(watch.session.id) !== watch) throw new RemoteError('remote_not_found');
      watch.view = view;
      watch.awaiting = null;
      void pull(watch);
    },

    async ack(target, channel, seq) {
      const watch = watching(target, channel);
      if (watch.awaiting !== seq) return;
      watch.awaiting = null;
      void pull(watch);
    },

    async detach(target, channel) {
      const watch = watches.get(own(target.deviceId, target.environmentId).id);
      if (watch?.channel === channel) stop(watch, null);
    },

    onChannel(listener) { channelListeners.push(listener); },
    // The extension's link carries no stream of the phone's: a lost extension shows as frames that
    // stop and come back, and in availability.
    onDisconnected() {},

    close() {
      unsubscribe();
      for (const watch of [...watches.values()]) stop(watch, null);
    },
  };
}
