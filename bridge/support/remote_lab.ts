// The real Puente, the real supervisor and its real socket for environment and terminal tests. Only
// the native boundary (PTY, systemd, cgroup) is the double: supervisor/support/fakeHost.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import type { BrowserStreamEvent } from '../../protocol/remoteBrowser.ts';
import type { TerminalStreamEvent } from '../../protocol/remoteTerminal.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { createRemoteFileSystem, FILES_CAPABILITY } from '../src/remote/files.ts';
import { createSupervisorClient, type SupervisorClient } from '../src/remote/supervisorClient.ts';
import { FakeHost } from '../../supervisor/support/fakeHost.ts';
import { listenSupervisor } from '../../supervisor/src/server.ts';
import { openSupervisor, type SupervisorOptions } from '../../supervisor/src/supervisor.ts';
import { FakeHermes } from './fake_hermes.ts';

export const NOW = 1_700_000_000_000;
export const PHONE = { id: '00000000-0000-4000-8000-000000000001', key: `rly1_${Buffer.alloc(32, 7).toString('base64url')}` };
export const TABLET = { id: '00000000-0000-4000-8000-000000000002', key: `rly1_${Buffer.alloc(32, 9).toString('base64url')}` };
const TIMING = { terminateGraceMs: 20, terminateGiveUpMs: 40, terminateRetryMs: 50, pollMs: 2, sweepMs: 10 };
export const RETRY_MS = 60;
const SHELLS = fileURLToPath(new URL('../../supervisor/test/fixtures/shells', import.meta.url));
export type Device = typeof PHONE;

/** An open output stream as the app's native side reads it: SSE over a request with the key in a header. */
export interface OutputStream {
  status: number;
  /** Error body when the stream did not open. */
  json: { error: { code: string } } | null;
  events: (TerminalStreamEvent | BrowserStreamEvent)[];
  /** Concatenated raw bytes of every output frame. */
  bytes(): Buffer;
  lastSeq(): number;
  /** The channel the open event named; empty until it arrives. */
  channel(): string;
  ended: Promise<void>;
  close(): void;
}

export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
}

/** A remote SSE route as the app's native side reads it, events gathered until the stream ends. */
export async function openStream(url: string, headers: Record<string, string>): Promise<OutputStream> {
  const { promise, resolve } = Promise.withResolvers<http.IncomingMessage>();
  const request = http.get(url, { headers }, resolve);
  request.on('error', () => {});
  const response = await promise;
  const events: (TerminalStreamEvent | BrowserStreamEvent)[] = [];
  const ended = Promise.withResolvers<void>();
  let buffer = '';
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    if (response.statusCode !== 200) { body += chunk; return; }
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const data = buffer.slice(0, index).split('\n').find((line) => line.startsWith('data: '));
      buffer = buffer.slice(index + 2);
      if (data) events.push(JSON.parse(data.slice('data: '.length)));
    }
  });
  response.on('close', () => ended.resolve());
  if (response.statusCode !== 200) await ended.promise;
  const frames = () => events.filter((event) => event.type === 'output') as Extract<TerminalStreamEvent, { type: 'output' }>[];
  return {
    status: response.statusCode!, json: body ? JSON.parse(body) : null, events, ended: ended.promise,
    bytes: () => Buffer.concat(frames().map((frame) => Buffer.from(frame.data, 'base64'))),
    lastSeq: () => frames().at(-1)?.seq ?? 0,
    channel: () => {
      const open = events.find((event) => event.type === 'open');
      return open?.type === 'open' ? open.channel : '';
    },
    close: () => { request.destroy(); },
  };
}

async function json(base: string, headers: Record<string, string>, route: string, body: unknown) {
  const response = await fetch(base + route, { method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'Content-Type': 'application/json' } });
  const answer = await response.json();
  if (response.status !== 200) throw new Error(`${route} ${answer.error.code}`);
  return answer;
}

/** A file of the phone onto the Server through the files transfer (#87), one chunk after another as the app sends it: where it was published. */
export async function uploadFile(base: string, headers: Record<string, string>, folder: string, name: string, bytes: Buffer): Promise<string> {
  const { id } = await json(base, headers, '/v1/remote/files/uploads', { directory: folder, name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += REMOTE_LIMITS.transferChunkBytes) {
    const chunk = await fetch(`${base}/v1/remote/files/uploads/${id}/${offset}`, {
      method: 'PUT', body: new Uint8Array(bytes.subarray(offset, offset + REMOTE_LIMITS.transferChunkBytes)), headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    });
    if (chunk.status !== 200) throw new Error(`upload chunk ${chunk.status}`);
  }
  return path.join(folder, (await json(base, headers, `/v1/remote/files/uploads/${id}/commit`, {})).name);
}

/** A file of the Server onto the phone through the files transfer (#87): its bytes. */
export async function downloadFile(base: string, headers: Record<string, string>, file: string): Promise<Buffer> {
  const { id, size } = await json(base, headers, '/v1/remote/files/downloads', { path: file });
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < size; offset += chunks.at(-1)!.length) {
    const response = await fetch(`${base}/v1/remote/files/downloads/${id}/${offset}`, { headers });
    if (response.status !== 200) throw new Error(`download chunk ${response.status}`);
    chunks.push(Buffer.from(await response.arrayBuffer()));
  }
  return Buffer.concat(chunks);
}

