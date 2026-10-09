import { Profiler, useState } from 'react';
import { LockGate } from '@/screens/LockGate';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { createDemoClient, resetDemo, setDemoActivityScenario, setDemoConnection } from '@/core/demo';
import { ActivityScreen } from '@/screens/ActivityScreen';
import { useApp } from '@/state/app';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA, polling, seed, serverA, serverB, health } from '../support/fixtures';
import { json, requests, respond, networkError } from '../support/transport';
import { clockStart, deferred, router, emitAppState, navigation, biometrics, secureStore } from '../support/native';
const path = '/v1/activity?limit=50';
const event = { id: 'event-A', at: clockStart, actor: { kind: 'device', id: serverA.deviceId }, action: 'job.run', category: 'tasks', result: 'requested', scope: { kind: 'agent', agentId: agentA.id }, conversationId: 'fixture-conversation' };
const page = (items = [event], nextCursor: string | null = null, capturedAt = clockStart) => ({ items, capturedAt, nextCursor });
const mount = () => renderApp(<ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider>);
test('global Activity uses the real provider and shows allowed metadata with honest results and actor labels', async () => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]);
  respond(serverA.url, path, json(page([{ ...event, command: 'hidden-command', message: 'hidden-message', deviceName: 'hidden-device', ip: 'hidden-ip' } as typeof event])));
  respond(serverB.url, path, json(page([{ ...event, id: 'event-B', action: 'server.pause', category: 'server', result: 'uncertain', actor: { kind: 'server' }, scope: { kind: 'server' }, conversationId: null } as unknown as typeof event], null, clockStart + 86400000)));
  const view = mount(); await view.ready();
  await waitFor(() => expect(view.queryByText('Ejecución de tarea')).not.toBeNull());
  expect(view.getByText('SOLICITADO')).toBeVisible(); expect(view.getByText('INCIERTO')).toBeVisible();
  expect(view.getByText('Este dispositivo')).toBeVisible(); expect(view.getByText('Puente')).toBeVisible();
  for (const secret of ['hidden-command', 'hidden-message', 'hidden-device', 'hidden-ip']) expect(view.queryByText(secret)).toBeNull();
  expect(view.queryByText('OK')).toBeNull();
  expect(requests.filter(r => r.path === path).map(r => r.origin).sort()).toEqual([serverA.url, serverB.url].sort());
  expect(view.getAllByText(/Fecha del Servidor · UTC/)).toHaveLength(2);
});


test('changing filters queues one current reading after the previous body, never another snapshot in parallel', async () => {
  seed(); polling(serverA, [agentA]);
  const pending = deferred<Response>();
  respond(serverA.url, path, pending.promise);
  respond(serverA.url, path + '&category=tasks', json(page([{ ...event, id: 'current-event', result: 'accepted' }])));
  const view = mount();
  await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(1));
  fireEvent.press(view.getByText('TAREAS'));
  await act(async () => {});
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(1);
  await act(async () => pending.resolve(json(page([{ ...event, action: 'agent.memory.edit', category: 'configuration' }]))));
  await view.findByText('ACEPTADO');
  expect(view.queryByText('Edición de memoria')).toBeNull();
  expect(requests.filter(r => r.path.startsWith('/v1/activity')).map(r => r.path)).toEqual([path, path + '&category=tasks']);
});


test('load more serializes double taps, preserves Server capture and order, deduplicates and retires a changed snapshot', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'cursor-1')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=cursor-1', pending.promise);
  respond(serverA.url, path + '&cursor=cursor-2', json(page([{ ...event, id: 'wrong-snapshot', action: 'agent.memory.delete', result: 'succeeded' }], null, clockStart + 1)));
  const view = mount(); await view.findByText('SOLICITADO');
  act(() => { fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A')); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A')); });
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=cursor-1'))).toHaveLength(1));
  expect(view.getByText('CARGANDO…')).toBeVisible();
  await act(async () => pending.resolve(json(page([event, { ...event, id: 'event-2', at: clockStart + 3600000, action: 'job.edit', result: 'accepted', actor: { kind: 'device', id: 'private-device-identifier' } }], 'cursor-2'))));
  expect(requests.filter(r => r.path.endsWith('cursor=cursor-1'))).toHaveLength(1);
  expect(view.getAllByText('SOLICITADO')).toHaveLength(1); expect(view.getByText('ACEPTADO')).toBeVisible();
  expect(view.getByText('Otro dispositivo')).toBeVisible(); expect(view.queryByText('private-device-identifier')).toBeNull();
  expect(view.getAllByRole('button', { name: /Ejecución de tarea|Edición de tarea/ }).map(node => node.props.accessibilityLabel)).toEqual(['Ejecución de tarea, SOLICITADO', 'Edición de tarea, ACEPTADO']);
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await view.findByText('La consulta de Actividad caducó. Actualiza para continuar.');
  expect(view.queryByText('Eliminación de memoria')).toBeNull(); expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
});

