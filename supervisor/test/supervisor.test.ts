import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { RegisterInput } from '../../protocol/supervisor.ts';
import { REGISTRY_FILE, RegistryError } from '../src/registry.ts';
import { openSupervisor, SupervisorFailure, type Supervisor, type SupervisorOptions } from '../src/supervisor.ts';
import { FakeHost } from '../support/fakeHost.ts';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TIMING = { terminateGraceMs: 30, terminateGiveUpMs: 60, terminateRetryMs: 40, pollMs: 5, sweepMs: 10 };
const SHELLS = fileURLToPath(new URL('./fixtures/shells', import.meta.url));
const TERMINAL = { shell: '/bin/sh', cwd: os.tmpdir() };
let counter = 0;
const envId = () => `env_${String(++counter).padStart(22, 'A')}`;
const input = (extra: Partial<RegisterInput> = {}): RegisterInput => ({ id: envId(), deviceId: DEVICE, kind: 'terminal', requestId: `request-${counter}-x`, createdAt: 1000, terminal: TERMINAL, ...extra });

async function setup(t: TestContext, extra: Partial<SupervisorOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-supervisor-'));
  const host = new FakeHost();
  const opened: Supervisor[] = [];
  const open = async (more: Partial<SupervisorOptions> = {}) => {
    const supervisor = await openSupervisor({ directory, host, unitPrefix: 'relay-test', shellsFile: SHELLS, now: () => 5000, timing: TIMING, ...extra, ...more });
    opened.push(supervisor);
    return supervisor;
  };
  t.after(async () => {
    for (const supervisor of opened) await supervisor.close();
    await fs.chmod(directory, 0o700).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const unit = (id: string) => `relay-test-${id}`;
  const onDisk = async () => JSON.parse(await fs.readFile(path.join(directory, REGISTRY_FILE), 'utf8')).environments;
  return { directory, host, open, unit, onDisk };
}

async function create(supervisor: Supervisor, extra: Partial<RegisterInput> = {}) {
  const { environment } = await supervisor.register(input(extra));
  return supervisor.launch(environment.id);
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { if (error instanceof SupervisorFailure) return error.code; throw error; }
  assert.fail('expected a SupervisorFailure');
};

test('the durable record exists on disk before the process is launched', async (t) => {
  const { host, open, onDisk } = await setup(t);
  const supervisor = await open();
  const seen: unknown[] = [];
  host.beforeLaunch = async () => { seen.push(...await onDisk()); };
  const registered = await supervisor.register(input());
  assert.equal(registered.created, true);
  assert.equal(registered.environment.state, 'starting');
  const running = await supervisor.launch(registered.environment.id);
  assert.equal(running.state, 'running');
  assert.deepEqual(seen, [{ ...registered.environment }]);
  assert.equal((await onDisk())[0].state, 'running');
});

test('without a durable record nothing is launched', async (t) => {
  const { host, open, directory } = await setup(t);
  const supervisor = await open();
  await fs.chmod(directory, 0o500);
  const request = input();
  assert.equal(await failure(supervisor.register(request)), 'unavailable');
  assert.deepEqual(supervisor.list(), []);
  assert.equal(await failure(supervisor.launch(request.id)), 'not_found');
  assert.deepEqual(host.launched, []);
});

test('a repeated requestId answers the same environment; another body conflicts', async (t) => {
  const { host, open } = await setup(t);
  const supervisor = await open();
  const first = await supervisor.register(input({ requestId: 'same-request' }));
  const again = await supervisor.register(input({ requestId: 'same-request' }));
  assert.equal(again.created, false);
  assert.equal(again.environment.id, first.environment.id);
  assert.equal(await failure(supervisor.register(input({ requestId: 'same-request', kind: 'browser_dedicated' }))), 'conflict');
  // The requestId belongs to its device.
  const other = await supervisor.register(input({ requestId: 'same-request', deviceId: OTHER }));
  assert.equal(other.created, true);
  await supervisor.launch(first.environment.id);
  await supervisor.launch(first.environment.id);
  assert.equal(host.launched.length, 1);
});

test('live limits reject creation and never end another environment', async (t) => {
  const { host, open } = await setup(t, { limits: { liveEnvironmentsPerDevice: 2, liveEnvironmentsTotal: 3 } });
  const supervisor = await open();
  const first = await create(supervisor);
  await create(supervisor);
  assert.equal(await failure(supervisor.register(input())), 'limit');
  await create(supervisor, { deviceId: OTHER });
  assert.equal(await failure(supervisor.register(input({ deviceId: OTHER }))), 'limit');
  assert.deepEqual(host.signals, []);
  await supervisor.terminate(first.id);
  assert.equal((await supervisor.register(input())).created, true);
});

test('terminating hangs up and sends SIGTERM, then cgroup.kill only after the grace', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true }, { ignoresHangUp: true, ignoresTerm: true }];
  const environment = await create(supervisor);
  const outside = 'relay-test-outside';
  host.outside(outside, 2);
  const started = Date.now();
  const ended = await supervisor.terminate(environment.id);
  assert.ok(Date.now() - started >= TIMING.terminateGraceMs, 'cgroup.kill waits for the grace');
  assert.deepEqual(host.signals, [`${unit(environment.id)} HUP`, `${unit(environment.id)} TERM`, `${unit(environment.id)} KILL`]);
  assert.equal(ended.state, 'exited');
  assert.equal(ended.exitCode, null);
  assert.equal(ended.endedAt, 5000);
  assert.deepEqual(await host.processes(unit(environment.id)), []);
  // Only its own cgroup: what was not started inside it is never signalled.
  assert.equal((await host.processes(outside)).length, 2);
  assert.deepEqual(supervisor.takeEvents(), [{ type: 'event', action: 'terminated', environmentId: environment.id }]);
  // Idempotent: the real final state again, no new signal.
  assert.deepEqual(await supervisor.terminate(environment.id), ended);
  assert.equal(host.signals.length, 3);
});

