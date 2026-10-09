import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChangeLog } from '../src/changeLog.ts';
import { createKanbanStore, createKanbanStoreForStateRoot, type KanbanIO, type StoredReceipt } from '../src/kanbanStore.ts';
import { Kanban } from '../src/kanban.ts';
import type { KanbanNotifyReceipt } from '../../protocol/kanban.ts';
const NOW = 1791115200000;
const AUTHOR = { kind: 'device' as const, id: '00000000-0000-4000-8000-000000000001', name: 'synthetic-device' };
async function fixture(t: test.TestContext, io?: KanbanIO) {
  const directory = await fs.mkdtemp(path.resolve('.kanban-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const changeLog = createChangeLog({ file: path.join(directory, 'changes.jsonl'), now: () => NOW });
  await changeLog.ready();
  const open = async () => new Kanban({ store: await createKanbanStore({ directory, changeLog, io, now: () => NOW }), now: () => NOW,
    agentExists: async id => id === 'dev' });
  return { directory, open, changeLog, kanban: await open() };
}
const create = (requestId: string, title = 'Manual work') => ({ requestId, title, agentId: 'dev', column: 'todo', blockedBy: [] });
test('manual item persists, keeps a private prior snapshot, and replays without changing metadata or audit', async t => {
  const { kanban, open, directory } = await fixture(t);
  const result = await kanban.create(create('create_01'), AUTHOR, () => {});
  assert.equal(result.item.number, 1);
  assert.equal(result.item.title, 'Manual work');
  const updated = await kanban.update(result.item.id, { requestId: 'update_01', revision: result.item.revision, column: 'done' }, AUTHOR, () => {});
  const before = await fs.readFile(path.join(directory, 'kanban.json'));
  const restarted = await open();
  assert.deepEqual(await restarted.create(create('create_01'), AUTHOR, () => {}), result);
  assert.equal((await restarted.detail(result.item.id, AUTHOR, () => {})).item.column, 'done');
  assert.deepEqual(await fs.readFile(path.join(directory, 'kanban.json')), before);
  assert.notEqual(updated.item.revision, result.item.revision);
  const stored = JSON.parse(before.toString());
  assert.equal(stored.previous.items[0].column, 'todo');
  assert.equal((await fs.stat(path.join(directory, 'kanban.json'))).mode & 0o777, 0o600);
  const audit = await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8');
  assert.equal(audit.trim().split('\n').length, 2);
  assert.doesNotMatch(audit, /Manual work|"column"|"revision"/);
});

test('stale edits and cycles fail atomically; independent human comments never become Agent work',async t=>{
  const {kanban}=await fixture(t),a=await kanban.create(create('create_01','A'),AUTHOR,()=>{}),b=await kanban.create({...create('create_02','B'),blockedBy:[a.item.id]},AUTHOR,()=>{});
  await assert.rejects(kanban.update(a.item.id,{requestId:'update_01',revision:a.item.revision,blockedBy:[b.item.id]},AUTHOR,()=>{}),{code:'kanban_invalid_request'});
  await assert.rejects(kanban.update(a.item.id,{requestId:'update_02',revision:a.item.revision,column:'blocked',blockedBy:[]},AUTHOR,()=>{}),{code:'kanban_invalid_request'});
  const [first,second]=await Promise.allSettled([
    kanban.update(a.item.id,{requestId:'update_03',revision:a.item.revision,title:'Changed'},AUTHOR,()=>{}),
    kanban.update(a.item.id,{requestId:'update_04',revision:a.item.revision,column:'done'},AUTHOR,()=>{}),
  ]);
  assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');
  if (second.status==='rejected') assert.equal(second.reason.code,'kanban_conflict');
  assert.equal((await kanban.detail(a.item.id,AUTHOR,()=>{})).item.column,'todo');
  const comment=await kanban.comment(b.item.id,{requestId:'comment_01',revision:b.item.revision,text:'@dev\nHuman only'},AUTHOR,()=>{});
  assert.equal(comment.comment.number,1);assert.equal(comment.item.commentCount,1);
  assert.equal((await kanban.comments(b.item.id,{},AUTHOR,()=>{})).comments[0].text,'@dev\nHuman only');
  await assert.rejects(kanban.create({...create('create_01'),title:'Other'},AUTHOR,()=>{}),{code:'kanban_conflict'});
  await assert.rejects(kanban.update(b.item.id,{requestId:'create_01',revision:b.item.revision,title:'Other'},AUTHOR,()=>{}),{code:'kanban_conflict'});
});

test('cursor binds device, filter, resource, limit and revision, with full counts and stable tie ordering',async t=>{
  const {kanban}=await fixture(t);await kanban.create(create('create_01'),AUTHOR,()=>{});await kanban.create(create('create_02'),AUTHOR,()=>{});
  const first=await kanban.list({limit:1},AUTHOR,()=>{});assert.ok(first.nextCursor);assert.equal(first.counts.todo,2);
  const second=await kanban.list({limit:1,cursor:first.nextCursor},AUTHOR,()=>{});assert.equal(second.nextCursor,null);assert.ok(first.items[0].id<second.items[0].id);
  const other={...AUTHOR,id:'00000000-0000-4000-8000-000000000002'};
  await assert.rejects(kanban.list({limit:1,cursor:first.nextCursor},other,()=>{}),{code:'kanban_conflict'});
  await assert.rejects(kanban.list({limit:1,column:'done',cursor:first.nextCursor},AUTHOR,()=>{}),{code:'kanban_conflict'});
  await assert.rejects(kanban.comments(first.items[0].id,{limit:1,cursor:first.nextCursor},AUTHOR,()=>{}),{code:'kanban_conflict'});
  const original=Buffer.from(first.nextCursor,'base64url'),payload=JSON.parse(original.subarray(0,-32).toString());payload.o=2;
  const modified=Buffer.concat([Buffer.from(JSON.stringify(payload)),original.subarray(-32)]);
  await assert.rejects(kanban.list({limit:1,cursor:modified.toString('base64url')},AUTHOR,()=>{}),{code:'kanban_conflict'});
  await kanban.comment(first.items[0].id,{requestId:'comment_01',revision:first.items[0].revision,text:'Changes revision'},AUTHOR,()=>{});
  await assert.rejects(kanban.list({limit:1,cursor:first.nextCursor},AUTHOR,()=>{}),{code:'kanban_conflict'});
});

test('request bounds and strict shapes reject without any mutation or new receipt',async t=>{
  const {kanban}=await fixture(t);
  for (const body of [{...create('bad'),title:'A'},{...create('valid_001'),extra:'private-canary'},{...create('valid_002'),title:'x'.repeat(201)},
    {...create('valid_003'),title:'A\u0000'},{...create('valid_004'),agentId:'missing'},{...create('valid_005'),blockedBy:['00000000-0000-4000-8000-000000000003']}]) {
    await assert.rejects(kanban.create(body,AUTHOR,()=>{}));
  }
  assert.equal((await kanban.list({},AUTHOR,()=>{})).items.length,0);
  const created=await kanban.create({...create('create_01'),title:'  Saved  '},AUTHOR,()=>{});assert.equal(created.item.title,'Saved');
  for (const text of ['\u0000secret',' '.repeat(4096),'é'.repeat(2049)]) await assert.rejects(kanban.comment(created.item.id,{requestId:'comment_01',revision:created.item.revision,text},AUTHOR,()=>{}),{code:'kanban_invalid_request'});
  const comment=await kanban.comment(created.item.id,{requestId:'comment_01',revision:created.item.revision,text:'é'.repeat(2048)},AUTHOR,()=>{});assert.equal(comment.comment.number,1);
});

test('a foreign file appearing after an empty read is never adopted or overwritten',async t=>{
  const {kanban,directory}=await fixture(t);
  const bytes='private-foreign-canary';await fs.writeFile(path.join(directory,'kanban.json'),bytes,{mode:0o600});
  await assert.rejects(kanban.create(create('create_01'),AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
  assert.equal(await fs.readFile(path.join(directory,'kanban.json'),'utf8'),bytes);
});

test('private state rejects symlinks, hardlinks, permissive mode, replacement, missing and oversized bytes',async t=>{
  for (const attack of ['symlink','hardlink','mode','replacement','missing','oversize','corrupt','schema']) {
    const {kanban,directory,open}=await fixture(t),item=await kanban.create(create('create_01'),AUTHOR,()=>{}),file=path.join(directory,'kanban.json');
    const bytes=await fs.readFile(file),before=file+'.safe';await fs.writeFile(before,bytes,{mode:0o600});
    if (attack==='symlink') {await fs.unlink(file);await fs.symlink(before,file);}
    if (attack==='hardlink') await fs.link(file,file+'.linked');
    if (attack==='mode') await fs.chmod(file,0o644);
    if (attack==='replacement') {await fs.unlink(file);await fs.writeFile(file,bytes,{mode:0o600});}
    if (attack==='missing') await fs.unlink(file);
    if (attack==='oversize') await fs.writeFile(file,Buffer.concat([bytes,Buffer.alloc(16*1024*1024+1-bytes.length,32)]));
    if (attack==='corrupt') await fs.writeFile(file,'private-corruption-canary');
    if (attack==='schema') await fs.writeFile(file,JSON.stringify({...JSON.parse(bytes.toString()),schemaVersion:2}));
    await assert.rejects(kanban.detail(item.item.id,AUTHOR,()=>{}),{code:'kanban_store_unavailable'},attack);
    if (!['replacement','missing'].includes(attack)) await assert.rejects(open(),{code:'kanban_store_unavailable'},attack);
    assert.deepEqual(await fs.readFile(before),bytes,attack);
  }
});

test('symlinked ancestors and replacement during IO cannot reach or change the original private state',async t=>{
  const {directory,changeLog,kanban}=await fixture(t);await kanban.create(create('create_01'),AUTHOR,()=>{});
  const link=directory+'-link';await fs.symlink(directory,link);t.after(()=>fs.unlink(link));
  await assert.rejects(createKanbanStore({directory:link,changeLog}),{code:'kanban_store_unavailable'});
  let switched=false;const file=path.join(directory,'kanban.json'),bytes=await fs.readFile(file);
  const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{
    const handle=await fs.open(...args);
    if (String(args[0]).endsWith('/kanban.json')&&!switched) {switched=true;await fs.rename(file,file+'.prior');await fs.writeFile(file,bytes,{mode:0o600});}
    return handle;
  }};
  await assert.rejects(createKanbanStore({directory,changeLog,io}),{code:'kanban_store_unavailable'});
  assert.deepEqual(await fs.readFile(file+'.prior'),bytes);
});

test('a failed atomic replacement leaves the old version readable and retryable after recovery',async t=>{
  let fail=false;const io={...fs,rename:async(...args:Parameters<typeof fs.rename>)=>{if(fail)throw new Error('private-rename-canary');return fs.rename(...args);}};
  const {kanban,open,directory}=await fixture(t,io),created=await kanban.create(create('create_01'),AUTHOR,()=>{}),bytes=await fs.readFile(path.join(directory,'kanban.json'));
  fail=true;await assert.rejects(kanban.update(created.item.id,{requestId:'update_01',revision:created.item.revision,column:'done'},AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
  assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),bytes);fail=false;
  const recovered=await open();assert.equal((await recovered.detail(created.item.id,AUTHOR,()=>{})).item.column,'todo');
  const retried=await recovered.update(created.item.id,{requestId:'update_01',revision:created.item.revision,column:'done'},AUTHOR,()=>{});assert.equal(retried.item.column,'done');
});

test('durable metadata and outbox survive a failed audit append; no success precedes audit ACK and recovery deduplicates it',async t=>{
  const {kanban,open,directory}=await fixture(t),file=path.join(directory,'changes.jsonl');
  await fs.rename(file,file+'.safe');await fs.symlink(file+'.safe',file);
  await assert.rejects(kanban.create(create('create_01'),AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
  await fs.unlink(file);await fs.rename(file+'.safe',file);
  const recovered=await open(),replayed=await recovered.create(create('create_01'),AUTHOR,()=>{});
  assert.equal(replayed.item.number,1);assert.equal((await recovered.list({},AUTHOR,()=>{})).items.length,1);
  assert.equal((await fs.readFile(file,'utf8')).trim().split('\n').length,1);
});

test('interrupted durable pending intent becomes uncertain on recovery without any send port',async t=>{
  const {directory,changeLog,kanban}=await fixture(t),created=await kanban.create(create('create_01'),AUTHOR,()=>{});
  const store=await createKanbanStore({directory,changeLog,now:()=>NOW});
  await store.mutate(draft=>{draft.receipts.push({deviceId:AUTHOR.id,requestId:'notify_001',fingerprint:'1'.repeat(64),itemId:created.item.id,kind:'notify',result:{requestId:'notify_001',itemId:created.item.id,itemRevision:created.item.revision,agentId:'dev',requestedBy:AUTHOR,requestedAt:NOW,updatedAt:NOW,state:'pending',conversationId:'relay_known',runId:null,errorCode:null}});},()=>{});
  const recovered=await createKanbanStore({directory,changeLog,now:()=>NOW+1000});
  const service=new Kanban({store:recovered,agentExists:async()=>{throw new Error('Recovery must not contact Hermes');},now:()=>NOW+1000});
  const receipt=await service.notification(created.item.id,'notify_001',AUTHOR,()=>{});assert.equal(receipt.state,'uncertain');assert.equal(receipt.conversationId,'relay_known');assert.equal(receipt.runId,null);assert.equal(receipt.updatedAt,NOW+1000);
  assert.match(await fs.readFile(path.join(directory,'changes.jsonl'),'utf8'),/kanban.notify.uncertain/);
});

test('revocation during staging aborts metadata replacement and audit; a later permitted retry gets number one',async t=>{
  const {AuthorizationError}=await import('../src/auth.ts');
  let entered!:()=>void,release!:()=>void,revoked=false,armed=false;
  const opened=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});t.after(()=>release?.());
  const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args);if(armed && String(args[0]).includes('/.kanban.')) {armed=false;entered();await gate;}return handle;}};
  const {kanban,open,directory}=await fixture(t,io),guard=()=>{if(revoked)throw new AuthorizationError('device_revoked');};armed=true;
  const pending=kanban.create(create('create_01'),AUTHOR,guard);await opened;revoked=true;release();
  await assert.rejects(pending,{code:'device_revoked'});await assert.rejects(fs.stat(path.join(directory,'kanban.json')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(directory,'changes.jsonl'),'utf8'),'');revoked=false;
  assert.equal((await (await open()).create(create('create_01'),AUTHOR,guard)).item.number,1);
});

