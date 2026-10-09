import { useState } from 'react';
import { act,fireEvent,waitFor, within } from '@testing-library/react-native';
import { ConversationPersonalityControl } from '@/screens/chat/ConversationPersonalityControl';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA,conversationA,polling,seed,serverA,serverB,serverInfo } from '../support/fixtures';
import { biometrics,clockStart,deferred,emitAppState,emitAppBlur,emitAppFocus } from '../support/native';
import { json,requestsFor,respond,streamFixture } from '../support/transport';
const root='/v1/personality-presets',id='11111111-1111-4111-8111-111111111111',rev='a'.repeat(64),next='b'.repeat(64);
const preset={id,revision:rev,name:'Tutor',kind:'overlay',bytes:12,content:'Capa exacta.',createdAt:clockStart,updatedAt:clockStart};
preset.bytes=new TextEncoder().encode(preset.content).byteLength;
const {content,...summary}=preset;void content;
const path=`/v1/agents/agentA/conversations/${conversationA.id}/personality`;
const selection={agentId:'agentA',conversationId:conversationA.id,revision:rev,preset:null,updatedAt:null};
function setup(){seed([serverA,serverB]);for(const s of [serverA,serverB]){polling(s,[agentA]);respond(s.url,root,json({revision:rev,capturedAt:clockStart,presets:[summary]}));respond(s.url,`${root}/${id}/versions/${rev}`,json(preset));respond(s.url,path,json(selection));respond(s.url,path,(r)=>json({...selection,revision:next,preset:(r.body as {preset:unknown}).preset?preset:null,updatedAt:clockStart}),'PUT');}}
function component(running=false){return renderApp(<ChatVisibilityProvider value={true}><ConversationPersonalityControl serverId="A" agentId="agentA" conversation={conversationA} running={running}/></ChatVisibilityProvider>);}
async function choose(view:ReturnType<typeof renderApp>){await view.ready();fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));await view.findByLabelText('Tutor');fireEvent.press(view.getByLabelText('Tutor'));await view.findByText(preset.content);}
test('the overlay presets sit in a block, so they keep their separators and the chosen one its lit LED',async()=>{
 setup();const view=component();await view.ready();fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));await view.findByLabelText('Tutor');
 expect(within(view.getByTestId('list-block')).getByLabelText('Tutor')).toBeTruthy();
});
test('free selection freezes exact revision after ACK and none inherits full Servidor configuration',async()=>{
 setup();const view=component();await choose(view);expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(0);const ack=deferred<Response>();respond(serverA.url,path,ack.promise,'PUT');fireEvent.press(view.getByText('Usar en siguientes Turnos'));await waitFor(()=>expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(1));expect(view.getByText('Guardando selección…')).toBeTruthy();
 const body=requestsFor(serverA.url,path).find(r=>r.method==='PUT')!.body;expect(body).toEqual({requestId:expect.any(String),revision:rev,preset:{id,revision:rev}});
 await act(async()=>ack.resolve(json({...selection,revision:next,preset,updatedAt:clockStart})));await view.findByLabelText('Personalidad de esta Conversación: Tutor');expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 respond(serverA.url,path,json({...selection,revision:next,preset,updatedAt:clockStart}));respond(serverA.url,path,json({...selection,revision:rev,preset:null,updatedAt:clockStart}),'PUT');fireEvent.press(view.getByLabelText('Personalidad de esta Conversación: Tutor'));await view.findByText('Sin capa extra de Relay');fireEvent.press(view.getByText('Sin capa extra de Relay'));await view.findByText('Sin capa extra de Relay. Se hereda la configuración del Servidor.');fireEvent.press(view.getByText('Usar en siguientes Turnos'));await view.findByLabelText('Personalidad de esta Conversación: Sin capa extra');
});
test('mid-Turn requires confirmation explicitly for next only; another channel is read-only without a write',async()=>{
 setup();const view=component(true);await choose(view);expect(view.getByText('Este Turno conserva su personalidad. La capa se usará en el siguiente Turno.')).toBeTruthy();expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(0);fireEvent.press(view.getByText('Usar en siguientes Turnos'));await view.findByLabelText('Personalidad de esta Conversación: Tutor');});
