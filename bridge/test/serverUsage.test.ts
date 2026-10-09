import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readServerUsage, usageWindow, totalUsage } from '../src/serverUsage.ts';

const now = Date.parse('2026-10-04T18:00:00Z');
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(home, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
  const add = (at: number, model: string | null, input: number | null, cost: number | null, status: string | null = 'estimated') => db.prepare('INSERT INTO sessions VALUES (?,?,?,10,5,?,?)').run(at / 1000, model, input, cost, status);
  t.after(() => { if (db.isOpen) db.close(); });
  return { home, db, add };
}
test('calendar windows use server midnight, Monday and month start with 23/25 hour DST days', () => {
  const previous = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const spring = usageWindow(Date.parse('2026-03-08T20:00Z'), 'day');
    assert.equal(spring.until - spring.from, 23 * 3600);
    const fall = usageWindow(Date.parse('2026-11-01T20:00Z'), 'day');
    assert.equal(fall.until - fall.from, 25 * 3600);
    assert.equal(new Date(spring.from * 1000).toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(usageWindow(now, 'week').days[0].day, '2026-09-28');
    assert.equal(usageWindow(now, 'month').days[0].day, '2026-10-01');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('known totals and unknown totals stay distinct, including known zero', () => {
  assert.deepEqual(totalUsage([{ conversations: 1, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0 }, { conversations: 1, tokens: null, inputTokens: null, outputTokens: 4, cacheReadTokens: null, estimatedCostUsd: null }]), {
    conversations: 2, tokens: null, inputTokens: null, outputTokens: 4, cacheReadTokens: null, estimatedCostUsd: null,
  });
});
test('sessions group by start, agent and recorded model; unknown price is not free', (t) => {
  const {home, add} = fixture(t);
  add(now - 1000, 'paid', 100, 0); add(now - 2000, 'local', 30, 0, 'unknown');
  add(now - 3000, null, null, null); add(now + 1000, 'future', 999, 999);
  const result = readServerUsage(home, [{id:'default',name:'Default'}], now, 'day');
  assert.equal(result.total.conversations, 3); assert.equal(result.total.tokens, null);
  assert.equal(result.total.estimatedCostUsd, null); assert.equal(result.totalsKnown.estimatedCostUsd, 0);
  assert.equal(result.models.find(m => m.model === 'paid')?.amount.estimatedCostUsd, 0);
  assert.equal(result.models.find(m => m.model === 'local')?.amount.estimatedCostUsd, null);
  assert.equal(result.basis, 'conversation_started_at');
  assert.equal(result.agents[0].status, 'ok');
});
test('missing store is unavailable, corrupt store is error; partial agents never become complete totals', (t) => {
  const {home, add} = fixture(t); add(now, 'model', 100, 2);
  fs.mkdirSync(path.join(home,'profiles/bad'), {recursive:true}); fs.writeFileSync(path.join(home,'profiles/bad/state.db'), 'invalid database');
  fs.mkdirSync(path.join(home,'profiles/new'), {recursive:true});
  const result = readServerUsage(home, [{id:'default',name:'Default'},{id:'bad',name:'Bad'},{id:'new',name:'New'}], now, 'month');
  assert.equal(result.partial, true); assert.equal(result.total.tokens, null); assert.equal(result.totalsKnown.tokens, 110);
  assert.deepEqual(result.agents.map(a=>a.status), ['ok','error','unavailable']);
});
test('rejects symlinked DB, profile directory, sidecar, escapes and oversized stores without leaking paths', (t) => {
  const {home} = fixture(t); fs.mkdirSync(path.join(home,'profiles'), {recursive:true});
  fs.symlinkSync(home,path.join(home,'profiles/link'));
  const agents = [{id:'link',name:'Link'},{id:'../outside',name:'Escape'}];
  assert.deepEqual(readServerUsage(home, agents, now, 'day').agents.map(a=>a.status), ['error','error']);
  fs.symlinkSync(path.join(home,'state.db'),path.join(home,'state.db-wal'));
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
  fs.unlinkSync(path.join(home,'state.db-wal'));
  fs.renameSync(path.join(home,'state.db'),path.join(home,'original.db')); fs.symlinkSync(path.join(home,'original.db'),path.join(home,'state.db'));
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
});

test('readonly URI includes committed WAL totals without modifying the database or creating absent stores', (t) => {
  const {home,db,add} = fixture(t); db.exec('PRAGMA journal_mode=WAL'); add(now,'included',0,0,'included');
  const file=path.join(home,'state.db'); const before=fs.readFileSync(file);
  const result=readServerUsage(home,[{id:'default',name:'Default'}],now,'day');
  assert.equal(result.total.estimatedCostUsd,0); assert.equal(result.total.tokens,10);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(fs.existsSync(path.join(home,'profiles/missing/state.db')),false);
});
test('optional absent fields stay unknown; malformed timestamps and bounded reads fail closed', (t) => {
  const {home,db} = fixture(t); db.exec('DROP TABLE sessions; CREATE TABLE sessions (started_at REAL)');
  db.prepare('INSERT INTO sessions VALUES (?)').run(now/1000);
  let result=readServerUsage(home,[{id:'default',name:'Default'}],now,'day');
  assert.equal(result.total.tokens,null); assert.equal(result.total.estimatedCostUsd,null); assert.equal(result.models[0].model,null);
  db.prepare('UPDATE sessions SET started_at=?').run(now);
  result=readServerUsage(home,[{id:'default',name:'Default'}],now,'day'); assert.equal(result.agents[0].status,'error');
  db.exec('DELETE FROM sessions; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50001) INSERT INTO sessions SELECT 1 FROM n');
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
});
test('oversized files and root ancestor symlinks are rejected', (t) => {
  const {home,db} = fixture(t); db.close();
  fs.symlinkSync(home,path.join(home,'alias'));
  assert.equal(readServerUsage(path.join(home,'alias'),[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
  fs.truncateSync(path.join(home,'state.db'),64*1024*1024+1);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
});
test('a view cannot substitute an unbounded sessions projection', (t) => {
  const {home,db} = fixture(t);
  db.exec(`DROP TABLE sessions; CREATE VIEW sessions AS SELECT ${now / 1000} AS started_at, 100 AS input_tokens, 10 AS output_tokens`);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
});
