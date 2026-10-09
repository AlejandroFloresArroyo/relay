import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import childProcess from 'node:child_process';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { eventually } from '../support/channel.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { createAgentMemory } from '../src/agentMemory.ts';
import type { AgentMemory, AgentSoul } from '../../protocol/agentMemory.ts';

const KEY = `rly1_${Buffer.alloc(32, 44).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', 'Content-Type': 'application/json' };

test('local revocation queued at the native replacement cannot interleave authorization and rename', async t=>{
 const {call,home,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const rename=fsSync.renameSync;const order:string[]=[];
 let revoked:Promise<unknown>|undefined;
 t.mock.method(fsSync,'renameSync',(from:fsSync.PathLike,to:fsSync.PathLike)=>{
   if(String(to).endsWith('/MEMORY.md')) {
     revoked=store.mutate(s=>{s.devices[0].revokedAt=Date.now();}).then(()=>order.push('revoked'));
     assert.equal(store.snapshot().devices[0].revokedAt,null,'queued revocation has not committed inside the synchronous effect');
     const result=rename(from,to);order.push('replaced');return result;
   }
   return rename(from,to);
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Authorized replacement'});
 await revoked;
 assert.deepEqual(order,['replaced','revoked'],'the real native replacement precedes the queued local revocation');
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFAuthorized replacement\n§\n  Second\n');
 assert.equal(result.status,503);assert.equal(result.json.error.code,'agent_memory_uncertain');
});
function pauseReplacement(t: TestContext, state: string, stage: 'before' | 'prepared') {
  const original=childProcess.spawn;
  const native: { worker?: childProcess.ChildProcess; closed?: Promise<unknown>; output: string } = { output:'' };
  t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
    if (args.some(arg=>arg.endsWith('/agent_memory.py'))) {
      native.worker=original(file,['-I',fileURLToPath(new URL('../support/memoryReplacementBarrier.py',import.meta.url)),args[1],state,stage],options);
      native.closed=new Promise(resolve=>native.worker!.once('close',resolve));
      native.worker.stdout!.on('data',(chunk:Buffer)=>{native.output+=chunk;});
      return native.worker;
    }
    return original(file,args,options);
  });
  syncBuiltinESMExports();
  t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();native.worker?.kill('SIGKILL');await native.closed;});
  return native;
}
function interceptPrepared(t: TestContext, alter: (message: Record<string,unknown>) => void) {
  const spawn=childProcess.spawn;
  t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
    const worker=spawn(file,args,options);
    if(args.some(arg=>arg.endsWith('/agent_memory.py'))) {
      const output=worker.stdout!, emit=output.emit;
      t.mock.method(output,'emit',(event:string,...values:unknown[])=>{
        if(event==='data' && Buffer.isBuffer(values[0])) {
          const value=values[0].toString('utf8');
          if(value.includes('"phase": "prepared"')) {
            const message=JSON.parse(value);alter(message);
            values[0]=Buffer.from(JSON.stringify(message)+'\n');
          }
        }
        return Reflect.apply(emit,output,[event,...values]);
      });
    }
    return worker;
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}
async function start(t: TestContext, options: { env?: Record<string,string|undefined> } = {}) {
  const directory = await fs.mkdtemp(path.resolve('.memory-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'profile'), state = path.join(directory, 'state');
  await fs.mkdir(home); await fs.mkdir(state); await fs.mkdir(path.join(home,'memories'));
  await fs.writeFile(path.join(home,'config.yaml'), 'memory:\n  memory_char_limit: 2200\n  user_char_limit: 1375\n');
  await fs.writeFile(path.join(home,'memories/MEMORY.md'), '\uFEFF First \n§\n  Second\n');
  await fs.writeFile(path.join(home,'memories/USER.md'), 'Soy Ale.');
  const store = await createDeviceStore({ directory: state });
  await store.mutate(s => { s.devices.push({ id: '00000000-0000-4000-8000-000000000044', name:'phone', pairedAt:1700000000000, revokedAt:null, keyHash:hashDeviceKey(KEY).toString('hex') }); });
  const hermes = Object.assign(new FakeHermes(), { memory: createAgentMemory({ home, python:'python3', managedFile:path.join(directory,'absent'), env:options.env ?? {} }) });
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier:{ async approvalCreated() {} }, sleep:async()=>{} });
  const server=createApp({ config:{corsOrigins:[]},store,pairing:createPairing({store,origin:async()=> 'http://fixture.example.ts.net',serverName:'fixture'}),hermes,runs,tailnet:{async whois(){return null;}},peerAddress:()=> '100.64.0.1',log:line=>logs.push(line) });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{runs.close();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call<T=any>(method:string,resource='memory',body?:unknown,headers=AUTH,agentId='default') {
    const response=await fetch(`${base}/v1/agents/${encodeURIComponent(agentId)}/${resource}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,json:await response.json() as T};
  }
  return {home,state,store,logs,call,hermes,managedFile:path.join(directory,'absent')};
}