test('seconds from a broken clock cannot be committed as Server milliseconds',async t=>{
  const {directory,changeLog}=await fixture(t),store=await createKanbanStore({directory,changeLog});
  const service=new Kanban({store,agentExists:async()=>true,now:()=>1791115200});
  await assert.rejects(service.create(create('create_01'),AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
  assert.equal((await (await fixture(t)).kanban.list({},AUTHOR,()=>{})).items.length,0);
});

test('500 elements and 200 human comments per element are hard caps; replays remain readable at capacity',async t=>{
  const {directory,changeLog,kanban}=await fixture(t),first=await kanban.create(create('create_0000'),AUTHOR,()=>{});
  const store=await createKanbanStore({directory,changeLog}),{itemRevision}=await import('../src/kanbanValidation.ts'),{randomUUID}=await import('node:crypto');
  // One bounded synthetic import avoids hundreds of fsyncs just to populate a limit fixture.
  await store.mutate(draft=>{for(let n=1;n<500;n++){const item={...first.item,id:randomUUID(),number:n+1};item.revision=itemRevision(item);draft.items.push(item);}draft.nextNumber=501;},()=>{});
  const full=new Kanban({store,now:()=>NOW,agentExists:async()=>true});
  await assert.rejects(full.create(create('create_full'),AUTHOR,()=>{}),{code:'kanban_store_full'});
  assert.equal((await full.list({limit:100},AUTHOR,()=>{})).counts.todo,500);
  assert.deepEqual(await full.create(create('create_0000'),AUTHOR,()=>{}),first);
  const second=await fixture(t),created=await second.kanban.create(create('create_01'),AUTHOR,()=>{}),commentStore=await createKanbanStore({directory:second.directory,changeLog:second.changeLog});
  // Same synthetic import for 199 comments; only the boundary goes through the durable API.
  await commentStore.mutate(draft=>{const item=draft.items[0];for(let n=1;n<200;n++)draft.comments.push({itemId:item.id,comment:{id:randomUUID(),number:n,author:AUTHOR,text:'Human',createdAt:NOW}});item.commentCount=199;item.revision=itemRevision(item);},()=>{});
  const fresh=new Kanban({store:commentStore,now:()=>NOW,agentExists:async()=>true}),revision=commentStore.snapshot().items[0].revision;
  const last=await fresh.comment(created.item.id,{requestId:'comment_0199',revision,text:'Human'},AUTHOR,()=>{});assert.equal(last.comment.number,200);
  await assert.rejects(fresh.comment(created.item.id,{requestId:'comment_full',revision:last.item.revision,text:'Human'},AUTHOR,()=>{}),{code:'kanban_store_full'});
  assert.deepEqual(await fresh.comment(created.item.id,{requestId:'comment_0199',revision,text:'Human'},AUTHOR,()=>{}),last);
  assert.equal((await fresh.detail(created.item.id,AUTHOR,()=>{})).item.commentCount,200);
});

test('shared receipt capacity rejects new requests without silently evicting prior idempotency',async t=>{
  const {directory,changeLog,kanban}=await fixture(t),created=await kanban.create(create('create_01'),AUTHOR,()=>{}),store=await createKanbanStore({directory,changeLog});
  await store.mutate(draft=>{
    for(let n=1;n<20000;n++) {const requestId=`fixture_${String(n).padStart(5,'0')}`;draft.receipts.push({deviceId:AUTHOR.id,requestId,fingerprint:'1'.repeat(64),itemId:created.item.id,kind:'create',result:{requestId,item:structuredClone(created.item)}});}
  },()=>{});
  const service=new Kanban({store,now:()=>NOW,agentExists:async()=>true});
  await assert.rejects(service.create(create('create_02'),AUTHOR,()=>{}),{code:'kanban_store_full'});
  assert.deepEqual(await service.create(create('create_01'),AUTHOR,()=>{}),created);
  assert.equal((await service.list({},AUTHOR,()=>{})).items.length,1);
});

test('directory fsync failure never acknowledges success; recovery finds the committed receipt and audits it once',async t=>{
  let armed=false;const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args),sync=handle.sync.bind(handle);handle.sync=async()=>{if(armed&&(await handle.stat()).isDirectory()){armed=false;throw new Error('private-fsync-canary');}await sync();};return handle;}};
  const {kanban,open,directory}=await fixture(t,io);armed=true;
  await assert.rejects(kanban.create(create('create_01'),AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
  const recovered=await open(),receipt=await recovered.create(create('create_01'),AUTHOR,()=>{});assert.equal(receipt.item.number,1);
  assert.equal((await fs.readFile(path.join(directory,'changes.jsonl'),'utf8')).trim().split('\n').length,1);
});

test('private state byte capacity includes the previous snapshot and never overwrites on overflow',async t=>{
  const {directory,changeLog,kanban}=await fixture(t),created=await kanban.create(create('create_01'),AUTHOR,()=>{}),file=path.join(directory,'kanban.json'),store=await createKanbanStore({directory,changeLog});
  // Synthetic valid receipts provide a bounded large prior version without upstream effects.
  await store.mutate(draft=>{for(let n=1;n<18000;n++){const requestId=`fixture_${String(n).padStart(5,'0')}`;draft.receipts.push({deviceId:AUTHOR.id,requestId,fingerprint:'1'.repeat(64),itemId:created.item.id,kind:'create',result:{requestId,item:structuredClone(created.item)}});}},()=>{});
  const before=await fs.readFile(file),service=new Kanban({store,now:()=>NOW,agentExists:async()=>true});
  await assert.rejects(service.update(created.item.id,{requestId:'update_01',revision:created.item.revision,column:'done'},AUTHOR,()=>{}),{code:'kanban_store_full'});
  assert.deepEqual(await fs.readFile(file),before);
  assert.equal((await service.detail(created.item.id,AUTHOR,()=>{})).item.column,'todo');
});

test('idempotency compares the exact validated fields independent of JSON object key order',async t=>{
  const {kanban}=await fixture(t),body=create('create_01'),created=await kanban.create(body,AUTHOR,()=>{});
  const reordered={blockedBy:body.blockedBy,column:body.column,agentId:body.agentId,title:body.title,requestId:body.requestId};
  assert.deepEqual(await kanban.create(reordered,AUTHOR,()=>{}),created);
});

test('a missing previously initialized store fails closed through restart instead of dropping receipts and resetting numbers',async t=>{
  const {kanban,directory,open}=await fixture(t);await kanban.create(create('create_01'),AUTHOR,()=>{});
  await fs.unlink(path.join(directory,'kanban.json'));
  await assert.rejects(open(),{code:'kanban_store_unavailable'});
  await assert.rejects(fs.stat(path.join(directory,'kanban.json')),{code:'ENOENT'});
});

test('initialization marker rejects replacement, hardlinks, permissive permissions and corrupt/versioned bytes without repair',async t=>{
  for(const attack of ['symlink','hardlink','mode','corrupt','version','missing']) {
    const {kanban,directory,open}=await fixture(t),created=await kanban.create(create('create_01'),AUTHOR,()=>{}),file=path.join(directory,'kanban.initialized'),state=await fs.readFile(path.join(directory,'kanban.json'));
    if(attack==='symlink'){await fs.rename(file,file+'.safe');await fs.symlink(file+'.safe',file);}
    if(attack==='hardlink')await fs.link(file,file+'.linked');
    if(attack==='mode')await fs.chmod(file,0o644);
    if(attack==='corrupt')await fs.writeFile(file,'private-marker-canary');
    if(attack==='version')await fs.writeFile(file,'Relay Kanban v2\n');
    if(attack==='missing')await fs.unlink(file);
    await assert.rejects(kanban.detail(created.item.id,AUTHOR,()=>{}),{code:'kanban_store_unavailable'},attack);
    if(attack!=='missing')await assert.rejects(open(),{code:'kanban_store_unavailable'},attack);
    assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),state);
  }
});

