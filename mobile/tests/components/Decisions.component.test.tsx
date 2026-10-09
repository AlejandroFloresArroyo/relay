import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApprovalSheet } from '@/screens/ApprovalSheet';
import { ApprovalsScreen } from '@/screens/ApprovalsScreen';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { agentA, approval, polling, seed, serverA, serverB } from '../support/fixtures';
import { drag, hold } from '../support/gestures';
import { biometrics, deferred } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requests, respond } from '../support/transport';
import type { DecisionRecord } from '../../../protocol/protocol';
const record: DecisionRecord = {id:'decision-fixture',agentId:'agentA',agentName:'Agente A',sessionId:'discord-session',runId:null,approvalId:null,toolCallId:'fixture-call',command:'rm -rf build',actor:'guardian',outcome:'approved',choice:null,at:Date.parse('2026-10-03T11:00:00Z'),timeKind:'result',origin:'other',source:'discord',originLabel:'Discord'};
/** Opens one of the three selectors (AGENTE, DECIDE, CANAL) and chooses `option` in its sheet. */
function pick(selector: 'AGENTE'|'DECIDE'|'CANAL', option: string) {
 fireEvent.press(screen.getByRole('button',{name:new RegExp(`^${selector} · `)}));
 fireEvent.press(screen.getByRole('button',{name:option}));
}
test('history uses real transport and the AGENTE, DECIDE and CANAL selectors combine like the filters, without inventing consent time', async () => {
 seed(); polling(serverA,[agentA]);
 respond(serverA.url,'/v1/decisions',json({decisions:[record,{...record,id:'unknown',command:'echo unclassified',actor:'unknown',outcome:'executed'}],capturedAt:record.at}));
 const app=renderApp(<ChatVisibilityProvider value={true}><ApprovalsScreen/></ChatVisibilityProvider>); await app.ready();
 await waitFor(()=>expect(screen.getByText('rm -rf build')).toBeVisible());
 expect(screen.getByText('echo unclassified')).toBeVisible();
 expect(screen.getAllByText(/HORA DEL RESULTADO/)).toHaveLength(2);
 expect(screen.getByText('APROBADA · GUARDIÁN')).toBeVisible();
 pick('DECIDE','Guardián');
 expect(screen.getByRole('button',{name:/^DECIDE · Guardián/})).toBeVisible();
 expect(screen.queryByText('echo unclassified')).toBeNull();
 pick('AGENTE','Agente A');
 expect(screen.getByText('rm -rf build')).toBeVisible();
 pick('CANAL','Relay');
 expect(screen.queryByText('rm -rf build')).toBeNull();
 expect(screen.getByText('No hay registros con estos filtros.')).toBeVisible();
 pick('CANAL','Todos');
 expect(screen.getByText('rm -rf build')).toBeVisible();
});
test('loading does not claim nothing pending and history errors offer retry', async () => {
 seed(); polling(serverA,[agentA]);
 const response=deferred<Response>(); respond(serverA.url,'/v1/decisions',response.promise);
 const app=renderApp(<ApprovalsScreen/>); await app.ready();
 expect(screen.getByText('CARGANDO APROBACIONES…')).toBeVisible();
 expect(screen.queryByText('SIN APROBACIONES PENDIENTES')).toBeNull();
 await act(async()=>{response.resolve(json({error:{code:'decision_history_unavailable',message:'fixture'}},503));});
 await waitFor(()=>expect(screen.getByText('No se pudo cargar el historial. Reintenta.')).toBeVisible());
 expect(screen.getByRole('button',{name:'Reintentar'})).toBeVisible();
});

