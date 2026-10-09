import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
const execute = promisify(execFile);
const names = ['bridge:test','bridge:typecheck','supervisor:test','supervisor:typecheck','mobile:test','mobile:components','mobile:typecheck','mobile:lint','mobile:web-export'];
async function fixture(t: TestContext, failure = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-gate-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const dir of ['scripts','bin','markers','bridge/node_modules','supervisor/node_modules','mobile/node_modules']) await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.copyFile(new URL('../../scripts/gate.sh',import.meta.url),path.join(root,'scripts/gate.sh'));
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const group = path.basename(process.cwd());
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const kind = tool === 'npx' ? 'web-export' : args[0] === 'test' ? 'test' : args[1] === 'test:components' ? 'components' : args[1];
const name = group + ':' + kind;
const dir = process.env.GATE_MARKERS;
fs.writeFileSync(path.join(dir,name),String(process.pid));
const deadline = Date.now() + 10000;
const expected = JSON.parse(process.env.GATE_NAMES);
const timer = setInterval(() => {
  if (process.env.GATE_HOLD === '1') return;
  if (!expected.every(x => fs.existsSync(path.join(dir,x)))) {
    if (Date.now() < deadline) return;
    fs.writeFileSync(path.join(dir,name+'.observed'),String(expected.filter(x => fs.existsSync(path.join(dir,x))).length)); console.log('fixture passed'); clearInterval(timer); return;
  }
  clearInterval(timer); fs.writeFileSync(path.join(dir,name+'.observed'),String(expected.length));
  if(name === process.env.GATE_FAILURE) { console.error('Synthetic compiler failure'); process.exitCode = 7; }
  else console.log('fixture passed');
},10);
`;
  for(const bin of ['npm','npx']) await fs.writeFile(path.join(root,'bin',bin),fake,{mode:0o755});
  const env = {...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,GATE_MARKERS:path.join(root,'markers'),GATE_NAMES:JSON.stringify(names),GATE_FAILURE:failure};
  return {root,env};
}
// A zombie has already exited: only its reaper is late, and that is outside the gate's guarantee.
// SIGKILL is delivered asynchronously, so a killed process may still run briefly after the gate exits;
// these are not our children, so no exit event exists and polling /proc is the only signal.
async function survivors(match:(pid:number,group:number)=>boolean){
  const deadline=Date.now()+5000;
  while(true){
    const live:number[]=[];
    for(const entry of await fs.readdir('/proc')){
      if(!/^\d+$/.test(entry)) continue;
      let stat:string;try{stat=await fs.readFile(`/proc/${entry}/stat`,'utf8');}catch{continue;}
      const [state,,group]=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(state!=='Z'&&state!=='X'&&match(Number(entry),Number(group))) live.push(Number(entry));
    }
    if(!live.length||Date.now()>deadline) return live;
    await sleep(20);
  }
}
test('the gate starts independent checks together and reports every step in a stable order',async t=>{
  const {root,env}=await fixture(t);
  const {stdout,stderr}=await execute('bash',['scripts/gate.sh'],{cwd:root,env,timeout:25000});
  assert.equal(stderr,'');
  const lines=stdout.trim().split('\n');
  assert.equal(lines.length,names.length);
  assert.deepEqual(lines.map(line=>line.trim().split(/\s+/)[1]),names);
  assert.ok(lines.every(line=>line.startsWith('PASS')));
  for (const name of names) assert.equal(await fs.readFile(path.join(root,'markers',name+'.observed'),'utf8'),String(names.length),name);
});
test('a failed independent check remains a gate failure while other checks complete',async t=>{
  const {root,env}=await fixture(t,'mobile:typecheck');
  await assert.rejects(execute('bash',['scripts/gate.sh'],{cwd:root,env,timeout:25000}),error=>{
    const e=error as Error & {code:number;stdout:string};
    assert.equal(e.code,1);assert.match(e.stdout,/FAIL\s+mobile:typecheck/);
    assert.match(e.stdout,/Synthetic compiler failure/);
    assert.match(e.stdout,/PASS\s+mobile:web-export/);
    assert.equal((e.stdout.match(/^PASS/gm)??[]).length,names.length-1);
    return true;
  });
});

test('cancelling the gate stops its checks before removing their temporary directories',async t=>{
  const {root,env}=await fixture(t);
  const temp=path.join(root,'temporary');await fs.mkdir(temp);
  const gate=spawn('bash',['scripts/gate.sh'],{cwd:root,env:{...env,TMPDIR:temp,GATE_HOLD:'1'},stdio:'ignore'});
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>gate.once('exit',(code,signal)=>resolve({code,signal})));
  const children:number[]=[];
  t.after(()=>{gate.kill('SIGKILL');for(const pid of children){try{process.kill(pid,'SIGKILL');}catch{}}});
  const deadline=Date.now()+3000;
  for(const name of names){
    while(true){
      try{children.push(Number(await fs.readFile(path.join(root,'markers',name),'utf8')));break;}
      catch{assert.ok(Date.now()<deadline,'all checks must start before cancellation');await new Promise(resolve=>setTimeout(resolve,10));}
    }
  }
  gate.kill('SIGTERM');
  const result=await exited;
  assert.deepEqual(await survivors(pid=>children.includes(pid)),[],'cancelled check still running');
  assert.equal(result.code,143);
  assert.deepEqual(await fs.readdir(temp),[]);
});

test('cancellation also stops a group before its PID is recorded',async t=>{
  const {root,env}=await fixture(t);
  const temp=path.join(root,'temporary');await fs.mkdir(temp);
  const boundary=path.join(root,'boundary.bash');
  await fs.writeFile(boundary,`set -T
review_gate_parent=$BASHPID
review_signal_boundary() {
  if [[ $BASHPID == "$review_gate_parent" && $BASH_COMMAND == 'pids+=('* ]]; then
    printf '%s\n' "$!" > "$GATE_MARKERS/group"
    trap - DEBUG
    kill -TERM "$BASHPID"
  fi
}
trap review_signal_boundary DEBUG
`);
  const gate=spawn('bash',['scripts/gate.sh'],{cwd:root,env:{...env,TMPDIR:temp,GATE_HOLD:'1',BASH_ENV:boundary},stdio:'ignore'});
  let group=0;
  t.after(()=>{gate.kill('SIGKILL');if(group){try{process.kill(-group,'SIGKILL');}catch{}}});
  const code=await new Promise<number|null>(resolve=>gate.once('exit',resolve));
  group=Number(await fs.readFile(path.join(root,'markers/group'),'utf8'));
  assert.ok(group>0);
  assert.deepEqual(await survivors((_,pgid)=>pgid===group),[],'cancelled group was not recorded yet and remained alive');
  assert.equal(code,143);
  assert.deepEqual(await fs.readdir(temp),[]);
});
