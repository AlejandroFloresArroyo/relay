import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readAgentUsage } from '../src/agentUsage.ts';
import { readServerUsage } from '../src/serverUsage.ts';
import { HermesConversations } from '../src/hermes_conversations.ts';
import { writeStateDb } from '../support/hermes_home.ts';
import { installReaderFault, type ReaderFault } from '../support/sqlite_reader_fault.ts';

const now = Date.parse('2026-10-04T18:00Z');
function fixture(t: TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-reader-security-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),outside=path.join(root,'outside');
  for (const [directory,tokens] of [[home,100],[outside,424242]] as const) {
    writeStateDb(path.join(directory,'state.db'),[{id:'conversation',source:'cli',startedAt:now/1000}],[{session:'conversation',role:'user',content:'Synthetic',at:now/1000}]);
    const db=new DatabaseSync(path.join(directory,'state.db'));
    db.prepare("UPDATE sessions SET input_tokens=?,output_tokens=10,estimated_cost_usd=1,cost_status='estimated'").run(tokens); db.close();
  }
  return {root,home,outside};
}
function faultDuringRead(t: TestContext, fault: ReaderFault) {
  t.after(installReaderFault(fault));
}
function assertRejected(home: string) {
  assert.throws(()=>readAgentUsage(home,now),{code:'agent_details_unavailable'});
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'error');
  assert.throws(()=>new HermesConversations(home).list({}), {code:'chat_unavailable'});
}
for (const mode of ['database','database_copy','ancestor','wal','wal_copy','shm','shm_copy'] as const) {
  test(`all public adapters reject effective ${mode} replacement before any Hermes table read, even after name restoration`, t => {
    const {home,outside,root}=fixture(t); const log=path.join(root,'reads.log');
    const writers: DatabaseSync[]=[];
    if (mode.startsWith('wal') || mode.startsWith('shm')) {
      for (const directory of [home,outside]) {
        const db=new DatabaseSync(path.join(directory,'state.db')); writers.push(db);
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('UPDATE sessions SET input_tokens=input_tokens+1');
      }
      t.after(()=>writers.forEach(db=>db.close()));
    }
    faultDuringRead(t,{home,outside,log,mode});
    assertRejected(home);
    assert.equal(fs.existsSync(log)?fs.readFileSync(log,'utf8'):'','', 'No sessions/messages query may precede effective identity verification');
    assert.equal(fs.readFileSync(`${log}.fault`,'utf8'), `${mode}\n`.repeat(3), 'Every public adapter must reach the injected open boundary');
  });
}

test('all public adapters reject static file, ancestor and sidecar symlinks through the shared boundary', t => {
  const {home,outside}=fixture(t);
  for (const name of ['state.db','state.db-wal','state.db-shm','state.db-journal']) {
    const target=path.join(home,name),held=`${target}.held`;
    if (fs.existsSync(target)) fs.renameSync(target,held);
    fs.symlinkSync(path.join(outside,'state.db'),target);
    assertRejected(home); fs.unlinkSync(target);
    if (fs.existsSync(held)) fs.renameSync(held,target);
  }
  const alias=path.join(home,'alias'); fs.symlinkSync(home,alias);
  assertRejected(alias);
});

test('normal WAL exposes committed snapshots, excludes uncommitted rows and keeps main DB bytes unchanged', t => {
  const {home}=fixture(t); const file=path.join(home,'state.db');
  const writer=new DatabaseSync(file); t.after(()=>writer.close());
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  const before=fs.readFileSync(file);
  writer.exec('UPDATE sessions SET input_tokens=200; BEGIN; UPDATE sessions SET input_tokens=900000');
  assert.equal(readAgentUsage(home,now).today.tokens,210);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').total.tokens,210);
  assert.equal(new HermesConversations(home).list({}).conversations.length,1);
  assert.deepEqual(fs.readFileSync(file),before);
  writer.exec('ROLLBACK; UPDATE sessions SET input_tokens=300');
  assert.equal(readAgentUsage(home,now).today.tokens,310);
});

