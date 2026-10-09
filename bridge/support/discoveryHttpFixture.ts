import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import type { Approval } from '../../protocol/protocol.ts';
import { RunManager } from '../src/runs.ts';
import { createApp, type AppDeps } from '../src/server.ts';
import type { Discovery } from '../src/discovery.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

export const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
export const AUTH = { Authorization: `Bearer ${KEY}` };

export async function start(t: TestContext, discovery?: Discovery, extra: Partial<AppDeps> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1_700_000_000_000;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000001', name: 'phone', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:17651', serverName: 'arch' });
  const hermes = new FakeHermes();
  const notified: Approval[] = [];
  const logs: string[] = [];
  const runs = new RunManager({
    hermes,
    notifier: {
      async approvalCreated(approval) {
        notified.push(approval);
      },
    },
    sleep: async () => {},
  });
  const whoisCalls: string[] = [];
  const server = createApp({
    config: { corsOrigins: ['http://localhost:8081'] },
    store, pairing, peerAddress: () => '100.64.0.1', discovery,
    hermes,
    runs,
    tailnet: {
      async whois(ip) {
        whoisCalls.push(ip);
        return ip === '100.84.12.7' ? { device: 'iphone-dev', tailnet: 'tail0a1b2c.ts.net' } : null;
      },
    },
    hostname: 'arch',
    version: '9.9.9',
    now: () => clock,
    log: (line) => logs.push(line),
    ...extra,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    runs.close();
    server.closeAllConnections();
    server.close();
  });

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON (SSE or empty)
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  return { store, hermes, runs, base, call, whoisCalls, notified, logs, advanceWindow: () => { clock += 60_000; } };
}