test('HTTP edits one note, retains exact previous bytes privately and records no contents', async t=>{
 const {call,home,state,logs}=await start(t);
 const before=await call<AgentMemory>('GET'); assert.equal(before.status,200);
 assert.deepEqual(before.json.buckets.memory.notes.map(n=>n.text),['First','Second']);
 const result=await call<AgentMemory>('PATCH','memory',{bucket:'memory',revision:before.json.buckets.memory.revision,noteId:before.json.buckets.memory.notes[0].id,content:'Changed 😀'});
 assert.equal(result.status,200); assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFChanged 😀\n§\n  Second\n');
 const backups=(await fs.readdir(state)).filter(n=>n.endsWith('.previous'));
 assert.equal(backups.length,1); assert.equal(await fs.readFile(path.join(state,backups[0]),'utf8'),'\uFEFF First \n§\n  Second\n');
 assert.equal((await fs.stat(path.join(state,backups[0]))).mode&0o777,0o600);
 const audit=await fs.readFile(path.join(state,'changes.jsonl'),'utf8');
 assert.match(audit,/agent.memory.edit.requested/); assert.doesNotMatch(audit+logs.join('\n'),/First|Second|Changed|😀/);
 const record=JSON.parse(audit.split('\n')[0]);assert.equal(backups[0],`memory-${record.id}.previous`);assert.deepEqual(record.details,{file:'memory',previous:true});
});

test('stale revision and cross-bucket identity cannot overwrite external changes', async t=>{
 const {call,home}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const change={bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.user.notes[0].id,content:'Private replacement'};
 assert.equal((await call('PATCH','memory',change)).status,409);
 await fs.writeFile(path.join(home,'memories/MEMORY.md'),'External update');
 assert.equal((await call('PATCH','memory',{...change,noteId:before.buckets.memory.notes[0].id})).status,409);
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'External update');
});

