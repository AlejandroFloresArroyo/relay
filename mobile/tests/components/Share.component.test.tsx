import { ThemeProvider, useThemePreference } from '@/theme/ThemeProvider';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/theme/tokens';
import { act, cleanupAsync, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ShareLauncher } from '@/screens/ShareLauncher';
import { ShareScreen } from '@/screens/ShareScreen';
import { DraftProvider, useDraftStore } from '@/state/sharedDrafts';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { configureImageStorage, imageFiles, imagePicker, imageResult } from '../support/images';
import { legacyFileSystem } from '../support/files';
import { ChatRouteContent } from '@/screens/SharedChat';
import { receiveShare, resetExternalShare, externalShare } from '../support/externalShare';
import { agentA, conversationA, polling, seed, serverA, serverB, settings, serverInfo } from '../support/fixtures';
import { biometrics, deferred, emitAppState, emitAppBlur, emitAppFocus, navigation, router } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, respond, requestsFor, networkError } from '../support/transport';
// The native boundary is loaded inside the hoisted Jest factory.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('expo', () => ({ ...jest.requireActual('expo'), requireOptionalNativeModule: (name: string) => name === 'RelayShareReceiver' ? require('../support/externalShare').externalShare : null }));
beforeEach(() => resetExternalShare());
function setup(locked = false) {
  seed([serverA], { ...settings, faceid: locked }); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ items: [], sessionId: null }));
}
function mount() { return renderApp(<DraftProvider><LockGate><ShareScreen /></LockGate></DraftProvider>); }
test('LockGate precedes any content read; literal URL prepares a new private draft without HTTP mutations', async () => {
  setup(true); receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'https://literal.invalid' });
  const app = mount(); await app.ready(); await screen.findByText('Relay está bloqueado');
  expect(externalShare.read).not.toHaveBeenCalled();
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await screen.findByText('https://literal.invalid');
  fireEvent.press(screen.getByText('Agente A'));
  await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/chat/[server]/[agent]', params: expect.objectContaining({ server: 'A', agent: 'agentA', shareDraft: expect.any(String), entry: '1' }) })));
  expect(requestsFor(serverA.url, '/v1/agents/agentA/conversations')).toHaveLength(0);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  expect(router.replace.mock.calls[0][0].params).not.toHaveProperty('boardDraft');
  await cleanupAsync();
});
test('a delayed native read after background exposes no content or navigation', async () => {
  setup(); receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'private late content' });
  const pending = deferred<unknown>(); externalShare.read.mockReturnValueOnce(pending.promise);
  const app = mount(); await app.ready(); await waitFor(() => expect(externalShare.read).toHaveBeenCalled());
  await act(async () => { emitAppState('background'); pending.resolve({ kind: 'text', text: 'private late content' }); });
  expect(screen.queryByText('private late content')).toBeNull(); expect(router.replace).not.toHaveBeenCalled();
  await cleanupAsync();
});
test('a generic share route with no native capability contains no content or draft', async () => {
  setup(); const app = mount(); await app.ready(); await screen.findByText('NADA QUE COMPARTIR');
  expect(externalShare.read).not.toHaveBeenCalled(); expect(router.replace).not.toHaveBeenCalled(); await cleanupAsync();
});

test('new intents keep the previous preview and require matching confirmation before replacing a private draft', async () => {
  setup(); const first = '11111111-1111-4111-8111-111111111111'; const next = '22222222-2222-4222-8222-222222222222';
  receiveShare(first, { kind: 'text', text: 'Primer contenido' }); const app = mount(); await app.ready(); await screen.findByText('Primer contenido');
  fireEvent.press(screen.getByText('Agente A')); await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); });
  const originalId = router.replace.mock.calls[0][0].params.shareDraft;
  await act(async () => receiveShare(next, { kind: 'text', text: 'Segundo contenido' }));
  expect(screen.getByText('Primer contenido')).toBeVisible(); expect(screen.queryByText('Segundo contenido')).toBeNull();
  await act(async () => fireEvent.press(screen.getByText('Revisar contenido nuevo · conservar el anterior')));
  await screen.findByText('Segundo contenido');
  await act(async () => fireEvent.press(screen.getByText('Preparar borrador')));
  expect(screen.getByText(/Ya hay un borrador/)).toBeVisible(); expect(router.replace).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.press(screen.getByText('Reemplazar borrador anterior')));
  expect(router.replace).toHaveBeenCalledTimes(2); expect(router.replace.mock.calls[1][0].params.shareDraft).not.toBe(originalId);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0); await cleanupAsync();
});