test('another channel is read-only without fetching private presets or selecting',async()=>{
 setup();const external=renderApp(<ChatVisibilityProvider value={true}><ConversationPersonalityControl serverId="A" agentId="agentA" conversation={{...conversationA,origin:'external',writable:false}} running={false}/></ChatVisibilityProvider>);await external.ready();fireEvent.press(external.getByLabelText('Personalidad de esta Conversación'));await external.findByText('Esta Conversación nació fuera de Relay; su personalidad es de solo lectura.');expect(external.queryByLabelText('Tutor')).toBeNull();expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(0);expect(requestsFor(serverA.url,root)).toHaveLength(0);
});
test.each(['personality_conflict','personality_uncertain'] as const)('%s requires fresh reload instead of automatic replay',async code=>{
 setup();respond(serverA.url,path,json({error:{code,message:'PRIVATE'}},code==='personality_conflict'?409:503),'PUT');const view=component();await choose(view);fireEvent.press(view.getByText('Usar en siguientes Turnos'));await waitFor(()=>expect(view.getByText('Usar en siguientes Turnos')).toBeDisabled());expect(view.queryByText('PRIVATE')).toBeNull();fireEvent.press(view.getByText('Usar en siguientes Turnos'));expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(1);fireEvent.press(view.getByText('Recargar'));await waitFor(()=>expect(view.queryByText(preset.content)).toBeNull());await view.findByLabelText('Tutor');
});
test.each(['hidden','background','blur','conversation'] as const)('immutable read returning after %s cannot reveal a sheet or select',async reason=>{
 setup();let visible!:(v:boolean)=>void,conv!:(v:boolean)=>void;function Page(){const [show,setShow]=useState(true),[other,setOther]=useState(false);visible=setShow;conv=setOther;return <ChatVisibilityProvider value={show}><ConversationPersonalityControl serverId="A" agentId="agentA" conversation={other?{...conversationA,id:'other'}:conversationA} running={false}/></ChatVisibilityProvider>;}
 const read=deferred<Response>();respond(serverA.url,`${root}/${id}/versions/${rev}`,read.promise);const view=renderApp(<Page/>);await view.ready();fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));await view.findByLabelText('Tutor');fireEvent.press(view.getByLabelText('Tutor'));await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}/versions/${rev}`)).toHaveLength(1));
 if(reason==='hidden'){act(()=>visible(false));act(()=>visible(true));}if(reason==='background'){act(()=>emitAppState('background'));act(()=>emitAppState('active'));}if(reason==='blur'){act(()=>emitAppBlur());act(()=>emitAppFocus());}if(reason==='conversation')act(()=>conv(true));await act(async()=>read.resolve(json(preset)));expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('Usar en siguientes Turnos',{includeHiddenElements:true})).toBeNull();expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(0);
});
test('LockGate removes the overlay confirmation entirely',async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});const view=renderApp(<LockGate><ConversationPersonalityControl serverId="A" agentId="agentA" conversation={conversationA} running/></LockGate>);await choose(view);await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('Usar en siguientes Turnos',{includeHiddenElements:true})).toBeNull();
});
test('real Chat title opens overlay; selecting during a Turn preserves model, transcript and Turn',async()=>{
 setup();respond(serverA.url,'/v1/server',json(serverInfo));const history={sessionId:conversationA.id,conversation:conversationA,items:[{kind:'assistant',id:'history',text:'Historia conservada',at:clockStart}]};respond(serverA.url,'/v1/agents/agentA/transcript',json(history));respond(serverA.url,`/v1/agents/agentA/transcript?sessionId=${conversationA.id}`,json(history));const stream=streamFixture();respond(serverA.url,'/v1/agents/agentA/runs',json({runId:'preset-turn',sessionId:conversationA.id,conversationId:conversationA.id,inputMessageId:'input'}),'POST');respond(serverA.url,'/v1/runs/preset-turn/events',stream.reply);
 const view=renderApp(<ChatVisibilityProvider value={true}><ChatScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await view.ready();await view.findByText('Historia conservada');fireEvent.changeText(view.getByPlaceholderText('Mensaje a Agente A…'),'Consulta');fireEvent.press(view.getByLabelText('Enviar'));await waitFor(()=>expect(stream.reader.read).toHaveBeenCalled());await choose(view);fireEvent.press(view.getByText('Usar en siguientes Turnos'));await view.findByLabelText('Personalidad de esta Conversación: Tutor');expect(view.getByText('Historia conservada')).toBeTruthy();expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1);expect(requestsFor(serverA.url,'/v1/runs/preset-turn/stop')).toHaveLength(0);expect(requestsFor(serverA.url,`/v1/agents/agentA/conversations/${conversationA.id}/model`)).toHaveLength(0);
});

test.each(['device_revoked','key_unknown'] as const)('overlay %s cancels private previews and retains the known diagnosis',async code=>{
 setup();const view=component();await choose(view);respond(serverA.url,path,json({error:{code,message:'PRIVATE'}},403),'PUT');fireEvent.press(view.getByText('Usar en siguientes Turnos'));await view.findByText(code==='device_revoked'?/DISPOSITIVO REVOCADO/:/LLAVE RECHAZADA/);expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();expect(view.getByLabelText('Personalidad de esta Conversación')).toBeDisabled();
});

test.each(['background','hidden','conversation'] as const)('confirmation cannot write when fresh read returns after %s even if visible again',async reason=>{
 setup();let visible!:(v:boolean)=>void,conv!:(v:boolean)=>void;function Page(){const [show,setShow]=useState(true),[other,setOther]=useState(false);visible=setShow;conv=setOther;return <ChatVisibilityProvider value={show}><ConversationPersonalityControl serverId="A" agentId="agentA" conversation={other?{...conversationA,id:'other'}:conversationA} running={false}/></ChatVisibilityProvider>;}
 const view=renderApp(<Page/>);await choose(view);const fresh=deferred<Response>();respond(serverA.url,path,fresh.promise);fireEvent.press(view.getByText('Usar en siguientes Turnos'));await waitFor(()=>expect(requestsFor(serverA.url,path).filter(r=>r.method==='GET')).toHaveLength(2));
 if(reason==='background'){act(()=>emitAppState('background'));act(()=>emitAppState('active'));}if(reason==='hidden'){act(()=>visible(false));act(()=>visible(true));}if(reason==='conversation')act(()=>conv(true));
 await act(async()=>fresh.resolve(json(selection)));expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(0);expect(view.queryByText('Usar en siguientes Turnos',{includeHiddenElements:true})).toBeNull();
});

test.each(['version','selection','replacement'] as const)('late overlay credential rejection during %s retires only its client',async stage=>{
 setup();const view=component();await view.ready();const response=deferred<Response>();
 if(stage==='version'){respond(serverA.url,`${root}/${id}/versions/${rev}`,response.promise);fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));await view.findByLabelText('Tutor');fireEvent.press(view.getByLabelText('Tutor'));await waitFor(()=>expect(requestsFor(serverA.url,`${root}/${id}/versions/${rev}`)).toHaveLength(1));}
 else {await choose(view);respond(serverA.url,path,response.promise,'PUT');fireEvent.press(view.getByText('Usar en siguientes Turnos'));await waitFor(()=>expect(requestsFor(serverA.url,path).filter(r=>r.method==='PUT')).toHaveLength(1));}
 act(()=>emitAppBlur());act(()=>emitAppFocus());if(stage==='replacement')await act(async()=>{await view.probe.current!.replaceServer('A',{name:serverA.name,url:serverA.url,deviceId:serverA.deviceId,key:'fresh-key'});});
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'PRIVATE'}},403)));
 if(stage==='replacement'){act(()=>emitAppBlur());act(()=>emitAppFocus());expect(view.queryByText(/DISPOSITIVO REVOCADO/)).toBeNull();expect(view.getByLabelText('Personalidad de esta Conversación')).toBeEnabled();return;}
 await view.findByText(/DISPOSITIVO REVOCADO/);expect(view.getByLabelText('Personalidad de esta Conversación')).toBeDisabled();expect(view.queryByText(preset.content,{includeHiddenElements:true})).toBeNull();expect(view.queryByText('PRIVATE')).toBeNull();const count=requestsFor(serverA.url,root).length;fireEvent.press(view.getByLabelText('Personalidad de esta Conversación'));expect(requestsFor(serverA.url,root)).toHaveLength(count);
});