test('an environment that empties with SIGTERM never gets cgroup.kill', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true }];
  const environment = await create(supervisor);
  assert.equal((await supervisor.terminate(environment.id)).state, 'exited');
  assert.deepEqual(host.signals, [`${unit(environment.id)} HUP`, `${unit(environment.id)} TERM`]);
});

test('a jump of the wall clock never shortens the grace before cgroup.kill', async (t) => {
  const { host, open } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true, ignoresTerm: true }];
  const environment = await create(supervisor);
  const wall = Date.now;
  let jumps = 0;
  Date.now = () => wall() + ++jumps * 3_600_000;
  t.after(() => { Date.now = wall; });
  const started = performance.now();
  assert.equal((await supervisor.terminate(environment.id)).state, 'exited');
  assert.ok(performance.now() - started >= TIMING.terminateGraceMs, 'cgroup.kill still waited for the grace');
});

test('never exited while a process remains: terminating with an error, retried until it empties', async (t) => {
  const { host, open, unit, onDisk } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true, ignoresTerm: true, unkillable: true }];
  const environment = await create(supervisor);
  const stuck = await supervisor.terminate(environment.id);
  assert.equal(stuck.state, 'terminating');
  assert.equal(stuck.terminationError, 'processes_remaining');
  assert.equal(stuck.endedAt, null);
  assert.equal((await onDisk())[0].state, 'terminating');
  assert.deepEqual(supervisor.takeEvents(), [{ type: 'event', action: 'terminate_failed', environmentId: environment.id }]);
  await sleep(TIMING.terminateRetryMs * 2);
  assert.equal(supervisor.list()[0]!.state, 'terminating', 'the retry still finds the process');
  for (const process of host.units.get(unit(environment.id))!) process.unkillable = false;
  await sleep(TIMING.terminateRetryMs * 2);
  assert.equal(supervisor.list()[0]!.state, 'exited');
  assert.equal(supervisor.list()[0]!.terminationError, undefined);
});