test('closed WAL without sidecars is read via private auxiliaries without creating original files; absent main keeps DTO semantics', t => {
  const {home}=fixture(t); const file=path.join(home,'state.db');
  const writer=new DatabaseSync(file); writer.exec('PRAGMA journal_mode=WAL'); writer.close();
  assert.deepEqual(fs.readdirSync(home),['state.db']);
  assert.equal(readAgentUsage(home,now).today.tokens,110);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').total.tokens,110);
  assert.equal(new HermesConversations(home).list({}).conversations.length,1);
  assert.deepEqual(fs.readdirSync(home),['state.db'], 'Original profiles must not acquire WAL/SHM');
  fs.unlinkSync(file);
  assert.equal(readAgentUsage(home,now).today.tokens,0);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').agents[0].status,'unavailable');
  assert.equal(new HermesConversations(home).list({}).conversations.length,0);
  assert.deepEqual(fs.readdirSync(home),[]);
});

test('corruption and excessive sidecars are opaque failures through each public adapter', t => {
  const {home}=fixture(t);
  fs.writeFileSync(path.join(home,'state.db-shm'),'');
  fs.truncateSync(path.join(home,'state.db-shm'),512*1024*1024+1);
  assertRejected(home); fs.unlinkSync(path.join(home,'state.db-shm'));
  fs.writeFileSync(path.join(home,'state.db'),'synthetic corrupt store');
  assertRejected(home);
  assert.throws(()=>new HermesConversations(home).list({}), error => {
    assert.equal((error as Error).message,'The Hermes conversation store is unavailable.'); return true;
  });
});

test('a symlink in a profile ancestor is rejected before any SQLite table read', t => {
  const {home,root}=fixture(t), alias=path.join(root,'alias');
  fs.symlinkSync(home,alias); assertRejected(alias);
});

test('a valid WAL main DB with a hardlinked hostile SHM never changes the linked target bytes', t => {
  const {home,root}=fixture(t), file=path.join(home,'state.db');
  const writer=new DatabaseSync(file); writer.exec('PRAGMA journal_mode=WAL'); writer.close();
  fs.writeFileSync(`${file}-wal`,Buffer.alloc(0));
  const target=path.join(root,'synthetic-target'),before=Buffer.alloc(65536,0xa5);
  fs.writeFileSync(target,before); fs.linkSync(target,`${file}-shm`);
  for (const read of [()=>readAgentUsage(home,now),()=>readServerUsage(home,[{id:'default',name:'Default'}],now,'day'),()=>new HermesConversations(home).list({})]) {
    let result: unknown,error: unknown; try { result=read(); } catch (failure) {error=failure;}
    assert.deepEqual(fs.readFileSync(target),before,'No SQLite initialization may truncate or reinitialize an original SHM hardlink target');
    assert.ok(error || (result as ReturnType<typeof readServerUsage>).agents?.[0].status==='error','Unsafe hardlink must be rejected');
  }
});

test('a SHM hardlink swapped just before SQLite opens cannot modify the original target', t => {
  const {home,outside,root}=fixture(t),file=path.join(home,'state.db'),log=path.join(root,'reads.log');
  const writer=new DatabaseSync(file);
  writer.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens=200');
  // Preserve a valid committed WAL fixture without a same-process SQLite mapping cache.
  const snapshot=['', '-wal', '-shm'].map(suffix=>[suffix,fs.readFileSync(`${file}${suffix}`)] as const);
  writer.close(); for (const [suffix,bytes] of snapshot) fs.writeFileSync(`${file}${suffix}`,bytes);
  const target=path.join(outside,'state.db-shm'),before=Buffer.from(snapshot.find(([suffix])=>suffix==='-shm')![1]);
  fs.writeFileSync(target,before); faultDuringRead(t,{home,outside,log,mode:'shm_open_hardlink'});
  assert.equal(readAgentUsage(home,now).today.tokens,210);
  assert.deepEqual(fs.readFileSync(target),before,'SQLite must initialize only its private SHM, never the swapped original target');
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').total.tokens,210);
  assert.deepEqual(fs.readFileSync(target),before);
  assert.equal(new HermesConversations(home).list({}).conversations.length,1);
  assert.deepEqual(fs.readFileSync(target),before);
  assert.equal(fs.readFileSync(`${log}.fault`,'utf8'),'shm_open_hardlink\n'.repeat(3));
});