test('external changes during retention and revocation prevent the final write', async t=>{
 const {call,home,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const append=store.changeLog.appendCommitted.bind(store.changeLog);
 store.changeLog.appendCommitted=async record=>{const saved=await append(record);await fs.writeFile(path.join(home,'memories/MEMORY.md'),'Changed during retention');return saved;};
 const request={bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'};
 assert.equal((await call('PATCH','memory',request)).status,409);
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'Changed during retention');
 store.changeLog.appendCommitted=async record=>{const saved=await append(record);await store.mutate(s=>{s.devices[0].revokedAt=Date.now();});return saved;};
 const soul=(await call<AgentSoul>('GET','soul')).json;
 assert.equal((await call('PUT','soul',{revision:soul.revision,content:'Must not create'})).status,403);
 await assert.rejects(fs.stat(path.join(home,'SOUL.md')),{code:'ENOENT'});
});

test('revocation at the final prepared descriptor boundary cancels the real worker before writing', async t=>{
 const {call,home,state,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const native=pauseReplacement(t,state,'before');
 const response=call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'});
 await eventually(async()=>assert.ok(await fs.readFile(path.join(state,'replacement-ready'),'utf8')));
 assert.equal((await fs.readdir(state)).filter(name=>name.endsWith('.previous')).length,1,'retention already completed');
 assert.match(await fs.readFile(path.join(state,'changes.jsonl'),'utf8'),/agent.memory.edit.requested/);
 await store.mutate(s=>{s.devices[0].revokedAt=Date.now();});
 try {
   // The worker's own exit is the signal; the barrier's 5 s timeout ends it if cancellation never arrives.
   await native.closed;
   assert.match(native.output,/"error": "agent_memory_cancelled"/,'cancellation must terminate the worker without releasing preparation');
 } finally { await fs.writeFile(path.join(state,'replacement-release'),'release'); }
 const result=await response;await native.closed;
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n','revocation before the real replace must prevent replacement');
 assert.equal(result.status,403);assert.equal(result.json.error.code,'device_revoked');
 assert.throws(()=>process.kill(native.worker!.pid!,0),{code:'ESRCH'});
 assert.equal((await fs.readdir(path.join(home,'memories'))).filter(name=>name.startsWith('.relay-memory-')).length,0);
});

test('final authorization after staged fsync refuses revocation even if its notification was missed', async t=>{
 const {call,home,state,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 pauseReplacement(t,state,'prepared');
 // The state-watch boundary misses this notification; the final synchronous guard must still check live state.
 t.mock.method(store,'subscribe',()=>()=>{});
 const response=call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'});
 await eventually(async()=>assert.ok(await fs.readFile(path.join(state,'replacement-ready'),'utf8')));
 assert.equal((await fs.readdir(state)).filter(name=>name.endsWith('.previous')).length,1);
 await store.mutate(s=>{s.devices[0].revokedAt=Date.now();});
 await fs.writeFile(path.join(state,'replacement-release'),'release');
 const result=await response;
 assert.equal(result.status,403);assert.equal(result.json.error.code,'device_revoked');
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n');
 assert.equal((await fs.readdir(path.join(home,'memories'))).filter(name=>name.startsWith('.relay-memory-')).length,0);
});

test('revocation after Node replacement but before the native ACK reports uncertainty', async t=>{
 const {call,home,state,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const spawn=childProcess.spawn;
 let revoked:Promise<unknown>|undefined;
 t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
   const worker=spawn(file,args,options);
   if(args.some(arg=>arg.endsWith('/agent_memory.py'))) {
     const input=worker.stdin!, end=input.end;
     t.mock.method(input,'end',(...values:unknown[])=>{
       if(typeof values[0]==='string' && values[0].includes('"committed":true')) {
         revoked=store.mutate(s=>{s.devices[0].revokedAt=Date.now();});
         void revoked.then(()=>{if(!worker.killed)Reflect.apply(end,input,values);});return input;
       }
       return Reflect.apply(end,input,values);
     });
   }
   return worker;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Already replaced'});
 await revoked;
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFAlready replaced\n§\n  Second\n');
 assert.equal(result.status,503);assert.equal(result.json.error.code,'agent_memory_uncertain');
 assert.doesNotMatch(await fs.readFile(path.join(state,'changes.jsonl'),'utf8'),/agent.memory.edit.succeeded|Already replaced/);
});

test('standalone SIGTERM after Node replacement and before the worker reads ACK reports uncertainty',async t=>{
 const {call,home,state}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const spawn=childProcess.spawn;let worker:childProcess.ChildProcess|undefined;
 t.mock.method(childProcess,'spawn',(file:string,args:string[],options:childProcess.SpawnOptions)=>{
  const child=spawn(file,args,options);
  if(args.some(arg=>arg.endsWith('/agent_memory.py'))) {
   worker=child;const input=child.stdin!,end=input.end;
   t.mock.method(input,'end',(...values:unknown[])=>{
    if(typeof values[0]==='string' && values[0].includes('"committed":true')) {
     // Withhold ACK at the native pipe boundary; TERM is not a device-revocation notification.
     child.kill('SIGTERM');return input;
    }
    return Reflect.apply(end,input,values);
   });
  }
  return child;
 });
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();worker?.kill('SIGKILL');});
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Replacement before lost ACK'});
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFReplacement before lost ACK\n§\n  Second\n');
 assert.equal(result.status,503);assert.equal(result.json.error.code,'agent_memory_uncertain');
 assert.doesNotMatch(await fs.readFile(path.join(state,'changes.jsonl'),'utf8'),/agent.memory.edit.succeeded|Replacement before lost ACK/);
 assert.throws(()=>process.kill(worker!.pid!,0),{code:'ESRCH'});
});

test('a native descriptor-close failure after replacement stays uncertain and retires all owned directory descriptors',async t=>{
 const {call,home}=await start(t);const before=(await call<AgentMemory>('GET')).json;
 const open=fsSync.openSync,close=fsSync.closeSync,rename=fsSync.renameSync;
 const directories:number[]=[];let replaced=false,injected=false;
 t.mock.method(fsSync,'openSync',(...values:Parameters<typeof fsSync.openSync>)=>{
  const fd=open(...values);if(fsSync.fstatSync(fd).isDirectory())directories.push(fd);return fd;
 });
 t.mock.method(fsSync,'renameSync',(from:fsSync.PathLike,to:fsSync.PathLike)=>{
  const result=rename(from,to);if(String(to).endsWith('/MEMORY.md'))replaced=true;return result;
 });
 t.mock.method(fsSync,'closeSync',(fd:number)=>{
  close(fd);
  if(replaced&&!injected) {injected=true;throw Object.assign(new Error('Synthetic close failure.'),{code:'EIO'});}
 });
 syncBuiltinESMExports();t.after(()=>{
  t.mock.restoreAll();syncBuiltinESMExports();
  for(const fd of directories)try{close(fd);}catch{/* Retire any descriptor leaked by the deliberate failure. */}
 });
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Replaced before close failure'});
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFReplaced before close failure\n§\n  Second\n');
 assert.equal(result.status,503);assert.equal(result.json.error.code,'agent_memory_uncertain');
 assert.equal(injected,true);
 for(const fd of directories)assert.throws(()=>fsSync.fstatSync(fd),{code:'EBADF'},'every directory descriptor must be retired despite one close failure');
});

for(const field of ['pid','bucket','dirFd','directoryIdentity','revision','temp','tempIdentity','lockIdentity'] as const) {
 test(`prepared ${field} is bound to the captured worker, bucket, descriptor and version`,async t=>{
  const {call,home}=await start(t);const before=(await call<AgentMemory>('GET')).json;
  interceptPrepared(t,message=>{message[field]=({pid:1,bucket:'user',dirFd:-1,directoryIdentity:['0','0','0','0'],revision:'0'.repeat(64),temp:'../config.yaml',tempIdentity:['0','0','0','0','0','0','0'],lockIdentity:['0','0']})[field];});
  const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'});
  assert.notEqual(result.status,200);
  assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n');
  assert.doesNotMatch(JSON.stringify(result.json),/config.yaml|\.relay-memory-|Must not save/);
 });
}
for(const field of ['source','config','directory'] as const) test(`Node rejects ${field} drift after Python prepared the final descriptor`,async t=>{
 const {call,home}=await start(t);const before=(await call<AgentMemory>('GET')).json;
 interceptPrepared(t,()=>{
   if(field==='source')fsSync.writeFileSync(path.join(home,'memories/MEMORY.md'),'External after preparation');
   if(field==='config')fsSync.appendFileSync(path.join(home,'config.yaml'),'# External after preparation\n');
   if(field==='directory'){
     fsSync.renameSync(path.join(home,'memories'),path.join(home,'detached'));
     fsSync.mkdirSync(path.join(home,'memories'));fsSync.writeFileSync(path.join(home,'memories/MEMORY.md'),'External after preparation');
   }
 });
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'});
 assert.equal(result.status,409);assert.equal(result.json.error.code,'agent_memory_conflict');
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),field==='config'?'\uFEFF First \n§\n  Second\n':'External after preparation');
});

