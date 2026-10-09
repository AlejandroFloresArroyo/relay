import { memoryDecisionStore, type DecisionStore } from '../src/decisionStore.ts';
import { constants } from 'node:fs';
import type { StateIO } from '../src/changeLog.ts';
import type { NotificationPublisher } from '../src/notifications.ts';
import { eventually } from '../support/channel.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../protocol/protocol.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATIONS_HEADER } from '../../protocol/notifications.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const HEADERS = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': String(PROTOCOL_VERSION), [NOTIFICATIONS_HEADER]: '1' };
const ORIGIN = 'http://ntfy.fixture.ts.net:8080';
const ENDPOINT = ORIGIN + '/upSyntheticCapability123456789?up=1';
async function start(t: TestContext, options: { decisions?:DecisionStore; io?:StateIO; directory?:string; publish?:NotificationPublisher; configured?:boolean } = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'relay-notifications-fake-'));
  if (!options.directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1700000000000;
  const store = await createDeviceStore({ directory, now: () => clock });
  await store.mutate(state => { if (!state.devices.some(device => device.id === DEVICE)) state.devices.push({ id: DEVICE, name: 'synthetic-phone', pairedAt: clock, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, decisionStore:options.decisions, now: () => clock });
  const logs: string[] = [];
  const publications: Array<{ endpoint: string; body: string; signal: AbortSignal }> = [];
  const deps = { config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://relay.fixture.ts.net:1234', serverName: 'fixture' }),
    hermes, runs, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', now: () => clock,
    log: (line: string) => logs.push(line), notificationOrigin: options.configured === false ? undefined : ORIGIN, notificationIO:options.io,
    // Widget signals have their own suite (widgetHttp.test.ts); these count notices only.
    notificationPublisher: async (endpoint: string, body: string, signal: AbortSignal) => { if (JSON.parse(body).kind === 'widget') return; publications.push({ endpoint, body, signal }); await options.publish?.(endpoint,body,signal); },
  };
  const server = createApp(deps);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function stop() { runs.close(); if (!server.listening) return; server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  t.after(stop);
  async function call(method: string, route: string, body?: unknown, headers: Record<string,string> = HEADERS) {
    const response = await fetch(base + route, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }
  return { call, stop, deps, publications, store, hermes, runs, logs, directory, advance(ms: number) { clock += ms; } };
}
test('notifications capability is authenticated, explicitly versioned and initially disabled per device', async t => {
  const app = await start(t);
  assert.equal((await app.call('GET','/v1/notifications',undefined,{})).status,401);
  assert.equal((await app.call('GET','/v1/notifications',undefined,{Authorization:HEADERS.Authorization})).status,426);
  assert.equal((await app.call('GET','/v1/notifications',undefined,{Authorization:HEADERS.Authorization,'X-Relay-Protocol':String(PROTOCOL_VERSION)})).status,426);
  const status = await app.call('GET','/v1/notifications');
  assert.equal(status.status,200);
  const value = JSON.parse(status.text);
  assert.deepEqual(value.preferences,DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(value.registration,null);
  assert.equal(value.revision,0);
  assert.equal(value.configured,true);
  assert.deepEqual(value.availableKinds,['approval','task','error','server']);
  assert.equal(value.delivery,'disabled');
  assert.equal(app.publications.length,0);
});

test('registration is a durable per-device CAS, contains no endpoint in replies/audit and disabling invalidates it', async t => {
  const app = await start(t);
  const input = { schema:1, revision:0, endpoint:ENDPOINT, preferences:{...DEFAULT_NOTIFICATION_PREFERENCES, enabled:true} };
  const created = await app.call('PUT','/v1/notifications/registration',input);
  assert.equal(created.status,200);
  const first = JSON.parse(created.text);
  assert.equal(first.revision,1);
  assert.ok(first.registration.id);
  assert.equal(first.delivery,'unknown');
  assert.doesNotMatch(created.text,/SyntheticCapability|endpoint/);
  assert.equal((await app.call('PUT','/v1/notifications/registration',input)).status,409);
  const removed = await app.call('DELETE','/v1/notifications/registration',{schema:1,revision:1});
  assert.equal(removed.status,200);
  const disabled = JSON.parse(removed.text);
  assert.equal(disabled.revision,2);
  assert.equal(disabled.registration,null);
  assert.equal(disabled.preferences.enabled,false);
  const stored = JSON.parse(await fs.readFile(path.join(app.directory,'notifications.json'),'utf8'));
  assert.equal(stored.entries[0].endpoint,null);
  const audit = await fs.readFile(path.join(app.directory,'changes.jsonl'),'utf8');
  assert.match(audit,/notification.registration.requested/);
  assert.doesNotMatch(audit,/SyntheticCapability|endpoint|preferences/);
  assert.ok((await fs.readdir(app.directory)).some(name => name.startsWith('notifications-version-')));
});

async function pendingNotice(app: Awaited<ReturnType<typeof start>>) {
  await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
  await app.runs.start(app.hermes.profilesList[1],{input:'synthetic input'});
  app.hermes.stream('run_1').push({ event:'approval.request',seq:0,request_id:'synthetic-approval',command:'synthetic-private-command',choices:['once','deny'],timestamp:1700000000 });
  await eventually(() => assert.equal(app.publications.length,1));
  return JSON.parse(app.publications[0].body);
}
test('private generic delivery resolves the exact target and rejection ACKs only once through fake Hermes', async t => {
  const app = await start(t);
  const envelope = await pendingNotice(app);
  assert.deepEqual(Object.keys(envelope).sort(),['schema','kind','noticeId','registrationId','expiresAt'].sort());
  assert.equal(envelope.kind,'approval');
  assert.doesNotMatch(app.publications[0].body,/synthetic-private-command|coding|rly1_/);
  const route = '/v1/notifications/notices/' + envelope.noticeId;
  const notice = await app.call('GET',route);
  assert.equal(notice.status,200);
  const value = JSON.parse(notice.text);
  assert.deepEqual(value.target,{agentId:'coding',runId:'run_1',approvalId:'synthetic-approval'});
  assert.equal(value.state,'pending');
  const input = {schema:1,registrationId:envelope.registrationId,target:value.target,choice:'deny'};
  assert.equal((await app.call('POST',route+'/decision',{...input,target:{...value.target,runId:'wrong-run'}})).status,409);
  assert.equal((await app.call('POST',route+'/decision',{...input,choice:'session'})).status,400);
  assert.equal((await app.call('POST',route+'/decision',{...input,choice:['deny']})).status,400);
  assert.equal((await app.call('POST',route+'/decision',input)).status,200);
  assert.equal((await app.call('POST',route+'/decision',{...input,choice:['deny']})).status,400);
  assert.equal((await app.call('POST',route+'/decision',input)).status,200);
  assert.deepEqual(app.hermes.callsTo('resolveApproval').map(call => call.args),[['coding','run_1','deny','synthetic-approval']]);
  assert.equal(JSON.parse((await app.call('GET',route)).text).state,'rejected');
  assert.doesNotMatch(app.logs.join('\n'),/synthetic-private-command|SyntheticCapability|synthetic-approval/);
  assert.ok(!app.logs.join('\n').includes(envelope.noticeId));
  assert.ok(!app.logs.join('\n').includes(envelope.registrationId));
});

test('expiry, registration rotation and another device cannot authorize an old notice',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const value=JSON.parse((await app.call('GET',route)).text);
 const input={schema:1,registrationId:envelope.registrationId,target:value.target,choice:'once'};
 const other='00000000-0000-4000-8000-000000000002';const otherKey=`rly1_${Buffer.alloc(32,8).toString('base64url')}`;
 await app.store.mutate(state=>{state.devices.push({id:other,name:'other-fixture',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(otherKey).toString('hex')});});
 assert.equal((await app.call('GET',route,undefined,{...HEADERS,Authorization:'Bearer '+otherKey})).status,404);
 app.advance(300001);
 assert.equal(JSON.parse((await app.call('GET',route)).text).state,'expired');
 assert.equal((await app.call('POST',route+'/decision',input)).status,409);
 assert.equal(app.hermes.callsTo('resolveApproval').length,0);
 await app.call('PUT','/v1/notifications/registration',{schema:1,revision:1,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
 assert.equal((await app.call('GET',route)).status,404);
});
test('approval ACK remains honest when fake Hermes resolution is uncertain',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 app.hermes.failWith.resolveApproval=new Error('synthetic-private-upstream-canary');
 const input={schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'};
 const response=await app.call('POST',route+'/decision',input);
 assert.equal(response.status,409);assert.match(response.text,/decision_uncertain/);assert.doesNotMatch(response.text,/synthetic-private-upstream-canary|outcome/);
 assert.equal(JSON.parse((await app.call('GET',route)).text).state,'uncertain');
 const again=await app.call('POST',route+'/decision',input);
 assert.equal(again.status,409);assert.equal(app.hermes.callsTo('resolveApproval').length,1);
});

test('revocation during durable decision prepare blocks fake Hermes and purges enrollment',async t=>{
 let release!:()=>void;let entered!:()=>void;
 const arrived=new Promise<void>(resolve=>{entered=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
 const ledger=memoryDecisionStore();const prepare=ledger.prepare;
 ledger.prepare=async record=>{await prepare(record);entered();await blocked;};
 const app=await start(t,{decisions:ledger});const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 const pending=app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 await arrived;
 await app.store.mutate(state=>{state.devices[0].revokedAt=1700000000001;});
 release();
 const response=await pending;assert.equal(response.status,403);
 assert.equal(app.hermes.callsTo('resolveApproval').length,0);
 await eventually(async()=>{const value=JSON.parse(await fs.readFile(path.join(app.directory,'notifications.json'),'utf8'));assert.equal(value.entries[0].endpoint,null);});
 
});
test('authorization after the last disk wait prevents replacement by a revoked device',async t=>{
 let arm=false;let release!:()=>void;let entered!:()=>void;
 const arrived=new Promise<void>(resolve=>{entered=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
 const replacements:string[]=[];
 const io={...fs,open:(async(file:Parameters<typeof fs.open>[0],flags:Parameters<typeof fs.open>[1],mode?:number)=>{
   const handle=await fs.open(file,flags,mode);
   if(arm && String(file).includes('/.notifications.')){
     arm=false;const close=handle.close.bind(handle);handle.close=async()=>{await close();entered();await blocked;};
   }
   return handle;
 }) as typeof fs.open,rename:async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
   if(String(to).endsWith('/notifications.json')) replacements.push(await fs.readFile(from,'utf8'));
   await fs.rename(from,to);
 }};
 const app=await start(t,{io});
 await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
 arm=true;
 const pending=app.call('PUT','/v1/notifications/registration',{schema:1,revision:1,endpoint:ORIGIN+'/upReplacementSynthetic123456789?up=1',preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
 await arrived;await app.store.mutate(state=>{state.devices[0].revokedAt=1700000000001;});release();
 assert.equal((await pending).status,403);
 await eventually(async()=>{const value=JSON.parse(await fs.readFile(path.join(app.directory,'notifications.json'),'utf8'));assert.equal(value.entries[0].endpoint,null);});
 assert.ok(!replacements.some(raw=>raw.includes('upReplacementSynthetic')));
});
test('revoking a device after its registration replace keeps notifications available for other devices',async t=>{
 let arm=false;let release!:()=>void;let entered!:()=>void;
 const arrived=new Promise<void>(resolve=>{entered=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
 const io={...fs,rename:async(from:Parameters<typeof fs.rename>[0],to:Parameters<typeof fs.rename>[1])=>{
   await fs.rename(from,to);
   if(arm && String(to).endsWith('/notifications.json')){arm=false;entered();await blocked;}
 }};
 const app=await start(t,{io});
 const other='00000000-0000-4000-8000-000000000002';const otherKey=`rly1_${Buffer.alloc(32,8).toString('base64url')}`;
 const otherHeaders={...HEADERS,Authorization:'Bearer '+otherKey};
 await app.store.mutate(state=>{state.devices.push({id:other,name:'other-fixture',pairedAt:1700000000000,revokedAt:null,keyHash:hashDeviceKey(otherKey).toString('hex')});});
 const input={schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}};
 assert.equal((await app.call('PUT','/v1/notifications/registration',input,otherHeaders)).status,200);
 arm=true;
 const pending=app.call('PUT','/v1/notifications/registration',input);
 await arrived;await app.store.mutate(state=>{state.devices[0].revokedAt=1700000000001;});release();
 assert.equal((await pending).status,403);
 assert.equal((await app.call('GET','/v1/notifications',undefined,otherHeaders)).status,200);
 await eventually(async()=>{const value=JSON.parse(await fs.readFile(path.join(app.directory,'notifications.json'),'utf8'));
   assert.equal(value.entries.find((entry:{deviceId:string})=>entry.deviceId===DEVICE).endpoint,null);});
 assert.equal((await app.call('GET','/v1/notifications',undefined,otherHeaders)).status,200);
});

test('a failed directory sync after replacing registration state fails closed',async t=>{
 let arm=false;
 const io={...fs,open:(async(file:Parameters<typeof fs.open>[0],flags:Parameters<typeof fs.open>[1],mode?:number)=>{
   if(arm && typeof flags==='number' && (flags&constants.O_DIRECTORY)){arm=false;throw Object.assign(new Error('synthetic sync failure'),{code:'EIO'});}
   return fs.open(file,flags,mode);
 }) as typeof fs.open};
 const app=await start(t,{io});
 arm=true;
 assert.notEqual((await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}})).status,200);
 assert.equal((await app.call('GET','/v1/notifications')).status,503);
});


test('registration rejects extra fields, unsupported schemas, overflow and query aliases without writing',async t=>{
 const app=await start(t);
 const input={schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}};
 for(const value of [{...input,schema:2},{...input,revision:Number.MAX_SAFE_INTEGER},{...input,key:'synthetic-private-key'},
   {...input,preferences:{...input.preferences,preview:'command'}},{...input,endpoint:'https://ntfy.sh/upSyntheticCapability123456789'}]){
   assert.equal((await app.call('PUT','/v1/notifications/registration',value)).status,400);
 }
 assert.equal((await app.call('PUT','/v1/notifications/registration?legacy=1',input)).status,400);
 assert.equal(JSON.parse((await app.call('GET','/v1/notifications')).text).revision,0);
 assert.equal(app.publications.length,0);
 await assert.rejects(fs.stat(path.join(app.directory,'notifications.json')),{code:'ENOENT'});
});

test('a revoked device aborts an outstanding publication and a late completion cannot restore enrollment',async t=>{
 let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
 const app=await start(t,{publish:async()=>blocked});const envelope=await pendingNotice(app);
 assert.equal(JSON.parse((await app.call('GET','/v1/notifications')).text).delivery,'unknown');
 await app.store.mutate(state=>{state.devices[0].revokedAt=1700000000001;});
 assert.equal(app.publications[0].signal.aborted,true);
 release();
 await eventually(async()=>{const value=JSON.parse(await fs.readFile(path.join(app.directory,'notifications.json'),'utf8'));assert.equal(value.entries[0].endpoint,null);assert.equal(value.entries[0].preferences.enabled,false);});
 await app.stop();
 const restarted=await start(t,{directory:app.directory});
 assert.equal((await restarted.call('GET','/v1/notifications')).status,403);
 assert.equal((await restarted.call('GET','/v1/notifications/notices/'+envelope.noticeId)).status,403);
 assert.equal(restarted.publications.length,0);
});

test('enrollment persists across restart while notice actions remain unknown and lease expiry disables delivery',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);
 await app.stop();const restarted=await start(t,{directory:app.directory});
 let status=JSON.parse((await restarted.call('GET','/v1/notifications')).text);
 assert.equal(status.revision,1);assert.equal(status.registration.id,envelope.registrationId);assert.equal(status.delivery,'unknown');
 assert.equal((await restarted.call('GET','/v1/notifications/notices/'+envelope.noticeId)).status,404);
 restarted.advance(7*24*60*60*1000+1);
 status=JSON.parse((await restarted.call('GET','/v1/notifications')).text);
 assert.equal(status.registration,null);assert.equal(status.delivery,'disabled');
 await restarted.runs.start(restarted.hermes.profilesList[1],{input:'synthetic input'});
 restarted.hermes.stream('run_1').push({event:'approval.request',seq:0,request_id:'synthetic-after-lease',command:'synthetic command',choices:['once','deny'],timestamp:1700000000+7*24*60*60+1});
 await eventually(()=>assert.equal(restarted.runs.approvals().length,1));
 await restarted.call('GET','/v1/notifications');
 assert.equal(restarted.publications.length,0);
});

test('a muted approval type produces no delivery and enabling it requires a new registration revision',async t=>{
 const app=await start(t);
 const preferences={...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true,types:{...DEFAULT_NOTIFICATION_PREFERENCES.types,approval:false}};
 const input={schema:1,revision:0,endpoint:ENDPOINT,preferences};
 assert.equal((await app.call('PUT','/v1/notifications/registration',input)).status,200);
 await app.runs.start(app.hermes.profilesList[1],{input:'synthetic input'});
 app.hermes.stream('run_1').push({event:'approval.request',seq:0,request_id:'synthetic-muted',command:'synthetic command',choices:['once','deny'],timestamp:1700000000});
 await eventually(()=>assert.equal(app.runs.approvals().length,1));await app.call('GET','/v1/notifications');assert.equal(app.publications.length,0);
 assert.equal((await app.call('PUT','/v1/notifications/registration',{...input,preferences:{...preferences,types:{...preferences.types,approval:true}}})).status,409);
 assert.equal(app.publications.length,0);
});


test('a symlinked enrollment file fails closed without exposing its private contents or sending notices',async t=>{
 const app=await start(t);
 assert.equal((await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}})).status,200);
 await app.stop();
 const file=path.join(app.directory,'notifications.json');const target=path.join(app.directory,'synthetic-private-target.json');
 await fs.rename(file,target);await fs.symlink(target,file);
 const restarted=await start(t,{directory:app.directory});const response=await restarted.call('GET','/v1/notifications');
 assert.equal(response.status,503);assert.doesNotMatch(response.text,/SyntheticCapability|endpoint|target.json/);
 assert.equal(restarted.publications.length,0);
});


test('approval once confirms the exact fake Hermes effect without session authorization',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.text),{ok:true,outcome:'approved'});
 assert.deepEqual(app.hermes.callsTo('resolveApproval').map(call=>call.args),[['coding','run_1','once','synthetic-approval']]);
 assert.equal(JSON.parse((await app.call('GET',route)).text).state,'approved');
});

