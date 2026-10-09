import { ConnectionStatus } from '@/ui/ConnectionStatus';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { WorkRow, WorkTile, type Travel } from './WorkCard';
import { DemoWorkStates } from './DemoWorkStates';
import { demoWorkScenario, type WorkDemoScenario } from '@/core/demoKanban';
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { KANBAN_COLUMNS, KANBAN_COMMENT_MAX_BYTES, type KanbanColumn, type KanbanItem } from '../../../protocol/kanban';
import { WORK_COLUMNS, dragTarget, nextColumn, notificationLabel, validateWorkDraft, validateWorkText, validateWorkNotification, type WorkDraft } from '@/core/kanban';
import { WORK_MESSAGES } from '@/core/kanbanClient';
import { conversationRequestId } from '@/core/conversations';
import { useWork } from '@/state/work';
import { DEMO, useApp } from '@/state/app';
import { F, RADIUS, TYPE, ledGlow } from '@/theme/tokens';
import { usePalette } from '@/theme/ThemeProvider';
import { StatusBarSpace, useBottomInset } from '@/ui/chrome';
import { PullToRefresh } from '@/ui/gestures';
import { RootHeader } from '@/ui/headers';
import { IconKey, Lamp, ListBlock, SectionHeader, type LampTone } from '@/ui/kit';
import { ShellNavigationContext } from '@/ui/layoutContext';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { HeaderServerSelector } from '@/ui/ServerSelector';
import { StateRow, SubjectStateBlock } from '@/ui/states';

/** Gap between the tablet's five columns, and the counters' LEDs and short names (D-17). */
const COLUMN_GAP = 12;
const COUNTER_LAMP: Record<KanbanColumn, LampTone> = { todo: 'off', in_progress: 'orange', review: 'off', blocked: 'red', done: 'green' };
const COUNTER_LABEL: Record<KanbanColumn, string> = { todo: 'HACER', in_progress: 'CURSO', review: 'REVIS.', blocked: 'BLOQ.', done: 'HECHO' };