test('managed configuration appearing after Python preparation prevents the Node replacement',async t=>{
 const {call,home,managedFile}=await start(t);const before=(await call<AgentMemory>('GET')).json;
 interceptPrepared(t,()=>fsSync.writeFileSync(managedFile,'Managed configuration appeared'));
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Must not save'});
 assert.equal(result.status,409);assert.equal(result.json.error.code,'agent_memory_conflict');
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n');
});

test('missing files are honest, SOUL creation is explicit and context truncation is separate from payload capacity', async t=>{
 const {call,home}=await start(t);
 await fs.unlink(path.join(home,'memories/USER.md'));
 const memory=(await call<AgentMemory>('GET')).json;
 assert.equal(memory.buckets.user.exists,false); assert.equal(memory.buckets.user.writable,false);
 let soul=(await call<AgentSoul>('GET','soul')).json;
 assert.equal(soul.exists,false);assert.equal(soul.content,'');assert.equal(soul.contextLimit,null);
 await assert.rejects(fs.stat(path.join(home,'SOUL.md')),{code:'ENOENT'});
 await fs.writeFile(path.join(home,'config.yaml'),'memory:\n  memory_char_limit: 5\ncontext_file_max_chars: 3\n');
 soul=(await call<AgentSoul>('GET','soul')).json;
 assert.equal(soul.contextLimit,3);
 const saved=await call<AgentSoul>('PUT','soul',{revision:soul.revision,content:'Longer than context'});
 assert.equal(saved.status,200); assert.equal(saved.json.content,'Longer than context');
 const notes=(await call<AgentMemory>('GET')).json;
 assert.equal((await call('PATCH','memory',{bucket:'memory',revision:notes.buckets.memory.revision,noteId:notes.buckets.memory.notes[0].id,content:'Sixsix'})).status,400);
 assert.equal((await call('PATCH','memory',{bucket:'memory',revision:notes.buckets.memory.revision,noteId:notes.buckets.memory.notes[0].id,content:null})).status,200);
});

