import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { realExec } from '../src/exec.ts';
import { AgentMemoryError } from '../src/agentMemory.ts';
import path from 'node:path';
import os from 'node:os';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDeviceStore } from '../src/deviceStore.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createPairing } from '../src/pairing.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import type { HermesMemory } from '../src/agentMemory.ts';
import { createAgentMemory } from '../src/agentMemory.ts';
import { hermesRunBody } from '../src/chatImages.ts';
import { eventually } from '../support/channel.ts';

const key=`rly1_${Buffer.alloc(32,82).toString('base64url')}`;
const headers={Authorization:`Bearer ${key}`,'X-Relay-Protocol':'2','Content-Type':'application/json'};
async function start(t:TestContext,options:{directory?:string;hermes?:FakeHermes&{memory:HermesMemory}}={}) {
 const directory=options.directory??await fs.mkdtemp(path.join(os.tmpdir(),'personality-fixture-'));
 if(!options.directory)t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const store=await createDeviceStore({directory});
 if(!store.snapshot().devices.length)await store.mutate(s=>s.devices.push({id:'00000000-0000-4000-8000-000000000082',name:'synthetic phone',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(key).toString('hex')}));
 const home=path.join(directory,'profile');if(!options.directory)await fs.mkdir(home);
 if(!options.directory)await fs.writeFile(path.join(home,'config.yaml'),'memory:\n  memory_char_limit: 2200\ncontext_file_max_chars: 3\n');
 if(!options.directory)await fs.writeFile(path.join(home,'SOUL.md'),'Original identity');
 const hermes=options.hermes??Object.assign(new FakeHermes(),{memory:createAgentMemory({home,python:'python3',managedFile:path.join(directory,'absent-managed'),env:{}})});const logs:string[]=[];
 const runs=new RunManager({hermes,notifier:{async approvalCreated(){}},sleep:async()=>{}});
 const server=createApp({config:{corsOrigins:[]},store,hermes,runs,pairing:createPairing({store,origin:async()=> 'http://fixture.example.ts.net',serverName:'fixture'}),tailnet:{async whois(){return null;}},peerAddress:()=> '100.64.0.1',log:line=>logs.push(line)});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{runs.close();server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 async function call(method:string,resource='/v1/personality-presets',body?:unknown,requestHeaders:Record<string,string>=headers) {
  const result=await fetch(base+resource,{method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:result.status,json:await result.json() as any};
 }
 return {call,directory,home,store,hermes,logs,runs,base,stop:()=>{runs.close();server.closeAllConnections();server.close();}};
}
test('an authenticated Server exposes an honest empty personality catalog without preset contents',async t=>{
 const {call}=await start(t);const result=await call('GET');
 assert.equal(result.status,200);
 assert.deepEqual(result.json.presets,[]);assert.match(result.json.revision,/^[a-f0-9]{64}$/);
 assert.equal(Number.isSafeInteger(result.json.capturedAt),true);
});

test('catalog CRUD retains immutable versions and durably replays the exact request identity',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const create={requestId:randomUUID(),catalogRevision:catalog.revision,name:'Revisor',kind:'overlay',content:'Revisa errores y casos límite.'};
 const made=await call('POST','/v1/personality-presets',create);assert.equal(made.status,201);
 assert.match(made.json.id,/^[a-f0-9-]{36}$/);assert.equal(made.json.content,create.content);
 assert.deepEqual((await call('POST','/v1/personality-presets',create)).json,made.json);
 assert.equal((await call('POST','/v1/personality-presets',{...create,content:'Different body'})).status,409);
 const resource='/v1/personality-presets/'+made.json.id;
 const edit={requestId:randomUUID(),revision:made.json.revision,name:'Revisor breve',content:'Revisa sin rodeos.'};
 const changed=await call('PATCH',resource,edit);assert.equal(changed.status,200);
 assert.notEqual(changed.json.revision,made.json.revision);
 assert.deepEqual((await call('GET',resource+'/versions/'+made.json.revision)).json,made.json);
 assert.deepEqual((await call('PATCH',resource,edit)).json,changed.json);
 assert.equal((await call('PATCH',resource,{...edit,requestId:randomUUID()})).status,409);
 const listed=(await call('GET')).json;assert.equal(listed.presets.length,1);assert.equal('content' in listed.presets[0],false);
 const remove={requestId:randomUUID(),revision:changed.json.revision};const deleted=await call('DELETE',resource,remove);
 assert.equal(deleted.status,200);assert.equal(deleted.json.deleted,true);
 assert.deepEqual((await call('DELETE',resource,remove)).json,deleted.json);
 assert.equal((await call('GET',resource)).status,404);
 assert.deepEqual((await call('GET',resource+'/versions/'+made.json.revision)).json,made.json);
 assert.deepEqual((await call('GET')).json.presets,[]);
 const audit=await fs.readFile(path.join(directory,'changes.jsonl'),'utf8');assert.doesNotMatch(audit,/Revisor|sin rodeos|casos límite/);
 const backups=(await fs.readdir(directory)).filter(name=>name.startsWith('personality-')&&name.endsWith('.previous'));
 assert.ok(backups.length>=2);
 for(const file of backups)assert.equal((await fs.stat(path.join(directory,file))).mode&0o777,0o600);
});

test('SOUL application previews exact bytes and uses the existing guarded writer once with both revisions',async t=>{
 const {call,home,directory,hermes}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Identidad breve',kind:'soul',content:'# Soul\nSé claro y directo.'})).json;
 const preview=await call('GET',`/v1/agents/default/soul/preset-preview?presetId=${preset.id}&presetRevision=${preset.revision}`);
 assert.equal(preview.status,200);assert.equal(preview.json.preset.content,preset.content);assert.equal(preview.json.soul.content,'Original identity');assert.equal(preview.json.soul.contextLimit,3);
 const change=t.mock.method(hermes.memory,'changeSoul');
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:preview.json.soul.revision};
 const result=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(result.status,200);assert.equal(result.json.soul.content,preset.content);assert.equal(result.json.requestId,request.requestId);
 assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),preset.content);
 assert.deepEqual((await call('PUT','/v1/agents/default/soul/preset',request)).json,result.json);
 assert.equal(change.mock.callCount(),1,'replay must never invoke a second SOUL writer');
 const context=change.mock.calls[0].arguments[2];assert.equal(context.signal instanceof AbortSignal,true);assert.equal(typeof context.guard,'function');
 const retained=(await fs.readdir(directory)).filter(name=>name.startsWith('memory-')&&name.endsWith('.previous'));
 assert.equal(retained.length,1);assert.equal(await fs.readFile(path.join(directory,retained[0]),'utf8'),'Original identity');
 assert.doesNotMatch(await fs.readFile(path.join(directory,'changes.jsonl'),'utf8'),/Identidad breve|Sé claro|Original identity/);
 assert.equal((await call('PUT','/v1/agents/default/soul/preset',{...request,requestId:randomUUID()})).status,409);
});

