import { RelayShell } from '@/ui/RelayShell';
import { resizeWindow, navigation } from '../support/native';
import { StyleSheet } from 'react-native';
import { ThemeProvider, useThemePreference } from '@/theme/ThemeProvider';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/theme/tokens';
import { act, cleanupAsync, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { drag, hold } from '../support/gestures';
import { ShellNavigationContext } from '@/ui/layoutContext';
import { WorkScreen } from '@/screens/WorkScreen';
import { LockGate } from '@/screens/LockGate';
import { agentA, polling, seed, serverA, settings } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, respond, requests } from '../support/transport';
import { clockStart, biometrics, deferred, emitAppState, stored, secureStore, router } from '../support/native';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { serverB } from '../support/fixtures';
import { networkError } from '../support/transport';
import type { KanbanItem } from '../../../protocol/kanban';
const id='00000000-0000-4000-8000-000000000001', rev='a'.repeat(64);
const item:KanbanItem={id,number:17,revision:rev,title:'Revisar pruebas del Puente',agentId:'agentA',column:'todo',blockedBy:[],commentCount:0,createdAt:clockStart,updatedAt:clockStart};
function fixtures(items:KanbanItem[]=[item]) {
 seed([serverA],{...settings,faceid:false}); polling(serverA,[agentA]);
 respond(serverA.url,'/v1/kanban/items?limit=100',json({items,counts:{todo:items.filter(i=>i.column==='todo').length,in_progress:0,review:0,blocked:0,done:0},revision:rev,observedAt:clockStart,nextCursor:null}));
 respond(serverA.url,`/v1/kanban/items/${id}`,json({item,blockers:[],blocks:[],latestNotification:null,observedAt:clockStart}));
 respond(serverA.url,`/v1/kanban/items/${id}/comments?limit=100`,json({comments:[],itemRevision:rev,observedAt:clockStart,nextCursor:null}));
}
test('Trabajo mounts the real provider and shows five manual columns, scoped assignment and independent notice state',async()=>{
 fixtures();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
 fireEvent.press(await screen.findByText('Revisar pruebas del Puente'));
 await screen.findByText('Sin aviso enviado');
 expect(screen.getByLabelText('Mover a En curso')).toBeVisible();
 expect(screen.getAllByText('Agente A').length).toBeGreaterThan(0);
 expect(screen.getByText('Asignar o mover no inicia un Turno.')).toBeVisible();
 expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
 await act(async()=>{});
 await cleanupAsync();
});

test('create is saved separately; exact notice opens only the backend route and preserves a rejected partial result',async()=>{
 fixtures([]);
 respond(serverA.url,'/v1/kanban/items',r=>json({requestId:(r.body as {requestId:string}).requestId,item},201),'POST');
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{
  const body=r.body as {requestId:string;revision:string;agentId:string};
  return json({requestId:body.requestId,itemId:id,itemRevision:body.revision,agentId:body.agentId,requestedBy:{kind:'device',id:'fixture-device-A',name:'Humano'},requestedAt:clockStart,updatedAt:clockStart,state:'rejected',conversationId:null,runId:null,errorCode:'server_paused'},202);
 },'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
 fireEvent.press(await screen.findByLabelText('Crear elemento'));
 fireEvent.changeText(screen.getByLabelText('Título del elemento'),'Revisar pruebas del Puente');
 fireEvent.press(screen.getByLabelText('Asignar a Agente A'));
 fixtures([item]);
 fireEvent.press(screen.getByText('Crear y revisar aviso'));
 await screen.findByLabelText('Texto exacto del aviso');
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
 fireEvent.changeText(screen.getByLabelText('Texto exacto del aviso'),'Texto exacto\nSin instrucciones ocultas.');
 fireEvent.press(screen.getByText('Revisar aviso'));
 expect(screen.getByText('Texto exacto\nSin instrucciones ocultas.')).toBeVisible();
 fireEvent.press(screen.getByText('Enviar este aviso'));
 await screen.findByText('Aviso rechazado · Pausa general');
 const notices=requests.filter(r=>r.path.endsWith('/notify'));
 expect(notices).toHaveLength(1);
 expect(notices[0].body).toEqual(expect.objectContaining({input:'Texto exacto\nSin instrucciones ocultas.',revision:rev,agentId:'agentA'}));
 expect(requests.filter(r=>r.path.includes('/conversations') || r.path.endsWith('/runs'))).toHaveLength(0);
 expect(screen.getAllByText('Revisar pruebas del Puente').length).toBeGreaterThan(0);
 await cleanupAsync();
});

