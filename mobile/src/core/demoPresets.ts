import type { PersonalityPresetCatalog, PersonalityPresetVersion, ConversationPersonality } from '../../../protocol/personalityPresets.ts';
import { PERSONALITY_MESSAGES, PERSONALITY_PRESET_MAX_COUNT } from '../../../protocol/personalityPresets.ts';
import type { PersonalityClient } from './personalityPresetsClient.ts';
import { validPreset } from './personalityPresetsClient.ts';
import type { RelayClient } from './client.ts';
import { RelayError } from './client.ts';
import { utf8Bytes } from './agentMemory.ts';
export const DEMO_PRESET_SCENARIOS=['ready','empty','loading','offline','revoked','error','conflict','uncertain','soul_changed','mid_turn','external','limit','read_only','key_unknown','cleartext','fingerprint_denied'] as const;
export type DemoPresetScenario=typeof DEMO_PRESET_SCENARIOS[number];
let scenario:DemoPresetScenario='ready';
export function demoPresetScenario(){return scenario;}
export function demoPresetFingerprintAllowed(){return scenario!=='fingerprint_denied';}
export function setDemoPresetScenario(value:DemoPresetScenario){scenario=value;worlds.clear();}
export function resetDemoPresets(){setDemoPresetScenario('ready');}
const hash=(n:number)=>n.toString(16).padStart(64,'0');
interface World {sequence:number;revision:string;current:Map<string,PersonalityPresetVersion>;versions:Map<string,PersonalityPresetVersion>;conversations:Map<string,ConversationPersonality>;receipts:Map<string,{body:string;value:unknown}>;previews:number}
const worlds=new Map<string,World>();
function world(serverId:string,now:number){let w=worlds.get(serverId);if(!w){w={sequence:2,revision:hash(2),current:new Map(),versions:new Map(),conversations:new Map(),receipts:new Map(),previews:0};if(scenario!=='empty'){
 for(const [i,kind,name,content] of [[1,'soul','Revisor de código','# Soul\nRevisa errores y casos límite. Sé breve.'],[2,'overlay','Tutor paciente','Explica cada paso con un ejemplo breve.']] as const){const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,p={id,revision:hash(i),name,kind,content,bytes:utf8Bytes(content),createdAt:now,updatedAt:now};w.current.set(id,p);w.versions.set(`${id}:${p.revision}`,p);}}
 if(scenario==='limit'){for(let i=3;i<=PERSONALITY_PRESET_MAX_COUNT;i++){const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,content='Capa sintética.',p:PersonalityPresetVersion={id,revision:hash(i),name:`Preset ${i}`,kind:'overlay',content,bytes:utf8Bytes(content),createdAt:now,updatedAt:now};w.current.set(id,p);w.versions.set(`${id}:${p.revision}`,p);}w.sequence=PERSONALITY_PRESET_MAX_COUNT;w.revision=hash(w.sequence);}
 worlds.set(serverId,w);}return w;}