// Credential rotation is handled inside useWork; origin/device changes also retire all drafts.
export function WorkScreen({serverId}: {serverId:string}) {
 const {servers}=useApp();
 const server=servers.find(s=>s.id===serverId);
 const [scenario,setScenario]=useState<WorkDemoScenario>(()=>demoWorkScenario(serverId));
 return <WorkContent key={JSON.stringify([serverId,server?.url,server?.deviceId,DEMO?scenario:'real'])} serverId={serverId} demo={DEMO?<DemoWorkStates serverId={serverId} scenario={scenario} onSelect={setScenario}/>:null}/>;
}
type Editor = {owner:unknown;item:KanbanItem|null;draft:WorkDraft;permission:()=>boolean;requestId:string};
type Preview = {owner:unknown;requestId:string;input:string;item:KanbanItem;permission:()=>boolean};
function WorkContent({serverId,demo}: {serverId:string;demo:ReactNode}) {
 const {K}=usePalette();
 const work=useWork(serverId);
 const bottom=useBottomInset(26);
 const tablet=useContext(ShellNavigationContext);
 const {width}=useWindowDimensions();
 const [paneWidth,setPaneWidth]=useState<number|null>(null);
 // Five columns share the pane between the 12 px side margins; a Tarjeta moves one column per `stride` of travel.
 const stride=((paneWidth ?? width)-24-4*COLUMN_GAP)/5+COLUMN_GAP;
 const [editor,setEditor]=useState<Editor|null>(null);
 const [noticeText,setNoticeText]=useState<string|null>(null);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [comment,setComment]=useState('');
 const [validation,setValidation]=useState<string|null>(null);
 const [boardHeight,setBoardHeight]=useState(0);
 const [target,setTarget]=useState<KanbanColumn|null>(null);
 const lifted=useRef<(()=>boolean)|null>(null);
 const column=work.preferences.column;
 const items=work.page?.items.filter(item=>item.column===column) ?? [];
 const chosen=work.detail?.item ?? work.page?.items.find(item=>item.id===work.selected);
 const agents=work.snap.agents;
 const writable=work.writable && !work.busy;
 const editableDetail=writable && !!work.detail;
 const receipt=work.notice ?? work.detail?.latestNotification ?? null;
 const noticeBusy=work.attempt || receipt?.state==='pending' || receipt?.state==='uncertain'
   || receipt?.state==='started' && (!receipt.turn || !['completed','failed','cancelled'].includes(receipt.turn.phase));
 useLayoutEffect(()=>{
   let active=true;
   void Promise.resolve().then(()=>{if(active){setEditor(null);setPreview(null);setNoticeText(null);setComment('');setValidation(null);setTarget(null);lifted.current=null;}});
   return ()=>{active=false;};
 },[work.client,work.scope.visible,work.scope.revision]);
 useLayoutEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)setPreview(null);});return ()=>{active=false;};},[work.detail?.item.revision,work.selected]);
 function openEditor(item:KanbanItem|null,draft?:WorkDraft) {
   const permission=work.scope.begin();
   if (!writable || !permission) return;
   setEditor({owner:work.client,item,draft:draft ?? (item ? {title:item.title,agentId:item.agentId,column:item.column,blockedBy:[...item.blockedBy]} : {title:'',agentId:null,column,blockedBy:[]}),permission,requestId:conversationRequestId()});setValidation(null);
 }
 async function saveEditor(reviewNotice=false) {
   if (!editor || !work.api || !editor.permission() || !writable) {setEditor(null);return;}
   const draft={...editor.draft,title:editor.draft.title.trim()};
   const error=validateWorkDraft(draft,agents.map(a=>a.id),work.page?.items ?? [],editor.item?.id);
   if (error) {setValidation(error);return;}
   const target=editor;
   const saved=await work.metadata(()=>target.item
     ? work.api!.update(target.item.id,{requestId:target.requestId,revision:target.item.revision,...draft})
     : work.api!.create({requestId:target.requestId,...draft}),target.permission);
   if (!saved) return;
   setEditor(null);setComment('');setValidation(null);
   if (reviewNotice) setNoticeText(saved.item.title);
 }
 async function move(item:KanbanItem,next:KanbanColumn,dropPermission?:()=>boolean) {
   if (!work.api || !writable || item.column===next || dropPermission && !dropPermission()) return;
   if (next==='blocked' && !item.blockedBy.length) {openEditor(item,{...item,column:next});return;}
   const permission=dropPermission ?? work.scope.begin();
   await work.metadata(()=>work.api!.update(item.id,{requestId:conversationRequestId(),revision:item.revision,column:next}),permission);
 }
 async function publishComment() {
   if (!work.api || !work.detail || !editableDetail) return;
   const error=validateWorkText(comment,KANBAN_COMMENT_MAX_BYTES);
   if (error) {setValidation(error);return;}
   const item=work.detail.item,text=comment,permission=work.scope.begin();
   const saved=await work.metadata(()=>work.api!.comment(item.id,{requestId:conversationRequestId(),revision:item.revision,text}),permission);
   if (saved) {setComment('');setValidation(null);}
 }
 function review() {
   if (!work.detail || !editableDetail || noticeText===null || noticeBusy) return;
   const requestId=conversationRequestId();
   const error=validateWorkNotification({requestId,revision:work.detail.item.revision,agentId:work.detail.item.agentId ?? '',input:noticeText});
   if (error) {setValidation(error);return;}
   const permission=work.scope.begin();
   if (permission) {setPreview({owner:work.client,requestId,input:noticeText,item:work.detail.item,permission});setValidation(null);}
 }
 async function send() {
   if (!preview || !preview.permission() || !editableDetail || !preview.item.agentId || noticeBusy) {setPreview(null);return;}
   const target=preview;
   // Only this explicit confirmation calls the backend notice endpoint. Never create a local Conversation.
   setPreview(null);setNoticeText(null);
   await work.notify({requestId:target.requestId,revision:target.item.revision,agentId:target.item.agentId!,input:target.input},target.permission);
 }
 const updateDraft=(patch:Partial<WorkDraft>)=>setEditor(previous=>previous?{...previous,draft:{...previous.draft,...patch},requestId:conversationRequestId()}:null);
 const agentName=(id:string|null)=>agents.find(a=>a.id===id)?.name ?? (id?'Agente no disponible':'Sin asignar');
 const formError=validation ?? work.error;
 const blockers=(item:KanbanItem)=>item.blockedBy.map(blocker=>`#${work.page?.items.find(i=>i.id===blocker)?.number ?? '?'}`).join(', ');
 const cardProps=(item:KanbanItem)=>({item,name:agentName(item.agentId),blockerNumbers:blockers(item),fresh:work.fresh,writable,open:()=>{work.select(item.id);setValidation(null);}});
 const lift=()=>{lifted.current=writable?work.scope.begin():null;};
 const reach=(item:KanbanItem,travel:Travel)=>dragTarget(item.column,travel.dx,stride,{...travel,board:boardHeight});
 function drop(item:KanbanItem,travel:Travel) {
   const permission=lifted.current;lifted.current=null;setTarget(null);
   const next=reach(item,travel);
   if (permission && next && permission()) void move(item,next,permission);
 }
 return <View accessibilityLabel="Trabajo del Servidor" onLayout={event=>{const next=event.nativeEvent.layout.width;if(Number.isFinite(next)&&next>0)setPaneWidth(next);}} style={{flex:1,backgroundColor:K.background}}>
 <StatusBarSpace/>
 <RootHeader title="Trabajo" right={<><HeaderServerSelector/><IconKey round glyph="+" accessibilityLabel="Crear elemento" disabled={!writable} onPress={()=>openEditor(null)}/></>}/>
 <PullToRefresh onRefresh={work.reloaded} contentContainerStyle={{gap:12,paddingTop:4,paddingBottom:24}}>
  {work.diagnosis && work.diagnosis !== work.snap.down
   ? work.diagnosis.kind==='unreachable'
    ? <View style={{paddingVertical:4}}><StateRow name={work.server?.name ?? 'Servidor'} kind="unreachable" onRetry={work.reload}/></View>
    : <ConnectionStatus serverName={work.server?.name ?? 'Servidor'} diagnosis={work.diagnosis} onRetry={work.reload} onPair={()=>router.push({pathname:'/connect',params:{serverId}})}/>
   : <ServerConnectionStatus serverId={serverId}/>}
  {work.loading && !work.page ? <View style={{paddingHorizontal:12}}><SubjectStateBlock spec={{kind:'loading',what:'trabajo'}}/></View> : null}
  {work.error && !work.diagnosis ? work.page
   ? <T {...TYPE.secondary} c={K.dangerText} style={{paddingHorizontal:16}}>{work.error}</T>
   : <View style={{paddingHorizontal:12}}><SubjectStateBlock spec={work.error===WORK_MESSAGES.kanban_unsupported
    ? {kind:'unavailable',phrase:`El Puente de ${work.server?.name ?? 'este Servidor'} no ofrece Trabajo.`}
    : {kind:'error',verb:'cargar Trabajo',onRetry:work.reload}}/></View> : null}
  {work.page && !work.fresh ? <View style={{marginHorizontal:12,padding:12,gap:4,borderRadius:RADIUS.key,backgroundColor:K.block,boxShadow:K.shadowBlock}}><M s={9.5} w="600" ls={0.08} c={K.accentText}>ÚLTIMA COPIA · SOLO LECTURA</M><T {...TYPE.secondary} c={K.inkSecondary}>{new Date(work.page.observedAt).toLocaleString('es-ES')}</T><T {...TYPE.secondary} c={K.inkSecondary}>Sin cambios ni envíos automáticos al reconectar.</T></View> : null}
  {work.fresh && !work.page?.items.length ? <View style={{paddingHorizontal:12}}><SubjectStateBlock spec={{kind:'empty',title:'TRABAJO VACÍO',phrase:'Crea elementos y asígnalos. Avisar a un Agente requiere otra acción.'}}/></View> : null}
  {tablet ? <View testID="work-board" onLayout={event=>setBoardHeight(event.nativeEvent.layout.height)} style={{flexDirection:'row',alignItems:'flex-start',gap:COLUMN_GAP,marginHorizontal:12}}>{KANBAN_COLUMNS.map(key=>{
   const lit=target===key;
   return <View key={key} testID={`work-column-${key}`} style={{flex:1,minWidth:0,gap:8,padding:6,borderRadius:RADIUS.block,borderWidth:2,borderColor:lit?K.accent:'transparent',backgroundColor:K.field,boxShadow:lit?ledGlow(K.accent):undefined}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:4}}><Lamp tone={COUNTER_LAMP[key]} size={6}/><M s={9.5} w="600" ls={0.06} c={K.inkTertiary} style={{flex:1}} numberOfLines={1}>{WORK_COLUMNS[key].toUpperCase()}</M><M s={9.5} w="600" c={K.inkTertiary}>{work.page?.counts[key] ?? '·'}</M></View>
    {work.page?.items.filter(item=>item.column===key).map(item=><WorkTile key={item.id} {...cardProps(item)} onLift={lift} onMove={travel=>setTarget(travel===null?null:reach(item,travel))} onDrop={travel=>drop(item,travel)}/>)}
   </View>;
  })}</View> : <>
   <View style={{flexDirection:'row',gap:6,paddingHorizontal:12}}>{KANBAN_COLUMNS.map(key=><Pressable key={key} accessibilityRole="button" accessibilityLabel={`Ver ${WORK_COLUMNS[key]}`} accessibilityState={{selected:column===key}} onPress={()=>work.prefer({...work.preferences,column:key})}
    style={{flex:1,minHeight:64,borderRadius:RADIUS.key,alignItems:'center',justifyContent:'center',gap:4,backgroundColor:column===key?K.ink:K.key,boxShadow:column===key?K.shadowKey:K.shadowKey}}>
    <Lamp tone={COUNTER_LAMP[key]} size={6} onScreen={column===key}/><M s={20} w="600" c={column===key?K.block:K.inkSecondary}>{work.page?.counts[key] ?? '·'}</M><M s={9.5} c={column===key?K.block:K.inkSecondary}>{COUNTER_LABEL[key]}</M>
   </Pressable>)}</View>
   <SectionHeader title={`${WORK_COLUMNS[column].toUpperCase()} · ORDEN MANUAL`} action={{label:work.preferences.compact?'Ampliar':'Compactar',onPress:()=>work.prefer({...work.preferences,compact:!work.preferences.compact})}}/>
   {items.length ? <ListBlock>{items.map(item=><WorkRow key={item.id} {...cardProps(item)} compact={work.preferences.compact||items.length>=18} onNext={()=>{const next=nextColumn(item.column);if(next)void move(item,next);}}/>)}</ListBlock>
    : work.page ? <T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>Sin Tarjetas en {WORK_COLUMNS[column]}.</T> : null}
  </>}
  <T s={11} c={K.inkTertiary} style={{paddingHorizontal:16}}>La asignación y la carga cuentan elementos manuales, no trabajo activo.</T>
  {work.page?<T s={11} c={K.inkTertiary} style={{paddingHorizontal:16}}>{work.page.items.length} elementos · observado {new Date(work.page.observedAt).toLocaleString('es-ES')}</T>:null}
  {demo}
 </PullToRefresh>
 {chosen && !editor && noticeText===null && !preview ? <Sheet bottom={bottom}>
  <M c={K.inkTertiary}>ELEMENTO #{chosen.number}</M><T s={22} w="700">{chosen.title}</T>
  <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><T>{agentName(chosen.agentId)}</T><Tecla height={34} style={{paddingHorizontal:12}} accessibilityLabel="Editar elemento" disabled={!editableDetail} onPress={()=>openEditor(chosen)}><T s={12}>Cambiar</T></Tecla></View>
  <T s={12} c={K.inkTertiary}>Asignar o mover no inicia un Turno.</T>
  <View style={{flexDirection:'row',gap:4}}>{KANBAN_COLUMNS.map(key=><Tecla key={key} height={48} radius={12} style={{flex:1,backgroundColor:chosen.column===key?K.ink:K.key}} accessibilityLabel={`Mover a ${WORK_COLUMNS[key]}`} disabled={!editableDetail} onPress={()=>void move(chosen,key)}><M s={9.5} c={chosen.column===key?K.onInk:K.inkSecondary}>{WORK_COLUMNS[key]}</M></Tecla>)}</View>
  <M c={K.inkTertiary}>DEPENDENCIAS</M>
  {work.detail?.blockers.map(dep=><Pressable key={dep.id} onPress={()=>work.select(dep.id)}><T s={12} c={K.dangerText}>Bloqueado por #{dep.number} · {dep.title} · {WORK_COLUMNS[dep.column]}</T></Pressable>)}
  {work.detail?.blocks.map(dep=><Pressable key={dep.id} onPress={()=>work.select(dep.id)}><T s={12} c={K.accentText}>Bloquea a #{dep.number} · {dep.title}</T></Pressable>)}
  {!work.detail?<T s={12} c={K.inkTertiary}>{work.fresh?'Cargando detalle…':'Detalle y comentarios no disponibles en esta copia.'}</T>:!work.detail.blockers.length&&!work.detail.blocks.length?<T s={12} c={K.inkTertiary}>Sin dependencias</T>:null}
  <RecessedScreen style={{padding:12,gap:8}}><M s={10} c={K.onScreen}>{work.attempt && !work.notice?'Resultado no confirmado · consulta el recibo':work.detail?notificationLabel(receipt):'Avisos y Turnos no disponibles en esta copia.'}</M><T s={11} c={K.onScreenLabel}>El recibo y el Turno observado no cambian la columna.</T>{receipt?<><T s={11} c={K.onScreen}>Agente del aviso: {agentName(receipt.agentId)} ({receipt.agentId})</T><T s={11} c={K.onScreen}>Recibo actualizado {new Date(receipt.updatedAt).toLocaleString('es-ES')}</T></>:null}{receipt?.state==='started'&&receipt.turn?<T s={11} c={K.onScreen}>Turno observado {new Date(receipt.turn.observedAt).toLocaleString('es-ES')}</T>:null}{(work.attempt||receipt)?<Tecla height={36} disabled={!editableDetail} onPress={()=>void work.consult()}><T s={12}>Consultar recibo</T></Tecla>:null}{receipt?.conversationId && receipt.state!=='started'?<T s={11} c={K.onScreen}>Conversación registrada · no se confirmó un Turno.</T>:null}{receipt?.conversationId?<Tecla disabled={DEMO && receipt.requestId==='synthetic_notice'} height={36} onPress={()=>router.push({pathname:'/chat/[server]/[agent]',params:{server:serverId,agent:receipt.agentId,conversationId:receipt.conversationId}})}><T s={12}>Abrir Conversación</T></Tecla>:null}</RecessedScreen>
  <Tecla accessibilityLabel="Avisar al Agente" disabled={!editableDetail || !chosen.agentId || !!noticeBusy} onPress={()=>{setNoticeText(chosen.title);setValidation(null);}}><M>Revisar aviso al Agente</M></Tecla>
  <M c={K.inkTertiary}>COMENTARIOS MANUALES</M>
  {work.comments?.comments.map(entry=><View key={entry.id} style={{borderRadius:12,backgroundColor:K.block,boxShadow:K.shadowBlock,padding:10,gap:4}}><M s={9.5} c={K.inkTertiary}>{entry.author.name} · {new Date(entry.createdAt).toLocaleString('es-ES')}</M><T s={13}>{entry.text}</T></View>)}
  <Input label="Comentar elemento" value={comment} onChange={setComment} editable={editableDetail} placeholder="Comentar… @ no envía avisos"/>
  <T s={11} c={K.inkTertiary}>Hasta 4096 bytes UTF-8 · {chosen.commentCount}/200 comentarios.</T>
  <Tecla disabled={!editableDetail || chosen.commentCount>=200} onPress={()=>void publishComment()}><T>Publicar comentario</T></Tecla>
  {formError?<T c={K.dangerText}>{formError}</T>:null}
  <Tecla onPress={()=>work.select(null)} disabled={work.busy}><M>Cerrar</M></Tecla>
 </Sheet>:null}
 {editor && editor.owner===work.client && work.scope.visible?<Sheet bottom={bottom}>
  <T s={22} w="700">{editor.item?'Editar elemento':'Nuevo elemento'}</T>
  <M c={K.inkTertiary}>TÍTULO · HASTA 200 CARACTERES</M><Input label="Título del elemento" value={editor.draft.title} onChange={title=>updateDraft({title})} editable={writable}/>
  <M c={K.inkTertiary}>ASIGNAR · ESTE SERVIDOR</M><Tecla height={36} accessibilityLabel="Sin asignar" disabled={!writable} onPress={()=>updateDraft({agentId:null})}><T>Sin asignar {editor.draft.agentId===null?'✓':''}</T></Tecla>
  {agents.map(agent=><Tecla key={agent.id} height={40} accessibilityLabel={`Asignar a ${agent.name}`} disabled={!writable} onPress={()=>updateDraft({agentId:agent.id})}><T>{agent.name} {editor.draft.agentId===agent.id?'✓':''}</T><M s={9.5} c={K.inkTertiary}>{work.page?.items.filter(item=>item.agentId===agent.id && item.column==='in_progress').length ?? 0} EN CURSO</M></Tecla>)}
  <T s={11} c={K.inkTertiary}>La carga cuenta elementos en En curso; no Turnos activos.</T>
  <M c={K.inkTertiary}>COLUMNA</M><View style={{flexDirection:'row',gap:4}}>{KANBAN_COLUMNS.map(key=><Tecla key={key} height={40} radius={10} style={{flex:1,backgroundColor:editor.draft.column===key?K.ink:K.key}} disabled={!writable} accessibilityLabel={`Columna ${WORK_COLUMNS[key]}`} onPress={()=>updateDraft({column:key})}><M s={9.5} c={editor.draft.column===key?K.onInk:K.inkSecondary}>{WORK_COLUMNS[key]}</M></Tecla>)}</View>
  <M c={K.inkTertiary}>DEPENDE DE · MÁXIMO 16</M>
  {work.page?.items.filter(item=>item.id!==editor.item?.id).map(item=><Pressable key={item.id} accessibilityRole="checkbox" accessibilityLabel={`Depender de elemento ${item.number}`} accessibilityState={{checked:editor.draft.blockedBy.includes(item.id),disabled:!writable}} disabled={!writable} onPress={()=>updateDraft({blockedBy:editor.draft.blockedBy.includes(item.id)?editor.draft.blockedBy.filter(id=>id!==item.id):[...editor.draft.blockedBy,item.id]})} style={{paddingVertical:10,flexDirection:'row',gap:8}}><M>{editor.draft.blockedBy.includes(item.id)?'✓':'○'}</M><T s={12} style={{flex:1}}>#{item.number} · {item.title}</T></Pressable>)}
  {formError?<T c={K.dangerText}>{formError}</T>:null}
  <Tecla style={{backgroundColor:K.accent}} disabled={!writable} onPress={()=>void saveEditor()}><T w="700" c={K.onAccent}>{editor.item?'Guardar cambios':'Crear elemento'}</T></Tecla>
  {!editor.item?<Tecla disabled={!writable || !editor.draft.agentId} onPress={()=>void saveEditor(true)}><T>Crear y revisar aviso</T></Tecla>:null}
  <T s={11} c={K.inkTertiary}>Crear guarda metadatos. Avisar requiere revisar y confirmar otro paso.</T><Tecla disabled={work.busy} onPress={()=>setEditor(null)}><T>Cancelar</T></Tecla>
 </Sheet>:null}
 {noticeText!==null && !preview?<Sheet bottom={bottom}>
  <T s={22} w="700">Preparar aviso</T><T s={13}>Se abrirá una Conversación nueva sólo al confirmar el envío.</T>
  <Input label="Texto exacto del aviso" value={noticeText} onChange={setNoticeText} editable={editableDetail}/><T s={11} c={K.inkTertiary}>Hasta 64000 bytes UTF-8. No se añaden instrucciones ocultas.</T>
  {formError?<T c={K.dangerText}>{formError}</T>:null}<Tecla disabled={!editableDetail || !!noticeBusy} onPress={review}><T>Revisar aviso</T></Tecla><Tecla onPress={()=>{setNoticeText(null);setValidation(null);}}><T>Cancelar</T></Tecla>
 </Sheet>:null}
 {preview && preview.owner===work.client && preview.item.revision===work.detail?.item.revision && work.scope.visible?<Sheet bottom={bottom}>
  <M c={K.inkTertiary}>AVISO EXPLÍCITO · {work.server?.name}</M><T s={22} w="700">Nueva Conversación con {agentName(preview.item.agentId)}</T><T s={12}>Elemento #{preview.item.number} · {preview.item.title}</T><RecessedScreen style={{padding:14}}><T s={14} c={K.onScreenBright}>{preview.input}</T></RecessedScreen><T s={12} c={K.inkTertiary}>Este texto exacto se enviará al Puente. Pausa general y dependencias se comprobarán antes de iniciar el Turno.</T><Tecla style={{backgroundColor:K.accent}} disabled={!editableDetail || !!noticeBusy} onPress={()=>void send()}><T w="700" c={K.onAccent}>Enviar este aviso</T></Tecla><Tecla onPress={()=>setPreview(null)}><T>Volver a editar</T></Tecla><Tecla onPress={()=>{setPreview(null);setNoticeText(null);}}><T>Cancelar</T></Tecla>
 </Sheet>:null}
 </View>;
}
function Input({label,value,onChange,editable,placeholder}: {label:string;value:string;onChange:(text:string)=>void;editable:boolean;placeholder?:string}) {
 const {K}=usePalette();
 return <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={editable} multiline placeholder={placeholder} selectionColor={K.accent} textAlignVertical="top" style={{backgroundColor:K.field,color:K.ink,boxShadow:K.shadowField,borderRadius:14,minHeight:72,maxHeight:180,padding:12,fontFamily:F.sans['400'],fontSize:14}}/>;
}
function Sheet({children,bottom}: {children:ReactNode;bottom:number}) {
 const {K}=usePalette();
 // Inline sheets inherit LockGate visibility; native Modal windows would outlive its hidden subtree.
 return <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={{position:'absolute',inset:0,justifyContent:'flex-end',backgroundColor:K.sheetBackdrop}}><View accessibilityViewIsModal style={{maxHeight:'85%',backgroundColor:K.background,borderTopLeftRadius:28,borderTopRightRadius:28,boxShadow:K.shadowSheet,paddingHorizontal:18,paddingTop:10,paddingBottom:bottom}}><View style={{alignSelf:'center',width:38,height:4,borderRadius:2,backgroundColor:K.field,marginBottom:12}}/><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{gap:14}}>{children}</ScrollView></View></KeyboardAvoidingView>;
}
/** A key wrapping custom content (two lines, a check mark), drawn with the K-1 key face. */
function Tecla({onPress,accessibilityLabel,height=48,radius=16,disabled,style,children}: {onPress?:()=>void;accessibilityLabel?:string;height?:number;radius?:number;disabled?:boolean;style?:StyleProp<ViewStyle>;children:ReactNode}) {
 const {K}=usePalette();
 return <Pressable role="button" accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={disabled} style={({pressed})=>[{height,borderRadius:radius,backgroundColor:K.key,boxShadow:pressed?K.shadowKeyPressed:K.shadowKey,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8},style]}>{children}</Pressable>;
}