test('review: retained rename admits only one cooperative writer and never loses an acknowledged receipt',async t=>{
  const {kanban,directory,changeLog,open}=await fixture(t),item=(await kanban.create(create('create_01'),AUTHOR,()=>{})).item;
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(); t.after(()=>release.resolve());
  let armed=true;
  const io={...fs,rename:async(...args:Parameters<typeof fs.rename>)=>{if(armed){armed=false;entered.resolve();await release.promise;}return fs.rename(...args);}};
  const store=await createKanbanStore({directory,changeLog,io,now:()=>NOW});
  const second=new Kanban({store,now:()=>NOW,agentExists:async()=>true});
  const pending=second.update(item.id,{requestId:'second_01',revision:item.revision,title:'Second writer'},AUTHOR,()=>{});
  const outcome=pending.then(value=>({value,error:null}),error=>({value:null,error}));
  await entered.promise;
  let acknowledged:Awaited<ReturnType<Kanban['update']>>|null=null,firstError:unknown=null;
  try{acknowledged=await kanban.update(item.id,{requestId:'first_01',revision:item.revision,column:'done'},AUTHOR,()=>{});}catch(error){firstError=error;}
  release.resolve();const later=await outcome;
  const state=JSON.parse(await fs.readFile(path.join(directory,'kanban.json'),'utf8'));
  // Original Standards window is unchanged. Exclusion now rejects the overlapping contender
  // rather than letting it acknowledge a receipt that the retained rename would erase.
  assert.equal(Number(acknowledged!==null)+Number(later.value!==null),1,'Only one overlapping cooperative writer may acknowledge success');
  assert.equal((firstError as {code:string})?.code,'kanban_store_unavailable');assert.equal(later.error,null);
  for(const result of [acknowledged,later.value].filter(r=>r!==null))assert.ok(state.data.receipts.some((r:{requestId:string})=>r.requestId===result.requestId),'Every acknowledged receipt must remain durable');
  assert.ok(state.data.receipts.some((r:{requestId:string})=>r.requestId==='create_01'));assert.equal(state.data.items[0].title,'Second writer');
  await assert.rejects(kanban.detail(item.id,AUTHOR,()=>{}),{code:'kanban_store_unavailable'},'External replacement invalidates the old store');
  const reopened=await open();assert.deepEqual(await reopened.update(item.id,{requestId:'second_01',revision:item.revision,title:'Second writer'},AUTHOR,()=>{}),later.value);
});