test('Activity row links use validated existing routes without claiming a message anchor', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page()));
  const view = mount(); await view.findByText('Ejecución de tarea');
  fireEvent.press(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  expect(view.getByText('Solicitud registrada; no confirma que se haya aplicado.')).toBeVisible();
  fireEvent.press(view.getByText('ABRIR CONVERSACIÓN ›'));
  expect(router.push).toHaveBeenLastCalledWith({ pathname: '/chat/[server]/[agent]', params: { server: 'A', agent: agentA.id, conversationId: 'fixture-conversation' } });
  fireEvent.press(view.getByText('VER AGENTE ›'));
  expect(router.push).toHaveBeenLastCalledWith({ pathname: '/agent/[server]/[agent]', params: { server: 'A', agent: agentA.id } });
  expect(view.queryByText(/EN ESTE PUNTO/)).toBeNull();
});

test.each(['hidden', 'blur', 'background', 'inactive', 'grouped-background'] as const)('late Activity page after %s stays invalid when returning, including notices and cursor', async kind => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'cursor-old')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=cursor-old', pending.promise);
  let visibility!: (value: boolean) => void;
  function Controlled() {
    const [visible, setVisible] = useState(true); visibility = setVisible;
    return <ChatVisibilityProvider value={visible}><ActivityScreen/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled/>); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=cursor-old'))).toHaveLength(1));
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  if (kind === 'hidden') { act(() => visibility(false)); expect(view.queryByText('Ejecución de tarea')).toBeNull(); act(() => visibility(true)); }
  if (kind === 'blur') { navigation.focused = false; await act(async () => { await view.probe.current!.refresh(serverA.id); }); expect(view.queryByText('Ejecución de tarea')).toBeNull(); navigation.focused = true; await act(async () => { await view.probe.current!.refresh(serverA.id); }); }
  if (kind === 'background' || kind === 'inactive') { act(() => emitAppState(kind)); expect(view.queryByText('Ejecución de tarea')).toBeNull(); act(() => emitAppState('active')); }
  if (kind === 'grouped-background') act(() => { emitAppState('background'); emitAppState('active'); });
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  await act(async () => pending.resolve(json(page([{ ...event, id: 'late-private', action: 'agent.soul.edit', result: 'succeeded' }], 'cursor-late'))));
  await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(2));
  expect(view.queryByText('Edición de personalidad')).toBeNull(); expect(view.queryByText('CONFIRMADO')).toBeNull();
  await act(async () => fresh.resolve(json(page([{ ...event, id: 'current-event', result: 'recorded' }]))));
  await view.findByText('REGISTRADO');
  expect(view.queryByText('Edición de personalidad')).toBeNull(); expect(view.queryByText('CONFIRMADO')).toBeNull();
  expect(view.queryByText('Solicitud registrada; no confirma que se haya aplicado.')).toBeNull();
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  expect(requests.filter(r => r.path === path)).toHaveLength(2);
});

test('real LockGate hides Activity and permanently retires its pending page after idle lock and phone-code unlock', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'cursor-idle')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=cursor-idle', pending.promise);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  const view = renderApp(<LockGate><ActivityScreen/></LockGate>); await view.findByText('SOLICITADO');
  await act(async () => { await jest.advanceTimersByTimeAsync(59000); });
  expect(requests.filter(r => r.path === path)).toHaveLength(1);
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=cursor-idle'))).toHaveLength(1));
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  expect(view.getByText('Relay está bloqueado')).toBeVisible(); expect(view.queryByText('Ejecución de tarea')).toBeNull();
  respond(serverA.url, path, json(page([{ ...event, result: 'recorded' }])));
  fireEvent.press(view.getByText('Usar el código del teléfono'));
  await waitFor(() => expect(view.queryByText('Relay está bloqueado')).not.toBeOnTheScreen());
  await act(async () => pending.resolve(json(page([{ ...event, id: 'idle-private', action: 'agent.memory.delete', result: 'succeeded' }], 'cursor-idle-old'))));
  await view.findByText('REGISTRADO'); expect(view.queryByText('Eliminación de memoria')).toBeNull();
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
});


