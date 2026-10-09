import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState } from 'react';
import { Pressable } from 'react-native';
import { router } from 'expo-router';
import type { Conversation } from '../../../../protocol/protocol';
import type { ConversationPersonality, PersonalityPresetCatalog, PersonalityPresetSummary, PersonalityPresetVersion } from '../../../../protocol/personalityPresets';
import { PERSONALITY_MESSAGES, PERSONALITY_NONE_NOTICE } from '../../../../protocol/personalityPresets';
import { RelayError } from '@/core/client';
import { conversationRequestId } from '@/core/conversations';
import { demoPresetScenario } from '@/core/demoPresets';
import { DEMO } from '@/state/app';
import { usePersonalityContext } from '@/state/usePersonalityContext';
import { M, T } from '@/ui/primitives';
import { DemoPresetStates } from '../DemoPresetStates';
import { Keycap, ListBlock } from '@/ui/kit';
import { PresetContent, PresetProblem, PresetRow, PresetSheet, sheetBlock } from '../PersonalityPresetParts';
interface Props {serverId:string;agentId:string;conversation:Conversation|null;running:boolean;disabled?:boolean}
export function ConversationPersonalityControl(props:Props) {
 const context=usePersonalityContext(props.serverId,JSON.stringify([props.agentId,props.conversation?.id,props.conversation?.origin,props.conversation?.writable,props.disabled]));
 const [demoRevision,setDemoRevision]=useState(0);
 if(!context.presenting||!props.conversation)return null;
 return <>{context.failure?<PresetProblem message={context.failure}/>:null}<Control key={`${context.generation}:${demoRevision}`} {...props} conversation={props.conversation} context={context} demoReload={()=>setDemoRevision(n=>n+1)}/></>;
}
function Control({serverId,agentId,conversation,running,disabled,context,demoReload}:Props&{conversation:Conversation;context:ReturnType<typeof usePersonalityContext>;demoReload:()=>void}) {
 const { K } = usePalette();
 const [open,setOpen]=useState(false),[selection,setSelection]=useState<ConversationPersonality|null>(null),[catalog,setCatalog]=useState<PersonalityPresetCatalog|null>(null),[candidate,setCandidate]=useState<{preset:PersonalityPresetVersion|null}|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false);
 const mounted=useRef(true),pending=useRef(false),dialogEpoch=useRef(0);
 useEffect(()=>()=>{mounted.current=false;},[]);
 const readOnly=conversation.origin!=='relay'||!conversation.writable||conversation.state!=='ready'||DEMO&&demoPresetScenario()==='external';
 const midTurn=running||DEMO&&demoPresetScenario()==='mid_turn';
 const capture=()=>{const current=context.capture(),epoch=dialogEpoch.current;return()=>mounted.current&&epoch===dialogEpoch.current&&current();};
 function close(){dialogEpoch.current++;setOpen(false);setCandidate(null);setCatalog(null);setError(null);}
 async function load(){
  if(pending.current||disabled)return;dialogEpoch.current++;const guard=capture();if(!guard())return;setOpen(true);setCandidate(null);setError(null);setBlocked(false);setCatalog(null);
  if(readOnly)return;setLoading(true);
  try{if(!context.client.personalityPresets||!context.client.conversationPersonality)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);
   const [values,current]=await Promise.all([context.client.personalityPresets(),context.client.conversationPersonality(agentId,conversation.id)]);if(!guard())return;setCatalog(values);setSelection(current);
  }catch(e){const message=context.fail(e);if(guard())setError(message);}finally{if(guard())setLoading(false);}
 }
 async function choose(preset:PersonalityPresetSummary|null){
  if(pending.current||loading||blocked||readOnly)return;const guard=capture();if(!guard())return;setError(null);if(!preset){setCandidate({preset:null});return;}
  pending.current=true;setLoading(true);try{if(!context.client.personalityPreset)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await context.client.personalityPreset(preset.id,preset.revision);if(guard())setCandidate({preset:value});}catch(e){const message=context.fail(e);if(guard())setError(message);}finally{pending.current=false;if(mounted.current)setLoading(false);}
 }
 async function apply(){
  if(!candidate||!selection||pending.current||blocked||readOnly||disabled)return;const guard=capture();if(!guard())return;const shown=selection,chosen=candidate.preset;pending.current=true;setBusy(true);setError(null);
  try{
   if(!context.client.conversationPersonality||!context.client.setConversationPersonality)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);
   const fresh=await context.client.conversationPersonality(agentId,conversation.id);if(!guard())return;
   if(fresh.revision!==shown.revision)throw new RelayError('personality_conflict',PERSONALITY_MESSAGES.personality_conflict);
   const result=await context.client.setConversationPersonality(agentId,conversation.id,{requestId:conversationRequestId(),revision:shown.revision,preset:chosen?{id:chosen.id,revision:chosen.revision}:null});if(!guard())return;setSelection(result);close();
  }catch(e){const message=context.fail(e);if(guard()){setBlocked(true);setError(message);}}
  finally{pending.current=false;if(mounted.current)setBusy(false);}
 }
 const label=selection?`Personalidad de esta Conversación: ${selection.preset?.name??'Sin capa extra'}`:'Personalidad de esta Conversación';
 return <><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{expanded:open,disabled:disabled||!context.available}} disabled={disabled||!context.available} onPress={()=>void load()} style={{minHeight:40,maxWidth:200,paddingHorizontal:12,borderRadius:12,backgroundColor:K.key,boxShadow:K.shadowKey,flexDirection:'row',alignItems:'center',gap:8,opacity:disabled||!context.available?0.45:1}}><T s={13} w="600" c={K.ink} numberOfLines={1} style={{flexShrink:1}}>{selection?.preset?.name??'Personalidad'}</T><T s={13} w="600" c={K.inkSecondary}>▾</T></Pressable>
  {open&&context.available&&!disabled?<PresetSheet title="Personalidad de Conversación" close={close}>
   {readOnly?<T s={13} c={K.inkTertiary}>{PERSONALITY_MESSAGES.personality_read_only}</T>:<>
    <T s={13} c={K.inkSecondary}>{PERSONALITY_NONE_NOTICE} Esto puede incluir system_prompt y personality de Hermes.</T>
    {loading?<M c={K.inkTertiary}>CARGANDO PRESETS…</M>:null}
    {!candidate?<><Keycap label="Sin capa extra de Relay" disabled={loading||busy||blocked} onPress={()=>void choose(null)}/>
     {catalog?.presets.some(p=>p.kind==='overlay')?<ListBlock style={sheetBlock(K)}>{catalog.presets.filter(p=>p.kind==='overlay').map(p=><PresetRow key={p.id} preset={p} selected={selection?.preset?.id===p.id&&selection.preset.revision===p.revision} disabled={loading||busy||blocked} onPress={()=>void choose(p)}/>)}</ListBlock>:null}
     {!loading&&catalog&&!catalog.presets.some(p=>p.kind==='overlay')?<T s={13} c={K.inkTertiary}>No hay capas de Relay en este Servidor.</T>:null}
     {selection?.preset?<><T s={12} c={K.inkTertiary}>La versión en uso se conserva aunque se edite o borre del catálogo.</T><PresetContent title="Capa fijada" content={selection.preset.content} revision={selection.preset.revision}/></>:null}
    </>:<>
     {candidate.preset?<PresetContent title={candidate.preset.name} content={candidate.preset.content} revision={candidate.preset.revision}/>:<T s={13}>{PERSONALITY_NONE_NOTICE}</T>}
     <T s={13} lh={1.5}>{midTurn?'Este Turno conserva su personalidad. La capa se usará en el siguiente Turno.':'La versión elegida se fija para los siguientes Turnos. No cambia mensajes anteriores ni el modelo.'}</T>
     <Keycap variant="primary" label={busy?'Guardando selección…':'Usar en siguientes Turnos'} disabled={busy||blocked||loading} onPress={()=>void apply()}/><Keycap label="Elegir otra capa" disabled={busy} onPress={()=>setCandidate(null)}/>
    </>}
    {error?<PresetProblem message={error} reload={()=>void load()}/>:null}
    <Keycap label="Gestionar presets del Servidor" disabled={busy} onPress={()=>{if(capture()()){close();router.push({pathname:'/presets/[server]',params:{server:serverId}});}}}/>
   </>}
   <DemoPresetStates reload={()=>{close();demoReload();}}/>
  </PresetSheet>:null}
 </>;
}