test('a held directory lease excludes a second process; a crash or foreign lock is never stolen',async t=>{
 const {kanban,directory,changeLog,open}=await fixture(t),item=(await kanban.create(create('create_01'),AUTHOR,()=>{})).item;
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();t.after(()=>release.resolve());let armed=true;
 const io={...fs,rename:async(...args:Parameters<typeof fs.rename>)=>{if(armed){armed=false;entered.resolve();await release.promise;}return fs.rename(...args);}};
 const second=new Kanban({store:await createKanbanStore({directory,changeLog,io}),now:()=>NOW,agentExists:async()=>true});
 const pending=second.update(item.id,{requestId:'second_01',revision:item.revision,column:'done'},AUTHOR,()=>{});
 const result=pending.then(v=>v,e=>{throw e;});await entered.promise;const lock=path.join(directory,'kanban.lock'),before=await fs.stat(lock,{bigint:true});
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const script=`import {createKanbanStore} from './src/kanbanStore.ts';import {createChangeLog} from './src/changeLog.ts';try{await createKanbanStore({directory:process.argv[1],changeLog:createChangeLog({file:process.argv[1]+'/changes.jsonl'})});console.log('unexpected success');}catch(e){console.log(e.code);}`;
 const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,directory],{cwd:process.cwd(),timeout:5000});
 assert.equal(child.stdout.trim(),'kanban_store_unavailable');const after=await fs.stat(lock,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mtimeNs,before.mtimeNs);
 release.resolve();assert.equal((await result).item.column,'done');await assert.rejects(fs.stat(lock),{code:'ENOENT'});
 const receipt=await (await open()).update(item.id,{requestId:'second_01',revision:item.revision,column:'done'},AUTHOR,()=>{});assert.equal(receipt.item.column,'done');
 // A leftover lease needs operator recovery. No process guesses ownership from PID/age.
 await fs.writeFile(lock,'foreign-lock-canary',{mode:0o600});await assert.rejects(open(),{code:'kanban_store_unavailable'});assert.equal(await fs.readFile(lock,'utf8'),'foreign-lock-canary');
});