test('moving, assigning and manual comments mutate metadata without starting work',async()=>{
 fixtures();let current={...item};const manual: unknown[]=[];
 const page=()=>({items:[current],counts:{todo:Number(current.column==='todo'),in_progress:Number(current.column==='in_progress'),review:Number(current.column==='review'),blocked:0,done:0},revision:current.revision,observedAt:clockStart,nextCursor:null});
 respond(serverA.url,'/v1/kanban/items?limit=100',()=>json(page()));
 respond(serverA.url,`/v1/kanban/items/${id}`,()=>json({item:current,blockers:[],blocks:[],latestNotification:null,observedAt:clockStart}));
 respond(serverA.url,`/v1/kanban/items/${id}/comments?limit=100`,()=>json({comments:manual,itemRevision:current.revision,observedAt:clockStart,nextCursor:null}));
 respond(serverA.url,`/v1/kanban/items/${id}`,r=>{
  const body=r.body as {requestId:string;column?:KanbanItem['column'];agentId?:string|null;title?:string;blockedBy?:string[]};
  current={...current,...Object.fromEntries(Object.entries(body).filter(([key])=>!['requestId','revision'].includes(key))),revision:'b'.repeat(64)};
  return json({requestId:body.requestId,item:current});
 },'PATCH');
 respond(serverA.url,`/v1/kanban/items/${id}/comments`,r=>{
  const body=r.body as {requestId:string;text:string}; const comment={id:'00000000-0000-4000-8000-000000000003',number:1,author:{kind:'device',id:'fixture-device-A',name:'Humano'},text:body.text,createdAt:clockStart};
  manual.push(comment);current={...current,commentCount:1,revision:'c'.repeat(64)};return json({requestId:body.requestId,item:current,comment},201);
 },'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
 fireEvent.press(await screen.findByText(item.title));await screen.findByLabelText('Editar elemento');
 fireEvent.press(screen.getByLabelText('Mover a En curso'));
 await waitFor(()=>expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(1));
 await waitFor(()=>expect(screen.getByLabelText('Editar elemento')).not.toBeDisabled());
 fireEvent.press(screen.getByLabelText('Editar elemento'));fireEvent.press(screen.getByLabelText('Sin asignar'));
 fireEvent.press(screen.getByText('Guardar cambios'));
 await waitFor(()=>expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(2));
 await waitFor(()=>expect(screen.getByLabelText('Comentar elemento')).toHaveProp('editable',true));
 fireEvent.changeText(screen.getByLabelText('Comentar elemento'),'@agentA comentario manual');fireEvent.press(screen.getByText('Publicar comentario'));
 await screen.findByText('@agentA comentario manual');
 expect(requests.filter(r=>r.method==='PATCH')[1].body).toEqual(expect.objectContaining({agentId:null}));
 expect(requests.filter(r=>r.path.endsWith('/notify') || r.path.endsWith('/runs'))).toHaveLength(0);
 await cleanupAsync();
});

async function openPreview() {
 fireEvent.press(await screen.findByText(item.title));
 await waitFor(()=>expect(screen.getByLabelText('Avisar al Agente')).not.toBeDisabled());
 fireEvent.press(screen.getByLabelText('Avisar al Agente'));fireEvent.changeText(screen.getByLabelText('Texto exacto del aviso'),'Aviso humano exacto');
 fireEvent.press(screen.getByText('Revisar aviso'));await screen.findByText('Enviar este aviso');
}
test('LockGate hides and retires an exact confirmation; unlocking cannot revive it',async()=>{
 fixtures();seed([serverA],{...settings,autoLockMs:0});biometrics.authenticateAsync.mockResolvedValue({success:true});
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();
 biometrics.authenticateAsync.mockResolvedValue({success:false});
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));
 await screen.findByText('Relay está bloqueado');
 expect(screen.queryByText('Enviar este aviso')).toBeNull();
 biometrics.authenticateAsync.mockResolvedValue({success:true});fireEvent.press(screen.getByText('Usar el código del teléfono'));await screen.findByLabelText('Editar elemento');
 expect(screen.queryByText('Enviar este aviso')).toBeNull();
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(0);
 await cleanupAsync();
});
test('a lost notice result is not replayed and explicit receipt lookup keeps the original request id',async()=>{
 fixtures();let receiptId='';respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{receiptId=(r.body as {requestId:string}).requestId;throw new Error('SECRET_UPSTREAM');},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();
 const button=screen.getByText('Enviar este aviso');fireEvent.press(button);fireEvent.press(button);
 await screen.findByText('Resultado no confirmado · consulta el recibo');
 expect(screen.queryByText(/SECRET_UPSTREAM/)).toBeNull();expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
 respond(serverA.url,`/v1/kanban/items/${id}/notifications/${receiptId}`,json({requestId:receiptId,itemId:id,itemRevision:rev,agentId:'agentA',requestedBy:{kind:'device',id:'fixture-device-A',name:'Humano'},requestedAt:clockStart,updatedAt:clockStart,state:'uncertain',conversationId:null,runId:null,errorCode:'kanban_notification_uncertain'}));
 fireEvent.press(screen.getByText('Consultar recibo'));await screen.findByText('Resultado incierto · no se reenviará automáticamente');
 fireEvent.press(screen.getByText('Cerrar'));fireEvent.press(screen.getByText(item.title));await screen.findByLabelText('Editar elemento');
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
 await cleanupAsync();
});
test('late notice response from another Server is retired and never becomes that Server’s state',async()=>{
 fixtures();seed([serverA,serverB],{...settings,faceid:false});polling(serverB,[agentA]);
 respond(serverB.url,'/v1/kanban/items?limit=100',json({items:[],counts:{todo:0,in_progress:0,review:0,blocked:0,done:0},revision:rev,observedAt:clockStart,nextCursor:null}));
 const pending=deferred<Response>();let body:{requestId:string}|null=null;
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{body=r.body as {requestId:string};return pending.promise;},'POST');
 function Switcher(){const [server,setServer]=useState('A');return <><Pressable onPress={()=>setServer('B')}><Text>Cambiar contexto</Text></Pressable><LockGate><WorkScreen serverId={server}/></LockGate></>;}
 const app=renderApp(<Switcher/>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));
 await waitFor(()=>expect(body).not.toBeNull());fireEvent.press(screen.getByText('Cambiar contexto'));await screen.findByText('TRABAJO VACÍO');
 await act(async()=>pending.resolve(json({requestId:body!.requestId,itemId:id,itemRevision:rev,agentId:'agentA',requestedBy:{kind:'device',id:'fixture-device-A',name:'Humano'},requestedAt:clockStart,updatedAt:clockStart,state:'started',conversationId:'new',runId:'run',errorCode:null,turn:null},202)));
 expect(screen.queryByText(/Turno aceptado/)).toBeNull();expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
 await cleanupAsync();
});
test('cache is dated and readonly offline; revocation removes cached elements and opaque errors never reveal server text',async()=>{
 fixtures();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await screen.findByText(item.title);
 await waitFor(()=>expect(stored.get('relay.work.v1.A')).toContain(item.title));
 respond(serverA.url,'/v1/kanban/items?limit=100',()=>networkError());
 fireEvent.press(screen.getByLabelText('Ver Revisión'));fireEvent.press(screen.getByLabelText('Ver Por hacer'));
 // A remount forces a cache load, with a synthetic unavailable transport.
 await act(async()=>{app.unmount();});const offline=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await offline.ready();
 await screen.findByText('ÚLTIMA COPIA · SOLO LECTURA');
 expect(screen.getByText('SERVIDOR A · SIN RESPUESTA')).toBeVisible();
 expect(screen.getByLabelText('Crear elemento')).toBeDisabled();fireEvent.press(screen.getByText(item.title));
 expect(screen.getByLabelText('Mover a En curso')).toBeDisabled();expect(screen.getByLabelText('Comentar elemento')).toHaveProp('editable',false);
 respond(serverA.url,'/v1/kanban/items?limit=100',json({error:{code:'device_revoked',message:'SECRET_UPSTREAM'}},401));
 fireEvent.press(screen.getByText('Cerrar'));fireEvent.press(screen.getByText('Reintentar'));
 await waitFor(()=>expect(stored.get('relay.work.v1.A')).toBe(''));
 expect(screen.queryByText(item.title)).toBeNull();expect(screen.queryByText(/SECRET_UPSTREAM/)).toBeNull();expect(requests.filter(r=>r.method==='POST')).toHaveLength(0);
 await cleanupAsync();
});

