import { act, cleanupAsync, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { ChatScreen } from '@/screens/ChatScreen';
import { AgentDetailScreen } from '@/screens/AgentDetailScreen';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { biometrics, clockStart, deferred, router, emitAppState, navigation } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond } from '../support/transport';
import type { AgentDetails } from '../../../protocol/agentDetails';
import type { AgentSkills, AgentTools } from '../../../protocol/agentTools';
const path='/v1/agents/agentA/details',modePath='/v1/agents/agentA/approval-mode';
const fixture:AgentDetails={agentId:'agentA',name:'Agente A',status:'on',capturedAt:clockStart,defaultModel:{provider:'fixture',model:'default-model'},
 security:{mode:'manual',pendingMode:null,deny:['git push --force*'],guardianPolicy:'Escala operaciones peligrosas.',revision:'a'.repeat(64),writable:true,reason:null},
 usage:{capturedAt:clockStart,timezone:'UTC',basis:'conversation_started_at',includesAuxiliary:false,today:{tokens:140,estimatedCostUsd:0.41,conversations:1},last7days:{tokens:420,estimatedCostUsd:2.62,conversations:2},daily:[{day:'2026-10-03',tokens:140,estimatedCostUsd:0.41,conversations:1}]},usageError:null,recentConversations:[conversationA]};
const toolsFixture:AgentTools={platform:'api_server',observedAt:clockStart,appliesTo:'next_turn',toolsets:[
 {name:'terminal',label:'Terminal',description:'Ejecutar comandos',enabled:true,configured:true,tools:['terminal']},
 {name:'web',label:'Web',description:'Buscar',enabled:false,configured:true,tools:['web_search']},
 {name:'browser',label:'Navegador',description:'Navegar',enabled:true,configured:false,tools:['browser_navigate']}]};
