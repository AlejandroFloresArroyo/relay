import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { RealHermes } from '../src/hermes_real.ts';
import { start } from '../support/discoveryHttpFixture.ts';

test('HTTP logs redact compound credentials across lines and select the requested agent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-log-synthetic-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });
  await fs.mkdir(path.join(home, 'profiles/coding/logs'), { recursive: true });
  await fs.writeFile(path.join(home, 'logs/agent.log'), '2026-10-04 10:00:00,000 INFO default text\n');
  const secrets = ['short', 'abc123', 'cookie-value', 'folded-value', 'query-value', 'compound-value', 'encoded-value', 'url-pass', 'camel-value'];
  await fs.writeFile(path.join(home, 'profiles/coding/logs/agent.log'), [
    '2026-10-04 10:00:00,000 INFO coding text',
    'Authorization: Basic short',
    'X-API-Key: abc123',
    'Cookie: session=cookie-value; mode=private',
    'Authorization: Bearer',
    ' folded-value',
    'url=https://example.invalid/?access_token=query-value&safe=yes',
    'ANTHROPIC_API_KEY="compound-value"',
    'url=https://user:url-pass@example.invalid/?api%5Fkey=encoded-value&safe=yes',
    'clientSecret=camel-value',
    'ordinary tokens count=123 model=synthetic channel=public monkey=banana keyboard=ready',
  ].join('\n'));
  const f = await start(t);
  const hermes = new RealHermes({ home, bin: 'never-call', exec: async () => { throw new Error('Unexpected exec'); } });
  f.hermes.logs = query => hermes.logs(query);
  assert.match((await f.call('GET', '/v1/logs')).text, /default text/);
  const result = await f.call('GET', '/v1/logs?agentId=coding');
  assert.equal(result.status, 200); assert.match(result.text, /coding text/);
  for (const secret of secrets) assert.ok(!result.text.includes(secret), secret);
  assert.match(result.text, /ordinary tokens count=123 model=synthetic channel=public monkey=banana keyboard=ready/);
  assert.equal((await f.call('GET', '/v1/logs?agentId=..%2Fprivate')).status, 400);
  await fs.unlink(path.join(home, 'profiles/coding/logs/agent.log'));
  await fs.symlink(path.join(home, 'logs/agent.log'), path.join(home, 'profiles/coding/logs/agent.log'));
  const blocked = await f.call('GET', '/v1/logs?agentId=coding');
  assert.equal(blocked.status, 502); assert.ok(!blocked.text.includes(home));
});