test('Preparar borrador stays disabled until an Agente is chosen, and an Agente of a Servidor that does not answer cannot be chosen', async () => {
  seed([serverA, serverB], { ...settings, faceid: false }); polling(serverA, [agentA]); polling(serverB, [{ ...agentA, id: 'ops', name: 'ops' }]);
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'Contenido sin destino' });
  const app = renderApp(<DraftProvider><LockGate><ShareScreen /></LockGate></DraftProvider>); await app.ready(); await screen.findByText('Contenido sin destino');
  await waitFor(() => expect(app.probe.current!.snapshot('B').agents).toHaveLength(1));
  respond(serverB.url, '/health', networkError); respond(serverB.url, '/v1/agents', networkError); await act(async () => app.probe.current!.refresh('B'));
  await screen.findByText('SERVIDOR B · SIN RESPUESTA');
  expect(screen.getByText('Preparar borrador')).toBeDisabled();
  await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); }); expect(router.replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'ops, Servidor B sin respuesta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'ops, Servidor B sin respuesta' })).toHaveStyle({ opacity: 0.45 });
  fireEvent.press(screen.getByText('ops')); expect(screen.getByText('Preparar borrador')).toBeDisabled();
  fireEvent.press(screen.getByText('Agente A')); expect(screen.getByText('Preparar borrador')).toBeEnabled();
  await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ server: 'A', agent: 'agentA' }) })));
  expect(app.probe.current!.selectedServer).toBe('A'); await cleanupAsync();
});

test('a Servidor that does not answer and has no cached Agentes still shows «<NOMBRE> · SIN RESPUESTA», dimmed and not selectable', async () => {
  seed([serverA, serverB], { ...settings, faceid: false }); polling(serverA, [agentA]);
  respond(serverB.url, '/health', networkError); respond(serverB.url, '/v1/agents', networkError);
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'Contenido sin destino' });
  const app = renderApp(<DraftProvider><LockGate><ShareScreen /></LockGate></DraftProvider>); await app.ready(); await screen.findByText('Contenido sin destino');
  await act(async () => app.probe.current!.refresh('B'));
  await screen.findByText('SERVIDOR B · SIN RESPUESTA');
  const row = screen.getByRole('button', { name: 'Servidor B sin respuesta' });
  expect(row).toBeDisabled(); expect(row).toHaveStyle({ opacity: 0.45 });
  fireEvent.press(row); expect(screen.getByText('Preparar borrador')).toBeDisabled(); await cleanupAsync();
});

test('an Agente already chosen becomes unchosen when its Servidor stops answering', async () => {
  seed([serverA, serverB], { ...settings, faceid: false }); polling(serverA, [agentA]); polling(serverB, [{ ...agentA, id: 'ops', name: 'ops' }]);
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'Contenido sin destino' });
  const app = renderApp(<DraftProvider><LockGate><ShareScreen /></LockGate></DraftProvider>); await app.ready(); await screen.findByText('Contenido sin destino');
  await waitFor(() => expect(app.probe.current!.snapshot('B').agents).toHaveLength(1));
  fireEvent.press(screen.getByText('ops')); expect(screen.getByText('Preparar borrador')).toBeEnabled();
  respond(serverB.url, '/health', networkError); respond(serverB.url, '/v1/agents', networkError); await act(async () => app.probe.current!.refresh('B'));
  await screen.findByText('SERVIDOR B · SIN RESPUESTA');
  expect(screen.getByText('Preparar borrador')).toBeDisabled();
  await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); }); expect(router.replace).not.toHaveBeenCalled(); await cleanupAsync();
});

