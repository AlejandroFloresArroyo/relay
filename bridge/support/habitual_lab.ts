// The real Puente with the habitual browser wired: its HTTP routes, its device store and its extension
// socket. What is at the other end of the socket is the test's: the transport double
// (fake_extension.ts) or the real extension and host in a test browser (habitualBrowserReal.test.ts).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { ToolAvailability } from '../../protocol/protocol.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { createRemoteFileSystem, FILES_CAPABILITY } from '../src/remote/files.ts';
import { listenExtension } from '../src/remote/habitualBrowser.ts';
import type { BrowserController } from '../src/remote/ports.ts';
import { SupervisorRejected } from '../src/remote/supervisorClient.ts';
import { FakeHermes } from './fake_hermes.ts';
import { fixedBrowser, fixedSupervisor } from './fake_remote.ts';
import { NOW, PHONE, TABLET, downloadFile, openStream, uploadFile, type Device, type OutputStream } from './remote_lab.ts';

export { NOW, PHONE, TABLET, type Device };
const V1 = { version: 1, minAppVersion: 1 };
const DEDICATED: ToolAvailability = { state: 'unavailable', reason: 'not_configured' };
const notFound = async (): Promise<never> => { throw new SupervisorRejected('not_found'); };
/** A supervisor with no dedicated browser: any other environment ID is one it does not have. */
const noDedicated: BrowserController = {
  ...fixedBrowser(async () => DEDICATED).dedicated,
  tabs: notFound, openTab: notFound, closeTab: notFound, act: notFound, attach: notFound, view: notFound, ack: notFound, detach: notFound,
};

/** `files`: the home of the Puente's files tool (#87), wired beside the browser; without it there is none. */
export async function habitualPuente(t: TestContext, options: { stateDirectory?: string; requestTimeoutMs?: number; files?: string } = {}) {
  const directory = options.stateDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'relay-habitual-'));
  if (!options.stateDirectory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory, now: () => NOW });
  await store.mutate((draft) => {
    for (const device of [PHONE, TABLET]) draft.devices.push({ id: device.id, name: 'phone', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(device.key).toString('hex') });
  });
  const logs: string[] = [];
  const link = await listenExtension({ stateDirectory: directory, log: (line) => logs.push(line), requestTimeoutMs: options.requestTimeoutMs });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const server = createApp({
    config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, hostname: 'arch', version: '9.9.9', now: () => NOW,
    log: (line) => logs.push(line),
    remote: {
      environments: { capability: V1, port: fixedSupervisor() },
      browser: { capability: V1, port: { dedicated: noDedicated, habitual: link } },
      ...options.files ? { files: { capability: FILES_CAPABILITY, port: createRemoteFileSystem({ home: options.files, hermesHome: path.join(options.files, '.hermes'), stateDirectory: directory, changeLog: store.changeLog, now: () => NOW }) } } : {},
    },
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const streams: OutputStream[] = [];
  t.after(async () => { for (const stream of streams) stream.close(); runs.close(); server.closeAllConnections(); server.close(); await link.close(); });
  const headers = (device: Device, capability: string) => ({ Authorization: `Bearer ${device.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': capability });

  async function call(device: Device, method: string, route: string, body?: unknown, capability = 'browser/1') {
    const response = await fetch(base + route, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...headers(device, capability), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }
  /** Connects the device to the habitual browser: its shared environment. */
  const connect = (device: Device, requestId = `habitual-${device.id.slice(-4)}`) => call(device, 'POST', '/v1/remote/environments', { requestId, kind: 'browser_habitual' }, 'environments/1');
  const tabs = (device: Device, id: string) => call(device, 'GET', `/v1/remote/browsers/${id}/tabs`);
  const open = (device: Device, id: string, url: unknown) => call(device, 'POST', `/v1/remote/browsers/${id}/tabs`, { url });
  /** `tab` as the path carries it: the extension's tab number, in decimal. */
  const act = (device: Device, id: string, tab: string | number, action: unknown) => call(device, 'POST', `/v1/remote/browsers/${id}/tabs/${tab}/action`, action);
  /** The connection's frames and tabs stream, read as the app's native side reads it. */
  const frames = async (device: Device, id: string) => {
    const stream = await openStream(`${base}/v1/remote/browsers/${id}/frames`, headers(device, 'browser/1'));
    streams.push(stream);
    return stream;
  };
  const terminate = (device: Device, id: string) => call(device, 'POST', `/v1/remote/environments/${id}/terminate`, { confirm: true }, 'environments/1');
  const list = async (device: Device) => (await call(device, 'GET', '/v1/remote/environments', undefined, 'environments/1')).json.environments as Record<string, unknown>[];
  const revoke = (device: Device) => store.mutate((draft) => { draft.devices.find((candidate) => candidate.id === device.id)!.revokedAt = NOW; });
  const changes = async () => (await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((record) => record.action.startsWith('remote.')).map((record) => `${record.action} ${record.actor.kind} ${record.target.id}`);
  const upload = (device: Device, folder: string, name: string, bytes: Buffer) => uploadFile(base, headers(device, 'files/1'), folder, name, bytes);
  const download = (device: Device, file: string) => downloadFile(base, headers(device, 'files/1'), file);
  return { directory, link, logs, call, connect, tabs, open, act, frames, terminate, list, revoke, changes, upload, download };
}
