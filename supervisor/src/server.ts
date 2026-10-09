// The supervisor's local channel: a Unix socket in a private directory (0700, socket 0600) plus a
// key regenerated at every start (0600) that the Puente must present before anything else. A
// connection without it gets nothing: no list, no events, no operation. One Puente at a time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  MIN_PUENTE_PROTOCOL, SUPERVISOR_KEY_BYTES, SUPERVISOR_KEY_FILE, SUPERVISOR_LINE_BYTES, SUPERVISOR_PROTOCOL, SUPERVISOR_SOCKET_FILE,
  validEnvironmentRecord,
} from '../../protocol/supervisor.ts';
import type { ChannelEvent, SupervisorEvent, SupervisorHello, SupervisorReady, SupervisorRefused, SupervisorRequest, SupervisorResponse } from '../../protocol/supervisor.ts';
import { TERMINAL_CHANNEL_PATTERN, TERMINAL_INPUT_BYTES } from '../../protocol/remoteTerminal.ts';
import { BROWSER_TAB_PATTERN, browserUrl, validBrowserAction, validBrowserView } from '../../protocol/remoteBrowser.ts';
import { SupervisorFailure, type Supervisor } from './supervisor.ts';

export interface SupervisorServer { close(): Promise<void> }

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Shapes only; the terminal checks ranges and order. Browser fields are checked whole here. */
const TERMINAL_OPS: Record<string, string[]> = {
  attach: ['channel', 'after'], ack: ['channel', 'seq'], detach: ['channel'], input: ['seq', 'data'], resize: ['cols', 'rows', 'redraw'],
  tabs: [], openTab: ['url'], closeTab: ['tab'], act: ['tab', 'action'], view: ['channel', 'view'],
};

