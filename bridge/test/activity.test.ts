import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createActivityReader } from '../src/activity.ts';
const DEVICE = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = (n: number, action = 'agent.tools.enable.requested', target = { kind: 'agent', id: 'dev' }) => ({
  id: id(n), at: '2026-10-04T12:00:00.000Z', actor: { kind: 'device', id: DEVICE, name: 'private-name-canary' }, action, target,
});
async function fixture(t: TestContext, records: unknown[] = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-activity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'changes.jsonl');
  await fs.writeFile(file, records.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  return { directory, file };
}
test('activity projects content-free independent requests and sorts by UTC time and event ID', async t => {
  const { directory, file } = await fixture(t, [record(1), record(2, 'server.pause.failed', { kind: 'server', id: 'local' })]);
  const before = await fs.readFile(file);
  const page = await createActivityReader({ directory, now: () => 1234 }).list({}, DEVICE, () => {});
  assert.deepEqual(page, { capturedAt: 1234, nextCursor: null, items: [
    { id: id(2), at: 1791115200000, actor: { kind: 'device', id: DEVICE }, action: 'server.pause', category: 'server', result: 'failed', scope: { kind: 'server' }, conversationId: null },
    { id: id(1), at: 1791115200000, actor: { kind: 'device', id: DEVICE }, action: 'agent.tools.enable', category: 'configuration', result: 'requested', scope: { kind: 'agent', agentId: 'dev' }, conversationId: null },
  ] });
  assert.doesNotMatch(JSON.stringify(page), /private-name-canary|details|previous|local/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('pages remain stable across appends and bind cursors to device, filters and ten-minute expiry', async t => {
  const { directory, file } = await fixture(t, [record(1), record(2), record(3)]);
  let now = 1000;
  const reader = createActivityReader({ directory, now: () => now });
  const first = await reader.list({ limit: 1, category: 'configuration' }, DEVICE, () => {});
  assert.deepEqual(first.items.map(item => item.id), [id(3)]);
  assert.match(first.nextCursor!, /^[A-Za-z0-9_-]+$/);
  await fs.appendFile(file, JSON.stringify({ ...record(4), at: '2026-10-04T13:00:00.000Z' }) + '\n');
  const query = { limit: 1, category: 'configuration' as const, cursor: first.nextCursor! };
  const second = await reader.list(query, DEVICE, () => {});
  assert.deepEqual(second.items.map(item => item.id), [id(2)]);
  assert.equal(second.capturedAt, 1000);
  await assert.rejects(reader.list(query, id(2), () => {}), { code: 'invalid_activity_query' });
  await assert.rejects(reader.list({ ...query, agentId: 'dev' }, DEVICE, () => {}), { code: 'invalid_activity_query' });
  await assert.rejects(reader.list({ ...query, cursor: first.nextCursor!.slice(0, 40) + (first.nextCursor![40] === 'A' ? 'B' : 'A') + first.nextCursor!.slice(41) }, DEVICE, () => {}), { code: 'activity_cursor_expired' });
  now += 599999;
  assert.deepEqual((await reader.list({ ...query, cursor: second.nextCursor! }, DEVICE, () => {})).items.map(item => item.id), [id(1)]);
  now++;
  await assert.rejects(reader.list(query, DEVICE, () => {}), { code: 'activity_cursor_expired' });
  assert.deepEqual((await reader.list({ limit: 1 }, DEVICE, () => {})).items.map(item => item.id), [id(4)]);
});

test('revocation while opening releases every descriptor and returns no page', async t => {
  const { directory } = await fixture(t, [record(1)]);
  let revoked = false;
  const handles = new Set<number>();
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); handles.add(handle.fd);
    const close = handle.close.bind(handle), fd = handle.fd;
    handle.close = async () => { await close(); handles.delete(fd); };
    revoked = true;
    return handle;
  } };
  const guard = () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'device_revoked' }); };
  await assert.rejects(createActivityReader({ directory, io }).list({}, DEVICE, guard), { code: 'device_revoked' });
  assert.equal(handles.size, 0, 'revoked requests must release opened file descriptors');
});