test('HTTP log reads reject parent links and hardlinks, bound lines and bytes, and distinguish missing logs', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-log-bounds-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });
  await fs.mkdir(path.join(home, 'profiles/coding'), { recursive: true });
  await fs.writeFile(path.join(home, 'logs/agent.log'), '2026-10-04 10:00:00,000 INFO ordinary\n');
  const f = await start(t);
  const hermes = new RealHermes({ home, bin: 'unused', exec: async () => { throw new Error('Unexpected exec'); } });
  f.hermes.logs = query => hermes.logs(query);
  assert.deepEqual((await f.call('GET', '/v1/logs?agentId=coding')).json.lines, []);
  await fs.symlink(path.join(home, 'logs'), path.join(home, 'profiles/coding/logs'));
  assert.equal((await f.call('GET', '/v1/logs?agentId=coding')).status, 502);
  await fs.unlink(path.join(home, 'profiles/coding/logs'));
  await fs.mkdir(path.join(home, 'profiles/coding/logs'));
  await fs.link(path.join(home, 'logs/agent.log'), path.join(home, 'profiles/coding/logs/agent.log'));
  assert.equal((await f.call('GET', '/v1/logs?agentId=coding')).status, 502);
  await fs.unlink(path.join(home, 'profiles/coding/logs/agent.log'));
  await fs.writeFile(path.join(home, 'profiles/coding/logs/agent.log'), '2026-10-04 09:00:00,000 ERROR outside-window-marker\n' + 'x'.repeat(600000) + '\n2026-10-04 10:00:00,000 INFO first\n2026-10-04 10:00:01,000 ERROR last\n');
  const result = await f.call('GET', '/v1/logs?agentId=coding&level=ERROR&lines=1');
  assert.equal(result.status, 502);
  assert.equal(result.json.error.code, 'upstream');
  assert.ok(result.text.length < 1000);
  const bounded = await f.call('GET', '/v1/logs?agentId=coding&level=DEBUG&lines=100');
  assert.ok(!bounded.text.includes('outside-window-marker'), 'A recognized entry outside the 512 KiB tail must not be served');
  assert.equal(bounded.status, 502);
  await fs.writeFile(path.join(home, 'profiles/coding/logs/agent.log'), '2026-10-04 10:00:00,000 INFO first\n2026-10-04 10:00:01,000 ERROR last\n');
  assert.deepEqual((await f.call('GET', '/v1/logs?agentId=coding&level=DEBUG&lines=100')).json.lines, [{ t: '10:00:00', level: 'INFO', msg: 'first' }, { t: '10:00:01', level: 'ERROR', msg: 'last' }]);
  assert.deepEqual((await f.call('GET', '/v1/logs?agentId=coding&level=ERROR&lines=1')).json.lines, [{ t: '10:00:01', level: 'ERROR', msg: 'last' }]);
  assert.equal((await f.call('GET', '/v1/logs?agentId=coding&agentId=default')).status, 400);
  assert.equal((await f.call('GET', '/v1/logs?agentId=unknown')).status, 404);
});

test('revocation while logs are pending prevents delivery and logs never record query credentials', async t => {
  const f = await start(t); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.hermes.logs = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return [{ t: '10:00', level: 'INFO', msg: 'private contents' }]; };
  const pending = f.call('GET', '/v1/logs'); await started;
  await f.store.mutate(state => { state.devices[0].revokedAt = 1_700_000_000_001; }); release();
  const result = await pending; assert.equal(result.status, 403); assert.ok(!result.text.includes('private contents'));
  await f.call('GET', '/v1/logs?token=synthetic-secret');
  assert.ok(!f.logs.join('').includes('synthetic-secret'));
});


