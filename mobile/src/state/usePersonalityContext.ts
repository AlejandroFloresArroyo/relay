import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { DEMO, useApp } from './app';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';
import { demoPresetScenario } from '@/core/demoPresets';
import { classifyConnectionError } from '@/core/connectionStatus';
import { RelayError, type RelayClient } from '@/core/client';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES, type AgentMemoryErrorCode } from '../../../protocol/agentMemory';
import { PERSONALITY_MESSAGES } from '../../../protocol/personalityPresets';
export function personalityError(error:unknown):string {
 if(error instanceof RelayError&&error.code==='protocol_upgrade_required')return 'Actualiza Relay o el Puente antes de consultar presets.';
 if(error instanceof RelayError&&error.code.startsWith('personality_'))return PERSONALITY_MESSAGES[error.code as keyof typeof PERSONALITY_MESSAGES]??PERSONALITY_MESSAGES.personality_unavailable;
 if(error instanceof RelayError&&Object.hasOwn(AGENT_MEMORY_ERROR_STATUS,error.code))return AGENT_MEMORY_MESSAGES[error.code as AgentMemoryErrorCode];
 const diagnosis=classifyConnectionError(error);return `${diagnosis.label}. ${diagnosis.hint}`;
}
type ClientRetirement={demo:ReturnType<typeof demoPresetScenario>|null;message:string};
// Retirement outlives a screen, but never crosses the paired client identity.
const retirements=new WeakMap<RelayClient,ClientRetirement>();
const retirementListeners=new WeakMap<RelayClient,Set<()=>void>>();
function retirementFor(client:RelayClient,demo:ClientRetirement['demo']){const value=retirements.get(client);return value?.demo===demo?value:null;}
/** A lost presentation invalidates every captured action permanently, including free selections. */
export function usePersonalityContext(serverId:string,resource:string) {
 const {ready,servers,clientFor,snapshot}=useApp(),visible=useChatVisible();
 const server=servers.find(s=>s.id===serverId),connection=snapshot(serverId);
 const client=useMemo(()=>clientFor(serverId),[clientFor,serverId]);
 const demo=DEMO?demoPresetScenario():null;
 const retirement=useSyncExternalStore(useCallback((listener:()=>void)=>{let listeners=retirementListeners.get(client);if(!listeners){listeners=new Set();retirementListeners.set(client,listeners);}listeners.add(listener);return()=>{listeners.delete(listener);};},[client]),useCallback(()=>retirementFor(client,demo),[client,demo]),()=>null);
 const revoked=connection.down?.action==='pair'||!!retirement;
 const connected=ready&&!!server?.deviceId&&!!server.key&&!revoked&&connection.reachable!==false&&(!connection.protocol||connection.protocol.kind==='compatible');
 const lifecycle=useRef({epoch:0,mounted:false,focused:false,active:AppState.currentState==='active',window:true,allowed:false});
 const [generation,setGeneration]=useState(0),[focused,setFocused]=useState(false),[active,setActive]=useState(AppState.currentState==='active'),[windowFocused,setWindowFocused]=useState(true);
 const [identity,setIdentity]=useState({client,resource,serverId,connected,visible,demo,revision:0});
 if(identity.client!==client||identity.resource!==resource||identity.serverId!==serverId||identity.connected!==connected||identity.visible!==visible||identity.demo!==demo)setIdentity({client,resource,serverId,connected,visible,demo,revision:identity.revision+1});
 const invalidate=useCallback(()=>{lifecycle.current.epoch++;setGeneration(n=>n+1);},[]);
 useLayoutEffect(()=>{const state=lifecycle.current;state.mounted=true;return()=>{state.mounted=false;state.epoch++;};},[]);
 useLayoutEffect(()=>{const state=lifecycle.current;state.epoch++;state.allowed=connected&&visible;return()=>{state.allowed=false;state.epoch++;};},[connected,visible,client,resource,serverId,demo]);
 useFocusEffect(useCallback(()=>{lifecycle.current.focused=true;setFocused(true);return()=>{lifecycle.current.focused=false;setFocused(false);invalidate();};},[invalidate]));
 useEffect(()=>{
  const change=AppState.addEventListener('change',state=>{lifecycle.current.active=state==='active';setActive(state==='active');if(state!=='active')invalidate();});
  const blur=addWindowFocusListener('blur',()=>{lifecycle.current.window=false;setWindowFocused(false);invalidate();});
  const focus=addWindowFocusListener('focus',()=>{lifecycle.current.window=true;setWindowFocused(true);});
  return()=>{change.remove();blur.remove();focus.remove();};
 },[invalidate]);
 const capture=useCallback(()=>{const epoch=lifecycle.current.epoch;return()=>{const s=lifecycle.current;return s.mounted&&s.allowed&&s.focused&&s.active&&s.window&&s.epoch===epoch&&!retirementFor(client,demo);};},[client,demo]);
 const fail=useCallback((error:unknown)=>{const message=personalityError(error);if(classifyConnectionError(error).action==='pair'){retirements.set(client,{demo,message});for(const listener of retirementListeners.get(client)??[])listener();}return message;},[client,demo]);
 return {server,client,connection,revoked,failure:retirement?.message??null,generation:`${identity.revision}:${generation}`,capture,fail,presenting:visible&&focused&&active&&windowFocused,available:connected&&visible&&focused&&active&&windowFocused};
}