test('lease ownership replacement is never unlinked, and revocation during lease acquisition cannot replace metadata',async t=>{
 const {directory,changeLog,kanban,open}=await fixture(t),item=(await kanban.create(create('create_01'),AUTHOR,()=>{})).item;
 let armed=false;const io={...fs,rename:async(...args:Parameters<typeof fs.rename>)=>{const result=await fs.rename(...args);if(armed){armed=false;const lock=path.join(directory,'kanban.lock');await fs.rename(lock,lock+'.owned');await fs.writeFile(lock,'foreign-lock-canary',{mode:0o600});}return result;}};
 const store=await createKanbanStore({directory,changeLog,io}),service=new Kanban({store,now:()=>NOW,agentExists:async()=>true});armed=true;
 await assert.rejects(service.update(item.id,{requestId:'update_01',revision:item.revision,column:'done'},AUTHOR,()=>{}),{code:'kanban_store_unavailable'});
 assert.equal(await fs.readFile(path.join(directory,'kanban.lock'),'utf8'),'foreign-lock-canary');
 await fs.unlink(path.join(directory,'kanban.lock'));await fs.unlink(path.join(directory,'kanban.lock.owned'));const current=(await (await open()).detail(item.id,AUTHOR,()=>{})).item;
 const before=await fs.readFile(path.join(directory,'kanban.json'));let revoked=false,ready=false;
 const {AuthorizationError}=await import('../src/auth.ts');const guard=()=>{if(revoked)throw new AuthorizationError('device_revoked');};
 const blockedIO={...fs,open:async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args);if(ready&&String(args[0]).endsWith('/kanban.lock'))revoked=true;return handle;}};
 const blocked=new Kanban({store:await createKanbanStore({directory,changeLog,io:blockedIO}),now:()=>NOW,agentExists:async()=>true});ready=true;
 await assert.rejects(blocked.update(item.id,{requestId:'update_02',revision:current.revision,column:'todo'},AUTHOR,guard),{code:'device_revoked'});assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),before);await assert.rejects(fs.stat(path.join(directory,'kanban.lock')),{code:'ENOENT'});
});