test('HTTP logs hide entire quoted credentials across newlines, escaped quotes and log-shaped continuations', async t => {
  const home = await fs.mkdtemp(path.join(import.meta.dirname, '../../.synthetic-quoted-logs-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'logs'));
  await fs.writeFile(path.join(home, 'logs/agent.log'), [
    '2026-10-04 10:00:00,000 INFO safe before',
    'client_secret="first-line',
    'second-line"',
    'clientSecret="camel-first\\"escaped-piece',
    '2026-10-04 10:00:01,000 ERROR hidden-log-shaped-piece"',
    "refresh_token='single-first\\'escaped-single",
    "single-last'",
    '2026-10-04 10:00:02,000 INFO safe after',
    'clientSecret="unfinished-first',
    'unfinished-last',
  ].join('\n'));
  const f = await start(t);
  const hermes = new RealHermes({ home, bin: 'never-call', exec: async () => { throw new Error('Unexpected exec'); } });
  f.hermes.logs = query => hermes.logs(query);
  const result = await f.call('GET', '/v1/logs');
  assert.equal(result.status, 200);
  for (const fragment of ['first-line', 'second-line', 'camel-first', 'escaped-piece', 'hidden-log-shaped-piece', 'single-first', 'escaped-single', 'single-last', 'unfinished-first', 'unfinished-last']) {
    assert.ok(!result.text.includes(fragment), `Credential fragment leaked: ${fragment}`);
  }
  assert.match(result.text, /safe before/);
  assert.match(result.text, /safe after/);
  assert.equal(result.json.lines.length, 2);
});


test('HTTP logs refuse truncated quote context without serving any source content', async t => {
  const home = await fs.mkdtemp(path.join(import.meta.dirname, '../../.synthetic-truncated-logs-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'logs'));
  const f = await start(t);
  const hermes = new RealHermes({ home, bin: 'never-call', exec: async () => { throw new Error('Unexpected exec'); } });
  f.hermes.logs = query => hermes.logs(query);
  for (const [opening, ending] of [
    ['clientSecret="', 'escaped\\"fragment"'],
    ["client_secret='", "escaped\\'fragment'"],
    ['refresh_token="', 'unfinished-fragment\\'],
  ]) {
    await fs.writeFile(path.join(home, 'logs/agent.log'), [
      '2026-10-04 09:00:00,000 INFO outside-window-marker',
      opening + 'long-prefix-' + 'x'.repeat(600000),
      '2026-10-04 10:00:00,000 ERROR private-continuation ' + ending,
      '2026-10-04 10:00:01,000 INFO public-suffix',
    ].join('\n'));
    for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR']) {
      const result = await f.call('GET', '/v1/logs?level=' + level);
      assert.ok(!result.text.includes('private-continuation'), 'Truncated quote context leaked a log-shaped credential continuation');
      assert.equal(result.status, 502, 'Unknown quote context must be an explicit unavailable state');
      assert.equal(result.json.error.code, 'upstream');
      assert.ok(!result.text.includes('outside-window-marker'));
      assert.ok(!result.text.includes('public-suffix'));
      assert.ok(!result.text.includes(home));
      assert.ok(result.text.length < 1000);
    }
  }
});


test('HTTP logs read at most 512 KiB from a known start and redact very long escaped quoted values', async t => {
  const home = await fs.mkdtemp(path.join(import.meta.dirname, '../../.synthetic-log-read-limit-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'logs'));
  const file = path.join(home, 'logs/agent.log');
  const f = await start(t);
  const hermes = new RealHermes({ home, bin: 'never-call', exec: async () => { throw new Error('Unexpected exec'); } });
  f.hermes.logs = query => hermes.logs(query);
  const reads: { length: number; position: number | null }[] = [];
  const originalRead = syncFs.readSync;
  // Observe the filesystem boundary; HTTP output alone cannot prove a bounded read.
  syncFs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    if (syncFs.readlinkSync(`/proc/self/fd/${fd}`) === file) reads.push({ length, position });
    return originalRead(fd, buffer, offset, length, position);
  }) as typeof originalRead;
  t.after(() => { syncFs.readSync = originalRead; });
  const prefix = '2026-10-04 10:00:00,000 INFO safe-before clientSecret="';
  const suffix = '\n2026-10-04 10:00:01,000 ERROR hidden-long-fragment"\n2026-10-04 10:00:02,000 INFO safe-after\n';
  const escapes = String.raw`\"\\`.repeat(10000);
  const padding = 'x'.repeat(512 * 1024 - Buffer.byteLength(prefix + escapes + suffix));
  await fs.writeFile(file, prefix + escapes + padding + suffix);
  const complete = await f.call('GET', '/v1/logs');
  assert.equal(complete.status, 200, 'A complete file at the byte limit must remain readable');
  assert.match(complete.text, /safe-before/);
  assert.match(complete.text, /safe-after/);
  assert.ok(!complete.text.includes('hidden-long-fragment'));
  assert.equal(complete.json.lines.length, 2);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], { length: 512 * 1024, position: 0 });
  reads.length = 0;
  await fs.appendFile(file, 'x');
  const oversized = await f.call('GET', '/v1/logs');
  assert.ok(reads.reduce((total, read) => total + read.length, 0) <= 512 * 1024, 'Actual log reads exceeded the 512 KiB budget');
  assert.equal(oversized.status, 502);
  assert.deepEqual(reads, [], 'Unknown quote context must be refused before reading source content');
});
