import fs, { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentSoul, AgentMemoryErrorCode } from '../../protocol/agentMemory.ts';
import { AGENT_MEMORY_ERROR_STATUS } from '../../protocol/agentMemory.ts';
import type { AppliedSoulPreset, ApplySoulPreset, SoulPresetPreview } from '../../protocol/personalityPresets.ts';
import { exactObject, isTimestamp, isUuid, makeChangeRecord } from './changeLog.ts';
import type { HermesMemory, MemoryWriteContext } from './agentMemory.ts';
import { AuthorizationError } from './auth.ts';
import { MemoryFileError } from './memoryFileCommit.ts';
import { AgentMemoryError } from './agentMemory.ts';
import { PersonalityCatalog, PersonalityError, openPersonalityDirectory, privatePersonalityWrite, verifyPrivatePersonalityFile } from './personalityCatalog.ts';

interface Receipt { fingerprint:string; state:'pending'|'applied'|'rejected'; result:Omit<AgentSoul,'content'>|null; error:AgentMemoryErrorCode|'personality_conflict'|null }
const MAX_RECEIPT_BYTES=16384,MAX_RECEIPTS=4096;
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function error(code:'personality_invalid'|'personality_conflict'|'personality_uncertain'|'personality_unavailable'|'personality_limit'):never {throw new PersonalityError(code);}
function readReceipt(fd:number,name:string):{receipt:Receipt;bytes:Buffer}|null {
 let file:number;
 try {file=fs.openSync(`/proc/self/fd/${fd}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
 catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return null;error('personality_unavailable');}
 try {
  const stat=fs.fstatSync(file,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid!())||stat.mode&0o7177n||stat.size>BigInt(MAX_RECEIPT_BYTES))error('personality_unavailable');
  const buffer=Buffer.alloc(MAX_RECEIPT_BYTES+1);let size=0;
  while(size<buffer.length) {const count=fs.readSync(file,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
  if(size>MAX_RECEIPT_BYTES)error('personality_unavailable');
  const after=fs.fstatSync(file,{bigint:true});if(after.dev!==stat.dev||after.ino!==stat.ino||after.mode!==stat.mode||after.uid!==stat.uid||after.nlink!==stat.nlink||after.size!==stat.size||after.mtimeNs!==stat.mtimeNs||after.ctimeNs!==stat.ctimeNs)error('personality_uncertain');
  const bytes=buffer.subarray(0,size);let r:unknown;
  try{r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{error('personality_uncertain');}
  if(!exactObject(r,['fingerprint','state','result','error'])||!revision(r.fingerprint)||!['pending','applied','rejected'].includes(String(r.state)))error('personality_uncertain');
  if(r.state==='applied') {
   const v=r.result;
   if(!exactObject(v,['agentId','capturedAt','exists','revision','characters','contextLimit','writable','reason'])||typeof v.agentId!=='string'||!isTimestamp(v.capturedAt)||typeof v.exists!=='boolean'||!revision(v.revision)||!Number.isSafeInteger(v.characters)||Number(v.characters)<0||v.contextLimit!==null&&(!Number.isSafeInteger(v.contextLimit)||Number(v.contextLimit)<=0)||typeof v.writable!=='boolean'||v.reason!==null&&(typeof v.reason!=='string'||v.reason.length>200)||r.error!==null)error('personality_uncertain');
  } else if(r.result!==null||r.state==='pending'&&r.error!==null||r.state==='rejected'&&(typeof r.error!=='string'||r.error!=='personality_conflict'&&!Object.hasOwn(AGENT_MEMORY_ERROR_STATUS,r.error)))error('personality_uncertain');
  return {receipt:r as unknown as Receipt,bytes};
 } finally {fs.closeSync(file);}
}
export class PersonalityApplications {
 private readonly catalog:PersonalityCatalog;private readonly memory:()=>HermesMemory|undefined;
 private readonly pending=new Map<string,{fingerprint:string;operation:Promise<AppliedSoulPreset>}>();
 constructor(catalog:PersonalityCatalog,memory:()=>HermesMemory|undefined) {this.catalog=catalog;this.memory=memory;}
 async preview(agentId:string,presetId:string,presetRevision:string,guard:()=>void):Promise<SoulPresetPreview> {
  if(!isUuid(presetId)||!revision(presetRevision))error('personality_invalid');
  const preset=await this.catalog.get(presetId);guard();
  if(preset.kind!=='soul'||preset.revision!==presetRevision)error('personality_conflict');
  const memory=this.memory();if(!memory)error('personality_unavailable');
  const soul=await memory.readSoul(agentId);guard();this.catalog.assertCurrent(presetId,presetRevision,'soul');
  return {agentId,preset,soul};
 }
 apply(agentId:string,value:unknown,context:MemoryWriteContext):Promise<AppliedSoulPreset> {
  if(!exactObject(value,['requestId','presetId','presetRevision','soulRevision'])||!isUuid(value.requestId)||!isUuid(value.presetId)||!revision(value.presetRevision)||!revision(value.soulRevision)||context.actor.kind!=='device')return Promise.reject(new PersonalityError('personality_invalid'));
  const request=value as unknown as ApplySoulPreset;
  const fingerprint=hash([agentId,request.presetId,request.presetRevision,request.soulRevision]);
  const key=hash([context.actor.id,request.requestId]);const pending=this.pending.get(key);
  if(pending)return pending.fingerprint===fingerprint?pending.operation:Promise.reject(new PersonalityError('personality_conflict'));
  const operation=this.once(agentId,request,fingerprint,key,context).finally(()=>this.pending.delete(key));
  this.pending.set(key,{fingerprint,operation});return operation;
 }
 private async once(agentId:string,request:ApplySoulPreset,fingerprint:string,key:string,context:MemoryWriteContext):Promise<AppliedSoulPreset> {
  context.guard();context.signal.throwIfAborted();const fd=openPersonalityDirectory(context.directory),anchor=`/proc/self/fd/${fd}`,name=`personality-apply-${key}.json`;
  let soulReturned=false;
  try {
   const previous=readReceipt(fd,name);
   if(previous) {
    if(previous.receipt.fingerprint!==fingerprint)error('personality_conflict');
    if(previous.receipt.state==='pending')error('personality_uncertain');
    if(previous.receipt.state==='rejected'){if(previous.receipt.error==='personality_conflict')error('personality_conflict');throw new AgentMemoryError(previous.receipt.error!);}
    const preset=await this.catalog.get(request.presetId,request.presetRevision);context.guard();
    if(previous.receipt.result!.agentId!==agentId||previous.receipt.result!.characters!==Array.from(preset.content).length)error('personality_uncertain');
    return {requestId:request.requestId,presetId:request.presetId,presetRevision:request.presetRevision,soul:{...previous.receipt.result!,content:preset.content}};
   }
   const preset=await this.catalog.get(request.presetId);context.guard();
   if(preset.kind!=='soul'||preset.revision!==request.presetRevision)error('personality_conflict');
   const memory=this.memory();if(!memory)error('personality_unavailable');
   if(fs.readdirSync(anchor).filter(n=>/^personality-apply-[a-f0-9]{64}\.json$/.test(n)).length>=MAX_RECEIPTS)error('personality_limit');
   const receipt:Receipt={fingerprint,state:'pending',result:null,error:null};
   try {privatePersonalityWrite(anchor,name,Buffer.from(JSON.stringify(receipt)));fs.fsyncSync(fd);}
   catch(e) {if((e as NodeJS.ErrnoException).code==='EEXIST')error('personality_uncertain');throw e;}
   await context.changeLog.appendChange({actor:context.actor,action:'personality.soul.apply.requested',target:{kind:'agent',id:agentId}});context.guard();
   let catalogConflict=false;
   const guarded:MemoryWriteContext={...context,guard:()=>{context.guard();try{this.catalog.assertCurrent(request.presetId,request.presetRevision,'soul');}catch(e){if(e instanceof PersonalityError&&e.code==='personality_conflict'){catalogConflict=true;throw new MemoryFileError('agent_memory_conflict');}throw e;}}};
   let soul:AgentSoul;
   try {soul=await memory.changeSoul(agentId,{revision:request.soulRevision,content:preset.content},guarded);soulReturned=true;}
   catch(e) {
    if(e instanceof AuthorizationError)throw e;
    if(catalogConflict&&e instanceof AgentMemoryError&&e.code==='agent_memory_conflict') {
     receipt.state='rejected';receipt.error='personality_conflict';await this.finish(fd,name,receipt,context,agentId);error('personality_conflict');
    }
    if(e instanceof AgentMemoryError&&['agent_memory_conflict','agent_memory_invalid','agent_memory_read_only','agent_memory_limit','agent_memory_busy'].includes(e.code)) {
     receipt.state='rejected';receipt.error=e.code;await this.finish(fd,name,receipt,context,agentId);throw e;
    }
    if(catalogConflict&&!(e instanceof AgentMemoryError&&e.code==='agent_memory_uncertain'))error('personality_conflict');
    error('personality_uncertain');
   }
   context.guard();if(soul.agentId!==agentId||soul.content!==preset.content)error('personality_uncertain');
   const {content:_content,...result}=soul;receipt.state='applied';receipt.result=result;
   await this.finish(fd,name,receipt,context,agentId);
   return {requestId:request.requestId,presetId:request.presetId,presetRevision:request.presetRevision,soul};
  } catch(e) {if(soulReturned)error('personality_uncertain');if(e instanceof PersonalityError||e instanceof AgentMemoryError||e instanceof AuthorizationError)throw e;return error('personality_unavailable');}
  finally {try{fs.closeSync(fd);}catch{error('personality_uncertain');}}
 }
 private async finish(fd:number,name:string,receipt:Receipt,context:MemoryWriteContext,agentId:string) {
  const anchor=`/proc/self/fd/${fd}`,before=readReceipt(fd,name);if(!before||before.receipt.state!=='pending'||before.receipt.fingerprint!==receipt.fingerprint)error('personality_uncertain');
  const record=makeChangeRecord({actor:context.actor,action:'personality.soul.apply.recorded',target:{kind:'agent',id:agentId}},Date.now(),randomUUID);
  privatePersonalityWrite(anchor,`personality-apply-${record.id}.previous`,before.bytes);fs.fsyncSync(fd);
  await context.changeLog.appendCommitted(record);context.guard();
  const bytes=Buffer.from(JSON.stringify(receipt));if(bytes.length>MAX_RECEIPT_BYTES)error('personality_uncertain');
  const temp=`.personality-apply-${randomUUID()}.tmp`,prepared=privatePersonalityWrite(anchor,temp,bytes);
  try {
   const latest=readReceipt(fd,name);if(!latest?.bytes.equals(before.bytes))error('personality_uncertain');
   const publicFd=openPersonalityDirectory(context.directory);
   try{const a=fs.fstatSync(fd),b=fs.fstatSync(publicFd);if(a.dev!==b.dev||a.ino!==b.ino)error('personality_uncertain');}finally{fs.closeSync(publicFd);}
   verifyPrivatePersonalityFile(`${anchor}/${temp}`,prepared,bytes);
   context.guard();fs.renameSync(`${anchor}/${temp}`,`${anchor}/${name}`);fs.fsyncSync(fd);
  } finally{try{fs.unlinkSync(`${anchor}/${temp}`);}catch{/* The staged receipt is private and never a served file. */}}
 }
}