// CPU-bound on purpose: ~15 full passes over a real 16 MiB checkpoint (~2 s idle, measured up to 27 s at
// load 100+). The suite's 20 s timeout is only a hang backstop and guards no behaviour here.
test('capacity recovery preserves readable uncertain receipts and never rewrites a valid near-full checkpoint',{timeout:60_000},async t=>{
 const {directory,changeLog}=await fixture(t),MAX=16*1024*1024;
 const store=await createKanbanStore({directory,changeLog,now:()=>NOW});
 const kanban=new Kanban({store,now:()=>NOW,agentExists:async()=>true});
 const initial=await kanban.create({requestId:'create_01',title:'T'.repeat(200),agentId:'dev',column:'todo',blockedBy:[]},AUTHOR,()=>{});
 const data=store.snapshot();
 const row=(n:number):StoredReceipt=>({deviceId:AUTHOR.id,requestId:'fixture_'+String(n).padStart(5,'0'),fingerprint:'1'.repeat(64),itemId:initial.item.id,kind:'update',result:{requestId:'fixture_'+String(n).padStart(5,'0'),item:structuredClone(initial.item)}});
 const pending:StoredReceipt={deviceId:AUTHOR.id,requestId:'notify_001',fingerprint:'2'.repeat(64),itemId:initial.item.id,kind:'notify',result:{requestId:'notify_001',itemId:initial.item.id,itemRevision:initial.item.revision,agentId:'dev',requestedBy:AUTHOR,requestedAt:NOW,updatedAt:NOW,state:'pending',conversationId:null,runId:null,errorCode:null}};
 data.receipts.push(pending);
 const checkpointSize=()=>Buffer.byteLength(JSON.stringify({schemaVersion:1,data,previous:data})+'\n');
 const rowBytes=Buffer.byteLength(JSON.stringify(row(1)))+1;
 const count=Math.floor((MAX-500-checkpointSize())/(2*rowBytes));
 for(let n=1;n<=count;n++)data.receipts.push(row(n));
 let padding=Math.max(0,Math.floor((MAX-120-checkpointSize())/4));
 for(let n=data.receipts.length-1;padding>0&&n>0;n--){
   const row=data.receipts[n],add=Math.min(128-row.requestId.length,padding);
   row.requestId+='x'.repeat(add);row.result.requestId=row.requestId;padding-=add;
 }
 assert.equal(padding,0);
 // One plain write of the near-full checkpoint (backup holds the same receipts) instead of two
 // fsynced 16 MiB commits; the recovery opens below validate it through the real store.
 const latest=structuredClone(data);(latest.receipts.find(r=>r.kind==='notify')!.result as KanbanNotifyReceipt).updatedAt=NOW+1;
 await fs.writeFile(path.join(directory,'kanban.json'),JSON.stringify({schemaVersion:1,data:latest,previous:data})+'\n');
 const bytes=await fs.readFile(path.join(directory,'kanban.json'));
 assert.equal(bytes.length,16_777_096);assert.equal(MAX-bytes.length,120);
 let recovery;try{await createKanbanStore({directory,changeLog,now:()=>NOW+2});recovery='readable'}catch(error){recovery=(error as {code:string}).code}
 assert.equal(recovery,'readable','previous receipts must stay accessible at capacity; pending recovery must not require an over-cap rewrite');
 const recovered=await createKanbanStore({directory,changeLog,now:()=>NOW+3});
 let starts=0;const service=new Kanban({store:recovered,now:()=>NOW+3,agentExists:async()=>true,notifications:{admit:async(operation,guard)=>operation(guard),start:async()=>{starts++;throw new Error('Recovery must not dispatch');},observe:async()=>null}});
 const result=await service.notification(initial.item.id,'notify_001',AUTHOR,()=>{});assert.equal(result.state,'uncertain');assert.equal(result.runId,null);
 assert.deepEqual(await recovered.read(()=>{}),recovered.snapshot());assert.equal((await service.detail(initial.item.id,AUTHOR,()=>{})).item.number,1);
 assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),bytes,'Read-only recovery must preserve the entire valid checkpoint and backup');
 const {itemRevision}=await import('../src/kanbanValidation.ts');await assert.rejects(recovered.mutate(draft=>{draft.items[0].title='Small';draft.items[0].revision=itemRevision(draft.items[0]);},()=>{}),{code:'kanban_store_full'},'Even a smaller valid mutation cannot bypass readonly recovery');
 await assert.rejects(service.comment(initial.item.id,{requestId:'comment_01',revision:initial.item.revision,text:'New'},AUTHOR,()=>{}),{code:'kanban_store_full'});
 assert.equal((await service.notification(initial.item.id,'notify_001',AUTHOR,()=>{})).state,'uncertain');
 await assert.rejects(service.notify(initial.item.id,{requestId:'notify_002',revision:initial.item.revision,agentId:'dev',input:'Synthetic'},AUTHOR,()=>{}),{code:'kanban_notification_busy'});assert.equal(starts,0);
 assert.deepEqual(await service.create({requestId:'create_01',title:'T'.repeat(200),agentId:'dev',column:'todo',blockedBy:[]},AUTHOR,()=>{}),initial);
 const audit=await fs.readFile(path.join(directory,'changes.jsonl'),'utf8');assert.equal(audit.trim().split('\n').filter(line=>JSON.parse(line).action==='kanban.notify.uncertain').length,1,'Restart must deduplicate the fallback recovery audit');
});


