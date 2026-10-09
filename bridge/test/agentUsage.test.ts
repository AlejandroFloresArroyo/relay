import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readAgentUsage, usageWindow } from '../src/agentUsage.ts';

test('usage counts session accumulators by their start date, excludes old/future and auxiliary consumption, and preserves unknown cost', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-usage-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT); CREATE TABLE session_model_usage (input_tokens INTEGER); INSERT INTO session_model_usage VALUES (900000)');
  const captured = new Date(2026, 9, 4, 12).getTime();
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(2026, 9, 4, 1).getTime() / 1000, 100, 40, 0.41, 'estimated');
  insert.run(new Date(2026, 9, 3, 23).getTime() / 1000, 200, 80, null, 'unknown');
  insert.run(new Date(2026, 8, 1).getTime() / 1000, 40000, 20000, 8, 'estimated');
  insert.run(captured / 1000 + 1, 9000, 9000, 8, 'actual'); db.close();
  const usage = readAgentUsage(root, captured);
  assert.deepEqual(usage.today, { tokens: 140, estimatedCostUsd: 0.41, conversations: 1 });
  assert.deepEqual(usage.last7days, { tokens: 420, estimatedCostUsd: null, conversations: 2 });
  assert.equal(usage.daily.length, 7); assert.equal(usage.daily.at(-1)?.day, '2026-10-04');
  assert.equal(usage.basis, 'conversation_started_at'); assert.equal(usage.includesAuxiliary, false); assert.equal(usage.capturedAt, captured);
});

test('calendar windows retain a 23-hour DST day and expose DB corruption as unavailable rather than zero consumption',async(t)=>{
 const previous=process.env.TZ;process.env.TZ='America/New_York';t.after(()=>{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous});
 const captured=new Date(2026,2,9,12).getTime();const window=usageWindow(captured,1,1);
 assert.deepEqual(window.bins,['2026-03-08']);assert.equal(window.first,new Date(2026,2,8).getTime()/1000);assert.equal(Math.round((window.end-window.first)*1000),23*3600*1000-1);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-usage-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'state.db'),'not a database');
 assert.throws(()=>readAgentUsage(root,captured),{code:'agent_details_unavailable'});
});

test('a zero with unknown cost status remains unavailable without losing tokens or conversation counts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-cost-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = new Date(2026, 9, 4, 12).getTime();
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?,100,40,0,?)').run(captured / 1000, 'unknown'); db.close();
  const usage = readAgentUsage(root, captured);
  assert.deepEqual(usage.today, { tokens: 140, estimatedCostUsd: null, conversations: 1 });
  assert.deepEqual(usage.last7days, { tokens: 140, estimatedCostUsd: null, conversations: 1 });
  assert.deepEqual(usage.daily.at(-1), { day: '2026-10-04', tokens: 140, estimatedCostUsd: null, conversations: 1 });
});

for (const status of ['estimated', 'actual', 'included']) {
  for (const cost of [0, 0.5, null]) {
    test(`${status} retains its reported cost ${cost} and tokens`, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-known-cost-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const captured = new Date(2026, 9, 4, 12).getTime();
      const db = new DatabaseSync(path.join(root, 'state.db'));
      db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
      db.prepare('INSERT INTO sessions VALUES (?,NULL,40,?,?)').run(captured / 1000, cost, status); db.close();
      const usage = readAgentUsage(root, captured);
      assert.deepEqual(usage.today, { tokens: 40, estimatedCostUsd: cost, conversations: 1 });
      assert.deepEqual(usage.last7days, usage.today);
    });
  }
}

for (const status of ['unknown', null, 'future_status']) {
  test(`unconfirmed status ${status} cannot confirm a positive reported cost`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-unconfirmed-cost-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const captured = new Date(2026, 9, 4, 12).getTime();
    const db = new DatabaseSync(path.join(root, 'state.db'));
    db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?,100,40,0.5,?)').run(captured / 1000, status); db.close();
    const usage = readAgentUsage(root, captured);
    assert.deepEqual(usage.today, { tokens: 140, estimatedCostUsd: null, conversations: 1 });
    assert.deepEqual(usage.last7days, usage.today);
  });
}

test('unknown cost propagates through a mixed day and seven-day total without contaminating known days or counting outside the window', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-mixed-cost-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = new Date(2026, 9, 4, 12).getTime();
  const first = new Date(2026, 8, 28).getTime() / 1000;
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)');
  insert.run(first - 0.001, 9000, 9000, 0, 'unknown');
  insert.run(first, 10, 5, 0.25, 'estimated');
  insert.run(first + 1, 20, 10, 0, 'unknown');
  insert.run(first + 2, 5, 0, 0.25, 'included');
  insert.run(new Date(2026, 9, 3, 23).getTime() / 1000, 30, 15, 0.5, 'actual');
  insert.run(captured / 1000, 40, 20, 0, 'included');
  insert.run(captured / 1000 + 0.001, 9000, 9000, 0, 'unknown'); db.close();
  const usage = readAgentUsage(root, captured);
  assert.deepEqual(usage.today, { tokens: 60, estimatedCostUsd: 0, conversations: 1 });
  assert.deepEqual(usage.last7days, { tokens: 155, estimatedCostUsd: null, conversations: 5 });
  assert.deepEqual(usage.daily[0], { day: '2026-09-28', tokens: 50, estimatedCostUsd: null, conversations: 3 });
  assert.deepEqual(usage.daily[1], { day: '2026-09-29', tokens: 0, estimatedCostUsd: 0, conversations: 0 });
  assert.deepEqual(usage.daily[5], { day: '2026-10-03', tokens: 45, estimatedCostUsd: 0.5, conversations: 1 });
});

test('a compatible schema without cost status retains usage with unavailable cost', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-legacy-cost-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = new Date(2026, 9, 4, 12).getTime();
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
  insert.run(captured / 1000, 100, 40, 0);
  insert.run(captured / 1000, 200, 80, 0.5); db.close();
  const usage = readAgentUsage(root, captured);
  assert.deepEqual(usage.today, { tokens: 420, estimatedCostUsd: null, conversations: 2 });
  assert.deepEqual(usage.last7days, usage.today);
});

test('unknown status does not bypass validation of malformed costs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-invalid-cost-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = new Date(2026, 9, 4, 12).getTime();
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, cost_status TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?,100,40,-1,?)').run(captured / 1000, 'unknown'); db.close();
  assert.throws(() => readAgentUsage(root, captured), { code: 'agent_details_unavailable' });
});

test('a schema missing required usage columns remains unavailable rather than reporting zero', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-agent-incompatible-cost-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured = new Date(2026, 9, 4, 12).getTime();
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec('CREATE TABLE sessions (started_at REAL, input_tokens INTEGER, output_tokens INTEGER)');
  db.prepare('INSERT INTO sessions VALUES (?,100,40)').run(captured / 1000); db.close();
  assert.throws(() => readAgentUsage(root, captured), { code: 'agent_details_unavailable' });
});
