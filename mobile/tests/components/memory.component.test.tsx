import { Modal } from 'react-native';
import { useState } from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { AgentMemoryScreen } from '@/screens/AgentMemoryScreen';
import { AgentSoulScreen } from '@/screens/AgentSoulScreen';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { seed, polling, serverA, agentA } from '../support/fixtures';
import { biometrics, deferred, emitAppState, emitAppBlur, emitAppFocus, navigation, clockStart, router } from '../support/native';
import { json, networkError, respond, requestsFor } from '../support/transport';
import type { AgentMemory, AgentSoul } from '../../../protocol/agentMemory';
const rev='a'.repeat(64), id='b'.repeat(64);
const memory:AgentMemory={agentId:'agentA',capturedAt:clockStart,buckets:{memory:{exists:true,revision:rev,notes:[{id,text:'Prefiere español.'}],characters:17,limit:2200,writable:true,reason:null},user:{exists:false,revision:rev,notes:[],characters:0,limit:1375,writable:false,reason:'El archivo no existe.'}}};
const soul:AgentSoul={agentId:'agentA',capturedAt:clockStart,exists:true,revision:rev,content:'# Soul\nSé breve.',characters:16,contextLimit:null,writable:true,reason:null};
const path='/v1/agents/agentA/';
function setup() { seed();polling(serverA,[agentA]);respond(serverA.url,path+'memory',json(memory));respond(serverA.url,path+'soul',json(soul)); }
function screen(kind:'memory'|'soul') {return renderApp(<ChatVisibilityProvider value={true}>{kind==='memory'?<AgentMemoryScreen serverId="A" agentId="agentA"/>:<AgentSoulScreen serverId="A" agentId="agentA"/>}</ChatVisibilityProvider>);}

for(const kind of ['memory','soul'] as const) test(`${kind} shows context reconstruction may affect the current Conversation`,async()=>{
 setup();const view=screen(kind);await view.ready();
 await view.findByText(kind==='memory'?'Prefiere español.':'# Soul\nSé breve.');
 expect(view.getByText(/Hermes puede aplicar los cambios al reconstruir el contexto, incluso en esta Conversación\./)).toBeTruthy();
 expect(view.queryByText(/Los cambios se aplican al empezar una Conversación nueva/)).toBeNull();
 if(kind==='memory') {
  fireEvent.press(view.getByLabelText('Borrar nota 01 de Memoria'));
  expect(view.getByText('Hermes dejará de recordarlo cuando reconstruya el contexto. Puede ocurrir en esta Conversación.')).toBeTruthy();
  expect(view.queryByText(/dejará de recordarlo desde la próxima Conversación/)).toBeNull();
 } else {
  fireEvent.press(view.getByText('Editar'));
  expect(view.getByText(/Hermes puede aplicar los cambios al reconstruir el contexto, incluso en esta Conversación\./)).toBeTruthy();
 }
});

test('editing is free and deletion requires confirmation for the exact note',async()=>{
 setup();respond(serverA.url,path+'memory',json(memory),'PATCH');
 const view=screen('memory');await view.ready();await view.findByText('Prefiere español.');
 fireEvent.press(view.getByLabelText('Editar nota 01 de Memoria'));
 fireEvent.changeText(view.getByLabelText('Texto de la nota'),'Más breve.');
 fireEvent.press(view.getByText('Guardar'));
 await waitFor(()=>expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(1));
 expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 expect(requestsFor(serverA.url,path+'memory').find(r=>r.method==='PATCH')?.body).toEqual({bucket:'memory',revision:rev,noteId:id,content:'Más breve.'});
 await waitFor(()=>expect(view.queryByLabelText('Texto de la nota')).toBeNull());
 fireEvent.press(view.getByLabelText('Borrar nota 01 de Memoria'));
 expect(view.getByText('¿Borrar la nota 01?')).toBeTruthy();
 expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(1);
 fireEvent.press(view.getByText('Cancelar'));expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(1);
 fireEvent.press(view.getByLabelText('Borrar nota 01 de Memoria'));fireEvent.press(view.getByText('Borrar'));
 await waitFor(()=>expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(2));
 expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')[1].body).toEqual({bucket:'memory',revision:rev,noteId:id,content:null});
});