function validRequest(value: unknown): value is SupervisorRequest {
  if (!plain(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) return false;
  if (value.op === 'list' || value.op === 'shells' || value.op === 'browserStatus') return exact(value, ['id', 'op']);
  if (value.op === 'launch' || value.op === 'terminate' || value.op === 'discard') return exact(value, ['id', 'op', 'environmentId']) && typeof value.environmentId === 'string';
  if (typeof value.op === 'string' && Object.hasOwn(TERMINAL_OPS, value.op)) {
    const fields = TERMINAL_OPS[value.op]!;
    return exact(value, ['id', 'op', 'environmentId', 'deviceId', ...fields]) && typeof value.environmentId === 'string' && typeof value.deviceId === 'string'
      && (!fields.includes('channel') || (typeof value.channel === 'string' && new RegExp(TERMINAL_CHANNEL_PATTERN).test(value.channel)))
      && ['after', 'seq', 'cols', 'rows'].every((field) => !fields.includes(field) || typeof value[field] === 'number')
      && (!fields.includes('data') || (typeof value.data === 'string' && value.data.length > 0 && value.data.length <= Math.ceil(TERMINAL_INPUT_BYTES / 3) * 4 && BASE64.test(value.data)))
      && (!fields.includes('redraw') || typeof value.redraw === 'boolean')
      && (!fields.includes('url') || value.url === null || browserUrl(value.url))
      && (!fields.includes('tab') || (typeof value.tab === 'string' && new RegExp(BROWSER_TAB_PATTERN).test(value.tab)))
      && (!fields.includes('action') || validBrowserAction(value.action) !== null)
      && (!fields.includes('view') || validBrowserView(value.view));
  }
  if (value.op !== 'register' || !exact(value, ['id', 'op', 'environment']) || !plain(value.environment)) return false;
  const environment = value.environment;
  return exact(environment, ['id', 'deviceId', 'kind', 'requestId', 'createdAt', ...(environment.kind === 'terminal' ? ['terminal'] : [])])
    && validEnvironmentRecord({ ...environment, ownership: 'own', state: 'starting', exitCode: null, endedAt: null });
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('The supervisor runtime directory must be a private directory of this user.');
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

export async function listenSupervisor(options: { runtimeDirectory: string; supervisor: Supervisor; authTimeoutMs?: number }): Promise<SupervisorServer> {
  const { supervisor, runtimeDirectory } = options;
  await privateDirectory(runtimeDirectory);
  const file = path.join(runtimeDirectory, SUPERVISOR_SOCKET_FILE);
  if (await alive(file)) throw new Error('Another supervisor is already listening.');
  await fs.rm(file, { force: true });

  const key = randomBytes(SUPERVISOR_KEY_BYTES).toString('base64url');
  const expected = digest(key);
  const temporary = path.join(runtimeDirectory, `.${SUPERVISOR_KEY_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(key); } finally { await handle.close(); }
  await fs.rename(temporary, path.join(runtimeDirectory, SUPERVISOR_KEY_FILE));

  let active: net.Socket | null = null;
  const sockets = new Set<net.Socket>();
  // The channel is every device's: a line the Puente would refuse never goes. An answer that long
  // fails alone, an event that long is dropped; the connection and every other stream go on.
  const send = (socket: net.Socket, message: SupervisorHello | SupervisorReady | SupervisorResponse | SupervisorEvent | ChannelEvent) => {
    if (socket.destroyed) return;
    let text = JSON.stringify(message);
    if (text.length > SUPERVISOR_LINE_BYTES) {
      if (message.type !== 'response') return;
      text = JSON.stringify({ type: 'response', id: message.id, ok: false, code: 'unavailable' } satisfies SupervisorResponse);
    }
    socket.write(`${text}\n`);
  };
  const flush = () => {
    if (!active) return;
    for (const event of supervisor.takeEvents()) send(active, event);
  };
  supervisor.onEvent(flush);
  // Frames never wait for a later Puente: without one, every channel is detached.
  supervisor.onChannel((event) => { if (active) send(active, event); });

  async function answer(request: SupervisorRequest): Promise<SupervisorResponse> {
    const ok = { type: 'response', id: request.id, ok: true } as const;
    try {
      switch (request.op) {
        case 'list': return { ...ok, environments: supervisor.list() };
        case 'register': return { ...ok, ...await supervisor.register(request.environment) };
        case 'launch': return { ...ok, environment: await supervisor.launch(request.environmentId) };
        case 'terminate': return { ...ok, environment: await supervisor.terminate(request.environmentId) };
        case 'discard': await supervisor.discard(request.environmentId); return ok;
        case 'shells': return { ...ok, shells: await supervisor.shells() };
        case 'attach': supervisor.attach(request, request.channel, request.after); return ok;
        case 'ack': supervisor.ack(request, request.channel, request.seq); return ok;
        case 'detach': supervisor.detach(request, request.channel); return ok;
        case 'resize': supervisor.resize(request, request.cols, request.rows, request.redraw); return ok;
        case 'input': {
          const data = Buffer.from(request.data, 'base64');
          if (data.length > TERMINAL_INPUT_BYTES) throw new SupervisorFailure('invalid');
          return { ...ok, inputSeq: supervisor.input(request, request.seq, data) };
        }
        case 'browserStatus': return { ...ok, availability: await supervisor.browserStatus() };
        case 'tabs': return { ...ok, tabs: supervisor.tabs(request) };
        case 'openTab': return { ...ok, tab: await supervisor.openTab(request, request.url) };
        case 'closeTab': await supervisor.closeTab(request, request.tab); return ok;
        // The checked copy: exactly the fields of a known action.
        case 'act': return { ...ok, result: await supervisor.act(request, request.tab, validBrowserAction(request.action)!) };
        case 'view': await supervisor.view(request, request.channel, request.view); return ok;
      }
    } catch (error) {
      return { type: 'response', id: request.id, ok: false, code: error instanceof SupervisorFailure ? error.code : 'unavailable' };
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let authenticated = false;
    let buffer = '';
    const deadline = setTimeout(() => socket.destroy(), options.authTimeoutMs ?? 2000);
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.once('close', () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      if (active === socket) {
        active = null;
        supervisor.detachAll();
      }
    });
    const refuse = (code: SupervisorRefused['code']) => { socket.end(`${JSON.stringify({ type: 'refused', code } satisfies SupervisorRefused)}\n`); };

    function line(text: string): void {
      let message: unknown;
      try { message = JSON.parse(text); } catch { socket.destroy(); return; }
      if (!authenticated) {
        // Anything but a well-formed auth with the key is refused before any information leaves.
        if (!plain(message) || message.type !== 'auth' || !exact(message, ['type', 'key', 'puenteProtocol', 'minSupervisorProtocol'])
          || typeof message.key !== 'string' || !timingSafeEqual(digest(message.key), expected)) return refuse('unauthorized');
        if (!version(message.puenteProtocol) || !version(message.minSupervisorProtocol)
          || message.puenteProtocol < MIN_PUENTE_PROTOCOL || SUPERVISOR_PROTOCOL < message.minSupervisorProtocol) return refuse('incompatible');
        clearTimeout(deadline);
        authenticated = true;
        // Events reach a Puente only after its ready, the first line it expects once authenticated.
        void supervisor.availability().then((availability) => {
          if (socket.destroyed) return;
          if (active) {
            // The previous Puente's channels go with it: their frames never reach this one.
            supervisor.detachAll();
            active.destroy();
          }
          active = socket;
          send(socket, { type: 'ready', availability });
          flush();
        });
        return;
      }
      if (!validRequest(message)) { socket.destroy(); return; }
      void answer(message).then((response) => send(socket, response));
    }

    socket.on('data', (chunk: string) => {
      // setEncoding keeps a UTF-8 character split between two reads whole (a cwd like /home/ana/Música).
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (socket.destroyed || socket.writableEnded) return;
        line(text);
      }
      if (buffer.length > SUPERVISOR_LINE_BYTES) socket.destroy();
    });
    send(socket, { type: 'hello', supervisorProtocol: SUPERVISOR_PROTOCOL, minPuenteProtocol: MIN_PUENTE_PROTOCOL } satisfies SupervisorHello);
  });

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(file, listening.resolve);
  await listening.promise;
  await fs.chmod(file, 0o600);

  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    },
  };
}