test('pulling Aprobaciones down reloads the pending ones and the history, and keeps «CARGANDO…» until both arrive', async () => {
 seed(); polling(serverA,[agentA]); respond(serverA.url,'/v1/decisions',json({decisions:[],capturedAt:record.at}));
 const app=renderApp(<ApprovalsScreen/>); await app.ready();
 await waitFor(()=>expect(screen.getByText('SIN APROBACIONES PENDIENTES')).toBeVisible());
 const history=deferred<Response>();
 respond(serverA.url,'/v1/approvals',json({approvals:[approval().approval]}));
 respond(serverA.url,'/v1/decisions',history.promise);
 hold('pull-to-refresh',[{y:120}]).release();
 await waitFor(()=>expect(screen.getByText('PENDIENTES · 1')).toBeVisible());
 expect(screen.getByText('CARGANDO…')).toBeVisible();
 await act(async()=>{history.resolve(json({decisions:[record],capturedAt:record.at}));});
 await waitFor(()=>expect(screen.getByText('rm -rf build')).toBeVisible());
 await waitFor(()=>expect(screen.queryByText('CARGANDO…')).toBeNull());
});

test('an uncertain attempt is visibly distinct from a completed approval',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[],capturedAt:record.at,uncertain:[{id:'attempt',agentId:'agentA',agentName:'Agente A',command:'echo unknown attempt',choice:'once',at:record.at,origin:'relay'}]}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();
 await waitFor(()=>expect(screen.getByText('DECISIÓN SIN CONFIRMAR')).toBeVisible());
 expect(screen.getByText('echo unknown attempt')).toBeVisible();
 expect(screen.getByText('No se conoce el resultado. Relay no enviará esta elección otra vez.')).toBeVisible();
 expect(screen.queryByText('SIN APROBACIONES PENDIENTES')).toBeNull();
});

test('a failed refresh retains dated readonly history but never old actionable pending commands',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();await waitFor(()=>expect(screen.getByText('rm -rf build')).toBeVisible());
 respond(serverA.url,'/v1/decisions',()=>{throw new Error('Fixture offline');});
 respond(serverA.url,'/health',()=>{throw new Error('Fixture offline');});
 respond(serverA.url,'/v1/agents',()=>{throw new Error('Fixture offline');});
 await act(async()=>{await jest.advanceTimersByTimeAsync(5000);});
 expect(screen.getByText(/historial guardado/)).toBeVisible();expect(screen.getByText('rm -rf build')).toBeVisible();
 expect(screen.queryByText('SIN APROBACIONES PENDIENTES')).toBeNull();
});

test('a Servidor that does not answer is a compact row with Reintentar, not the big block',async()=>{
 seed([serverA,serverB]);polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 for (const path of ['/health','/v1/agents','/v1/approvals','/v1/decisions']) respond(serverB.url,path,()=>{throw new Error('Fixture offline');});
 const app=renderApp(<ApprovalsScreen/>);await app.ready();
 await waitFor(()=>expect(screen.getByText('SERVIDOR B · SIN RESPUESTA')).toBeVisible());
 expect(screen.getAllByRole('button',{name:'Reintentar'}).length).toBeGreaterThan(0);
 expect(screen.queryByText(/SIN RESPUESTA · REVISA/)).toBeNull();
 expect(screen.getByText('rm -rf build')).toBeVisible();
});

test('agent filters distinguish profiles with the same id on different Servidores',async()=>{
 seed([serverA,serverB]);polling(serverA,[agentA]);polling(serverB,[agentA]);
 respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));respond(serverB.url,'/v1/decisions',json({decisions:[{...record,command:'echo second server'}],capturedAt:record.at}));
 const app=renderApp(<ChatVisibilityProvider value={true}><ApprovalsScreen/></ChatVisibilityProvider>);await app.ready();await waitFor(()=>expect(screen.getByText('echo second server')).toBeVisible());
 pick('AGENTE','Agente A · Servidor B');
 expect(screen.queryByText('rm -rf build')).toBeNull();expect(screen.getByText('echo second server')).toBeVisible();
});