test('unsafe files and descriptor chains, invalid UTF8 and oversized files fail closed without contents', async t=>{
 const {call,home}=await start(t); const file=path.join(home,'memories/MEMORY.md');
 for(const kind of ['symlink','hardlink','fifo','permissions','utf8','oversize']) {
  await fs.rm(file,{force:true});
  if(kind==='symlink')await fs.symlink('USER.md',file);
  if(kind==='hardlink')await fs.link(path.join(home,'memories/USER.md'),file);
  if(kind==='fifo') { const {realExec}=await import('../src/exec.ts'); await realExec('mkfifo',[file],{timeoutMs:1000}); }
  if(kind==='permissions')await fs.writeFile(file,'Private unsafe text',{mode:0o666});
  if(kind==='permissions')await fs.chmod(file,0o666);
  if(kind==='utf8')await fs.writeFile(file,Buffer.from([0xff]));
  if(kind==='oversize')await fs.writeFile(file,Buffer.alloc(1024*1024+1,65));
  const result=await call('GET');assert.equal(result.status,503,kind);assert.doesNotMatch(JSON.stringify(result.json),/Private unsafe text|Soy Ale/);
 }
 await fs.rm(path.join(home,'memories'),{recursive:true});
 await fs.mkdir(path.join(home,'alternate'));await fs.symlink('alternate',path.join(home,'memories'));
 assert.equal((await call('GET')).status,503);
});