test.each(['origin', 'key', 'device'] as const)('same-ID Server %s replacement hides the old client reading and rejects its late page', async kind => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'old-client')));
  const old = deferred<Response>(); respond(serverA.url, path + '&cursor=old-client', old.promise);
  const replacement = { ...serverA, ...(kind === 'origin' ? { url: serverB.url } : kind === 'key' ? { key: 'fixture-key-replaced' } : { deviceId: 'fixture-device-replaced' }) };
  let view!: ReturnType<typeof renderApp>; const commits: boolean[] = [];
  function ObserveRender() {
    const app = useApp(); const server = app.servers.find(entry => entry.id === serverA.id);
    const changed = !!server && [server.url, server.key, server.deviceId].join('|') === [replacement.url, replacement.key, replacement.deviceId].join('|');
    return <Profiler id="activity-scope" onRender={() => { if (changed && view) commits.push(view.queryByText('SOLICITADO') !== null); }}><ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider></Profiler>;
  }
  view = renderApp(<ObserveRender/>); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=old-client'))).toHaveLength(1));
  polling(replacement, [agentA]); const fresh = deferred<Response>(); respond(replacement.url, path, fresh.promise);
  await act(async () => { await view.probe.current!.replaceServer(serverA.id, replacement); });
  expect(commits.length).toBeGreaterThan(0); expect(commits).not.toContain(true);
  expect(view.queryByText('Ejecución de tarea')).toBeNull(); expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  await act(async () => old.resolve(json(page([{ ...event, id: 'old-secret', action: 'agent.soul.edit', result: 'succeeded' }], 'old-next'))));
  expect(view.queryByText('Edición de personalidad')).toBeNull();
  await act(async () => fresh.resolve(json(page([{ ...event, id: 'fresh-client', result: 'recorded', actor: { kind: 'device', id: replacement.deviceId } }]))));
  await view.findByText('REGISTRADO'); expect(view.getByText('Este dispositivo')).toBeVisible(); expect(view.queryByText('CONFIRMADO')).toBeNull();
});

test('offline memory survives screen remount with the same client, is dated read-only and never persisted', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'offline-cursor')));
  let toggle!: (visible: boolean) => void;
  function Remount() { const [visible, setVisible] = useState(true); toggle = setVisible; return visible ? <ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider> : null; }
  const view = renderApp(<Remount/>); await view.findByText('SOLICITADO'); secureStore.setItemAsync.mockClear();
  respond(serverA.url, '/health', () => networkError()); act(() => view.probe.current!.refresh(serverA.id));
  await view.findByText('Sin conexión. Última lectura en memoria; solo lectura.');
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  act(() => toggle(false)); act(() => toggle(true)); await view.findByText('SOLICITADO');
  expect(view.getByText(/Fecha del Servidor · UTC.*ÚLTIMA LECTURA/)).toBeVisible();
  expect(requests.filter(r => r.path === path)).toHaveLength(1); expect(secureStore.setItemAsync).not.toHaveBeenCalled();
});

