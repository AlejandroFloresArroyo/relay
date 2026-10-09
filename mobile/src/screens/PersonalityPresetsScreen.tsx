import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { router } from 'expo-router';
import { TextInput, View, useWindowDimensions } from 'react-native';
import { useReturn } from '@/state/navigation';
import type { PersonalityPresetCatalog, PersonalityPresetKind, PersonalityPresetSummary, PersonalityPresetVersion } from '../../../protocol/personalityPresets';
import { PERSONALITY_MESSAGES, PERSONALITY_OVERLAY_MAX_BYTES, PERSONALITY_PRESET_MAX_COUNT, PERSONALITY_PRESET_NAME_MAX_CHARACTERS, PERSONALITY_SOUL_MAX_BYTES } from '../../../protocol/personalityPresets';
import { utf8Bytes } from '@/core/agentMemory';
import { conversationRequestId } from '@/core/conversations';
import { RelayError } from '@/core/client';
import { usePersonalityContext } from '@/state/usePersonalityContext';
import { DEMO } from '@/state/app';
import { F, TYPE } from '@/theme/tokens';
import { DetailHeader, RootHeader } from '@/ui/headers';
import { IconKey, Keycap, ListBlock } from '@/ui/kit';
import { PullToRefresh } from '@/ui/gestures';
import { SubjectStateBlock } from '@/ui/states';
import { M, T } from '@/ui/primitives';
import { HomeIndicator, StatusBarSpace } from '@/ui/chrome';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { PresetProblem, PresetRow, PresetSheet } from './PersonalityPresetParts';
import { DemoPresetStates } from './DemoPresetStates';
export function PersonalityPresetsScreen({serverId}:{serverId:string}) {
 const {K}=usePalette();
 const context=usePersonalityContext(serverId,'catalog');
 const [demoRevision,setDemoRevision]=useState(0);
 const reason=context.failure??(context.connection.down?`${context.connection.down.label}. ${context.connection.down.hint}`:context.revoked?'Empareja de nuevo con el Puente para consultar presets.':context.connection.protocol&&context.connection.protocol.kind!=='compatible'?'Actualiza Relay o el Puente antes de consultar presets.':'Este Servidor no está disponible.');
 // The only cause the D-ES sheet names as «SIN ACCESO»; a rejected key or blocked HTTP keep their own diagnosis.
 const lostAccess=context.revoked&&reason.startsWith('DISPOSITIVO REVOCADO');
 const serverName=context.server?.name??'Servidor',ret=useReturn();
 return <View style={{flex:1,backgroundColor:K.background}}><StatusBarSpace/>
  {lostAccess?null:<ServerConnectionStatus serverId={serverId}/>}
  {context.presenting?(context.available?<Catalog key={`${context.generation}:${demoRevision}`} context={context} ret={ret}/>:<>
   <PresetsHeader ret={ret} presenting={context.presenting}/>
   <View style={{padding:12}}>{lostAccess?<SubjectStateBlock spec={{kind:'noAccess',phrase:`Este dispositivo perdió el acceso a ${serverName}.`,action:{label:'Emparejar de nuevo',onPress:()=>router.push({pathname:'/connect',params:{serverId}})}}}/>:<PresetProblem message={reason}/>}</View></>):null}
  {DEMO?<DemoPresetStates reload={()=>setDemoRevision(n=>n+1)}/>:null}<HomeIndicator/>
 </View>;
}
/** Encabezado B «‹ <Servidor>»; with `create` it carries the «+» key, and `subtitle` is the catalogue's count. */
function PresetsHeader({ret,presenting,subtitle,create}:{ret:ReturnType<typeof useReturn>;presenting:boolean;subtitle?:string;create?:ReactNode}) {
 const {K}=usePalette();
 return ret?<DetailHeader back={ret.label} onBack={()=>{if(presenting)ret.go();}} right={create} title="Presets de personalidad" subtitle={subtitle}/>:<><RootHeader title="Presets de personalidad" right={create}/>{subtitle?<M s={9.5} ls={0.04} c={K.inkTertiary} style={{paddingHorizontal:16}}>{subtitle}</M>:null}</>;
}
function Catalog({context,ret}:{context:ReturnType<typeof usePersonalityContext>;ret:ReturnType<typeof useReturn>}) {
 const {K}=usePalette();
 const {client,capture:contextCapture,fail}=context;
 const [catalog,setCatalog]=useState<PersonalityPresetCatalog|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[retry,setRetry]=useState(0);
 const [editor,setEditor]=useState<{original:PersonalityPresetVersion|null}|null>(null),[name,setName]=useState(''),[kind,setKind]=useState<PersonalityPresetKind>('overlay'),[content,setContent]=useState(''),[deletion,setDeletion]=useState(false),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false);
 const mounted=useRef(true),pending=useRef(false),dialogEpoch=useRef(0),{width}=useWindowDimensions();
 useEffect(()=>()=>{mounted.current=false;settle.current?.();settle.current=null;},[]);
 const capture=()=>{const current=context.capture(),epoch=dialogEpoch.current;return()=>mounted.current&&epoch===dialogEpoch.current&&current();};
 function close(){dialogEpoch.current++;setEditor(null);setDeletion(false);setName('');setContent('');}
 const settle=useRef<(()=>void)|null>(null);
 function refresh(){return new Promise<void>(resolve=>{if(pending.current){resolve();return;}settle.current=resolve;reload();});}
 function reload(){if(pending.current)return;close();setCatalog(null);setError(null);setBlocked(false);setLoading(true);setRetry(n=>n+1);}
 useEffect(()=>{let alive=true;const current=contextCapture();void(async()=>{try{if(!client.personalityPresets)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await client.personalityPresets();if(alive&&current())setCatalog(value);}catch(e){const message=fail(e);if(alive&&current())setError(message);}finally{if(alive&&current())setLoading(false);if(alive){settle.current?.();settle.current=null;}}})();return()=>{alive=false;};},[client,contextCapture,fail,retry]);
 async function edit(preset:PersonalityPresetSummary){if(pending.current||blocked)return;dialogEpoch.current++;const guard=capture();if(!guard())return;pending.current=true;setBusy(true);setError(null);setNotice(null);try{if(!context.client.personalityPreset)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);const value=await context.client.personalityPreset(preset.id,preset.revision);if(!guard())return;setName(value.name);setContent(value.content);setKind(value.kind);setEditor({original:value});setBlocked(false);}catch(e){const message=context.fail(e);if(guard())setError(message);}finally{pending.current=false;if(mounted.current)setBusy(false);}}
 function create(){if(!catalog||pending.current||blocked||!capture()())return;dialogEpoch.current++;setName('');setContent('');setKind('overlay');setEditor({original:null});setBlocked(false);setError(null);setNotice(null);}
 const max=kind==='soul'?PERSONALITY_SOUL_MAX_BYTES:PERSONALITY_OVERLAY_MAX_BYTES;
 const invalid=!name.trim()||[...name.trim()].length>PERSONALITY_PRESET_NAME_MAX_CHARACTERS||utf8Bytes(content)>max||/[\u0000-\u001f\u007f]/.test(name);
 async function store(remove=false){
  if(!editor||!catalog||pending.current||blocked||(!remove&&invalid))return;const guard=capture();if(!guard())return;const original=editor.original;pending.current=true;setBusy(true);setError(null);setNotice(null);
  try {
   const requestId=conversationRequestId();
   if(remove){if(!original||!deletion||!context.client.deletePersonalityPreset)return;await context.client.deletePersonalityPreset(original.id,{requestId,revision:original.revision});}
   else if(original){if(!context.client.updatePersonalityPreset)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);await context.client.updatePersonalityPreset(original.id,{requestId,revision:original.revision,name:name.trim(),content});}
   else {if(!context.client.createPersonalityPreset)throw new RelayError('personality_unavailable',PERSONALITY_MESSAGES.personality_unavailable);await context.client.createPersonalityPreset({requestId,catalogRevision:catalog.revision,name:name.trim(),kind,content});}
   if(!guard())return;close();setNotice(remove?'Preset borrado.':'Preset guardado.');setCatalog(null);setLoading(true);setRetry(n=>n+1);
  }catch(e){const message=context.fail(e);if(guard()){setBlocked(true);setError(message);}}
  finally{pending.current=false;if(mounted.current)setBusy(false);}
 }