test('reading a non-writable bucket never enables its note editor or mutation actions',async()=>{
 setup();respond(serverA.url,path+'memory',json({...memory,buckets:{...memory.buckets,memory:{...memory.buckets.memory,writable:false,reason:'Configuración no verificable.'}}}));
 const view=screen('memory');await view.ready();await view.findByText('Prefiere español.');
 expect(view.queryByLabelText('Editar nota 01 de Memoria')).toBeNull();
 fireEvent.press(view.getByLabelText('Leer nota 01 de Memoria'));
 expect(view.getByLabelText('Texto de la nota').props.editable).toBe(false);
 expect(view.queryByText('Guardar')).toBeNull();expect(view.queryByText('Borrar nota')).toBeNull();
 expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(0);
});

for (const open of ['editor','confirmation'] as const) test(`an open note ${open} obeys a fresh non-writable bucket`,async()=>{
 setup();const view=screen('memory');await view.ready();await view.findByText('Prefiere español.');
 fireEvent.press(view.getByLabelText(open==='editor'?'Editar nota 01 de Memoria':'Borrar nota 01 de Memoria'));
 if(open==='editor')fireEvent.changeText(view.getByLabelText('Texto de la nota'),'Borrador conservado');
 respond(serverA.url,'/v1/agents',json({error:{code:'unavailable'}},503));
 await act(async()=>{view.probe.current!.refresh('A');});
 await waitFor(()=>expect(view.probe.current!.snapshot('A').reachable).toBe(false));
 respond(serverA.url,path+'memory',json({...memory,buckets:{...memory.buckets,memory:{...memory.buckets.memory,writable:false,reason:'Configuración no verificable.'}}}));
 respond(serverA.url,'/v1/agents',json({agents:[agentA]}));
 await act(async()=>{view.probe.current!.refresh('A');});
 await view.findByText('Configuración no verificable.');
 if(open==='editor') {
  expect(view.getByLabelText('Texto de la nota').props.editable).toBe(false);
  expect(view.getByLabelText('Texto de la nota').props.value).toBe('Borrador conservado');
  expect(view.queryByText('Guardar')).toBeNull();expect(view.queryByText('Borrar nota')).toBeNull();
 } else {
  expect(view.getByText('Borrar')).toBeDisabled();fireEvent.press(view.getByText('Borrar'));
 }
 expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(0);
});

for (const open of ['editor','confirmation'] as const) test(`revocation removes the open note ${open} and its private content`,async()=>{
 setup();const view=screen('memory');await view.ready();await view.findByText('Prefiere español.');
 if(open==='editor') {
  fireEvent.press(view.getByLabelText('Editar nota 01 de Memoria'));
  fireEvent.changeText(view.getByLabelText('Texto de la nota'),'Borrador privado');
 } else {
  fireEvent.press(view.getByLabelText('Borrar nota 01 de Memoria'));
  expect(view.getByText('«Prefiere español.»')).toBeTruthy();
 }
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));
 await act(async()=>{view.probe.current!.refresh('A');});
 await waitFor(()=>expect(view.probe.current!.snapshot('A').down?.action).toBe('pair'));
 expect(view.queryByLabelText('Texto de la nota',{includeHiddenElements:true})).toBeNull();
 expect(view.queryByText('«Prefiere español.»',{includeHiddenElements:true})).toBeNull();
 expect(view.queryByText('¿Borrar la nota 01?',{includeHiddenElements:true})).toBeNull();
 expect(view.queryByText('Prefiere español.',{includeHiddenElements:true})).toBeNull();
 expect(requestsFor(serverA.url,path+'memory').filter(r=>r.method==='PATCH')).toHaveLength(0);
});

for(const open of ['editor','confirmation'] as const) test(`the real LockGate withdraws the note ${open} native Modal`,async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const view=renderApp(<LockGate><AgentMemoryScreen serverId="A" agentId="agentA"/></LockGate>);
 await view.ready();await view.findByText('Prefiere español.');
 fireEvent.press(view.getByLabelText(open==='editor'?'Editar nota 01 de Memoria':'Borrar nota 01 de Memoria'));
 if(open==='editor')fireEvent.changeText(view.getByLabelText('Texto de la nota'),'Borrador privado');
 expect(view.UNSAFE_queryAllByType(Modal).filter(modal=>modal.props.visible)).toHaveLength(1);
 await act(async()=>{await jest.advanceTimersByTimeAsync(60000);});
 expect(view.getByText('Relay está bloqueado')).toBeVisible();
 expect(view.UNSAFE_queryAllByType(Modal).filter(modal=>modal.props.visible)).toHaveLength(0);
 expect(view.queryByLabelText('Texto de la nota',{includeHiddenElements:true})).toBeNull();
 expect(view.queryByText('«Prefiere español.»',{includeHiddenElements:true})).toBeNull();
 expect(requestsFor(serverA.url,path+'memory').filter(request=>request.method==='PATCH')).toHaveLength(0);
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 await act(async()=>fireEvent.press(view.getByText('Usar el código del teléfono')));
 if(open==='editor')await waitFor(()=>expect(view.getByLabelText('Texto de la nota').props.value).toBe('Borrador privado'));
 else await view.findByText('¿Borrar la nota 01?');
});