test('decision rechecks approval expiry after the notice read before RunManager or fake Hermes',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);assert.equal(notice.state,'pending');
 const approvals=app.runs.approvals.bind(app.runs);let reads=0;
 // The decision's notice read sees a pending approval; it expires before the decision guard runs.
 t.mock.method(app.runs,'approvals',()=>{if(++reads===2) app.advance(300001);return approvals();});
 const decide=t.mock.method(app.runs,'decide');
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 assert.equal(response.status,409);
 assert.equal(app.hermes.callsTo('resolveApproval').length,0);
 assert.equal(decide.mock.callCount(),0);
});

test('decision on an unknown notice state conflicts without calling fake Hermes',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 t.mock.method(app.runs,'approvals',()=>[]);
 const decide=t.mock.method(app.runs,'decide');
 assert.equal(JSON.parse((await app.call('GET',route)).text).state,'unknown');
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 assert.equal(response.status,409);
 assert.equal(app.hermes.callsTo('resolveApproval').length,0);
 assert.equal(decide.mock.callCount(),0);
});

test('a notice whose registration lease expired conflicts without calling fake Hermes',async t=>{
 const app=await start(t);const lease=7*24*60*60*1000;
 await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
 app.advance(lease-1000);
 await app.runs.start(app.hermes.profilesList[1],{input:'synthetic input'});
 app.hermes.stream('run_1').push({event:'approval.request',seq:0,request_id:'synthetic-approval',command:'synthetic command',choices:['once','deny'],timestamp:1700000000+lease/1000-1});
 await eventually(()=>assert.equal(app.publications.length,1));
 const envelope=JSON.parse(app.publications[0].body);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);assert.equal(notice.state,'pending');
 app.advance(2000);
 assert.equal((await app.call('GET',route)).status,409);
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 assert.equal(response.status,409);
 assert.equal(app.hermes.callsTo('resolveApproval').length,0);
});

