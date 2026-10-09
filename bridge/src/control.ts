import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PAIRING_QR_TYPE, PAIRING_QR_VERSION } from '../../protocol/protocol.ts';
import { checkStateDirectory, exactObject, isDeviceName, isTimestamp, isUuid, StateError } from './changeLog.ts';
import type { ChangeLog, StateIO } from './changeLog.ts';
import { createDeviceStore } from './deviceStore.ts';
import type { DeviceStore } from './deviceStore.ts';
import { createPairing, isPairingOrigin, normalizePairingCode, PairingError } from './pairing.ts';
import type { Pairing } from './pairing.ts';

export type ControlRequest = { command: 'pair' } | { command: 'devices' } | { command: 'revoke'; deviceId: string };
type ControlResult = Awaited<ReturnType<Pairing['pair']>> | Awaited<ReturnType<Pairing['devices']>> | Awaited<ReturnType<Pairing['revoke']>>;
export type ControlResponse = { ok: true; result: ControlResult } | { ok: false; error: { code: 'device_not_found' | 'invalid_command' | 'unavailable' | 'internal'; message: string } };
const MESSAGES = { device_not_found: 'Device not found.', invalid_command: 'Invalid control command.', unavailable: 'Control service is unavailable.', internal: 'Internal control error.' } as const;

export class ControlError extends Error {
  constructor(message: string = MESSAGES.unavailable) { super(message); this.name = 'ControlError'; }
}

export async function controlSocketPath(directory: string, runtimeDirectory: string | undefined): Promise<string> {
  if (!runtimeDirectory) throw new ControlError('XDG_RUNTIME_DIR is required; use a systemd user session.');
  await checkStateDirectory(runtimeDirectory).catch(() => { throw new ControlError(); });
  const instance = crypto.createHash('sha256').update(await fs.realpath(directory)).digest('hex').slice(0, 24);
  return path.join(runtimeDirectory, 'relayd', `${instance}.sock`);
}

function validRequest(value: unknown): value is ControlRequest {
  return (exactObject(value, ['command']) && (value.command === 'pair' || value.command === 'devices'))
    || (exactObject(value, ['command', 'deviceId']) && value.command === 'revoke' && isUuid(value.deviceId));
}

async function privateSocket(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(file);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (Number(stat.mode) & 0o777) !== 0o600) throw new ControlError();
  return stat;
}

async function socketAlive(file: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new ControlError()); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(new ControlError());
    });
  });
}