test('AppProvider polling revocation purges memory before pending reading, including after remount and false recovery', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'revoked-cursor')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=revoked-cursor', pending.promise);
  let toggle!: (visible: boolean) => void;
  function Remount() { const [visible, setVisible] = useState(true); toggle = setVisible; return visible ? <ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider> : null; }
  const view = renderApp(<Remount/>); await view.findByText('SOLICITADO'); secureStore.setItemAsync.mockClear(); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=revoked-cursor'))).toHaveLength(1));
  respond(serverA.url, '/health', json({ error: { code: 'device_revoked', message: 'hidden-revocation-detail' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  await waitFor(() => expect(view.queryByText('SOLICITADO')).toBeNull());
  expect(view.getAllByText('DISPOSITIVO REVOCADO').length).toBeGreaterThan(0);
  act(() => toggle(false)); respond(serverA.url, '/health', () => networkError()); act(() => toggle(true));
  await act(async () => pending.resolve(json(page([{ ...event, id: 'revoked-late', action: 'agent.memory.delete', result: 'succeeded' }], 'revoked-next'))));
  polling(serverA, [agentA]); act(() => view.probe.current!.refresh(serverA.id)); await act(async () => {});
  expect(view.queryByText('SOLICITADO')).toBeNull(); expect(view.queryByText('Eliminación de memoria')).toBeNull();
  expect(requests.filter(r => r.path === path)).toHaveLength(1); expect(secureStore.setItemAsync).not.toHaveBeenCalled();
});

test('incompatible protocol purges memory, retires pending cursors and requires a fresh reading after recovery', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'protocol-cursor')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=protocol-cursor', pending.promise);
  const view = mount(); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=protocol-cursor'))).toHaveLength(1));
  respond(serverA.url, '/health', json({ ...health, protocolVersion: 999, minAppProtocolVersion: 999 }));
  act(() => view.probe.current!.refresh(serverA.id)); await waitFor(() => expect(view.queryByText('SOLICITADO')).not.toBeOnTheScreen());
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  polling(serverA, [agentA]); const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  act(() => view.probe.current!.refresh(serverA.id));
  await act(async () => pending.resolve(json(page([{ ...event, id: 'protocol-late', action: 'agent.soul.edit', result: 'succeeded' }], 'protocol-next'))));
  expect(view.queryByText('Edición de personalidad')).toBeNull(); expect(view.queryByText('SOLICITADO')).toBeNull();
  await act(async () => fresh.resolve(json(page([{ ...event, result: 'recorded' }])))); await view.findByText('REGISTRADO');
});

test.each([
  [404, 'unknown', 'Actualiza el Puente para consultar Actividad.'],
  [503, 'activity_busy', 'Hay demasiadas consultas de Actividad abiertas. Reintenta en unos minutos.'],
  [503, 'activity_unavailable', 'No se pudo leer el registro de Actividad del Puente. Reintenta.'],
] as const)('endpoint state %s/%s is visible and content-free while another Server continues', async (status, code, label) => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]);
  respond(serverA.url, path, json({ error: { code, message: 'hidden-error-body' } }, status));
  respond(serverB.url, path, json(page([{ ...event, id: 'other-server', result: 'recorded' }])));
  const view = mount(); await view.findByText(label); await view.findByText('REGISTRADO');
  expect(view.queryByText('hidden-error-body')).toBeNull(); expect(view.queryByText('CONFIRMADO')).toBeNull();
});

test('empty and loading states and combined Server/Agent/category/failure filters use real transport', async () => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]); respond(serverA.url, path, json(page())); respond(serverB.url, path, json(page([])));
  const selected = path + '&agentId=agentA&category=tasks&failuresOnly=true';
  const agentPath = path + '&agentId=agentA'; const failuresPath = agentPath + '&failuresOnly=true';
  respond(serverA.url, agentPath, json(page())); respond(serverA.url, failuresPath, json(page([{ ...event, result: 'failed' }])));
  const pending = deferred<Response>(); respond(serverA.url, selected, pending.promise);
  const view = mount(); await view.findByText('SIN ACTIVIDAD EN ESTA CONSULTA'); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByRole('button', { name: 'SERVIDOR A' })); fireEvent.press(view.getAllByText('AGENTA')[0]); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByText('SOLO FALLOS')); await view.findByText('NO CONFIRMADO'); fireEvent.press(view.getByText('TAREAS'));
  await view.findByText('Cargando Actividad…'); expect(view.queryByText('NO CONFIRMADO')).toBeNull();
  await act(async () => pending.resolve(json(page([{ ...event, result: 'rejected' }, { ...event, id: 'uncertain-event', result: 'uncertain' }, { ...event, id: 'failed-event', result: 'failed' }]))));
  await view.findByText('RECHAZADO'); expect(view.getByText('INCIERTO')).toBeVisible(); expect(view.getByText('NO CONFIRMADO')).toBeVisible();
  fireEvent.press(view.getByLabelText('Ejecución de tarea, RECHAZADO')); expect(view.getByText('Solicitud rechazada; no indica un fallo técnico.')).toBeVisible();
  expect(requests.filter(r => r.path === selected)).toHaveLength(1);
});