test('uncertain attempts follow the selected Agente and remain distinct across Servidores',async()=>{
 seed([serverA,serverB]);polling(serverA,[agentA]);polling(serverB,[agentA]);
 const attempt={id:'attempt',agentId:'agentA',agentName:'Agente A',command:'echo first uncertain',choice:'once',at:record.at,origin:'relay'};
 respond(serverA.url,'/v1/decisions',json({decisions:[],capturedAt:record.at,uncertain:[attempt]}));
 respond(serverB.url,'/v1/decisions',json({decisions:[],capturedAt:record.at,uncertain:[{...attempt,command:'echo second uncertain'}]}));
 const app=renderApp(<ChatVisibilityProvider value={true}><ApprovalsScreen/></ChatVisibilityProvider>);await app.ready();await waitFor(()=>expect(screen.getByText('echo second uncertain')).toBeVisible());
 pick('AGENTE','Agente A · Servidor B');
 expect(screen.queryByText('echo first uncertain')).toBeNull();expect(screen.getByText('echo second uncertain')).toBeVisible();
});

test('revocation clears previously cached history instead of retaining commands after access is lost',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();await waitFor(()=>expect(screen.getByText('rm -rf build')).toBeVisible());
 respond(serverA.url,'/v1/decisions',json({error:{code:'device_revoked',message:'Fixture revoked'}},401));
 await act(async()=>{await jest.advanceTimersByTimeAsync(5000);});
 expect(screen.queryByText('rm -rf build')).toBeNull();expect(screen.queryByText(/historial guardado/)).toBeNull();
});


test('a partial history failure identifies its Servidor while preserving the other history',async()=>{
 seed([serverA,serverB]);polling(serverA,[agentA]);polling(serverB,[agentA]);
 respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 respond(serverB.url,'/v1/decisions',json({error:{code:'decision_history_unavailable',message:'Fixture database unavailable'}},503));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();await waitFor(()=>expect(screen.getByText('rm -rf build')).toBeVisible());
 expect(screen.getByText('No se pudo cargar el historial de Servidor B. Reintenta.')).toBeVisible();
 expect(screen.getByRole('button',{name:'Reintentar'})).toBeVisible();expect(screen.queryByText('SIN APROBACIONES PENDIENTES')).toBeNull();
});


test('large legacy histories mount a hundred recent rows globally, keep complete pending/uncertain commands and preserve server filters under LockGate',async()=>{
 seed([serverA,serverB]);polling(serverA,[agentA]);polling(serverB,[agentA]);
 const pendingCommand='pending-full-'+ 'p'.repeat(3000), uncertainCommand='uncertain-full-'+ 'u'.repeat(3000);
 const pending=approval().approval;
 respond(serverA.url,'/v1/approvals',json({approvals:[{...pending,command:pendingCommand}]}));
 for(const [server,base] of [[serverA,240],[serverB,120]] as const){
  respond(server.url,'/v1/decisions',json({decisions:Array.from({length:120},(_,i)=>({...record,id:`large-${i}`,at:record.at+base+i,command:`history-${server.id}-${i} `+'h'.repeat(3000)})),capturedAt:record.at,
   uncertain:[{id:'uncertain',agentId:'agentA',agentName:'Agente A',command:uncertainCommand+server.id,choice:'once',at:record.at,origin:'relay'}]}));
 }
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const app=renderApp(<LockGate><ApprovalsScreen/></LockGate>);await app.ready();
 await waitFor(()=>expect(screen.getByText(/^history-A-119 /)).toBeVisible());
 expect(screen.getAllByText('HORA DEL RESULTADO').length).toBe(100);
 expect(screen.getByText(/Mostrando los 100 registros más recientes/)).toBeVisible();
 expect(screen.queryAllByText(/Los filtros se aplican solo a los últimos 100 registros de cada Servidor/).length).toBe(1);
 expect(screen.queryAllByText(/máximo 100 visibles/).length).toBe(1);
 expect(screen.getAllByText('COMANDO ABREVIADO')).toHaveLength(100);
 expect(screen.getByText('$ '+pendingCommand)).toBeVisible();expect(screen.getByText(uncertainCommand+'A')).toBeVisible();expect(screen.getByText(uncertainCommand+'B')).toBeVisible();
 expect(screen.queryByText('history-A-119 '+'h'.repeat(3000))).toBeNull();
 pick('AGENTE','Agente A · Servidor B');
 expect(screen.getAllByText('HORA DEL RESULTADO').length).toBe(100);
 expect(screen.getByText(/^history-B-119 /)).toBeVisible();expect(screen.queryByText(/^history-A-/)).toBeNull();
 expect(screen.queryByText('$ '+pendingCommand)).toBeNull();expect(screen.getByText(uncertainCommand+'B')).toBeVisible();
 pick('DECIDE','Tú');
 expect(screen.getByText('No hay registros con estos filtros.')).toBeVisible();
 expect(screen.queryAllByText(/Los filtros se aplican solo a los últimos 100 registros de cada Servidor/).length).toBe(1);
 expect(screen.queryAllByText(/máximo 100 visibles/).length).toBe(1);
});