test('a readable state root isolates Work in a private child and preserves unsafe or ambiguous legacy entries',async t=>{
  const directory=await fs.mkdtemp(path.resolve('.kanban-root-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.chmod(directory,0o755);
  const changeLog=createChangeLog({file:path.join(directory,'changes.jsonl'),now:()=>NOW});await changeLog.ready();
  const open=async()=>new Kanban({store:await createKanbanStoreForStateRoot({directory,changeLog,now:()=>NOW}),now:()=>NOW,agentExists:async()=>true});
  const service=await open();const saved=await service.create(create('create_01'),AUTHOR,()=>{});
  assert.equal((await fs.stat(path.join(directory,'kanban'))).mode&0o777,0o700);
  assert.equal((await fs.stat(path.join(directory,'kanban','kanban.json'))).mode&0o777,0o600);
  assert.deepEqual((await (await open()).detail(saved.item.id,AUTHOR,()=>{})).item,saved.item);
  await fs.writeFile(path.join(directory,'kanban.json'),'private-legacy-canary',{mode:0o600});
  await assert.rejects(open(),{code:'kanban_store_unavailable'});
  assert.equal(await fs.readFile(path.join(directory,'kanban.json'),'utf8'),'private-legacy-canary');
});


test('state-root selection rejects public legacy, linked or permissive children and preserves private legacy receipts',async t=>{
  const {directory,changeLog,kanban}=await fixture(t);
  const saved=await kanban.create(create('legacy_01'),AUTHOR,()=>{});
  const before=await fs.readFile(path.join(directory,'kanban.json'));
  const legacy=new Kanban({store:await createKanbanStoreForStateRoot({directory,changeLog,now:()=>NOW}),now:()=>NOW,agentExists:async()=>true});
  assert.deepEqual(await legacy.create(create('legacy_01'),AUTHOR,()=>{}),saved);
  assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),before);
  await fs.chmod(directory,0o755);
  await assert.rejects(createKanbanStoreForStateRoot({directory,changeLog}),{code:'kanban_store_unavailable'});
  assert.deepEqual(await fs.readFile(path.join(directory,'kanban.json')),before);
  await assert.rejects(fs.lstat(path.join(directory,'kanban')),{code:'ENOENT'});
  for (const attack of ['symlink','mode','file','writable-root','ancestor-link']) {
    const root=await fs.mkdtemp(path.resolve('.kanban-unsafe-root-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
    const child=path.join(root,'kanban');
    if(attack==='symlink')await fs.symlink(directory,child);
    if(attack==='mode'){await fs.mkdir(child,{mode:0o755});await fs.chmod(child,0o755);}
    if(attack==='file')await fs.writeFile(child,'foreign-child-canary',{mode:0o600});
    if(attack==='writable-root')await fs.chmod(root,0o777);
    let selected=root;
    if(attack==='ancestor-link'){selected=root+'-link';await fs.symlink(root,selected);t.after(()=>fs.unlink(selected));}
    await assert.rejects(createKanbanStoreForStateRoot({directory:selected,changeLog}),{code:'kanban_store_unavailable'},attack);
    if(attack==='file')assert.equal(await fs.readFile(child,'utf8'),'foreign-child-canary');
    if(attack==='writable-root'||attack==='ancestor-link')await assert.rejects(fs.lstat(child),{code:'ENOENT'});
  }
});

test('selected private Work never adopts a directory replaced across asynchronous initialization',async t=>{
  const root=await fs.mkdtemp(path.resolve('.kanban-selection-race-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
  const changeLog=createChangeLog({file:path.join(root,'changes.jsonl')});await changeLog.ready();
  let switched=false;
  const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{
    if(!switched&&String(args[0]).endsWith('/kanban')){
      switched=true;await fs.rename(path.join(root,'kanban'),path.join(root,'kanban.original'));
      await fs.mkdir(path.join(root,'kanban'),{mode:0o700});
    }
    return fs.open(...args);
  }};
  await assert.rejects(createKanbanStoreForStateRoot({directory:root,changeLog,io}),{code:'kanban_store_unavailable'});
  assert.equal(switched,true);
  assert.deepEqual(await fs.readdir(path.join(root,'kanban')),[],'No lock or empty checkpoint may be created in the replacement');
  assert.deepEqual(await fs.readdir(path.join(root,'kanban.original')),[]);
});


test('a new private state root also uses its own Work directory and an unsafe direct store stays rejected',async t=>{
 const directory=await fs.mkdtemp(path.resolve('.kanban-new-private-root-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const changeLog=createChangeLog({file:path.join(directory,'changes.jsonl')});await changeLog.ready();
 await createKanbanStoreForStateRoot({directory,changeLog});assert.equal((await fs.stat(path.join(directory,'kanban'))).mode&0o777,0o700);
 await fs.chmod(directory,0o755);await assert.rejects(createKanbanStore({directory,changeLog}),{code:'kanban_store_unavailable'});
});


test('state-root permissions changed across initialization fail closed before any Work lock or checkpoint',async t=>{
 const root=await fs.mkdtemp(path.resolve('.kanban-root-mode-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
 const changeLog=createChangeLog({file:path.join(root,'changes.jsonl')});await changeLog.ready();let switched=false;
 const io={...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  if(!switched&&String(args[0]).endsWith('/'+path.basename(root))){switched=true;await fs.chmod(root,0o777);}
  return fs.open(...args);
 }};
 await assert.rejects(createKanbanStoreForStateRoot({directory:root,changeLog,io}),{code:'kanban_store_unavailable'});
 assert.equal(switched,true);assert.deepEqual(await fs.readdir(path.join(root,'kanban')),[]);
});