async function startControl(file: string, getPairing: () => Pairing | null, timeoutMs: number) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw new ControlError(); });
  await checkStateDirectory(directory);
  if (((await fs.lstat(directory)).mode & 0o777) !== 0o700) throw new ControlError();
  const existing = await privateSocket(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (await socketAlive(file)) throw new ControlError();
    const current = await privateSocket(file);
    if (current.ino !== existing.ino || current.dev !== existing.dev) throw new ControlError();
    await fs.unlink(file);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let chunks: Buffer[] = []; let size = 0; let handled = false;
    let flushDeadline: ReturnType<typeof setTimeout> | undefined;
    const send = (response: ControlResponse) => {
      if (socket.destroyed || socket.writableEnded) return;
      clearTimeout(deadline);
      // Release the read side even when the peer never sends FIN. Allow only a bounded flush.
      flushDeadline = setTimeout(() => socket.destroy(), 100);
      socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    };
    const fail = (code: keyof typeof MESSAGES) => send({ ok: false, error: { code, message: MESSAGES[code] } });
    const deadline = setTimeout(() => { handled = true; fail('unavailable'); }, timeoutMs);
    socket.once('close', () => { clearTimeout(deadline); clearTimeout(flushDeadline); sockets.delete(socket); });
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      size += chunk.length; chunks.push(chunk);
      if (size > 4096) { handled = true; chunks = []; fail('invalid_command'); return; }
      const bytes = Buffer.concat(chunks);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      handled = true; chunks = [];
      let request: unknown;
      try {
        if (newline !== bytes.length - 1) throw new ControlError();
        request = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, newline)));
        if (!validRequest(request)) throw new ControlError();
      } catch { fail('invalid_command'); return; }
      const pairing = getPairing();
      if (!pairing) { fail('unavailable'); return; }
      const operation = request.command === 'pair' ? pairing.pair() : request.command === 'devices' ? pairing.devices() : pairing.revoke(request.deviceId);
      operation.then((result) => send({ ok: true, result })).catch((error: unknown) => {
        fail(error instanceof PairingError && error.code === 'device_not_found' ? 'device_not_found' : error instanceof StateError || error instanceof PairingError ? 'unavailable' : 'internal');
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
    await fs.chmod(file, 0o600);
  } catch {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new ControlError();
  }
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function validDevice(value: unknown): boolean {
  return exactObject(value, ['id', 'name', 'pairedAt', 'revokedAt']) && isUuid(value.id) && isDeviceName(value.name)
    && isTimestamp(value.pairedAt) && (value.revokedAt === null || (isTimestamp(value.revokedAt) && value.revokedAt >= value.pairedAt));
}

function parseResponse(bytes: Buffer, request: ControlRequest): ControlResponse {
  const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  if (exactObject(value, ['ok', 'error']) && value.ok === false && exactObject(value.error, ['code', 'message'])
    && typeof value.error.code === 'string' && Object.hasOwn(MESSAGES, value.error.code)) {
    const code = value.error.code as keyof typeof MESSAGES;
    return { ok: false, error: { code, message: MESSAGES[code] } };
  }
  if (!exactObject(value, ['ok', 'result']) || value.ok !== true) throw new ControlError();
  const result = value.result;
  if (request.command === 'devices') {
    if (!exactObject(result, ['devices']) || !Array.isArray(result.devices) || !result.devices.every(validDevice)) throw new ControlError();
  } else if (request.command === 'revoke') {
    if (!exactObject(result, ['device']) || !validDevice(result.device)) throw new ControlError();
  } else {
    if (!exactObject(result, ['payload', 'expiresAt']) || !isTimestamp(result.expiresAt)
      || !exactObject(result.payload, ['type', 'version', 'url', 'code']) || result.payload.type !== PAIRING_QR_TYPE || result.payload.version !== PAIRING_QR_VERSION
      || typeof result.payload.url !== 'string' || typeof result.payload.code !== 'string' || normalizePairingCode(result.payload.code) !== result.payload.code) throw new ControlError();
    if (!isPairingOrigin(result.payload.url)) throw new ControlError();
  }
  return value as unknown as ControlResponse;
}

export async function sendControlRequest(options: { directory: string; runtimeDirectory: string | undefined; request: ControlRequest; timeoutMs?: number }): Promise<ControlResponse> {
  if (!validRequest(options.request)) throw new ControlError(MESSAGES.invalid_command);
  try {
    const file = await controlSocketPath(options.directory, options.runtimeDirectory);
    await checkStateDirectory(path.dirname(file));
    if (((await fs.lstat(path.dirname(file))).mode & 0o777) !== 0o700) throw new ControlError();
    await privateSocket(file);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const socket = net.createConnection(file); const chunks: Buffer[] = [];
      const deadline = setTimeout(() => { socket.destroy(); reject(new ControlError()); }, options.timeoutMs ?? 5000);
      socket.on('close', () => clearTimeout(deadline));
      socket.on('error', () => { clearTimeout(deadline); reject(new ControlError()); });
      socket.on('connect', () => socket.write(`${JSON.stringify(options.request)}\n`));
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => { clearTimeout(deadline); resolve(Buffer.concat(chunks)); });
    });
    if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) throw new ControlError();
    return parseResponse(bytes.subarray(0, -1), options.request);
  } catch (error) { throw error instanceof ControlError ? error : new ControlError(); }
}

export async function startService(options: {
  host: string; port: number; directory: string; runtimeDirectory: string | undefined;
  origin: () => Promise<string>; serverName: string;
  createHttpApp: (security: { store: DeviceStore; pairing: Pairing; changeLog: ChangeLog }) => http.Server | Promise<http.Server>;
  stateIO?: StateIO; now?: () => number; controlTimeoutMs?: number;
}) {
  let app: http.Server | null = null; let pairing: Pairing | null = null;
  let control: Awaited<ReturnType<typeof startControl>> | null = null;
  let closing: Promise<void> | null = null;
  const server = http.createServer((req, res) => {
    if (app) app.emit('request', req, res);
    else { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":{"code":"unavailable","message":"Service is not ready."}}'); }
  });
  function close(): Promise<void> {
    if (closing) return closing;
    server.closeAllConnections();
    closing = Promise.all([
      new Promise<void>((resolve) => server.close(() => { app?.emit('close'); resolve(); })),
      control?.close() ?? Promise.resolve(),
    ]).then(() => {});
    return closing;
  }
  try {
    // Win TCP before inspecting/removing a residual socket or opening any state file.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
    const file = await controlSocketPath(options.directory, options.runtimeDirectory);
    control = await startControl(file, () => pairing, options.controlTimeoutMs ?? 5000);
    const store = await createDeviceStore({ directory: options.directory, now: options.now, io: options.stateIO, onFatal: () => { void close(); } });
    pairing = createPairing({ store, origin: options.origin, serverName: options.serverName });
    app = await options.createHttpApp({ store, pairing, changeLog: store.changeLog });
    return { server, control: control.server, store, pairing, close };
  } catch (error) {
    await close();
    throw error instanceof ControlError ? error : new ControlError();
  }
}
