import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { AgentSoul } from '../../../protocol/agentMemory';
import type { PersonalityPresetCatalog, PersonalityPresetRef, SoulPresetPreview } from '../../../protocol/personalityPresets';
import { PERSONALITY_CONTEXT_NOTICE, PERSONALITY_MESSAGES, PERSONALITY_PRESET_NAME_MAX_CHARACTERS } from '../../../protocol/personalityPresets';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { RelayError } from '@/core/client';
import { DEMO, useApp } from '@/state/app';
import { demoPresetFingerprintAllowed } from '@/core/demoPresets';
import { useAgentDocument } from '@/state/useAgentDocument';
import { usePersonalityContext } from '@/state/usePersonalityContext';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { conversationRequestId as requestId } from '@/core/conversations';
import { Keycap, ListBlock, ListRow } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { DemoPresetStates } from './DemoPresetStates';
import { PresetContent, PresetProblem, PresetRow, PresetSheet, sheetBlock } from './PersonalityPresetParts';
type Doc=ReturnType<typeof useAgentDocument<AgentSoul>>;
export function SoulPresetControl({serverId,agentId,doc}:{serverId:string;agentId:string;doc:Doc}) {
 const context=usePersonalityContext(serverId,agentId);
 const [demoRevision,setDemoRevision]=useState(0);
 if(!context.presenting)return null;
 return <>{context.failure?<PresetProblem message={context.failure}/>:null}<SoulControl key={`${context.generation}:${demoRevision}`} serverId={serverId} agentId={agentId} doc={doc} context={context} demoReload={()=>{doc.reload();setDemoRevision(n=>n+1);}}/></>;
}
function samePreview(a:SoulPresetPreview,b:SoulPresetPreview){return a.agentId===b.agentId&&a.preset.id===b.preset.id&&a.preset.revision===b.preset.revision&&a.preset.content===b.preset.content&&a.soul.revision===b.soul.revision&&a.soul.content===b.soul.content&&a.soul.writable===b.soul.writable&&a.soul.exists===b.soul.exists&&a.soul.contextLimit===b.soul.contextLimit&&a.soul.reason===b.soul.reason;}
function SoulControl({serverId,agentId,doc,context,demoReload}:{serverId:string;agentId:string;doc:Doc;context:ReturnType<typeof usePersonalityContext>;demoReload:()=>void}) {
 const {K}=usePalette();
 const serverName=useApp().servers.find(x=>x.id===serverId)?.name??serverId;
 const [open,setOpen]=useState(false),[catalog,setCatalog]=useState<PersonalityPresetCatalog|null>(null),[preview,setPreview]=useState<SoulPresetPreview|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
 const pending=useRef(false),mounted=useRef(true),dialogEpoch=useRef(0);
 useEffect(()=>()=>{mounted.current=false;},[]);
 const capture=()=>{const current=context.capture(),epoch=dialogEpoch.current;return()=>mounted.current&&epoch===dialogEpoch.current&&current();};
 async function load(){dialogEpoch.current++;const guard=capture();if(!guard())return;setOpen(true);setCatalog(null);setPreview(null);setError(null);setLoading(true);try{if(!context.client.personalityPresets)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await context.client.personalityPresets();if(guard())setCatalog(value);}catch(e){const message=context.fail(e);if(guard())setError(message);}finally{if(guard())setLoading(false);}}
 async function select(ref:PersonalityPresetRef){const guard=capture();if(!guard()||loading)return;setLoading(true);setError(null);try{if(!context.client.soulPresetPreview)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await context.client.soulPresetPreview(agentId,{id:ref.id,revision:ref.revision});if(guard())setPreview(value);}catch(e){const message=context.fail(e);if(guard())setError(message);}finally{if(guard())setLoading(false);}}
 async function apply(){
  if(!preview||pending.current||loading||doc.readOnly||!preview.soul.writable)return;
  const guard=capture(),shown=preview;if(!guard())return;pending.current=true;setError(null);
  try {
   const saved=await doc.write(async(client,_current,documentGuard)=>{
    const valid=()=>guard()&&documentGuard()&&client===context.client;
    try {
    if(!valid()||!client.soulPresetPreview||!client.applySoulPreset)return null;
    const fresh=await client.soulPresetPreview(agentId,{id:shown.preset.id,revision:shown.preset.revision});if(!valid())return null;
    if(!samePreview(shown,fresh)){setPreview(fresh);setError('SOUL cambió. Revisa la nueva vista previa y confirma de nuevo.');return null;}
    const confirmed=DEMO&&!demoPresetFingerprintAllowed()?false:await confirmWithFingerprint('Reemplazar SOUL con huella',valid);if(!valid())return null;
    if(!confirmed){setError('Huella no confirmada. Nada se guardó.');return null;}
    const latest=await client.soulPresetPreview(agentId,{id:shown.preset.id,revision:shown.preset.revision});if(!valid())return null;
    if(!samePreview(shown,latest)){setPreview(latest);setError('SOUL cambió. Revisa la nueva vista previa y confirma de nuevo.');return null;}
    // Only a rejection the Puente answered before writing is definitive; anything else may have replaced SOUL.
    const result=await client.applySoulPreset(agentId,{requestId:requestId(),presetId:shown.preset.id,presetRevision:shown.preset.revision,soulRevision:shown.soul.revision}).catch((error:unknown)=>{
     if(error instanceof RelayError&&(error.code==='personality_invalid'||[400,401,403,404,409,426,429].includes(error.status??0)))throw error;
     throw new RelayError('personality_uncertain',PERSONALITY_MESSAGES.personality_uncertain);
    });
    if(!valid())return null;if(result.soul.content!==shown.preset.content)throw new RelayError('personality_uncertain',PERSONALITY_MESSAGES.personality_uncertain);return result.soul;
    }catch(error){context.fail(error);throw error;}
   });
   if(saved&&guard())setOpen(false);
  }finally{pending.current=false;}
 }
 // Script step 6.1: the SOUL on screen becomes a new catalogue preset. It changes no SOUL, so no huella.
 const [saving,setSaving]=useState<{content:string;revision:string}|null>(null),[catalogRevision,setCatalogRevision]=useState<string|null>(null),[name,setName]=useState(''),[saveError,setSaveError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[saveBusy,setSaveBusy]=useState(false),[saveBlocked,setSaveBlocked]=useState(false);
 const saveEpoch=useRef(0);
 const captureSave=()=>{const current=context.capture(),epoch=saveEpoch.current;return()=>mounted.current&&epoch===saveEpoch.current&&current();};
 const invalidName=!name.trim()||[...name.trim()].length>PERSONALITY_PRESET_NAME_MAX_CHARACTERS||/[\u0000-\u001f\u007f]/.test(name);
 function closeSave(){saveEpoch.current++;setSaving(null);setCatalogRevision(null);setName('');setSaveError(null);setSaveBlocked(false);}
 async function openSave(){
  const data=doc.data;if(!data)return;
  closeSave();const guard=captureSave();if(!guard())return;setNotice(null);setSaving({content:data.content,revision:data.revision});setSaveBusy(true);
  try{if(!context.client.personalityPresets)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await context.client.personalityPresets();if(guard())setCatalogRevision(value.revision);}
  catch(e){const message=context.fail(e);if(guard())setSaveError(message);}
  finally{if(mounted.current)setSaveBusy(false);}
 }
 async function save(){
  if(!saving||!catalogRevision||pending.current||saveBlocked||invalidName)return;const guard=captureSave();if(!guard())return;pending.current=true;setSaveBusy(true);setSaveError(null);
  try{
   if(!context.client.createPersonalityPreset)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);
   await context.client.createPersonalityPreset({requestId:requestId(),catalogRevision,name:name.trim(),kind:'soul',content:saving.content});
   if(!guard())return;closeSave();setNotice('Preset guardado.');
  }catch(e){const message=context.fail(e);if(guard()){setSaveBlocked(true);setSaveError(message);}}
  finally{pending.current=false;if(mounted.current)setSaveBusy(false);}
 }
 const saveSoulDisabled=!context.available||doc.readOnly||!doc.data?.exists||saveBusy;
 const applyDisabled=!context.available||doc.readOnly||!doc.data?.writable;
 return <><ListBlock>
  <ListRow title="Aplicar preset SOUL" chevron disabled={applyDisabled} onPress={()=>void load()}/>
  <ListRow title="Guardar SOUL actual como preset" chevron disabled={saveSoulDisabled} onPress={()=>void openSave()}/>
 </ListBlock>
 {notice?<T s={13} c={K.ink} accessibilityLiveRegion="polite" style={{paddingHorizontal:16}}>{notice}</T>:null}
 <Pressable accessibilityRole="button" accessibilityState={{disabled:context.revoked}} disabled={context.revoked} onPress={()=>router.push({pathname:'/presets/[server]',params:{server:serverId}})}
  style={{marginHorizontal:12,minHeight:56,paddingHorizontal:12,paddingVertical:8,borderRadius:RADIUS.block,boxShadow:`0px 0px 0px 1.5px ${K.onScreenLabel}`,flexDirection:'row',alignItems:'center',gap:12,opacity:context.revoked?0.45:1}}>
  <View style={{flex:1,gap:2}}><T {...TYPE.body} c={K.ink}>Presets de personalidad</T><M s={9.5} ls={0.04} c={K.inkTertiary}>EN SERVIDORES › {serverName.toUpperCase()}</M></View>
  <T s={18} c={K.inkTertiary}>›</T>
 </Pressable>
 {open&&context.available&&doc.visible?<PresetSheet title={preview?'Reemplazar personalidad':'Elegir preset SOUL'} close={()=>{dialogEpoch.current++;setOpen(false);setPreview(null);}}>
  {loading?<M {...TYPE.label} c={K.inkTertiary}>CARGANDO PRESETS…</M>:null}
  {!preview&&catalog?.presets.some(p=>p.kind==='soul')?<ListBlock style={sheetBlock(K)}>{catalog.presets.filter(p=>p.kind==='soul').map(p=><PresetRow key={p.id} preset={p} disabled={loading} onPress={()=>void select(p)}/>)}</ListBlock>:null}
  {!loading&&catalog&&!preview&&!catalog.presets.some(p=>p.kind==='soul')?<T>No hay presets SOUL. Crea uno en el catálogo del Servidor.</T>:null}
  {preview?<><PresetContent title="SOUL" content={preview.soul.content} revision={preview.soul.revision}/><PresetContent title="Preset" content={preview.preset.content} revision={preview.preset.revision}/><T s={12} c={K.inkSecondary}>{PERSONALITY_CONTEXT_NOTICE} Relay conserva respaldo y registro en el Servidor.</T>
   {!preview.soul.writable?<T s={12} c={K.dangerText}>El SOUL de este Agente es de solo lectura.</T>:null}
   <Keycap variant="primary" label={doc.busy?'Confirmando…':'Reemplazar con huella'} disabled={doc.busy||doc.readOnly||loading||!preview.soul.writable} onPress={()=>void apply()}/></>:null}
  <DemoPresetStates reload={demoReload}/>
  {error||doc.error?<PresetProblem message={error??doc.error!} reload={()=>{doc.reload();void load();}}/>:null}
 </PresetSheet>:null}
 {saving&&context.available&&doc.visible?<PresetSheet title="Guardar SOUL actual como preset" close={closeSave}>
  <T s={12} c={K.inkSecondary}>Nombre</T><TextInput accessibilityLabel="Nombre del preset" value={name} onChangeText={setName} editable={!saveBusy&&!saveBlocked} maxLength={200} style={{borderRadius:12,backgroundColor:K.field,padding:12,fontFamily:F.sans['400'],fontSize:16,color:K.ink}}/>
  <PresetContent title="SOUL actual" content={saving.content} revision={saving.revision}/>
  <T s={12} c={K.inkSecondary}>Guardar crea un preset SOUL en el catálogo del Servidor con este texto. No cambia el SOUL de ningún Agente.</T>
  <Keycap variant="primary" label={saveBusy?'Guardando…':'Guardar preset'} disabled={saveBusy||saveBlocked||invalidName||!catalogRevision} onPress={()=>void save()}/>
  {saveError?<PresetProblem message={saveError}/>:null}
 </PresetSheet>:null}</>;
}