for(const open of ['editor','confirmation'] as const) test(`native app blur withdraws the note ${open} Modal until focus returns`,async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const view=renderApp(<LockGate><AgentMemoryScreen serverId="A" agentId="agentA"/></LockGate>);
 await view.ready();await view.findByText('Prefiere español.');
 fireEvent.press(view.getByLabelText(open==='editor'?'Editar nota 01 de Memoria':'Borrar nota 01 de Memoria'));
 act(()=>emitAppBlur());
 expect(view.UNSAFE_queryAllByType(Modal).filter(modal=>modal.props.visible)).toHaveLength(0);
 act(()=>emitAppFocus());
 expect(view.UNSAFE_queryAllByType(Modal).filter(modal=>modal.props.visible)).toHaveLength(1);
 expect(requestsFor(serverA.url,path+'memory').filter(request=>request.method==='PATCH')).toHaveLength(0);
});

for(const open of ['editor','confirmation'] as const) for(const reason of ['background','blur','scope','hidden'] as const) test(`note ${open} Modal respects ${reason} presentation boundary`,async()=>{
 setup();let change!:(reason:string)=>void;
 function Page() {
  const [boundary,setBoundary]=useState('ready');change=setBoundary;
  const agentId=boundary==='scope'?'agentB':'agentA';
  return <ChatVisibilityProvider value={boundary!=='hidden'}><AgentMemoryScreen serverId="A" agentId={agentId}/></ChatVisibilityProvider>;
 }
 const view=renderApp(<Page/>);await view.ready();await view.findByText('Prefiere español.');
 fireEvent.press(view.getByLabelText(open==='editor'?'Editar nota 01 de Memoria':'Borrar nota 01 de Memoria'));
 if(open==='editor')fireEvent.changeText(view.getByLabelText('Texto de la nota'),'Borrador de otro alcance');
 if(reason==='background')act(()=>emitAppState('background'));
 if(reason==='blur') {navigation.focused=false;act(()=>change('blur'));}
 if(reason==='hidden')act(()=>change('hidden'));
 if(reason==='scope') {
  respond(serverA.url,'/v1/agents/agentB/memory',json({...memory,agentId:'agentB',buckets:{...memory.buckets,memory:{...memory.buckets.memory,notes:[{id,text:'Nota del nuevo Agente.'}],characters:22}}}));
  act(()=>change('scope'));await view.findByText('Nota del nuevo Agente.');
 }
 expect(view.UNSAFE_queryAllByType(Modal).filter(modal=>modal.props.visible)).toHaveLength(0);
 expect(view.queryByLabelText('Texto de la nota',{includeHiddenElements:true})).toBeNull();
 expect(view.queryByText('«Prefiere español.»',{includeHiddenElements:true})).toBeNull();
 expect(requestsFor(serverA.url,path+'memory').filter(request=>request.method==='PATCH')).toHaveLength(0);
});

test('SOUL requires strong Android biometrics and a pending ref prevents duplicate prompts',async()=>{
 setup();respond(serverA.url,path+'soul',json(soul),'PUT');const auth=deferred<{success:boolean}>();
 biometrics.authenticateAsync.mockImplementation(()=>auth.promise);
 const view=screen('soul');await view.ready();await view.findByText('# Soul\nSé breve.');
 fireEvent.press(view.getByText('Editar'));fireEvent.changeText(view.getByLabelText('Texto de SOUL.md'),'Nueva personalidad');
 const save=view.getByText('Guardar con huella');act(()=>{fireEvent.press(save);fireEvent.press(save);});
 await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
 expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({disableDeviceFallback:true,biometricsSecurityLevel:'strong'}));
 expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(0);
 await act(async()=>auth.resolve({success:true}));
 await waitFor(()=>expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(1));
 expect(requestsFor(serverA.url,path+'soul').find(r=>r.method==='PUT')?.body).toEqual({revision:rev,content:'Nueva personalidad'});
});