test('a host failure in the middle of a termination is retried until the cgroup empties', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  let failures = 1;
  const kill = host.kill.bind(host);
  host.kill = async (name) => { if (failures-- > 0) throw Object.assign(new Error('cgroup.kill'), { code: 'EACCES' }); return kill(name); };
  host.children = [{ ignoresHangUp: true, ignoresTerm: true }];
  const environment = await create(supervisor);
  const stuck = await supervisor.terminate(environment.id);
  assert.deepEqual([stuck.state, stuck.terminationError, stuck.endedAt], ['terminating', 'processes_remaining', null]);
  await sleep(TIMING.terminateRetryMs * 3);
  assert.deepEqual(await host.processes(unit(environment.id)), []);
  assert.equal(supervisor.list()[0]!.state, 'exited');
});

test('a registry that cannot be written never holds back the signals of a termination', async (t) => {
  const { host, open, unit, directory } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true }];
  const environment = await create(supervisor);
  await fs.chmod(directory, 0o500);
  const ended = await supervisor.terminate(environment.id);
  assert.deepEqual(host.signals, [`${unit(environment.id)} HUP`, `${unit(environment.id)} TERM`]);
  assert.deepEqual(await host.processes(unit(environment.id)), []);
  assert.deepEqual([ended.state, ended.terminationError], ['exited', undefined]);
  assert.deepEqual(supervisor.takeEvents().map((event) => event.action), ['terminated']);
  await fs.chmod(directory, 0o700);
});

test('a main process that exits leaves the environment running until its cgroup empties', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  host.children = [{}];
  const environment = await create(supervisor);
  host.exit(unit(environment.id), 3);
  await sleep(TIMING.sweepMs * 3);
  assert.equal(supervisor.list()[0]!.state, 'running');
  assert.equal(supervisor.list()[0]!.endedAt, null);
  host.units.delete(unit(environment.id));
  await sleep(TIMING.sweepMs * 3);
  assert.deepEqual([supervisor.list()[0]!.state, supervisor.list()[0]!.exitCode], ['exited', 3]);
  host.children = [];
  const alone = await create(supervisor);
  host.exit(unit(alone.id), 0);
  await sleep(TIMING.sweepMs * 3);
  assert.deepEqual([supervisor.list()[1]!.state, supervisor.list()[1]!.exitCode], ['exited', 0]);
});

test('after a supervisor restart nothing is relaunched or adopted; live cgroups stay lost and terminable', async (t) => {
  const { host, open, unit } = await setup(t);
  const first = await open();
  host.children = [{ ignoresHangUp: true }];
  const alive = await create(first);
  const gone = await create(first);
  const pending = await first.register(input());
  await first.close();
  // The supervisor died: its PTYs closed; what ignores SIGHUP is still in its cgroup.
  host.units.delete(unit(gone.id));
  host.outside('relay-test-env_unrecordedAAAAAAAAAAAAAAAAA');
  const launches = host.launched.length;
  const second = await open();
  const byId = Object.fromEntries(second.list().map((record) => [record.id, record]));
  assert.deepEqual([byId[alive.id]!.state, byId[alive.id]!.endedAt], ['lost', null]);
  assert.deepEqual([byId[gone.id]!.state, byId[gone.id]!.endedAt], ['lost', 5000]);
  assert.deepEqual([byId[pending.environment.id]!.state, byId[pending.environment.id]!.endedAt], ['lost', 5000]);
  assert.equal(second.list().length, 3, 'an unrecorded cgroup is not adopted');
  assert.equal(host.launched.length, launches, 'nothing is relaunched');
  assert.equal(await failure(second.discard(alive.id)), 'alive');
  const ended = await second.terminate(alive.id);
  assert.deepEqual([ended.state, ended.exitCode], ['exited', null]);
  assert.equal((await host.processes('relay-test-env_unrecordedAAAAAAAAAAAAAAAAA')).length, 1);
  assert.deepEqual(second.takeEvents().map((event) => event.action).sort(), ['lost', 'lost', 'lost', 'terminated']);
});

test('after a Server restart every live environment is lost and ended', async (t) => {
  const { host, open } = await setup(t);
  const first = await open();
  const environment = await create(first);
  await first.close();
  host.reboot();
  const second = await open();
  assert.deepEqual(second.list().map((record) => [record.id, record.state, record.endedAt]), [[environment.id, 'lost', 5000]]);
});