test('Agents owns the two-section selector and returns to its existing list', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page()));
  const view = renderApp(<ChatVisibilityProvider value><AgentsScreen/></ChatVisibilityProvider>); await view.findByText('Agente A'); fireEvent.press(view.getByRole('button', { name: 'Actividad' })); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByRole('button', { name: 'Agentes' })); await view.findByText('Agente A'); expect(view.queryByText('SOLICITADO')).toBeNull(); expect(view.queryByText('TRABAJO')).toBeNull();
});


test('retired late nonterminal endpoint errors cannot become notices or revocation for a current filter', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'error-old')));
  const pending = deferred<Response>(); respond(serverA.url, path + '&cursor=error-old', pending.promise);
  respond(serverA.url, path + '&category=tasks', json(page([{ ...event, result: 'recorded' }])));
  const view = mount(); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=error-old'))).toHaveLength(1));
  fireEvent.press(view.getByText('TAREAS'));
  await act(async () => pending.resolve(json({ error: { code: 'not_found', message: 'hidden-late-error' } }, 404)));
  await view.findByText('REGISTRADO'); expect(view.queryByText('DISPOSITIVO REVOCADO')).toBeNull(); expect(view.queryByText('hidden-late-error')).toBeNull();
});

test('queued obsolete filters are replaced and never start after the screen becomes hidden', async () => {
  seed(); polling(serverA, [agentA]); const pending = deferred<Response>(); respond(serverA.url, path, pending.promise);
  let toggle!: (visible: boolean) => void;
  function Visibility() { const [visible, setVisible] = useState(true); toggle = setVisible; return <ChatVisibilityProvider value={visible}><ActivityScreen/></ChatVisibilityProvider>; }
  const view = renderApp(<Visibility/>); await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(1));
  fireEvent.press(view.getByText('TAREAS')); await act(async () => {}); fireEvent.press(view.getByText('CONFIGURACIÓN')); await act(async () => {});
  act(() => toggle(false)); await act(async () => pending.resolve(json(page())));
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(1); expect(view.queryByText('SOLICITADO')).toBeNull();
  respond(serverA.url, path + '&category=configuration', json(page([{ ...event, action: 'agent.tools.enable', category: 'configuration', result: 'recorded' }])));
  act(() => toggle(true)); await view.findByText('REGISTRADO');
  expect(requests.filter(r => r.path.startsWith('/v1/activity')).map(r => r.path)).toEqual([path, path + '&category=configuration']);
});

test.each(['normal', 'empty', 'error', 'unsupported', 'busy', 'expired', 'clock-skew'] as const)('real Activity demo %s renders through the same bridge and screen', async scenario => {
  resetDemo(); setDemoActivityScenario('atlas', scenario);
  const demo = createDemoClient('atlas', () => clockStart);
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, path, async () => { try { return json(await demo.activity()); } catch (error) { const e = error as { code: string; status: number }; return json({ error: { code: e.code } }, e.status ?? 503); } });
  const view = mount();
  if (scenario === 'empty') await view.findByText('SIN ACTIVIDAD EN ESTA CONSULTA');
  else if (scenario === 'busy') await view.findByText('Hay demasiadas consultas de Actividad abiertas. Reintenta en unos minutos.');
  else if (scenario === 'unsupported') await view.findByText('Actualiza el Puente para consultar Actividad.');
  else if (scenario === 'error') await view.findByText('No se pudo leer el registro de Actividad del Puente. Reintenta.');
  else { await view.findByText('SOLICITADO'); if (scenario === 'expired') expect(view.getByText('CARGAR MÁS · SERVIDOR A')).toBeVisible(); else { expect(view.getByText('NO CONFIRMADO')).toBeVisible(); expect(view.getByText('RECHAZADO')).toBeVisible(); expect(view.getByText('INCIERTO')).toBeVisible(); } }
});


test('loaded date gaps use a compact qualified divider without asserting completeness of unobserved days', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event, { ...event, id: 'older-event', at: clockStart - 3 * 86400000, result: 'recorded' }])));
  const view = mount(); await view.findByText('2 DÍAS SIN REGISTROS VISIBLES');
  expect(view.getByText('SOLICITADO')).toBeVisible(); expect(view.getByText('REGISTRADO')).toBeVisible(); expect(view.queryByText('2 DÍAS SIN ACTIVIDAD')).toBeNull();
});