test.each(['background','hidden','blur','unmount','removed','revoked'] as const)('late successful huella cannot save after %s',async reason=>{
 setup();respond(serverA.url,path+'soul',json(soul),'PUT');
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);
 let update!: (v:boolean)=>void;
 function Visibility() {
  const [visible,setVisible]=useState(true);update=setVisible;
  return <ChatVisibilityProvider value={visible}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>;
 }
 const view=renderApp(<Visibility/>);await view.ready();await view.findByText('# Soul\nSé breve.');
 fireEvent.press(view.getByText('Editar'));fireEvent.press(view.getByText('Guardar con huella'));
 await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
 if(reason==='background')act(()=>emitAppState('background'));
 if(reason==='hidden')act(()=>update(false));
 if(reason==='blur') { const {navigation}=require('../support/native');navigation.focused=false;act(()=>update(false)); }
 if(reason==='unmount')await view.unmount();
 if(reason==='removed')await act(async()=>{await view.probe.current!.removeServer('A');});
 if(reason==='revoked') {
  respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'PRIVATE'}},403));
  await act(async()=>{view.probe.current!.refresh();});
  await waitFor(()=>expect(view.probe.current!.snapshot('A').reachable).toBe(false));
 }
 await act(async()=>auth.resolve({success:true}));
 expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(0);
});

test('failed huella keeps the complete editor and sends nothing',async()=>{
 setup();const view=screen('soul');await view.ready();await view.findByText('# Soul\nSé breve.');
 fireEvent.press(view.getByText('Editar'));fireEvent.changeText(view.getByLabelText('Texto de SOUL.md'),'Borrador conservado');
 fireEvent.press(view.getByText('Guardar con huella'));
 await view.findByText('Huella no confirmada. Nada se guardó.');
 expect(view.getByLabelText('Texto de SOUL.md').props.value).toBe('Borrador conservado');
 expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(0);
});

test('offline cache is dated and read-only, and an error without cache can retry',async()=>{
 setup();const view=screen('memory');await view.ready();await view.findByText('Prefiere español.');
 respond(serverA.url,path+'memory',json({error:{code:'agent_memory_unavailable',message:'PRIVATE'}},503));
 respond(serverA.url,'/v1/agents',json({error:{code:'unavailable',message:'PRIVATE'}},503));
 await act(async()=>{view.probe.current!.refresh();});
 await view.findByText('SOLO LECTURA · ÚLTIMO CONOCIDO');
 expect(view.queryByLabelText('Editar nota 01 de Memoria')).toBeNull();
 expect(view.getByText(/Guardado.*hace/)).toBeTruthy();
 expect(view.getByText('Prefiere español.')).toBeTruthy();
 expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test('loading and errors without a cache are honest and retry fetches a fresh snapshot',async()=>{
 setup();const response=deferred<Response>();respond(serverA.url,path+'memory',response.promise);
 const view=screen('memory');await view.ready();expect(view.getByLabelText('Cargando datos del Agente…')).toBeTruthy();
 await act(async()=>response.resolve(json({error:{code:'agent_memory_unavailable',message:'PRIVATE'}},503)));
 await view.findByText('ERROR');
 expect(view.queryByText('Prefiere español.')).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();
 respond(serverA.url,path+'memory',json(memory));fireEvent.press(view.getByText('Reintentar'));
 await view.findByText('Prefiere español.');expect(view.getByLabelText('Editar nota 01 de Memoria')).toBeTruthy();
});

test('SOUL truncation warning allows complete saving, missing SOUL is created only explicitly',async()=>{
 setup();const missing={...soul,exists:false,content:'',characters:0,contextLimit:3};
 respond(serverA.url,path+'soul',json(missing));respond(serverA.url,path+'soul',json(soul),'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});
 const view=screen('soul');await view.ready();await view.findByText('SIN MEMORIA · SIN SOUL.md');expect(view.getByText('SOUL.md todavía no existe. Se creará al guardar.')).toBeTruthy();
 expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(0);
 fireEvent.press(view.getByText('Editar'));fireEvent.changeText(view.getByLabelText('Texto de SOUL.md'),'Texto completo');
 expect(view.getByText('Hermes truncará este archivo al cargarlo en el contexto. Puedes guardar el texto completo.')).toBeTruthy();
 fireEvent.press(view.getByText('Guardar con huella'));
 await waitFor(()=>expect(requestsFor(serverA.url,path+'soul').find(r=>r.method==='PUT')?.body).toEqual({revision:rev,content:'Texto completo'}));
});

test('a persisted snapshot survives reopening offline, while revocation hides cached content',async()=>{
 setup();let reopen!:(v:boolean)=>void;
 function Page() {const [open,setOpen]=useState(true);reopen=setOpen;return <ChatVisibilityProvider value={true}>{open?<AgentMemoryScreen serverId="A" agentId="agentA"/>:null}</ChatVisibilityProvider>;}
 const view=renderApp(<Page/>);await view.ready();await view.findByText('Prefiere español.');
 await act(async()=>{reopen(false);});
 respond(serverA.url,'/v1/agents',json({error:{code:'unavailable'}},503));respond(serverA.url,path+'memory',json({error:{code:'agent_memory_unavailable'}},503));
 await act(async()=>{view.probe.current!.refresh();});
 await waitFor(()=>expect(view.probe.current!.snapshot('A').reachable).toBe(false));
 await act(async()=>{reopen(true);});await view.findByText('SOLO LECTURA · ÚLTIMO CONOCIDO');
 expect(view.getByText('Prefiere español.')).toBeTruthy();expect(view.queryByLabelText('Editar nota 01 de Memoria')).toBeNull();
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));
 await act(async()=>{view.probe.current!.refresh('A');});
 await waitFor(()=>expect(view.queryByText('Prefiere español.')).toBeNull());
});

test('the real LockGate blocks a late SOUL save at the idle threshold and retains the hidden draft',async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const view=renderApp(<LockGate><AgentSoulScreen serverId="A" agentId="agentA"/></LockGate>);await view.ready();await view.findByText('# Soul\nSé breve.');
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);
 fireEvent.press(view.getByText('Editar'));fireEvent.changeText(view.getByLabelText('Texto de SOUL.md'),'Borrador privado');fireEvent.press(view.getByText('Guardar con huella'));
 await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
 await act(async()=>{await jest.advanceTimersByTimeAsync(60000);});
 expect(view.getByText('Relay está bloqueado')).toBeVisible();expect(view.queryByLabelText('Texto de SOUL.md')).toBeNull();
 await act(async()=>auth.resolve({success:true}));
 expect(requestsFor(serverA.url,path+'soul').filter(r=>r.method==='PUT')).toHaveLength(0);
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 await act(async()=>fireEvent.press(view.getByText('Usar el código del teléfono')));
 expect(view.getByLabelText('Texto de SOUL.md').props.value).toBe('Borrador privado');
});

