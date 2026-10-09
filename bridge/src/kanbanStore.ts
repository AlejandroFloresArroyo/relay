import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { KanbanItem, KanbanComment, KanbanItemMutationResult, KanbanCommentMutationResult, KanbanNotifyReceipt } from '../../protocol/kanban.ts';
import * as p from '../../protocol/kanban.ts';
import { exactObject, isUuid, makeChangeRecord, validateChangeRecord, type ChangeLog, type ChangeInput, type ChangeRecord } from './changeLog.ts';
import { AuthorizationError } from './auth.ts';
import { HermesError } from './hermes.ts';
import { KanbanError, unavailable, revision, requestId, timestamp, author, text, validItem, validNotification, graph } from './kanbanValidation.ts';
export interface StoredReceipt {
  deviceId: string; requestId: string; fingerprint: string; itemId: string;
  kind: 'create' | 'update' | 'comment' | 'notify';
  result: KanbanItemMutationResult | KanbanCommentMutationResult | KanbanNotifyReceipt;
}
export interface KanbanData { nextNumber: number; items: KanbanItem[]; comments: { itemId: string; comment: KanbanComment }[]; receipts: StoredReceipt[]; auditOutbox: ChangeRecord[] }
interface State { schemaVersion: 1; data: KanbanData; previous: KanbanData | null }
export type KanbanIO = Pick<typeof fs, 'open' | 'lstat' | 'rename' | 'unlink'>;
export interface KanbanStore {
  snapshot(): KanbanData;
  read(guard: () => void): Promise<KanbanData>;
  mutate<T>(fn: (draft: KanbanData, audit: (input: ChangeInput) => void) => T, guard: () => void): Promise<T>;
}
function validateData(v: unknown): asserts v is KanbanData {
  if (!exactObject(v,['nextNumber','items','comments','receipts','auditOutbox']) || !Array.isArray(v.items) || v.items.length > p.KANBAN_MAX_ITEMS
    || !Array.isArray(v.comments) || v.comments.length > p.KANBAN_MAX_COMMENTS || !Array.isArray(v.receipts) || v.receipts.length > p.KANBAN_MAX_RECEIPTS
    || !Array.isArray(v.auditOutbox) || v.auditOutbox.length > p.KANBAN_MAX_RECEIPTS || !Number.isSafeInteger(v.nextNumber) || Number(v.nextNumber) < 1) throw unavailable();
  const items = v.items as KanbanItem[], ids = new Set<string>(), numbers = new Set<number>();
  for (const item of items) { if (!validItem(item) || ids.has(item.id) || numbers.has(item.number) || item.number >= Number(v.nextNumber)) throw unavailable(); ids.add(item.id); numbers.add(item.number); }
  try { graph(items); } catch { throw unavailable(); }
  const commentIds = new Set<string>(), counts = new Map<string, number>(), commentValues = new Map<string, string>();
  for (const row of v.comments) {
    if (!exactObject(row,['itemId','comment']) || !ids.has(String(row.itemId)) || !exactObject(row.comment,['id','number','author','text','createdAt'])) throw unavailable();
    const c = row.comment;
    const n = (counts.get(String(row.itemId)) ?? 0) + 1;
    if (!isUuid(c.id) || commentIds.has(c.id) || c.number !== n || !author(c.author) || !text(c.text,p.KANBAN_COMMENT_MAX_BYTES) || !timestamp(c.createdAt)) throw unavailable();
    commentIds.add(c.id); counts.set(String(row.itemId),n); commentValues.set(JSON.stringify([row.itemId,c.id]),JSON.stringify(c));
  }
  for (const item of items) if ((counts.get(item.id) ?? 0) !== item.commentCount) throw unavailable();
  const receiptKeys = new Set<string>();
  for (const r of v.receipts) {
    if (!exactObject(r,['deviceId','requestId','fingerprint','itemId','kind','result']) || !isUuid(r.deviceId) || !requestId(r.requestId) || !revision(r.fingerprint)
      || !ids.has(String(r.itemId)) || !['create','update','comment','notify'].includes(String(r.kind))) throw unavailable();
    const key = JSON.stringify([r.deviceId,r.requestId]); if (receiptKeys.has(key)) throw unavailable(); receiptKeys.add(key);
    if (r.kind === 'notify') {
      if (!validNotification(r.result) || r.result.requestId !== r.requestId || r.result.itemId !== r.itemId || r.result.requestedBy.id !== r.deviceId) throw unavailable();
    } else {
      if (!exactObject(r.result,['requestId','item'],r.kind === 'comment' ? ['comment'] : []) || r.result.requestId !== r.requestId || !validItem(r.result.item) || r.result.item.id !== r.itemId) throw unavailable();
      const result=r.result;
      if (r.kind === 'comment' && (!exactObject(result.comment,['id','number','author','text','createdAt']) || !isUuid(result.comment.id)
        || commentValues.get(JSON.stringify([r.itemId,result.comment.id])) !== JSON.stringify(result.comment))) throw unavailable();
    }
  }
  const auditIds = new Set<string>();
  for (const a of v.auditOutbox) { validateChangeRecord(a); if (auditIds.has(a.id)) throw unavailable(); auditIds.add(a.id); }
}
const same = (a: BigIntStats,b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const version = (a: BigIntStats,b: BigIntStats) => same(a,b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.mode === b.mode && a.nlink === b.nlink;
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Backups are embedded, so the new data, previous private snapshot and audit outbox share one
// atomic rename. One previous committed mutation is retained; outbox delivery does not rotate it.
interface StoreOptions { directory: string; changeLog: ChangeLog; now?: () => number; io?: KanbanIO }

// The service state root may be a readable checkout. Work itself still requires a private
// directory. Existing private legacy state stays in place; ambiguous/public legacy fails closed.
export async function createKanbanStoreForStateRoot(options: StoreOptions): Promise<KanbanStore> {
  const root = path.resolve(options.directory);
  const pins: { file: string; fd: number; stat: BigIntStats }[] = [];
  try {
    if (process.platform !== 'linux' || root.split('/').length > 64) throw unavailable();
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let file = '/', fd = openSync(file, flags);
    pins.push({ file, fd, stat: fstatSync(fd, { bigint: true }) });
    for (const component of root.split('/').filter(Boolean)) {
      fd = openSync(`/proc/self/fd/${fd}/${component}`, flags); file = path.join(file, component);
      pins.push({ file, fd, stat: fstatSync(fd, { bigint: true }) });
    }
    const parent = pins.at(-1)!;
    if (parent.stat.uid !== BigInt(process.getuid!()) || (parent.stat.mode & 0o022n) !== 0n) throw unavailable();
    const anchor = `/proc/self/fd/${fd}`;
    const exists = (name: string) => {
      try { lstatSync(`${anchor}/${name}`); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    const legacy = ['kanban.json', 'kanban.initialized', 'kanban.lock'].some(exists);
    const child = exists('kanban');
    if (legacy && (child || (parent.stat.mode & 0o077n) !== 0n)) throw unavailable();
    // Retain existing private legacy state; new stores always use their own directory.
    if (!legacy) {
      if (!child) mkdirSync(`${anchor}/kanban`, { mode: 0o700 });
      fd = openSync(`${anchor}/kanban`, flags); file = path.join(root, 'kanban');
      const stat = fstatSync(fd, { bigint: true }); pins.push({ file, fd, stat });
      if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n) throw unavailable();
    }
    for (const pin of pins) {
      const entry = lstatSync(pin.file, { bigint: true });
      if (!same(pin.stat, entry) || !entry.isDirectory() || entry.mode !== pin.stat.mode) throw unavailable();
    }
    const ancestors = pins.map(pin => `${pin.stat.dev}:${pin.stat.ino}:${pin.stat.mode}:${pin.stat.uid}`).join('/');
    // Pin selection through asynchronous store initialization; a replacement cannot be adopted.
    return await openKanbanStore({ ...options, directory: file }, ancestors);
  } catch { throw unavailable(); }
  finally { for (const pin of pins.reverse()) closeSync(pin.fd); }
}

export async function createKanbanStore(options: StoreOptions): Promise<KanbanStore> {
  return openKanbanStore(options, null);
}

async function openKanbanStore(options: StoreOptions, expectedAncestors: string | null): Promise<KanbanStore> {
  const directory = path.resolve(options.directory), io = options.io ?? fs, now = options.now ?? Date.now;
  let state: State = { schemaVersion: 1, data: { nextNumber: 1, items: [], comments: [], receipts: [], auditOutbox: [] }, previous: null };
  let identity: BigIntStats | null = null, contentHash: string | null = null, ancestors: string | null = expectedAncestors, fatal = false;
  let recoveryReadOnly=false;
  let markerIdentity: BigIntStats | null=null;
  const markerBytes=Buffer.from('Relay Kanban v1\n');
  let queue = Promise.resolve(); let allowAdopt=true; let replacement: BigIntStats | null=null;
  async function access<T>(guard: () => void, operation: (parent: FileHandle, check: () => Promise<void>) => Promise<T>): Promise<T> {
    const handles: FileHandle[] = [], pins: { file: string; handle: FileHandle; stat: BigIntStats }[] = [];
    const wait = async <V>(op: Promise<V>): Promise<V> => { const result = await op; guard(); return result; };
    const open = async (file: string, flags: number) => { const handle = await io.open(file,flags); handles.push(handle); guard(); return handle; };
    try {
      guard(); if (process.platform !== 'linux' || directory.split('/').length > 64) throw unavailable();
      let file = '/', handle = await open(file,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      pins.push({ file,handle,stat: await wait(handle.stat({ bigint: true })) });
      for (const component of directory.split('/').filter(Boolean)) {
        file = path.join(file,component); handle = await open(`/proc/self/fd/${handle.fd}/${component}`,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        pins.push({file,handle,stat:await wait(handle.stat({bigint:true}))});
      }
      const parent = pins.at(-1)!;
      if (parent.stat.uid !== BigInt(process.getuid!()) || (parent.stat.mode & 0o077n) !== 0n) throw unavailable();
      const chain = pins.map(pin => `${pin.stat.dev}:${pin.stat.ino}:${pin.stat.mode}:${pin.stat.uid}`).join('/');
      if (ancestors !== null && ancestors !== chain) throw unavailable();
      const check = async () => {
        for (const pin of pins) {
          const entry = await wait(io.lstat(pin.file,{bigint:true}));
          if (!same(pin.stat,entry) || !entry.isDirectory() || entry.mode !== pin.stat.mode) throw unavailable();
        }
      };
      const result = await operation(handle,check); await check(); ancestors = chain; guard(); return result;
    } finally { for (const handle of handles.reverse()) await handle.close().catch(() => {}); }
  }
  // Cooperating stores/processes contend on the same private directory entry. Never steal a
  // lease, infer a dead owner, or unlink an entry whose inode/version is no longer ours.
  async function exclusive<T>(guard: () => void, operation: () => Promise<T>): Promise<T> {
    return access(guard,async(parent,check)=>{
      const file=`/proc/self/fd/${parent.fd}/kanban.lock`;
      let lease: FileHandle;
      try { lease=await io.open(file,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600); }
      catch { guard(); throw unavailable(); }
      const owned=fstatSync(lease.fd,{bigint:true});
      try {
        guard();
        if (!owned.isFile() || owned.uid!==BigInt(process.getuid!()) || (owned.mode & 0o7177n)!==0n || owned.nlink!==1n || owned.size!==0n) throw unavailable();
        await check(); guard(); const result=await operation(); guard(); await check(); guard(); return result;
      } finally {
        try {
          // No event-loop turn between the ownership check and release. Arbitrary writers that
          // ignore this lease are outside the cooperative exclusion contract.
          const entry=lstatSync(file,{bigint:true});
          if (!version(owned,entry) || !entry.isFile()) { fatal=true; throw unavailable(); }
          unlinkSync(file);
        } finally { await lease.close(); }
      }
    });
  }
  async function readMarker(parent: FileHandle, guard: () => void): Promise<boolean> {
    const file=`/proc/self/fd/${parent.fd}/kanban.initialized`;
    let handle: FileHandle;
    try { handle=await io.open(file,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch(error) { guard(); if ((error as NodeJS.ErrnoException).code==='ENOENT' && markerIdentity===null) return false; throw unavailable(); }
    try {
      guard(); const stat=await handle.stat({bigint:true}); guard();
      if (!stat.isFile() || stat.uid!==BigInt(process.getuid!()) || (stat.mode & 0o7177n)!==0n || stat.nlink!==1n || stat.size!==BigInt(markerBytes.length)
        || markerIdentity!==null && !version(markerIdentity,stat)) throw unavailable();
      const bytes=Buffer.alloc(markerBytes.length); const chunk=await handle.read(bytes,0,bytes.length,0); guard();
      const held=await handle.stat({bigint:true}); guard(); const entry=await io.lstat(file,{bigint:true}); guard();
      if (chunk.bytesRead!==bytes.length || !bytes.equals(markerBytes) || !version(stat,held) || !version(stat,entry)) throw unavailable();
      markerIdentity=stat; return true;
    } finally { await handle.close(); }
  }
  async function ensureMarker(parent: FileHandle, guard: () => void): Promise<void> {
    if (await readMarker(parent,guard)) { guard(); return; } guard();
    const handle=await io.open(`/proc/self/fd/${parent.fd}/kanban.initialized`,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    try { guard(); await handle.writeFile(markerBytes); guard(); await handle.sync(); guard(); } finally { await handle.close(); }
    guard(); await parent.sync(); guard(); await readMarker(parent,guard); guard();
  }
  async function readCurrent(parent: FileHandle, guard: () => void): Promise<Buffer | null> {
    const initialized=await readMarker(parent,guard); guard();
    let handle: FileHandle;
    try { handle = await io.open(`/proc/self/fd/${parent.fd}/kanban.json`,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { guard(); if ((error as NodeJS.ErrnoException).code === 'ENOENT' && identity === null && !initialized) return null; throw unavailable(); }
    try {
      guard(); const stat = await handle.stat({bigint:true}); guard();
      if (!stat.isFile() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7177n) !== 0n || stat.nlink !== 1n || stat.size > BigInt(p.KANBAN_STATE_MAX_BYTES)
        || identity === null && !allowAdopt || replacement !== null && !same(replacement,stat) || identity !== null && !version(identity,stat)) throw unavailable();
      const bytes = Buffer.alloc(Number(stat.size));
      for (let position=0;position<bytes.length;) { const chunk=await handle.read(bytes,position,Math.min(65536,bytes.length-position),position); guard(); if (!chunk.bytesRead) throw unavailable(); position+=chunk.bytesRead; }
      const held=await handle.stat({bigint:true}); guard(); const entry=await io.lstat(`/proc/self/fd/${parent.fd}/kanban.json`,{bigint:true}); guard();
      if (!version(stat,held) || !version(stat,entry) || contentHash !== null && contentHash !== hash(bytes)) throw unavailable();
      identity=stat; contentHash=hash(bytes); return bytes;
    } finally { await handle.close(); }
  }
  function decode(bytes: Buffer): State {
    const parsed: unknown=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
    if (!exactObject(parsed,['schemaVersion','data','previous']) || parsed.schemaVersion !== 1) throw unavailable();
    validateData(parsed.data); if (parsed.previous !== null) validateData(parsed.previous);
    return parsed as unknown as State;
  }
  async function commit(next: State, guard: () => void): Promise<void> {
    validateData(next.data); if (next.previous !== null) validateData(next.previous);
    const bytes=Buffer.from(JSON.stringify(next)+'\n'); if (bytes.length > p.KANBAN_STATE_MAX_BYTES) throw new KanbanError('kanban_store_full');
    await access(guard,async (parent,check) => {
      await readCurrent(parent,guard); guard();
      const temporary=`/proc/self/fd/${parent.fd}/.kanban.${randomBytes(16).toString('hex')}.tmp`;
      let renamed=false, renameStarted=false; let staged: BigIntStats | null=null;
      try {
        const handle=await io.open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        try { guard(); await handle.writeFile(bytes); guard(); await handle.sync(); guard(); staged=await handle.stat({bigint:true}); guard(); } finally { await handle.close(); }
        guard(); await check(); guard();
        // Revalidate the old entry immediately before replacement, not just before staging.
        await readCurrent(parent,guard); guard(); renameStarted=true;
        await io.rename(temporary,`/proc/self/fd/${parent.fd}/kanban.json`); renamed=true;
        // Publish committed data before a post-rename authorization check can reject the caller.
        state=next; replacement=staged; identity=null; contentHash=hash(bytes); allowAdopt=true;
        guard(); await parent.sync(); guard(); await readCurrent(parent,guard); guard(); allowAdopt=false; replacement=null; await ensureMarker(parent,guard); guard();
      } catch (error) { if (renameStarted) fatal=true; throw error; }
      finally { if (!renamed) await io.unlink(temporary).catch(() => {}); }
    });
  }
  async function drain(guard: () => void): Promise<void> {
    if (!state.data.auditOutbox.length) return;
    for (const record of state.data.auditOutbox) { guard(); await options.changeLog.appendCommitted(record); guard(); }
    const next=structuredClone(state); next.data.auditOutbox=[]; await commit(next,guard); guard();
  }
  const enqueue = <T>(guard: () => void, operation: () => Promise<T>): Promise<T> => {
    const result=queue.then(()=>exclusive(guard,operation)).catch((error: unknown) => {
      if (error instanceof KanbanError || error instanceof AuthorizationError || error instanceof HermesError) throw error;
      throw unavailable();
    }); queue=result.then(()=>{},()=>{}); return result;
  };
  try {
    await exclusive(()=>{},async()=>{
    await access(()=>{},async parent=>{ const bytes=await readCurrent(parent,()=>{}); if (bytes) { state=decode(bytes); await ensureMarker(parent,()=>{}); } }); allowAdopt=false;
    // Recovery only changes private receipts. It never invokes a Conversation or Turn port.
    const interrupted=state.data.receipts.filter(r=>r.kind==='notify' && (r.result as KanbanNotifyReceipt).state==='pending');
    if (interrupted.length) {
      const next=structuredClone(state); next.previous=structuredClone(state.data);
      for (const r of next.data.receipts) if (r.kind==='notify' && (r.result as KanbanNotifyReceipt).state==='pending') {
        const old=r.result as KanbanNotifyReceipt;
        r.result={...old,state:'uncertain',runId:null,errorCode:'kanban_notification_uncertain',updatedAt:Math.max(old.updatedAt,now())};
        next.data.auditOutbox.push(makeChangeRecord({actor:old.requestedBy,action:'kanban.notify.uncertain',target:{kind:'server',id:'local'},details:{itemId:old.itemId,requestId:old.requestId}},now(),randomUUID));
      }
      try { await commit(next,()=>{}); }
      catch(error) {
        if (!(error instanceof KanbanError) || error.code!=='kanban_store_full') throw error;
        // A valid older checkpoint may have no room to rotate its backup during recovery.
        // Preserve those bytes; project pending as uncertain in memory and reject new writes.
        // Stable event identity/time makes this readonly recovery audit replayable on restart.
        next.previous=state.previous;
        next.data.auditOutbox=[...state.data.auditOutbox];
        const lost=new Map(interrupted.map(r=>[JSON.stringify([r.deviceId,r.requestId]),r]));
        for (const r of next.data.receipts) {
          const old=lost.get(JSON.stringify([r.deviceId,r.requestId]));if(!old)continue;
          const receipt=old.result as KanbanNotifyReceipt;
          const digest=createHash('sha256').update(JSON.stringify(['kanban-recovery',r.deviceId,r.requestId,r.fingerprint])).digest('hex');
          const eventId=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
          next.data.auditOutbox.push(makeChangeRecord({actor:receipt.requestedBy,action:'kanban.notify.uncertain',target:{kind:'server',id:'local'},details:{itemId:receipt.itemId,requestId:receipt.requestId}},receipt.updatedAt,()=>eventId));
        }
        for (const record of next.data.auditOutbox) await options.changeLog.appendCommitted(record);
        next.data.auditOutbox=[];state=next;recoveryReadOnly=true;
      }
    }
    await drain(()=>{});
    });
  } catch { throw unavailable(); }
  return {
    snapshot:()=>structuredClone(state.data),
    read:guard=>enqueue(guard,async()=>{ guard(); if (fatal) throw unavailable(); await access(guard,async parent=>{ await readCurrent(parent,guard); }); guard(); await drain(guard); guard(); return structuredClone(state.data); }),
    mutate:(fn,guard)=>enqueue(guard,async()=>{
      guard(); if (fatal) throw unavailable(); await access(guard,async parent=>{ await readCurrent(parent,guard); }); guard(); await drain(guard); guard();
      const draft=structuredClone(state.data); const result=fn(draft,input=>draft.auditOutbox.push(makeChangeRecord(input,now(),randomUUID)));
      guard(); if (JSON.stringify(draft) !== JSON.stringify(state.data)) {
        if (recoveryReadOnly) throw new KanbanError('kanban_store_full');
        const next:State={schemaVersion:1,data:draft,previous:structuredClone(state.data)};
        await commit(next,guard); guard();
        try { await drain(guard); } catch(error) { fatal=true; throw error; }
      }
      guard(); return structuredClone(result);
    }),
  };
}
