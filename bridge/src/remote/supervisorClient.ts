// The Puente's side of the supervisor channel (protocol/supervisor.ts). The supervisor is another
// systemd user unit: this client never starts, restarts nor kills it, because it holds live PTYs.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { REMOTE_ID_PATTERN } from '../../../protocol/protocol.ts';
import type { RemoteUnavailableReason, ToolAvailability } from '../../../protocol/protocol.ts';
import { TERMINAL_CHANNEL_PATTERN } from '../../../protocol/remoteTerminal.ts';
import type { TerminalShells } from '../../../protocol/remoteTerminal.ts';
import { BROWSER_LIMITS, BROWSER_TAB_PATTERN, validBrowserTab } from '../../../protocol/remoteBrowser.ts';
import type { BrowserTab } from '../../../protocol/remoteBrowser.ts';
import {
  BROWSER_SUPERVISOR_PROTOCOL, MIN_SUPERVISOR_PROTOCOL, PUENTE_SUPERVISOR_PROTOCOL, SUPERVISOR_KEY_FILE, SUPERVISOR_LINE_BYTES, SUPERVISOR_SOCKET_FILE,
  validEnvironmentRecord, validTerminalPath,
} from '../../../protocol/supervisor.ts';
import type { ChannelEvent, EnvironmentRecord, RegisterInput, SupervisorErrorCode, SupervisorEvent, SupervisorOperation, TerminalTarget } from '../../../protocol/supervisor.ts';
import type { BrowserController, PtyHost, Supervisor } from './ports.ts';

const SUPERVISOR_REASONS: readonly RemoteUnavailableReason[] = ['unsupported_platform', 'dependency_missing'];
const EVENT_ACTIONS: readonly SupervisorEvent['action'][] = ['terminated', 'terminate_failed', 'lost', 'discarded'];
const seq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const size = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tabId = (value: unknown): value is string => typeof value === 'string' && new RegExp(BROWSER_TAB_PATTERN).test(value);

/** Exactly a channel line; anything else ends the connection. */
function channelEvent(line: Record<string, unknown>): ChannelEvent | null {
  const { channel, type } = line;
  if (typeof channel !== 'string' || !new RegExp(TERMINAL_CHANNEL_PATTERN).test(channel)) return null;
  const keys = Object.keys(line).sort().join();
  if (type === 'opened' && keys === 'channel,inputSeq,type' && seq(line.inputSeq)) return { channel, type, inputSeq: line.inputSeq };
  if (type === 'output' && keys === 'channel,data,seq,type' && seq(line.seq) && typeof line.data === 'string') return { channel, type, seq: line.seq, data: line.data };
  if (type === 'gap' && keys === 'channel,from,to,type' && seq(line.from) && seq(line.to)) return { channel, type, from: line.from, to: line.to };
  if (type === 'closed' && keys === 'channel,reason,type' && (line.reason === 'replaced' || line.reason === 'exited')) return { channel, type, reason: line.reason };
  // Browser streams.
  if (type === 'frame' && keys === 'channel,data,seq,tab,type,viewport' && seq(line.seq) && typeof line.data === 'string' && tabId(line.tab)
    && plain(line.viewport) && Object.keys(line.viewport).sort().join() === 'height,width' && size(line.viewport.width) && size(line.viewport.height)) {
    return { channel, type, seq: line.seq, tab: line.tab, data: line.data, viewport: { width: line.viewport.width, height: line.viewport.height } };
  }
  if (type === 'oversized' && keys === 'channel,tab,type' && tabId(line.tab)) return { channel, type, tab: line.tab };
  if (type === 'tabs' && keys === 'channel,tabs,type' && Array.isArray(line.tabs) && line.tabs.length <= BROWSER_LIMITS.dedicatedTabs && line.tabs.every(validBrowserTab)) {
    return { channel, type, tabs: line.tabs };
  }
  if (type === 'download' && keys === 'channel,name,path,type' && typeof line.name === 'string' && typeof line.path === 'string') return { channel, type, name: line.name, path: line.path };
  return null;
}