test('filters include failed, rejected and uncertain while preserving distinct results and excluding requested events', async t => {
  const { directory } = await fixture(t, [
    record(1), record(2, 'job.run.requested', { kind: 'agent', id: '["ops","job-canary"]' }),
    record(3, 'conversation.rename.failed', { kind: 'conversation', id: '["dev","conversation-canary"]' }),
    record(4, 'run.steer.uncertain', { kind: 'run', id: '["dev","run-canary"]' }),
    record(5, 'run.steer.rejected', { kind: 'run', id: '["dev","run-canary"]' }),
    record(6, 'agent.mode.queued', { kind: 'agent', id: '["dev","revision-canary"]' }),
    record(7, 'conversation.create.succeeded', { kind: 'conversation', id: '["dev","conversation-ref"]' }),
    { ...record(8, 'auth.rate_limited', { kind: 'ip', id: '100.64.0.9' }), actor: { kind: 'server' }, details: { blockedUntil: 1791115300000 } },
    { ...record(9, 'agent.memory.edit.requested'), details: { file: 'memory', previous: true } },
  ]);
  const reader = createActivityReader({ directory });
  const page = await reader.list({ agentId: 'dev', category: 'conversations', failuresOnly: true }, DEVICE, () => {});
  assert.deepEqual(page.items.map(item => [item.id, item.result]), [[id(5), 'rejected'], [id(4), 'uncertain'], [id(3), 'failed']]);
  const all = await reader.list({}, DEVICE, () => {});
  assert.equal(all.items.find(item => item.id === id(6))?.result, 'requested');
  assert.equal(all.items.find(item => item.id === id(7))?.conversationId, 'conversation-ref');
  assert.equal(all.items.find(item => item.id === id(3))?.conversationId, null);
  assert.doesNotMatch(JSON.stringify(all), /100\.64|revision-canary|run-canary|job-canary|private-name-canary|previous|blockedUntil/);
  assert.deepEqual((await reader.list({ category: 'tasks' }, DEVICE, () => {})).items.map(item => item.action), ['job.run']);
});

test('empty files and incomplete tails are read without creation, recovery or backup access', async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(path.join(directory, 'memory-private.previous'), 'backup-canary', { mode: 0o600 });
  const reader = createActivityReader({ directory });
  assert.deepEqual((await reader.list({}, DEVICE, () => {})).items, []);
  const tail = Buffer.from(JSON.stringify(record(1)) + '\n{"private-tail":');
  await fs.writeFile(file, tail);
  assert.deepEqual((await reader.list({}, DEVICE, () => {})).items.map(item => item.id), [id(1)]);
  assert.deepEqual(await fs.readFile(file), tail);
  await fs.unlink(file);
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_unavailable' });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(directory, 'memory-private.previous'), 'utf8'), 'backup-canary');
});

for (const invalid of [
  'private-corrupt-canary\n', Buffer.from([0xff, 10]),
  JSON.stringify({ ...record(1), at: 'invalid' }) + '\n',
  JSON.stringify({ ...record(1), content: 'private-content-canary' }) + '\n',
  JSON.stringify({ ...record(1), action: 'unknown.action' }) + '\n',
  JSON.stringify(record(1)) + '\n' + JSON.stringify(record(1)) + '\n',
]) {
  test('invalid complete records fail closed without returning or changing source contents', async t => {
    const { directory, file } = await fixture(t);
    await fs.writeFile(file, invalid);
    const bytes = await fs.readFile(file);
    await assert.rejects(createActivityReader({ directory }).list({}, DEVICE, () => {}), error => {
      assert.equal((error as { code: string }).code, 'activity_unavailable');
      assert.doesNotMatch(String(error), /private-|unknown.action|invalid$/); return true;
    });
    assert.deepEqual(await fs.readFile(file), bytes);
  });
}