test('a termination interrupted by a supervisor restart resumes on start', async (t) => {
  const { host, open } = await setup(t);
  const first = await open();
  host.children = [{ ignoresHangUp: true, ignoresTerm: true, unkillable: true }];
  const environment = await create(first);
  await first.terminate(environment.id);
  await first.close();
  for (const process of [...host.units.values()].flat()) process.unkillable = false;
  const second = await open();
  await sleep(TIMING.terminateGiveUpMs);
  assert.equal(second.list()[0]!.state, 'exited');
});

test('once closed it neither signals nor writes: a termination in flight stops where it was', async (t) => {
  const { host, open, unit, onDisk } = await setup(t);
  const supervisor = await open();
  host.children = [{ ignoresHangUp: true, ignoresTerm: true }];
  const environment = await create(supervisor);
  const signalled = Promise.withResolvers<void>();
  const terminate = host.terminate.bind(host);
  host.terminate = async (name) => { await terminate(name); signalled.resolve(); };
  const pending = supervisor.terminate(environment.id);
  // Stopped while the termination waits for the cgroup to empty. The process exits after close (a
  // test removes the directory): the start after it resumes the termination from the disk.
  await signalled.promise;
  await supervisor.close();
  const closed = await onDisk();
  await pending;
  assert.deepEqual(host.signals, [`${unit(environment.id)} HUP`, `${unit(environment.id)} TERM`]);
  assert.equal((await host.processes(unit(environment.id))).length, 1);
  assert.deepEqual(await onDisk(), closed);
  assert.equal(closed[0].state, 'terminating');
});

test('a corrupt registry stops the supervisor and is left untouched', async (t) => {
  const { open, directory } = await setup(t);
  const file = path.join(directory, REGISTRY_FILE);
  const valid = { id: 'env_AAAAAAAAAAAAAAAAAAAAAA', deviceId: DEVICE, kind: 'terminal', ownership: 'own', requestId: 'request-1', createdAt: 1, state: 'running', exitCode: null, endedAt: null, terminal: TERMINAL };
  const { terminal: _, ...withoutTerminal } = valid;
  for (const content of [
    '{"version":1,"environments":[', 'null', '{"version":2,"environments":[]}',
    JSON.stringify({ version: 1, environments: [{ ...valid, state: 'exited' }] }),
    JSON.stringify({ version: 1, environments: [{ ...valid, id: 'term_AAAAAAAAAAAAAAAAAAAAAA' }] }),
    JSON.stringify({ version: 1, environments: [{ ...valid, extra: true }] }),
    JSON.stringify({ version: 1, environments: [withoutTerminal] }),
    JSON.stringify({ version: 1, environments: [{ ...valid, terminal: { ...TERMINAL, cwd: 'relative' } }] }),
    JSON.stringify({ version: 1, environments: [valid, { ...valid, requestId: 'request-2' }] }),
    JSON.stringify({ version: 1, environments: [valid, { ...valid, id: 'env_BBBBBBBBBBBBBBBBBBBBBB' }] }),
  ]) {
    await fs.writeFile(file, content, { mode: 0o600 });
    await assert.rejects(open(), RegistryError, content);
    assert.equal(await fs.readFile(file, 'utf8'), content);
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, environments: [valid] }));
  await fs.chmod(file, 0o644);
  await assert.rejects(open(), RegistryError);
  await fs.chmod(file, 0o600);
  assert.equal((await open()).list()[0]!.id, valid.id);
});

test('over the ended limit the oldest ended record goes, with its event', async (t) => {
  let clock = 100;
  const { open } = await setup(t, { now: () => clock++, limits: { endedEnvironmentsPerDevice: 2 } });
  const supervisor = await open();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const environment = await create(supervisor);
    ids.push(environment.id);
    await supervisor.terminate(environment.id);
  }
  const live = await create(supervisor);
  assert.deepEqual(supervisor.list().map((record) => record.id), [ids[1], ids[2], live.id]);
  assert.deepEqual(supervisor.takeEvents().filter((event) => event.action === 'discarded'), [{ type: 'event', action: 'discarded', environmentId: ids[0] }]);
});

