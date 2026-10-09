import type { KanbanClient } from './kanbanClient.ts';
import type { KanbanColumn, KanbanComment, KanbanItem, KanbanItemDetail, KanbanNotifyReceipt, KanbanItemsPage } from '../../../protocol/kanban.ts';
import { KANBAN_COLUMNS } from '../../../protocol/kanban.ts';
import { RelayError } from './client.ts';
import { validateWorkDraft } from './kanban.ts';
export const DEMO_WORK_SCENARIOS = [
 {id:'normal',name:'19·1 Columnas'}, {id:'detail',name:'19·2 Detalle'}, {id:'drag',name:'19·3 Mover'},
 {id:'blocked',name:'19·4 Dependencias'}, {id:'create',name:'19·5 Crear'}, {id:'compact',name:'19·6 Compacto'},
 {id:'empty',name:'19·7 Vacío'}, {id:'loading',name:'19·8 Cargando'}, {id:'offline',name:'19·9 Sin conexión'},
 {id:'error',name:'19·10 Error'}, {id:'pending',name:'Aviso pendiente'}, {id:'uncertain',name:'Aviso incierto'},
 {id:'rejected',name:'Pausa general'}, {id:'partial',name:'Conversación sin Turno'}, {id:'started',name:'Turno observado'}, {id:'unobserved',name:'Turno sin estado'}, {id:'lost',name:'Respuesta perdida'}, {id:'unsupported',name:'Puente antiguo'},
] as const;
export type WorkDemoScenario = typeof DEMO_WORK_SCENARIOS[number]['id'];
const modes=new Map<string,WorkDemoScenario>();
const stores=new Map<string,{items:KanbanItem[];comments:Map<string,KanbanComment[]>;receipts:Map<string,KanbanNotifyReceipt>;replays:Map<string,{body:string;result:unknown}>;version:number}>();
export const demoWorkScenario=(serverId:string)=>modes.get(serverId) ?? 'normal';
export const setDemoWorkScenario=(serverId:string,mode:WorkDemoScenario)=>{modes.set(serverId,mode);};
export function resetDemoWork(){modes.clear();stores.clear();}
const uuid=(number:number)=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const revision=(version:number)=>version.toString(16).padStart(64,'0');
const labels=['Revisar pruebas del Puente','Documentar el emparejamiento','Configurar la demo','Revisar dependencias','Comprobar el recibo','Preparar capturas','Revisar cambios manuales','Cerrar revisión'];
export function demoWorkPage(at:number,agents:string[]=['dev','research'],mode:WorkDemoScenario='normal'): KanbanItemsPage {
 const total=mode==='empty'?0:mode==='compact'?22:8;
 const items=Array.from({length:total},(_,index):KanbanItem=>({id:uuid(index+1),number:index+17,revision:revision(1),title:labels[index%labels.length]+(index>=8?` · ${index+1}`:''),agentId:index%3===2?null:agents[index%agents.length] ?? null,column:mode==='compact'?'todo':mode==='blocked'&&index===0?'blocked':index<3?'todo':KANBAN_COLUMNS[(index-2)%5],blockedBy:mode==='blocked'&&index===0?[uuid(2)]:index===5?[uuid(1)]:[],commentCount:0,createdAt:at-index*60000,updatedAt:at-index*60000}));
 // The blocked column always carries an explicit manual dependency.
 for(const item of items) if(item.column==='blocked'&&!item.blockedBy.length)item.blockedBy=[uuid(1)];
 return {items,counts:Object.fromEntries(KANBAN_COLUMNS.map(column=>[column,items.filter(item=>item.column===column).length])) as Record<KanbanColumn,number>,revision:revision(1),observedAt:at,nextCursor:null};
}
export function createDemoKanbanClient(serverId:string, agents=['dev','research'], at=1791110400000, noticeEffect?:(agent:string,requestId:string,input:string)=>Promise<{conversationId:string;runId:string}>): KanbanClient {
 const current=()=>{
  const key=`${serverId}:${demoWorkScenario(serverId)}`;
  let state=stores.get(key);
  if(!state){state={items:demoWorkPage(at,agents,demoWorkScenario(serverId)).items,comments:new Map(),receipts:new Map(),replays:new Map(),version:1};stores.set(key,state);}
  return state;
 };
 const get=(id:string)=>{const item=current().items.find(i=>i.id===id);if(!item)throw new RelayError('kanban_not_found','Elemento de demo no disponible.');return item;};
 const dependency=(id:string)=>{const item=get(id);return {id:item.id,number:item.number,title:item.title,column:item.column};};
 function receipt(id:string,requestId:string,agentId:string,state:KanbanNotifyReceipt['state']):KanbanNotifyReceipt {
  const base={requestId,itemId:id,itemRevision:get(id).revision,agentId,requestedBy:{kind:'device' as const,id:'synthetic-device',name:'Tú'},requestedAt:at,updatedAt:at};
  if(state==='started')return {...base,state,conversationId:`synthetic-conversation-${requestId}`,runId:`synthetic-turn-${requestId}`,errorCode:null,turn:{phase:'running',observedAt:at}};
  if(state==='rejected')return {...base,state,conversationId:null,runId:null,errorCode:'server_paused'};
  if(state==='uncertain')return {...base,state,conversationId:null,runId:null,errorCode:'kanban_notification_uncertain'};
  return {...base,state,conversationId:null,runId:null,errorCode:null};
 }
 function replay<T>(requestId:string,body:unknown,action:()=>T):T {
  const old=current().replays.get(requestId),fingerprint=JSON.stringify(body);
  if(old){if(old.body!==fingerprint)throw new RelayError('kanban_conflict','La petición de demo cambió.');return old.result as T;}
  const result=action();current().replays.set(requestId,{body:fingerprint,result});return result;
 }
 function update(id:string,patch:Partial<KanbanItem>) {
  const state=current();state.version++;const item={...get(id),...patch,revision:revision(state.version),updatedAt:at};
  const error=validateWorkDraft(item,agents,state.items,id);if(error)throw new RelayError('kanban_invalid_request',error);
  state.items=state.items.map(i=>i.id===id?item:i);return item;
 }
 return {
  items:async q=>{
   const mode=demoWorkScenario(serverId);
   if(mode==='loading')return new Promise<KanbanItemsPage>(()=>{});
   if(mode==='offline')throw new RelayError('unreachable','Servidor sintético sin conexión.');
   if(mode==='error')throw new RelayError('kanban_store_unavailable','No se pudo leer Trabajo de demostración. Reintenta.');
   if(mode==='unsupported')throw new RelayError('kanban_unsupported','Actualiza el Puente para usar Trabajo.',404);
   const state=current(),all=state.items.filter(item=>!q?.column||q.column===item.column),start=q?.cursor?Number(q.cursor):0,limit=q?.limit??100;
   return {items:all.slice(start,start+limit),counts:Object.fromEntries(KANBAN_COLUMNS.map(c=>[c,state.items.filter(item=>item.column===c).length])) as Record<KanbanColumn,number>,revision:revision(state.version),observedAt:at,nextCursor:start+limit<all.length?String(start+limit):null};
  },
  item:async id=>{
   const item=get(id),mode=demoWorkScenario(serverId);
   let sample=['pending','uncertain','rejected','started','unobserved','partial'].includes(mode)&&item.agentId?receipt(id,'synthetic_notice',item.agentId,mode==='unobserved'?'started':mode==='partial'?'rejected':mode as KanbanNotifyReceipt['state']):null;if(sample?.state==='started'&&mode==='unobserved')sample={...sample,turn:null};if(sample?.state==='rejected'&&mode==='partial')sample={...sample,conversationId:'synthetic-partial-conversation',errorCode:'configuration_conflict'};
   return {item,blockers:item.blockedBy.map(dependency),blocks:current().items.filter(i=>i.blockedBy.includes(id)).map(i=>dependency(i.id)),latestNotification:Array.from(current().receipts.values()).filter(r=>r.itemId===id).at(-1)??sample,observedAt:at} satisfies KanbanItemDetail;
  },
  comments:async(id,q)=>{const all=current().comments.get(id)??[],start=q?.cursor?Number(q.cursor):0,limit=q?.limit??100;return {comments:all.slice(start,start+limit),itemRevision:get(id).revision,observedAt:at,nextCursor:start+limit<all.length?String(start+limit):null};},
  create:async body=>replay(body.requestId,body,()=>{const state=current(),number=state.items.length+100,id=uuid(number);const error=validateWorkDraft(body,agents,state.items);if(error)throw new RelayError('kanban_invalid_request',error);state.version++;const {requestId:_requestId,...draft}=body;const item:KanbanItem={...draft,id,number,revision:revision(state.version),commentCount:0,createdAt:at,updatedAt:at};state.items=[item,...state.items];return {requestId:body.requestId,item};}),
  update:async(id,body)=>replay(body.requestId,{id,...body},()=>{if(get(id).revision!==body.revision)throw new RelayError('kanban_conflict','El elemento cambió.');const {requestId,revision:_revision,...patch}=body;return {requestId,item:update(id,patch)};}),
  comment:async(id,body)=>replay(body.requestId,{id,...body},()=>{if(get(id).revision!==body.revision)throw new RelayError('kanban_conflict','El elemento cambió.');const comments=current().comments.get(id)??[],comment:KanbanComment={id:uuid(1000+comments.length),number:comments.length+1,author:{kind:'device',id:'synthetic-device',name:'Tú'},text:body.text,createdAt:at};current().comments.set(id,[...comments,comment]);return {requestId:body.requestId,item:update(id,{commentCount:comments.length+1}),comment};}),
  notify:async(id,body)=>replay(body.requestId,{id,...body},async()=>{
   const item=get(id);
   if(item.revision!==body.revision||item.agentId!==body.agentId)throw new RelayError('kanban_conflict','El elemento cambió.');
   let result=receipt(id,body.requestId,body.agentId,demoWorkScenario(serverId)==='rejected'?'rejected':'started');
   if(item.column==='blocked'||item.blockedBy.some(id=>get(id).column!=='done'))result={...receipt(id,body.requestId,body.agentId,'rejected'),state:'rejected',conversationId:null,runId:null,errorCode:'dependency_blocked'};
   if(result.state==='started' && noticeEffect) {
    try {const effect=await noticeEffect(body.agentId,body.requestId,body.input);result={...result,...effect};}
    catch(error){result=receipt(id,body.requestId,body.agentId,error instanceof RelayError && error.code==='server_paused'?'rejected':'uncertain');}
   }
   current().receipts.set(body.requestId,result);if(demoWorkScenario(serverId)==='lost')throw new RelayError('timeout','Respuesta de demostración perdida.');return result;
  }),
  receipt:async(id,requestId)=>{const mode=demoWorkScenario(serverId);const sample=requestId==='synthetic_notice'&&['pending','uncertain','rejected','started'].includes(mode)&&get(id).agentId?receipt(id,requestId,get(id).agentId!,mode as KanbanNotifyReceipt['state']):undefined;const result=current().receipts.get(requestId)??sample;if(result?.itemId!==id)throw new RelayError('kanban_not_found','Recibo de demo no disponible.');return result;},
 };
}