test('cold offline Server explicitly has no memory reading and never probes Activity before protocol is known', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/health', () => networkError());
  const view = mount(); await view.findByText('Sin conexión. No hay una lectura de Actividad en memoria.');
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(0); expect(view.queryByText('Cargando Actividad…')).toBeNull();
});


test('known endpoint denial hides its notice on blur/background and cannot expose metadata or retry the denied client', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json({ error: { code: 'device_revoked', message: 'hidden-denial-detail' } }, 403));
  const view = mount(); await view.findByText('DISPOSITIVO REVOCADO');
  act(() => emitAppState('background')); expect(view.queryByText('DISPOSITIVO REVOCADO')).toBeNull(); expect(view.queryByText('ACTUALIZAR · SERVIDOR A')).toBeNull();
  act(() => emitAppState('active')); await view.findByText('DISPOSITIVO REVOCADO');
  expect(requests.filter(r => r.path === path)).toHaveLength(1); expect(view.queryByText('hidden-denial-detail')).toBeNull();
});


test('real demo loading and expired cursor stay visible without starting automatic snapshots', async () => {
  resetDemo(); setDemoActivityScenario('atlas', 'loading'); const demo = createDemoClient('atlas', () => clockStart);
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, async () => json(await demo.activity()));
  const view = mount(); await view.findByText('Cargando Actividad…'); await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(1));
  await act(async () => { await jest.advanceTimersByTimeAsync(1500); }); await view.findByText('SOLICITADO');
  setDemoActivityScenario('atlas', 'expired'); const first = await demo.activity(); respond(serverA.url, path, json(first));
  respond(serverA.url, path + '&cursor=' + encodeURIComponent(first.nextCursor!), async () => { try { return json(await demo.activity({ cursor: first.nextCursor! })); } catch (error) { const e = error as { code: string; status: number }; return json({ error: { code: e.code } }, e.status); } });
  fireEvent.press(view.getByText('ACTUALIZAR ACTIVIDAD')); await view.findByText('CARGAR MÁS · SERVIDOR A'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await view.findByText('La consulta de Actividad caducó. Actualiza para continuar.'); expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  expect(requests.filter(r => r.path === path)).toHaveLength(2);
});

test('real demo partial/offline keeps the available Server and labels the missing reading independently', async () => {
  resetDemo(); setDemoConnection('homelab', 'compatible'); setDemoActivityScenario('atlas', 'partial'); setDemoActivityScenario('homelab', 'partial');
  const available = createDemoClient('atlas', () => clockStart); const offline = createDemoClient('homelab', () => clockStart);
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]);
  respond(serverA.url, path, async () => json(await available.activity()));
  respond(serverB.url, path, async () => { await offline.activity(); return json(page([])); });
  const view = mount(); await view.findByText('SOLICITADO'); await view.findByText('Sin conexión. No hay una lectura de Actividad en memoria.');
  expect(view.getByText('RECHAZADO')).toBeVisible(); expect(view.getByText('INCIERTO')).toBeVisible();
});


test('failed audit outcome does not claim that the operation had no effects', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([{ ...event, result: 'failed' }])));
  const view = mount(); await view.findByText('NO CONFIRMADO'); fireEvent.press(view.getByLabelText('Ejecución de tarea, NO CONFIRMADO'));
  expect(view.getByText('El resultado quedó sin confirmar; el cambio pudo tener efectos.')).toBeVisible(); expect(view.queryByText('FALLÓ')).toBeNull();
});


test('cursor cycle is visible and permanently retires pagination instead of silently retaining a dead button', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'cycle-1')));
  respond(serverA.url, path + '&cursor=cycle-1', json(page([{ ...event, id: 'cycle-event-2', action: 'run.steer', category: 'conversations', result: 'accepted' }], 'cycle-2')));
  respond(serverA.url, path + '&cursor=cycle-2', json(page([{ ...event, id: 'cycle-event-3', action: 'job.delete', result: 'requested' }], 'cycle-1')));
  const view = mount(); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A')); await view.findByText('ACEPTADO');
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A')); await view.findByText('La consulta de Actividad caducó. Actualiza para continuar.');
  expect(view.queryByText('Eliminación de tarea')).toBeNull(); expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
});