test('an unconfigured private channel reports disabled and refuses enrollment without any publication',async t=>{
 const app=await start(t,{configured:false});const response=await app.call('GET','/v1/notifications');
 assert.equal(response.status,200);const status=JSON.parse(response.text);
 assert.equal(status.configured,false);assert.equal(status.registration,null);assert.equal(status.delivery,'disabled');
 const denied=await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}});
 assert.equal(denied.status,503);assert.doesNotMatch(denied.text,/Hermes|API_SERVER_KEY/);assert.match(denied.text,/Avisos/);
 assert.equal(app.publications.length,0);
 await assert.rejects(fs.stat(path.join(app.directory,'notifications.json')),{code:'ENOENT'});
});


test('review predeadline human ACK after expiry stays confirmed', async t => {
  const app = await start(t);
  const envelope = await pendingNotice(app);
  const route = '/v1/notifications/notices/' + envelope.noticeId;
  const notice = JSON.parse((await app.call('GET',route)).text);
  const real = app.hermes.resolveApproval.bind(app.hermes);
  t.mock.method(app.hermes,'resolveApproval',async (...args: Parameters<typeof real>) => {
    app.advance(300001);
    return real(...args);
  });
  const response = await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
  const finalNotice = JSON.parse((await app.call('GET',route)).text);
  assert.deepEqual({responseStatus:response.status,noticeState:finalNotice.state,upstreamCalls:app.hermes.calls.filter(call=>call.method==='resolveApproval').length},
    {responseStatus:200,noticeState:'approved',upstreamCalls:1});
});