test('a pending Aprobación leads the list with its count and a live countdown that ends as VENCIDA',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 respond(serverA.url,'/v1/approvals',json({approvals:[approval().approval]}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();
 expect(await screen.findByText('PENDIENTES · 1')).toBeVisible();
 expect(screen.getByText('1 PENDIENTE · 1 EN EL HISTORIAL')).toBeVisible();
 expect(screen.getByText('$ echo fixture')).toBeVisible();
 expect(screen.getByText('5:00')).toBeVisible();
 expect(screen.queryByText('SIN APROBACIONES PENDIENTES')).toBeNull();
 await act(async()=>{await jest.advanceTimersByTimeAsync(61000);});
 expect(screen.getByText('3:59')).toBeVisible();
 await act(async()=>{await jest.advanceTimersByTimeAsync(240000);});
 expect(screen.getByText('VENCIDA')).toBeVisible();
 expect(screen.getByRole('button',{name:'Revisar comando de Agente A'})).toBeDisabled();
});

test.each([-600000,600000])('the countdown uses the Puente clock with phone skew %i ms',async(skew)=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 const phoneNow=Date.now(); const pending=approval().approval;
 respond(serverA.url,'/v1/approvals',json({approvals:[{...pending,expiresAt:phoneNow-skew+300000}],serverNow:phoneNow-skew}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();
 expect(await screen.findByText('5:00')).toBeVisible();
 expect(screen.getByRole('button',{name:'Revisar comando de Agente A'})).toBeEnabled();
});

test('swiping a pending Aprobación right opens its sheet and never sends a Decisión; a short swipe does nothing',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[],capturedAt:record.at}));
 respond(serverA.url,'/v1/approvals',json({approvals:[approval().approval]}));
 const app=renderApp(<ChatVisibilityProvider value={true}><ApprovalsScreen/><ApprovalSheet/></ChatVisibilityProvider>);await app.ready();
 await screen.findByText('PENDIENTES · 1');
 drag('approval-A-approval-A',[{x:40},{x:80}]);
 expect(app.probe.current!.sheet).toBeNull();
 drag('approval-A-approval-A',[{x:60},{x:120}]);
 await waitFor(()=>expect(screen.getByText('Agente A quiere ejecutar')).toBeVisible());
 expect(app.probe.current!.sheet?.approval.id).toBe('approval-A');
 await act(async()=>{await jest.advanceTimersByTimeAsync(2000);});
 expect(requests.filter(request=>request.method === 'POST')).toEqual([]);
});

test('with nothing pending and every Servidor confirmed the screen says SIN APROBACIONES PENDIENTES',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,'/v1/decisions',json({decisions:[record],capturedAt:record.at}));
 const app=renderApp(<ApprovalsScreen/>);await app.ready();
 expect(await screen.findByText('SIN APROBACIONES PENDIENTES')).toBeVisible();
 expect(screen.getByText('Aquí aparecen cuando un Agente pida permiso.')).toBeVisible();
 expect(screen.getByText('0 PENDIENTES · 1 EN EL HISTORIAL')).toBeVisible();
 expect(screen.queryByText(/^PENDIENTES · /)).toBeNull();
 expect(screen.getByText('rm -rf build')).toBeVisible();
});