export async function lab(t: TestContext, options: Partial<SupervisorOptions> = {}, retryMs = RETRY_MS) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-environments-'));
  const runtime = path.join(root, 'run');
  const state = path.join(root, 'supervisor');
  const relay = path.join(root, 'relay');
  await fs.mkdir(relay, { mode: 0o700 });
  const host = new FakeHost();
  const store = await createDeviceStore({ directory: relay, now: () => NOW });
  await store.mutate((draft) => {
    for (const device of [PHONE, TABLET]) draft.devices.push({ id: device.id, name: 'phone', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(device.key).toString('hex') });
  });
  const closers: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
  });

  let supervisor: { close(): Promise<void> } | null = null;
  /** The supervisor process: start, crash (close without ending anything), start again. */
  async function startSupervisor() {
    const core = await openSupervisor({ directory: state, host, unitPrefix: 'relay-test', shellsFile: SHELLS, now: () => NOW, timing: TIMING, ...options });
    const server = await listenSupervisor({ runtimeDirectory: runtime, supervisor: core });
    supervisor = { async close() { await server.close(); await core.close(); } };
    return core;
  }
  async function stopSupervisor() { await supervisor?.close(); supervisor = null; }
  closers.push(() => stopSupervisor());
  await startSupervisor();

  /** One Puente process: its own client of the supervisor socket and its own HTTP server; `files`, the home of its files tool (#87). */
  async function puente(wrap: (client: SupervisorClient) => SupervisorClient = (client) => client, options: { files?: string } = {}) {
    const client = createSupervisorClient({ runtimeDirectory: runtime, timeoutMs: 1000 });
    const port = wrap(client);
    const hermes = new FakeHermes();
    const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
    const logs: string[] = [];
    const server = createApp({
      config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }),
      peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, hostname: 'arch', version: '9.9.9', now: () => NOW,
      log: (line) => logs.push(line), environmentRetryMs: retryMs,
      remote: {
        environments: { capability: { version: 1, minAppVersion: 1 }, port }, terminal: { capability: { version: 1, minAppVersion: 1 }, port },
        browser: { capability: { version: 1, minAppVersion: 1 }, port: { dedicated: port.browser, habitual: null } },
        ...options.files ? { files: { capability: FILES_CAPABILITY, port: createRemoteFileSystem({ home: options.files, hermesHome: path.join(options.files, '.hermes'), stateDirectory: relay, changeLog: store.changeLog, now: () => NOW }) } } : {},
      },
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const streams: OutputStream[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const stream of streams) stream.close();
      runs.close(); server.closeAllConnections(); server.close(); client.close();
    };
    closers.push(close);
    const headers = (device: Device, capability: string) => ({ Authorization: `Bearer ${device.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': capability });
    async function call(device: Device, method: string, route: string, body?: unknown, capability = 'environments/1') {
      const response = await fetch(base + route, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...headers(device, capability), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    }
    const create = (device: Device, requestId: string, terminal = { shell: '/bin/sh', cwd: os.tmpdir() }) => call(device, 'POST', '/v1/remote/environments', { requestId, kind: 'terminal', ...terminal });
    const list = async (device: Device) => (await call(device, 'GET', '/v1/remote/environments')).json.environments as { id: string; state: string; endedAt: number | null; exitCode: number | null; terminationError?: string }[];
    const terminate = (device: Device, id: string, body: unknown = { confirm: true }) => call(device, 'POST', `/v1/remote/environments/${id}/terminate`, body);
    const terminal = (device: Device, id: string, action: 'ack' | 'input' | 'resize', body: unknown) => call(device, 'POST', `/v1/remote/terminals/${id}/${action}`, body, 'terminal/1');
    let inputSeq = 0;
    const type = (device: Device, id: string, text: string | Buffer, seq = ++inputSeq) => terminal(device, id, 'input', { seq, data: Buffer.from(text).toString('base64') });

    /** GET …/output (or another remote SSE route), read as SSE events until the stream ends. */
    async function output(device: Device, id: string, lastEventId?: string, route = `/v1/remote/terminals/${id}/output`, capability = 'terminal/1'): Promise<OutputStream> {
      const stream = await openStream(`${base}${route}`, { ...headers(device, capability), ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) });
      streams.push(stream);
      return stream;
    }
    /** A browser: its frames and tabs stream, and its other routes. */
    const frames = (device: Device, id: string) => output(device, id, undefined, `/v1/remote/browsers/${id}/frames`, 'browser/1');
    const browser = (device: Device, method: string, route: string, body?: unknown) => call(device, method, `/v1/remote/browsers/${route}`, body, 'browser/1');
    /** The files transfer (#87), as the app moves a file to or from the Server. */
    const upload = (device: Device, folder: string, name: string, bytes: Buffer) => uploadFile(base, headers(device, 'files/1'), folder, name, bytes);
    const download = (device: Device, file: string) => downloadFile(base, headers(device, 'files/1'), file);
    return { call, create, list, terminate, terminal, type, output, frames, browser, upload, download, logs, close, client, base };
  }

  const revoke = (device: Device) => store.mutate((draft) => { draft.devices.find((candidate) => candidate.id === device.id)!.revokedAt = NOW; });
  const unit = (id: string) => `relay-test-${id}`;
  const changes = async () => (await fs.readFile(path.join(relay, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    .filter((record) => record.action.startsWith('remote.')).map((record) => `${record.action.slice('remote.environment.'.length)} ${record.actor.kind} ${record.target.id}`);
  return { host, store, puente, revoke, unit, changes, startSupervisor, stopSupervisor, runtime };
}