test('a stale catalog revision on create is a conflict and leaves the catalog unchanged',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 assert.equal((await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Primero',kind:'overlay',content:'Uno'})).status,201);
 const file=path.join(directory,'personality-presets.json'),before=await fs.readFile(file);
 const stale=await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Segundo',kind:'overlay',content:'Dos'});
 assert.equal(stale.status,409);assert.equal(stale.json.error.code,'personality_conflict');
 assert.equal((await fs.readFile(file)).equals(before),true);
 assert.deepEqual((await call('GET')).json.presets.map((p:any)=>p.name),['Primero']);
});

test('a stale preset revision on apply is a conflict before any receipt, backup, or SOUL write',async t=>{
 const {call,home,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Alma',kind:'soul',content:'Antigua'})).json;
 const edited=await call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'Alma',content:'Nueva'});assert.equal(edited.status,200);
 const preview=await call('GET',`/v1/agents/default/soul/preset-preview?presetId=${preset.id}&presetRevision=${edited.json.revision}`);
 const result=await call('PUT','/v1/agents/default/soul/preset',{requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:preview.json.soul.revision});
 assert.equal(result.status,409);assert.equal(result.json.error.code,'personality_conflict');
 const names=await fs.readdir(directory);
 assert.deepEqual(names.filter(n=>/^personality-apply-/.test(n)),[],'no pending receipt or receipt backup');
 assert.deepEqual(names.filter(n=>/^memory-.*\.previous$/.test(n)),[],'no SOUL backup');
 assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');
});


