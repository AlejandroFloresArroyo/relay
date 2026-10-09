import { useState } from 'react';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { AgentSoulScreen } from '@/screens/AgentSoulScreen';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES } from '../../../protocol/agentMemory';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA, polling, seed, serverA, serverB } from '../support/fixtures';
import { biometrics, deferred, clockStart, emitAppBlur, emitAppFocus, emitAppState, navigation, stored } from '../support/native';
import { json, networkError, requestsFor, respond } from '../support/transport';
const id='11111111-1111-4111-8111-111111111111',rev='a'.repeat(64),next='b'.repeat(64);
const soul={agentId:'agentA',capturedAt:clockStart,exists:true,revision:rev,content:'SOUL anterior completo',characters:22,contextLimit:null,writable:true,reason:null};
const preset={id,revision:rev,name:'Revisor',kind:'soul',bytes:22,content:'Reemplazo íntegro SOUL',createdAt:clockStart,updatedAt:clockStart};
soul.characters=[...soul.content].length;preset.bytes=new TextEncoder().encode(preset.content).byteLength;
const root='/v1/personality-presets',previewPath=`/v1/agents/agentA/soul/preset-preview?presetId=${id}&presetRevision=${rev}`,applyPath='/v1/agents/agentA/soul/preset';
function setup(){seed([serverA,serverB]);polling(serverA,[agentA]);polling(serverB,[agentA]);for(const s of [serverA,serverB]){
 respond(s.url,'/v1/agents/agentA/soul',json(soul));const {content,...summary}=preset;void content;
 respond(s.url,root,json({revision:rev,capturedAt:clockStart,presets:[summary]}));respond(s.url,previewPath,json({agentId:'agentA',preset,soul}));
 respond(s.url,applyPath,(r)=>json({requestId:(r.body as {requestId:string}).requestId,presetId:id,presetRevision:rev,soul:{...soul,revision:next,content:preset.content,characters:[...preset.content].length}}),'PUT');
}}
async function preview(view:ReturnType<typeof renderApp>){await view.ready();await view.findByText(soul.content);fireEvent.press(view.getByText('Aplicar preset SOUL'));await view.findByText('Revisor');await waitFor(()=>expect(view.getByLabelText('Revisor')).toBeEnabled());fireEvent.press(view.getByLabelText('Revisor'));await view.findByText(preset.content);}
test('the SOUL presets sit in a block, so they keep their separators',async()=>{
 setup();const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText(soul.content);fireEvent.press(view.getByText('Aplicar preset SOUL'));await view.findByText('Revisor');
 expect(within(view.getByTestId('list-block')).getByLabelText('Revisor')).toBeTruthy();
});
test('exact old SOUL and immutable replacement precede a new strong huella and ACK',async()=>{
 setup();const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);
 expect(view.getAllByText(soul.content).length).toBeGreaterThan(0);expect(view.getByText(`Preset · ${rev}`)).toBeTruthy();expect(view.getByText(`SOUL · ${rev}`)).toBeTruthy();expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);
 act(()=>{fireEvent.press(view.getByText('Reemplazar con huella'));fireEvent.press(view.getByText('Reemplazar con huella'));});
 await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({disableDeviceFallback:true,biometricsSecurityLevel:'strong'}));
 expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);await act(async()=>auth.resolve({success:true}));
 await waitFor(()=>expect(requestsFor(serverA.url,applyPath)).toHaveLength(1));expect(requestsFor(serverA.url,applyPath)[0].body).toEqual({requestId:expect.any(String),presetId:id,presetRevision:rev,soulRevision:rev});
 expect(requestsFor(serverA.url,'/v1/agents/agentA/soul').filter(r=>r.method==='PUT')).toHaveLength(0);expect([...stored.keys()].filter(k=>/preset|personality/.test(k))).toEqual([]);
});
test.each(['hidden','background','native-blur','nav-blur','unmount','server','agent','revoked'] as const)('late huella after %s is permanently invalidated even if presentation returns',async reason=>{
 setup();let visibility!:(v:boolean)=>void,scope!:(v:string)=>void,agent!:(v:string)=>void;
 function Page(){const [visible,setVisible]=useState(true),[server,setServer]=useState('A'),[a,setAgent]=useState('agentA');visibility=setVisible;scope=setServer;agent=setAgent;return <ChatVisibilityProvider value={visible}><AgentSoulScreen serverId={server} agentId={a}/></ChatVisibilityProvider>;}
 const view=renderApp(<Page/>);await preview(view);const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
 if(reason==='hidden'){act(()=>visibility(false));act(()=>visibility(true));}
 if(reason==='background'){act(()=>emitAppState('background'));act(()=>emitAppState('active'));}
 if(reason==='native-blur'){act(()=>emitAppBlur());act(()=>emitAppFocus());}
 if(reason==='nav-blur'){navigation.focused=false;act(()=>visibility(false));navigation.focused=true;act(()=>visibility(true));}
 if(reason==='unmount')await view.unmount();if(reason==='server')act(()=>scope('B'));
 if(reason==='agent'){respond(serverA.url,'/v1/agents/other/soul',json({...soul,agentId:'other'}));act(()=>agent('other'));}
 if(reason==='revoked'){respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));await act(async()=>view.probe.current!.refresh('A'));await waitFor(()=>expect(view.probe.current!.snapshot('A').reachable).toBe(false));}
 await act(async()=>auth.resolve({success:true}));expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);expect(requestsFor(serverB.url,applyPath)).toHaveLength(0);if(reason!=='unmount')expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();
});
test('real LockGate withdraws the entire preset sheet at idle and a late huella cannot replace SOUL',async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});const view=renderApp(<LockGate><AgentSoulScreen serverId="A" agentId="agentA"/></LockGate>);await preview(view);
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
 await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(view.getByText('Relay está bloqueado')).toBeVisible();expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();await act(async()=>auth.resolve({success:true}));expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);
});
test.each(['before','after'] as const)('changed SOUL %s huella requires a new exact preview, never automatic replay',async when=>{
 setup();const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);const changed={...soul,revision:next,content:'SOUL cambiado',characters:13};
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);if(when==='before')respond(serverA.url,previewPath,json({agentId:'agentA',preset,soul:changed}));fireEvent.press(view.getByText('Reemplazar con huella'));
 if(when==='after'){await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));respond(serverA.url,previewPath,json({agentId:'agentA',preset,soul:changed}));await act(async()=>auth.resolve({success:true}));}
 await waitFor(()=>expect(requestsFor(serverA.url,applyPath)).toHaveLength(0));await waitFor(()=>expect(view.queryByText('SOUL cambió. Revisa la nueva vista previa y confirma de nuevo.')).not.toBeNull());if(when==='before')expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test.each(['hardware','enrollment'] as const)('a hidden screen cannot start a native huella after deferred %s',async boundary=>{
 setup();let visibility!:(v:boolean)=>void;function Page(){const [show,setShow]=useState(true);visibility=setShow;return <ChatVisibilityProvider value={show}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>;}
 const view=renderApp(<Page/>);await preview(view);const check=deferred<boolean>();if(boundary==='hardware')biometrics.hasHardwareAsync.mockImplementation(()=>check.promise);else biometrics.isEnrolledAsync.mockImplementation(()=>check.promise);
 fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(boundary==='hardware'?biometrics.hasHardwareAsync:biometrics.isEnrolledAsync).toHaveBeenCalled());act(()=>visibility(false));await act(async()=>check.resolve(true));expect(biometrics.authenticateAsync).not.toHaveBeenCalled();expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);
});
test('closing the preset sheet cancels a pending huella even while the SOUL screen stays visible',async()=>{
 setup();const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));fireEvent.press(view.getByText('Cerrar'));await act(async()=>auth.resolve({success:true}));expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);expect(view.queryByText(preset.content)).toBeNull();
});
test('an uncertain SOUL ACK requires reload and cannot automatically replay or claim success',async()=>{
 setup();respond(serverA.url,applyPath,json({error:{code:'personality_uncertain',message:'PRIVATE'}},503),'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);fireEvent.press(view.getByText('Reemplazar con huella'));await view.findByText('El cambio quedó sin confirmar. Recarga; no se enviará otra vez automáticamente.');expect(view.getByText('Reemplazar con huella')).toBeDisabled();expect(view.queryByText('PRIVATE')).toBeNull();fireEvent.press(view.getByText('Reemplazar con huella'));expect(requestsFor(serverA.url,applyPath)).toHaveLength(1);expect(view.getByText(preset.content)).toBeTruthy();
});
test.each([['network',()=>networkError()],['bad gateway',()=>json({error:{code:'http',message:'PRIVATE'}},502)],['unavailable',()=>json({error:{code:'personality_unavailable',message:'PRIVATE'}},503)]] as const)('a non-definitive apply failure (%s) is shown as uncertain and never resent',async(_name,reply)=>{
 setup();respond(serverA.url,applyPath,reply,'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);fireEvent.press(view.getByText('Reemplazar con huella'));
 await view.findByText('El cambio quedó sin confirmar. Recarga; no se enviará otra vez automáticamente.');expect(view.queryByText(/SIN RESPUESTA|no están disponibles/)).toBeNull();expect(requestsFor(serverA.url,applyPath)).toHaveLength(1);
});
test('a definitive 409 apply conflict keeps its own cause',async()=>{
 setup();respond(serverA.url,applyPath,json({error:{code:'personality_conflict',message:'PRIVATE'}},409),'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);fireEvent.press(view.getByText('Reemplazar con huella'));
 await view.findByText('El preset o la selección cambió. Recarga antes de confirmar.');expect(view.queryByText(/No se pudo confirmar el cambio/)).toBeNull();
});

test('replacing the paired client while huella is pending withdraws the preview permanently',async()=>{
 setup();const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockImplementation(()=>auth.promise);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
 await act(async()=>{await view.probe.current!.replaceServer('A',{name:serverA.name,url:serverA.url,deviceId:'fixture-device-new',key:'fixture-key-new'});});await act(async()=>auth.resolve({success:true}));expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();
});
test('a late SOUL ACK after presentation loss cannot publish success or update the visible cached document',async()=>{
 setup();let show!:(v:boolean)=>void;function Page(){const [v,set]=useState(true);show=set;return <ChatVisibilityProvider value={v}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>;}
 const ack=deferred<Response>();respond(serverA.url,applyPath,ack.promise,'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});const view=renderApp(<Page/>);await preview(view);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(requestsFor(serverA.url,applyPath)).toHaveLength(1));act(()=>show(false));act(()=>show(true));const body=requestsFor(serverA.url,applyPath)[0].body as {requestId:string};await act(async()=>ack.resolve(json({requestId:body.requestId,presetId:id,presetRevision:rev,soul:{...soul,revision:next,content:preset.content,characters:[...preset.content].length}})));await view.findByText(soul.content);expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();
});

test('revoked preset preview withdraws content and retains the real device diagnosis',async()=>{
 setup();respond(serverA.url,previewPath,json({error:{code:'device_revoked',message:'PRIVATE'}},403));const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText(soul.content);fireEvent.press(view.getByText('Aplicar preset SOUL'));await view.findByLabelText('Revisor');fireEvent.press(view.getByLabelText('Revisor'));await view.findByText(/DISPOSITIVO REVOCADO/);expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();
});

test('independent SPEC: profile read-only after huella preserves its cause instead of rejecting the device key',async()=>{
 setup();respond(serverA.url,applyPath,json({error:{code:'agent_memory_read_only',message:'PRIVATE memory guard'}},403),'PUT');
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);
 fireEvent.press(view.getByText('Reemplazar con huella'));
 await waitFor(()=>expect(requestsFor(serverA.url,applyPath)).toHaveLength(1));
 await act(async()=>{});
 console.log('SPEC_PRESETS_MEMORY_CAUSE',JSON.stringify({profileReadOnlyShown:!!view.queryByText('Solo lectura: no se puede verificar la configuración efectiva del Agente.'),genericPresetUnavailable:!!view.queryByText('Los presets de personalidad no están disponibles en este Servidor.') }));
 await view.findByText('Solo lectura: no se puede verificar la configuración efectiva del Agente.');
});

test.each(['blur','remount','replacement'] as const)('late revoked SOUL preview after %s withdraws the same client but preserves a replacement',async reason=>{
 setup();let show!:(v:boolean)=>void;function Page(){const [mounted,set]=useState(true);show=set;return <ChatVisibilityProvider value={true}>{mounted?<AgentSoulScreen serverId="A" agentId="agentA"/>:null}</ChatVisibilityProvider>;}
 const read=deferred<Response>();respond(serverA.url,previewPath,read.promise);const view=renderApp(<Page/>);await view.ready();await view.findByText(soul.content);fireEvent.press(view.getByText('Aplicar preset SOUL'));await view.findByLabelText('Revisor');fireEvent.press(view.getByLabelText('Revisor'));await waitFor(()=>expect(requestsFor(serverA.url,previewPath)).toHaveLength(1));
 if(reason==='blur'){act(()=>emitAppBlur());act(()=>emitAppFocus());}if(reason==='remount'){act(()=>show(false));act(()=>show(true));}if(reason==='replacement')await act(async()=>{await view.probe.current!.replaceServer('A',{name:serverA.name,url:serverA.url,deviceId:serverA.deviceId,key:'fresh-key'});});
 await act(async()=>read.resolve(json({error:{code:'device_revoked',message:'PRIVATE'}},403)));
 if(reason==='replacement'){act(()=>emitAppBlur());act(()=>emitAppFocus());await view.findByText(soul.content);expect(view.queryByText(/DISPOSITIVO REVOCADO/)).toBeNull();expect(view.getByText('Aplicar preset SOUL')).toBeEnabled();return;}
 await view.findByText(/DISPOSITIVO REVOCADO/);expect(view.queryByText(soul.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});
test('late revoked SOUL apply ACK retires the client even after the document action guard expired',async()=>{
 setup();const ack=deferred<Response>();respond(serverA.url,applyPath,ack.promise,'PUT');biometrics.authenticateAsync.mockResolvedValue({success:true});const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await preview(view);fireEvent.press(view.getByText('Reemplazar con huella'));await waitFor(()=>expect(requestsFor(serverA.url,applyPath)).toHaveLength(1));act(()=>emitAppBlur());act(()=>emitAppFocus());await act(async()=>ack.resolve(json({error:{code:'key_unknown',message:'PRIVATE'}},403)));expect(view.queryByText(soul.content,{includeHiddenElements:true})).toBeNull();await waitFor(()=>expect(view.queryByText(/LLAVE RECHAZADA/)).not.toBeNull());expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(requestsFor(serverA.url,applyPath)).toHaveLength(1);expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
});

test.each(['agent_memory_read_only','agent_memory_conflict','agent_memory_uncertain'] as const)('SOUL preview keeps %s locally without retiring valid credentials',async code=>{
 setup();respond(serverA.url,previewPath,json({error:{code,message:'PRIVATE profile error'}},AGENT_MEMORY_ERROR_STATUS[code]));const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText(soul.content);fireEvent.press(view.getByText('Aplicar preset SOUL'));await view.findByLabelText('Revisor');fireEvent.press(view.getByLabelText('Revisor'));await waitFor(()=>expect(view.queryByText(AGENT_MEMORY_MESSAGES[code])).not.toBeNull());expect(view.queryByText(/LLAVE RECHAZADA/)).toBeNull();expect(view.queryByText('PRIVATE profile error')).toBeNull();fireEvent.press(view.getByText('Cerrar'));expect(view.getByText(soul.content)).toBeTruthy();expect(biometrics.authenticateAsync).not.toHaveBeenCalled();expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);
});

const savedId='22222222-2222-4222-8222-222222222222';
function created(r:{body:unknown}){const b=r.body as {name:string;content:string};return json({id:savedId,revision:next,name:b.name,kind:'soul',bytes:new TextEncoder().encode(b.content).byteLength,content:b.content,createdAt:clockStart,updatedAt:clockStart});}
test('saving the current SOUL as a preset pins the catalogue and the exact shown SOUL, without huella or SOUL writes',async()=>{
 setup();respond(serverA.url,root,created,'POST');const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText(soul.content);
 fireEvent.press(view.getByText('Guardar SOUL actual como preset'));await view.findByText(`SOUL actual · ${rev}`);
 expect(view.getByText('Guardar preset')).toBeDisabled();fireEvent.changeText(view.getByLabelText('Nombre del preset'),'  SOUL de Agente A  ');
 await act(async()=>fireEvent.press(view.getByText('Guardar preset')));await view.findByText('Preset guardado.');
 expect(requestsFor(serverA.url,root).filter(r=>r.method==='POST').map(r=>r.body)).toEqual([{requestId:expect.any(String),catalogRevision:rev,name:'SOUL de Agente A',kind:'soul',content:soul.content}]);
 expect(view.queryByText(`SOUL actual · ${rev}`)).toBeNull();expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 expect(requestsFor(serverA.url,'/v1/agents/agentA/soul').filter(r=>r.method==='PUT')).toHaveLength(0);expect(requestsFor(serverA.url,applyPath)).toHaveLength(0);
});
test('a failed save of the current SOUL shows its cause and is never resent from the same sheet',async()=>{
 setup();respond(serverA.url,root,json({error:{code:'personality_limit',message:'PRIVATE'}},409),'POST');const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText(soul.content);
 fireEvent.press(view.getByText('Guardar SOUL actual como preset'));await view.findByText(`SOUL actual · ${rev}`);fireEvent.changeText(view.getByLabelText('Nombre del preset'),'Copia');
 await act(async()=>fireEvent.press(view.getByText('Guardar preset')));await view.findByText('El catálogo o el preset supera su límite. No se borró ninguna versión.');expect(view.queryByText('PRIVATE')).toBeNull();expect(view.getByText('Guardar preset')).toBeDisabled();
 await act(async()=>fireEvent.press(view.getByText('Guardar preset')));expect(requestsFor(serverA.url,root).filter(r=>r.method==='POST')).toHaveLength(1);expect(view.queryByText('Preset guardado.')).toBeNull();
});
test('a missing SOUL cannot be saved as a preset',async()=>{
 seed([serverA]);polling(serverA,[agentA]);respond(serverA.url,'/v1/agents/agentA/soul',json({...soul,exists:false,content:'',characters:0}));const {content,...summary}=preset;void content;respond(serverA.url,root,json({revision:rev,capturedAt:clockStart,presets:[summary]}));
 const view=renderApp(<ChatVisibilityProvider value={true}><AgentSoulScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText('SOUL.md todavía no existe. Se creará al guardar.');
 expect(view.getByText('Guardar SOUL actual como preset')).toBeDisabled();
});