const skillsFixture:AgentSkills={observedAt:clockStart,scope:'profile_installed',limited:false,skills:[{name:'review-pr',description:'Revisa cambios',category:'desarrollo',availability:'unknown'}]};
function setup(){seed();polling(serverA,[agentA]);respond(serverA.url,path,json(fixture));respond(serverA.url,'/v1/agents/agentA/tools',json(toolsFixture));respond(serverA.url,'/v1/agents/agentA/skills',json(skillsFixture));}
async function mount(){const app=renderApp(<ChatVisibilityProvider value={true}><AgentDetailScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await app.ready();await screen.findByText('default-model');return app;}
test('the actual ficha shows identity, readonly default model, dated estimated usage and recent Conversations; lowering protection requires explicit confirmation and huella before posting the revision',async()=>{
 setup();await mount();expect(screen.getByText('≈ $0.41')).toBeVisible();expect(screen.getByText('Conversación de prueba')).toBeVisible();expect(screen.getByText(/Conversaciones iniciadas/)).toBeVisible();
 fireEvent.press(screen.getByText('Modo de aprobación'));await screen.findByText('MODO DE APROBACIÓN');
 fireEvent.press(screen.getByLabelText('Modo Smart'));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 biometrics.authenticateAsync.mockResolvedValue({success:true});respond(serverA.url,modePath,json({...fixture.security,pendingMode:{mode:'smart',requestedAt:clockStart},revision:'b'.repeat(64)}),'POST');
 await act(async()=>{fireEvent.press(screen.getByText('Pasar a Smart'));});
 await waitFor(()=>expect(requestsFor(serverA.url,modePath)).toHaveLength(1));
 expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({disableDeviceFallback:true,biometricsSecurityLevel:'strong'}));expect(requestsFor(serverA.url,modePath)[0].body).toEqual({mode:'smart',revision:'a'.repeat(64)});
 expect(screen.getByText('PENDIENTE: SMART')).toBeVisible();expect(screen.getByText(/otros canales activos/)).toBeVisible();
});
test('the ficha 3.1 lists its rows in blocks: Modo de aprobación by word, deny rules, memory and one Herramientas y skills row with its count',async()=>{
 setup();await mount();
 for(const text of ['Abrir chat','Conversaciones','MODELO','COMPORTAMIENTO','MEMORIA Y HERRAMIENTAS','Personalidad','SOUL.md','Modo de aprobación','MANUAL','Reglas de bloqueo','1 REGLAS · SIEMPRE SE BLOQUEAN','Memoria','DE AGENTE A EN SERVIDOR A','Herramientas y skills'])expect(screen.getByText(text)).toBeVisible();
 expect(screen.getByText('PROVEEDOR · FIXTURE · SE CAMBIA EN EL SERVIDOR')).toBeVisible();
 await waitFor(()=>expect(screen.getByText('2 DE 3 · 1 SKILLS')).toBeVisible());
 expect(screen.queryByText(/Aprobaciones · /)).toBeNull();
 expect(screen.queryByText('Se cambia en el Servidor. En el chat puedes elegir otro para una Conversación.')).toBeNull();
 fireEvent.press(screen.getByText('Herramientas y skills'));expect(router.push).toHaveBeenCalledWith({pathname:'/agent/[server]/[agent]/tools',params:{server:'A',agent:'agentA'}});
 fireEvent.press(screen.getByText('Personalidad'));expect(router.push).toHaveBeenCalledWith({pathname:'/agent/[server]/[agent]/soul',params:{server:'A',agent:'agentA'}});
});
test('Modo de aprobación offers exactly manual, smart and off, with the current one checked',async()=>{
 setup();await mount();fireEvent.press(screen.getByText('Modo de aprobación'));await screen.findByText('MODO DE APROBACIÓN');
 const radios=screen.getAllByRole('radio');expect(radios.map(r=>r.props.accessibilityLabel)).toEqual(['Modo Manual','Modo Smart','Modo Off']);
 expect(screen.getByLabelText('Modo Manual')).toBeChecked();expect(screen.getByLabelText('Modo Smart')).not.toBeChecked();expect(screen.getByLabelText('Modo Off')).not.toBeChecked();
});
test('the last known pending mode survives reopening offline, remains dated readonly, and offers no security writes',async()=>{
 setup();await mount();fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Smart'));biometrics.authenticateAsync.mockResolvedValue({success:true});
 respond(serverA.url,modePath,json({...fixture.security,pendingMode:{mode:'smart',requestedAt:clockStart},revision:'b'.repeat(64)}),'POST');
 await act(async()=>{fireEvent.press(screen.getByText('Pasar a Smart'));});await screen.findByText('PENDIENTE: SMART');await cleanupAsync();
 respond(serverA.url,'/health',()=>networkError());const app=renderApp(<ChatVisibilityProvider value={true}><AgentDetailScreen serverId="A" agentId="agentA"/></ChatVisibilityProvider>);await app.ready();await screen.findByText('default-model');await screen.findByText(/SOLO LECTURA/);
 fireEvent.press(screen.getByText('Modo de aprobación'));await screen.findByText('PENDIENTE: SMART');expect(screen.getByLabelText('Modo Off')).toBeDisabled();expect(screen.queryByLabelText('Añadir regla de bloqueo')).toBeNull();expect(requestsFor(serverA.url,modePath)).toHaveLength(1);
});
test('recent Conversation navigation loads exactly that stored thread rather than the latest one',async()=>{
 setup();await mount();fireEvent.press(screen.getByText('Conversación de prueba'));expect(router.push).toHaveBeenCalledWith({pathname:'/chat/[server]/[agent]',params:{server:'A',agent:'agentA',conversationId:conversationA.id}});await cleanupAsync();
 respond(serverA.url,'/v1/server',json(serverInfo));const target=`/v1/agents/agentA/transcript?sessionId=${conversationA.id}`;
 respond(serverA.url,target,json({sessionId:conversationA.id,conversation:conversationA,items:[{kind:'assistant',id:'specific-message',text:'La Conversación seleccionada',at:clockStart}]}));
 const app=renderApp(<ChatScreen serverId="A" agentId="agentA" initialConversationId={conversationA.id}/>);await app.ready();await screen.findByText('La Conversación seleccionada');expect(requestsFor(serverA.url,target)).toHaveLength(1);expect(requestsFor(serverA.url,'/v1/agents/agentA/transcript')).toHaveLength(0);
});
test('a queued decrease awaits one huella despite repeated taps; failure and cancellation produce no POST',async()=>{
 setup();await mount();fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Off'));fireEvent.press(screen.getByText('Cancelar'));expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 fireEvent.press(screen.getByLabelText('Modo Off'));const authentication=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValue(authentication.promise);
 await act(async()=>{fireEvent.press(screen.getByText('Desactivar con huella'));});await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));fireEvent.press(screen.getByText('Guardando…'));expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);expect(requestsFor(serverA.url,modePath)).toHaveLength(0);
 await act(async()=>authentication.resolve({success:false}));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);expect(screen.getByText('Desactivar con huella')).toBeVisible();
});
test('an offline transition while huella is pending prevents a stale mode write',async()=>{
 setup();const app=await mount();fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Off'));const authentication=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValue(authentication.promise);
 await act(async()=>{fireEvent.press(screen.getByText('Desactivar con huella'));});await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));respond(serverA.url,'/health',()=>networkError());
 await act(async()=>{app.probe.current!.refresh('A');});await waitFor(()=>expect(app.probe.current!.snapshot('A').reachable).toBe(false));await act(async()=>authentication.resolve({success:true}));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);expect(screen.getByLabelText('Modo Off')).toBeDisabled();
});
test('raising protection and adding an exact glob are free, while removing it needs confirmation and huella',async()=>{
 setup();respond(serverA.url,path,json({...fixture,security:{...fixture.security,mode:'off'}}));await mount();fireEvent.press(screen.getByText('Modo de aprobación'));
 respond(serverA.url,modePath,json({...fixture.security,mode:'off',pendingMode:{mode:'manual',requestedAt:clockStart},revision:'b'.repeat(64)}),'POST');await act(async()=>{fireEvent.press(screen.getByLabelText('Modo Manual'));});await screen.findByText('PENDIENTE: MANUAL');expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 const rulePath='/v1/agents/agentA/block-rules';fireEvent.press(screen.getByLabelText('Añadir regla de bloqueo'));fireEvent.changeText(screen.getByLabelText('Patrón de bloqueo'),'Echo [Aa]*');respond(serverA.url,rulePath,json({...fixture.security,mode:'off',deny:['git push --force*','Echo [Aa]*'],revision:'c'.repeat(64)}),'POST');await act(async()=>{fireEvent.press(screen.getByText('Añadir regla'));});await screen.findByText('Echo [Aa]*');
 expect(requestsFor(serverA.url,rulePath)[0].body).toEqual({action:'add',pattern:'Echo [Aa]*',revision:'b'.repeat(64)});expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 fireEvent.press(screen.getByLabelText('Quitar regla Echo [Aa]*'));expect(requestsFor(serverA.url,rulePath)).toHaveLength(1);biometrics.authenticateAsync.mockResolvedValue({success:true});respond(serverA.url,rulePath,json({...fixture.security,mode:'off',deny:['git push --force*'],revision:'d'.repeat(64)}),'POST');await act(async()=>{fireEvent.press(screen.getByText('Quitar con huella'));});await waitFor(()=>expect(requestsFor(serverA.url,rulePath)).toHaveLength(2));expect(requestsFor(serverA.url,rulePath)[1].body).toEqual({action:'remove',pattern:'Echo [Aa]*',revision:'c'.repeat(64)});expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
});

