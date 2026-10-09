// Environments through the real Puente, the real supervisor and its real socket. Only the native
// boundary (PTY, systemd, cgroup) is the double: supervisor/support/fakeHost.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { BROWSER_LIMITS } from '../../protocol/remoteBrowser.ts';
import { BROWSER_SUPERVISOR_PROTOCOL, MIN_SUPERVISOR_PROTOCOL, PUENTE_SUPERVISOR_PROTOCOL, SUPERVISOR_LINE_BYTES } from '../../protocol/supervisor.ts';
import { createSupervisorClient, SupervisorUnreachable } from '../src/remote/supervisorClient.ts';
import { lab, NOW, PHONE, RETRY_MS, TABLET, until } from '../support/remote_lab.ts';

test('a device creates, lists and terminates only its own environments; a foreign ID is answered as missing', async (t) => {
  const { puente, host, unit, changes } = await lab(t);
  const { create, list, terminate, call, logs } = await puente();
  const created = await create(PHONE, 'request-phone-1');
  assert.equal(created.status, 200);
  assert.partialDeepStrictEqual(created.json, { kind: 'terminal', ownership: 'own', state: 'running', createdAt: NOW, endedAt: null });
  const id = created.json.id as string;
  assert.match(id, /^env_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual((await list(PHONE)).map((environment) => environment.id), [id]);
  assert.deepEqual(await list(TABLET), []);
  for (const response of [await terminate(TABLET, id), await call(TABLET, 'DELETE', `/v1/remote/environments/${id}`), await terminate(TABLET, 'env_doesNotExistAAAAAAAAAA')]) {
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, 'remote_not_found');
  }
  assert.deepEqual(host.signals, []);

  assert.equal((await terminate(PHONE, id, {})).json.error.code, 'remote_confirmation_required');
  assert.equal((await call(PHONE, 'DELETE', `/v1/remote/environments/${id}`)).json.error.code, 'remote_conflict');
  const ended = await terminate(PHONE, id);
  assert.partialDeepStrictEqual(ended.json, { id, state: 'exited', exitCode: null, endedAt: NOW });
  assert.deepEqual(await host.processes(unit(id)), []);
  assert.deepEqual((await terminate(PHONE, id)).json, ended.json, 'terminate is idempotent');
  assert.deepEqual((await call(PHONE, 'DELETE', `/v1/remote/environments/${id}`)).json, { ok: true });
  assert.deepEqual(await list(PHONE), []);
  await until(async () => (await changes()).length === 4, 'four changes');
  assert.deepEqual(await changes(), [`created device ${id}`, `terminate_requested device ${id}`, `terminated server ${id}`, `discarded device ${id}`]);
  // The log line carries the route, never the ID.
  assert.ok(logs.every((line) => !line.includes(id)), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('POST /v1/remote/environments/:id/terminate 200')));
});

test('a repeated requestId answers the same environment without launching another', async (t) => {
  const { puente, host } = await lab(t);
  const { create } = await puente();
  const first = await create(PHONE, 'request-same-1');
  const again = await create(PHONE, 'request-same-1');
  assert.equal(again.json.id, first.json.id);
  assert.equal(host.launched.length, 1);
  assert.equal((await create(TABLET, 'request-same-1')).json.id === first.json.id, false, 'a requestId belongs to its device');
  assert.equal((await create(PHONE, 'short')).json.error.code, 'remote_invalid_request');
});

test('at the live limit creation is refused and nothing else is ended', async (t) => {
  const { puente, host } = await lab(t, { limits: { liveEnvironmentsPerDevice: 1 } });
  const { create } = await puente();
  await create(PHONE, 'request-limit-1');
  const refused = await create(PHONE, 'request-limit-2');
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, 'remote_limit_reached');
  assert.deepEqual(host.signals, []);
});