test('SOUL of an unresponsive Servidor shows the screen block, disables the preset rows and still opens the Presets of that Servidor',async()=>{
 setup();respond(serverA.url,'/health',()=>networkError());respond(serverA.url,path+'soul',json({error:{code:'agent_memory_unavailable'}},503));
 const view=screen('soul');await view.ready();
 await view.findByText('SIN RESPUESTA · REVISA TAILNET');
 expect(view.getByText('Servidor A no contesta; no se pudo leer SOUL.md. Relay lo reintenta solo.')).toBeTruthy();
 expect(view.getAllByText('Reintentar').length).toBeGreaterThan(0);expect(view.getByText('Personalidad')).toBeTruthy();expect(view.getByText('AGENTA · SOUL.md')).toBeTruthy();
 expect(view.getByText('Aplicar preset SOUL')).toBeDisabled();expect(view.getByText('Guardar SOUL actual como preset')).toBeDisabled();
 expect(view.getByText('EN SERVIDORES › SERVIDOR A')).toBeTruthy();
 fireEvent.press(view.getByText('Presets de personalidad'));
 expect(router.push).toHaveBeenCalledWith({pathname:'/presets/[server]',params:{server:'A'}});
});

test('Memoria of an unresponsive Servidor says it could not read the memory; an agent with no notes says SIN MEMORIA',async()=>{
 setup();respond(serverA.url,'/health',()=>networkError());respond(serverA.url,path+'memory',json({error:{code:'agent_memory_unavailable'}},503));
 const view=screen('memory');await view.ready();
 await view.findByText('SIN RESPUESTA · REVISA TAILNET');
 expect(view.getByText('Servidor A no contesta; no se pudo leer la memoria. Relay lo reintenta solo.')).toBeTruthy();
 expect(view.getByText('Memoria')).toBeTruthy();
});

test('an agent with no memory notes shows SIN MEMORIA instead of empty lists',async()=>{
 setup();const empty:AgentMemory={...memory,buckets:{memory:{...memory.buckets.memory,notes:[],characters:0},user:memory.buckets.user}};
 respond(serverA.url,path+'memory',json(empty));
 const view=screen('memory');await view.ready();
 await view.findByText('SIN MEMORIA · SIN SOUL.md');
 expect(view.getByText('Agente A todavía no tiene memoria guardada en Servidor A.')).toBeTruthy();
});