test('a successful huella after the ficha unmounts never writes its old Agent',async()=>{
 setup();await mount();fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Off'));const authentication=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValue(authentication.promise);
 await act(async()=>{fireEvent.press(screen.getByText('Desactivar con huella'));});await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));await cleanupAsync();await act(async()=>authentication.resolve({success:true}));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);
});
test('locking the mounted ficha during huella prevents a late successful protection decrease',async()=>{
 setup();biometrics.authenticateAsync.mockResolvedValueOnce({success:true});const app=renderApp(<LockGate><AgentDetailScreen serverId="A" agentId="agentA"/></LockGate>);await app.ready();await screen.findByText('default-model');await waitFor(()=>expect(screen.getByText('default-model')).toBeVisible());
 fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Off'));const authentication=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValue(authentication.promise);
 await act(async()=>{fireEvent.press(screen.getByText('Desactivar con huella'));});await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));await act(async()=>{emitAppState('background');});jest.setSystemTime(clockStart+61000);await act(async()=>{emitAppState('active');});await screen.findByText('Relay está bloqueado');await act(async()=>authentication.resolve({success:true}));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);
});

test('a blurred stack route cannot write its old Agent when huella finishes successfully',async()=>{
 setup();const app=await mount();fireEvent.press(screen.getByText('Modo de aprobación'));fireEvent.press(screen.getByLabelText('Modo Off'));const authentication=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValue(authentication.promise);
 await act(async()=>{fireEvent.press(screen.getByText('Desactivar con huella'));});await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));navigation.focused=false;await act(async()=>{app.probe.current!.refresh('A');});await act(async()=>authentication.resolve({success:true}));expect(requestsFor(serverA.url,modePath)).toHaveLength(0);
});
