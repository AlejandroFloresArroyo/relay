import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { AgentConfig } from '../src/agentConfig.ts';
import { realExec } from '../src/exec.ts';
import { readAgentUsage } from '../src/agentUsage.ts';
import type { AgentDetails, AgentSecurity } from '../../protocol/agentDetails.ts';
const KEY=`rly1_${Buffer.alloc(32,43).toString('base64url')}`;
const headers={Authorization:`Bearer ${KEY}`,'X-Relay-Protocol':'2','Content-Type':'application/json'};
const deviceId='00000000-0000-4000-8000-000000000043';
const original='secret_fixture: private-config-value\napprovals:\n  mode: manual\n  deny: ["git push --force*", "DROP DATABASE*"]\n  smart_policy: Escala las operaciones peligrosas.\n';
async function fixture(t:import('node:test').TestContext, directory?:string) {
 const root=directory??await fs.mkdtemp(path.join(os.tmpdir(),'relay-details-'));if(!directory)t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,'hermes');await fs.mkdir(home,{recursive:true,mode:0o700});
 if(!directory)await fs.writeFile(path.join(home,'config.yaml'),original,{mode:0o600});
 const state=path.join(root,'relay');await fs.mkdir(state,{recursive:true,mode:0o700});const store=await createDeviceStore({directory:state});
 if(!directory)await store.mutate(s=>{s.devices.push({id:deviceId,name:'phone',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(KEY).toString('hex')})});
 const config=new AgentConfig({home,python:'python3',exec:realExec,managedFile:path.join(root,'no-managed')});
 const hermes=new FakeHermes();hermes.details={security:p=>config.security(p),usage:async(_p,at)=>readAgentUsage(home,at),writeSecurity:(...args)=>config.writeSecurity(...args)};
 const runs=new RunManager({hermes,notifier:{async approvalCreated(){}},sleep:async()=>{}});const logs:string[]=[];
 const server=createApp({now:()=>1700000000043,config:{corsOrigins:[]},store,pairing:createPairing({store,origin:async()=>'',serverName:'fixture'}),hermes,runs,tailnet:{async whois(){return null}},peerAddress:()=> '100.64.0.1',log:l=>logs.push(l)});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const close=()=>{runs.close();server.closeAllConnections();server.close()};t.after(close);
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 async function call<T=any>(method:string,route:string,body?:unknown,auth=headers){const response=await fetch(base+route,{method,headers:auth,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,json:await response.json() as T}};
 const details=()=>call<AgentDetails>('GET','/v1/agents/default/details');
 return {root,home,store,hermes,runs,logs,call,details,close};
}
test('a mode stays pending across Puente restart and applies with byte backup and content-free audit only before the next Relay Turn',async(t)=>{
 const f=await fixture(t);const first=await f.details();assert.equal(first.status,200);assert.equal(first.json.security.mode,'manual');
 const changed=await f.call<AgentSecurity>('POST','/v1/agents/default/approval-mode',{mode:'smart',revision:first.json.security.revision});
 assert.equal(changed.status,200);assert.equal(changed.json.mode,'manual');assert.equal(changed.json.pendingMode?.mode,'smart');assert.equal(changed.json.pendingMode?.requestedAt,1700000000043);
 assert.equal(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),original);f.close();
 const next=await fixture(t,f.root);const reloaded=await next.details();assert.equal(reloaded.json.security.pendingMode?.mode,'smart');
 const started=await next.call('POST','/v1/agents/default/runs',{input:'Hello'});assert.equal(started.status,200);
 assert.match(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),/mode: smart/);
 assert.equal((await next.details()).json.security.pendingMode,null);
 const backups=(await fs.readdir(path.join(f.root,'relay'))).filter(n=>n.endsWith('.config-backup'));
 assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(f.root,'relay',backups[0]),'utf8'),original);
 const audit=await fs.readFile(path.join(f.root,'relay','changes.jsonl'),'utf8');
 assert.match(audit,/agent.mode.queued/);assert.match(audit,/agent.mode.requested/);assert.match(audit,/agent.mode.succeeded/);assert.doesNotMatch(audit,/private-config-value|git push|DROP DATABASE/);
 assert.doesNotMatch(JSON.stringify(reloaded.json)+next.logs.join('\n'),/private-config-value|secret_fixture/);
});
test('queue revision serializes competing changes, cancellation writes no Hermes config, and a stale config prevents applying a pending mode',async(t)=>{
 const f=await fixture(t);const first=(await f.details()).json;
 const responses=await Promise.all([f.call<AgentSecurity>('POST','/v1/agents/default/approval-mode',{mode:'smart',revision:first.security.revision}),f.call('POST','/v1/agents/default/approval-mode',{mode:'off',revision:first.security.revision})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),original);
 const current=(await f.details()).json.security;const cancel=await f.call<AgentSecurity>('POST','/v1/agents/default/approval-mode',{mode:'manual',revision:current.revision});
 assert.equal(cancel.status,200);assert.equal(cancel.json.pendingMode,null);assert.equal(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),original);
 await f.call('POST','/v1/agents/default/approval-mode',{mode:'off',revision:cancel.json.revision});await fs.appendFile(path.join(f.home,'config.yaml'),'# external edit\n');
 assert.equal((await f.call('POST','/v1/agents/default/runs',{input:'No unsafe start'})).status,409);assert.equal(f.hermes.callsTo('createRun').length,0);assert.match(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),/mode: manual/);
});
test('an actor revoked after queuing cannot lower protection from another active device and cannot reach private details',async(t)=>{
 const f=await fixture(t);const security=(await f.details()).json.security;await f.call('POST','/v1/agents/default/approval-mode',{mode:'off',revision:security.revision});
 const otherKey=`rly1_${Buffer.alloc(32,44).toString('base64url')}`,auth={...headers,Authorization:`Bearer ${otherKey}`};
 await f.store.mutate(s=>{s.devices[0].revokedAt=Date.now();s.devices.push({id:'00000000-0000-4000-8000-000000000044',name:'other',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(otherKey).toString('hex')})});
 assert.equal((await f.details()).status,403);
 const stopped=await f.call('POST','/v1/agents/default/runs',{input:'Do not apply revoked preference'},auth);assert.equal(stopped.status,403);assert.equal(f.hermes.callsTo('createRun').length,0);assert.equal(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),original);
});
test('exact deny globs survive additions and removals, and unavailable audit fails before writing config',async(t)=>{
 const f=await fixture(t);const before=(await f.details()).json.security;
 const added=await f.call<AgentSecurity>('POST','/v1/agents/default/block-rules',{action:'add',pattern:'Echo [Aa]*',revision:before.revision});assert.equal(added.status,200);assert.deepEqual(added.json.deny,['git push --force*','DROP DATABASE*','Echo [Aa]*']);
 const removed=await f.call<AgentSecurity>('POST','/v1/agents/default/block-rules',{action:'remove',pattern:'git push --force*',revision:added.json.revision});assert.equal(removed.status,200);assert.deepEqual(removed.json.deny,['DROP DATABASE*','Echo [Aa]*']);
 const contents=await fs.readFile(path.join(f.home,'config.yaml'),'utf8');assert.match(contents,/secret_fixture: private-config-value/);
 const auditFile=path.join(f.root,'relay','changes.jsonl');await fs.rename(auditFile,auditFile+'.previous');await fs.symlink(auditFile+'.previous',auditFile);
 const rejected=await f.call('POST','/v1/agents/default/block-rules',{action:'remove',pattern:'DROP DATABASE*',revision:removed.json.revision});assert.notEqual(rejected.status,200);assert.equal(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),contents);assert.doesNotMatch(JSON.stringify(rejected.json),/private-config-value|secret_fixture/);
});