for (const suffix of ['', '-wal']) {
  test(`source ${suffix || 'main'} writes during chunk copying reject the whole snapshot`, t => {
    const {home}=fixture(t),file=path.join(home,`state.db${suffix}`);
    let writer: DatabaseSync | undefined;
    if (suffix) {
      writer=new DatabaseSync(path.join(home,'state.db')); writer.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens=200');
      t.after(()=>writer!.close());
    }
    const read=fs.readSync;
    t.mock.method(fs,'readSync',((fd: number,buffer: NodeJS.ArrayBufferView,...args: unknown[]) => {
      const result=Reflect.apply(read,fs,[fd,buffer,...args]);
      if (args[2] === 0 && fs.realpathSync(`/proc/self/fd/${fd}`)===file) {
        // Change metadata without changing contents: a partial copy cannot silently pass.
        const original=fs.readFileSync(file),write=fs.openSync(file,'r+');
        try {fs.writeSync(write,original,0,1,0);} finally {fs.closeSync(write);}
      }
      return result;
    }) as typeof fs.readSync);
    assertRejected(home);
  });
}

test('SQLite receives only private 0700 directories with 0600 files and every copy is removed', t => {
  const {home}=fixture(t),create=fs.mkdtempSync,privateHomes: string[]=[];
  t.mock.method(fs,'mkdtempSync',((prefix: string) => {
    const directory=create(prefix); privateHomes.push(directory);
    assert.equal(fs.statSync(directory).mode & 0o777,0o700); return directory;
  }) as typeof fs.mkdtempSync);
  const Original=sqlite.DatabaseSync;
  sqlite.DatabaseSync=class extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      const file=fileURLToPath(String(args[0])),directory=path.dirname(file);
      assert.ok(privateHomes.includes(directory),'SQLite can only open a recorded private directory');
      assert.notEqual(directory,home); assert.equal(fs.statSync(file).mode & 0o777,0o600);
      super(...args);
    }
  }; t.after(()=>{sqlite.DatabaseSync=Original;});
  const writer=new DatabaseSync(path.join(home,'state.db')); writer.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens=200');
  t.after(()=>writer.close());
  assert.equal(readAgentUsage(home,now).today.tokens,210);
  assert.equal(readServerUsage(home,[{id:'default',name:'Default'}],now,'day').total.tokens,210);
  assert.equal(new HermesConversations(home).list({}).conversations.length,1);
  assert.equal(privateHomes.length,3);
  assert.ok(privateHomes.every(directory=>directory!==home && !fs.existsSync(directory)));
});

test('a sidecar appearing during the copy invalidates the snapshot', t => {
  const {home}=fixture(t),file=path.join(home,'state.db'),read=fs.readSync;
  t.mock.method(fs,'readSync',((fd: number,buffer: NodeJS.ArrayBufferView,...args: unknown[]) => {
    const result=Reflect.apply(read,fs,[fd,buffer,...args]);
    if (args[2] === 0 && fs.realpathSync(`/proc/self/fd/${fd}`)===file) fs.writeFileSync(`${file}-wal`,Buffer.alloc(0));
    return result;
  }) as typeof fs.readSync);
  assert.throws(()=>readAgentUsage(home,now),{code:'agent_details_unavailable'});
});

test('message payload projection is bounded independently of row count and source file limit', t => {
  const {home}=fixture(t); fs.unlinkSync(path.join(home,'state.db'));
  writeStateDb(path.join(home,'state.db'),[{id:'large',source:'cli',startedAt:now/1000}],
    Array.from({length:20},(_,i)=>({session:'large',role:'user',content:'x'.repeat(800000),at:now/1000+i})));
  assert.throws(()=>new HermesConversations(home).list({}),{code:'chat_unavailable'});
});

