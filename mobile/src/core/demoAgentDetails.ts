import type { AgentDetails, AgentSecurity } from '../../../protocol/agentDetails.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
export const DEMO_AGENT_DETAILS_SCENARIOS=[{id:'ready',name:'Ficha completa'},{id:'loading',name:'Cargando'},{id:'error',name:'Error'},{id:'offline',name:'Último conocido · solo lectura'},{id:'empty',name:'Agente nuevo'},{id:'no-rules',name:'Sin reglas'},{id:'off',name:'Aprobaciones Off'},{id:'usage-error',name:'Uso no disponible'},{id:'managed',name:'Configuración administrada'}] as const;
type Scenario=(typeof DEMO_AGENT_DETAILS_SCENARIOS)[number]['id'];const scenarios=new Map<string,Scenario>(),securities=new Map<string,AgentSecurity>();let revision=1;
export const demoAgentDetailsScenario=(server:string):Scenario=>scenarios.get(server)??'ready';
export function setDemoAgentDetailsScenario(server:string,scenario:Scenario){scenarios.set(server,scenario);for(const key of securities.keys())if(key.startsWith(`${server}/`))securities.delete(key);}
export function resetDemoAgentDetails(){scenarios.clear();securities.clear();revision=1;}
export function createDemoAgentDetails(serverId:string,now:()=>number,conversations:RelayClient['conversations'],startRun?:RelayClient['startRun']):Pick<RelayClient,'agentDetails'|'setApprovalMode'|'changeBlockRule'> & Partial<Pick<RelayClient,'startRun'>> {
 const guard=()=>{const failure=demoConnectionError(serverId);if(failure)throw failure;};
 const security=(agent:string)=>{const key=`${serverId}/${agent}`;let s=securities.get(key);const scenario=demoAgentDetailsScenario(serverId);
  if(!s){s={mode:scenario==='off'?'off':scenario==='no-rules'?'manual':'smart',pendingMode:null,deny:scenario==='empty'||scenario==='no-rules'?[]:['rm -rf /','git push --force*','DROP DATABASE*'],guardianPolicy:'Aprueba solo comandos de bajo riesgo dentro del proyecto. Escala a la persona los cambios de permisos, red o credenciales.',revision:String(revision++).padStart(64,'0'),writable:scenario!=='offline'&&scenario!=='managed',reason:scenario==='managed'?'La configuración está administrada.':scenario==='offline'?'Se muestra lo último conocido del Servidor.':null};securities.set(key,s);}return s;};
 const change=(agent:string,expected:string)=>{guard();const s=security(agent);if(!s.writable)throw new RelayError('agent_security_read_only','La ficha está en solo lectura.',403);if(s.revision!==expected)throw new RelayError('agent_security_conflict','La configuración cambió.',409);return s;};
 const bump=(s:AgentSecurity)=>{s.revision=String(revision++).padStart(64,'0');return structuredClone(s);};
 return {
  async agentDetails(agent):Promise<AgentDetails>{guard();const scenario=demoAgentDetailsScenario(serverId);if(scenario==='loading')await new Promise(r=>setTimeout(r,1800));if(scenario==='error')throw new RelayError('agent_details_unavailable','No se pudo cargar la ficha. Reintenta.',503);
   const capturedAt=now()-(scenario==='offline'?2*60*60*1000:0),empty=scenario==='empty';const counts=[162000,208000,134000,253000,88000,141000,184200];
   const daily=counts.map((tokens,i)=>{const d=new Date(capturedAt);d.setDate(d.getDate()-6+i);return {day:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,tokens:empty?0:tokens,estimatedCostUsd:empty?0:0.374,conversations:empty?0:1};});
   return {agentId:agent,name:agent,status:scenario==='offline'?'off':'on',capturedAt,defaultModel:{provider:agent==='research'?'anthropic':'OpenRouter',model:agent==='research'?'claude-sonnet-4-6':'qwen3-coder-480b'},security:structuredClone(security(agent)),usage:scenario==='usage-error'?null:{capturedAt,timezone:'America/Mexico_City',basis:'conversation_started_at',includesAuxiliary:false,today:{tokens:empty?0:184200,estimatedCostUsd:empty?0:0.41,conversations:empty?0:1},last7days:{tokens:empty?0:1170000,estimatedCostUsd:empty?0:2.62,conversations:empty?0:7},daily},usageError:scenario==='usage-error'?'No se pudo leer el uso del Agente. Reintenta.':null,recentConversations:empty?[]:(await conversations(agent,{limit:5,offset:0})).conversations};},
  async setApprovalMode(agent,request){const s=change(agent,request.revision);s.pendingMode=request.mode===s.mode?null:{mode:request.mode,requestedAt:now()};return bump(s);},
  async changeBlockRule(agent,request){const s=change(agent,request.revision);s.deny=request.action==='add'?[...(s.deny??[]),request.pattern]:(s.deny??[]).filter(p=>p!==request.pattern);return bump(s);},
  ...(startRun?{async startRun(agent:string,request:Parameters<RelayClient['startRun']>[1]){const s=security(agent);if(s.pendingMode){s.mode=s.pendingMode.mode;s.pendingMode=null;bump(s);}return startRun(agent,request);}}:{}),
 };
}