test('Activity protocol rejection purges cached metadata even when the last health was compatible', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'endpoint-protocol')));
  respond(serverA.url, path + '&cursor=endpoint-protocol', json({ error: { code: 'protocol_upgrade_required', message: 'hidden-version-detail' } }, 426));
  let toggle!: (value: boolean) => void;
  function Remount() { const [mounted, setMounted] = useState(true); toggle = setMounted; return <ChatVisibilityProvider value>{mounted ? <ActivityScreen/> : null}</ChatVisibilityProvider>; }
  const view = renderApp(<Remount/>); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await view.findByText('Actualiza Relay para consultar Actividad.'); expect(view.queryByText('SOLICITADO')).toBeNull(); expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  act(() => toggle(false)); act(() => toggle(true)); await view.findByText('Actualiza Relay para consultar Actividad.');
  fireEvent.press(view.getByText('ACTUALIZAR ACTIVIDAD')); await act(async () => {});
  expect(requests.filter(r => r.path === path)).toHaveLength(1); expect(view.queryByText('hidden-version-detail')).toBeNull();
});


test('new Personality and Avisos events render honest outcomes and preset rows never open a Conversation', async () => {
  resetDemo(); setDemoActivityScenario('atlas', 'composition');
  const demo = createDemoClient('atlas', () => clockStart);
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, path, async () => json(await demo.activity()));
  respond(serverA.url, path + '&category=configuration', async () => json(await demo.activity({ category: 'configuration' })));
  respond(serverA.url, path + '&category=conversations', async () => json(await demo.activity({ category: 'conversations' })));
  respond(serverA.url, path + '&category=server', async () => json(await demo.activity({ category: 'server' })));
  const view = mount(); await view.findByText('10 REGISTROS');
  expect(view.getAllByText('SOLICITADO')).toHaveLength(5);
  expect(view.getAllByText('CONFIRMADO')).toHaveLength(3);
  expect(view.getAllByText('REGISTRADO')).toHaveLength(2);
  for (const label of ['Creación de preset de personalidad', 'Edición de preset de personalidad', 'Eliminación de preset de personalidad', 'Aplicación de personalidad a SOUL.md']) expect(view.getAllByText(label)).toHaveLength(2);
  expect(view.getByText('Inscripción de Avisos')).toBeVisible();
  fireEvent.press(view.getByLabelText('Creación de preset de personalidad, SOLICITADO'));
  expect(view.getByText('Solicitud registrada; no confirma que se haya aplicado.')).toBeVisible();
  expect(view.queryByText('ABRIR CONVERSACIÓN ›')).toBeNull();
  fireEvent.press(view.getByText('ADMINISTRAR SERVIDOR ›'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/server/[server]', params: { server: serverA.id } });
  fireEvent.press(view.getByText('CONFIGURACIÓN')); await view.findByText('8 REGISTROS');
  expect(view.queryByText('Inscripción de Avisos')).toBeNull(); expect(view.queryByText('Elección de personalidad de Conversación')).toBeNull();
  fireEvent.press(view.getByText('CONVERSACIONES')); await view.findByText('1 REGISTROS');
  expect(view.getByText('REGISTRADO')).toBeVisible(); expect(view.queryByText('CONFIRMADO')).toBeNull();
  fireEvent.press(view.getByLabelText('Elección de personalidad de Conversación, REGISTRADO'));
  fireEvent.press(view.getByText('ABRIR CONVERSACIÓN ›'));
  expect(router.push).toHaveBeenLastCalledWith({ pathname: '/chat/[server]/[agent]', params: { server: serverA.id, agent: 'dev', conversationId: 'demo-conv-atlas-dev' } });
  fireEvent.press(view.getByText('SERVIDOR')); await view.findByText('Inscripción de Avisos');
  expect(view.getByText('SOLICITADO')).toBeVisible(); expect(view.queryByText('REGISTRADO')).toBeNull(); expect(view.queryByText('CONFIRMADO')).toBeNull();
  expect(requests.filter(r => r.path.startsWith('/v1/activity')).map(r => r.path)).toEqual([path, path + '&category=configuration', path + '&category=conversations', path + '&category=server']);
});
