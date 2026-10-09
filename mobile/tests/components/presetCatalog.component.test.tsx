import { Pressable, Text } from 'react-native';
import { ThemeProvider, useThemePreference } from '@/theme/ThemeProvider';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/theme/tokens';
import { useState } from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { PersonalityPresetsScreen } from '@/screens/PersonalityPresetsScreen';
import { AgentSoulScreen } from '@/screens/AgentSoulScreen';
import { ConversationPersonalityControl } from '@/screens/chat/ConversationPersonalityControl';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA,conversationA,polling,seed,serverA,serverB } from '../support/fixtures';
import { biometrics,clockStart,deferred,emitAppBlur,emitAppFocus,emitAppState,router,stored,resizeWindow } from '../support/native';
import { json,requestsFor,respond } from '../support/transport';
import { drag } from '../support/gestures';
const root='/v1/personality-presets',id='11111111-1111-4111-8111-111111111111',rev='a'.repeat(64),next='b'.repeat(64);
const preset={id,revision:rev,name:'Breve',kind:'overlay' as const,bytes:5,content:'Breve',createdAt:clockStart,updatedAt:clockStart};
const {content,...summary}=preset;void content;
const catalog={revision:rev,capturedAt:clockStart,presets:[summary]};
function setup(){seed([serverA,serverB]);for(const s of [serverA,serverB]){polling(s,[agentA]);respond(s.url,root,json(catalog));respond(s.url,`${root}/${id}/versions/${rev}`,json(preset));}}
/** Pull to refresh past the 60 px threshold (120 px of finger at ×0.5), then let its reload settle. */
async function pull(_view:unknown){drag('pull-to-refresh',[{y:60},{y:130}]);await act(async()=>{});}
function page(){return renderApp(<ChatVisibilityProvider value={true}><PersonalityPresetsScreen serverId="A"/></ChatVisibilityProvider>);}
test('catalogue loads no content; editing reads the selected immutable version and ACK only, without huella',async()=>{
 setup();const view=page();await view.ready();await view.findByLabelText('Breve');expect(requestsFor(serverA.url,`${root}/${id}/versions/${rev}`)).toHaveLength(0);
 fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');expect(view.getByLabelText('Contenido del preset').props.value).toBe('Breve');
 fireEvent.changeText(view.getByLabelText('Nombre del preset'),'Revisión');fireEvent.changeText(view.getByLabelText('Contenido del preset'),'Nueva');
 const ack=deferred<Response>();respond(serverA.url,`${root}/${id}`,ack.promise,'PATCH');fireEvent.press(view.getByText('Guardar preset'));
 await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1));expect(view.queryByText('Guardando…')).not.toBeNull();expect(view.queryByText('Preset guardado.')).toBeNull();
 await act(async()=>ack.resolve(json({...preset,revision:next,name:'Revisión',content:'Nueva'})));await view.findByText('Preset guardado.');await view.findByLabelText('Breve');expect(biometrics.authenticateAsync).not.toHaveBeenCalled();expect([...stored.keys()].filter(k=>/preset|personality/.test(k))).toEqual([]);
});
test('create pins catalogue revision, type and content, deletion requires explicit free confirmation',async()=>{
 setup();respond(serverA.url,root,json({...preset,kind:'soul',name:'SOUL breve'}),'POST');respond(serverA.url,`${root}/${id}`,json({id,revision:rev,deleted:true}),'DELETE');
 const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Crear preset'));fireEvent.changeText(view.getByLabelText('Nombre del preset'),'SOUL breve');fireEvent.press(view.getByText('SOUL del Agente'));fireEvent.changeText(view.getByLabelText('Contenido del preset'),'Breve');fireEvent.press(view.getByText('Guardar preset'));
 await view.findByText('Preset guardado.');expect(requestsFor(serverA.url,root).find(r=>r.method==='POST')?.body).toEqual({requestId:expect.any(String),catalogRevision:rev,name:'SOUL breve',kind:'soul',content:'Breve'});
 fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Borrar preset'));expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='DELETE')).toHaveLength(0);fireEvent.press(view.getByText('Confirmar borrado'));await view.findByText('Preset borrado.');await view.findByLabelText('Breve');expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});
test.each(['personality_conflict','personality_uncertain'] as const)('%s disables replay and reload discards the draft',async code=>{
 setup();respond(serverA.url,`${root}/${id}`,json({error:{code,message:'PRIVATE'}},code==='personality_conflict'?409:503),'PATCH');const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));
 await waitFor(()=>expect(view.getByText('Guardar preset')).toBeDisabled());expect(view.queryByText('PRIVATE')).toBeNull();fireEvent.press(view.getByText('Guardar preset'));expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1);fireEvent.press(view.getByText('Recargar'));await waitFor(()=>expect(view.queryByLabelText('Contenido del preset')).toBeNull());await view.findByLabelText('Breve');
});
test.each(['device_revoked','key_unknown','cleartext'] as const)('known %s diagnosis removes revoked catalogue without private error',async reason=>{
 setup();const view=page();await view.ready();await view.findByLabelText('Breve');
 respond(serverA.url,root,reason==='cleartext'?()=>Promise.reject(new Error('CLEARTEXT communication to synthetic not permitted by network security policy')):json({error:{code:reason,message:'PRIVATE'}},403));
 await pull(view);await view.findByText(reason==='device_revoked'?'SIN ACCESO':reason==='key_unknown'?/LLAVE RECHAZADA/:/HTTP BLOQUEADO POR ANDROID/);expect(view.queryByText('PRIVATE')).toBeNull();expect(view.queryByLabelText('Breve')).toBeNull();
});
test('loading, empty and wide catalogue are explicit states',async()=>{
 setup();resizeWindow(1100,800);const read=deferred<Response>();respond(serverA.url,root,read.promise);const view=page();await view.ready();await view.findByText('CARGANDO PRESETS…');await act(async()=>read.resolve(json({...catalog,presets:[]})));await view.findByText('Todavía no hay presets en este Servidor.');expect(view.getByLabelText('Crear preset')).toBeEnabled();
});
test.each(['hidden','blur','background','server'] as const)('free delete confirmation is removed after %s without an effect',async reason=>{
 setup();let show!:(v:boolean)=>void,scope!:(v:string)=>void;function Page(){const [visible,setVisible]=useState(true),[s,setServer]=useState('A');show=setVisible;scope=setServer;return <ChatVisibilityProvider value={visible}><PersonalityPresetsScreen serverId={s}/></ChatVisibilityProvider>;}
 const view=renderApp(<Page/>);await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Borrar preset'));
 if(reason==='hidden'){act(()=>show(false));act(()=>show(true));}if(reason==='blur'){act(()=>emitAppBlur());act(()=>emitAppFocus());}if(reason==='background'){act(()=>emitAppState('background'));act(()=>emitAppState('active'));}if(reason==='server')act(()=>scope('B'));
 expect(view.queryByText('Confirmar borrado',{includeHiddenElements:true})).toBeNull();expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='DELETE')).toHaveLength(0);await view.findByLabelText('Breve');
});
test('LockGate unmounts private editor rather than hiding its native Modal',async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});const view=renderApp(<LockGate><PersonalityPresetsScreen serverId="A"/></LockGate>);await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(view.queryByLabelText('Contenido del preset',{includeHiddenElements:true})).toBeNull();expect(view.getByText('Relay está bloqueado')).toBeVisible();
});