test('a response after leaving and returning to the same visible scope cannot revive an old notice',async()=>{
 fixtures();const pending=deferred<Response>();let requestId='';
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{requestId=(r.body as {requestId:string}).requestId;return pending.promise;},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));
 await waitFor(()=>expect(requestId).not.toBe(''));
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));
 await waitFor(()=>expect(screen.getByLabelText('Editar elemento')).not.toBeDisabled());
 await act(async()=>pending.resolve(json({requestId,itemId:id,itemRevision:rev,agentId:'agentA',requestedBy:{kind:'device',id:'fixture-device-A',name:'Humano'},requestedAt:clockStart,updatedAt:clockStart,state:'started',conversationId:'old-response',runId:'old-run',errorCode:null,turn:null},202)));
 expect(screen.queryByText(/Turno aceptado/)).toBeNull();
 expect(screen.getByText('Resultado no confirmado · consulta el recibo')).toBeVisible();
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);
 await cleanupAsync();
});
test('lost notice reference survives remount; reconnect and mount perform no POST or receipt lookup automatically',async()=>{
 fixtures();let requestId='';respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{requestId=(r.body as {requestId:string}).requestId;throw new Error('Synthetic network loss');},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));
 await screen.findByText('Resultado no confirmado · consulta el recibo');
 expect(stored.get('relay.work.v1.A.notices')).toContain(requestId);expect(stored.get('relay.work.v1.A.notices')).not.toContain('Aviso humano exacto');
 await act(async()=>{app.unmount();});const next=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await next.ready();fireEvent.press(await screen.findByText(item.title));
 await screen.findByText('Resultado no confirmado · consulta el recibo');
 expect(screen.getByLabelText('Avisar al Agente')).toBeDisabled();
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);expect(requests.filter(r=>r.path.includes('/notifications/'))).toHaveLength(0);
 await cleanupAsync();
});
test('moving to Bloqueado requires a same-Server dependency; a move alone never notifies',async()=>{
 fixtures();const blocker={...item,id:'00000000-0000-4000-8000-000000000002',number:18,title:'Dependencia humana'};let current={...item};
 const page=()=>({items:[current,blocker],counts:{todo:current.column==='blocked'?1:2,in_progress:0,review:0,blocked:current.column==='blocked'?1:0,done:0},revision:current.revision,observedAt:clockStart,nextCursor:null});
 respond(serverA.url,'/v1/kanban/items?limit=100',()=>json(page()));
 respond(serverA.url,`/v1/kanban/items/${id}`,()=>json({item:current,blockers:current.blockedBy.length?[{id:blocker.id,number:18,title:blocker.title,column:blocker.column}]:[],blocks:[],latestNotification:null,observedAt:clockStart}));
 respond(serverA.url,`/v1/kanban/items/${id}/comments?limit=100`,()=>json({comments:[],itemRevision:current.revision,observedAt:clockStart,nextCursor:null}));
 respond(serverA.url,`/v1/kanban/items/${id}`,r=>{const b=r.body as {requestId:string;column:KanbanItem['column'];blockedBy:string[]};current={...current,column:b.column,blockedBy:b.blockedBy,revision:'b'.repeat(64)};return json({requestId:b.requestId,item:current});},'PATCH');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();fireEvent.press(await screen.findByText(item.title));
 await waitFor(()=>expect(screen.getByLabelText('Mover a Bloqueado')).not.toBeDisabled());fireEvent.press(screen.getByLabelText('Mover a Bloqueado'));fireEvent.press(screen.getByText('Guardar cambios'));
 expect(screen.getByText('Selecciona el elemento que lo bloquea.')).toBeVisible();expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(0);
 fireEvent.press(screen.getByLabelText('Depender de elemento 18'));fireEvent.press(screen.getByText('Guardar cambios'));
 await screen.findByText('Bloqueado por #18 · Dependencia humana · Por hacer');
 expect(requests.find(r=>r.method==='PATCH')?.body).toEqual(expect.objectContaining({column:'blocked',blockedBy:[blocker.id]}));
 expect(requests.filter(r=>r.path.endsWith('/notify'))).toHaveLength(0);
 await cleanupAsync();
});