test('review disabling absent registration cannot poison valid registry capacity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'relay-notifications-capacity-review-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const entries = Array.from({length:256},(_,index)=>({
    deviceId:'00000000-0000-4000-8000-'+String(index+2).padStart(12,'0'),
    deviceHash:'a'.repeat(64),revision:1,registrationId:null,expiresAt:1700000000000,endpoint:null,
    preferences:structuredClone(DEFAULT_NOTIFICATION_PREFERENCES)
  }));
  await fs.writeFile(path.join(directory,'notifications.json'),JSON.stringify({schema:1,entries}),{mode:0o600});
  const app = await start(t,{directory});
  assert.equal((await app.call('GET','/v1/notifications')).status,200);
  const file = path.join(directory,'notifications.json');
  const before = await fs.readFile(file,'utf8');
  const deletion = await app.call('DELETE','/v1/notifications/registration',{schema:1,revision:0});
  assert.equal(deletion.status,200);
  const disabled = JSON.parse(deletion.text);
  assert.equal(disabled.revision,0);
  assert.deepEqual(disabled.preferences,DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(disabled.registration,null);
  assert.equal(await fs.readFile(file,'utf8'),before,'an absent DELETE must not write or consume quota');
  assert.equal((await app.call('DELETE','/v1/notifications/registration',{schema:1,revision:1})).status,409);
  assert.equal((await app.call('PUT','/v1/notifications/registration',{schema:1,revision:0,endpoint:ENDPOINT,preferences:{...DEFAULT_NOTIFICATION_PREFERENCES,enabled:true}})).status,503);
  assert.equal(await fs.readFile(file,'utf8'),before,'refusals must preserve all revisions and preferences');
  await app.stop();
  const reloaded = await start(t,{directory});
  const status = await reloaded.call('GET','/v1/notifications');
  assert.equal(status.status,200,'valid DELETE must not persist a registry rejected at next startup');
});