test('revoking a device ends only its own environments and closes its access', async (t) => {
  const { puente, host, revoke, unit, changes } = await lab(t);
  const { create, list, call } = await puente();
  host.children = [{ ignoresHangUp: true }];
  const phone = [(await create(PHONE, 'request-revoke-1')).json.id, (await create(PHONE, 'request-revoke-2')).json.id];
  const tablet = (await create(TABLET, 'request-revoke-3')).json.id;
  await revoke(PHONE);
  await until(async () => (await host.processes(unit(phone[0]))).length === 0 && (await host.processes(unit(phone[1]))).length === 0, 'the revoked device has nothing running');
  assert.equal((await host.processes(unit(tablet))).length, 2);
  assert.equal((await list(TABLET))[0]!.state, 'running');
  assert.equal((await call(PHONE, 'GET', '/v1/remote/environments')).json.error.code, 'device_revoked');
  await until(async () => (await changes()).filter((line) => line.startsWith('terminated')).length === 2, 'terminations recorded');
  assert.ok((await changes()).includes(`terminate_requested server ${phone[0]}`));
});

test('a revoked environment the supervisor lists as terminating is asked to end again until it does', async (t) => {
  const { puente, host, revoke, unit } = await lab(t);
  // A supervisor whose own termination stalled: terminating, no error, nothing retrying it.
  const { create } = await puente((real) => ({
    ...real,
    list: async () => (await real.list()).map((record) => record.endedAt === null ? { ...record, state: 'terminating' as const } : record),
  }));
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-stalled-1')).json.id;
  await revoke(PHONE);
  await until(async () => (await host.processes(unit(id))).length === 0, 'the revoked environment ended');
});

test('a termination the supervisor refused once is retried while the list still reads', async (t) => {
  const { puente, host, revoke, unit } = await lab(t);
  let refusals = 1;
  const { create } = await puente((real) => ({
    ...real,
    terminate: async (id) => { if (refusals-- > 0) throw new Error('unavailable'); return real.terminate(id); },
  }));
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-refused-1')).json.id;
  await revoke(PHONE);
  await until(async () => (await host.processes(unit(id))).length === 0, 'ended by the periodic retry');
});

test('revocation ends only own work: an environment shared with the device stays', async (t) => {
  const { puente, host, revoke, unit } = await lab(t);
  let shared = '';
  const { create } = await puente((real) => ({
    ...real,
    list: async () => (await real.list()).map((record) => record.id === shared ? { ...record, ownership: 'shared' as const } : record),
  }));
  host.children = [{ ignoresHangUp: true }];
  const own = (await create(PHONE, 'request-own-1')).json.id;
  shared = (await create(PHONE, 'request-shared-1')).json.id;
  await revoke(PHONE);
  await until(async () => (await host.processes(unit(own))).length === 0, 'the own environment ended');
  await sleep(RETRY_MS * 2);
  assert.equal((await host.processes(unit(shared))).length, 2);
});

test('a termination the device asked for that got no answer is confirmed without another request', async (t) => {
  const { puente, host, unit } = await lab(t);
  let unanswered = 1;
  const { create, terminate } = await puente((real) => ({
    ...real,
    terminate: async (id) => { if (unanswered-- > 0) throw new SupervisorUnreachable(); return real.terminate(id); },
  }));
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-unanswered-1')).json.id;
  assert.partialDeepStrictEqual((await terminate(PHONE, id)).json, { state: 'terminating', terminationError: 'supervisor_unreachable' });
  await until(async () => (await host.processes(unit(id))).length === 0, 'ended by the retry of the request');
});

test('a revocation while the record is being written: the environment never launches', async (t) => {
  const { puente, host, revoke } = await lab(t);
  let revokeNow = false;
  // Revocation lands after the durable record and before the Puente checks again.
  const { create, client } = await puente((real) => ({
    ...real,
    register: async (input) => { const result = await real.register(input); if (revokeNow) await revoke(PHONE); return result; },
  }));
  revokeNow = true;
  const response = await create(PHONE, 'request-race-1');
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'device_revoked');
  // The 403 is answered at the revocation; the creation still in flight ends its own record.
  await until(async () => (await client.list())[0]?.state === 'exited', 'the record ended');
  assert.deepEqual(host.launched, [], 'nothing was launched for a revoked device');
  const [record] = await client.list();
  assert.deepEqual([record!.state, record!.endedAt], ['exited', NOW]);
});