const other=(number:number,column:KanbanItem['column'],blockedBy:string[]=[]):KanbanItem=>({...item,id:`00000000-0000-4000-8000-0000000000${String(number).padStart(2,'0')}`,number,title:`Tarjeta ${number}`,column,blockedBy});
/** A board with a Tarjeta in every column but BLOQUEADO, whose PATCHes are recorded and applied. */
function board(){
 let items=[item,other(18,'in_progress'),other(19,'review'),other(20,'done')];
 const page=()=>({items,counts:Object.fromEntries(['todo','in_progress','review','blocked','done'].map(key=>[key,items.filter(i=>i.column===key).length])),revision:rev,observedAt:clockStart,nextCursor:null});
 seed([serverA],{...settings,faceid:false});polling(serverA,[agentA]);
 respond(serverA.url,'/v1/kanban/items?limit=100',()=>json(page()));
 for(const entry of items){
  respond(serverA.url,`/v1/kanban/items/${entry.id}`,()=>json({item:items.find(i=>i.id===entry.id),blockers:[],blocks:[],latestNotification:null,observedAt:clockStart}));
  respond(serverA.url,`/v1/kanban/items/${entry.id}/comments?limit=100`,json({comments:[],itemRevision:rev,observedAt:clockStart,nextCursor:null}));
  respond(serverA.url,`/v1/kanban/items/${entry.id}`,r=>{
   const body=r.body as {requestId:string;column:KanbanItem['column']};
   items=items.map(i=>i.id===entry.id?{...i,column:body.column}:i);
   return json({requestId:body.requestId,item:items.find(i=>i.id===entry.id)});
  },'PATCH');
 }
}
const patches=()=>requests.filter(r=>r.method==='PATCH');
describe('Tarjeta gestures',()=>{
 test('a swipe to the right moves a Tarjeta to the next column, and in HECHO does nothing',async()=>{
  board();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
  await screen.findByText(item.title);
  drag('work-17',[{x:120}]);
  await waitFor(()=>expect(patches()).toHaveLength(1));
  expect(patches()[0].path).toBe(`/v1/kanban/items/${id}`);expect(patches()[0].body).toEqual(expect.objectContaining({column:'in_progress'}));
  fireEvent.press(screen.getByLabelText('Ver Hecho'));
  await screen.findByText('Tarjeta 20');
  drag('work-20',[{x:120}]);
  await act(async()=>{});
  expect(patches()).toHaveLength(1);
  await cleanupAsync();
 });
 test('a swipe short of 90 px moves nothing',async()=>{
  board();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
  await screen.findByText(item.title);
  drag('work-17',[{x:89}]);
  await act(async()=>{});
  expect(patches()).toHaveLength(0);
  await cleanupAsync();
 });
 test('pulling 60 px reloads Trabajo',async()=>{
  board();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
  await screen.findByText(item.title);
  const loads=()=>requests.filter(r=>r.method==='GET'&&r.path==='/v1/kanban/items?limit=100').length;
  const before=loads();
  hold('pull-to-refresh',[{y:120}]).release();
  await waitFor(()=>expect(loads()).toBeGreaterThan(before));
  await waitFor(()=>expect(screen.queryByText('CARGANDO…')).toBeNull());
  await act(async()=>{jest.advanceTimersByTime(400);});
  await cleanupAsync();
 });
 describe('dragging on a tablet',()=>{
  const pane=1000,stride=(pane-24-4*12)/5+12;
  async function tablet(){
   board();resizeWindow(pane,800);
   const app=renderApp(<ShellNavigationContext.Provider value><LockGate><WorkScreen serverId="A"/></LockGate></ShellNavigationContext.Provider>);await app.ready();
   await screen.findByText(item.title);
   fireEvent(screen.getByLabelText('Trabajo del Servidor'),'layout',{nativeEvent:{layout:{width:pane,height:800,x:0,y:0}}});
  }
  const inColumn=(key:string,title:string)=>within(screen.getByTestId(`work-column-${key}`)).queryByText(title);
  test('the column under the card gets a 2 px orange edge with glow, and dropping there moves the Tarjeta',async()=>{
   await tablet();
   const finger=hold('work-card-17',[{x:stride}]);
   act(()=>{jest.advanceTimersByTime(0);});
   const target=StyleSheet.flatten(screen.getByTestId('work-column-in_progress').props.style);
   expect(target).toEqual(expect.objectContaining({borderWidth:2,borderColor:LIGHT_PALETTE.K.accent}));
   expect(target.boxShadow).toContain(LIGHT_PALETTE.K.accent);
   expect(StyleSheet.flatten(screen.getByTestId('work-column-review').props.style).borderColor).not.toBe(LIGHT_PALETTE.K.accent);
   finger.release();
   await waitFor(()=>expect(patches()).toHaveLength(1));
   expect(patches()[0].body).toEqual(expect.objectContaining({column:'in_progress'}));
   await waitFor(()=>expect(inColumn('in_progress',item.title)).not.toBeNull());
   await cleanupAsync();
  });
  test('dropping on BLOQUEADO opens the picker, and cancelling leaves the Tarjeta in its column',async()=>{
   await tablet();
   hold('work-card-17',[{x:3*stride}]).release();
   await screen.findByText('DEPENDE DE · MÁXIMO 16');
   expect(patches()).toHaveLength(0);
   fireEvent.press(screen.getByText('Cancelar'));
   await waitFor(()=>expect(screen.queryByText('DEPENDE DE · MÁXIMO 16')).toBeNull());
   expect(patches()).toHaveLength(0);
   expect(inColumn('todo',item.title)).not.toBeNull();expect(inColumn('blocked',item.title)).toBeNull();
   await cleanupAsync();
  });
  test('a drag the system cancels drops nothing',async()=>{
   await tablet();
   hold('work-card-17',[{x:stride}]).cancel();
   await act(async()=>{jest.advanceTimersByTime(100);});
   expect(patches()).toHaveLength(0);expect(screen.queryByText('DEPENDE DE · MÁXIMO 16')).toBeNull();
   await cleanupAsync();
  });
  test('releasing above or below the board cancels, though the column under it is right',async()=>{
   await tablet();
   fireEvent(screen.getByTestId('work-board'),'layout',{nativeEvent:{layout:{width:pane,height:600,x:0,y:0}}});
   fireEvent(screen.getByTestId('work-tile-17'),'layout',{nativeEvent:{layout:{x:0,y:40,width:100,height:100}}});
   await act(async()=>{});
   hold('work-card-17',[{x:stride,y:-200}]).release();
   hold('work-card-17',[{x:stride,y:700}]).release();
   await act(async()=>{jest.advanceTimersByTime(100);});
   expect(patches()).toHaveLength(0);
   hold('work-card-17',[{x:stride,y:100}]).release();
   await waitFor(()=>expect(patches()).toHaveLength(1));
   await cleanupAsync();
  });
  test('letting go outside the board cancels the drag',async()=>{
   await tablet();
   hold('work-card-17',[{x:-stride}]).release();
   await act(async()=>{});
   expect(patches()).toHaveLength(0);expect(screen.queryByText('DEPENDE DE · MÁXIMO 16')).toBeNull();
   await cleanupAsync();
  });
 });
});
test('retiring confirmation while native receipt storage waits prevents the notice HTTP effect',async()=>{
 fixtures();const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();
 const saved=deferred<void>(),persist=secureStore.setItemAsync.getMockImplementation()!;let waiting=false;
 secureStore.setItemAsync.mockImplementation(async(key,value)=>{if(key==='relay.work.v1.A.notices'){waiting=true;await saved.promise;}return persist(key,value);});
 // Declare a reply so the mutation fails on the explicit zero-effect assertion, not an absent fixture.
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,json({error:{code:'server_paused',message:'Synthetic'}},409),'POST');
 fireEvent.press(screen.getByText('Enviar este aviso'));await waitFor(()=>expect(waiting).toBe(true));
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));
 await act(async()=>saved.resolve());
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(0);
 expect(screen.queryByText('Enviar este aviso')).toBeNull();
 await cleanupAsync();
});
test('a rejected notice with a recorded Conversation preserves that partial outcome and opens only its recorded id',async()=>{
 fixtures();respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{const b=r.body as {requestId:string};return json({requestId:b.requestId,itemId:id,itemRevision:rev,agentId:'agentA',requestedBy:{kind:'device',id:'fixture-device-A',name:'Humano'},requestedAt:clockStart,updatedAt:clockStart,state:'rejected',conversationId:'retained-conversation',runId:null,errorCode:'configuration_conflict'},202);},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));
 await screen.findByText('Conversación registrada · no se confirmó un Turno.');
 expect(screen.getByText('Aviso rechazado · configuración en conflicto')).toBeVisible();
 fireEvent.press(screen.getByText('Abrir Conversación'));
 expect(router.push).toHaveBeenCalledWith({pathname:'/chat/[server]/[agent]',params:{server:'A',agent:'agentA',conversationId:'retained-conversation'}});
 expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);expect(requests.filter(r=>r.path.endsWith('/runs')||r.path.endsWith('/conversations'))).toHaveLength(0);
 await cleanupAsync();
});


