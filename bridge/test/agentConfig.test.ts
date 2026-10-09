import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { realExec } from '../src/exec.ts';
import { AgentConfig } from '../src/agentConfig.ts';

const raw = '# keep comment\nprovider_key: fixture-private-config\napprovals:\n  mode: smart # keep mode comment\n  deny: ["git push --force*", "DROP DATABASE*"]\n  smart_policy: |\n    Escala los cambios de red.\nmodel:\n  default: fixed\n';
async function setup(t: import('node:test').TestContext) {
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'relay-agent-config-')); t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.writeFile(path.join(home,'config.yaml'),raw,{mode:0o600});
 return {home,config:new AgentConfig({home,python:'python3',exec:realExec,managedFile:path.join(home,'no-managed.yaml')})};
}
test('security reads only allowed fields without initializing Hermes, and a leaf write retains bytes before preserving all other config content',async(t)=>{
 const {home,config}=await setup(t); const snapshot=await config.security('default');
 assert.equal(snapshot.security.mode,'smart'); assert.deepEqual(snapshot.security.deny,['git push --force*','DROP DATABASE*']);
 assert.doesNotMatch(JSON.stringify(snapshot.security),/fixture-private-config|provider_key/);
 let retained=false; let guardCalls=0;
 const after=await config.writeSecurity('default',snapshot,'mode','manual',()=>{guardCalls++},async()=>{assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),raw); retained=true});
 assert.ok(retained); assert.ok(guardCalls>=3); assert.equal(after.security.mode,'manual');
 assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),raw.replace('mode: smart','mode: manual')); assert.notEqual(after.revision,snapshot.revision);
 assert.deepEqual((await fs.readdir(home)).sort(),['config.yaml']);
});
test('stale revision, symlinks, unsafe paths, managed and environment values refuse writes without exposing config bytes',async(t)=>{
 const {home,config}=await setup(t); const snapshot=await config.security('default');
 await fs.appendFile(path.join(home,'config.yaml'),'# concurrent\n');
 await assert.rejects(()=>config.writeSecurity('default',snapshot,'mode','off',()=>{},async()=>{}),{code:'agent_security_conflict'});
 await assert.rejects(()=>config.security('../default'),{code:'agent_details_unavailable'});
 await fs.rename(path.join(home,'config.yaml'),path.join(home,'original')); await fs.symlink(path.join(home,'original'),path.join(home,'config.yaml'));
 await assert.rejects(()=>config.security('default'),{code:'agent_details_unavailable'});
 await fs.unlink(path.join(home,'config.yaml')); await fs.writeFile(path.join(home,'config.yaml'),raw.replace('mode: smart','mode: "${APPROVAL_MODE}"'),{mode:0o600});
 const unknown=await config.security('default'); assert.equal(unknown.security.writable,false); assert.equal(unknown.security.mode,null);
 await assert.rejects(()=>config.writeSecurity('default',unknown,'mode','off',()=>{},async()=>{}),{code:'agent_security_read_only'});
 await fs.writeFile(path.join(home,'config.yaml'),raw); await fs.writeFile(path.join(home,'managed.yaml'),'approvals: {mode: manual}');
 const managed=new AgentConfig({home,python:'python3',exec:realExec,managedFile:path.join(home,'managed.yaml')});
 assert.equal((await managed.security('default')).security.writable,false);
});
test('backup failure or authorization revocation before the write leaves the previous version untouched',async(t)=>{
 const {home,config}=await setup(t); const snapshot=await config.security('default');
 await assert.rejects(()=>config.writeSecurity('default',snapshot,'deny',[],()=>{},async()=>{throw new Error('retention unavailable')}));
 assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),raw);
 let revoked=false; await assert.rejects(()=>config.writeSecurity('default',snapshot,'deny',[],()=>{if(revoked)throw new Error('revoked')},async()=>{revoked=true}));
 assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),raw);
});
test('replacing a profile ancestor with an outside symlink while retention awaits creates no outside temporary or config write',async(t)=>{
 const {home,config}=await setup(t);const profiles=path.join(home,'profiles');await fs.mkdir(path.join(profiles,'dev'),{recursive:true,mode:0o700});await fs.writeFile(path.join(profiles,'dev','config.yaml'),raw,{mode:0o600});
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),'relay-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.mkdir(path.join(outside,'dev'),{mode:0o700});await fs.writeFile(path.join(outside,'dev','config.yaml'),raw,{mode:0o600});
 const snapshot=await config.security('dev');let capturedOutside:string[]=[];
 const created:string[]=[];const watcher=watch(path.join(outside,'dev'),(_event,name)=>{if(name)created.push(String(name))});t.after(()=>watcher.close());
 // Inspect at the executor boundary before the later security check can clean up an escaped temporary.
 const guarded=new AgentConfig({home,python:'python3',managedFile:path.join(home,'no-managed.yaml'),exec:async(...args)=>{capturedOutside.push(...await fs.readdir(path.join(outside,'dev')));return realExec(...args)}});
 await assert.rejects(()=>guarded.writeSecurity('dev',snapshot,'mode','off',()=>{},async()=>{await fs.rename(profiles,profiles+'.saved');await fs.symlink(outside,profiles)}));
 await new Promise<void>(r=>setTimeout(r,25));
 assert.deepEqual(created,[]);assert.deepEqual([...new Set(capturedOutside)].sort(),['config.yaml']);
 assert.equal(await fs.readFile(path.join(outside,'dev','config.yaml'),'utf8'),raw);assert.deepEqual(await fs.readdir(path.join(outside,'dev')),['config.yaml']);
});