function Flow() {
  const [epoch,setEpoch] = useState(0);
  const [route, setRoute] = useState<{ server: string; agent: string; shareDraft: string } | null>(null);
  router.replace.mockImplementation((value) => { if (typeof value === 'object') setRoute(value.params); });
  return route ? <View style={{flex:1}}><Pressable onPress={()=>setEpoch(value=>value+1)}><Text>Reabrir chat de prueba</Text></Pressable><Pressable onPress={()=>setRoute(null)}><Text>Compartir de nuevo de prueba</Text></Pressable><ChatRouteContent key={epoch} serverId={route.server} agentId={route.agent} shareDraft={route.shareDraft} /></View> : <ShareScreen />;
}
test('one native image reuses the real reduction pipeline and reaches an empty NEW Conversation composer without creating a Turno', async () => {
  setup(); configureImageStorage(); const reduced = imageResult();
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'image', uri: 'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image', width: 4000, height: 3000 });
  const app = renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>); await app.ready();
  await screen.findByLabelText('Imagen compartida'); fireEvent.press(screen.getByText('Agente A'));
  await act(async () => fireEvent.press(screen.getByText('Preparar borrador')));
  await screen.findByLabelText('Imagen adjunta');
  expect(reduced.context.resize).toHaveBeenCalledWith({ width: 1600, height: 1200 });
  expect(imageFiles.has(screen.getByLabelText('Imagen adjunta').props.source.uri)).toBe(true);
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
  expect(requestsFor(serverA.url, '/v1/agents/agentA/transcript')).toHaveLength(0);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/conversations')).toHaveLength(0);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  await cleanupAsync();
});
test.each(['background', 'blur', 'route-blur', 'key-swap', 'remove', 'revoked', 'unmount'])('image preparation after %s discards the late copy and grants no navigation or draft', async (interruption) => {
  setup(); configureImageStorage(); const reduced = imageResult(); const response = deferred<unknown>();
  reduced.rendered.saveAsync.mockReturnValueOnce(response.promise as never);
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'image', uri: 'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image', width: 4000, height: 3000 });
  const app = mount(); await app.ready(); await screen.findByLabelText('Imagen compartida'); fireEvent.press(screen.getByText('Agente A'));
  await act(async () => fireEvent.press(screen.getByText('Preparar borrador')));
  await waitFor(() => expect(reduced.rendered.saveAsync).toHaveBeenCalled());
  await act(async () => {
    if (interruption === 'background') emitAppState('background');
    if (interruption === 'blur') emitAppBlur();
    if (interruption === 'route-blur') { navigation.focused = false; await app.probe.current!.setSetting('autoLockMs', 300000); }
    if (interruption === 'key-swap') await app.probe.current!.replaceServer(serverA.id, { ...serverA, key: 'replacement-fixture' });
    if (interruption === 'revoked') { respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'opaque' } }, 401)); app.probe.current!.refresh(); }
    if (interruption === 'remove') await app.probe.current!.removeServer(serverA.id);
    if (interruption === 'unmount') app.unmount();
  });
  await act(async () => response.resolve({ uri: 'file:///fixture/cache/reduced.jpg', base64: '/9j/', width: 1600, height: 1200 }));
  expect(router.replace).not.toHaveBeenCalled(); expect([...imageFiles.keys()].filter((uri) => uri.includes('relay-images/img-'))).toHaveLength(0);
  await cleanupAsync();
});
test.each([{ kind: 'rejected' }, { kind: 'rejected', reason: 'busy' }, { kind: 'image', uri: 'file:///sdcard/outside.jpg', width: 100, height: 100 }, { kind: 'text', text: 'é'.repeat(32001) }])('unsupported payload fails closed before destination selection', async (payload) => {
  setup(); receiveShare('11111111-1111-4111-8111-111111111111', payload); const app = mount(); await app.ready();
  await screen.findByText('ESTE CONTENIDO NO SE PUEDE COMPARTIR'); expect(screen.queryByText('Agente A')).toBeNull(); expect(router.replace).not.toHaveBeenCalled(); await cleanupAsync();
});

test('launcher waits for LockGate and ignores a late native capability after Android window blur', async () => {
 setup(true); receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'private'});
 const app=renderApp(<DraftProvider><LockGate><ShareLauncher /></LockGate></DraftProvider>); await app.ready(); await screen.findByText('Relay está bloqueado');
 expect(externalShare.pending).not.toHaveBeenCalled(); expect(router.push).not.toHaveBeenCalled();
 const pending=deferred<string[]>();externalShare.pending.mockReturnValueOnce(pending.promise);biometrics.authenticateAsync.mockResolvedValue({success:true});
 await act(async()=>fireEvent.press(screen.getByText('Usar el código del teléfono')));await waitFor(()=>expect(externalShare.pending).toHaveBeenCalled());
 await act(async()=>{emitAppBlur();pending.resolve(['11111111-1111-4111-8111-111111111111']);});expect(router.push).not.toHaveBeenCalled();
 await act(async()=>emitAppFocus());await waitFor(()=>expect(router.push).toHaveBeenCalledWith('/share'));expect(externalShare.read).not.toHaveBeenCalled();await cleanupAsync();
});
test('fabricated draft capability for a generic chat route reveals no text or Conversation',async()=>{
 setup();const app=renderApp(<DraftProvider><LockGate><ChatRouteContent serverId="A" agentId="agentA" shareDraft="forged-capability" /></LockGate></DraftProvider>);await app.ready();
 await screen.findByText('Este borrador ya no está disponible para este destino. Comparte el contenido de nuevo.');
 expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();expect(requestsFor(serverA.url,'/v1/agents/agentA/transcript')).toHaveLength(0);await cleanupAsync();
});
test('window blur hides a prepared draft, then resumes edited private text; a key swap retires its scope',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Contenido original'});
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Contenido original');fireEvent.press(screen.getByText('Agente A'));
 await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));
 const composer=await screen.findByPlaceholderText('Mensaje a Agente A…');fireEvent.changeText(composer,'Edición privada');
 await act(async()=>emitAppBlur());expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();
 await act(async()=>emitAppFocus());expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Edición privada');
 await act(async()=>{await app.probe.current!.replaceServer(serverA.id,{...serverA,key:'replacement-fixture'});});
 expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();expect(screen.queryByText('Edición privada')).toBeNull();expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});