test('changing the theme recolors Work and its open editor without discarding the draft or sending work',async()=>{
 fixtures();
 function ThemeToggle(){const {setPreference}=useThemePreference();return <Pressable onPress={()=>setPreference('dark')}><Text>Choose dark theme</Text></Pressable>;}
 const app=renderApp(<ThemeProvider><ThemeToggle/><LockGate><WorkScreen serverId="A"/></LockGate></ThemeProvider>);await app.ready();
 const title=await screen.findByText(item.title);
 expect(title).toHaveStyle({color:LIGHT_PALETTE.K.ink});
 fireEvent.press(screen.getByLabelText('Crear elemento'));
 fireEvent.changeText(screen.getByLabelText('Título del elemento'),'Borrador que conserva el tema');
 fireEvent.press(screen.getByText('Choose dark theme'));
 await waitFor(()=>expect(screen.getByText(item.title)).toHaveStyle({color:DARK_PALETTE.K.ink}));
 expect(screen.getByLabelText('Título del elemento')).toHaveStyle({backgroundColor:DARK_PALETTE.K.field,color:DARK_PALETTE.K.ink});
 expect(screen.getByLabelText('Título del elemento')).toHaveProp('value','Borrador que conserva el tema');
 expect(screen.getByText('Crear elemento')).toHaveStyle({color:DARK_PALETTE.K.onAccent});
 expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
 await cleanupAsync();
});