test('Off is written as a YAML string while preserving unrelated leaves and comment bytes',async(t)=>{
 const {home,config}=await setup(t);const snapshot=await config.security('default');
 let after: Awaited<ReturnType<typeof config.writeSecurity>>|undefined;await assert.doesNotReject(async()=>{after=await config.writeSecurity('default',snapshot,'mode','off',()=>{},async()=>{})});
 assert.equal(after?.security.mode,'off');assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),raw.replace('mode: smart','mode: "off"'));
});

test('an external edit during retention rejects the write and preserves the concurrent version',async(t)=>{
 const {home,config}=await setup(t);const snapshot=await config.security('default');const changed=raw+'# concurrent edit during retention\n';
 await assert.rejects(()=>config.writeSecurity('default',snapshot,'mode','manual',()=>{},async()=>{await fs.writeFile(path.join(home,'config.yaml'),changed)}),{code:'agent_security_conflict'});
 assert.equal(await fs.readFile(path.join(home,'config.yaml'),'utf8'),changed);
});

test('an omitted Guardian policy is explicitly unavailable rather than presenting an empty policy as known',async(t)=>{
 const {home,config}=await setup(t);await fs.writeFile(path.join(home,'config.yaml'),'approvals:\n  mode: smart\n  deny: []\n',{mode:0o600});
 const snapshot=await config.security('default');assert.equal(snapshot.security.guardianPolicy,null);assert.equal(snapshot.security.writable,true);
});

test('a config without approvals.mode shows the mode Hermes itself defaults to, read from its own defaults',async(t)=>{
 const {home,config}=await setup(t);const defaults=path.join(home,'hermes-agent','hermes_cli');await fs.mkdir(defaults,{recursive:true});
 await fs.writeFile(path.join(defaults,'config_defaults.py'),"DEFAULT_CONFIG = {'approvals': {'mode': 'smart', 'deny': []}}\n");
 await fs.writeFile(path.join(home,'config.yaml'),'model:\n  default: fixed\n',{mode:0o600});
 const absent=await config.security('default');assert.equal(absent.security.mode,'smart');assert.equal(absent.security.writable,true);
 await fs.writeFile(path.join(home,'config.yaml'),'approvals:\n  deny: []\n',{mode:0o600});
 assert.equal((await config.security('default')).security.mode,'smart');
 await fs.writeFile(path.join(defaults,'config_defaults.py'),"DEFAULT_CONFIG = {'approvals': {'mode': 'off'}}\n");
 assert.equal((await config.security('default')).security.mode,'off');
});

test('when Hermes defaults cannot be read, an absent approvals.mode is unknown and read-only instead of a guess',async(t)=>{
 const {home,config}=await setup(t);await fs.writeFile(path.join(home,'config.yaml'),'model:\n  default: fixed\n',{mode:0o600});
 const missing=await config.security('default');assert.equal(missing.security.mode,null);assert.equal(missing.security.writable,false);
 await assert.rejects(()=>config.writeSecurity('default',missing,'mode','manual',()=>{},async()=>{}),{code:'agent_security_read_only'});
 const defaults=path.join(home,'hermes-agent','hermes_cli');await fs.mkdir(defaults,{recursive:true});
 await fs.writeFile(path.join(defaults,'config_defaults.py'),"raise RuntimeError('broken')\n");
 assert.equal((await config.security('default')).security.mode,null);
});