test('an overlay freezes in a durable Relay receipt and later Turns inherit that snapshot until none is selected',async t=>{
 const first=await start(t);const {call,hermes}=first;
 const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Revisión',kind:'overlay',content:'Busca riesgos concretos.'})).json;
 const conversation=await call('POST','/v1/agents/default/conversations',{requestId:randomUUID()});assert.equal(conversation.status,201);
 const route=`/v1/agents/default/conversations/${conversation.json.id}/personality`;
 const none=await call('GET',route);assert.equal(none.status,200);assert.equal(none.json.preset,null);
 const select={requestId:randomUUID(),revision:none.json.revision,preset:{id:preset.id,revision:preset.revision}};
 const picked=await call('PUT',route,select);assert.equal(picked.status,200);assert.deepEqual(picked.json.preset,preset);
 assert.deepEqual((await call('PUT',route,select)).json,picked.json);
 assert.deepEqual((await call('PUT',route,{...select,preset:{revision:preset.revision,id:preset.id}})).json,picked.json,'JSON key order must not change the request identity');
 assert.equal((await call('PUT',route,{...select,preset:null})).status,409);
 first.stop();const second=await start(t,{directory:first.directory,hermes});
 assert.deepEqual((await second.call('GET',route)).json,picked.json);
 const firstTurn=await second.call('POST','/v1/agents/default/runs',{input:'Primero',sessionId:conversation.json.id});assert.equal(firstTurn.status,200);
 const sent=hermes.callsTo('createRun').at(-1)!.args[1] as Record<string,unknown>;assert.equal(sent.instructions,'Busca riesgos concretos.');
 const updated=await second.call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'Revisión nueva',content:'No debe afectar el snapshot anterior.'});assert.equal(updated.status,200);
 assert.equal((await second.call('DELETE','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:updated.json.revision})).status,200);
 assert.deepEqual((await second.call('GET',route)).json.preset,preset);
 assert.equal(hermes.callsTo('steerRun').length,0,'preset edits must never redirect an active Turn');
 hermes.stream(firstTurn.json.runId).push({event:'run.completed',seq:1,output:'done'});
 await eventually(()=>assert.equal(second.runs.activeForConversation('default',conversation.json.id),false));
 const nextTurn=await second.call('POST','/v1/agents/default/runs',{input:'Segundo',sessionId:conversation.json.id});assert.equal(nextTurn.status,200);
 assert.equal((hermes.callsTo('createRun').at(-1)!.args[1] as Record<string,unknown>).instructions,'Busca riesgos concretos.');
 const clear=await second.call('PUT',route,{requestId:randomUUID(),revision:picked.json.revision,preset:null});assert.equal(clear.status,200);assert.equal(clear.json.preset,null);
 assert.equal(sent.instructions,'Busca riesgos concretos.','selecting none cannot alter an already admitted Turn');
 hermes.stream(nextTurn.json.runId).push({event:'run.completed',seq:1,output:'done'});
 await eventually(()=>assert.equal(second.runs.activeForConversation('default',conversation.json.id),false));
 const inherited=await second.call('POST','/v1/agents/default/runs',{input:'Tercero',sessionId:conversation.json.id});assert.equal(inherited.status,200);
 assert.equal(Object.hasOwn(hermes.callsTo('createRun').at(-1)!.args[1] as object,'instructions'),false);
 const audit=await fs.readFile(path.join(first.directory,'changes.jsonl'),'utf8');assert.doesNotMatch(audit,/Busca riesgos|snapshot anterior|Revisión/);
});


test('the private Turn adapter sends frozen overlays as official Hermes instructions and none omits the extra layer',()=>{
 assert.deepEqual(hermesRunBody({input:'Pregunta',sessionId:'relay-fixture',instructions:'Busca riesgos concretos.',model:{provider:'configured',model:'configured-model'}}),
  {input:'Pregunta',session_id:'relay-fixture',instructions:'Busca riesgos concretos.',provider:'configured',model:'configured-model'});
 assert.deepEqual(hermesRunBody({input:'Pregunta',sessionId:'relay-fixture'}),{input:'Pregunta',session_id:'relay-fixture'});
});


test('SOUL receipt capacity fails closed before any profile replacement',async t=>{
 const {call,directory,home}=await start(t);
 const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Capacidad',kind:'soul',content:'Replacement must not happen'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 for(let i=0;i<4096;i++)nativeFs.writeFileSync(path.join(directory,`personality-apply-${i.toString(16).padStart(64,'0')}.json`),'{}',{mode:0o600});
 const result=await call('PUT','/v1/agents/default/soul/preset',{requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision});
 assert.equal(result.status,409);assert.equal(result.json.error.code,'personality_limit');assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');
});


test('uncertain SOUL application remains durable after restart and never replaces the profile again',async t=>{
 const first=await start(t);const {call,hermes,home}=first;
 const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Recuperación',kind:'soul',content:'Replacement confirmed only on disk'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const original=hermes.memory.changeSoul.bind(hermes.memory);
 const change=t.mock.method(hermes.memory,'changeSoul',async(...args:Parameters<HermesMemory['changeSoul']>)=>{await original(...args);throw new AgentMemoryError('agent_memory_uncertain');});
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const result=await call('PUT','/v1/agents/default/soul/preset',request);assert.equal(result.status,503);assert.equal(result.json.error.code,'personality_uncertain');
 assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),preset.content);assert.equal(change.mock.callCount(),1);
 first.stop();const restarted=await start(t,{directory:first.directory,hermes});
 assert.equal((await restarted.call('PUT','/v1/agents/default/soul/preset',request)).json.error.code,'personality_uncertain');
 assert.equal((await restarted.call('PUT','/v1/agents/default/soul/preset',{...request,soulRevision:'0'.repeat(64)})).json.error.code,'personality_conflict');
 assert.equal(change.mock.callCount(),1,'a durable uncertain claim must prohibit another writer invocation');
});

test('personality choices on external Conversations are honestly read only',async t=>{
 const {call,hermes}=await start(t);
 hermes.seedConversation('default',{id:'discord-private',sessionId:'discord-private',sessionIds:['discord-private'],source:'discord',createdSource:'discord',title:null,kind:'interactive',hidden:false,archived:false,startedAt:1700000000000,lastActiveAt:1700000000000,messageCount:1,preview:null});
 const resource='/v1/agents/default/conversations/discord-private/personality';
 const read=await call('GET',resource);assert.equal(read.status,403);assert.equal(read.json.error.code,'personality_read_only');
 const write=await call('PUT',resource,{requestId:randomUUID(),revision:'0'.repeat(64),preset:null});assert.equal(write.status,403);assert.equal(write.json.error.code,'personality_read_only');
 assert.equal(hermes.callsTo('createRun').length,0);
});