test('on a tablet Work shows the five columns and keeps an editor draft through rotation to the phone list',async()=>{
 fixtures();navigation.pathname='/work/A';resizeWindow(1200,800);
 const app=renderApp(<LockGate><RelayShell><WorkScreen serverId="A"/></RelayShell></LockGate>);await app.ready();
 await screen.findByText(item.title);
 for(const key of ['todo','in_progress','review','blocked','done'])expect(screen.getByTestId(`work-column-${key}`)).toBeVisible();
 fireEvent.press(screen.getByLabelText('Crear elemento'));
 fireEvent.changeText(screen.getByLabelText('Título del elemento'),'Borrador tras rotar');
 await act(async()=>resizeWindow(390,844));
 await screen.findByLabelText('Ver Por hacer');
 expect(screen.queryByTestId('work-column-todo')).toBeNull();
 expect(screen.getByLabelText('Título del elemento')).toHaveProp('value','Borrador tras rotar');
 expect(screen.queryAllByRole('tab')).toHaveLength(0);
 expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
 await cleanupAsync();
});
test('review: late device_revoked from the same client retires private Work after background-return',async()=>{
 fixtures();const pending=deferred<Response>();let requestId='';
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,r=>{requestId=(r.body as {requestId:string}).requestId;return pending.promise;},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));
 await waitFor(()=>expect(requestId).not.toBe(''));
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));
 await waitFor(()=>expect(screen.getByLabelText('Editar elemento')).not.toBeDisabled());
 await act(async()=>pending.resolve(json({error:{code:'device_revoked',message:'Synthetic denial'}},403)));
 console.log(JSON.stringify({titleVisible:screen.queryAllByText(item.title).length>0,cacheContainsTitle:stored.get('relay.work.v1.A')?.includes(item.title),noticeReferenceRetained:stored.get('relay.work.v1.A.notices')?.includes(requestId),writes:requests.filter(r=>r.method==='POST').length}));
 expect(stored.get('relay.work.v1.A')).toBe('');
 expect(screen.queryByText(item.title)).toBeNull();
 await cleanupAsync();
});

