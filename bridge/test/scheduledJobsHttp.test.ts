import { StateError } from '../src/changeLog.ts';
import { realExec } from '../src/exec.ts';
import { RealHermes } from '../src/hermes_real.ts';
import { createHermesHome } from '../support/hermes_home.ts';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
const KEY = `rly1_${Buffer.alloc(32, 19).toString('base64url')}`;
async function start(t: TestContext, manager?: import('../src/jobsManager.ts').JobsManager) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-jobs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory });
  await store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000019', name: 'phone', pairedAt: 1700000000000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  const calls: unknown[] = [];
  Object.assign(hermes, { jobsManager: {
      list: async (agent: string) => { calls.push(['list', agent]); return { agentId: agent, timezone: 'America/Mexico_City', jobs: [] }; },
    } });
  if (manager)
    Object.assign(hermes, { jobsManager: manager });
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() { } } });
  const logs: string[] = [];
  const server = createApp({ config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://fixture.example.ts.net', serverName: 'fixture' }), hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: l => logs.push(l) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const call = async (method: string, route: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  return { call, calls, hermes, store, directory, logs };
}
test('jobs list is scoped to the exact known Agente', async (t) => {
  const { call, calls } = await start(t);
  assert.equal((await call('GET', '/v1/agents/default/jobs')).status, 200);
  assert.deepEqual(calls, [['list', 'default']]);
  assert.equal((await call('GET', '/v1/agents/missing/jobs')).status, 404);
  assert.equal(calls.length, 1);
});
const input = { name: 'Resumen privado', prompt: 'Contenido privado', schedule: 'every 30m', deliver: 'local', skills: [], repeat: null };
test('writes preserve the previous file and audit before forwarding; reject hidden fields', async (t) => {
  const { call, hermes, store, directory, logs } = await start(t);
  const writes: unknown[] = [];
  Object.assign((hermes as any).jobsManager, {
    snapshot: async () => Buffer.from('{"jobs":[{"prompt":"previous private"}]}').toString('base64'),
    create: async (agent: string, body: unknown) => {
      const files = await fs.readdir(directory);
      assert.ok(files.some(f => f.startsWith('jobs-version-')));
      const previousFile = files.find(f => f.startsWith('jobs-version-'))!;
      const previous = JSON.parse(await fs.readFile(path.join(directory, previousFile), 'utf8'));
      assert.equal((await fs.stat(path.join(directory, previousFile))).mode & 0o777, 0o600);
      assert.equal(Buffer.from(previous.previous, 'base64').toString('utf8'), '{"jobs":[{"prompt":"previous private"}]}');
      const log = await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8');
      assert.match(log, /job.create.requested/);
      assert.doesNotMatch(log, /Contenido privado|previous private|Resumen privado/);
      writes.push([agent, body]);
      return { id: 'abcdef123456', agentId: agent, ...input };
    }
  });
  assert.equal((await call('POST', '/v1/agents/default/jobs', { ...input, script: 'hidden' })).status, 400);
  assert.equal(writes.length, 0);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 201);
  assert.deepEqual(writes, [['default', input]]);
  assert.doesNotMatch(logs.join('\n'), /Contenido privado|Resumen privado/);
  await store.mutate(s => { s.devices[0].revokedAt = Date.now(); });
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 403);
  assert.equal(writes.length, 1);
});
test('all mutation routes and history preserve agent/job scope and reject action payloads', async (t) => {
  const { call, hermes } = await start(t);
  const calls: unknown[] = [];
  const job = { id: 'abcdef123456', agentId: 'default', ...input };
  Object.assign((hermes as any).jobsManager, { snapshot: async () => null,
    get: async (a: string, j: string) => { calls.push(['get', a, j]); return job; },
    history: async (a: string, j: string, o: number) => { calls.push(['history', a, j, o]); return { executions: [], hasMore: false }; },
    edit: async (a: string, j: string, b: unknown) => { calls.push(['edit', a, j, b]); return job; },
    delete: async (a: string, j: string) => { calls.push(['delete', a, j]); },
    action: async (a: string, j: string, action: string) => { calls.push([action, a, j]); return job; },
  });
  const route = '/v1/agents/default/jobs/abcdef123456';
  assert.equal((await call('GET', route)).status, 200);
  assert.equal((await call('GET', route + '/history?offset=50')).status, 200);
  assert.equal((await call('PATCH', route, input)).status, 200);
  for (const action of ['pause', 'resume', 'run'])
    assert.equal((await call('POST', route + '/' + action, {})).status, 200);
  assert.equal((await call('POST', route + '/run', { prompt: 'hidden' })).status, 400);
  assert.equal((await call('DELETE', route, {})).status, 200);
  assert.ok(calls.every(c => (c as string[])[1] === 'default' && (c as string[])[2] === 'abcdef123456'));
  assert.deepEqual(calls[1], ['history', 'default', 'abcdef123456', 50]);
});
test('real adapter reads minutes, offsets and ledger chronologically without touching another profile', async (t) => {
  const home = createHermesHome();
  t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/New_York\ngateway:\n  multiplex_profiles: true\n');
  home.write('profiles/coding/config.yaml', 'timezone: Asia/Tokyo\n');
  home.write('profiles/coding/cron/jobs.json', '{"jobs":[]}');
  const dbPath = path.join(home.home, 'profiles/coding/cron/executions.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE executions(id TEXT PRIMARY KEY,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT,delivery_outcome TEXT,scheduled_instant TEXT)");
  const insert = db.prepare('INSERT INTO executions VALUES(?,?,?,?,NULL,NULL,?,?)');
  insert.run('older', 'abcdef123456', 'failed', '2026-11-01T01:55:00-04:00', 'failed', null);
  insert.run('newer', 'abcdef123456', 'completed', '2026-11-01T01:05:00-05:00', 'delivered', '2026-11-01T06:00:00Z');
  insert.run('z-tie', 'abcdef123456', 'running', '2026-11-01T06:05:00Z', null, null);
  insert.run('other', '000000000000', 'claimed', '2027-01-01T00:00:00Z', null, null);
  db.close();
  const before = await fs.readFile(dbPath);
  const requests: string[] = [];
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw new Error('No subprocess expected'); }, fetch: async (url) => {
      requests.push(String(url));
      return Response.json({ jobs: [{ id: 'abcdef123456', name: 'Interval', prompt: 'Test', schedule: { kind: 'interval', minutes: 30 }, enabled: false, next_run_at: '2026-11-01T01:05:00-05:00' }] });
    } });
  assert.ok(real.jobsManager);
  const { call } = await start(t, real.jobsManager);
  const list = await call('GET', '/v1/agents/coding/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.body.timezone, 'Asia/Tokyo');
  assert.equal(list.body.jobs[0].schedule, 'every 30m');
  assert.equal(list.body.jobs[0].nextRunAt, 1793513100000);
  assert.equal(list.body.jobs[0].enabled, false);
  assert.match(requests[0], /\/p\/coding\/api\/jobs\?include_disabled=true$/);
  const history = await call('GET', '/v1/agents/coding/jobs/abcdef123456/history');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.executions.map((e: {
    id: string;
  }) => e.id), ['z-tie', 'newer', 'older']);
  assert.equal(history.body.executions[1].deliveryOutcome, 'delivered');
  assert.deepEqual(await fs.readFile(dbPath), before);
  assert.equal((await call('GET', '/v1/agents/default/jobs/abcdef123456/history')).status, 503);
});
test('revocation during snapshot and an unavailable audit fail closed before upstream writes', async (t) => {
  const { call, hermes, store, directory } = await start(t);
  let writes = 0;
  Object.assign((hermes as any).jobsManager, { snapshot: async () => { await store.mutate(s => { s.devices[0].revokedAt = Date.now(); }); return '{}'; }, create: async () => { writes++; return {}; } });
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 403);
  assert.equal(writes, 0);
  assert.equal((await fs.readdir(directory)).filter(f => f.startsWith('jobs-version-')).length, 0);
});
test('invalid fields, schedule units and missing capability never dispatch writes', async (t) => {
  const { call, hermes } = await start(t);
  let writes = 0;
  Object.assign((hermes as any).jobsManager, { snapshot: async () => null, create: async () => { writes++; return {}; } });
  for (const change of [{ model: 'hidden' }, { workdir: '/hidden' }, { enabled: true }, { agentId: 'coding' }, { repeat: 0 }, { repeat: 1.5 }, { skills: ['../escape'] }, { schedule: 'every 0m' }, { schedule: 'every 30000ms' }, { schedule: '99 25 * * *' }, { schedule: '0 9 * * *; echo nope' }])
    assert.equal((await call('POST', '/v1/agents/default/jobs', { ...input, ...change })).status, 400);
  assert.equal(writes, 0);
  Object.assign(hermes, { jobsManager: undefined });
  assert.equal((await call('GET', '/v1/agents/default/jobs')).status, 503);
});
test('legacy ledger has nullable optional columns and missing ledger is not fabricated empty', async (t) => {
  const home = createHermesHome();
  t.after(() => home.cleanup());
  home.write('cron/jobs.json', '{"jobs":[]}');
  const file = path.join(home.home, 'cron/executions.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT); INSERT INTO executions VALUES('one','abcdef123456','unknown','2026-01-01T00:00:00Z',NULL,NULL)");
  db.close();
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No process'); }, fetch: async () => { throw Error('No transport'); } });
  const { call } = await start(t, real.jobsManager);
  const result = await call('GET', '/v1/agents/default/jobs/abcdef123456/history');
  assert.equal(result.status, 200);
  assert.equal(result.body.executions[0].deliveryOutcome, null);
  assert.equal(result.body.executions[0].scheduledInstant, null);
  await fs.unlink(file);
  assert.equal((await call('GET', '/v1/agents/default/jobs/abcdef123456/history')).status, 503);
  await assert.rejects(fs.stat(file));
});
test('symlinked jobs and history are rejected and an oversized previous file blocks mutation', async (t) => {
  const home = createHermesHome();
  t.after(() => home.cleanup());
  home.write('cron/jobs.json', '{}');
  home.write('elsewhere.json', 'private');
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No process'); }, fetch: async () => { throw Error('No transport'); } });
  const { call } = await start(t, real.jobsManager);
  const jobs = path.join(home.home, 'cron/jobs.json');
  await fs.unlink(jobs);
  await fs.symlink(path.join(home.home, 'elsewhere.json'), jobs);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  await fs.symlink(path.join(home.home, 'elsewhere.json'), path.join(home.home, 'cron/executions.db'));
  assert.equal((await call('GET', '/v1/agents/default/jobs/abcdef123456/history')).status, 503);
  await fs.unlink(jobs);
  await fs.writeFile(jobs, ' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
});
test('run-now cannot silently resume a paused job without huella', async (t) => {
  const { call, hermes } = await start(t);
  let writes = 0;
  Object.assign((hermes as any).jobsManager, { get: async () => ({ enabled: false }), snapshot: async () => null, action: async () => { writes++; return {}; } });
  const result = await call('POST', '/v1/agents/default/jobs/abcdef123456/run', {});
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'job_paused');
  assert.match(result.body.error.message, /huella/);
  assert.equal(writes, 0);
});
test('audit failure blocks a job write and creates no previous-version file', async t => {
  const { call, hermes, store, directory } = await start(t);
  let writes = 0;
  Object.assign((hermes as any).jobsManager, { snapshot: async () => '{}', create: async () => { writes++; return {}; } });
  store.changeLog.appendChange = async () => { throw new StateError('Synthetic audit failure'); };
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(writes, 0);
  assert.equal((await fs.readdir(directory)).filter(f => f.startsWith('jobs-version-')).length, 0);
});

test('jobs logs redact raw paths, queries, content and authorization headers', async t => {
  const { call, logs } = await start(t);
  const result = await call('GET', '/v1/agents/default/jobs?key=fixture-query-private');
  assert.equal(result.status, 400);
  await call('GET', '/v1/agents/fixture-path-private/jobs');
  assert.doesNotMatch(logs.join('\n'), /fixture-query-private|fixture-path-private|Bearer|rly1_/);
});
test('previous versions preserve original bytes even when the file is not UTF-8', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n');
  const original = Buffer.from([0xff, 0x00, 0x7b, 0x7d]);
  home.write('cron/jobs.json', '{}');
  await fs.writeFile(path.join(home.home, 'cron/jobs.json'), original);
  const real = new RealHermes({home: home.home, bin:'unused', exec:async()=>{throw new Error('No subprocess');}, fetch:async()=>Response.json({job:{id:'abcdef123456',name:'Created',prompt:'Test',schedule:{kind:'interval',minutes:30},enabled:true,next_run_at:null}})});
  const { call, directory } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 201);
  const backup = (await fs.readdir(directory)).find(f => f.startsWith('jobs-version-'))!;
  const data = JSON.parse(await fs.readFile(path.join(directory, backup), 'utf8'));
  assert.deepEqual(Buffer.from(data.previous, 'base64'), original);
});