test('a free rule addition cannot reactivate a mode invalidated by an external protection change',async(t)=>{
 const f=await fixture(t);const security=(await f.details()).json.security;
 assert.equal((await f.call('POST','/v1/agents/default/approval-mode',{mode:'off',revision:security.revision})).status,200);
 await fs.writeFile(path.join(f.home,'config.yaml'),original.replace('mode: manual','mode: smart'));
 assert.equal((await f.call('POST','/v1/agents/default/runs',{input:'Must resolve the stale mode'})).status,409);
 const stale=(await f.details()).json.security;assert.match(stale.reason!,/cambió/);
 const added=await f.call<AgentSecurity>('POST','/v1/agents/default/block-rules',{action:'add',pattern:'rm *.bak',revision:stale.revision});
 assert.equal(added.status,200);
 assert.equal((await f.call('POST','/v1/agents/default/runs',{input:'Still blocked until mode is explicitly selected'})).status,409);
 assert.equal(f.hermes.callsTo('createRun').length,0);
 assert.match(await fs.readFile(path.join(f.home,'config.yaml'),'utf8'),/mode: smart/);
 assert.match((await f.details()).json.security.reason!,/cambió/);
});

test('editing rules preserves a still valid pending mode and applying it retains the new rules',async(t)=>{
 const f=await fixture(t);const security=(await f.details()).json.security;
 const queued=await f.call<AgentSecurity>('POST','/v1/agents/default/approval-mode',{mode:'off',revision:security.revision});assert.equal(queued.status,200);
 const added=await f.call<AgentSecurity>('POST','/v1/agents/default/block-rules',{action:'add',pattern:'rm *.bak',revision:queued.json.revision});assert.equal(added.status,200);
 assert.equal((await f.call('POST','/v1/agents/default/runs',{input:'Apply the authorized mode with current rules'})).status,200);
 const final=(await f.details()).json.security;assert.equal(final.mode,'off');assert.equal(final.pendingMode,null);assert.ok(final.deny!.includes('rm *.bak'));
});

