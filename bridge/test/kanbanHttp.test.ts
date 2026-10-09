import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
const NOW=1791115200000,DEVICE='00000000-0000-4000-8000-000000000019';
const KEY=`rly1_${Buffer.alloc(32,19).toString('base64url')}`;
const AUTH={Authorization:`Bearer ${KEY}`,'X-Relay-Protocol':'2','Content-Type':'application/json'};
async function start(t:test.TestContext,options:{directory?:string;hermes?:FakeHermes}={}) {
  const directory=options.directory??await fs.mkdtemp(path.resolve('.kanban-http-'));
  if (!options.directory) t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await createDeviceStore({directory,now:()=>NOW});
  if (!store.snapshot().devices.length) await store.mutate(state=>{state.devices.push({id:DEVICE,name:'synthetic-device',pairedAt:NOW,revokedAt:null,keyHash:hashDeviceKey(KEY).toString('hex')});});
  const hermes=options.hermes??new FakeHermes(),logs:string[]=[];
  const runs=new RunManager({hermes,notifier:{async approvalCreated(){}},sleep:async()=>{}});
  const server=createApp({config:{corsOrigins:[]},store,pairing:createPairing({store,origin:async()=> 'http://synthetic.example.ts.net:8650',serverName:'synthetic'}),hermes,runs,
    tailnet:{async whois(){return null;}},peerAddress:()=> '100.64.0.1',now:()=>NOW,log:line=>logs.push(line)});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stop=()=>{runs.close();server.closeAllConnections();server.close();};t.after(stop);
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call=async(method:string,route:string,body?:unknown,headers:Record<string,string>=AUTH)=>{
    const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();return {status:response.status,json:JSON.parse(text),text,headers:response.headers};
  };
  const create=async(requestId='create_01')=>call('POST','/v1/kanban/items',{requestId,title:'private-title-canary',agentId:'default',column:'todo',blockedBy:[]});
  return {call,create,hermes,runs,store,directory,logs,stop};
}
test('HTTP manual metadata uses auth and protocol and cannot dispatch Hermes work; Activity projects content-free actions',async t=>{
  const {call,create,hermes,logs}=await start(t);
  const result=await create();assert.equal(result.status,201);
  const item=result.json.item;
  assert.equal((await call('GET','/v1/kanban/items')).json.items[0].id,item.id);
  const comment=await call('POST',`/v1/kanban/items/${item.id}/comments`,{requestId:'comment_01',revision:item.revision,text:'private-comment-canary @default'});
  assert.equal(comment.status,201);assert.equal(comment.json.comment.author.id,DEVICE);
  const moved=await call('PATCH',`/v1/kanban/items/${item.id}`,{requestId:'update_01',revision:comment.json.item.revision,column:'in_progress'});
  assert.equal(moved.status,200);
  assert.equal(hermes.callsTo('createConversation').length,0);assert.equal(hermes.callsTo('createRun').length,0);assert.equal(hermes.callsTo('stopRun').length,0);
  const feed=await call('GET','/v1/activity?category=tasks');assert.equal(feed.status,200);
  assert.deepEqual(feed.json.items.map((i:{action:string})=>i.action).sort(),['kanban.comment','kanban.create','kanban.update']);
  assert.ok(feed.json.items.every((i:{result:string;scope:{kind:string}})=>i.result==='succeeded'&&i.scope.kind==='server'));
  assert.doesNotMatch(feed.text+logs.join('\n'),/private-title-canary|private-comment-canary|requestId|Bearer|rly1_/);
  assert.equal((await call('GET','/v1/kanban/items',undefined,{})).status,401);
  assert.equal((await call('GET','/v1/kanban/items',undefined,{...AUTH,'X-Relay-Protocol':'99'})).status,426);
  assert.equal((await call('GET','/v1/kanban/items?limit=1&limit=2')).status,400);
});