test('hardlinked previous jobs fail before audit or API write without changing either link', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n');
  home.write('cron/jobs.json', '{"jobs":[]}');
  const file = path.join(home.home, 'cron/jobs.json');
  const other = path.join(home.home, 'private-fixture');
  await fs.link(file, other);
  const before = await fs.readFile(other);
  let upstream = 0;
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => { upstream++; throw Error('No API write expected'); } });
  const { call, directory } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(upstream, 0);
  assert.deepEqual(await fs.readFile(other), before);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.readdir(directory)).filter(f => f.startsWith('jobs-version-')).length, 0);
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8'), /job\.create/);
});


test('snapshot growth between stat and read consumes at most 8 MiB plus one byte and fails before writing', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n'); home.write('cron/jobs.json', '{}');
  const file = path.join(home.home, 'cron/jobs.json');
  const originalStat = syncFs.statSync(file);
  const stat = syncFs.fstatSync.bind(syncFs), read = syncFs.readSync.bind(syncFs);
  let grown = false, consumed = 0;
  const targets = new Set<number>();
  t.mock.method(syncFs, 'fstatSync', (...args: any[]) => {
    const result = (stat as any)(...args);
    if (String(result.ino) === String(originalStat.ino) && String(result.dev) === String(originalStat.dev)) {
      targets.add(args[0]);
      if (!grown) { grown = true; syncFs.truncateSync(file, 8 * 1024 * 1024 + 4096); }
    }
    return result;
  });
  t.mock.method(syncFs, 'readSync', (...args: any[]) => {
    const result = (read as any)(...args);
    if (targets.has(args[0])) consumed += result;
    return result;
  });
  let upstream = 0;
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => { upstream++; throw Error('No write expected'); } });
  const { call } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(grown, true);
  assert.ok(consumed <= 8 * 1024 * 1024 + 1, `Snapshot consumed ${consumed} bytes`);
  assert.equal(upstream, 0);
  assert.equal((await fs.stat(file)).size, 8 * 1024 * 1024 + 4096);
});