for (const extra of ['system_prompt', 'reasoning'] as const) {
  test(`conversation and decision projections ignore unused ${extra} payloads without relaxing the byte budget`, t => {
    const {home}=fixture(t), file=path.join(home,'state.db');
    fs.unlinkSync(file);
    const sessions=Array.from({length:16},(_,i)=>({id:`history-${i}`,source:'cli',startedAt:now/1000+i}));
    writeStateDb(file,sessions,sessions.map(session=>({session:session.id,role:'user',content:'Visible text',at:session.startedAt+0.5})));
    const db=new DatabaseSync(file);
    try {db.prepare(`UPDATE ${extra === 'system_prompt' ? 'sessions' : 'messages'} SET ${extra}=?`).run('x'.repeat(800000));}
    finally {db.close();}
    const reader=new HermesConversations(home);
    assert.equal(reader.list({}).conversations.length,16);
    assert.deepEqual(reader.transcript('history-0').items.map(item=>'text' in item?item.text:null),['Visible text']);
    assert.deepEqual(reader.decisionHistory('default'),[]);
  });
}

test('one conversation and imported decisions stay readable when unrelated tool output exceeds the profile display budget', t => {
  const {home}=fixture(t),file=path.join(home,'state.db');fs.unlinkSync(file);
  const sessions=Array.from({length:16},(_,i)=>({id:`tools-${i}`,source:'cli',startedAt:now/1000+i}));
  writeStateDb(file,sessions,sessions.flatMap(session=>[
    {session:session.id,role:'user',content:'Visible request',at:session.startedAt},
    {session:session.id,role:'assistant',content:'',at:session.startedAt+0.1,toolCalls:[{id:'call',name:'terminal',args:{command:'true'}}]},
    {session:session.id,role:'tool',toolName:'terminal',toolCallId:'call',content:JSON.stringify({exit_code:0,output:'x'.repeat(800000),approval:'Command required approval (test) and was approved by the user.'}),at:session.startedAt+0.2}
  ]));
  const reader=new HermesConversations(home);
  assert.equal(reader.list({}).conversations.length,16);
  assert.equal(reader.transcript('tools-0').sessionId,'tools-0');
  const decisions=reader.decisionHistory('default');
  assert.equal(decisions.length,16);
  assert.ok(decisions.every(record=>record.command==='true' && record.actor==='person' && record.outcome==='approved'));
});

test('private fields excluded from display still invalidate a deletion confirmation', t => {
  const {home}=fixture(t),reader=new HermesConversations(home),file=path.join(home,'state.db');
  const original=reader.deletionPreview('conversation');
  const db=new DatabaseSync(file);
  try {db.prepare('UPDATE sessions SET system_prompt=?').run('Private context changed');}
  finally {db.close();}
  const contextChanged=reader.deletionPreview('conversation');
  assert.notEqual(contextChanged.revision,original.revision);
  assert.ok(contextChanged.sessionRevisions && original.sessionRevisions);
  assert.notEqual(contextChanged.sessionRevisions.conversation,original.sessionRevisions.conversation);
  const next=new DatabaseSync(file);
  try {next.prepare('UPDATE messages SET reasoning=?').run('Private reasoning changed');}
  finally {next.close();}
  assert.notEqual(reader.deletionPreview('conversation').revision,contextChanged.revision);
  assert.deepEqual(reader.transcript('conversation').items.map(item=>'text' in item?item.text:null),['Synthetic']);
});

test('decision projection retains distinct tool-result identities when only their unused output differs', t => {
  const {home}=fixture(t),file=path.join(home,'state.db');fs.unlinkSync(file);
  writeStateDb(file,[{id:'identity',source:'cli',startedAt:now/1000}],[
    {session:'identity',role:'assistant',content:'',at:now/1000,toolCalls:[{id:'call',name:'terminal',args:{command:'true'}}]},
    ...['first','second'].map(output=>({session:'identity',role:'tool',toolName:'terminal',toolCallId:'call',content:JSON.stringify({exit_code:0,output}),at:now/1000+1}))
  ]);
  const records=new HermesConversations(home).decisionHistory('default');
  assert.equal(records.length,2);assert.notEqual(records[0].id,records[1].id);
});