test('discarding needs an ended environment', async (t) => {
  const { open } = await setup(t);
  const supervisor = await open();
  const environment = await create(supervisor);
  assert.equal(await failure(supervisor.discard(environment.id)), 'alive');
  await supervisor.terminate(environment.id);
  await supervisor.discard(environment.id);
  assert.deepEqual(supervisor.list(), []);
  assert.equal(await failure(supervisor.discard(environment.id)), 'not_found');
});

test('a failed launch ends the record instead of leaving it starting', async (t) => {
  const { host, open } = await setup(t);
  const supervisor = await open();
  host.failLaunch = true;
  const { environment } = await supervisor.register(input());
  assert.equal(await failure(supervisor.launch(environment.id)), 'launch_failed');
  assert.deepEqual([supervisor.list()[0]!.state, supervisor.list()[0]!.endedAt], ['exited', 5000]);
});

test('a terminal runs an installed shell in an existing folder the account can enter', async (t) => {
  const { host, open, unit, directory } = await setup(t);
  const supervisor = await open();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-cwd-Música-'));
  const running = await create(supervisor, { terminal: { shell: '/bin/sh', cwd: folder } });
  assert.equal(host.cwds.get(unit(running.id)), folder);
  assert.deepEqual(running.terminal, { shell: '/bin/sh', cwd: folder });

  const locked = path.join(folder, 'locked');
  await fs.mkdir(locked, { mode: 0o000 });
  t.after(async () => { await fs.chmod(locked, 0o700); await fs.rm(folder, { recursive: true, force: true }); });
  for (const [terminal, code] of [
    [{ shell: '/bin/bash-not-listed', cwd: folder }, 'invalid'],
    [{ shell: '/bin/sh', cwd: path.join(folder, 'missing') }, 'not_found'],
    [{ shell: '/bin/sh', cwd: path.join(directory, 'environments.json') }, 'not_found'],
    [{ shell: '/bin/sh', cwd: path.join(locked, 'inside') }, 'permission'],
    [{ shell: '/bin/sh', cwd: locked }, 'permission'],
  ] as const) {
    assert.equal(await failure(supervisor.register(input({ terminal }))), code, JSON.stringify(terminal));
  }
  assert.equal(await failure(supervisor.register(input({ terminal: undefined }))), 'invalid', 'a terminal without its shell and folder');
  assert.equal(host.launched.length, 1, 'nothing else was launched');
  assert.equal(supervisor.list().length, 1, 'nothing else was recorded');
});

test('the same requestId with another shell or folder is a conflict, never another terminal', async (t) => {
  const { open } = await setup(t);
  const supervisor = await open();
  const first = input();
  await supervisor.register(first);
  assert.equal((await supervisor.register({ ...first, id: envId() })).created, false);
  assert.equal(await failure(supervisor.register({ ...first, id: envId(), terminal: { shell: '/bin/sh', cwd: '/' } })), 'conflict');
});

test('the shells are the listed ones that can run, and the home folder', async (t) => {
  const { open, directory } = await setup(t);
  const list = path.join(directory, 'shells');
  await fs.writeFile(list, '# comment\n/bin/sh\n/bin/sh\n/nonexistent/shell\nrelative\n\n');
  const supervisor = await open({ shellsFile: list });
  assert.deepEqual((await supervisor.shells()).shells, ['/bin/sh']);
  assert.equal((await supervisor.shells()).home, os.homedir());
});