test('snapshot ancestor swap cannot read the replacement or reach the API', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n'); home.write('cron/jobs.json', '{"original":true}');
  home.write('foreign/jobs.json', '{"private":"foreign-fixture"}');
  const cron = path.join(home.home, 'cron'), saved = path.join(home.home, 'cron-original');
  const foreign = path.join(home.home, 'foreign');
  const foreignIno = (await fs.stat(path.join(foreign, 'jobs.json'))).ino;
  const open = syncFs.openSync.bind(syncFs); let swapped = false, openedForeign = false;
  t.mock.method(syncFs, 'openSync', (...args: any[]) => {
    if (!swapped && String(args[0]).endsWith('/jobs.json')) {
      swapped = true; syncFs.renameSync(cron, saved); syncFs.symlinkSync(foreign, cron);
    }
    const fd = (open as any)(...args);
    if (syncFs.fstatSync(fd).ino === foreignIno) openedForeign = true;
    return fd;
  });
  let upstream = 0;
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => { upstream++; return Response.json({job:{id:'abcdef123456',name:'Created',prompt:'Test',schedule:{kind:'interval',minutes:30},enabled:true,next_run_at:null}}); } });
  const { call, directory, logs } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(swapped, true); assert.equal(openedForeign, false); assert.equal(upstream, 0);
  assert.equal(await fs.readFile(path.join(saved, 'jobs.json'), 'utf8'), '{"original":true}');
  assert.equal(await fs.readFile(path.join(foreign, 'jobs.json'), 'utf8'), '{"private":"foreign-fixture"}');
  assert.equal((await fs.readdir(directory)).filter(f => f.startsWith('jobs-version-')).length, 0);
  assert.doesNotMatch(logs.join('\n'), /foreign-fixture/);
});