/** No answer: socket missing, refused, closed or timed out. Never carries the system error text. */
export class SupervisorUnreachable extends Error {
  reason: 'helper_stopped' | 'helper_incompatible';
  constructor(reason: SupervisorUnreachable['reason'] = 'helper_stopped') {
    super('The supervisor is not reachable.');
    this.reason = reason;
  }
}

/** The supervisor answered and refused the operation. */
export class SupervisorRejected extends Error {
  code: SupervisorErrorCode;
  constructor(code: SupervisorErrorCode) {
    super(code);
    this.code = code;
  }
}

interface Connection {
  availability: ToolAvailability;
  /** The supervisor's channel version: browsers need BROWSER_SUPERVISOR_PROTOCOL. */
  version: number;
  send(request: SupervisorOperation): Promise<Record<string, unknown>>;
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The key, only from a private regular file of this user in a private directory. */
async function readKey(directory: string): Promise<string> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new SupervisorUnreachable('helper_incompatible');
  const handle = await fs.open(path.join(directory, SUPERVISOR_KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new SupervisorUnreachable('helper_incompatible');
    return (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
}

export interface SupervisorClient extends Supervisor, PtyHost { browser: BrowserController; close(): void }

export function createSupervisorClient(options: { runtimeDirectory: string; timeoutMs?: number; requestTimeoutMs?: number }): SupervisorClient {
  const timeoutMs = options.timeoutMs ?? 3000;
  // Above terminateGiveUpMs: a termination answers within it.
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  let connection: Promise<Connection> | null = null;
  let current: net.Socket | null = null;
  const connectedListeners: (() => void)[] = [];
  const eventListeners: ((event: SupervisorEvent) => void)[] = [];
  const channelListeners: ((event: ChannelEvent) => void)[] = [];
  const disconnectedListeners: (() => void)[] = [];

  async function open(): Promise<Connection> {
    let key: string;
    try { key = await readKey(options.runtimeDirectory); } catch (error) { throw error instanceof SupervisorUnreachable ? error : new SupervisorUnreachable(); }
    const socket = net.createConnection(path.join(options.runtimeDirectory, SUPERVISOR_SOCKET_FILE));
    const pending = new Map<number, { resolve: (line: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let nextId = 1;
    let buffer = '';
    const handshake = Promise.withResolvers<ToolAvailability>();
    let stage: 'hello' | 'ready' | 'open' = 'hello';
    let supervisorVersion = 0;
    const deadline = setTimeout(() => { handshake.reject(new SupervisorUnreachable()); socket.destroy(); }, timeoutMs);

    const fail = (error: SupervisorUnreachable) => { handshake.reject(error); socket.destroy(); };
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(deadline);
      handshake.reject(new SupervisorUnreachable());
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new SupervisorUnreachable()); }
      pending.clear();
      if (current === socket) {
        current = null;
        connection = null;
        for (const listener of disconnectedListeners) listener();
      }
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
        if (stage === 'hello') {
          // ADR 0002 rules, applied to the supervisor's version before the key leaves this process.
          if (line.type !== 'hello' || !version(line.supervisorProtocol) || !version(line.minPuenteProtocol)) return fail(new SupervisorUnreachable('helper_incompatible'));
          if (line.supervisorProtocol < MIN_SUPERVISOR_PROTOCOL || PUENTE_SUPERVISOR_PROTOCOL < line.minPuenteProtocol) return fail(new SupervisorUnreachable('helper_incompatible'));
          stage = 'ready';
          supervisorVersion = line.supervisorProtocol;
          socket.write(`${JSON.stringify({ type: 'auth', key, puenteProtocol: PUENTE_SUPERVISOR_PROTOCOL, minSupervisorProtocol: MIN_SUPERVISOR_PROTOCOL })}\n`);
        } else if (stage === 'ready') {
          const availability = plain(line.availability) ? line.availability : null;
          if (line.type === 'ready' && availability) {
            stage = 'open';
            clearTimeout(deadline);
            // Only the reasons the supervisor may give; anything else is an incompatible supervisor.
            handshake.resolve(availability.state === 'available' ? { state: 'available' }
              : { state: 'unavailable', reason: SUPERVISOR_REASONS.find((reason) => reason === availability.reason) ?? 'helper_incompatible' });
          } else {
            // A refused key is an installation that does not match this Puente.
            fail(new SupervisorUnreachable(line.type === 'refused' ? 'helper_incompatible' : 'helper_stopped'));
          }
        } else if (Object.hasOwn(line, 'channel')) {
          const event = channelEvent(line);
          if (!event) { socket.destroy(); return; }
          for (const listener of channelListeners) listener(event);
        } else if (line.type === 'event') {
          const action = EVENT_ACTIONS.find((candidate) => candidate === line.action);
          if (!action || typeof line.environmentId !== 'string' || !new RegExp(REMOTE_ID_PATTERN).test(line.environmentId)) { socket.destroy(); return; }
          for (const listener of eventListeners) listener({ type: 'event', action, environmentId: line.environmentId });
        } else if (line.type === 'response' && typeof line.id === 'number' && pending.has(line.id)) {
          const entry = pending.get(line.id)!;
          pending.delete(line.id);
          clearTimeout(entry.timer);
          entry.resolve(line);
        }
      }
      // Only what is left is an unfinished line: a long line and the next one in the same read are fine.
      if (buffer.length > SUPERVISOR_LINE_BYTES) socket.destroy();
    });

    const availability = await handshake.promise;
    current = socket;
    return {
      availability,
      version: supervisorVersion,
      send(request) {
        const id = nextId++;
        const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
        // Without an answer the outcome is unknown: drop the connection and say so.
        const timer = setTimeout(() => { pending.delete(id); reject(new SupervisorUnreachable()); socket.destroy(); }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.write(`${JSON.stringify({ ...request, id })}\n`);
        return promise;
      },
    };
  }

  function connect(): Promise<Connection> {
    if (connection) return connection;
    const opening = open();
    connection = opening;
    opening.then(() => { for (const listener of connectedListeners) listener(); }, () => { if (connection === opening) connection = null; });
    return opening;
  }

  async function call(request: SupervisorOperation): Promise<Record<string, unknown>> {
    const response = await (await connect()).send(request);
    if (response.ok !== true) throw new SupervisorRejected(typeof response.code === 'string' ? response.code as SupervisorErrorCode : 'unavailable');
    return response;
  }

  /** Browser operations only go to a supervisor that knows them: an older one would drop the channel. */
  async function browserCall(request: SupervisorOperation): Promise<Record<string, unknown>> {
    if ((await connect()).version < BROWSER_SUPERVISOR_PROTOCOL) throw new SupervisorUnreachable('helper_incompatible');
    return call(request);
  }

  /** A tab that is not exactly a BrowserTab ends the connection: never shown. */
  function tab(value: unknown): BrowserTab {
    if (validBrowserTab(value)) return value;
    current?.destroy();
    throw new SupervisorUnreachable('helper_incompatible');
  }

  const attach = async (target: TerminalTarget, channel: string, after: number) => { await call({ op: 'attach', ...target, channel, after }); };
  const ack = async (target: TerminalTarget, channel: string, seq: number) => { await call({ op: 'ack', ...target, channel, seq }); };
  const detach = async (target: TerminalTarget, channel: string) => { await call({ op: 'detach', ...target, channel }); };
  const onChannel = (listener: (event: ChannelEvent) => void) => { channelListeners.push(listener); };
  const onDisconnected = (listener: () => void) => { disconnectedListeners.push(listener); };

  const browser: BrowserController = {
    async availability() {
      let opened: Connection;
      try { opened = await connect(); } catch (error) {
        return { state: 'unavailable', reason: error instanceof SupervisorUnreachable ? error.reason : 'helper_stopped' };
      }
      if (opened.version < BROWSER_SUPERVISOR_PROTOCOL) return { state: 'unavailable', reason: 'helper_incompatible' };
      const { availability } = await call({ op: 'browserStatus' });
      if (plain(availability) && availability.state === 'available') return { state: 'available' };
      const reason = plain(availability) ? SUPERVISOR_REASONS.find((candidate) => candidate === availability.reason) : undefined;
      return { state: 'unavailable', reason: reason ?? 'helper_incompatible' };
    },
    async tabs(target) {
      const { tabs } = await browserCall({ op: 'tabs', ...target });
      return Array.isArray(tabs) && tabs.length <= BROWSER_LIMITS.dedicatedTabs ? tabs.map(tab) : [tab(tabs)];
    },
    async openTab(target, url) { return tab((await browserCall({ op: 'openTab', ...target, url })).tab); },
    async closeTab(target, closing) { await browserCall({ op: 'closeTab', ...target, tab: closing }); },
    async act(target, acting, action) {
      const { result } = await browserCall({ op: 'act', ...target, tab: acting, action });
      if (!plain(result) || Object.keys(result).some((key) => key !== 'moved') || (result.moved !== undefined && typeof result.moved !== 'boolean')) {
        current?.destroy();
        throw new SupervisorUnreachable('helper_incompatible');
      }
      return result.moved === undefined ? {} : { moved: result.moved };
    },
    attach, ack, detach,
    async view(target, channel, view) { await browserCall({ op: 'view', ...target, channel, view }); },
    onChannel, onDisconnected,
  };

  /** A record that is not exactly an EnvironmentRecord ends the connection: never acted upon. */
  function record(value: unknown): EnvironmentRecord {
    if (validEnvironmentRecord(value)) return value;
    current?.destroy();
    throw new SupervisorUnreachable('helper_incompatible');
  }

  return {
    async availability(): Promise<ToolAvailability> {
      try { return (await connect()).availability; } catch (error) {
        return { state: 'unavailable', reason: error instanceof SupervisorUnreachable ? error.reason : 'helper_stopped' };
      }
    },
    async list() {
      const { environments } = await call({ op: 'list' });
      return Array.isArray(environments) ? environments.map(record) : [record(environments)];
    },
    async register(environment: RegisterInput) {
      const response = await call({ op: 'register', environment });
      return { environment: record(response.environment), created: response.created === true };
    },
    async launch(environmentId: string) { return record((await call({ op: 'launch', environmentId })).environment); },
    async terminate(environmentId: string) { return record((await call({ op: 'terminate', environmentId })).environment); },
    async discard(environmentId: string) { await call({ op: 'discard', environmentId }); },
    async shells(): Promise<TerminalShells> {
      const { shells } = await call({ op: 'shells' });
      const value = plain(shells) ? shells : {};
      if (!Array.isArray(value.shells) || !value.shells.every(validTerminalPath) || !(value.defaultShell === null || validTerminalPath(value.defaultShell))
        || !validTerminalPath(value.home)) {
        current?.destroy();
        throw new SupervisorUnreachable('helper_incompatible');
      }
      return { shells: value.shells, defaultShell: value.defaultShell, home: value.home };
    },
    attach, ack, detach,
    async input(target, seq, data) {
      const { inputSeq } = await call({ op: 'input', ...target, seq, data });
      if (!Number.isSafeInteger(inputSeq)) throw new SupervisorUnreachable('helper_incompatible');
      return inputSeq as number;
    },
    async resize(target, cols, rows, redraw) { await call({ op: 'resize', ...target, cols, rows, redraw }); },
    onConnected(listener: () => void) { connectedListeners.push(listener); },
    onEvent(listener: (event: SupervisorEvent) => void) { eventListeners.push(listener); },
    onChannel, onDisconnected,
    browser,
    close() { current?.destroy(); },
  };
}