test('revocation after the conversation receipt temp is synced prevents the overlay replacement',async t=>{
 const {call,store}=await start(t);
 const otherKey=`rly1_${Buffer.alloc(32,83).toString('base64url')}`;
 const observer={...headers,Authorization:`Bearer ${otherKey}`};
 await store.mutate(s=>s.devices.push({id:'00000000-0000-4000-8000-000000000083',name:'synthetic observer',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(otherKey).toString('hex')}));
 const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Revocación',kind:'overlay',content:'Must not be selected'})).json;
 const conversation=(await call('POST','/v1/agents/default/conversations',{requestId:randomUUID()})).json;
 const route=`/v1/agents/default/conversations/${conversation.id}/personality`;
 const before=(await call('GET',route)).json;
 const open=fs.open.bind(fs);let intercepted=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0]).includes('.conversations.json.')&&!intercepted) {
   const sync=handle.sync.bind(handle);
   handle.sync=async()=>{await sync();intercepted=true;await store.mutate(s=>{s.devices.find(d=>d.id.endsWith('082'))!.revokedAt=1700000001000;});};
  }
  return handle;
 });
 const response=await call('PUT',route,{requestId:randomUUID(),revision:before.revision,preset:{id:preset.id,revision:preset.revision}});
 assert.equal(intercepted,true,'test must reach the final synced temporary receipt before replacement');
 const after=await call('GET',route,undefined,observer);assert.equal(after.status,200);assert.deepEqual(after.json,before,'a revoked device must not publish the staged selection');assert.equal(response.status,403);
});


test('a catalog descriptor close failure after replacement is uncertain and exact replay recovers its durable outcome',async t=>{
 const {call}=await start(t);const catalog=(await call('GET')).json;
 const request={requestId:randomUUID(),catalogRevision:catalog.revision,name:'Cierre',kind:'overlay',content:'Retained immutable outcome'};
 const rename=nativeFs.renameSync.bind(nativeFs),close=nativeFs.closeSync.bind(nativeFs);let committedFd:number|null=null,failed=false;
 t.mock.method(nativeFs,'renameSync',(...args:Parameters<typeof nativeFs.renameSync>)=>{
  rename(...args);if(String(args[1]).endsWith('/personality-presets.json'))committedFd=Number(String(args[1]).match(/^\/proc\/self\/fd\/(\d+)\//)![1]);
 });
 t.mock.method(nativeFs,'closeSync',(fd:number)=>{close(fd);if(fd===committedFd&&!failed){failed=true;throw Object.assign(new Error('synthetic close failure'),{code:'EIO'});}});
 const response=await call('POST','/v1/personality-presets',request);
 assert.equal(failed,true);assert.equal(response.status,503);assert.equal(response.json.error.code,'personality_uncertain');
 const replay=await call('POST','/v1/personality-presets',request);assert.equal(replay.status,201);assert.equal(replay.json.content,request.content);
 assert.equal((await call('GET')).json.presets.length,1);
});


test('personality routes enforce protocol, exact input, closed methods and private safe errors',async t=>{
 const {call,base,logs}=await start(t);
 assert.equal((await call('GET','/v1/personality-presets',undefined,{Authorization:headers.Authorization})).status,426);
 assert.equal((await call('GET','/v1/personality-presets',undefined,{})).status,401);
 const catalog=(await call('GET')).json;
 const create={requestId:randomUUID(),catalogRevision:catalog.revision,name:'Only known fields',kind:'overlay',content:'safe synthetic content'};
 assert.equal((await call('POST','/v1/personality-presets',{...create,path:'private-client-path'})).json.error.code,'personality_invalid');
 assert.equal((await call('GET','/v1/personality-presets?path=private-client-path')).status,400);
 assert.equal((await call('GET','/v1/agents/default/soul/preset')).status,404);
 assert.equal((await call('PUT','/v1/agents/default/soul/preset-preview',{content:'do not write'})).status,404);
 assert.equal((await call('GET','/v1/agents/default/soul/preset-preview?presetId=bad&presetId=private-client-path&presetRevision=bad')).status,400);
 const publicInstructions=await call('POST','/v1/agents/default/runs',{input:'Synthetic',instructions:'untrusted overlay'});
 assert.equal(publicInstructions.status,400);
 const malformed=await fetch(base+'/v1/personality-presets',{method:'POST',headers,body:'{"private-synthetic-content":'});assert.equal(malformed.status,400);
 assert.doesNotMatch(logs.join('\n'),/private-client-path|safe synthetic content|untrusted overlay|private-synthetic-content/);
});


test('preset limits count Unicode code points for names and UTF-8 bytes for immutable content',async t=>{
 const {call}=await start(t);let catalog=(await call('GET')).json;
 const base={requestId:randomUUID(),catalogRevision:catalog.revision,name:'😀'.repeat(100),kind:'overlay',content:'é'.repeat(32768)};
 const boundary=await call('POST','/v1/personality-presets',base);assert.equal(boundary.status,201);assert.equal(boundary.json.bytes,65536);assert.equal(Array.from(boundary.json.name).length,100);
 catalog=(await call('GET')).json;
 for(const invalid of [{name:'😀'.repeat(101)},{content:'é'.repeat(32769)},{name:' leading'},{name:'bad\nname'},{content:'\ud800'},{kind:'unknown'}]) {
  const result=await call('POST','/v1/personality-presets',{...base,requestId:randomUUID(),catalogRevision:catalog.revision,...invalid});assert.equal(result.status,400);assert.equal(result.json.error.code,'personality_invalid');
 }
 const soul=await call('POST','/v1/personality-presets',{...base,requestId:randomUUID(),catalogRevision:catalog.revision,name:'SOUL completo',kind:'soul',content:'x'.repeat(1048576)});
 assert.equal(soul.status,201);assert.equal(soul.json.bytes,1048576);assert.equal(soul.json.content.length,1048576);
 const larger=await call('POST','/v1/personality-presets',{...base,requestId:randomUUID(),catalogRevision:(await call('GET')).json.revision,kind:'soul',content:'x'.repeat(1048577)});assert.equal(larger.status,400);
});

test('the serialized catalog cap preserves its full immutable history instead of truncating or pruning versions',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const content='\0'.repeat(1048576);
 const first=await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Original',kind:'soul',content});assert.equal(first.status,201);
 const route='/v1/personality-presets/'+first.json.id;
 const second=await call('PATCH',route,{requestId:randomUUID(),revision:first.json.revision,name:'Segundo',content});assert.equal(second.status,200);
 const before=await fs.readFile(path.join(directory,'personality-presets.json'));
 const full=await call('PATCH',route,{requestId:randomUUID(),revision:second.json.revision,name:'No cabe',content});assert.equal(full.status,409);assert.equal(full.json.error.code,'personality_limit');
 assert.equal((await fs.readFile(path.join(directory,'personality-presets.json'))).equals(before),true);
 assert.equal((await call('GET',route+'/versions/'+first.json.revision)).json.content.length,1048576);
 assert.equal((await call('GET',route)).json.revision,second.json.revision);
});

test('catalog active-count limits and Server isolation survive durable replay after restart',async t=>{
 const first=await start(t);const {call}=first;let catalog=(await call('GET')).json;
 let original:any,request:any;
 for(let i=0;i<64;i++) {
  const body={requestId:randomUUID(),catalogRevision:catalog.revision,name:`Preset ${i}`,kind:'overlay',content:''};
  const made=await call('POST','/v1/personality-presets',body);assert.equal(made.status,201);
  if(i===0){original=made.json;request=body;}catalog=(await call('GET')).json;
 }
 assert.equal(catalog.presets.length,64);
 const exceeded=await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'65',kind:'overlay',content:'Rejected'});assert.equal(exceeded.status,409);assert.equal(exceeded.json.error.code,'personality_limit');
 first.stop();const restarted=await start(t,{directory:first.directory,hermes:first.hermes});
 assert.deepEqual((await restarted.call('POST','/v1/personality-presets',request)).json,original);
 assert.equal((await restarted.call('GET')).json.presets.length,64);
 const separate=await start(t);assert.deepEqual((await separate.call('GET')).json.presets,[]);
 assert.equal((await separate.call('GET','/v1/personality-presets/'+original.id)).status,404);
});