async function ledgerFixture(t: TestContext, wal = false) {
  const home = createHermesHome(); t.after(() => home.cleanup()); home.write('cron/jobs.json', '{}');
  const file = path.join(home.home, 'cron/executions.db');
  const writer = new DatabaseSync(file);
  if (wal) writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  writer.exec("CREATE TABLE executions(id TEXT,job_id TEXT,status TEXT,claimed_at TEXT,started_at TEXT,finished_at TEXT); INSERT INTO executions VALUES('committed','abcdef123456','completed','2026-01-01T00:00:00Z',NULL,NULL)");
  if (wal) t.after(() => writer.close()); else writer.close();
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No process'); }, fetch: async () => { throw Error('No transport'); } });
  const app = await start(t, real.jobsManager);
  return { ...app, home, file, writer, route: '/v1/agents/default/jobs/abcdef123456/history' };
}
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  test(`history rejects hardlinked executions.db${suffix} before any source side effect`, async t => {
    const { home, file, call, route } = await ledgerFixture(t, true);
    const source = file + suffix, target = path.join(home.home, 'private-target');
    if (suffix === '-journal') await fs.writeFile(source, Buffer.alloc(4096, 23));
    await fs.link(source, target);
    const before = await fs.readFile(target);
    assert.equal((await call('GET', route)).status, 503);
    assert.deepEqual(await fs.readFile(target), before);
    assert.deepEqual(await fs.readFile(source), before);
  });
}
test('history never truncates a private hardlink substituted for SHM', async t => {
  const { home, file, call, route } = await ledgerFixture(t, true);
  const privateFile = path.join(home.home, 'private-target');
  const before = Buffer.from('synthetic private bytes that are not shared memory');
  await fs.writeFile(privateFile, before);
  await fs.unlink(file + '-shm'); await fs.link(privateFile, file + '-shm');
  assert.equal((await call('GET', route)).status, 503);
  assert.deepEqual(await fs.readFile(privateFile), before);
});
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  test(`history rejects symlinked executions.db${suffix} and leaves target bytes intact`, async t => {
    const { home, file, call, route } = await ledgerFixture(t, true);
    const target = path.join(home.home, 'private-target'), before = Buffer.alloc(4096, 19);
    await fs.writeFile(target, before);
    await fs.rm(file + suffix, { force: true }); await fs.symlink(target, file + suffix);
    assert.equal((await call('GET', route)).status, 503);
    assert.deepEqual(await fs.readFile(target), before);
  });
}
test('history rejects an ancestor swap at the native SQLite opening boundary without touching either ledger', async t => {
  const { home, file, call, route } = await ledgerFixture(t);
  const cron = path.dirname(file), saved = cron + '-original', foreign = path.join(home.home, 'foreign');
  await fs.mkdir(foreign); await fs.copyFile(file, path.join(foreign, 'executions.db'));
  const before = await fs.readFile(file);
  const NativeDatabase = sqlite.DatabaseSync; let swapped = false;
  t.mock.method(sqlite, 'DatabaseSync', class extends NativeDatabase {
    constructor(location: any, options: any) {
      if (!swapped) { swapped = true; syncFs.renameSync(cron, saved); syncFs.symlinkSync(foreign, cron); }
      super(location, options);
    }
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await call('GET', route)).status, 503);
  assert.equal(swapped, true);
  assert.deepEqual(await fs.readFile(path.join(saved, 'executions.db')), before);
  assert.deepEqual(await fs.readFile(path.join(foreign, 'executions.db')), before);
});
test('history reads committed WAL rows without writing any original bytes', async t => {
  const { file, writer, call, route } = await ledgerFixture(t, true);
  writer.exec("BEGIN; INSERT INTO executions VALUES('uncommitted','abcdef123456','failed','2026-01-02T00:00:00Z',NULL,NULL)");
  const before = await Promise.all(['', '-wal', '-shm'].map(s => fs.readFile(file + s)));
  const result = await call('GET', route);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.executions.map((e: {id:string}) => e.id), ['committed']);
  for (let i = 0; i < before.length; i++) assert.deepEqual(await fs.readFile(file + ['', '-wal', '-shm'][i]), before[i]);
  writer.exec('ROLLBACK');
});