test('explicit notify opens one new Relay Conversation and one exact Turn; replay, move and restart never resend',async t=>{
  const first=await start(t),created=await first.create(),item=created.json.item;
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'exact private-input-canary\n@coding'};
  const sent=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,request);
  assert.equal(sent.status,202);assert.equal(sent.json.state,'started');assert.ok(sent.json.runId);assert.ok(sent.json.conversationId.startsWith('relay_'));
  assert.deepEqual(first.hermes.callsTo('createRun')[0].args[1],{input:request.input,sessionId:sent.json.conversationId});
  const repeated=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,request);
  assert.deepEqual(repeated.json,sent.json);assert.equal(first.hermes.callsTo('createRun').length,1);assert.equal(first.hermes.callsTo('createConversation').length,1);
  const busy=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'});
  assert.equal(busy.status,409);assert.equal(busy.json.error.code,'kanban_notification_busy');
  assert.equal((await first.call('PATCH',`/v1/kanban/items/${item.id}`,{requestId:'update_01',revision:item.revision,agentId:'coding',column:'done'})).status,200);
  first.stop();const restarted=await start(t,{directory:first.directory,hermes:first.hermes});
  const receipt=await restarted.call('GET',`/v1/kanban/items/${item.id}/notifications/${request.requestId}`);
  assert.equal(receipt.status,200);assert.equal(receipt.json.agentId,'default');assert.equal(receipt.json.state,'started');
  assert.equal(restarted.hermes.callsTo('createRun').length,1);assert.equal(restarted.hermes.callsTo('createConversation').length,1);
  const feed=await restarted.call('GET','/v1/activity?category=tasks');assert.equal(feed.status,200);
  assert.ok(feed.json.items.some((i:{action:string;result:string})=>i.action==='kanban.notify' && i.result==='requested'));
  assert.ok(feed.json.items.some((i:{action:string;result:string})=>i.action==='kanban.notify' && i.result==='accepted'));
  const audit=await fs.readFile(path.join(first.directory,'changes.jsonl'),'utf8');
  assert.doesNotMatch(audit+feed.text+first.logs.join('\n'),/private-input-canary|private-title-canary/);
});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
test('Pausa general and unfinished dependencies block before Conversation creation and before pending approval mode effects',async t=>{
  const {call,create,hermes,directory}=await start(t);
  const home=path.join(directory,'synthetic-hermes');await fs.mkdir(home,{mode:0o700});
  const configFile=path.join(home,'config.yaml'),original='approvals:\n  mode: manual\n  deny: []\n';await fs.writeFile(configFile,original,{mode:0o600});
  const {AgentConfig}=await import('../src/agentConfig.ts'),{realExec}=await import('../src/exec.ts');
  const config=new AgentConfig({home,python:'python3',exec:realExec,managedFile:path.join(directory,'no-managed')});
  hermes.details={security:p=>config.security(p),usage:async()=>{throw new Error('usage not requested');},writeSecurity:(...args)=>config.writeSecurity(...args)};
  const security=(await call('GET','/v1/agents/default/details')).json.security;
  assert.equal((await call('POST','/v1/agents/default/approval-mode',{mode:'smart',revision:security.revision})).status,200);
  const item=(await create()).json.item;let paused=false;
  hermes.serverControl={async paused(){return paused;},async pause(){paused=true;},async resume(){throw new Error('private-resume-canary');}};
  await call('POST','/v1/server/pause');
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Do not dispatch'};
  const blocked=await call('POST',`/v1/kanban/items/${item.id}/notify`,request);assert.equal(blocked.status,409);assert.equal(blocked.json.error.code,'server_paused');
  assert.equal(await fs.readFile(configFile,'utf8'),original);assert.equal(hermes.callsTo('createConversation').length,0);assert.equal(hermes.callsTo('createRun').length,0);
  assert.equal((await call('POST','/v1/server/resume')).status,502);assert.equal((await call('POST',`/v1/kanban/items/${item.id}/notify`,request)).status,409);
  hermes.serverControl.resume=async()=>{paused=false;};assert.equal((await call('POST','/v1/server/resume')).status,200);
  const blocker=(await create('create_02')).json.item;
  const dependent=await call('PATCH',`/v1/kanban/items/${item.id}`,{requestId:'update_01',revision:item.revision,blockedBy:[blocker.id]});
  const dependencies=await call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,revision:dependent.json.item.revision});
  assert.equal(dependencies.json.error.code,'kanban_dependency_blocked');assert.equal(await fs.readFile(configFile,'utf8'),original);assert.equal(hermes.callsTo('createConversation').length,0);
  await call('PATCH',`/v1/kanban/items/${blocker.id}`,{requestId:'update_02',revision:blocker.revision,column:'done'});
  const sent=await call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,revision:dependent.json.item.revision});assert.equal(sent.status,202);assert.equal(sent.json.state,'started');
  assert.match(await fs.readFile(configFile,'utf8'),/mode: smart/);
});