test('a revocation while launching: the environment is ended once launched', async (t) => {
  const { puente, host, revoke, unit } = await lab(t);
  const { create, client } = await puente();
  host.beforeLaunch = async () => { await revoke(PHONE); await sleep(20); };
  const response = await create(PHONE, 'request-race-2');
  assert.equal(response.status, 403);
  await until(async () => (await client.list())[0]?.state === 'exited', 'the launched environment ended');
  assert.equal(host.launched.length, 1);
  const [record] = await client.list();
  assert.deepEqual(await host.processes(unit(record!.id)), []);
});

test('a supervisor down during the revocation: the retry and the reconnection end the environments', async (t) => {
  const { puente, host, revoke, unit, stopSupervisor, startSupervisor, changes } = await lab(t);
  const { create } = await puente();
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-down-1')).json.id;
  await stopSupervisor();
  await revoke(PHONE);
  await sleep(RETRY_MS * 2);
  assert.equal((await host.processes(unit(id))).length, 2, 'nothing could end it while the supervisor was down');
  await startSupervisor();
  // No request arrives: the retry reconnects, and the reconnection reconciles.
  await until(async () => (await host.processes(unit(id))).length === 0, 'the revoked environment ended after the supervisor came back');
  await until(async () => (await changes()).includes(`terminated server ${id}`), 'recorded');
  assert.ok((await changes()).includes(`lost server ${id}`), 'the supervisor restart lost its PTY');
});

test('re-establishing the supervisor channel reconciles at once, without waiting for the retry', async (t) => {
  const { puente, host, revoke, unit, stopSupervisor, startSupervisor } = await lab(t, {}, 60_000);
  const { create, list } = await puente();
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-reconnect-1')).json.id;
  await stopSupervisor();
  await revoke(PHONE);
  // The reconciliation of the revocation finds no supervisor; its retry is a minute away.
  await sleep(100);
  assert.equal((await host.processes(unit(id))).length, 2);
  await startSupervisor();
  // Another device's request reconnects; the reconciliation runs on that connection.
  await list(TABLET);
  await until(async () => (await host.processes(unit(id))).length === 0, 'ended on reconnection');
});

test('a revocation while the Puente was down is reconciled when it starts, with no request', async (t) => {
  const { puente, host, revoke, unit } = await lab(t);
  const first = await puente();
  host.children = [{ ignoresHangUp: true }];
  const id = (await first.create(PHONE, 'request-startup-1')).json.id;
  first.close();
  await revoke(PHONE);
  await sleep(RETRY_MS * 2);
  assert.equal((await host.processes(unit(id))).length, 2, 'no Puente was running');
  await puente();
  await until(async () => (await host.processes(unit(id))).length === 0, 'ended at start');
});

test('a Puente restart finds its environments alive and launches no replacement', async (t) => {
  const { puente, host } = await lab(t);
  const first = await puente();
  const id = (await first.create(PHONE, 'request-restart-1')).json.id;
  first.close();
  const second = await puente();
  assert.deepEqual((await second.list(PHONE)).map((environment) => [environment.id, environment.state]), [[id, 'running']]);
  assert.equal((await second.create(PHONE, 'request-restart-1')).json.id, id);
  assert.equal(host.launched.length, 1);
});