test('a terminal answers only the device that owns it; another device gets not_found', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  const events: unknown[] = [];
  supervisor.onChannel((event) => events.push(event));
  const own = { environmentId: (await create(supervisor)).id, deviceId: DEVICE };
  const foreign = { ...own, deviceId: OTHER };
  const pty = host.ptys.get(unit(own.environmentId))!;
  for (const attempt of [
    () => supervisor.attach(foreign, 'AAAAAAAAAAAAAAAAAAAAAA', 0),
    () => supervisor.input(foreign, 1, Buffer.from('rm -rf ~\r')),
    () => supervisor.resize(foreign, 10, 10, false),
    () => supervisor.ack(foreign, 'AAAAAAAAAAAAAAAAAAAAAA', 0),
    () => supervisor.detach(foreign, 'AAAAAAAAAAAAAAAAAAAAAA'),
    () => supervisor.attach({ environmentId: 'env_doesNotExistAAAAAAAAAA', deviceId: DEVICE }, 'AAAAAAAAAAAAAAAAAAAAAA', 0),
  ]) {
    assert.throws(attempt, (error: unknown) => error instanceof SupervisorFailure && error.code === 'not_found');
  }
  assert.deepEqual([pty.written, pty.sizes, events], [[], [], []]);
  assert.equal(supervisor.input(own, 1, Buffer.from('ls\r')), 1);
  assert.deepEqual(pty.written.map(String), ['ls\r']);
});

test('the output reaches the attached channel; when the Puente goes away the program keeps running', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  const events: { type: string; channel: string }[] = [];
  supervisor.onChannel((event) => events.push(event));
  const target = { environmentId: (await create(supervisor)).id, deviceId: DEVICE };
  const pty = host.ptys.get(unit(target.environmentId))!;
  supervisor.attach(target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
  pty.output(Buffer.from('hola'));
  assert.deepEqual(events.map((event) => event.type), ['opened', 'output']);
  supervisor.detachAll();
  pty.output(Buffer.alloc(4 * 1024 * 1024));
  assert.equal(pty.paused, false, 'nobody looks and the program still runs');
  assert.equal(events.length, 2);
  assert.equal(host.signals.length, 0, 'losing the transport ends nothing');
});

test('an ended terminal delivers its last frames, then answers ended', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  const events: { type: string }[] = [];
  supervisor.onChannel((event) => events.push(event));
  const target = { environmentId: (await create(supervisor)).id, deviceId: DEVICE };
  supervisor.attach(target, 'AAAAAAAAAAAAAAAAAAAAAA', 0);
  host.ptys.get(unit(target.environmentId))!.output(Buffer.from('bye'));
  host.exit(unit(target.environmentId), 0);
  await sleep(TIMING.sweepMs);
  assert.deepEqual(events.map((event) => event.type), ['opened', 'output', 'closed']);
  assert.throws(() => supervisor.attach(target, 'BBBBBBBBBBBBBBBBBBBBBB', 0), (error: unknown) => error instanceof SupervisorFailure && error.code === 'ended');
  assert.throws(() => supervisor.input(target, 1, Buffer.from('x')), (error: unknown) => error instanceof SupervisorFailure && error.code === 'ended');
});

test('a failed launch that left processes in its cgroup ends them before it is exited', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  // As systemd-run timing out after the program started a daemon in the scope.
  const launch = host.launch.bind(host);
  host.launch = async (name, argv, cwd) => { await launch(name, argv, cwd); throw new Error('not seen in its cgroup in time'); };
  host.children = [{ ignoresHangUp: true }];
  const { environment } = await supervisor.register(input());
  assert.equal(await failure(supervisor.launch(environment.id)), 'launch_failed');
  assert.deepEqual(await host.processes(unit(environment.id)), []);
  assert.equal(supervisor.list()[0]!.state, 'exited');
});

test('a failed launch whose cgroup cannot be read is ended as if processes were left', async (t) => {
  const { host, open, unit } = await setup(t);
  const supervisor = await open();
  const launch = host.launch.bind(host);
  const processes = host.processes.bind(host);
  let unreadable = false;
  host.launch = async (name, argv, cwd) => { await launch(name, argv, cwd); unreadable = true; throw new Error('not seen in its cgroup in time'); };
  host.processes = async (name) => { if (unreadable) { unreadable = false; throw new Error('EIO'); } return processes(name); };
  const { environment } = await supervisor.register(input());
  assert.equal(await failure(supervisor.launch(environment.id)), 'launch_failed');
  assert.deepEqual(await host.processes(unit(environment.id)), []);
  assert.equal(supervisor.list()[0]!.state, 'exited');
});
