import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDetails, AgentSecurity } from '../../../../protocol/agentDetails';
import type { RelayClient } from '@/core/client';
import { isAgentDetails, agentDetailsCacheKey } from '@/core/agentDetails';
import { load, save } from '@/state/storage';
export function useAgentDetails(client:RelayClient,agentId:string,scope:string,reachable:boolean|null){
 const [state,setState]=useState({details:null as AgentDetails|null,loading:true,error:null as string|null,cached:true});
 const [attempt,setAttempt]=useState(0);const writes=useRef(Promise.resolve());
 useEffect(()=>{let alive=true;const key=agentDetailsCacheKey(scope);
  void(async()=>{
   const raw=await load(key);if(!alive)return;
   if(raw)try{const cached=JSON.parse(raw);if(cached.scope===scope&&isAgentDetails(cached.details,agentId))setState(p=>p.details?p:{...p,details:cached.details,cached:true});}catch{/* Invalid cached data cannot become live state. */}
   if(reachable!==true){if(alive)setState(p=>({...p,loading:reachable===null,error:null,cached:true}));return;}
   setState(p=>({...p,loading:true,error:null}));
   try{const details=await client.agentDetails(agentId);if(!alive)return;if(!isAgentDetails(details,agentId))throw new Error();
    setState({details,loading:false,error:null,cached:false});
   }catch{if(alive)setState(p=>({...p,loading:false,error:'No se pudo cargar la ficha. Reintenta.',cached:true}));}
  })();return()=>{alive=false;};
 },[client,agentId,scope,reachable,attempt]);
 useEffect(()=>{if(state.details&&!state.cached){const details=state.details;writes.current=writes.current.then(()=>save(agentDetailsCacheKey(scope),JSON.stringify({scope,details})));}},[state.details,state.cached,scope]);
 const updateSecurity=useCallback((security:AgentSecurity)=>setState(p=>p.details?{...p,details:{...p.details,security}}:p),[]);
 return {...state,retry:()=>setAttempt(a=>a+1),updateSecurity};
}