test('unknown configuration is read-only, protocol is required, and arbitrary client paths are rejected', async t=>{
 const {call,home}=await start(t);
 const initial=(await call<AgentMemory>('GET')).json;
 assert.equal((await call('PATCH','memory',{bucket:'../other',revision:initial.buckets.memory.revision,noteId:initial.buckets.memory.notes[0].id,content:'No'})).status,400);
 assert.equal((await call('GET','memory',undefined,{...AUTH,'X-Relay-Protocol':'1'})).status,426);
 await fs.writeFile(path.join(home,'config.yaml'),'memory:\n  memory_char_limit: ${EXTERNAL}\n');
 const memory=(await call<AgentMemory>('GET')).json;
 assert.equal(memory.buckets.memory.limit,null);assert.equal(memory.buckets.memory.writable,false);
 assert.equal((await call('PATCH','memory',{bucket:'memory',revision:memory.buckets.memory.revision,noteId:memory.buckets.memory.notes[0].id,content:null})).status,403);
});

test('Hermes kernel flock excludes Relay writes until the owner releases the same lock', async t=>{
 const {call,home}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const {execExchange}=await import('../src/exec.ts');
 let ready!:()=>void, release!:()=>void;
 const acquired=new Promise<void>(resolve=>{ready=resolve;});
 const held=new Promise<void>(resolve=>{release=resolve;});
 const lock=execExchange('python3',['-I','-c',`import sys,json,fcntl
r=json.loads(sys.stdin.readline())
f=open(r['file'],'a')
fcntl.flock(f,fcntl.LOCK_EX)
print(json.dumps({'phase':'retain','snapshot':{}}),flush=True)
sys.stdin.readline()
f.close()
print('{}',flush=True)
`],{file:path.join(home,'memories/MEMORY.md.lock')},async()=>{ready();await held;return {};});
 try {
  await acquired;
  const request={bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'After lock'};
  const busy=await call('PATCH','memory',request);
  assert.equal(busy.status,409); assert.equal(busy.json.error.code,'agent_memory_busy');
  release(); await lock;
  assert.equal((await call('PATCH','memory',request)).status,200);
 } finally { release();await lock; }
});

test('retention/audit failure never replaces a profile and a renamed directory is a conflict', async t=>{
 const {call,home,store}=await start(t);
 const original=await fs.readFile(path.join(home,'memories/MEMORY.md'));
 const before=(await call<AgentMemory>('GET')).json;
 const request={bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Private forbidden replacement'};
 const append=store.changeLog.appendCommitted.bind(store.changeLog);
 store.changeLog.appendCommitted=async()=>{throw new Error('PRIVATE AUDIT ERROR');};
 const failed=await call('PATCH','memory',request);
 assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed.json),/PRIVATE AUDIT ERROR/);
 assert.deepEqual(await fs.readFile(path.join(home,'memories/MEMORY.md')),original);
 store.changeLog.appendCommitted=async record=>{
  const saved=await append(record);
  await fs.rename(path.join(home,'memories'),path.join(home,'previous-memories'));
  await fs.mkdir(path.join(home,'memories'));await fs.writeFile(path.join(home,'memories/MEMORY.md'),'Current directory content');
  return saved;
 };
 assert.equal((await call('PATCH','memory',request)).status,409);
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'Current directory content');
 assert.deepEqual(await fs.readFile(path.join(home,'previous-memories/MEMORY.md')),original);
});