test('name, UTF-8 content and catalogue limits disable invalid writes locally',async()=>{
 setup();const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Crear preset'));fireEvent.changeText(view.getByLabelText('Nombre del preset'),'N'.repeat(101));fireEvent.changeText(view.getByLabelText('Contenido del preset'),'ñ'.repeat(32769));expect(view.getByText('Guardar preset')).toBeDisabled();fireEvent.press(view.getByText('Guardar preset'));expect(requestsFor(serverA.url,root).filter(r=>r.method==='POST')).toHaveLength(0);fireEvent.press(view.getByText('Cerrar'));
 const presets=Array.from({length:64},(_,i)=>({...summary,id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,name:`Preset ${i}`}));respond(serverA.url,root,json({...catalog,presets}));await pull(view);await view.findByLabelText('Preset 63');expect(view.getByLabelText('Crear preset')).toBeDisabled();
});
test('late catalogue ACK after blur cannot reopen an editor or claim a saved change',async()=>{
 setup();const ack=deferred<Response>();respond(serverA.url,`${root}/${id}`,ack.promise,'PATCH');const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1));act(()=>emitAppBlur());act(()=>emitAppFocus());await act(async()=>ack.resolve(json({...preset,revision:next})));await view.findByLabelText('Breve');expect(view.queryByText('Preset guardado.')).toBeNull();expect(view.queryByLabelText('Contenido del preset',{includeHiddenElements:true})).toBeNull();
});