test('removing the shared image and editing text survive a same-client draft remount without orphan preview',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image',width:4000,height:3000});
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');
 fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Texto conservado');await act(async()=>fireEvent.press(screen.getByLabelText('Quitar imagen')));
 expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();await act(async()=>fireEvent.press(screen.getByText('Reabrir chat de prueba')));
 expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Texto conservado');expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});

test('a replacement image survives draft remount and a late picker after window blur preserves that image',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image',width:4000,height:3000});
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');
 const original=screen.getByLabelText('Imagen adjunta').props.source.uri;
 imagePicker.launchImageLibraryAsync.mockResolvedValue({canceled:false,assets:[{uri:'file:///fixture/gallery/replacement.jpg',type:'image',width:4000,height:3000}]});imageResult();
 fireEvent.press(screen.getByLabelText('Adjuntar imagen'));await act(async()=>fireEvent.press(screen.getByText('Galería')));
 const replacement=screen.getByLabelText('Imagen adjunta').props.source.uri;expect(replacement).not.toBe(original);expect(imageFiles.has(original)).toBe(false);
 await act(async()=>fireEvent.press(screen.getByText('Reabrir chat de prueba')));expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(replacement);expect(imageFiles.has(replacement)).toBe(true);
 const pending=deferred<unknown>();imagePicker.launchImageLibraryAsync.mockReturnValueOnce(pending.promise);imageResult();
 fireEvent.press(screen.getByLabelText('Adjuntar imagen'));await act(async()=>fireEvent.press(screen.getByText('Galería')));
 await act(async()=>{emitAppBlur();pending.resolve({canceled:false,assets:[{uri:'file:///fixture/gallery/late.jpg',type:'image',width:4000,height:3000}]});});
 await act(async()=>emitAppFocus());expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(replacement);expect(imageFiles.has(replacement)).toBe(true);
 expect([...imageFiles.keys()].filter(uri=>uri.includes('relay-images/img-'))).toEqual([replacement]);expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});

test.each(['blur','background','route-blur','key-swap','remove','revoked'])('explicit Send cannot continue a late Conversation creation into a Turno after %s',async(interruption)=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Mensaje privado explícito'});
 const created=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/conversations',created.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Mensaje privado explícito');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');
 await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(1));
 await act(async()=>{
  if(interruption==='blur')emitAppBlur();if(interruption==='background')emitAppState('background');
  if(interruption==='route-blur'){navigation.focused=false;await app.probe.current!.setSetting('autoLockMs',300000);}
  if(interruption==='key-swap')await app.probe.current!.replaceServer(serverA.id,{...serverA,key:'replacement-fixture'});
  if(interruption==='remove')await app.probe.current!.removeServer(serverA.id);
  if(interruption==='revoked'){respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));app.probe.current!.refresh();}
 });
 await act(async()=>{created.resolve(json(conversationA));});
 expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);
 if(interruption==='blur'){await act(async()=>emitAppFocus());expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Mensaje privado explícito');expect(screen.getByLabelText('Enviar')).not.toBeDisabled();}
 await cleanupAsync();
});

test('a Turno receipt after window blur is not presented as a current confirmed send',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Mensaje privado explícito'});
 respond(serverA.url,'/v1/agents/agentA/conversations',json(conversationA),'POST');respond(serverA.url,`/v1/agents/agentA/transcript?sessionId=${conversationA.id}`,json({conversation:conversationA,sessionId:conversationA.sessionId,items:[]}));
 const receipt=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/runs',receipt.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Mensaje privado explícito');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');
 await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1));
 await act(async()=>{emitAppBlur();receipt.resolve(json({runId:'late-share-run',sessionId:conversationA.sessionId,conversationId:conversationA.id,inputMessageId:'late-input'}));});
 expect(requestsFor(serverA.url,'/v1/runs/late-share-run/events')).toHaveLength(0);await act(async()=>emitAppFocus());
 expect(screen.getByText('No se confirmó el resultado del envío. Revisa la Conversación antes de volver a enviar.')).toBeVisible();
 expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Mensaje privado explícito');await cleanupAsync();
});

test('a late same-client terminal denial retires the private draft and file after background return without waiting for polling',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image',width:4000,height:3000});
 const created=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/conversations',created.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;
 fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Título privado');await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(1));
 await act(async()=>{emitAppState('background');emitAppState('active');});await act(async()=>created.resolve(json({error:{code:'device_revoked',message:'do-not-expose-terminal-payload'}},403)));
 expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();expect(screen.queryByText('Título privado')).toBeNull();expect(screen.queryByText('do-not-expose-terminal-payload')).toBeNull();expect(imageFiles.has(uri)).toBe(false);
 await act(async()=>fireEvent.press(screen.getByText('Reabrir chat de prueba')));expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});