const atMax=!!catalog&&catalog.presets.length>=PERSONALITY_PRESET_MAX_COUNT;
 const editable=!busy&&!blocked;
 return <View style={{flex:1}}>
  <PresetsHeader ret={ret} presenting={context.presenting} subtitle={catalog?`${catalog.presets.length} / ${PERSONALITY_PRESET_MAX_COUNT} PRESETS · VERSIONES INMUTABLES`:undefined} create={<IconKey round glyph="+" accessibilityLabel="Crear preset" disabled={!catalog||busy||blocked||atMax} onPress={create}/>}/>
  <PullToRefresh onRefresh={refresh} style={{alignSelf:'center',width:'100%',maxWidth:width>=840?960:620}} contentContainerStyle={{gap:12,paddingBottom:18}}>
   <T {...TYPE.secondary} c={K.inkSecondary} lh={1.45} style={{paddingHorizontal:16}}>El catálogo es de este Servidor. Un preset SOUL reemplaza la personalidad del Agente; una capa de Relay se fija por Conversación y vale para sus siguientes Turnos.</T>
   {loading?<View style={{marginHorizontal:12}}><SubjectStateBlock spec={{kind:'loading',what:'presets'}}/></View>:null}
   {!loading&&catalog?.presets.length===0?<View style={{marginHorizontal:12}}><SubjectStateBlock spec={{kind:'empty',title:'SIN PRESETS',phrase:'Todavía no hay presets en este Servidor.'}}/></View>:null}
   {catalog&&catalog.presets.length>0?<ListBlock>{catalog.presets.map(p=><PresetRow key={p.id} preset={p} disabled={!editable} onPress={()=>void edit(p)}/>)}</ListBlock>:null}
   {notice?<T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}} accessibilityLiveRegion="polite">{notice}</T>:null}
   {error&&!editor?<View style={{marginHorizontal:12}}><PresetProblem message={error} reload={reload}/></View>:null}
  </PullToRefresh>
  {editor?<PresetSheet title={deletion?'Borrar preset':editor.original?'Editar preset':'Crear preset'} close={close}>
   {deletion?<><T s={15} lh={1.5} c={K.ink}>¿Borrar «{editor.original?.name}» del catálogo? Las versiones ya fijadas en Conversaciones se conservan. No se cambia ningún SOUL.</T><Keycap variant="primary" disabled={!editable} label={busy?'Borrando…':'Confirmar borrado'} onPress={()=>void store(true)}/><Keycap disabled={busy} label="Conservar preset" onPress={()=>setDeletion(false)}/></>:<>
    <T {...TYPE.secondary} c={K.inkTertiary}>Nombre</T><TextInput accessibilityLabel="Nombre del preset" value={name} onChangeText={setName} editable={editable} maxLength={200} style={{borderRadius:12,backgroundColor:K.field,padding:12,fontFamily:F.sans['400'],fontSize:16,color:K.ink}}/>
    <View style={{flexDirection:'row',gap:8}}>{(['soul','overlay'] as const).map(value=><Keycap key={value} style={{flex:1}} variant={kind===value?'primary':'normal'} disabled={!!editor.original||!editable} label={value==='soul'?'SOUL del Agente':'Capa de Relay'} onPress={()=>setKind(value)}/>)}</View>
    <T {...TYPE.secondary} c={K.inkTertiary}>Contenido completo · {kind==='soul'?'máximo 1 MiB':'máximo 64 KiB'}</T><TextInput accessibilityLabel="Contenido del preset" multiline value={content} onChangeText={setContent} editable={editable} textAlignVertical="top" selectionColor={K.accent} style={{minHeight:170,maxHeight:340,backgroundColor:K.screen,borderRadius:16,padding:14,color:K.onScreenBright,fontFamily:F.mono['400'],fontSize:12,lineHeight:21}}/>
    <M s={9.5} c={utf8Bytes(content)>max?K.dangerText:K.inkTertiary}>{utf8Bytes(content)} / {max} bytes</M>
    {editor.original?<M s={9.5} c={K.inkTertiary} selectable>Versión · {editor.original.revision}</M>:null}
    <T {...TYPE.secondary} c={K.inkTertiary}>Guardar crea una versión. No la aplica a ningún Agente ni Conversación.</T>
    <Keycap variant="primary" disabled={!editable||invalid} label={busy?'Guardando…':'Guardar preset'} onPress={()=>void store()}/>
    {editor.original?<Keycap variant="danger" disabled={!editable} label="Borrar preset" onPress={()=>setDeletion(true)}/>:null}
   </>}
   {error?<PresetProblem message={error} reload={reload}/>:null}
  </PresetSheet>:null}
 </View>;
}