test('closing a conflicted editor does not allow another stale write without a fresh reload',async()=>{
 setup();respond(serverA.url,`${root}/${id}`,json({error:{code:'personality_conflict'}},409),'PATCH');const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));await waitFor(()=>expect(view.getByText('Guardar preset')).toBeDisabled());fireEvent.press(view.getByText('Cerrar'));expect(view.getByLabelText('Breve')).toBeDisabled();expect(view.getByLabelText('Crear preset')).toBeDisabled();fireEvent.press(view.getByLabelText('Breve'));expect(view.queryByLabelText('Contenido del preset')).toBeNull();fireEvent.press(view.getByText('Recargar'));await waitFor(()=>expect(view.getByLabelText('Breve')).toBeEnabled());
});


test('changing theme recolors the preset catalogue and open editor while preserving its draft without writes',async()=>{
 setup();
 function ThemeToggle(){const {setPreference}=useThemePreference();return <Pressable onPress={()=>setPreference('dark')}><Text>Choose dark presets</Text></Pressable>;}
 const view=renderApp(<ThemeProvider><ThemeToggle/><ChatVisibilityProvider value={true}><PersonalityPresetsScreen serverId="A"/></ChatVisibilityProvider></ThemeProvider>);
 await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Nombre del preset');
 fireEvent.changeText(view.getByLabelText('Nombre del preset'),'Borrador tras tema');
 expect(view.getByLabelText('Nombre del preset')).toHaveStyle({color:LIGHT_PALETTE.K.ink,backgroundColor:LIGHT_PALETTE.K.field});
 fireEvent.press(view.getByText('Choose dark presets'));
 await waitFor(()=>expect(view.getByLabelText('Nombre del preset')).toHaveStyle({color:DARK_PALETTE.K.ink,backgroundColor:DARK_PALETTE.K.field}));
 expect(view.getByLabelText('Nombre del preset')).toHaveProp('value','Borrador tras tema');
 expect(view.getByLabelText('Contenido del preset')).toHaveStyle({color:DARK_PALETTE.K.onScreenBright,backgroundColor:DARK_PALETTE.K.screen});
 expect(view.getByText('Guardar preset')).toHaveStyle({color:'#1A1A19'});
 expect(requestsFor(serverA.url,root).filter(r=>r.method!=='GET')).toHaveLength(0);
 expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method!=='GET')).toHaveLength(0);
});

test('independent SPEC: late revoked PATCH after blur and focus clears the same client catalogue',async()=>{
 setup();const ack=deferred<Response>();respond(serverA.url,`${root}/${id}`,ack.promise,'PATCH');
 const view=page();await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));
 await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1));
 act(()=>emitAppBlur());act(()=>emitAppFocus());await view.findByLabelText('Breve');
 await act(async()=>ack.resolve(json({error:{code:'device_revoked',message:'PRIVATE synthetic rejection'}},403)));
 console.log('SPEC_PRESETS_LATE_REVOKED',JSON.stringify({privateRowVisible:!!view.queryByLabelText('Breve'),revocationVisible:!!view.queryByText('SIN ACCESO'),writes:requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH').length}));
 expect(view.queryByLabelText('Breve',{includeHiddenElements:true})).toBeNull();
 await view.findByText('SIN ACCESO');
});

test.each(['remount-before','remount-after','replacement'] as const)('late credential rejection retires only the same client across %s',async reason=>{
 setup();let show!:(v:boolean)=>void;function Page(){const [mounted,set]=useState(true);show=set;return <ChatVisibilityProvider value={true}>{mounted?<PersonalityPresetsScreen serverId="A"/>:null}</ChatVisibilityProvider>;}
 const ack=deferred<Response>();respond(serverA.url,`${root}/${id}`,ack.promise,'PATCH');const view=renderApp(<Page/>);await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1));
 if(reason==='remount-before'){act(()=>show(false));act(()=>show(true));await view.findByLabelText('Breve');}
 if(reason==='replacement')await act(async()=>{await view.probe.current!.replaceServer('A',{name:serverA.name,url:serverA.url,deviceId:serverA.deviceId,key:'fresh-key'});});
 await act(async()=>ack.resolve(json({error:{code:'device_revoked',message:'PRIVATE'}},403)));
 if(reason==='replacement'){act(()=>emitAppBlur());act(()=>emitAppFocus());expect(view.queryByText('SIN ACCESO')).toBeNull();await view.findByLabelText('Breve');expect(view.getByLabelText('Crear preset')).toBeEnabled();return;}
 if(reason==='remount-after'){act(()=>show(false));act(()=>show(true));}
 expect(view.queryByLabelText('Breve',{includeHiddenElements:true})).toBeNull();await waitFor(()=>expect(view.queryByText('SIN ACCESO')).not.toBeNull());expect(view.queryByText('Crear preset')).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();const count=requestsFor(serverA.url,root).length;act(()=>emitAppBlur());act(()=>emitAppFocus());await act(async()=>{});expect(requestsFor(serverA.url,root)).toHaveLength(count);expect(view.queryByLabelText('Breve',{includeHiddenElements:true})).toBeNull();
});