for (const kind of ['file-link', 'ancestor-link', 'hardlink', 'public-file', 'public-directory', 'directory-file']) {
  test(`${kind} is rejected without exposing the destination`, async t => {
    const { directory, file } = await fixture(t, [record(1)]);
    let root = directory;
    if (kind === 'file-link') { await fs.rename(file, file + '.original'); await fs.symlink(file + '.original', file); }
    if (kind === 'ancestor-link') { root = directory + '-link'; await fs.symlink(directory, root); t.after(() => fs.unlink(root)); }
    if (kind === 'hardlink') await fs.link(file, file + '.alias');
    if (kind === 'public-file') await fs.chmod(file, 0o644);
    if (kind === 'public-directory') await fs.chmod(directory, 0o777);
    if (kind === 'directory-file') { await fs.unlink(file); await fs.mkdir(file); }
    await assert.rejects(createActivityReader({ directory: root }).list({}, DEVICE, () => {}), { code: 'activity_unavailable' });
  });
}

for (const kind of ['replacement', 'rewrite', 'truncate', 'disappear']) {
  test(`a ${kind} invalidates an existing snapshot instead of serving cached entries`, async t => {
    const { directory, file } = await fixture(t, [record(1), record(2)]);
    const reader = createActivityReader({ directory });
    const page = await reader.list({ limit: 1 }, DEVICE, () => {});
    if (kind === 'replacement') { const bytes = await fs.readFile(file); await fs.rename(file, file + '.old'); await fs.writeFile(file, bytes, { mode: 0o600 }); }
    if (kind === 'rewrite') await fs.writeFile(file, [record(3), record(4)].map(row => JSON.stringify(row) + '\n').join(''));
    if (kind === 'truncate') await fs.truncate(file, 0);
    if (kind === 'disappear') await fs.unlink(file);
    await assert.rejects(reader.list({ limit: 1, cursor: page.nextCursor! }, DEVICE, () => {}), { code: 'activity_unavailable' });
  });
}

test('read interval version changes are rejected even when the bytes still validate', async t => {
  const { directory, file } = await fixture(t, [record(1)]);
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('/changes.jsonl')) {
      const read = handle.read.bind(handle);
      handle.read = async (...args: Parameters<typeof handle.read>) => {
        const value = await read(...args); await fs.appendFile(file, JSON.stringify(record(2)) + '\n'); return value;
      };
    }
    return handle;
  } };
  await assert.rejects(createActivityReader({ directory, io }).list({}, DEVICE, () => {}), { code: 'activity_unavailable' });
});

test('file, row and line bounds fail explicitly and preserve source bytes', async t => {
  const { directory, file } = await fixture(t);
  const reader = createActivityReader({ directory });
  const handle = await fs.open(file, 'r+'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
  assert.equal((await fs.stat(file)).size, 16 * 1024 * 1024 + 1);
  const line = JSON.stringify(record(1));
  await fs.writeFile(file, line.padEnd(8192, ' ') + '\n');
  assert.equal((await reader.list({}, DEVICE, () => {})).items.length, 1);
  await fs.writeFile(file, line.padEnd(8193, ' ') + '\n');
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
  await fs.writeFile(file, 'x'.repeat(8193));
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
  const rows = Array.from({ length: 50001 }, (_, n) => JSON.stringify(record(n + 1)) + '\n').join('');
  await fs.writeFile(file, rows);
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
  assert.equal((await fs.stat(file)).size, Buffer.byteLength(rows));
});

test('snapshots and concurrent reads are bounded; expired slots become available again', async t => {
  const { directory } = await fixture(t, [record(1), record(2)]);
  let now = 0;
  const reader = createActivityReader({ directory, now: () => now });
  const pages = [];
  for (let n = 0; n < 4; n++) pages.push(await reader.list({ limit: 1 }, DEVICE, () => {}));
  await assert.rejects(reader.list({ limit: 1 }, DEVICE, () => {}), { code: 'activity_busy' });
  now = 600000;
  const inFlight = reader.list({ limit: 1 }, DEVICE, () => {});
  await assert.rejects(reader.list({}, DEVICE, () => {}), { code: 'activity_busy' });
  assert.equal((await inFlight).items.length, 1);
  await assert.rejects(createActivityReader({ directory }).list({ cursor: pages[0].nextCursor! }, DEVICE, () => {}), { code: 'activity_cursor_expired' });
});

test('the retained snapshot memory budget applies before the snapshot count cap', async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, Array.from({ length: 11000 }, (_, n) => JSON.stringify(record(n + 1)) + '\n').join(''));
  const reader = createActivityReader({ directory });
  await reader.list({ limit: 1 }, DEVICE, () => {});
  await reader.list({ limit: 1 }, DEVICE, () => {});
  await assert.rejects(reader.list({ limit: 1 }, DEVICE, () => {}), { code: 'activity_busy' });
});

