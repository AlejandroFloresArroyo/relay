import { usePalette } from '@/theme/ThemeProvider';
import { usePersonalityContext } from '@/state/usePersonalityContext';
import { PresetProblem } from './PersonalityPresetParts';
import { SoulPresetControl } from './SoulPresetControl';
import { DemoDocumentStates } from './DemoDocumentStates';
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import type { AgentSoul } from '../../../protocol/agentMemory';
import { AGENT_MEMORY_MAX_BYTES } from '../../../protocol/agentMemory';
import { utf8Bytes } from '@/core/agentMemory';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { useAgentDocument } from '@/state/useAgentDocument';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { Keycap, SectionHeader } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { AgentDocumentChrome, DocumentCacheNotice, DocumentMissing, DocumentState, CONTEXT_REBUILD_NOTICE } from './AgentDocumentChrome';
export function AgentSoulScreen(props:{serverId:string;agentId:string}) {
  const context=usePersonalityContext(props.serverId,props.agentId);
  if(context.revoked)return <AgentDocumentChrome serverId={props.serverId} title="Personalidad" subtitle={`${props.agentId.toUpperCase()} · SOUL.md`}><View style={{padding:12}}><PresetProblem message={context.failure??'Empareja de nuevo con el Puente para consultar personalidad.'}/></View></AgentDocumentChrome>;
  return <SoulDocument {...props}/>;
}
function SoulDocument({serverId,agentId}:{serverId:string;agentId:string}) {
  const { K } = usePalette();
  const doc=useAgentDocument<AgentSoul>(serverId,agentId,'soul');
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState('');
  const [revision,setRevision]=useState('');
  const [notice,setNotice]=useState<string|null>(null);
  const agentName=doc.connection.agents.find(a=>a.id===agentId)?.name??agentId;
  const serverName=doc.server?.name??'el Servidor';
  const data=doc.data;
  const oversized=utf8Bytes(draft)>AGENT_MEMORY_MAX_BYTES;
  async function store() {
    setNotice(null);
    const saved=await doc.write(async(client,_current,guard)=>{
      const confirmed=await confirmWithFingerprint('Guardar personalidad con huella');
      if(!confirmed){setNotice('Huella no confirmada. Nada se guardó.');return null;}
      if(!guard()){return null;}
      return client.changeAgentSoul(agentId,{revision,content:draft});
    });
    if(saved)setEditing(false);
  }
  return <AgentDocumentChrome serverId={serverId} title="Personalidad" subtitle={`${agentId.toUpperCase()} · SOUL.md`}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{paddingTop:4,paddingBottom:16,gap:12}} style={{flex:1}}>
      <View style={{paddingHorizontal:12,gap:12}}>
        {data&&(doc.cached||doc.offline)?<DocumentCacheNotice at={data.capturedAt}/>:null}
        {!data?<DocumentState kind="soul" loading={doc.loading} offline={doc.offline} serverName={serverName} reload={doc.reload}/>:null}
        {data&&!data.exists?<DocumentMissing kind="soul" agentName={agentName} serverName={serverName}/>:null}
      </View>
      {data?<>
        {data.exists||editing?<>
          {!editing?<SectionHeader title="SOUL.md · IDENTIDAD PRINCIPAL EN EL AGENTE"/>:null}
          <RecessedScreen radius={RADIUS.block} rim={editing} style={{marginHorizontal:12,padding:16,gap:14,maxHeight:editing?undefined:360}}>
            {editing?<TextInput accessibilityLabel="Texto de SOUL.md" multiline editable={!doc.busy&&!doc.readOnly&&data.writable} value={draft} onChangeText={setDraft} selectionColor={K.accent} textAlignVertical="top" style={{minHeight:220,color:K.onScreenBright,fontFamily:F.mono['400'],fontSize:13,lineHeight:21,padding:0}}/>:
              <ScrollView nestedScrollEnabled><M s={12.5} lh={1.55} c={K.onScreenBright}>{data.content||'SOUL.md está vacío.'}</M></ScrollView>}
            {!editing?<M s={9.5} c={K.onScreenLabel}>{data.content?data.content.split('\n').length:0} LÍNEAS</M>:null}
          </RecessedScreen>
        </>:<T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>SOUL.md todavía no existe. Se creará al guardar.</T>}
        {!editing&&!doc.readOnly&&data.writable?<View style={{paddingHorizontal:12,flexDirection:'row'}}><Keycap label="Editar" style={{flex:1}} onPress={()=>{setDraft(data.content);setRevision(data.revision);setEditing(true);setNotice(null);}}/></View>:null}
        <T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>{CONTEXT_REBUILD_NOTICE} {editing?'Relay guarda la versión anterior en el Servidor.':''}</T>
        <M s={9.5} c={K.inkTertiary} style={{paddingHorizontal:16}}>{editing?[...draft].length:data.characters} caracteres · límite de contexto {data.contextLimit===null?'no conocido':data.contextLimit}</M>
        {data.contextLimit!==null && [...(editing?draft:data.content)].length>data.contextLimit?<T {...TYPE.secondary} c={K.accentText} style={{paddingHorizontal:16}}>Hermes truncará este archivo al cargarlo en el contexto. Puedes guardar el texto completo.</T>:null}
        {data.reason?<T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>{data.reason}</T>:null}
        {oversized&&editing?<T {...TYPE.secondary} c={K.dangerText} style={{paddingHorizontal:16}}>El archivo supera el máximo de 1 MiB que admite el Puente.</T>:null}
        {doc.error?<View style={{marginHorizontal:12,padding:12,gap:4,borderRadius:RADIUS.block,backgroundColor:K.block,boxShadow:K.shadowBlock}}><T {...TYPE.secondary} c={K.dangerText}>{doc.error}</T><Keycap variant="link" label="Recargar" disabled={doc.busy} onPress={doc.reload} style={{alignSelf:'flex-start'}}/></View>:null}
        {notice?<T {...TYPE.secondary} c={K.dangerText} style={{paddingHorizontal:16}}>{notice}</T>:null}
        {editing?<View style={{marginHorizontal:12,flexDirection:'row',gap:8}}><Keycap label="Cancelar" style={{flex:1}} disabled={doc.busy} onPress={()=>setEditing(false)}/><Keycap variant="primary" style={{flex:1.4}} label={doc.busy?'Guardando…':'Guardar con huella'} disabled={doc.busy||doc.readOnly||!data.writable||oversized} onPress={()=>void store()}/></View>:null}
      </>:null}
      {doc.readOnly&&!doc.loading&&data?<View style={{paddingHorizontal:12}}><Keycap variant="link" label="Reintentar" onPress={doc.reload} style={{alignSelf:'flex-start'}}/></View>:null}
      {!editing?<SoulPresetControl serverId={serverId} agentId={agentId} doc={doc}/>:null}
    </ScrollView>
    <DemoDocumentStates reload={doc.reload}/>
  </AgentDocumentChrome>;
}