test('retirement propagates between catalogue, SOUL and overlay remounts without new private reads',async()=>{
 setup();let page!:(v:'catalogue'|'soul'|'overlay')=>void;function Page(){const [route,set]=useState<'catalogue'|'soul'|'overlay'>('catalogue');page=set;return <ChatVisibilityProvider value={true}>{route==='catalogue'?<PersonalityPresetsScreen serverId="A"/>:route==='soul'?<AgentSoulScreen serverId="A" agentId="agentA"/>:<ConversationPersonalityControl serverId="A" agentId="agentA" conversation={conversationA} running={false}/>}</ChatVisibilityProvider>;}
 const ack=deferred<Response>();respond(serverA.url,`${root}/${id}`,ack.promise,'PATCH');const view=renderApp(<Page/>);await view.ready();await view.findByLabelText('Breve');fireEvent.press(view.getByLabelText('Breve'));await view.findByLabelText('Contenido del preset');fireEvent.press(view.getByText('Guardar preset'));await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}`).filter(r=>r.method==='PATCH')).toHaveLength(1));await act(async()=>ack.resolve(json({error:{code:'device_revoked',message:'PRIVATE'}},403)));await view.findByText('SIN ACCESO');const count=requestsFor(serverA.url,root).length;
 act(()=>page('soul'));await view.findByText(/DISPOSITIVO REVOCADO/);expect(requestsFor(serverA.url,'/v1/agents/agentA/soul')).toHaveLength(0);expect(view.queryByText('Aplicar preset SOUL')).toBeNull();act(()=>page('overlay'));await view.findByText(/DISPOSITIVO REVOCADO/);expect(view.getByLabelText('Personalidad de esta Conversación')).toBeDisabled();fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));act(()=>page('catalogue'));await view.findByText('SIN ACCESO');expect(view.queryByLabelText('Breve',{includeHiddenElements:true})).toBeNull();expect(requestsFor(serverA.url,root)).toHaveLength(count);
});

test('the catalogue is rows in a block with «+» to create; «Actualizar» is gone and a pull reloads it',async()=>{
 setup();const view=page();await view.ready();await view.findByLabelText('Breve');
 expect(view.queryByText('Actualizar')).toBeNull();expect(view.getByLabelText('Crear preset')).toBeEnabled();
 expect(view.getByText('1 / 64 PRESETS · VERSIONES INMUTABLES')).toBeTruthy();expect(view.getByText('CAPA DE CONVERSACIÓN · 5 BYTES')).toBeTruthy();
 const reads=()=>requestsFor(serverA.url,root).filter(r=>r.method==='GET').length,before=reads();
 respond(serverA.url,root,json({...catalog,presets:[]}));
 drag('pull-to-refresh',[{y:40}]);await act(async()=>{});expect(reads()).toBe(before);
 await pull(view);await view.findByText('Todavía no hay presets en este Servidor.');expect(reads()).toBe(before+1);expect(view.queryByLabelText('Breve')).toBeNull();
});
test('a revoked device reads SIN ACCESO with its way out to pair again',async()=>{
 setup();const view=page();await view.ready();await view.findByLabelText('Breve');
 respond(serverA.url,root,json({error:{code:'device_revoked',message:'PRIVATE'}},403));await pull(view);
 await view.findByText('SIN ACCESO');expect(view.getByText(`Este dispositivo perdió el acceso a ${serverA.name}.`)).toBeTruthy();expect(view.queryByLabelText('Breve')).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();
 fireEvent.press(view.getByText('Emparejar de nuevo'));expect(router.push).toHaveBeenCalledWith({pathname:'/connect',params:{serverId:'A'}});
});

test('a snapshot that already knows the device is revoked reads SIN ACCESO before any catalogue request',async()=>{
 setup();respond(serverA.url,'/health',json({error:{code:'device_revoked',message:'PRIVATE'}},403));
 const view=page();await view.ready();await view.findByText('SIN ACCESO');
 expect(view.getByText(`Este dispositivo perdió el acceso a ${serverA.name}.`)).toBeTruthy();expect(view.queryByText(/Empareja de nuevo con el Puente para consultar presets/)).toBeNull();
 expect(view.getByText('Emparejar de nuevo')).toBeTruthy();
});