test('authorization remains required after a confirmed notification decision ACK', async t => {
  const app = await start(t);
  const envelope = await pendingNotice(app);
  const route = '/v1/notifications/notices/' + envelope.noticeId;
  const notice = JSON.parse((await app.call('GET',route)).text);
  const real = app.hermes.resolveApproval.bind(app.hermes);
  t.mock.method(app.hermes,'resolveApproval',async (...args: Parameters<typeof real>) => {
    await real(...args);
    await app.store.mutate(state => { state.devices[0].revokedAt = 1700000000001; });
  });
  const response = await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
  assert.equal(response.status,403);
  assert.deepEqual(app.hermes.callsTo('resolveApproval').map(call=>call.args),[['coding','run_1','once','synthetic-approval']]);
  assert.equal((await app.call('GET',route)).status,403);
});

test('independent notification ACK cannot confirm deny when live Hermes evidence approved',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 const original=app.hermes.resolveApproval.bind(app.hermes);
 t.mock.method(app.hermes,'resolveApproval',async(...args: Parameters<typeof original>)=>{
   await original(...args);
   app.hermes.stream('run_1').push({event:'approval.responded',seq:1,request_id:'synthetic-approval',choice:'once',resolved:1,timestamp:1700000000});
   await new Promise(resolve=>setImmediate(resolve));
 });
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'deny'});
 const after=JSON.parse((await app.call('GET',route)).text);
 console.log('REVIEW_NOTIFICATION_ACK',JSON.stringify({status:response.status,ack:JSON.parse(response.text),actualState:after.state,ledger:(await app.runs.decisionHistory()).map(record=>({choice:record.choice,outcome:record.outcome}))}));
 assert.equal(after.state,'approved','synthetic Hermes approval is durably confirmed');
 assert.equal(response.status,409,'opposite durable decision must not confirm the requested denial');
});