test('an old terminal denial cannot retire the replacement client draft or its private file',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Cliente anterior'});
 const created=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/conversations',created.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Cliente anterior');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(1));
 await act(async()=>app.probe.current!.replaceServer(serverA.id,{...serverA,key:'replacement-fixture'}));await act(async()=>{receiveShare('22222222-2222-4222-8222-222222222222',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/22222222-2222-4222-8222-222222222222/image',width:4000,height:3000});fireEvent.press(screen.getByText('Compartir de nuevo de prueba'));});
 await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Cliente nuevo');
 await act(async()=>created.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Cliente nuevo');expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(uri);expect(imageFiles.has(uri)).toBe(true);
 expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});

test('an old terminal denial immediately retires a newer draft belonging to the same client',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Cliente anterior'});
 const created=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/conversations',created.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Cliente anterior');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(1));
 await act(async()=>{receiveShare('22222222-2222-4222-8222-222222222222',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/22222222-2222-4222-8222-222222222222/image',width:4000,height:3000});fireEvent.press(screen.getByText('Compartir de nuevo de prueba'));});
 await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await act(async()=>fireEvent.press(screen.getByText('Reemplazar borrador anterior')));await screen.findByLabelText('Imagen adjunta');const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Cliente nuevo');
 await act(async()=>created.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();expect(imageFiles.has(uri)).toBe(false);
 expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});

test('a nonterminal send refusal keeps the private draft and exposes only a fixed error, never a remote error body',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Borrador conservado'});respond(serverA.url,'/v1/agents/agentA/conversations',json({error:{code:'bad_request',message:'do-not-expose-error-body'}},400),'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Borrador conservado');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));
 expect(screen.queryByText('do-not-expose-error-body')).toBeNull();expect(screen.getByText('El envío quedó sin confirmar. Se conserva el borrador. Revisa la Conversación antes de reintentar.')).toBeVisible();expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Borrador conservado');expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});


test('changing theme keeps shared text, destination and instruction without native rereads or sending',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Synthetic shared content'});
 function Toggle(){const {setPreference}=useThemePreference();return <Pressable onPress={()=>setPreference('dark')}><Text>Choose dark share</Text></Pressable>;}
 const view=renderApp(<ThemeProvider><Toggle/><DraftProvider><LockGate><ShareScreen/></LockGate></DraftProvider></ThemeProvider>);await view.ready();await screen.findByText('Synthetic shared content');
 fireEvent.press(screen.getByText('Agente A'));fireEvent.changeText(screen.getByLabelText('Instrucción opcional'),'Borrador con tema');
 expect(view.getByLabelText('Compartir con Relay')).toHaveStyle({backgroundColor:LIGHT_PALETTE.K.background});const reads=externalShare.read.mock.calls.length;
 await act(async()=>fireEvent.press(screen.getByText('Choose dark share')));
 expect(view.getByLabelText('Compartir con Relay')).toHaveStyle({backgroundColor:DARK_PALETTE.K.background});
 expect(screen.getByLabelText('Instrucción opcional')).toHaveProp('value','Borrador con tema');expect(screen.getByLabelText('Instrucción opcional')).toHaveStyle({color:DARK_PALETTE.K.ink});
 expect(screen.getByText('Synthetic shared content')).toBeVisible();expect(screen.getByText('Preparar borrador')).toBeEnabled();expect(externalShare.read).toHaveBeenCalledTimes(reads);expect(requestsFor(serverA.url,'/v1/runs')).toHaveLength(0);expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(0);
 await cleanupAsync();
});

test('independent SPEC: blur synchronously rejects a retained prepare button before focus/render',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Private share before blur'});
 const app=mount();await app.ready();await screen.findByText('Private share before blur');fireEvent.press(screen.getByText('Agente A'));
 const retained=screen.getByText('Preparar borrador');
 await act(async()=>{emitAppBlur();fireEvent.press(retained);emitAppFocus();});
 console.log('SPEC_SHARE_BLUR_PREPARE',JSON.stringify({navigations:router.replace.mock.calls.length,draftRoute:router.replace.mock.calls[0]?.[0]?.pathname}));
 expect(router.replace).not.toHaveBeenCalled();await cleanupAsync();
});

test('independent SPEC: blur synchronously rejects a retained Send button before focus/render',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Private share send'});
 const created=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/conversations',created.promise,'POST');
 const app=renderApp(<DraftProvider><LockGate><Flow /></LockGate></DraftProvider>);await app.ready();await screen.findByText('Private share send');fireEvent.press(screen.getByText('Agente A'));
 await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');
 const retained=screen.getByLabelText('Enviar');
 await act(async()=>{emitAppBlur();fireEvent.press(retained);emitAppFocus();});
 console.log('SPEC_SHARE_BLUR_SEND',JSON.stringify({conversationPosts:requestsFor(serverA.url,'/v1/agents/agentA/conversations').length,turnPosts:requestsFor(serverA.url,'/v1/agents/agentA/runs').length}));
 expect(requestsFor(serverA.url,'/v1/agents/agentA/conversations')).toHaveLength(0);await cleanupAsync();
});


test('review-independent polling revocation permanently rejects the same client even after an offline response',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Contenido privado sintético'});
 const app=mount();await app.ready();await screen.findByText('Contenido privado sintético');const client=app.probe.current!.clientFor('A');
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));
 await act(async()=>app.probe.current!.refresh('A'));await screen.findByText('Empareja de nuevo para usar este destino.');
 respond(serverA.url,'/health',networkError);respond(serverA.url,'/v1/agents',networkError);
 await act(async()=>app.probe.current!.refresh('A'));
 expect(app.probe.current!.clientFor('A')).toBe(client);
 const agent=screen.queryByText('Agente A');if(agent)fireEvent.press(agent);
 await act(async()=>{const prepare=screen.queryByText('Preparar borrador');if(prepare)fireEvent.press(prepare);});
 expect(router.replace).not.toHaveBeenCalled();
 expect(screen.getByText('Empareja de nuevo para usar este destino.')).toBeVisible();
 await cleanupAsync();
});