for(const unsafe of ['symlink','hardlink','fifo','permissions','utf8','oversize'] as const)test(`unsafe ${unsafe} catalog is never served or replaced`,async t=>{
 const {call,directory,logs}=await start(t);const initial=(await call('GET')).json;
 assert.equal((await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:initial.revision,name:'private-synthetic-content',kind:'overlay',content:'private-synthetic-content'})).status,201);
 const catalog=(await call('GET')).json;
 const name=path.join(directory,'personality-presets.json'),outside=path.join(directory,'private-synthetic-target'),valid=await fs.readFile(name);
 await fs.unlink(name);await fs.writeFile(outside,valid,{mode:0o600});
 if(unsafe==='symlink')await fs.symlink(outside,name);
 if(unsafe==='hardlink')await fs.link(outside,name);
 if(unsafe==='fifo'){const result=await realExec('mkfifo',[name],{timeoutMs:3000});assert.equal(result.code,0);}
 if(unsafe==='permissions')await fs.writeFile(name,valid,{mode:0o644});
 if(unsafe==='utf8')await fs.writeFile(name,Buffer.from([0xff,0xfe]),{mode:0o600});
 if(unsafe==='oversize'){const file=await fs.open(name,'wx',0o600);try{await file.truncate(16777217);}finally{await file.close();}}
 const read=await call('GET');assert.equal(read.status,503);assert.equal(read.json.error.code,'personality_unavailable');
 const write=await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Reject',kind:'overlay',content:'Replacement'});assert.equal(write.status,503);
 assert.equal((await fs.readFile(outside)).equals(valid),true);assert.doesNotMatch(JSON.stringify(read.json)+logs.join('\n'),/private-synthetic-content|private-synthetic-target/);
});