function failure(code:keyof typeof PERSONALITY_MESSAGES):never{throw new RelayError(code,PERSONALITY_MESSAGES[code]);}
export function createDemoPresets(serverId:string,now:()=>number,memory:Pick<RelayClient,'agentSoul'|'changeAgentSoul'>):PersonalityClient {
 const copy=<T>(v:T):T=>structuredClone(v),w=()=>world(serverId,now());
 async function read(){if(scenario==='loading')await new Promise(()=>{});if(scenario==='offline')throw new RelayError('unreachable','Sin respuesta del Servidor.');if(scenario==='key_unknown')throw new RelayError('key_unknown','Llave rechazada.');if(scenario==='cleartext')throw new RelayError('cleartext_blocked','Android bloquea HTTP.');if(scenario==='revoked')throw new RelayError('device_revoked','Dispositivo revocado.');if(scenario==='error')failure('personality_unavailable');}
 async function writable(){await read();if(scenario==='limit')failure('personality_limit');if(scenario==='conflict')failure('personality_conflict');if(scenario==='uncertain')failure('personality_uncertain');}
 async function receipt<T>(action:string,id:string,body:unknown,operation:()=>Promise<T>|T):Promise<T>{await writable();const key=`${action}:${id}`,serialized=JSON.stringify(body),old=w().receipts.get(key);if(old){if(old.body!==serialized)failure('personality_conflict');return copy(old.value as T);}const value=await operation();w().receipts.set(key,{body:serialized,value:copy(value)});return copy(value);}
 const bump=()=>{const state=w();state.sequence++;state.revision=hash(state.sequence);return state.revision;};
 const find=(id:string,revision?:string)=>{const p=revision?w().versions.get(`${id}:${revision}`):w().current.get(id);if(!p)failure('personality_not_found');return copy(p);};
 const store=(p:PersonalityPresetVersion)=>{if(!validPreset(p,true))failure('personality_invalid');w().current.set(p.id,p);w().versions.set(`${p.id}:${p.revision}`,copy(p));return copy(p);};
 const api:PersonalityClient={
  async personalityPresets(){await read();const presets=[...w().current.values()].map(({content,...summary})=>{void content;return summary;});return {revision:w().revision,capturedAt:now(),presets} satisfies PersonalityPresetCatalog;},
  async personalityPreset(id,revision){await read();return find(id,revision);},
  async createPersonalityPreset(body){return receipt('create',body.requestId,body,()=>{if(body.catalogRevision!==w().revision)failure('personality_conflict');if(w().current.size>=PERSONALITY_PRESET_MAX_COUNT)failure('personality_limit');const revision=bump(),id=`00000000-0000-4000-8000-${String(w().sequence+100).padStart(12,'0')}`;return store({id,revision,name:body.name,kind:body.kind,content:body.content,bytes:utf8Bytes(body.content),createdAt:now(),updatedAt:now()});});},
  async updatePersonalityPreset(id,body){return receipt(`update:${id}`,body.requestId,body,()=>{const p=find(id);if(p.revision!==body.revision)failure('personality_conflict');return store({...p,revision:bump(),name:body.name,content:body.content,bytes:utf8Bytes(body.content),updatedAt:now()});});},
  async deletePersonalityPreset(id,body){return receipt(`delete:${id}`,body.requestId,body,()=>{const p=find(id);if(p.revision!==body.revision)failure('personality_conflict');w().current.delete(id);bump();return {id,revision:body.revision,deleted:true};});},
  async soulPresetPreview(agentId,ref){await read();const preset=find(ref.id,ref.revision);if(preset.kind!=='soul')failure('personality_invalid');const soul=await memory.agentSoul(agentId);if(scenario==='read_only'){soul.writable=false;soul.reason='No se puede verificar la configuración efectiva del Agente.';}w().previews++;if(scenario==='soul_changed'&&w().previews>1){soul.revision=hash(999);soul.content='SOUL cambió en el Servidor.';soul.characters=[...soul.content].length;}return {agentId,preset,soul};},
  async applySoulPreset(agentId,body){return receipt(`soul:${agentId}`,body.requestId,body,async()=>{const preset=find(body.presetId,body.presetRevision);if(preset.kind!=='soul')failure('personality_invalid');const soul=await memory.changeAgentSoul(agentId,{revision:body.soulRevision,content:preset.content});return {requestId:body.requestId,presetId:body.presetId,presetRevision:body.presetRevision,soul};});},
  async conversationPersonality(agentId,conversationId){await read();const key=JSON.stringify([agentId,conversationId]);let c=w().conversations.get(key);if(!c){c={agentId,conversationId,revision:hash(0),preset:null,updatedAt:null};w().conversations.set(key,c);}return copy(c);},
  async setConversationPersonality(a,c,body){return receipt(`conversation:${a}:${c}`,body.requestId,body,async()=>{if(scenario==='external')failure('personality_read_only');const current=await api.conversationPersonality(a,c);if(current.revision!==body.revision)failure('personality_conflict');const preset=body.preset?find(body.preset.id,body.preset.revision):null;if(preset&&preset.kind!=='overlay')failure('personality_invalid');const value={...current,revision:bump(),preset,updatedAt:now()};w().conversations.set(JSON.stringify([a,c]),copy(value));return value;});},
 };
 return api;
}
