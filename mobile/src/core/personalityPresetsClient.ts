import type { AppliedSoulPreset, ApplySoulPreset, ConversationPersonality, CreatePersonalityPreset, DeletedPersonalityPreset, DeletePersonalityPreset, PersonalityPresetCatalog, PersonalityPresetRef, PersonalityPresetSummary, PersonalityPresetVersion, SelectConversationPersonality, SoulPresetPreview, UpdatePersonalityPreset } from '../../../protocol/personalityPresets.ts';
import { PERSONALITY_MESSAGES, PERSONALITY_PRESET_MAX_COUNT, PERSONALITY_PRESET_NAME_MAX_CHARACTERS, PERSONALITY_OVERLAY_MAX_BYTES, PERSONALITY_SOUL_MAX_BYTES, PERSONALITY_REQUEST_MAX_BYTES, PERSONALITY_RESPONSE_MAX_BYTES } from '../../../protocol/personalityPresets.ts';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES, type AgentMemoryErrorCode } from '../../../protocol/agentMemory.ts';
import { isAgentSoul, utf8Bytes } from './agentMemory.ts';
import { RelayError } from './client.ts';
export interface PersonalityClient {
 personalityPresets():Promise<PersonalityPresetCatalog>;
 personalityPreset(id:string,revision?:string):Promise<PersonalityPresetVersion>;
 createPersonalityPreset(request:CreatePersonalityPreset):Promise<PersonalityPresetVersion>;
 updatePersonalityPreset(id:string,request:UpdatePersonalityPreset):Promise<PersonalityPresetVersion>;
 deletePersonalityPreset(id:string,request:DeletePersonalityPreset):Promise<DeletedPersonalityPreset>;
 soulPresetPreview(agentId:string,preset:PersonalityPresetRef):Promise<SoulPresetPreview>;
 applySoulPreset(agentId:string,request:ApplySoulPreset):Promise<AppliedSoulPreset>;
 conversationPersonality(agentId:string,conversationId:string):Promise<ConversationPersonality>;
 setConversationPersonality(agentId:string,conversationId:string,request:SelectConversationPersonality):Promise<ConversationPersonality>;
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&utf8Bytes(v)<=max&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const name=(v:unknown):v is string=>text(v,400)&&v.trim()===v&&[...v].length>0&&[...v].length<=PERSONALITY_PRESET_NAME_MAX_CHARACTERS&&!/[\u0000-\u001f\u007f]/.test(v);
const ref=(v:unknown):v is PersonalityPresetRef=>exact(v,['id','revision'])&&uuid(v.id)&&hash(v.revision);
const summaryKeys=['id','revision','name','kind','bytes','createdAt','updatedAt'];
export function validPreset(v:unknown,content:true):v is PersonalityPresetVersion;
export function validPreset(v:unknown,content?:false):v is PersonalityPresetSummary;
export function validPreset(v:unknown,content=false):v is PersonalityPresetSummary|PersonalityPresetVersion {
 if(!exact(v,content?[...summaryKeys,'content']:summaryKeys)||!uuid(v.id)||!hash(v.revision)||!name(v.name)||(v.kind!=='soul'&&v.kind!=='overlay')||!time(v.bytes)||!time(v.createdAt)||!time(v.updatedAt)||v.updatedAt<v.createdAt)return false;
 const max=v.kind==='soul'?PERSONALITY_SOUL_MAX_BYTES:PERSONALITY_OVERLAY_MAX_BYTES;
 return v.bytes<=max&&(!content||text(v.content,max)&&utf8Bytes(v.content)===v.bytes);
}
export function validCatalog(v:unknown):v is PersonalityPresetCatalog {
 return exact(v,['revision','capturedAt','presets'])&&hash(v.revision)&&time(v.capturedAt)&&Array.isArray(v.presets)&&v.presets.length<=PERSONALITY_PRESET_MAX_COUNT&&v.presets.every(p=>validPreset(p))&&new Set(v.presets.map(p=>p.id)).size===v.presets.length;
}
function unavailable():RelayError{return new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);}
function requireValid(value:boolean):void {if(!value)throw new RelayError('personality_invalid',PERSONALITY_MESSAGES.personality_invalid);}
export function createPersonalityClient(request:(method:string,path:string,body?:unknown)=>Promise<Response>,timeoutMs:number):PersonalityClient {
 const root='/v1/personality-presets', encode=encodeURIComponent;
 async function read(method:string,path:string,body?:unknown):Promise<unknown> {
  if(body!==undefined)requireValid(utf8Bytes(JSON.stringify(body))<=PERSONALITY_REQUEST_MAX_BYTES);
  const response=await request(method,path,body);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const length=response.headers?.get('Content-Length');
   if(length&&(!time(Number(length))||Number(length)>PERSONALITY_RESPONSE_MAX_BYTES))throw unavailable();
   async function payload():Promise<unknown>{
    if(!response.body){const v:unknown=await response.json();if(utf8Bytes(JSON.stringify(v))>PERSONALITY_RESPONSE_MAX_BYTES)throw unavailable();return v;}
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>PERSONALITY_RESPONSE_MAX_BYTES)throw unavailable();chunks.push(chunk.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   }
   const v=await Promise.race([payload(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RelayError('timeout','Sin respuesta del Servidor.')),timeoutMs);})]);
   if(!response.ok){
    const code=record(v)&&record(v.error)?v.error.code:null;
    if(typeof code==='string'&&Object.hasOwn(PERSONALITY_MESSAGES,code)){const known=code as keyof typeof PERSONALITY_MESSAGES;throw new RelayError(known,PERSONALITY_MESSAGES[known],response.status);}
    if(typeof code==='string'&&Object.hasOwn(AGENT_MEMORY_ERROR_STATUS,code)){const known=code as AgentMemoryErrorCode;throw new RelayError(known,AGENT_MEMORY_MESSAGES[known],response.status);}
    const safe=['device_revoked','key_unknown','unauthorized','pairing_required','protocol_upgrade_required','rate_limited','tailnet_required'] as const;
    throw new RelayError(safe.find(k=>k===code)??([401,403].includes(response.status)?'unauthorized':'personality_unavailable'),PERSONALITY_MESSAGES.personality_unavailable,response.status);
   }
   return v;
  }catch(e){if(e instanceof RelayError)throw e;throw unavailable();}
  finally {clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Native cancellation may still be pending. */}}}
 }
 function version(v:unknown,id?:string,revision?:string):PersonalityPresetVersion {if(!validPreset(v,true)||(id!==undefined&&v.id!==id)||(revision!==undefined&&v.revision!==revision))throw unavailable();return v;}
 function selection(v:unknown,agentId:string,conversationId:string):ConversationPersonality {
  if(!exact(v,['agentId','conversationId','revision','preset','updatedAt'])||v.agentId!==agentId||v.conversationId!==conversationId||!hash(v.revision)||!(v.updatedAt===null||time(v.updatedAt))||!(v.preset===null||validPreset(v.preset,true)&&v.preset.kind==='overlay'))throw unavailable();
  return v as unknown as ConversationPersonality;
 }
 const conversationPath=(a:string,c:string)=>`/v1/agents/${encode(a)}/conversations/${encode(c)}/personality`;
 return {
  async personalityPresets(){const v=await read('GET',root);if(!validCatalog(v))throw unavailable();return v;},
  async personalityPreset(id,revision){requireValid(uuid(id)&&(revision===undefined||hash(revision)));return version(await read('GET',`${root}/${id}${revision?`/versions/${revision}`:''}`),id,revision);},
  async createPersonalityPreset(body){requireValid(exact(body,['requestId','catalogRevision','name','kind','content'])&&uuid(body.requestId)&&hash(body.catalogRevision)&&name(body.name)&&(body.kind==='soul'||body.kind==='overlay')&&text(body.content,body.kind==='soul'?PERSONALITY_SOUL_MAX_BYTES:PERSONALITY_OVERLAY_MAX_BYTES));const v=version(await read('POST',root,body));if(v.kind!==body.kind||v.name!==body.name||v.content!==body.content)throw unavailable();return v;},
  async updatePersonalityPreset(id,body){requireValid(uuid(id)&&exact(body,['requestId','revision','name','content'])&&uuid(body.requestId)&&hash(body.revision)&&name(body.name)&&text(body.content,PERSONALITY_SOUL_MAX_BYTES));const v=version(await read('PATCH',`${root}/${id}`,body),id);if(v.name!==body.name||v.content!==body.content)throw unavailable();return v;},
  async deletePersonalityPreset(id,body){requireValid(uuid(id)&&exact(body,['requestId','revision'])&&uuid(body.requestId)&&hash(body.revision));const v=await read('DELETE',`${root}/${id}`,body);if(!exact(v,['id','revision','deleted'])||v.id!==id||v.revision!==body.revision||v.deleted!==true)throw unavailable();return v as unknown as DeletedPersonalityPreset;},
  async soulPresetPreview(agentId,preset){requireValid(ref(preset));const v=await read('GET',`/v1/agents/${encode(agentId)}/soul/preset-preview?presetId=${preset.id}&presetRevision=${preset.revision}`);if(!exact(v,['agentId','preset','soul'])||v.agentId!==agentId||!isAgentSoul(v.soul,agentId))throw unavailable();const p=version(v.preset,preset.id,preset.revision);if(p.kind!=='soul')throw unavailable();return v as unknown as SoulPresetPreview;},
  async applySoulPreset(agentId,body){requireValid(exact(body,['requestId','presetId','presetRevision','soulRevision'])&&uuid(body.requestId)&&uuid(body.presetId)&&hash(body.presetRevision)&&hash(body.soulRevision));const v=await read('PUT',`/v1/agents/${encode(agentId)}/soul/preset`,body);if(!exact(v,['requestId','presetId','presetRevision','soul'])||v.requestId!==body.requestId||v.presetId!==body.presetId||v.presetRevision!==body.presetRevision||!isAgentSoul(v.soul,agentId))throw unavailable();return v as unknown as AppliedSoulPreset;},
  async conversationPersonality(a,c){return selection(await read('GET',conversationPath(a,c)),a,c);},
  async setConversationPersonality(a,c,body){requireValid(exact(body,['requestId','revision','preset'])&&uuid(body.requestId)&&hash(body.revision)&&(body.preset===null||ref(body.preset)));const v=selection(await read('PUT',conversationPath(a,c),body),a,c);if(v.preset?.id!==body.preset?.id||v.preset?.revision!==body.preset?.revision)throw unavailable();return v;},
 };
}
