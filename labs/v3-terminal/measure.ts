// Measures the terminal chain of #83 end to end: a real shell on a node-pty PTY in its own systemd
// scope, the real supervisor and socket, the real Puente and its SSE stream, and a client that acks
// every frame as soon as it arrives (the best case for the app). Not part of any suite.
//
//   node labs/v3-terminal/measure.ts            (needs `npm run setup` in supervisor/ and a user manager)
//
// Prints, per frame/window combination: throughput of 64 MiB of output and the time from Ctrl-C under
// an endless `yes` until the prompt answers again.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashDeviceKey } from '../../bridge/src/auth.ts';
import { createDeviceStore } from '../../bridge/src/deviceStore.ts';
import { createPairing } from '../../bridge/src/pairing.ts';
import { RunManager } from '../../bridge/src/runs.ts';
import { createApp } from '../../bridge/src/server.ts';
import { createSupervisorClient } from '../../bridge/src/remote/supervisorClient.ts';
import { FakeHermes } from '../../bridge/support/fake_hermes.ts';
import { listenSupervisor } from '../../supervisor/src/server.ts';
import { openSupervisor } from '../../supervisor/src/supervisor.ts';
import { systemdHost } from '../../supervisor/src/systemdHost.ts';

const DEVICE = { id: '00000000-0000-4000-8000-0000000000aa', key: `rly1_${Buffer.alloc(32, 3).toString('base64url')}` };
const V1 = { version: 1, minAppVersion: 1 };
const MiB = 1024 * 1024;

async function measure(frameBytes: number, windowBytes: number, ringBytes: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-measure-'));
  const relay = path.join(root, 'relay');
  await fs.mkdir(relay, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'shells'), '/bin/bash\n');
  const supervisor = await openSupervisor({
    directory: path.join(root, 'state'), host: await systemdHost(), unitPrefix: 'relay-measure', shellsFile: path.join(root, 'shells'),
    stream: { frameBytes, windowBytes, ringBytes },
  });
  const channel = await listenSupervisor({ runtimeDirectory: path.join(root, 'run'), supervisor });
  const client = createSupervisorClient({ runtimeDirectory: path.join(root, 'run') });
  const store = await createDeviceStore({ directory: relay });
  await store.mutate((draft) => { draft.devices.push({ id: DEVICE.id, name: 'lab', pairedAt: Date.now(), revokedAt: null, keyHash: hashDeviceKey(DEVICE.key).toString('hex') }); });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const server = createApp({
    config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://lab:8650', serverName: 'lab' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, log: () => {},
    remote: { environments: { capability: V1, port: client }, terminal: { capability: V1, port: client } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = (capability: string) => ({ Authorization: `Bearer ${DEVICE.key}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': capability, 'Content-Type': 'application/json' });
  const post = async (route: string, body: unknown, capability = 'terminal/1') => (await fetch(base + route, { method: 'POST', headers: headers(capability), body: JSON.stringify(body) })).json();

  const { id } = await post('/v1/remote/environments', { requestId: `measure-${frameBytes}-${windowBytes}`, kind: 'terminal', shell: '/bin/bash', cwd: root }, 'environments/1');
  let channelId = '';
  let lastSeq = 0;
  let received = 0;
  let tail = '';
  let ackPending = false;
  const waiters: (() => void)[] = [];
  const request = http.get(`${base}/v1/remote/terminals/${id}/output`, { headers: headers('terminal/1') }, (response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer.slice(0, index).split('\n').find((line) => line.startsWith('data: '));
        buffer = buffer.slice(index + 2);
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type === 'open') channelId = event.channel;
        if (event.type === 'output') {
          const bytes = Buffer.from(event.data, 'base64');
          received += bytes.length;
          lastSeq = event.seq;
          tail = (tail + bytes.toString('latin1')).slice(-256);
        }
      }
      for (const wake of waiters.splice(0)) wake();
      if (!ackPending && lastSeq > 0) {
        ackPending = true;
        setImmediate(() => { ackPending = false; void post(`/v1/remote/terminals/${id}/ack`, { channel: channelId, seq: lastSeq }); });
      }
    });
  });
  const until = async (check: () => boolean) => { while (!check()) await new Promise<void>((resolve) => waiters.push(resolve)); };
  let seq = 0;
  const type = (text: string) => post(`/v1/remote/terminals/${id}/input`, { seq: ++seq, data: Buffer.from(text).toString('base64') });
  await until(() => channelId !== '' && received > 0);

  const before = received;
  const started = performance.now();
  await type(`head -c ${64 * MiB} /dev/zero | tr '\\0' x; echo; echo END_$((40+2))\r`);
  await until(() => tail.includes('END_42'));
  const seconds = (performance.now() - started) / 1000;
  const throughput = (received - before) / MiB / seconds;

  await type('yes\r');
  const flood = received;
  await until(() => received - flood > 8 * MiB);
  const pressed = performance.now();
  await type('\x03');
  await type('echo MARK_$((1+1))\r');
  await until(() => tail.includes('MARK_2'));
  const ctrlC = performance.now() - pressed;

  request.destroy();
  await post(`/v1/remote/environments/${id}/terminate`, { confirm: true }, 'environments/1');
  runs.close(); server.closeAllConnections(); server.close(); client.close();
  await channel.close(); await supervisor.close();
  await fs.rm(root, { recursive: true, force: true });
  return { throughput, ctrlC };
}

console.log('frame KiB | window KiB | ring KiB | MiB/s (64 MiB) | Ctrl-C under yes (ms)');
for (const [frame, window] of [[16, 256], [16, 1024], [64, 256], [64, 1024], [64, 4096]] as const) {
  const ring = Math.max(2048, window * 2);
  const { throughput, ctrlC } = await measure(frame * 1024, window * 1024, ring * 1024);
  console.log(`${frame} | ${window} | ${ring} | ${throughput.toFixed(1)} | ${ctrlC.toFixed(0)}`);
}
process.exit(0);