test('concurrent notify reserves one item and a pause arriving during chat admission prevents Turn and mode effects',async t=>{
  const {call,create,hermes}=await start(t),item=(await create()).json.item,entered=deferred(),release=deferred();t.after(release.resolve);
  let paused=false;hermes.serverControl={async paused(){return paused;},async pause(){paused=true;},async resume(){paused=false;}};
  hermes.chatHooks.chat=async()=>{entered.resolve();await release.promise;return {available:true,reason:null};};
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'};
  const pending=call('POST',`/v1/kanban/items/${item.id}/notify`,request);await entered.promise;
  const same=await call('POST',`/v1/kanban/items/${item.id}/notify`,request);assert.equal(same.status,202);assert.equal(same.json.state,'pending');
  const competing=await call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'});assert.equal(competing.json.error.code,'kanban_notification_busy');
  const pause=call('POST','/v1/server/pause');
  const {eventually}=await import('../support/channel.ts');await eventually(async()=>assert.equal((await call('GET','/v1/server/control')).json.phase,'pending'));
  release.resolve();const result=await pending;assert.equal(result.status,202);assert.equal(result.json.state,'rejected');assert.equal(result.json.errorCode,'server_paused');await pause;
  assert.equal(hermes.callsTo('createConversation').length,0);assert.equal(hermes.callsTo('createRun').length,0);
  assert.equal((await call('POST',`/v1/kanban/items/${item.id}/notify`,request)).json.state,'rejected');
});

test('revocation during a Conversation await denies response and every following effect; receipt access is per device',async t=>{
  const {call,create,hermes,store}=await start(t),item=(await create()).json.item,entered=deferred(),release=deferred();t.after(release.resolve);
  const original=hermes.getConversation.bind(hermes);hermes.getConversation=async(...args)=>{const value=await original(...args);entered.resolve();await release.promise;return value;};
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'};
  const pending=call('POST',`/v1/kanban/items/${item.id}/notify`,request);await entered.promise;
  const otherKey=`rly1_${Buffer.alloc(32,20).toString('base64url')}`;await store.mutate(state=>{
    state.devices[0].revokedAt=NOW;state.devices.push({id:'00000000-0000-4000-8000-000000000020',name:'other',pairedAt:NOW,revokedAt:null,keyHash:hashDeviceKey(otherKey).toString('hex')});});
  release.resolve();const result=await pending;assert.equal(result.status,403);assert.equal(result.json.error.code,'device_revoked');assert.equal(result.json.conversationId,undefined);
  assert.equal(hermes.callsTo('createRun').length,0);
  assert.equal((await call('GET',`/v1/kanban/items/${item.id}/notifications/notify_001`,undefined,{...AUTH,Authorization:`Bearer ${otherKey}`})).status,404);
  assert.equal((await call('POST',`/v1/kanban/items/${item.id}/notify`,request)).status,403);
  assert.equal((await call('GET',`/v1/kanban/items/${item.id}`)).status,403);
});