test('a preset changed during actual SOUL retention conflicts before the final profile replacement',async t=>{
 const {call,home,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Snapshot',kind:'soul',content:'Old preset snapshot'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const open=fs.open.bind(fs);let intercepted=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(/memory-[a-f0-9-]+\.previous$/.test(String(args[0]))&&!intercepted) {
   const sync=handle.sync.bind(handle);
   handle.sync=async()=>{await sync();intercepted=true;const changed=await call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'Edited after retention',content:'New preset snapshot'});assert.equal(changed.status,200);};
  }
  return handle;
 });
 const response=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(intercepted,true,'preset must change after real raw SOUL backup fsync');
 assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');assert.equal(response.status,409);assert.equal(response.json.error.code,'personality_conflict');
 assert.equal((await call('PUT','/v1/agents/default/soul/preset',request)).json.error.code,'personality_conflict');
 const backups=(await fs.readdir(directory)).filter(n=>/^memory-.*\.previous$/.test(n));assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(directory,backups[0]),'utf8'),'Original identity');
});


test('a malformed durable SOUL outcome fails closed without another writer or private error contents',async t=>{
 const {call,directory,hermes}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Resultado',kind:'soul',content:'Exact frozen SOUL'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const writer=t.mock.method(hermes.memory,'changeSoul');
 assert.equal((await call('PUT','/v1/agents/default/soul/preset',request)).status,200);

 const file=(await fs.readdir(directory)).find(n=>/^personality-apply-[a-f0-9]{64}\.json$/.test(n))!;
 await fs.writeFile(path.join(directory,file),'private-synthetic-invalid-ledger');
 const response=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(response.status,503);assert.equal(response.json.error.code,'personality_uncertain');assert.doesNotMatch(JSON.stringify(response.json),/private-synthetic|Exact frozen SOUL/);
 assert.equal(writer.mock.callCount(),1,'unreadable outcome must not invoke a second writer');
 const retained=(await fs.readdir(directory)).filter(n=>/^memory-.*\.previous$/.test(n));assert.equal(retained.length,1,'unreadable outcome must never trigger a second profile replacement');
});


test('external catalog identity drift during raw retention conflicts and never replaces the external version',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Before',kind:'overlay',content:'Original frozen bytes'})).json;
 const file=path.join(directory,'personality-presets.json'),previous=await fs.readFile(file),before=await fs.stat(file);
 const open=nativeFs.openSync.bind(nativeFs),sync=nativeFs.fsyncSync.bind(nativeFs),rename=nativeFs.renameSync.bind(nativeFs);let backupFd:number|null=null,intercepted=false;
 t.mock.method(nativeFs,'openSync',(...args:Parameters<typeof nativeFs.openSync>)=>{const fd=open(...args);if(/personality-[a-f0-9-]+\.previous$/.test(String(args[0])))backupFd=fd;return fd;});
 t.mock.method(nativeFs,'fsyncSync',(fd:number)=>{sync(fd);if(fd===backupFd&&!intercepted){intercepted=true;const incoming=path.join(directory,'.external-synthetic');nativeFs.writeFileSync(incoming,previous,{mode:0o600});rename(incoming,file);}});
 const result=await call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'Should not replace',content:'Rejected'});
 assert.equal(intercepted,true);assert.equal(result.status,409);assert.equal(result.json.error.code,'personality_conflict');
 assert.notEqual((await fs.stat(file)).ino,before.ino);assert.equal((await fs.readFile(file)).equals(previous),true);
 assert.deepEqual((await call('GET','/v1/personality-presets/'+preset.id)).json,preset);
 const backups=(await fs.readdir(directory)).filter(n=>/^personality-[a-f0-9-]+\.previous$/.test(n));assert.equal(backups.length,1);assert.equal((await fs.readFile(path.join(directory,backups[0]))).equals(previous),true);
});


test('preset audit producers only accept UUID identities and reject private contents in details',async t=>{
 const {store,directory}=await start(t);
 const input={actor:{kind:'device' as const,id:'00000000-0000-4000-8000-000000000082',name:'synthetic phone'},action:'personality.preset.create.requested',target:{kind:'preset' as const,id:randomUUID()}};
 await assert.rejects(store.changeLog.appendChange({...input,details:{content:'private-synthetic-audit-content'} as never}),/unavailable or invalid/);
 await assert.rejects(store.changeLog.appendChange({...input,target:{kind:'preset',id:'private-synthetic-name'}}),/unavailable or invalid/);
 assert.doesNotMatch(await fs.readFile(path.join(directory,'changes.jsonl'),'utf8'),/private-synthetic-audit-content|private-synthetic-name/);
});


test('preset drift at the actual prepared worker barrier returns a durable conflict before Node rename',async t=>{
 const {call,home}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Prepared',kind:'soul',content:'Must not cross final barrier'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const spawn=childProcess.spawn;let worker:childProcess.ChildProcess|undefined,intercepted=false;
 t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
  const child=spawn(file,args,options);
  if(args.some(a=>a.endsWith('/agent_memory.py'))) {
   worker=child;const output=child.stdout!,emit=output.emit;
   t.mock.method(output,'emit',(event:string,...values:unknown[])=>{
    if(event==='data'&&!intercepted&&/"phase"\s*:\s*"prepared"/.test(String(values[0]))) {
     intercepted=true;
     void call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'Changed at prepared',content:'New version before final rename'}).then(changed=>{assert.equal(changed.status,200);Reflect.apply(emit,output,[event,...values]);});
     return true;
    }
    return Reflect.apply(emit,output,[event,...values]);
   });
  }
  return child;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();worker?.kill('SIGKILL');});
 const response=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(intercepted,true,'test must retain the real prepared worker message before Node commit');assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');
 assert.equal(response.status,409);assert.equal(response.json.error.code,'personality_conflict');
 assert.equal((await call('PUT','/v1/agents/default/soul/preset',request)).json.error.code,'personality_conflict','the same definitive final-barrier refusal must replay exactly');
 assert.throws(()=>process.kill(worker!.pid!,0),{code:'ESRCH'});
});