// Observes the real store boundary; no storage algorithm is replaced.
function DraftProbe({ capture }: { capture: (store: ReturnType<typeof useDraftStore>) => void }) {
 const store=useDraftStore();useEffect(()=>capture(store),[capture,store]);return null;
}
test('polling retirement permanently purges the same client private image and reference across offline recovery',async()=>{
 setup();configureImageStorage();imageResult();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image',width:4000,height:3000});
 let store: ReturnType<typeof useDraftStore>|null=null;const capture=(value: ReturnType<typeof useDraftStore>)=>{store=value;};
 const app=renderApp(<DraftProvider><DraftProbe capture={capture}/><LockGate><Flow/></LockGate></DraftProvider>);await app.ready();await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');
 const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;const client=app.probe.current!.clientFor('A');const target={serverId:'A',agentId:'agentA',client};const id=router.replace.mock.calls[0][0].params.shareDraft;
 fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Contenido privado del borrador');
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'never expose remote payload'}},403));await act(async()=>{emitAppState('background');app.probe.current!.refresh('A');});
 await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.action).toBe('pair'));
 expect(store!.isRetired(client)).toBe(true);expect(store!.byId(target,id)).toBeNull();expect(imageFiles.has(uri)).toBe(false);
 respond(serverA.url,'/health',networkError);respond(serverA.url,'/v1/agents',networkError);await act(async()=>{emitAppState('active');app.probe.current!.refresh('A');});await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.action).not.toBe('pair'));
 expect(store!.put(target,{text:'Must never resurrect',image:null},()=>true)).toBeNull();expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();expect(screen.queryByText('never expose remote payload')).toBeNull();
 await act(async()=>fireEvent.press(screen.getByText('Reabrir chat de prueba')));expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});
test('cached polling denial retires its causal client only, never replacement credentials',async()=>{
 setup();receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Client ownership'});
 let store: ReturnType<typeof useDraftStore>|null=null;const capture=(value: ReturnType<typeof useDraftStore>)=>{store=value;};const app=renderApp(<DraftProvider><DraftProbe capture={capture}/><LockGate><ShareScreen/></LockGate></DraftProvider>);await app.ready();await screen.findByText('Client ownership');const old=app.probe.current!.clientFor('A');
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));await act(async()=>app.probe.current!.refresh('A'));await screen.findByText('Empareja de nuevo para usar este destino.');
 const pending=deferred<Response>();respond(serverA.url,'/v1/agents',pending.promise);await act(async()=>app.probe.current!.replaceServer('A',{...serverA,key:'new-fixture-key'}));const replacement=app.probe.current!.clientFor('A');expect(replacement).not.toBe(old);
 expect(store!.isRetired(old)).toBe(true);expect(store!.isRetired(replacement)).toBe(false);
 const target={serverId:'A',agentId:'agentA',client:replacement};const draft=store!.put(target,{text:'Replacement private draft',image:null},()=>true);expect(draft).not.toBeNull();
 await act(async()=>pending.resolve(json({agents:[agentA]})));expect(store!.read(target)?.id).toBe(draft!.id);expect(store!.isRetired(replacement)).toBe(false);await cleanupAsync();
});

