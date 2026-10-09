import type { ServerUsage, UsageAmount, UsagePeriod } from '../../../protocol/serverUsage.ts';
import { RelayError } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
export const DEMO_USAGE_SCENARIOS = [
  {id:'ready',name:'Resumen'}, {id:'unknown',name:'Solo tokens'}, {id:'empty',name:'Sin uso'},
  {id:'partial',name:'Agente con error'}, {id:'offline',name:'Sin respuesta, con caché'}, {id:'loading',name:'Cargando'},
] as const;
export type UsageDemoState = typeof DEMO_USAGE_SCENARIOS[number]['id'];
const scenarios = new Map<string,UsageDemoState>();
export function resetDemoUsage() { scenarios.clear(); }
export function setDemoUsage(serverId:string,state:UsageDemoState) { scenarios.set(serverId,state); }
export function demoUsageScenario(serverId:string) { return scenarios.get(serverId)??'ready'; }
export async function demoUsage(serverId:string,period:UsagePeriod) {
  const state=demoUsageScenario(serverId);
  const error=demoConnectionError(serverId);
  if(error) throw error;
  if(state==='offline') throw new RelayError('unreachable','Servidor de demostración sin respuesta.');
  if(state==='loading') return new Promise<ServerUsage>(()=>{});
  return demoServerUsage(period,state);
}
const zero = (): UsageAmount => ({ conversations: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0 });
const missing = (): UsageAmount => ({ conversations: null, tokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, estimatedCostUsd: null });
function sum(rows:UsageAmount[],known=false) {
  const result=zero();
  for(const key of Object.keys(result) as (keyof UsageAmount)[]) {
    const values=rows.map(r=>r[key]).filter(v=>v!==null);
    result[key]=(!known&&values.length!==rows.length)||(rows.length>0&&values.length===0)?null:values.reduce((a,b)=>a+b,0);
  }
  return result;
}
export function demoServerUsage(period: UsagePeriod, state: UsageDemoState = 'ready'): ServerUsage {
  const count = period === 'day' ? 1 : period === 'week' ? 3 : 14;
  const capturedAt = Date.parse('2026-10-14T18:00:00Z');
  const paid:UsageAmount[]=[],local:UsageAmount[]=[];
  const daily=Array.from({length:count},(_,i)=>{
    const tokens=state==='empty'?0:12000+(i%5)*24000;
    const p={conversations:state==='empty'?0:3,tokens,inputTokens:tokens*.8,outputTokens:tokens*.2,cacheReadTokens:tokens*.4,estimatedCostUsd:state==='unknown'?null:tokens/100000};
    const l={...zero(),conversations:state==='empty'?0:1,tokens:state==='empty'?0:5000,inputTokens:state==='empty'?0:4000,outputTokens:state==='empty'?0:1000,estimatedCostUsd:state==='empty'?0:null};
    paid.push(p); if(state!=='partial') local.push(l);
    const amounts=state==='partial'?[p,missing()]:[p,l];
    return {day:`2026-10-${String(15-count+i).padStart(2,'0')}`,amount:state==='partial'?missing():sum(amounts),totalsKnown:sum(amounts,true)};
  });
  const amount=sum([...paid,...local]); const known=sum([...paid,...local],true);
  return {period,capturedAt,timezone:'America/Mexico_City',from:Date.parse(`${daily[0].day}T06:00:00Z`),until:Date.parse('2026-10-15T06:00:00Z'),basis:'conversation_started_at',modelBasis:'session_recorded_model',includesAuxiliary:false,partial:state==='partial',total:state==='partial'?missing():amount,totalsKnown:known,
    agents:state==='empty'?[{id:'dev',name:'dev',status:'ok',amount:zero(),totalsKnown:zero()}]:[{id:'dev',name:'dev',status:'ok',amount:sum(paid),totalsKnown:sum(paid,true)},{id:'ops',name:'ops',status:state==='partial'?'error':'ok',amount:state==='partial'?missing():sum(local),totalsKnown:state==='partial'?missing():sum(local,true)}],
    models:state==='empty'?[]:[{model:'qwen3-coder',amount:sum(paid),totalsKnown:sum(paid,true)},...(state==='partial'?[]:[{model:'llama-3.3',amount:sum(local),totalsKnown:sum(local,true)}])],daily};
}