for (const [requested, confirmed] of [['once','deny'],['deny','once'],['once','session']] as const) {
 test(`notification ACK conflicts with durable ${confirmed} when requested ${requested}, including late duplicate events`,async t=>{
  const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
  const notice=JSON.parse((await app.call('GET',route)).text);
  const original=app.hermes.resolveApproval.bind(app.hermes);
  t.mock.method(app.hermes,'resolveApproval',async(...args: Parameters<typeof original>)=>{
   await original(...args);
   app.advance(300001);
   const event={event:'approval.responded',seq:1,request_id:'synthetic-approval',choice:confirmed,resolved:1,timestamp:1700000301};
   app.hermes.stream('run_1').push(event);app.hermes.stream('run_1').push(event);
   await new Promise(resolve=>setImmediate(resolve));
  });
  const input={schema:1,registrationId:envelope.registrationId,target:notice.target,choice:requested};
  const response=await app.call('POST',route+'/decision',input);
  assert.equal(response.status,409,'only the exact durable choice can confirm a notification ACK');
  assert.equal(JSON.parse(response.text).error.code,'conflict');
  const outcome=confirmed==='deny'?'rejected':'approved';
  assert.equal(JSON.parse((await app.call('GET',route)).text).state,outcome);
  const records=await app.runs.decisionHistory();
  assert.equal(records.length,1,'duplicate events must leave a single durable result');
  assert.deepEqual([records[0].agentId,records[0].runId,records[0].approvalId,records[0].choice,records[0].outcome],
   ['coding','run_1','synthetic-approval',confirmed,outcome]);
  assert.equal((await app.call('POST',route+'/decision',input)).status,409,'a conflict never resends the requested choice');
  assert.deepEqual(app.hermes.callsTo('resolveApproval').map(call=>call.args),[['coding','run_1',requested,'synthetic-approval']]);
 });
}