test('uncertain upstream outcome persists and blocks new work through restart without a retry',async t=>{
  const first=await start(t),item=(await first.create()).json.item;
  const {HermesError}=await import('../src/hermes.ts');first.hermes.failWith.createRun=new HermesError('upstream','private-upstream-canary');
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'};
  const sent=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,request);assert.equal(sent.status,202);assert.equal(sent.json.state,'uncertain');assert.equal(sent.json.errorCode,'kanban_notification_uncertain');
  first.stop();const next=await start(t,{directory:first.directory,hermes:first.hermes});
  assert.equal((await next.call('POST',`/v1/kanban/items/${item.id}/notify`,request)).json.state,'uncertain');
  assert.equal((await next.call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'})).json.error.code,'kanban_notification_busy');
  assert.equal(first.hermes.callsTo('createRun').length,1);assert.equal(first.hermes.callsTo('createConversation').length,1);
  const feed=await next.call('GET','/v1/activity?category=tasks&failuresOnly=true');assert.equal(feed.status,200);assert.equal(feed.json.items[0].result,'uncertain');assert.doesNotMatch(feed.text,/private-upstream-canary/);
});

test('only recorded terminal evidence releases a notification; events never move a manual column or add comments',async t=>{
  const {call,create,hermes}=await start(t),item=(await create()).json.item;
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'};
  const sent=await call('POST',`/v1/kanban/items/${item.id}/notify`,request);
  hermes.stream(sent.json.runId).push({event:'run.completed',seq:1,output:'private-output-canary'});
  const {eventually}=await import('../support/channel.ts');await eventually(async()=>assert.equal((await call('GET',`/v1/kanban/items/${item.id}/notifications/notify_001`)).json.turn.phase,'completed'));
  const detail=await call('GET',`/v1/kanban/items/${item.id}`);assert.equal(detail.json.item.column,'todo');assert.equal(detail.json.item.commentCount,0);assert.equal(detail.json.item.revision,item.revision);
  const next=await call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'});assert.equal(next.json.state,'started');assert.notEqual(next.json.conversationId,sent.json.conversationId);
  assert.equal(hermes.callsTo('createRun').length,2);assert.doesNotMatch(detail.text,/private-output-canary/);
});

test('pause during an admitted upstream Turn preserves accepted IDs and stops late work; stop failure stays closed',async t=>{
  const {call,create,hermes}=await start(t),item=(await create()).json.item,entered=deferred(),release=deferred();t.after(release.resolve);
  let paused=false;hermes.serverControl={async paused(){return paused;},async pause(){paused=true;},async resume(){paused=false;}};
  const original=hermes.createRun.bind(hermes);hermes.createRun=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  hermes.stopRun=async()=>{throw new Error('private-stop-canary');};
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'},pending=call('POST',`/v1/kanban/items/${item.id}/notify`,request);await entered.promise;
  const pausing=call('POST','/v1/server/pause'),{eventually}=await import('../support/channel.ts');await eventually(async()=>assert.equal((await call('GET','/v1/server/control')).json.phase,'pending'));
  release.resolve();const result=await pending;assert.equal(result.status,202);assert.equal(result.json.state,'started');assert.ok(result.json.runId);
  const failed=await pausing;assert.equal(failed.status,502);assert.doesNotMatch(failed.text,/private-stop-canary/);
  assert.equal((await call('POST',`/v1/kanban/items/${item.id}/notify`,request)).json.state,'started');
  assert.equal((await call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'})).json.error.code,'server_paused');
  assert.equal(hermes.callsTo('createRun').length,1);
});

test('oversized or expanded notify input is rejected before intent, and dependency changes during a wait cannot dispatch',async t=>{
  const {call,create,hermes}=await start(t),item=(await create()).json.item,blocker=(await create('create_02')).json.item;
  const route=`/v1/kanban/items/${item.id}/notify`,request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic'};
  for(const extra of [{input:'x'.repeat(64001)},{input:'private-control-canary\u0000'},{input:'x'.repeat(80001)},{input:'Synthetic',images:[]}]){
    const response=await call('POST',route,{...request,...extra});assert.equal(response.status,400);assert.equal(response.json.error.code,'kanban_invalid_request');assert.doesNotMatch(response.text,/private-control-canary/);
  }
  const entered=deferred(),release=deferred();t.after(release.resolve);hermes.chatHooks.chat=async()=>{entered.resolve();await release.promise;return {available:true,reason:null};};
  const pending=call('POST',route,request);await entered.promise;
  await call('PATCH',`/v1/kanban/items/${item.id}`,{requestId:'update_01',revision:item.revision,blockedBy:[blocker.id]});
  release.resolve();const result=await pending;assert.equal(result.status,202);assert.equal(result.json.state,'rejected');assert.equal(result.json.errorCode,'configuration_conflict');
  assert.equal(hermes.callsTo('createConversation').length,0);assert.equal(hermes.callsTo('createRun').length,0);
  const feed=await call('GET','/v1/activity?category=tasks&failuresOnly=true');assert.equal(feed.status,200);assert.equal(feed.json.items[0].result,'rejected');
});

test('review: a different Conversation with a reused run ID cannot release a persisted notification',async t=>{
  const first=await start(t),item=(await first.create()).json.item;
  const request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic original'};
  const original=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,request);
  assert.equal(original.status,202);assert.equal(original.json.state,'started');
  first.stop();
  // New FakeHermes is the upstream boundary after a restart; IDs are opaque strings.
  const next=await start(t,{directory:first.directory,hermes:new FakeHermes()});
  const other=await next.call('POST','/v1/agents/coding/runs',{input:'Synthetic unrelated'});
  assert.equal(other.status,200);assert.equal(other.json.runId,original.json.runId);
  assert.notEqual(other.json.conversationId,original.json.conversationId);
  next.hermes.stream(other.json.runId).push({event:'run.completed',seq:1,output:'Synthetic terminal'});
  const {eventually}=await import('../support/channel.ts');
  await eventually(async()=>assert.equal(next.runs.snapshot(other.json.runId).phase,'completed'));
  const observed=await next.call('GET',`/v1/kanban/items/${item.id}/notifications/notify_001`);
  const repeated=await next.call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'});
  console.log(JSON.stringify({originalRun:original.json.runId,originalConversation:original.json.conversationId,otherAgent:'coding',otherConversation:other.json.conversationId,observed:observed.json.turn,newNotificationStatus:repeated.status,newNotificationState:repeated.json.state,newCreateRunCalls:next.hermes.callsTo('createRun').length}));
  assert.equal(repeated.status,409,'Unrelated terminal evidence must not release the pending Kanban reservation');
  assert.equal(repeated.json.error.code,'kanban_notification_busy');
});

test('same-Agente reused Turn ID and identity-free remote completion leave the old reservation unknown',async t=>{
 const first=await start(t),item=(await first.create()).json.item,request={requestId:'notify_001',revision:item.revision,agentId:'default',input:'Synthetic original'};
 const original=await first.call('POST',`/v1/kanban/items/${item.id}/notify`,request);first.stop();
 const next=await start(t,{directory:first.directory,hermes:new FakeHermes()});
 next.hermes.statuses.set(original.json.runId,{status:'completed',output:'Unscoped remote terminal',error:null});
 const absent=await next.call('GET',`/v1/kanban/items/${item.id}/notifications/notify_001`);assert.equal(absent.json.turn,null,'Remote status lacks the recorded Conversation identity');
 const other=await next.call('POST','/v1/agents/default/runs',{input:'Unrelated same Agente'});assert.equal(other.json.runId,original.json.runId);assert.notEqual(other.json.conversationId,original.json.conversationId);
 next.hermes.stream(other.json.runId).push({event:'run.completed',seq:1,output:'Synthetic terminal'});const {eventually}=await import('../support/channel.ts');await eventually(()=>assert.equal(next.runs.snapshot(other.json.runId).phase,'completed'));
 const observed=await next.call('GET',`/v1/kanban/items/${item.id}/notifications/notify_001`);assert.equal(observed.json.turn,null);
 const repeated=await next.call('POST',`/v1/kanban/items/${item.id}/notify`,{...request,requestId:'notify_002'});assert.equal(repeated.status,409);assert.equal(next.hermes.callsTo('createRun').length,1);
});


test('HTTP Work loads and persists under a readable checkout without making its private store public',async t=>{
  const directory=await fs.mkdtemp(path.resolve('.kanban-checkout-'));
  await fs.chmod(directory,0o755);
  const first=await start(t,{directory});
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const page=await first.call('GET','/v1/kanban/items');
  assert.equal(page.status,200,'A safe 0755 checkout must expose readable Work through the HTTP route');
  assert.equal(page.json.items.length,0);
  const created=await first.create();assert.equal(created.status,201);
  const item=created.json.item;
  first.stop();
  const restarted=await start(t,{directory});
  const restored=await restarted.call('GET',`/v1/kanban/items/${item.id}`);
  assert.equal(restored.status,200);assert.deepEqual(restored.json.item,item);
  assert.equal((await fs.stat(directory)).mode&0o777,0o755,'The checkout must retain its permissions');
  assert.equal(restarted.hermes.callsTo('createConversation').length,0);assert.equal(restarted.hermes.callsTo('createRun').length,0);
});


test('HTTP private Work corruption remains unavailable after restart without overwriting records or returning empty',async t=>{
 const directory=await fs.mkdtemp(path.resolve('.kanban-corrupt-checkout-'));await fs.chmod(directory,0o755);
 const first=await start(t,{directory});t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const saved=await first.create();assert.equal(saved.status,201);first.stop();
 const file=path.join(directory,'kanban','kanban.json'),corrupt='private-corruption-canary';await fs.writeFile(file,corrupt,{mode:0o600});
 const restarted=await start(t,{directory});
 for(const response of [await restarted.call('GET','/v1/kanban/items'),await restarted.create('second_01')]){
  assert.equal(response.status,503);assert.equal(response.json.error.code,'kanban_store_unavailable');
  assert.doesNotMatch(response.text,/private-corruption-canary|kanban.json/);assert.equal(response.json.items,undefined);
 }
 assert.equal(await fs.readFile(file,'utf8'),corrupt);assert.equal(restarted.hermes.callsTo('createRun').length,0);
});

test('HTTP Work recovers without a restart once the operator removes an ambiguous legacy lock',async t=>{
 const directory=await fs.mkdtemp(path.resolve('.kanban-ambiguous-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(path.join(directory,'kanban'),{mode:0o700});await fs.writeFile(path.join(directory,'kanban.lock'),'',{mode:0o600});
 const {call}=await start(t,{directory});
 const blocked=await call('GET','/v1/kanban/items');assert.equal(blocked.status,503);assert.equal(blocked.json.error.code,'kanban_store_unavailable');
 await fs.rm(path.join(directory,'kanban.lock'));
 assert.equal((await call('GET','/v1/kanban/items')).status,200);
});
