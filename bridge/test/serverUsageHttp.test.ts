import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readServerUsage } from '../src/serverUsage.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { Approval } from '../../protocol/protocol.ts';
import type { ServerUsage, UsagePeriod } from '../../protocol/serverUsage.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}` };
class UsageHermes extends FakeHermes {
  usageCalls: UsagePeriod[] = [];
  usageHome = '';
  async usage(period: UsagePeriod): Promise<ServerUsage> {
    this.usageCalls.push(period);
    return readServerUsage(this.usageHome,[{id:'default',name:'Default'},{id:'broken',name:'Broken'}],Date.parse('2026-10-04T18:00Z'),period);
  }
}
async function start(t: TestContext, peer = '100.64.0.1') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1_700_000_000_000;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000001', name: 'phone', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const pairing = createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' });
  const hermes = new UsageHermes();
  hermes.usageHome = path.join(directory,'synthetic-profile');
  await fs.mkdir(path.join(hermes.usageHome,'profiles/broken'),{recursive:true});
  const db = new DatabaseSync(path.join(hermes.usageHome,'state.db'));
  db.exec("CREATE TABLE sessions (started_at REAL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)");
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(Date.parse('2026-10-04T17:00Z')/1000,'synthetic-model',100,20,0,'included');
  db.close();
  await fs.writeFile(path.join(hermes.usageHome,'profiles/broken/state.db'),'fixture-corruption-private-canary');
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
    store, pairing, peerAddress: () => peer,
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

  return { hermes, runs, base, call, whoisCalls, notified, logs, advanceWindow: () => { clock += 60_000; } };
}

test('GET usage authenticates, validates period and calls only the optional usage port; logs omit queries', async t => {
  const {call,hermes,logs} = await start(t);
  assert.equal((await call('GET','/v1/usage?period=day',undefined,{})).status,401);
  for (const period of ['day','week','month']) {
    const response = await call('GET',`/v1/usage?period=${period}`);
    assert.equal(response.status,200); assert.equal(response.json.period,period);
    assert.equal(response.json.partial,true); assert.equal(response.json.total.tokens,null);
    assert.equal(response.json.totalsKnown.tokens,120); assert.equal(response.json.totalsKnown.estimatedCostUsd,0);
    assert.equal(response.json.agents[1].status,'error');
    assert.doesNotMatch(response.text,/fixture-corruption-private-canary|synthetic-profile|state.db/);
  }
  for (const query of ['', '?period=year', '?period=day&period=month','?period=day&path=private-canary']) {
    assert.equal((await call('GET','/v1/usage'+query)).status,400);
  }
  assert.deepEqual(hermes.usageCalls,['day','week','month']);
  assert.doesNotMatch(logs.join('\n'), /private-canary|period=/);
  Object.assign(hermes,{usage:undefined});
  assert.equal((await call('GET','/v1/usage?period=day')).status,503);
});