test('standalone worker TERM after SOUL rename and before ACK remains uncertain with a durable no-retry claim',async t=>{
 const {call,home}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'ACK',kind:'soul',content:'Replaced before standalone TERM'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const spawn=childProcess.spawn;let worker:childProcess.ChildProcess|undefined,withheld=false;
 t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
  const child=spawn(file,args,options);
  if(args.some(a=>a.endsWith('/agent_memory.py'))) {
   worker=child;const input=child.stdin!,end=input.end;
   t.mock.method(input,'end',(...values:unknown[])=>{
    if(typeof values[0]==='string'&&values[0].includes('"committed":true')){withheld=true;child.kill('SIGTERM');return input;}
    return Reflect.apply(end,input,values);
   });
  }
  return child;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();worker?.kill('SIGKILL');});
 const response=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(withheld,true,'TERM must land after Node rename while its native ACK is withheld');assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),preset.content);
 assert.equal(response.status,503);assert.equal(response.json.error.code,'personality_uncertain');
 assert.equal((await call('PUT','/v1/agents/default/soul/preset',request)).json.error.code,'personality_uncertain');assert.throws(()=>process.kill(worker!.pid!,0),{code:'ESRCH'});
});


test('a directory-chain close failure leaves no new catalog descriptors open',async t=>{
 const {call}=await start(t);const open=nativeFs.openSync.bind(nativeFs),close=nativeFs.closeSync.bind(nativeFs);const allocated=new Set<number>();let failed=false;
 t.mock.method(nativeFs,'openSync',(...args:Parameters<typeof nativeFs.openSync>)=>{const fd=open(...args);if(String(args[0]).startsWith('/proc/self/fd/'))allocated.add(fd);return fd;});
 t.mock.method(nativeFs,'closeSync',(fd:number)=>{close(fd);if(allocated.size&&!failed){failed=true;throw Object.assign(new Error('synthetic directory close failure'),{code:'EIO'});}});
 const result=await call('GET');assert.equal(result.status,503);assert.equal(result.json.error.code,'personality_unavailable');assert.equal(failed,true);
 for(const fd of allocated) {try{assert.throws(()=>nativeFs.fstatSync(fd),{code:'EBADF'});}finally{try{close(fd);}catch{/* Already retired. */}}}
});


test('oversized personality JSON is rejected before any catalog or profile write',async t=>{
 const {call,home,directory}=await start(t);const catalog=(await call('GET')).json;
 const result=await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Bounded',kind:'soul',content:'x'.repeat(6295553)});
 assert.equal(result.status,400);assert.equal(result.json.error.code,'bad_request');assert.equal(result.json.error.message,'Request body is too large.');assert.deepEqual((await call('GET')).json.presets,[]);assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');
 assert.equal((await fs.readdir(directory)).some(n=>n.endsWith('.previous')),false);
});


test('a replaced staged conversation receipt is rejected before publishing any overlay selection',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Staging',kind:'overlay',content:'Must not publish a replaced temp'})).json;
 const conversation=(await call('POST','/v1/agents/default/conversations',{requestId:randomUUID()})).json;
 const route=`/v1/agents/default/conversations/${conversation.id}/personality`,before=(await call('GET',route)).json;
 const original=await fs.readFile(path.join(directory,'conversations.json')),outside=path.join(directory,'private-synthetic-conversation');await fs.writeFile(outside,original,{mode:0o600});
 const open=fs.open.bind(fs);let replaced=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(String(args[0]).includes('.conversations.json.')&&!replaced) {
   const close=handle.close.bind(handle),file=String(args[0]);
   handle.close=async()=>{await close();if(!replaced){replaced=true;await fs.unlink(file);await fs.symlink(outside,file);}};
  }
  return handle;
 });
 const response=await call('PUT',route,{requestId:randomUUID(),revision:before.revision,preset:{id:preset.id,revision:preset.revision}});
 assert.equal(replaced,true);assert.equal((await fs.lstat(path.join(directory,'conversations.json'))).isSymbolicLink(),false,'the staged link must never become the durable receipt');
 assert.deepEqual((await call('GET',route)).json,before);assert.equal((await fs.readFile(path.join(directory,'conversations.json'))).equals(original),true);
 assert.equal(response.status,409);assert.equal(response.json.error.code,'personality_conflict');
});