test('polling retirement rejects a queued native copy after offline return and removes its late private file',async()=>{
 setup();configureImageStorage();imageResult();const copied=deferred<unknown>();let queued='';
 legacyFileSystem.copyAsync.mockImplementationOnce(async(options: unknown)=>{const {from,to}=options as {from:string;to:string};queued=to;await copied.promise;imageFiles.set(to,imageFiles.get(from)!);});
 receiveShare('11111111-1111-4111-8111-111111111111',{kind:'image',uri:'file:///data/user/0/io.github.fixture/cache/relay-share/11111111-1111-4111-8111-111111111111/image',width:4000,height:3000});
 let store: ReturnType<typeof useDraftStore>|null=null;const capture=(value:ReturnType<typeof useDraftStore>)=>{store=value;};const app=renderApp(<DraftProvider><DraftProbe capture={capture}/><LockGate><ShareScreen/></LockGate></DraftProvider>);await app.ready();await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await waitFor(()=>expect(queued).not.toBe(''));
 const client=app.probe.current!.clientFor('A');respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));await act(async()=>app.probe.current!.refresh('A'));await waitFor(()=>expect(store!.isRetired(client)).toBe(true));
 respond(serverA.url,'/health',networkError);respond(serverA.url,'/v1/agents',networkError);await act(async()=>app.probe.current!.refresh('A'));await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.action).not.toBe('pair'));await act(async()=>copied.resolve(undefined));
 expect(imageFiles.has(queued)).toBe(false);expect(store!.read({serverId:'A',agentId:'agentA',client})).toBeNull();expect(router.replace).not.toHaveBeenCalled();await cleanupAsync();
});
test('polling retirement never affects a different Server client private draft',async()=>{
 seed([serverA,serverB],{...settings,faceid:false});polling(serverA,[agentA]);polling(serverB,[agentA]);
 let store: ReturnType<typeof useDraftStore>|null=null;const capture=(value:ReturnType<typeof useDraftStore>)=>{store=value;};const app=renderApp(<DraftProvider><DraftProbe capture={capture}/></DraftProvider>);await app.ready();await waitFor(()=>expect(app.probe.current!.snapshot('B').reachable).toBe(true));
 const clientA=app.probe.current!.clientFor('A'),clientB=app.probe.current!.clientFor('B');const target={serverId:'B',agentId:'agentA',client:clientB};const original=store!.put(target,{text:'Private B',image:null},()=>true)!;
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));await act(async()=>app.probe.current!.refresh('A'));await waitFor(()=>expect(store!.isRetired(clientA)).toBe(true));
 expect(store!.isRetired(clientB)).toBe(false);expect(store!.byId(target,original.id)?.text).toBe('Private B');await cleanupAsync();
});