test('ancestor replacement invalidates a cursor even when the audit file retains its inode', async t => {
  const { directory, file } = await fixture(t, [record(1), record(2)]);
  const reader = createActivityReader({ directory });
  const page = await reader.list({ limit: 1 }, DEVICE, () => {});
  const old = directory + '-old';
  await fs.rename(directory, old); t.after(() => fs.rm(old, { recursive: true, force: true }));
  await fs.mkdir(directory, { mode: 0o700 }); await fs.rename(path.join(old, 'changes.jsonl'), file);
  await assert.rejects(reader.list({ limit: 1, cursor: page.nextCursor! }, DEVICE, () => {}), { code: 'activity_unavailable' });
});

test('cursor expiry is checked again after a slow filesystem read', async t => {
  const { directory } = await fixture(t, [record(1), record(2)]);
  let now = 0, expireDuringRead = false;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('/changes.jsonl')) {
      const read = handle.read.bind(handle);
      handle.read = async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args); if (expireDuringRead) now = 600000; return result;
      };
    }
    return handle;
  } };
  const reader = createActivityReader({ directory, io, now: () => now });
  const first = await reader.list({ limit: 1 }, DEVICE, () => {});
  expireDuringRead = true;
  await assert.rejects(reader.list({ limit: 1, cursor: first.nextCursor! }, DEVICE, () => {}), { code: 'activity_cursor_expired' });
});

test('revocation after reading prevents any subsequent filesystem inspection', async t => {
  const { directory } = await fixture(t, [record(1)]);
  let revoked = false, inspectionsAfterRevocation = 0;
  const io = { ...fs,
    lstat: (async (...args: Parameters<typeof fs.lstat>) => {
      if (revoked) inspectionsAfterRevocation++;
      return fs.lstat(...args);
    }) as typeof fs.lstat,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('/changes.jsonl')) {
        const read = handle.read.bind(handle);
        handle.read = async (...args: Parameters<typeof handle.read>) => { const result = await read(...args); revoked = true; return result; };
      }
      return handle;
    },
  };
  const guard = () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'device_revoked' }); };
  await assert.rejects(createActivityReader({ directory, io }).list({}, DEVICE, guard), { code: 'device_revoked' });
  assert.equal(inspectionsAfterRevocation, 0, 'revocation must stop private continuations immediately after reading');
});

test('the file byte budget rejects oversize input before allocating or reading its contents', async t => {
  const { directory, file } = await fixture(t);
  const handle = await fs.open(file, 'r+'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  let reads = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('/changes.jsonl')) handle.read = async () => { reads++; throw new Error('private-read-canary'); };
    return handle;
  } };
  await assert.rejects(createActivityReader({ directory, io }).list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
  assert.equal(reads, 0);
});

test('the row budget stops before parsing an additional malformed record', async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, Array.from({ length: 50000 }, (_, n) => JSON.stringify(record(n + 1)) + '\n').join('') + 'private-over-budget-row\n');
  await assert.rejects(createActivityReader({ directory }).list({}, DEVICE, () => {}), { code: 'activity_limit_exceeded' });
});
