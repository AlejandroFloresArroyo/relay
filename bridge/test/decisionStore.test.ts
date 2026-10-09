import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDecisionStore, deferredDecisionStore } from '../src/decisionStore.ts';
import type { DecisionRecord } from '../../protocol/protocol.ts';
const record: DecisionRecord = { id: 'relay:coding:run_1:req_1', agentId: 'coding', agentName: 'Coding', sessionId: 'session_1', runId: 'run_1', approvalId: 'req_1', toolCallId: null, command: 'rm -rf build', actor: 'person', outcome: 'approved', choice: 'session', at: 1000000, timeKind: 'decision', origin: 'relay', source: 'api_server', originLabel: 'Relay' };
test('a committed decision survives restart and an exact replay is idempotent', async (t) => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decisions-')); t.after(() => fs.rm(directory, {recursive:true,force:true}));
 const store = await createDecisionStore({directory}); await store.append(record); await store.append(record);
 assert.deepEqual((await createDecisionStore({directory})).list(), [record]);
 await assert.rejects(store.append({...record, choice:'once'}));
 assert.equal((await fs.stat(path.join(directory,'decisions.json'))).mode & 0o777, 0o600);
});
test('invalid state and symlink state fail closed without disclosing file contents', async (t) => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decisions-')); t.after(() => fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'decisions.json'),'fixture sensitive invalid', {mode:0o600});
 await assert.rejects(createDecisionStore({directory}), /registro de Decisiones/);
 await fs.unlink(path.join(directory,'decisions.json')); await fs.writeFile(path.join(directory,'target'),'{}', {mode:0o600}); await fs.symlink('target',path.join(directory,'decisions.json'));
 await assert.rejects(createDecisionStore({directory}), /registro de Decisiones/);
});
test('an unconfirmed attempt survives restart without pretending a completed decision', async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-decision-intent-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const store=await createDecisionStore({directory});await store.prepare(record);
 const reopened=await createDecisionStore({directory});assert.deepEqual(reopened.list(),[]);assert.equal(reopened.pending()[0].choice,'session');
 await assert.rejects(reopened.prepare(record),error=>error instanceof Error && 'code' in error && error.code === 'decision_uncertain');
 await reopened.append(record);assert.deepEqual(reopened.pending(),[]);assert.deepEqual(reopened.list(),[record]);
});
test('an oversized private ledger is rejected before reading its contents and never replaced',async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-decision-size-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'decisions.json');await fs.writeFile(file,'',{mode:0o600});await fs.truncate(file,16*1024*1024+1);
 let read=false;const io={...fs,async open(name:Parameters<typeof fs.open>[0],...args:Parameters<typeof fs.open> extends [unknown,...infer A]?A:never){const handle=await fs.open(name,...args);return new Proxy(handle,{get(target,key){if(String(name)===file && (key === 'read' || key === 'readFile'))return ()=>{read=true;throw new Error('Read must not happen');};const value=Reflect.get(target,key,target);return typeof value === 'function'?value.bind(target):value;}});}};
 await assert.rejects(createDecisionStore({directory,io}),error=>error instanceof Error && 'code' in error && error.code === 'decision_store_full');assert.equal(read,false);assert.equal((await fs.stat(file)).size,16*1024*1024+1);
});


test('a full ledger refuses a new attempt without dropping any prior history',async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-decision-write-cap-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const records=Array.from({length:254},(_,index)=>({...record,id:`fixture-${index}`,command:'x'.repeat(65536)}));
 const file=path.join(directory,'decisions.json');const contents=JSON.stringify({schemaVersion:1,decisions:records,intents:[]})+'\n';
 await fs.writeFile(file,contents,{mode:0o600});const store=await createDecisionStore({directory});
 await assert.rejects(store.prepare({...record,id:'over-limit',command:'x'.repeat(65536)}),error=>error instanceof Error && 'code' in error && error.code === 'decision_store_full');
 assert.equal(await fs.readFile(file,'utf8'),contents);assert.deepEqual(store.pending(),[]);assert.equal((await createDecisionStore({directory})).list().length,254);
});


test('a ledger with contradictory actor and outcome evidence fails closed',async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-decision-actor-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'decisions.json'),JSON.stringify({schemaVersion:1,decisions:[{...record,actor:'unknown',outcome:'approved'}],intents:[]}),{mode:0o600});
 await assert.rejects(createDecisionStore({directory}),error=>error instanceof Error && 'code' in error && error.code === 'decision_store_unavailable');
});


test('startup adapter waits for recovery and queued durable writes before history becomes ready',async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-decision-startup-'));
 let blocked=false;let release!:()=>void;let entered!:()=>void;
 const reached=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
 t.after(async()=>{blocked=false;release();await fs.rm(directory,{recursive:true,force:true});});
 const io={...fs,async rename(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1]){if(blocked && String(to).endsWith('/decisions.json')){entered();await gate;}return fs.rename(from,to);}};
 let initialized!: (store:Awaited<ReturnType<typeof createDecisionStore>>)=>void;
 const initialization=new Promise<Awaited<ReturnType<typeof createDecisionStore>>>(resolve=>{initialized=resolve;});
 const adapter=deferredDecisionStore(initialization);let ready=false;
 const recovering=adapter.ready().then(()=>{ready=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(ready,false);
 const store=await createDecisionStore({directory,io});initialized(store);await recovering;
 blocked=true;const write=adapter.prepare(record);await reached;
 ready=false;const waiting=adapter.ready().then(()=>{ready=true;});await new Promise<void>(resolve=>setImmediate(resolve));
 try {assert.equal(ready,false,'History must not be ready while a durable attempt is still being written');}
 finally {blocked=false;release();await write;await waiting;}
 assert.deepEqual((await createDecisionStore({directory})).pending(),[record]);assert.deepEqual(adapter.pending(),[record]);
});