test('a substituted catalog temporary file never becomes the private catalog',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Temp',kind:'overlay',content:'Before'})).json;
 const original=await fs.readFile(path.join(directory,'personality-presets.json')),outside=path.join(directory,'private-synthetic-catalog');await fs.writeFile(outside,original,{mode:0o600});
 const open=nativeFs.openSync.bind(nativeFs),close=nativeFs.closeSync.bind(nativeFs);let staged:{fd:number;file:string}|undefined,replaced=false;
 t.mock.method(nativeFs,'openSync',(...args:Parameters<typeof nativeFs.openSync>)=>{const fd=open(...args);if(/\/\.personality-[a-f0-9-]+\.tmp$/.test(String(args[0])))staged={fd,file:String(args[0])};return fd;});
 t.mock.method(nativeFs,'closeSync',(fd:number)=>{close(fd);if(fd===staged?.fd&&!replaced){replaced=true;nativeFs.unlinkSync(staged.file);nativeFs.symlinkSync(outside,staged.file);}});
 const result=await call('PATCH','/v1/personality-presets/'+preset.id,{requestId:randomUUID(),revision:preset.revision,name:'After',content:'Must not commit a substituted temp'});
 assert.equal(replaced,true);assert.equal((await fs.lstat(path.join(directory,'personality-presets.json'))).isSymbolicLink(),false);
 assert.equal((await fs.readFile(path.join(directory,'personality-presets.json'))).equals(original),true);assert.equal(result.status,409);assert.equal(result.json.error.code,'personality_conflict');
});


test('a substituted SOUL outcome temp preserves the pending receipt and reports post-write uncertainty',async t=>{
 const {call,directory,home}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Outcome temp',kind:'soul',content:'Replaced before outcome substitution'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const request={requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision};
 const open=nativeFs.openSync.bind(nativeFs),close=nativeFs.closeSync.bind(nativeFs);let staged:{fd:number;file:string}|undefined,replaced=false;
 t.mock.method(nativeFs,'openSync',(...args:Parameters<typeof nativeFs.openSync>)=>{const fd=open(...args);if(/\/\.personality-apply-[a-f0-9-]+\.tmp$/.test(String(args[0])))staged={fd,file:String(args[0])};return fd;});
 t.mock.method(nativeFs,'closeSync',(fd:number)=>{
  close(fd);
  if(fd===staged?.fd&&!replaced) {
   replaced=true;const receipt=nativeFs.readdirSync(directory).find(n=>/^personality-apply-[a-f0-9]{64}\.json$/.test(n))!;
   const outside=path.join(directory,'private-synthetic-outcome');nativeFs.copyFileSync(path.join(directory,receipt),outside);nativeFs.chmodSync(outside,0o600);nativeFs.unlinkSync(staged.file);nativeFs.symlinkSync(outside,staged.file);
  }
 });
 const response=await call('PUT','/v1/agents/default/soul/preset',request);
 assert.equal(replaced,true);assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),preset.content);
 const receipt=(await fs.readdir(directory)).find(n=>/^personality-apply-[a-f0-9]{64}\.json$/.test(n))!;
 assert.equal((await fs.lstat(path.join(directory,receipt))).isSymbolicLink(),false,'an unverified outcome must never replace the durable claim');
 assert.equal(response.status,503);assert.equal(response.json.error.code,'personality_uncertain');assert.equal((await call('PUT','/v1/agents/default/soul/preset',request)).json.error.code,'personality_uncertain');
});


test('a substituted private directory is unavailable before any SOUL writer can start',async t=>{
 const {call,directory}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Directory',kind:'soul',content:'Must not follow a replaced root'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const moved=directory+'.moved';t.after(()=>fs.rm(moved,{recursive:true,force:true}));
 await fs.rename(directory,moved);await fs.symlink(moved,directory);
 const result=await call('PUT','/v1/agents/default/soul/preset',{requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision});
 assert.equal(result.status,503);assert.equal(result.json.error.code,'personality_unavailable');assert.equal(await fs.readFile(path.join(moved,'profile','SOUL.md'),'utf8'),'Original identity');
 assert.equal((await fs.readdir(moved)).some(n=>n.startsWith('memory-')),false);
});


test('revocation during real SOUL retention preserves authorization failure before replacement',async t=>{
 const {call,store,home}=await start(t);const catalog=(await call('GET')).json;
 const preset=(await call('POST','/v1/personality-presets',{requestId:randomUUID(),catalogRevision:catalog.revision,name:'Authorization',kind:'soul',content:'Must not replace after revocation'})).json;
 const soul=(await call('GET','/v1/agents/default/soul')).json;
 const open=fs.open.bind(fs);let revoked=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await open(...args);
  if(/memory-[a-f0-9-]+\.previous$/.test(String(args[0]))&&!revoked) {
   const sync=handle.sync.bind(handle);
   handle.sync=async()=>{await sync();revoked=true;await store.mutate(s=>{s.devices.find(d=>d.id.endsWith('082'))!.revokedAt=1700000001000;});};
  }
  return handle;
 });
 const result=await call('PUT','/v1/agents/default/soul/preset',{requestId:randomUUID(),presetId:preset.id,presetRevision:preset.revision,soulRevision:soul.revision});
 assert.equal(revoked,true);assert.equal(await fs.readFile(path.join(home,'SOUL.md'),'utf8'),'Original identity');assert.equal(result.status,403);assert.equal(result.json.error.code,'device_revoked');
});