for (const choice of ['once','deny'] as const) {
 test(`notification matching ${choice} ACK survives expiry and duplicate SSE confirmation`,async t=>{
  const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
  const notice=JSON.parse((await app.call('GET',route)).text);
  const original=app.hermes.resolveApproval.bind(app.hermes);
  t.mock.method(app.hermes,'resolveApproval',async(...args: Parameters<typeof original>)=>{
   await original(...args);app.advance(300001);
   const event={event:'approval.responded',seq:1,request_id:'synthetic-approval',choice,resolved:1,timestamp:1700000301};
   app.hermes.stream('run_1').push(event);app.hermes.stream('run_1').push(event);
   await new Promise(resolve=>setImmediate(resolve));
  });
  const input={schema:1,registrationId:envelope.registrationId,target:notice.target,choice};
  for(let replay=0;replay<2;replay++) {
   const response=await app.call('POST',route+'/decision',input);
   assert.equal(response.status,200);
   assert.deepEqual(JSON.parse(response.text),{ok:true,outcome:choice==='once'?'approved':'rejected'});
  }
  assert.equal((await app.runs.decisionHistory()).length,1);
  assert.equal(app.hermes.callsTo('resolveApproval').length,1);
 });
}


test('notification authorization is revalidated after the final durable ACK read',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 const original=app.runs.decisionHistory.bind(app.runs);
 t.mock.method(app.runs,'decisionHistory',async()=>{
  const records=await original();
  if(app.hermes.callsTo('resolveApproval').length) await app.store.mutate(state=>{state.devices[0].revokedAt=1700000000001;});
  return records;
 });
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'once'});
 assert.equal(response.status,403,'revocation during the final ledger read still blocks the ACK');
 assert.equal(app.hermes.callsTo('resolveApproval').length,1);
 assert.equal((await app.call('GET',route)).status,403);
});

test('notification registration scope is revalidated after the final durable ACK read',async t=>{
 const app=await start(t);const envelope=await pendingNotice(app);const route='/v1/notifications/notices/'+envelope.noticeId;
 const notice=JSON.parse((await app.call('GET',route)).text);
 const original=app.runs.decisionHistory.bind(app.runs);
 t.mock.method(app.runs,'decisionHistory',async()=>{
  const records=await original();
  if(app.hermes.callsTo('resolveApproval').length) assert.equal((await app.call('DELETE','/v1/notifications/registration',{schema:1,revision:1})).status,200);
  return records;
 });
 const response=await app.call('POST',route+'/decision',{schema:1,registrationId:envelope.registrationId,target:notice.target,choice:'deny'});
 assert.equal(response.status,404,'an invalidated notice cannot ACK after its final ledger read');
 assert.equal(app.hermes.callsTo('resolveApproval').length,1);
});