test('profile directory ownership, configured quota drift, lock hardlinks and payload escape fail closed', async t=>{
 const {call,home,store,hermes}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 const request={bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Private replacement'};
 await fs.chmod(path.join(home,'memories'),0o777);assert.equal((await call('GET')).status,503);await fs.chmod(path.join(home,'memories'),0o755);
 await fs.link(path.join(home,'memories/USER.md'),path.join(home,'memories/MEMORY.md.lock'));
 assert.equal((await call('PATCH','memory',request)).status,503);await fs.unlink(path.join(home,'memories/MEMORY.md.lock'));
 const append=store.changeLog.appendCommitted.bind(store.changeLog);
 store.changeLog.appendCommitted=async record=>{const saved=await append(record);await fs.writeFile(path.join(home,'config.yaml'),'memory:\n  memory_char_limit: 1\n');return saved;};
 const fresh=(await call<AgentMemory>('GET')).json;
 assert.equal((await call('PATCH','memory',{...request,revision:fresh.buckets.memory.revision,noteId:fresh.buckets.memory.notes[0].id})).status,409);
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n');
 hermes.profilesList.push({id:'../escape',name:'unsafe fixture',model:'fixture',provider:'fixture'});
 assert.equal((await call('GET','soul',undefined,AUTH,'../escape')).status,503);
 const soul=(await call<AgentSoul>('GET','soul')).json;
 assert.equal((await call('PUT','soul',{revision:soul.revision,content:'\uD800'})).status,400);
 assert.equal((await call('PUT','soul',{revision:soul.revision,content:'A'.repeat(1024*1024+1)})).status,400);
});

test('a failed completion audit after atomic replacement is uncertain and never exposes its error contents', async t=>{
 const {call,home,store}=await start(t);
 const before=(await call<AgentMemory>('GET')).json;
 store.changeLog.appendChange=async()=>{throw new Error('PRIVATE COMPLETION FAILURE');};
 const result=await call('PATCH','memory',{bucket:'memory',revision:before.buckets.memory.revision,noteId:before.buckets.memory.notes[0].id,content:'Saved content'});
 assert.equal(result.status,503);assert.equal(result.json.error.code,'agent_memory_uncertain');assert.doesNotMatch(JSON.stringify(result.json),/PRIVATE COMPLETION FAILURE/);
 assert.equal(await fs.readFile(path.join(home,'memories/MEMORY.md'),'utf8'),'\uFEFFSaved content\n§\n  Second\n');
});

test('managed or externally resolved configuration never claims writable memory or effective quotas over HTTP', async t=>{
 for(const env of [{HERMES_IGNORE_USER_CONFIG:'1'},{HERMES_MANAGED_DIR:'synthetic-external'}]) {
  const {call}=await start(t,{env});
  const view=(await call<AgentMemory>('GET')).json;
  assert.equal(view.buckets.memory.writable,false);assert.equal(view.buckets.memory.limit,null);
  assert.equal((await call<AgentSoul>('GET','soul')).json.contextLimit,null);
 }
 const {call,managedFile}=await start(t);await fs.mkdir(managedFile);
 assert.equal((await call<AgentMemory>('GET')).json.buckets.user.writable,false);
});

test('opaque note identity is scoped to the selected Agente even when files have identical contents',async t=>{
 const {call,home,hermes}=await start(t);
 const other=path.join(home,'profiles/other');await fs.mkdir(other,{recursive:true});await fs.mkdir(path.join(other,'memories'));
 for(const file of ['config.yaml','memories/MEMORY.md','memories/USER.md'])await fs.copyFile(path.join(home,file),path.join(other,file));
 hermes.profilesList.push({id:'other',name:'Other',model:'fixture',provider:'fixture'});
 const first=(await call<AgentMemory>('GET')).json;
 const second=(await call<AgentMemory>('GET','memory',undefined,AUTH,'other')).json;
 const result=await call('PATCH','memory',{bucket:'memory',revision:second.buckets.memory.revision,noteId:first.buckets.memory.notes[0].id,content:'Wrong Agente'},AUTH,'other');
 assert.equal(result.status,409);assert.equal(await fs.readFile(path.join(other,'memories/MEMORY.md'),'utf8'),'\uFEFF First \n§\n  Second\n');
});