for (const suffix of ['', '-wal', '-shm', '-journal']) {
  test(`history source executions.db${suffix} swap at SQLite open cannot touch the replacement`, async t => {
    const { home, file, call, route } = await ledgerFixture(t, true);
    const source = file + suffix, saved = source + '-original', target = path.join(home.home, 'private-target');
    const before = Buffer.alloc(4096, 21); await fs.writeFile(target, before);
    const hadSource = await fs.stat(source).then(() => true, () => false);
    const original = hadSource ? await fs.readFile(source) : null;
    const NativeDatabase = sqlite.DatabaseSync; let swapped = false;
    t.mock.method(sqlite, 'DatabaseSync', class extends NativeDatabase {
      constructor(location: any, options: any) {
        if (!swapped) {
          swapped = true;
          if (hadSource) syncFs.renameSync(source, saved);
          syncFs.symlinkSync(target, source);
        }
        super(location, options);
      }
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await call('GET', route);
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readFile(target), before);
    if (original) assert.deepEqual(await fs.readFile(saved), original);
    assert.equal(result.status, 503);
  });
}
for (const name of ['jobs.json', 'executions.db', 'executions.db-wal', 'executions.db-shm', 'executions.db-journal']) {
  test(`special cron entry ${name} is rejected without blocking or modifying the source`, async t => {
    const { file, call, route } = await ledgerFixture(t);
    const entry = path.join(path.dirname(file), name);
    await fs.rm(entry, { force: true });
    assert.equal((await realExec('mkfifo', [entry], { timeoutMs: 5000 })).code, 0);
    const result = await call(name === 'jobs.json' ? 'POST' : 'GET', name === 'jobs.json' ? '/v1/agents/default/jobs' : route, name === 'jobs.json' ? input : undefined);
    assert.equal(result.status, 503);
    assert.equal((await fs.lstat(entry)).isFIFO(), true);
  });
}
test('snapshot rejects an already symlinked profile ancestor and preserves foreign bytes', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('profiles/coding/config.yaml', 'timezone: Asia/Tokyo\n');
  home.write('profiles/coding/cron/jobs.json', '{"fixture":"foreign"}');
  const profiles = path.join(home.home, 'profiles'), saved = path.join(home.home, 'profiles-original');
  await fs.rename(profiles, saved); await fs.symlink(saved, profiles);
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => { throw Error('No transport expected'); } });
  const { call, directory } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/coding/jobs', input)).status, 503);
  assert.equal((await fs.readdir(directory)).filter(f => f.startsWith('jobs-version-')).length, 0);
  assert.equal(await fs.readFile(path.join(saved, 'coding/cron/jobs.json'), 'utf8'), '{"fixture":"foreign"}');
});
test('a missing previous file is distinct from a file disappearing after pinning', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n');
  let upstream = 0;
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No process'); }, fetch: async () => { upstream++; return Response.json({job:{id:'abcdef123456',name:'Created',prompt:'Test',schedule:{kind:'interval',minutes:30},enabled:true,next_run_at:null}}); } });
  const { call, directory } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 201);
  const backup = (await fs.readdir(directory)).find(f => f.startsWith('jobs-version-'))!;
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, backup), 'utf8')).previous, null);
  home.write('cron/jobs.json', '{}');
  const file = path.join(home.home, 'cron/jobs.json'), ino = (await fs.stat(file)).ino;
  const stat = syncFs.fstatSync.bind(syncFs); let removed = false;
  t.mock.method(syncFs, 'fstatSync', (...args: any[]) => {
    const result = (stat as any)(...args);
    if (!removed && String(result.ino) === String(ino)) { removed = true; syncFs.unlinkSync(file); }
    return result;
  });
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(removed, true); assert.equal(upstream, 1);
});
test('history remains valid without source SHM and never creates it', async t => {
  const { file, call, route } = await ledgerFixture(t, true);
  await fs.unlink(file + '-shm');
  // Fresh inodes prevent SQLite's in-process fd cache from hiding a source SHM open.
  for (const suffix of ['', '-wal']) { await fs.copyFile(file + suffix, file + suffix + '-copy'); await fs.rename(file + suffix + '-copy', file + suffix); }
  const before = await Promise.all(['', '-wal'].map(s => fs.readFile(file + s)));
  const result = await call('GET', route);
  await assert.rejects(fs.stat(file + '-shm'), { code: 'ENOENT' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.executions.map((e: {id:string}) => e.id), ['committed']);
  assert.deepEqual(await fs.readFile(file), before[0]); assert.deepEqual(await fs.readFile(file + '-wal'), before[1]);
});


test('history native connection rejects writes before projection and has query_only enabled', async t => {
  const { call, route } = await ledgerFixture(t);
  const NativeDatabase = sqlite.DatabaseSync;
  let writable = false, queryOnly: unknown;
  t.mock.method(sqlite, 'DatabaseSync', class extends NativeDatabase {
    constructor(location: any, options: any) {
      super(location, options);
      try { this.exec('CREATE TABLE forbidden_write(id TEXT)'); writable = true; } catch { }
      const connection: DatabaseSync = this;
      const prepare = connection.prepare.bind(connection);
      t.mock.method(connection, 'prepare', (sql: string) => {
        if (sql.includes("name='executions'")) queryOnly = prepare('PRAGMA query_only').get()?.query_only;
        return prepare(sql);
      });
    }
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await call('GET', route)).status, 200);
  assert.equal(writable, false); assert.equal(queryOnly, 1);
});
test('history rejects a source write during copying and preserves the attacker final bytes', async t => {
  const { file, call, route } = await ledgerFixture(t);
  const ino = (await fs.stat(file)).ino, read = syncFs.readSync.bind(syncFs);
  let changed = false;
  t.mock.method(syncFs, 'readSync', (...args: any[]) => {
    const result = (read as any)(...args);
    if (!changed && String(syncFs.fstatSync(args[0]).ino) === String(ino)) {
      changed = true;
      // Keep the ledger SQL valid while making its copied version unstable.
      const editor = new DatabaseSync(file);
      editor.exec("INSERT INTO executions VALUES('later','abcdef123456','failed','2026-01-02T00:00:00Z',NULL,NULL)"); editor.close();
    }
    return result;
  });
  assert.equal((await call('GET', route)).status, 503); assert.equal(changed, true);
  const verify = new DatabaseSync(file, { readOnly: true });
  assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM executions').get()?.count, 2); verify.close();
});
test('history field sizes are bounded before rows reach the HTTP response', async t => {
  const { file, call, route } = await ledgerFixture(t);
  const editor = new DatabaseSync(file);
  editor.prepare('UPDATE executions SET id=?').run('x'.repeat(65537)); editor.close();
  const before = await fs.readFile(file);
  const result = await call('GET', route);
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(result.body), /xxxxxx/);
  assert.deepEqual(await fs.readFile(file), before);
});


