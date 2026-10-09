import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentDetails, AgentSecurity, ApprovalMode, BlockRuleRequest } from '../../protocol/agentDetails.ts';
import type { AgentProfile, Hermes } from './hermes.ts';
import type { ConversationActor } from './conversationStore.ts';
import type { DeviceStore } from './deviceStore.ts';
import type { RunManager } from './runs.ts';
import type { ConversationService } from './conversations.ts';
import type { SecuritySnapshot } from './agentDetailsPorts.ts';
import { AgentDetailsError } from './agentDetailsError.ts';
import { checkStateDirectory, exactObject, isDeviceName, isTimestamp, isUuid, openPrivateFile, syncStateDirectory } from './changeLog.ts';
interface PendingMode { agentId:string;mode:ApprovalMode;requestedAt:number;configRevision:string;actor:ConversationActor }
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const isMode=(value:unknown):value is ApprovalMode=>['manual','smart','off'].includes(String(value));
const profileId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&value!=='.'&&value!=='..';
export class AgentDetailsService {
 private options:{hermes:Hermes;store:DeviceStore;runs:RunManager;conversations:()=>Promise<ConversationService>;now:()=>number};
 private queue:Promise<void>=Promise.resolve();private pending:PendingMode[]|null=null;
 constructor(options:AgentDetailsService['options']){this.options=options;}
 private serialize<T>(operation:()=>Promise<T>):Promise<T>{const result=this.queue.then(operation);this.queue=result.then(()=>{},()=>{});return result;}
 private port(){const port=this.options.hermes.details;if(!port)throw new AgentDetailsError('agent_details_unavailable');return port;}
 private async load(){
  if(this.pending)return;
  const file=path.join(this.options.store.directory,'agent-modes.json');
  try{
   const opened=await openPrivateFile(file,constants.O_RDONLY,false);
   try{if((await opened.handle.stat()).size>256*1024)throw new Error();const parsed:unknown=JSON.parse(await opened.handle.readFile('utf8'));
    if(!Array.isArray(parsed)||parsed.length>1000)throw new Error();const ids=new Set<string>();
    for(const p of parsed){if(!exactObject(p,['agentId','mode','requestedAt','configRevision','actor'])||!profileId(p.agentId)||!isMode(p.mode)||!isTimestamp(p.requestedAt)||typeof p.configRevision!=='string'||!/^[a-f0-9]{64}$/.test(p.configRevision)||!exactObject(p.actor,['kind','id','name'])||p.actor.kind!=='device'||!isUuid(p.actor.id)||!isDeviceName(p.actor.name)||ids.has(p.agentId))throw new Error();ids.add(p.agentId);}
    this.pending=parsed as PendingMode[];
   }finally{await opened.handle.close();}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')this.pending=[];else throw new AgentDetailsError('agent_details_unavailable');}
 }
 private async commit(rows:PendingMode[],guard:()=>void){
  const directory=this.options.store.directory;await checkStateDirectory(directory);guard();
  const file=path.join(directory,'agent-modes.json'),temporary=path.join(directory,`.agent-modes-${randomUUID()}.tmp`);
  const old=await openPrivateFile(file,constants.O_RDONLY,false).catch(error=>{if(error.code==='ENOENT')return null;throw error});await old?.handle.close();guard();
  try{const handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(JSON.stringify(rows));await handle.sync();}finally{await handle.close();}
   guard();await fs.rename(temporary,file);await syncStateDirectory(directory);guard();this.pending=rows;
  }catch(error){if(error instanceof Error&&error.name==='AuthorizationError')throw error;throw new AgentDetailsError('agent_security_uncertain');}finally{await fs.unlink(temporary).catch(()=>{});}
 }
 private projected(profile:string,snapshot:SecuritySnapshot):AgentSecurity{
  const pending=this.pending?.find(p=>p.agentId===profile);
  const stale=!!pending&&pending.configRevision!==snapshot.revision;
  const revoked=!!pending&&!this.options.store.snapshot().devices.some(d=>d.id===pending.actor.id&&d.revokedAt===null);
  return {...snapshot.security,revision:digest(JSON.stringify([snapshot.revision,pending??null])),pendingMode:pending?{mode:pending.mode,requestedAt:pending.requestedAt}:null,
   reason:stale?'La configuración cambió desde que se guardó el modo pendiente. Cancélalo y elige de nuevo.':revoked?'El dispositivo que pidió el modo pendiente fue revocado. Cancela el cambio.':snapshot.security.reason};
 }
 private audit(action:string,agentId:string,revision:string,actor:ConversationActor){return this.options.store.changeLog.appendChange({actor,action,target:{kind:'agent',id:JSON.stringify([agentId,revision])}});}
 private async backup(agentId:string,snapshot:SecuritySnapshot){
  const directory=this.options.store.directory;await checkStateDirectory(directory);
  if(snapshot.bytes.length>1024*1024||digest(snapshot.bytes)!==snapshot.revision)throw new AgentDetailsError('agent_security_uncertain');
  const file=path.join(directory,`${digest(agentId).slice(0,16)}-${snapshot.revision}-${randomUUID()}.config-backup`);
  const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(snapshot.bytes);await handle.sync();}finally{await handle.close();}await syncStateDirectory(directory);
 }
 async read(agent:AgentProfile,guard:()=>void):Promise<AgentDetails>{
  return this.serialize(async()=>{guard();await this.load();guard();const snapshot=await this.port().security(agent.id);guard();const capturedAt=this.options.now();
   const [usage,recent,states]=await Promise.all([this.port().usage(agent.id,capturedAt).then(value=>({value,error:null}),()=>({value:null,error:'No se pudo leer el uso del Agente. Reintenta.'})),this.options.conversations().then(c=>c.list(agent.id,{limit:5,offset:0,background:false})),this.options.hermes.profileStates([agent.id])]);guard();
   return {agentId:agent.id,name:agent.name,status:this.options.runs.busy(agent.id)?'busy':states[agent.id]??'off',capturedAt,defaultModel:{provider:agent.provider,model:agent.model},security:this.projected(agent.id,snapshot),usage:usage.value,usageError:usage.error,recentConversations:recent.conversations};});
 }
 async mode(agentId:string,mode:ApprovalMode,revision:string,actor:ConversationActor,guard:()=>void):Promise<AgentSecurity>{
  return this.serialize(async()=>{guard();await this.load();guard();const snapshot=await this.port().security(agentId);guard();if(this.projected(agentId,snapshot).revision!==revision)throw new AgentDetailsError('agent_security_conflict');
   if(!snapshot.security.writable)throw new AgentDetailsError('agent_security_read_only');
   const rows=this.pending!.filter(p=>p.agentId!==agentId);const cancelling=mode===snapshot.security.mode;
   if(!cancelling)rows.push({agentId,mode,requestedAt:this.options.now(),configRevision:snapshot.revision,actor});
   await this.audit(cancelling?'agent.mode.cancelled':'agent.mode.queued',agentId,snapshot.revision,actor);guard();await this.commit(rows,guard);guard();return this.projected(agentId,snapshot);
  });
 }
 async rule(agentId:string,request:BlockRuleRequest,actor:ConversationActor,guard:()=>void):Promise<AgentSecurity>{
  return this.serialize(async()=>{guard();await this.load();guard();const snapshot=await this.port().security(agentId);guard();if(this.projected(agentId,snapshot).revision!==request.revision)throw new AgentDetailsError('agent_security_conflict');
   if(!snapshot.security.writable||!snapshot.security.deny)throw new AgentDetailsError('agent_security_read_only');
   const existing=snapshot.security.deny;if(request.action==='remove'&&!existing.includes(request.pattern)||request.action==='add'&&existing.includes(request.pattern))throw new AgentDetailsError('agent_security_conflict');
   const deny=request.action==='add'?[...existing,request.pattern]:existing.filter(p=>p!==request.pattern);if(deny.length>100)throw new AgentDetailsError('agent_security_invalid');
   const action=request.action==='add'?'agent.rule.add':'agent.rule.remove';
   const after=await this.port().writeSecurity(agentId,snapshot,'deny',deny,guard,async()=>{guard();await this.backup(agentId,snapshot);guard();await this.audit(`${action}.requested`,agentId,snapshot.revision,actor);guard();});guard();
   await this.audit(`${action}.succeeded`,agentId,after.revision,actor);guard();
   const pending=this.pending!.map(p=>p.agentId===agentId&&p.configRevision===snapshot.revision?{...p,configRevision:after.revision}:p);await this.commit(pending,guard);guard();return this.projected(agentId,after);
  });
 }
 async beforeTurn<T>(agentId:string,guard:()=>void,operation:()=>Promise<T>):Promise<T>{
  return this.serialize(async()=>{guard();await this.load();guard();const pending=this.pending!.find(p=>p.agentId===agentId);
   if(pending){if(this.options.runs.busy(agentId))throw new AgentDetailsError('agent_security_conflict');
    const valid=()=>{guard();if(!this.options.store.snapshot().devices.some(d=>d.id===pending.actor.id&&d.revokedAt===null))throw new AgentDetailsError('agent_security_read_only');};valid();
    const snapshot=await this.port().security(agentId);valid();if(snapshot.revision!==pending.configRevision)throw new AgentDetailsError('agent_security_conflict');
    const after=await this.port().writeSecurity(agentId,snapshot,'mode',pending.mode,valid,async()=>{valid();await this.backup(agentId,snapshot);valid();await this.audit('agent.mode.requested',agentId,snapshot.revision,pending.actor);valid();});valid();
    await this.audit('agent.mode.succeeded',agentId,after.revision,pending.actor);valid();await this.commit(this.pending!.filter(p=>p.agentId!==agentId),valid);valid();
   }guard();return operation();
  });
 }
}