const cacheKey = 'relay.work.v1.A';
const attemptKey = `${cacheKey}.notices`;
const source = JSON.stringify([serverA.id, serverA.url, serverA.deviceId]);
function seedAttempt() {
 stored.set(attemptKey, JSON.stringify({version:1,source,attempts:{[id]:{itemId:id,requestId:'pending_review_reference',itemRevision:rev,agentId:'agentA',requestedAt:clockStart}}}));
}
async function stagedRequest(kind: string, content = <LockGate><WorkScreen serverId="A"/></LockGate>) {
 fixtures(); if (kind !== 'notify') seedAttempt();
 const response=deferred<Response>(); let started=false;
 const app=renderApp(content); await app.ready(); await screen.findByText(item.title);
 await waitFor(()=>expect(stored.get(cacheKey)).toContain(item.title));
 const path=kind==='items'?'/v1/kanban/items?limit=100':kind==='comments'?`/v1/kanban/items/${id}/comments?limit=100`:kind==='notify'?`/v1/kanban/items/${id}/notify`:kind==='consult'?`/v1/kanban/items/${id}/notifications/pending_review_reference`:`/v1/kanban/items/${id}`;
 const method=kind==='metadata'?'PATCH':kind==='notify'?'POST':'GET';
 if (['metadata','notify','consult'].includes(kind)) { fireEvent.press(screen.getByText(item.title)); await screen.findByLabelText('Editar elemento'); }
 respond(serverA.url,path,()=>{started=true;return response.promise;},method);
 if(kind==='items'){await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));}
 else if(kind==='item'||kind==='comments')fireEvent.press(screen.getByText(item.title));
 else if(kind==='metadata')fireEvent.press(screen.getByLabelText('Mover a En curso'));
 else if(kind==='notify'){fireEvent.press(screen.getByLabelText('Avisar al Agente'));fireEvent.changeText(screen.getByLabelText('Texto exacto del aviso'),'Aviso humano exacto');fireEvent.press(screen.getByText('Revisar aviso'));fireEvent.press(screen.getByText('Enviar este aviso'));}
 else fireEvent.press(screen.getByText('Consultar recibo'));
 await waitFor(()=>expect(started).toBe(true));
 return {app,response};
}
test.each(['items','item','comments','metadata','notify','consult'])('late terminal denial from %s retires same-client titles and notice references after background-return',async(kind)=>{
 const {app,response}=await stagedRequest(kind);
 await act(async()=>emitAppState('background')); fixtures(); await act(async()=>emitAppState('active'));
 await waitFor(()=>expect(screen.getAllByText(item.title).length).toBeGreaterThan(0));
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'DO_NOT_SHOW_PRIVATE_UPSTREAM'}},403)));
 await waitFor(()=>{expect(stored.get(cacheKey)).toBe('');expect(stored.get(attemptKey)).toBe('');});
 expect(screen.queryAllByText(item.title)).toHaveLength(0);expect(screen.queryByText(/DO_NOT_SHOW_PRIVATE_UPSTREAM/)).toBeNull();
 expect(screen.queryByText('Resultado no confirmado · consulta el recibo')).toBeNull();
 await act(async()=>app.unmount());
 // Reusing the exact AppProvider client cannot revive its private cache or start new reads.
 // A new AppProvider is a new client and is covered separately by the replacement cases.
 await cleanupAsync();
});
test.each(['items','item','comments','metadata','notify','consult'])('late terminal denial from old %s cannot retire replacement credentials or their private cache/reference',async(kind)=>{
 const {app,response}=await stagedRequest(kind);
 const replacement={...item,title:'Datos del cliente reemplazado'};
 respond(serverA.url,'/v1/kanban/items?limit=100',json({items:[replacement],counts:{todo:1,in_progress:0,review:0,blocked:0,done:0},revision:rev,observedAt:clockStart,nextCursor:null}));
 respond(serverA.url,`/v1/kanban/items/${id}`,json({item:replacement,blockers:[],blocks:[],latestNotification:null,observedAt:clockStart}));
 respond(serverA.url,`/v1/kanban/items/${id}/comments?limit=100`,json({comments:[],itemRevision:rev,observedAt:clockStart,nextCursor:null}));
 await act(async()=>{await app.probe.current!.replaceServer(serverA.id,{...serverA,key:'replacement-fixture-key'});});
 await screen.findByText(replacement.title); await waitFor(()=>expect(stored.get(cacheKey)).toContain(replacement.title));
 const references=stored.get(attemptKey); expect(references).toBeTruthy();
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'old-client-denial'}},403)));
 expect(screen.getAllByText(replacement.title).length).toBeGreaterThan(0);expect(stored.get(cacheKey)).toContain(replacement.title);expect(stored.get(attemptKey)).toBe(references);
 expect(screen.getByLabelText('Crear elemento')).toBeEnabled(); await cleanupAsync();
});

