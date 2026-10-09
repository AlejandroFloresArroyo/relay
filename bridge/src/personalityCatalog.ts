import fs, { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PersonalityPresetCatalog, PersonalityPresetVersion, PersonalityPresetSummary, DeletedPersonalityPreset, PersonalityPresetKind, PersonalityErrorCode } from '../../protocol/personalityPresets.ts';
import { PERSONALITY_MESSAGES, PERSONALITY_CATALOG_MAX_BYTES, PERSONALITY_PRESET_MAX_COUNT, PERSONALITY_SOUL_MAX_BYTES, PERSONALITY_OVERLAY_MAX_BYTES } from '../../protocol/personalityPresets.ts';
import { exactObject, isUuid, isTimestamp, makeChangeRecord, validateChangeRecord } from './changeLog.ts';
import type { ChangeLog, ChangeRecord } from './changeLog.ts';

export class PersonalityError extends Error {
  readonly code:PersonalityErrorCode;
  constructor(code:PersonalityErrorCode) { super(PERSONALITY_MESSAGES[code]); this.code=code; }
}
export interface PersonalityActor { kind:'device'; id:string; name:string }
interface Entry { id:string; deleted:boolean; versions:PersonalityPresetVersion[] }
interface Receipt { deviceId:string; requestId:string; fingerprint:string; result:{kind:'preset'|'deleted';id:string;revision:string}; audit:ChangeRecord }
interface State { schemaVersion:1; presets:Entry[]; receipts:Receipt[] }
interface Snapshot { state:State; bytes:Buffer|null; identity:string[]|null }
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validString=(value:unknown,limit:number):value is string=>typeof value==='string'&&Buffer.byteLength(value)<=limit&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const nameValid=(value:unknown):value is string=>validString(value,400)&&value.trim()===value&&Array.from(value).length>0&&Array.from(value).length<=100&&!/[\x00-\x1f\x7f]/.test(value);
const contentLimit=(kind:PersonalityPresetKind)=>kind==='soul'?PERSONALITY_SOUL_MAX_BYTES:PERSONALITY_OVERLAY_MAX_BYTES;
const summary=({content:_content,...value}:PersonalityPresetVersion):PersonalityPresetSummary=>value;
const versionHash=(v:Omit<PersonalityPresetVersion,'revision'>,previous:string|null)=>hash([v.id,v.kind,v.name,v.content,v.createdAt,v.updatedAt,previous]);
function fail(code:PersonalityErrorCode='personality_unavailable'):never { throw new PersonalityError(code); }
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
function validate(state:unknown):asserts state is State {
  if(!exactObject(state,['schemaVersion','presets','receipts'])||state.schemaVersion!==1||!Array.isArray(state.presets)||!Array.isArray(state.receipts))fail();
  const ids=new Set<string>();let active=0;
  for(const entry of state.presets) {
    if(!exactObject(entry,['id','deleted','versions'])||!isUuid(entry.id)||ids.has(entry.id)||typeof entry.deleted!=='boolean'||!Array.isArray(entry.versions)||!entry.versions.length)fail();
    ids.add(entry.id);if(!entry.deleted)active++;
    let previous:string|null=null,kind:unknown,created:unknown;
    for(const v of entry.versions) {
      if(!exactObject(v,['id','revision','name','kind','bytes','createdAt','updatedAt','content'])||v.id!==entry.id||!['soul','overlay'].includes(String(v.kind))||!nameValid(v.name)||!validString(v.content,contentLimit(v.kind as PersonalityPresetKind))||v.bytes!==Buffer.byteLength(v.content)||!isTimestamp(v.createdAt)||!isTimestamp(v.updatedAt)||v.updatedAt<v.createdAt||!revision(v.revision))fail();
      if(previous&&(v.kind!==kind||v.createdAt!==created))fail();
      const {revision:actual,...rest}=v; if(versionHash(rest as unknown as Omit<PersonalityPresetVersion,'revision'>,previous)!==actual)fail();
      previous=v.revision;kind=v.kind;created=v.createdAt;
    }
  }
  if(active>PERSONALITY_PRESET_MAX_COUNT)fail();
  const requests=new Set<string>();
  for(const r of state.receipts) {
    if(!exactObject(r,['deviceId','requestId','fingerprint','result','audit'])||!isUuid(r.deviceId)||!isUuid(r.requestId)||!revision(r.fingerprint)||!exactObject(r.result,['kind','id','revision'])||!['preset','deleted'].includes(String(r.result.kind))||!isUuid(r.result.id)||!revision(r.result.revision))fail();
    const result=r.result;
    const entry=(state.presets as Entry[]).find(e=>e.id===result.id);
    if(!entry?.versions.some(v=>v.revision===result.revision))fail();
    const key=JSON.stringify([r.deviceId,r.requestId]);if(requests.has(key))fail();requests.add(key);
    try { validateChangeRecord(r.audit); } catch { fail(); }
  }
}
export function openPersonalityDirectory(directory:string):number {
  let fd=fs.openSync('/',constants.O_RDONLY|constants.O_DIRECTORY);
  try {
    for(const segment of path.resolve(directory).split('/').filter(Boolean)) {
      const next=fs.openSync(`/proc/self/fd/${fd}/${segment}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const previous=fd;fd=next;fs.closeSync(previous);
    }
    const stat=fs.fstatSync(fd);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||stat.mode&0o022)fail();
    return fd;
  } catch(error) { try{fs.closeSync(fd);}catch{/* Cleanup must not mask the original directory failure. */}if(error instanceof PersonalityError)throw error;return fail(); }
}
function fileIdentity(stat:fs.BigIntStats) {return [stat.dev,stat.ino,stat.mode,stat.uid,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);}
function read(fd:number):Snapshot {
  let file:number;
  try {file=fs.openSync(`/proc/self/fd/${fd}/personality-presets.json`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:{schemaVersion:1,presets:[],receipts:[]},bytes:null,identity:null};throw error;}
  try {
    const before=fs.fstatSync(file,{bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||before.mode&0o7177n||before.size>BigInt(PERSONALITY_CATALOG_MAX_BYTES))fail();
    const chunks:Buffer[]=[];let length=0;
    while(length<=PERSONALITY_CATALOG_MAX_BYTES) {
      const buffer=Buffer.alloc(Math.min(65536,PERSONALITY_CATALOG_MAX_BYTES+1-length));const count=fs.readSync(file,buffer,0,buffer.length,null);
      if(!count)break;chunks.push(buffer.subarray(0,count));length+=count;
    }
    const after=fs.fstatSync(file,{bigint:true});if(length>PERSONALITY_CATALOG_MAX_BYTES||hash(fileIdentity(before))!==hash(fileIdentity(after)))fail();
    const bytes=Buffer.concat(chunks,length);const state:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));validate(state);
    return {state,bytes,identity:fileIdentity(after)};
  } finally {fs.closeSync(file);}
}
export function privatePersonalityWrite(anchor:string,name:string,bytes:Buffer) {
  const fd=fs.openSync(`${anchor}/${name}`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);return fileIdentity(fs.fstatSync(fd,{bigint:true}));}finally{fs.closeSync(fd);}
}
export function verifyPrivatePersonalityFile(file:string,expected:string[],bytes:Buffer):void {
  let fd:number;
  try {fd=fs.openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch {fail('personality_conflict');}
  try {
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||before.mode&0o7177n||before.size!==BigInt(bytes.length)||hash(fileIdentity(before))!==hash(expected))fail('personality_conflict');
    const buffer=Buffer.alloc(bytes.length+1);let length=0;
    while(length<buffer.length){const count=fs.readSync(fd,buffer,length,buffer.length-length,null);if(!count)break;length+=count;}
    if(length!==bytes.length||!buffer.subarray(0,length).equals(bytes)||hash(fileIdentity(fs.fstatSync(fd,{bigint:true})))!==hash(expected))fail('personality_conflict');
  } finally {fs.closeSync(fd);}
}
export class PersonalityCatalog {
  private readonly directory:string;private readonly now:()=>number;private readonly audit:ChangeLog;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(directory:string,audit:ChangeLog,now:()=>number=Date.now) {this.directory=path.resolve(directory);this.audit=audit;this.now=now;}
  private async load<T>(operation:(snapshot:Snapshot,fd:number)=>Promise<T>,effect?:()=>boolean):Promise<T> {
    let fd:number|undefined;
    try {fd=openPersonalityDirectory(this.directory);const snapshot=read(fd);for(const r of snapshot.state.receipts)await this.audit.appendCommitted(r.audit);return await operation(snapshot,fd);}
    catch(error) {if(error instanceof PersonalityError||error instanceof Error&&error.name==='AuthorizationError')throw error;return fail();}
    finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{fail(effect?.()?'personality_uncertain':'personality_unavailable');}}
  }
  list():Promise<PersonalityPresetCatalog> {return this.load(async({state})=>({revision:hash(state.presets),capturedAt:this.now(),presets:state.presets.filter(e=>!e.deleted).map(e=>summary(e.versions.at(-1)!))}));}
  get(id:string,rev?:string):Promise<PersonalityPresetVersion> {
    if(!isUuid(id)||rev!==undefined&&!revision(rev))return Promise.reject(new PersonalityError('personality_invalid'));
    return this.load(async({state})=>{
      const entry=state.presets.find(e=>e.id===id);const v=rev?entry?.versions.find(v=>v.revision===rev):entry&&!entry.deleted?entry.versions.at(-1):undefined;
      if(!v)fail('personality_not_found');return structuredClone(v);
    });
  }
  assertCurrent(id:string,rev:string,kind:PersonalityPresetKind):void {
    const fd=openPersonalityDirectory(this.directory);
    try {const entry=read(fd).state.presets.find(e=>e.id===id);const value=entry?.versions.at(-1);if(!entry||entry.deleted||value?.revision!==rev||value.kind!==kind)fail('personality_conflict');}
    finally{fs.closeSync(fd);}
  }
  change(operation:'create'|'update'|'delete',id:string|undefined,body:unknown,actor:PersonalityActor,guard:()=>void):Promise<PersonalityPresetVersion|DeletedPersonalityPreset> {
    const required=operation==='create'?['requestId','catalogRevision','name','kind','content']:operation==='update'?['requestId','revision','name','content']:['requestId','revision'];
    if(!exactObject(body,required)||!isUuid(body.requestId)||operation!=='create'&&!isUuid(id)||!revision(operation==='create'?body.catalogRevision:body.revision)||operation!=='delete'&&!nameValid(body.name)||operation==='create'&&!['soul','overlay'].includes(String(body.kind)))return Promise.reject(new PersonalityError('personality_invalid'));
    const requestId=body.requestId;
    const request=structuredClone(body);const fingerprint=hash(canonical([operation,id??null,request]));
    const task=this.queue.then(()=>{let attempted=false;return this.load(async(before,fd)=>{
      guard();
      const existing=before.state.receipts.find(r=>r.deviceId===actor.id&&r.requestId===request.requestId);
      if(existing) {
        if(existing.fingerprint!==fingerprint)fail('personality_conflict');guard();
        const {result}=existing;const version=before.state.presets.find(e=>e.id===result.id)!.versions.find(v=>v.revision===result.revision)!;
        return result.kind==='deleted'?{id:result.id,revision:result.revision,deleted:true as const}:structuredClone(version);
      }
      const state=structuredClone(before.state);let entry=state.presets.find(e=>e.id===id);let current=entry?.versions.at(-1);
      if(operation==='create') {
        if(request.catalogRevision!==hash(state.presets))fail('personality_conflict');
        if(state.presets.filter(e=>!e.deleted).length>=PERSONALITY_PRESET_MAX_COUNT)fail('personality_limit');
        entry={id:randomUUID(),deleted:false,versions:[]};state.presets.push(entry);
      } else if(!entry||entry.deleted)fail('personality_not_found');
      else if(current?.revision!==request.revision)fail('personality_conflict');
      let value:PersonalityPresetVersion|DeletedPersonalityPreset;
      if(operation==='delete') {entry!.deleted=true;value={id:entry!.id,revision:current!.revision,deleted:true};}
      else {
        const kind=operation==='create'?request.kind as PersonalityPresetKind:current!.kind;
        if(!validString(request.content,contentLimit(kind)))fail('personality_invalid');
        const time=this.now();const next={id:entry!.id,name:request.name as string,kind,content:request.content,bytes:Buffer.byteLength(request.content),createdAt:current?.createdAt??time,updatedAt:time};
        value={...next,revision:versionHash(next,current?.revision??null)};entry!.versions.push(value);
      }
      const target={kind:'preset' as const,id:entry!.id};
      const requested=makeChangeRecord({actor,action:`personality.preset.${operation}.requested`,target},this.now(),randomUUID);
      const succeeded=makeChangeRecord({actor,action:`personality.preset.${operation}.succeeded`,target},this.now(),randomUUID);
      state.receipts.push({deviceId:actor.id,requestId,fingerprint,result:{kind:operation==='delete'?'deleted':'preset',id:value.id,revision:value.revision},audit:succeeded});
      validate(state);const bytes=Buffer.from(JSON.stringify(state));if(bytes.length>PERSONALITY_CATALOG_MAX_BYTES)fail('personality_limit');
      const anchor=`/proc/self/fd/${fd}`;const temp=`.personality-${randomUUID()}.tmp`;let staged=false;
      try {
        if(before.bytes) {privatePersonalityWrite(anchor,`personality-${requested.id}.previous`,before.bytes);fs.fsyncSync(fd);}
        guard();await this.audit.appendCommitted(requested);guard();
        const prepared=privatePersonalityWrite(anchor,temp,bytes);staged=true;
        const publicFd=openPersonalityDirectory(this.directory);
        try {const a=fs.fstatSync(fd,{bigint:true}),b=fs.fstatSync(publicFd,{bigint:true});if(a.dev!==b.dev||a.ino!==b.ino)fail('personality_conflict');}finally{fs.closeSync(publicFd);}
        const latest=read(fd);if(hash(latest.identity)!==hash(before.identity)||!((latest.bytes===null&&before.bytes===null)||(latest.bytes&&before.bytes&&latest.bytes.equals(before.bytes))))fail('personality_conflict');
        verifyPrivatePersonalityFile(`${anchor}/${temp}`,prepared,bytes);
        guard();attempted=true;fs.renameSync(`${anchor}/${temp}`,`${anchor}/personality-presets.json`);staged=false;fs.fsyncSync(fd);
        await this.audit.appendCommitted(succeeded);guard();return value;
      } catch(error) {if(attempted)fail('personality_uncertain');throw error;}
      finally {if(staged)try{fs.unlinkSync(`${anchor}/${temp}`);}catch{/* A private staged file is never served. */}}
    },()=>attempted);});
    this.queue=task.then(()=>{},()=>{});return task;
  }
}