test('an existing exact Hermes deny glob with surrounding spaces can be removed without normalizing another rule',async(t)=>{
 const f=await fixture(t);const contents=original.replace('"git push --force*"','" git push --force* "');
 await fs.writeFile(path.join(f.home,'config.yaml'),contents);
 const security=(await f.details()).json.security;assert.ok(security.deny!.includes(' git push --force* '));
 const removed=await f.call<AgentSecurity>('POST','/v1/agents/default/block-rules',{action:'remove',pattern:' git push --force* ',revision:security.revision});
 assert.equal(removed.status,200);assert.deepEqual(removed.json.deny,['DROP DATABASE*']);
 const backups=(await fs.readdir(path.join(f.root,'relay'))).filter(n=>n.endsWith('.config-backup'));
 assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(f.root,'relay',backups[0]),'utf8'),contents);
 const invalid=await f.call('POST','/v1/agents/default/block-rules',{action:'add',pattern:' rm *.bak ',revision:removed.json.revision});assert.equal(invalid.status,400);
});


test('general pause rejects a Turn before applying its queued approval mode or writing a backup', async (t) => {
 const f = await fixture(t); const security = (await f.details()).json.security;
 assert.equal((await f.call('POST', '/v1/agents/default/approval-mode', { mode: 'off', revision: security.revision })).status, 200);
 f.hermes.serverControl = { async paused() { return true; }, async pause() {}, async resume() {} };
 const rejected = await f.call('POST', '/v1/agents/default/runs', { input: 'Keep the queued mode until work is admitted' });
 assert.equal(rejected.status, 409);
 assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), original);
 assert.equal((await f.details()).json.security.pendingMode?.mode, 'off');
 assert.equal(f.hermes.callsTo('createRun').length, 0);
 assert.deepEqual((await fs.readdir(path.join(f.root, 'relay'))).filter(name => name.endsWith('.config-backup')), []);
});