function Lifetime() {
 const [shown,setShown]=useState(true);
 return <><Pressable onPress={()=>setShown(value=>!value)}><Text>Alternar Trabajo de prueba</Text></Pressable><LockGate>{shown?<WorkScreen serverId="A"/>:null}</LockGate></>;
}
test('denial after unmount retires that exact client before remount, with no private replay or new GET',async()=>{
 const {response}=await stagedRequest('notify',<Lifetime/>);
 fireEvent.press(screen.getByText('Alternar Trabajo de prueba'));
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 await waitFor(()=>{expect(stored.get(cacheKey)).toBe('');expect(stored.get(attemptKey)).toBe('');});
 const reads=requests.filter(request=>request.path.startsWith('/v1/kanban')).length;
 fireEvent.press(screen.getByText('Alternar Trabajo de prueba'));
 await waitFor(()=>expect(screen.queryByText(/DISPOSITIVO REVOCADO/)).not.toBeNull());expect(screen.queryByText(item.title)).toBeNull();
 expect(requests.filter(request=>request.path.startsWith('/v1/kanban'))).toHaveLength(reads);await cleanupAsync();
});
test('late terminal denial purges A only while another Server retains private metadata and writable controls',async()=>{
 fixtures();seed([serverA,serverB],{...settings,faceid:false});polling(serverB,[agentA]);
 const other={...item,title:'Trabajo privado del Servidor B'};
 respond(serverB.url,'/v1/kanban/items?limit=100',json({items:[other],counts:{todo:1,in_progress:0,review:0,blocked:0,done:0},revision:rev,observedAt:clockStart,nextCursor:null}));
 const response=deferred<Response>();let started=false;
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,()=>{started=true;return response.promise;},'POST');
 function Switcher(){const [server,setServer]=useState('A');return <><Pressable onPress={()=>setServer('B')}><Text>Cambiar contexto</Text></Pressable><LockGate><WorkScreen serverId={server}/></LockGate></>;}
 const app=renderApp(<Switcher/>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));await waitFor(()=>expect(started).toBe(true));
 fireEvent.press(screen.getByText('Cambiar contexto'));await screen.findByText(other.title);await waitFor(()=>expect(stored.get('relay.work.v1.B')).toContain(other.title));
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 expect(screen.getByText(other.title)).toBeVisible();expect(stored.get('relay.work.v1.B')).toContain(other.title);expect(screen.getByLabelText('Crear elemento')).toBeEnabled();
 await waitFor(()=>expect(stored.get(cacheKey)).toBe(''));await cleanupAsync();
});
test('terminal denial drains already-started native cache/reference writes, and a waiting notice never reaches HTTP',async()=>{
 fixtures(); const pending=deferred<Response>();let started=false;
 respond(serverA.url,`/v1/kanban/items/${id}`,()=>{started=true;return pending.promise;},'PATCH');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();fireEvent.press(await screen.findByText(item.title));await screen.findByLabelText('Editar elemento');
 fireEvent.press(screen.getByLabelText('Mover a En curso'));await waitFor(()=>expect(started).toBe(true));
 const nativeCache=deferred<void>(),nativeReference=deferred<void>();const original=secureStore.setItemAsync.getMockImplementation()!;let cacheWaiting=false,referenceWaiting=false;
 secureStore.setItemAsync.mockImplementation(async(key,value)=>{
  if(key===cacheKey&&value){cacheWaiting=true;await nativeCache.promise;}
  if(key===attemptKey&&value){referenceWaiting=true;await nativeReference.promise;}
  await original(key,value);
 });
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));
 await waitFor(()=>expect(screen.getByLabelText('Avisar al Agente')).toBeEnabled());
 fireEvent.press(screen.getByLabelText('Avisar al Agente'));fireEvent.changeText(screen.getByLabelText('Texto exacto del aviso'),'Aviso que no debe salir');fireEvent.press(screen.getByText('Revisar aviso'));fireEvent.press(screen.getByText('Enviar este aviso'));
 await waitFor(()=>{expect(cacheWaiting).toBe(true);expect(referenceWaiting).toBe(true);});
 await act(async()=>pending.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 expect(screen.queryAllByText(item.title)).toHaveLength(0);
 await act(async()=>{nativeCache.resolve();nativeReference.resolve();});
 await waitFor(()=>{expect(stored.get(cacheKey)).toBe('');expect(stored.get(attemptKey)).toBe('');});
 expect(requests.filter(request=>request.path.endsWith('/notify'))).toHaveLength(0);expect(screen.queryByText('Aviso que no debe salir')).toBeNull();await cleanupAsync();
});

test('independent SPEC: late revocation overrides an older offline cause',async()=>{
 fixtures();const ack=deferred<Response>();let started=false;
 respond(serverA.url,`/v1/kanban/items/${id}/notify`,()=>{started=true;return ack.promise;},'POST');
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();await openPreview();fireEvent.press(screen.getByText('Enviar este aviso'));await waitFor(()=>expect(started).toBe(true));
 respond(serverA.url,'/health',networkError);respond(serverA.url,'/v1/agents',networkError);
 await act(async()=>{app.probe.current!.refresh(serverA.id);});await screen.findByText(/· SIN RESPUESTA$/);
 await act(async()=>ack.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 console.log('SPEC_WORK_DENIAL_CAUSE',JSON.stringify({offlineVisible:!!screen.queryByText(/· SIN RESPUESTA$/),revocationVisible:!!screen.queryByText(/DISPOSITIVO REVOCADO/),titleVisible:screen.queryAllByText(item.title).length>0}));
 await screen.findByText(/DISPOSITIVO REVOCADO/);expect(screen.queryByText(/· SIN RESPUESTA$/)).toBeNull();
});


test('a Work storage failure is opaque and never becomes empty writable Work; an explicit retry restores manual actions',async()=>{
 fixtures([]);
 respond(serverA.url,'/v1/kanban/items?limit=100',json({error:{code:'kanban_store_unavailable',message:'PRIVATE_FILESYSTEM_PATH_CANARY'}},503));
 const app=renderApp(<LockGate><WorkScreen serverId="A"/></LockGate>);await app.ready();
 await screen.findByText('No se pudo cargar Trabajo. Reintenta.');
 expect(screen.queryByText('TRABAJO VACÍO')).toBeNull();
 expect(screen.queryByText(/PRIVATE_FILESYSTEM_PATH_CANARY/)).toBeNull();
 expect(screen.getByLabelText('Crear elemento')).toBeDisabled();
 expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
 fixtures([item]);fireEvent.press(screen.getByText('Reintentar'));
 await screen.findByText(item.title);
 await waitFor(()=>expect(screen.getByLabelText('Crear elemento')).not.toBeDisabled());
 expect(screen.queryByText('No se pudo cargar Trabajo. Reintenta.')).toBeNull();
 expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
 await cleanupAsync();
});