test('snapshot final symlink is rejected before API write even with a configured timezone', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n'); home.write('cron/jobs.json', '{}');
  const file = path.join(home.home, 'cron/jobs.json'), other = path.join(home.home, 'private-fixture');
  const before = Buffer.from('{"fixture":"private"}'); await fs.writeFile(other, before);
  await fs.unlink(file); await fs.symlink(other, file);
  let upstream = 0;
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => { upstream++; return Response.json({job:{id:'abcdef123456',name:'Created',prompt:'Test',schedule:{kind:'interval',minutes:30},enabled:true,next_run_at:null}}); } });
  const { call } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 503);
  assert.equal(upstream, 0); assert.deepEqual(await fs.readFile(other), before);
});
test('snapshot accepts exactly 8 MiB and preserves its bytes in the durable previous version', async t => {
  const home = createHermesHome(); t.after(() => home.cleanup());
  home.write('config.yaml', 'timezone: America/Mexico_City\n'); home.write('cron/jobs.json', '{}');
  const before = Buffer.alloc(8 * 1024 * 1024, 17); await fs.writeFile(path.join(home.home, 'cron/jobs.json'), before);
  const real = new RealHermes({ home: home.home, bin: 'unused', exec: async () => { throw Error('No subprocess'); }, fetch: async () => Response.json({job:{id:'abcdef123456',name:'Created',prompt:'Test',schedule:{kind:'interval',minutes:30},enabled:true,next_run_at:null}}) });
  const { call, directory } = await start(t, real.jobsManager);
  assert.equal((await call('POST', '/v1/agents/default/jobs', input)).status, 201);
  const backup = (await fs.readdir(directory)).find(f => f.startsWith('jobs-version-'))!;
  assert.deepEqual(Buffer.from(JSON.parse(await fs.readFile(path.join(directory, backup), 'utf8')).previous, 'base64'), before);
});
test('an oversized ledger fails before copying or SQLite opening', async t => {
  const { file, call, route } = await ledgerFixture(t);
  await fs.truncate(file, 64 * 1024 * 1024 + 1);
  const NativeDatabase = sqlite.DatabaseSync; let opens = 0;
  t.mock.method(sqlite, 'DatabaseSync', class extends NativeDatabase { constructor(location: any, options: any) { opens++; super(location, options); } });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await call('GET', route)).status, 503); assert.equal(opens, 0);
  assert.equal((await fs.stat(file)).size, 64 * 1024 * 1024 + 1);
});