async function unlockShare(){biometrics.authenticateAsync.mockResolvedValueOnce({success:true});await act(async()=>fireEvent.press(screen.getByText('Usar el código del teléfono')));}
test('locking Relay purges prepared drafts, their private image and the native copies pending before the lock',async()=>{
 setup(true);configureImageStorage();imageResult();const prepared='11111111-1111-4111-8111-111111111111',waiting='22222222-2222-4222-8222-222222222222';
 receiveShare(prepared,{kind:'image',uri:`file:///data/user/0/io.github.fixture/cache/relay-share/${prepared}/image`,width:4000,height:3000});
 const app=renderApp(<DraftProvider><LockGate><Flow/></LockGate></DraftProvider>);await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();
 await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');
 const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'),'Texto privado del borrador');
 await act(async()=>receiveShare(waiting,{kind:'text',text:'Contenido sin revisar'}));
 await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(screen.getByText('Relay está bloqueado')).toBeVisible();
 await waitFor(()=>expect(externalShare.discard).toHaveBeenCalledWith(waiting));expect(imageFiles.has(uri)).toBe(false);
 expect(screen.queryByText('Texto privado del borrador',{includeHiddenElements:true})).toBeNull();expect(screen.queryByDisplayValue('Texto privado del borrador',{includeHiddenElements:true})).toBeNull();
 await unlockShare();expect(screen.getByText('Este borrador ya no está disponible para este destino. Comparte el contenido de nuevo.')).toBeVisible();
 await act(async()=>fireEvent.press(screen.getByText('Compartir de nuevo de prueba')));await screen.findByText('NADA QUE COMPARTIR');
 expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(0);await cleanupAsync();
});
test('a lock on return purges what was pending when Relay left, but keeps content shared while it was away',async()=>{
 setup(true);const before='11111111-1111-4111-8111-111111111111',away='22222222-2222-4222-8222-222222222222';
 receiveShare(before,{kind:'text',text:'Compartido antes de salir'});const app=mount();await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();await screen.findByText('Compartido antes de salir');
 await act(async()=>emitAppState('background'));receiveShare(away,{kind:'text',text:'Compartido con Relay fuera'});jest.setSystemTime(Date.now()+60000);
 await act(async()=>emitAppState('active'));expect(screen.getByText('Relay está bloqueado')).toBeVisible();
 await waitFor(()=>expect(externalShare.discard).toHaveBeenCalledWith(before));expect(externalShare.discard).not.toHaveBeenCalledWith(away);
 await unlockShare();await screen.findByText('Compartido con Relay fuera');expect(screen.queryByText('Compartido antes de salir')).toBeNull();await cleanupAsync();
});
test('a return within the lock delay purges nothing; a later idle lock purges what is pending then',async()=>{
 setup(true);const token='11111111-1111-4111-8111-111111111111',later='22222222-2222-4222-8222-222222222222';receiveShare(token,{kind:'text',text:'Sigue disponible'});
 const app=mount();await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();await screen.findByText('Sigue disponible');
 await act(async()=>emitAppState('background'));jest.setSystemTime(Date.now()+1000);await act(async()=>emitAppState('active'));
 await act(async()=>jest.advanceTimersByTimeAsync(1000));expect(screen.getByText('Sigue disponible')).toBeVisible();expect(externalShare.discard).not.toHaveBeenCalled();
 await act(async()=>receiveShare(later,{kind:'text',text:'Llegó después'}));await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(screen.getByText('Relay está bloqueado')).toBeVisible();
 await waitFor(()=>expect(externalShare.discard).toHaveBeenCalledWith(later));expect(externalShare.discard).toHaveBeenCalledWith(token);await cleanupAsync();
});
function sendWhileLocking(){
 respond(serverA.url,'/v1/agents/agentA/conversations',json(conversationA),'POST');respond(serverA.url,`/v1/agents/agentA/transcript?sessionId=${conversationA.id}`,json({conversation:conversationA,sessionId:conversationA.sessionId,items:[]}));
 const receipt=deferred<Response>();respond(serverA.url,'/v1/agents/agentA/runs',receipt.promise,'POST');return receipt;
}
test.each([
 ['an accepted Turno keeps it', json({runId:'locked-share-run',sessionId:conversationA.sessionId,conversationId:conversationA.id,inputMessageId:'locked-input'}), true],
 ['a refusal while still locked purges it', json({error:{code:'conversation_busy',message:'opaque'}},409), false],
] as const)('a lock during an image send keeps the image until the send resolves; %s',async(_outcome,response,kept)=>{
 setup(true);configureImageStorage();imageResult();const token='11111111-1111-4111-8111-111111111111';
 receiveShare(token,{kind:'image',uri:`file:///data/user/0/io.github.fixture/cache/relay-share/${token}/image`,width:4000,height:3000});const receipt=sendWhileLocking();
 const app=renderApp(<DraftProvider><LockGate><Flow/></LockGate></DraftProvider>);await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();
 await screen.findByLabelText('Imagen compartida');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByLabelText('Imagen adjunta');
 const uri=screen.getByLabelText('Imagen adjunta').props.source.uri;
 await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1));
 await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(screen.getByText('Relay está bloqueado')).toBeVisible();expect(imageFiles.has(uri)).toBe(true);
 await act(async()=>receipt.resolve(response));
 expect(imageFiles.has(uri)).toBe(kept);expect([...imageFiles.values()].some((saved)=>saved.includes(uri)&&saved.includes('locked-share-run'))).toBe(kept);
 expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1);await cleanupAsync();
});
test('a lock during a text send keeps the uncertain result notice after the Server accepts it',async()=>{
 setup(true);receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Texto enviado al bloquear'});const receipt=sendWhileLocking();
 const app=renderApp(<DraftProvider><LockGate><Flow/></LockGate></DraftProvider>);await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();
 await screen.findByText('Texto enviado al bloquear');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');
 await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1));
 await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(screen.getByText('Relay está bloqueado')).toBeVisible();
 await act(async()=>receipt.resolve(json({runId:'locked-text-run',sessionId:conversationA.sessionId,conversationId:conversationA.id,inputMessageId:'locked-text'})));
 await unlockShare();
 expect(screen.getByText('No se confirmó el resultado del envío. Revisa la Conversación antes de volver a enviar.')).toBeVisible();
 expect(screen.queryByText('Este borrador ya no está disponible para este destino. Comparte el contenido de nuevo.')).toBeNull();
 expect(requestsFor(serverA.url,'/v1/runs/locked-text-run/events')).toHaveLength(0);await cleanupAsync();
});
test('a send refused after Relay unlocks again keeps the draft held at the lock',async()=>{
 setup(true);receiveShare('11111111-1111-4111-8111-111111111111',{kind:'text',text:'Borrador retenido'});const receipt=sendWhileLocking();
 const app=renderApp(<DraftProvider><LockGate><Flow/></LockGate></DraftProvider>);await app.ready();await screen.findByText('Relay está bloqueado');await unlockShare();
 await screen.findByText('Borrador retenido');fireEvent.press(screen.getByText('Agente A'));await act(async()=>fireEvent.press(screen.getByText('Preparar borrador')));await screen.findByPlaceholderText('Mensaje a Agente A…');
 await act(async()=>fireEvent.press(screen.getByLabelText('Enviar')));await waitFor(()=>expect(requestsFor(serverA.url,'/v1/agents/agentA/runs')).toHaveLength(1));
 await act(async()=>jest.advanceTimersByTimeAsync(60000));expect(screen.getByText('Relay está bloqueado')).toBeVisible();await unlockShare();
 await act(async()=>receipt.resolve(json({error:{code:'conversation_busy',message:'opaque'}},409)));
 expect(screen.getByText('El envío quedó sin confirmar. Se conserva el borrador. Revisa la Conversación antes de reintentar.')).toBeVisible();
 await act(async()=>fireEvent.press(screen.getByText('Reabrir chat de prueba')));expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value','Borrador retenido');await cleanupAsync();
});