test('after a supervisor restart a live environment is lost, not replaced, and still ends on request', async (t) => {
  const { puente, host, unit, stopSupervisor, startSupervisor } = await lab(t);
  const { create, list, terminate } = await puente();
  host.children = [{ ignoresHangUp: true }];
  const id = (await create(PHONE, 'request-lost-1')).json.id;
  await stopSupervisor();
  host.units.set(unit(id), host.units.get(unit(id))!.filter((process) => !process.main));
  await startSupervisor();
  assert.partialDeepStrictEqual(await list(PHONE), [{ id, state: 'lost', endedAt: null }]);
  assert.equal(host.launched.length, 1);
  assert.partialDeepStrictEqual((await terminate(PHONE, id)).json, { state: 'exited', exitCode: null, endedAt: NOW });
  assert.deepEqual(await host.processes(unit(id)), []);
});

test('a supervisor that stops answering mid-termination: terminating, then ended when it is back', async (t) => {
  const { puente, host, unit, stopSupervisor, startSupervisor, changes } = await lab(t);
  const { create, terminate, list } = await puente();
  host.children = [{ ignoresHangUp: true, ignoresTerm: true }];
  const id = (await create(PHONE, 'request-mid-1')).json.id;
  // The first termination is held right after its SIGTERM until the supervisor is stopped: stopped
  // mid-termination by construction, not by a grace long enough to win the race.
  const stopped = Promise.withResolvers<void>();
  const sigterm = host.terminate.bind(host);
  host.terminate = async (name) => { host.terminate = sigterm; await sigterm(name); await stopped.promise; };
  const pending = terminate(PHONE, id);
  await until(() => host.signals.includes(`${unit(id)} TERM`), 'termination started');
  await stopSupervisor();
  stopped.resolve();
  const answer = await pending;
  assert.equal(answer.status, 200);
  assert.partialDeepStrictEqual(answer.json, { id, state: 'terminating', terminationError: 'supervisor_unreachable', endedAt: null });
  await until(async () => (await changes()).includes(`terminate_failed server ${id}`), 'recorded as failed');
  assert.equal((await host.processes(unit(id))).length, 1);
  await startSupervisor();
  await until(async () => (await host.processes(unit(id))).length === 0, 'the persisted termination resumed');
  // Its event reaches the Puente only once it is connected to the new supervisor: the list after it
  // never races the reconnection.
  await until(async () => (await changes()).includes(`terminated server ${id}`), 'recorded as ended');
  assert.partialDeepStrictEqual(await list(PHONE), [{ id, state: 'exited', endedAt: NOW }]);
});

test('a Puente with a key that does not match the supervisor gets nothing', async (t) => {
  const { puente, runtime } = await lab(t);
  await fs.writeFile(path.join(runtime, 'supervisor.key'), 'not-the-key', { mode: 0o600 });
  const { create, client, call } = await puente();
  assert.deepEqual(await client.availability(), { state: 'unavailable', reason: 'helper_incompatible' });
  const created = await create(PHONE, 'request-key-1');
  assert.equal(created.status, 503);
  assert.equal(created.json.error.code, 'remote_unavailable');
  assert.equal((await call(PHONE, 'GET', '/v1/remote/environments')).json.error.code, 'remote_unavailable');
});

test('the Puente reads the supervisor key only from a private file', async (t) => {
  const { puente, runtime } = await lab(t);
  await fs.chmod(path.join(runtime, 'supervisor.key'), 0o644);
  const { client } = await puente();
  assert.deepEqual(await client.availability(), { state: 'unavailable', reason: 'helper_incompatible' });
  await fs.chmod(path.join(runtime, 'supervisor.key'), 0o600);
  assert.deepEqual(await client.availability(), { state: 'available' });
});

