import type { AgentMemory, AgentSoul, MemoryBucket, MemoryBucketSnapshot, MemoryChange, SoulChange } from '../../../protocol/agentMemory.ts';
import { AGENT_MEMORY_MESSAGES } from '../../../protocol/agentMemory.ts';
import { RelayError } from './client.ts';
export const DEMO_MEMORY_SCENARIOS = ['ready','empty','missing','read_only','loading','error','offline_empty','offline_cached','conflict','over_limit','soul_truncated'] as const;
export type DemoMemoryScenario = typeof DEMO_MEMORY_SCENARIOS[number];
let scenario: DemoMemoryScenario = 'ready';
const snapshots = new Map<string, { memory: AgentMemory; soul: AgentSoul; sequence: number }>();
export function setDemoMemoryScenario(value: DemoMemoryScenario) { scenario=value; snapshots.clear(); }
export function demoMemoryScenario() { return scenario; }
const revision = (n: number) => n.toString(16).padStart(64,'0');
const notes = [
  'Prefiere respuestas cortas y en español.',
  'El repositorio principal está en /srv/app/web.',
  'No hacer deploy los viernes después de las 16:00.',
  'En nodo-app se usa npm; en proyectos nuevos, pnpm.',
  'La base de datos de staging se reinicia cada domingo a las 04:00.',
];
function bucket(texts: string[], limit: number, exists = true): MemoryBucketSnapshot {
 return {exists,revision:revision(1),notes:texts.map((text,index)=>({id:revision(index+100),text})),characters:[...texts.join('\n§\n')].length,limit,writable:exists&&scenario!=='read_only',reason:!exists?'El archivo todavía no existe. Relay no añade notas.':scenario==='read_only'?'La configuración está administrada o usa valores externos.':null};
}
export function demoAgentDocuments(serverId: string, agentId: string, now: number) {
 const scope=JSON.stringify([serverId,agentId]);
 let value=snapshots.get(scope);
 if(!value) {
  const empty=scenario==='empty'||scenario==='missing';
  const memory:AgentMemory={agentId,capturedAt:scenario==='offline_cached'?now-7_200_000:now,buckets:{memory:bucket(empty?[]:notes,scenario==='over_limit'?10:2200,scenario!=='missing'),user:bucket(empty?[]:['Ale trabaja con sus propias máquinas por Tailscale.'],1375,scenario!=='missing')}};
  const content=empty?'':'# Soul\nEres un ingeniero backend senior.\nSé breve y directo.\nExplica solo si te lo piden.\nConsidera siempre errores y casos límite.';
  const soul:AgentSoul={agentId,capturedAt:memory.capturedAt,exists:scenario!=='missing',revision:revision(1),content,characters:[...content].length,contextLimit:scenario==='soul_truncated'?50:null,writable:scenario!=='read_only',reason:scenario==='read_only'?'No se puede verificar la configuración efectiva del Agente.':null};
  value={memory,soul,sequence:1};snapshots.set(scope,value);
 }
 return value;
}
export function createDemoMemory(serverId: string, now: () => number) {
 async function readGuard() {
  if(scenario==='loading')await new Promise(()=>{});
  if(scenario==='error')throw new RelayError('agent_memory_unavailable',AGENT_MEMORY_MESSAGES.agent_memory_unavailable);
  if(scenario==='offline_cached'||scenario==='offline_empty')throw new RelayError('unreachable','Sin respuesta del Servidor.');
 }
 const copy=<T>(v:T)=>structuredClone(v);
 async function writable() {
  await readGuard();
  if(scenario==='read_only')throw new RelayError('agent_memory_read_only',AGENT_MEMORY_MESSAGES.agent_memory_read_only);
  if(scenario==='conflict')throw new RelayError('agent_memory_conflict',AGENT_MEMORY_MESSAGES.agent_memory_conflict);
 }
 return {
  async agentMemory(agentId:string) {await readGuard();return copy(demoAgentDocuments(serverId,agentId,now()).memory);},
  async agentSoul(agentId:string) {await readGuard();return copy(demoAgentDocuments(serverId,agentId,now()).soul);},
  async changeAgentMemory(agentId:string,request:MemoryChange) {
   await writable();const row=demoAgentDocuments(serverId,agentId,now()),section=row.memory.buckets[request.bucket as MemoryBucket];
   const index=section.notes.findIndex(n=>n.id===request.noteId);
   if(index<0||section.revision!==request.revision)throw new RelayError('agent_memory_conflict',AGENT_MEMORY_MESSAGES.agent_memory_conflict);
   if(!section.writable)throw new RelayError('agent_memory_read_only',AGENT_MEMORY_MESSAGES.agent_memory_read_only);
   const next=section.notes.slice();
   if(request.content===null)next.splice(index,1);
   else {const text=request.content.trim();if(!text||text.includes('\n§\n'))throw new RelayError('agent_memory_invalid',AGENT_MEMORY_MESSAGES.agent_memory_invalid);next[index]={...next[index],text};}
   const characters=[...next.map(n=>n.text).join('\n§\n')].length;
   if(request.content!==null&&section.limit!==null&&characters>section.limit)throw new RelayError('agent_memory_limit',AGENT_MEMORY_MESSAGES.agent_memory_limit);
   row.sequence++;section.revision=revision(row.sequence);section.notes=next.map((n,i)=>({...n,id:revision(row.sequence*1000+i)}));section.characters=characters;row.memory.capturedAt=now();
   return copy(row.memory);
  },
  async changeAgentSoul(agentId:string,request:SoulChange) {
   await writable();const row=demoAgentDocuments(serverId,agentId,now());
   if(row.soul.revision!==request.revision)throw new RelayError('agent_memory_conflict',AGENT_MEMORY_MESSAGES.agent_memory_conflict);
   row.sequence++;row.soul={...row.soul,exists:true,content:request.content,characters:[...request.content].length,revision:revision(row.sequence),capturedAt:now()};return copy(row.soul);
  },
 };
}