/** A process posing as the supervisor on the private socket: says `hello`, then answers each line. */
async function impostor(t: TestContext, hello: Record<string, unknown>, answer: (line: Record<string, unknown>, socket: net.Socket) => unknown = () => undefined) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-impostor-'));
  await fs.writeFile(path.join(runtime, 'supervisor.key'), 'the-key', { mode: 0o600 });
  const received: Record<string, unknown>[] = [];
  const closed = Promise.withResolvers<void>();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('close', () => closed.resolve());
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let index: number; (index = buffer.indexOf('\n')) !== -1; buffer = buffer.slice(index + 1)) {
        const line = JSON.parse(buffer.slice(0, index));
        received.push(line);
        const reply = answer(line, socket);
        if (reply) socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
    socket.write(`${JSON.stringify({ type: 'hello', ...hello })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(path.join(runtime, 'supervisor.sock'), resolve));
  const client = createSupervisorClient({ runtimeDirectory: runtime, timeoutMs: 300 });
  t.after(async () => { client.close(); server.close(); await fs.rm(runtime, { recursive: true, force: true }); });
  return { client, received, closed: closed.promise };
}

test('the Puente sends neither its key nor any operation to a supervisor of an incompatible version', async (t) => {
  for (const hello of [{ supervisorProtocol: MIN_SUPERVISOR_PROTOCOL - 1, minPuenteProtocol: 1 }, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL + 1 }]) {
    const { client, received } = await impostor(t, hello);
    assert.deepEqual(await client.availability(), { state: 'unavailable', reason: 'helper_incompatible' }, JSON.stringify(hello));
    await assert.rejects(client.list(), (error: Error) => error instanceof SupervisorUnreachable && error.reason === 'helper_incompatible');
    assert.deepEqual(received, [], 'nothing left the Puente');
  }
});

test('a version 2 supervisor keeps serving terminals and never receives a browser operation', async (t) => {
  const { client, received } = await impostor(t, { supervisorProtocol: BROWSER_SUPERVISOR_PROTOCOL - 1, minPuenteProtocol: 2 }, (line) => {
    if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
    return { type: 'response', id: line.id, ok: true, environments: [] };
  });
  assert.deepEqual(await client.availability(), { state: 'available' });
  assert.deepEqual(await client.browser.availability(), { state: 'unavailable', reason: 'helper_incompatible' });
  const target = { environmentId: 'env_AAAAAAAAAAAAAAAAAAAAAA', deviceId: PHONE.id };
  for (const operation of [client.browser.tabs(target), client.browser.openTab(target, null), client.browser.act(target, 'T1', { type: 'reload' })]) {
    await assert.rejects(operation, (error: Error) => error instanceof SupervisorUnreachable && error.reason === 'helper_incompatible');
  }
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(received.map((line) => line.type ?? line.op), ['auth', 'list'], 'only the auth and the terminal-era list left the Puente');
});

test('a frame at the size limit fits a supervisor line, and a read of two keeps the channel open', async (t) => {
  const data = 'A'.repeat(Math.ceil(REMOTE_LIMITS.browserFrameBytes / 3) * 4);
  const frame = (channel: string) => ({ channel, type: 'frame', seq: 1, tab: 'T1', data, viewport: { width: 412, height: 800 } });
  const { client } = await impostor(t, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL }, (line, socket) => {
    if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
    socket.write(`${JSON.stringify(frame('a'.repeat(22)))}\n${JSON.stringify(frame('b'.repeat(22)))}\n`);
    return { type: 'response', id: line.id, ok: true, environments: [] };
  });
  const seen: string[] = [];
  client.onChannel((event) => seen.push(event.channel));
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(seen, ['a'.repeat(22), 'b'.repeat(22)]);
  assert.deepEqual(await client.list(), [], 'still connected');
});

test('the line limit measures a line: one just under it keeps the channel even when the next arrives in the same read', async (t) => {
  const { client } = await impostor(t, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL }, (line, socket) => {
    if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
    const answer = JSON.stringify({ type: 'response', id: line.id, ok: true, environments: [] }).slice(0, -1);
    const long = `${answer},"padding":"${'x'.repeat(SUPERVISOR_LINE_BYTES - answer.length - 100)}"}`;
    socket.write(`${long}\n${JSON.stringify({ type: 'response', id: 0, ok: true, padding: 'y'.repeat(70_000) })}\n`);
  });
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(await client.list(), [], 'still connected');
});

test('a tab list at its limits fits a supervisor line; a tab or a list beyond them is never shown', async (t) => {
  // Escaped in JSON, each control character takes six: the longest line a bounded list can make.
  const worst = (chars: number) => '\u0001'.repeat(chars);
  const tab = (index: number, extra = {}) => ({
    id: String(index).padStart(64, 'T'), url: worst(BROWSER_LIMITS.urlChars), title: worst(BROWSER_LIMITS.titleChars), limitation: 'canceled_by_user', createdByRelay: true,
    dialog: { type: 'beforeunload', message: worst(BROWSER_LIMITS.textChars), defaultPrompt: worst(BROWSER_LIMITS.textChars) }, fileChooser: { multiple: true }, ...extra,
  });
  const full = Array.from({ length: BROWSER_LIMITS.dedicatedTabs }, (_, index) => tab(index));
  const target = { environmentId: 'env_AAAAAAAAAAAAAAAAAAAAAA', deviceId: PHONE.id };
  const lines: number[] = [];
  for (const [label, tabs] of [
    ['at the limits', full], ['url', [tab(0, { url: worst(BROWSER_LIMITS.urlChars + 1) })]], ['title', [tab(0, { title: worst(BROWSER_LIMITS.titleChars + 1) })]],
    ['dialog', [tab(0, { dialog: { type: 'alert', message: worst(BROWSER_LIMITS.textChars + 1), defaultPrompt: '' } })]], ['count', [...full, tab(BROWSER_LIMITS.dedicatedTabs)]],
    ['limitation', [tab(0, { limitation: 'cookies' })]],
  ] as const) {
    const { client } = await impostor(t, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL }, (line) => {
      if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
      const response = { type: 'response', id: line.id, ok: true, tabs };
      lines.push(JSON.stringify(response).length);
      return response;
    });
    if (label === 'at the limits') assert.equal((await client.browser.tabs(target)).length, BROWSER_LIMITS.dedicatedTabs);
    else await assert.rejects(client.browser.tabs(target), (error: Error) => error instanceof SupervisorUnreachable && error.reason === 'helper_incompatible', label);
  }
  assert.ok(lines[0]! < SUPERVISOR_LINE_BYTES, `${lines[0]} characters`);
});

test('a record that is not exactly an environment record closes the channel and is never acted upon', async (t) => {
  const { client, closed } = await impostor(t, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL }, (line) => {
    if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
    return {
      type: 'response', id: line.id, ok: true,
      environments: [{ id: 'env_AAAAAAAAAAAAAAAAAAAAAA', deviceId: PHONE.id, kind: 'terminal', ownership: 'own', requestId: 'request-1', createdAt: 1, state: 'running', exitCode: null, endedAt: null, pid: 1 }],
    };
  });
  await assert.rejects(client.list(), (error: Error) => error instanceof SupervisorUnreachable && error.reason === 'helper_incompatible');
  await closed;
});

test('a supervisor line split inside a UTF-8 character reaches the Puente whole', async (t) => {
  const environment = { id: 'env_AAAAAAAAAAAAAAAAAAAAAA', deviceId: PHONE.id, kind: 'terminal', ownership: 'own', requestId: 'request-1', createdAt: 1, state: 'running', exitCode: null, endedAt: null, terminal: { shell: '/bin/sh', cwd: '/tmp/año' } };
  const { client } = await impostor(t, { supervisorProtocol: PUENTE_SUPERVISOR_PROTOCOL, minPuenteProtocol: PUENTE_SUPERVISOR_PROTOCOL }, (line, socket) => {
    if (line.type === 'auth') return { type: 'ready', availability: { state: 'available' } };
    const bytes = Buffer.from(`${JSON.stringify({ type: 'response', id: line.id, ok: true, environments: [environment] })}\n`);
    const cut = bytes.indexOf(Buffer.from('ñ')) + 1;
    socket.write(bytes.subarray(0, cut));
    // A real pause between the two writes: only then are they two reads on the Puente's side.
    setTimeout(() => socket.write(bytes.subarray(cut)), 20);
  });
  assert.deepEqual(await client.list(), [environment]);
});
