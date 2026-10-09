import { useState } from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { JobsScreen, JobDetailScreen } from '@/screens/JobsScreen';
import { LockGate } from '@/screens/LockGate';
import { AppState } from 'react-native';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA, polling, seed, serverA, serverB } from '../support/fixtures';
import { biometrics, deferred, emitAppState, navigation, router } from '../support/native';
import { json, requests, respond } from '../support/transport';
import { drag, hold } from '../support/gestures';
const job = { id: 'abcdef123456', agentId: agentA.id, name: 'Resumen diario', prompt: 'Revisa los PRs', schedule: '0 9 * * 1-5', deliver: 'local', skills: [], repeat: null, enabled: false, state: 'paused', timezone: 'America/Mexico_City', nextRunAt: null, lastStatus: null, model: 'modelo fijo', workdir: '/fixture', script: 'script.py' };
const route = `/v1/agents/${agentA.id}/jobs/${job.id}`;
function setup() { seed(); polling(serverA, [agentA]); respond(serverA.url, route, json(job)); respond(serverA.url, route + '/history?offset=0', json({ executions: [], hasMore: false })); respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ agentId: agentA.id, timezone: job.timezone, jobs: [job] })); }
function detail(visible = true) {
  return <ChatVisibilityProvider value={visible}>
  <JobDetailScreen serverId="A" agentId={agentA.id} jobId={job.id}/>
  </ChatVisibilityProvider>;
}
test('resume and each run require strong huella without PIN while pause stays free, with exact agent scope', async () => {
  setup();
  respond(serverA.url, route + '/resume', json({ ...job, enabled: true }), 'POST');
  respond(serverA.url, route + '/pause', json(job), 'POST');
  respond(serverA.url, route + '/run', json({ ...job, enabled: true }), 'POST');
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  respond(serverA.url, route, json({ ...job, enabled: true }));
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Reanudar'));
  await waitFor(() => expect(requests.some(r => r.path === route + '/resume')).toBe(true));
  expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  expect(view.getByText('Ejecutar ahora pide huella: Hermes puede reanudar la tarea.')).toBeVisible();
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  act(() => {
    fireEvent.press(view.getByText('Ejecutar ahora'));
    fireEvent.press(view.getByText('Ejecutar ahora'));
  });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  expect(requests.filter(r => r.path === route + '/run')).toHaveLength(0);
  expect(biometrics.authenticateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  await act(async () => auth.resolve({ success: true }));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/run')).toHaveLength(1));
  expect(requests.find(r => r.path === route + '/run')).toMatchObject({ origin: serverA.url, method: 'POST', body: {} });
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/run')).toHaveLength(2));
  fireEvent.press(view.getByText('Pausar'));
  await waitFor(() => expect(requests.some(r => r.path === route + '/pause')).toBe(true));
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(3);
});
test.each(['resume', 'run'].flatMap(action => ['blur', 'lock', 'background', 'expiry', 'revocation', 'profile'].map(kind => [action, kind])))('late %s huella after %s sends nothing', async (action, kind) => {
  setup();
  if (action === 'run') respond(serverA.url, route, json({ ...job, enabled: true }));
  respond(serverA.url, route + '/' + action, json({ ...job, enabled: true }), 'POST');
  let redraw!: () => void;
  let setVisible!: (visible: boolean) => void;
  let switchAgent!: () => void;
  function Controlled() {
    const [agent, setAgent] = useState(agentA.id);
    switchAgent = () => setAgent('other');
    const [visible, updateVisible] = useState(true);
    setVisible = updateVisible;
    const [, tick] = useState(0);
    redraw = () => tick(n => n + 1);
    return <ChatVisibilityProvider value={visible}>
    <JobDetailScreen serverId="A" agentId={agent} jobId={job.id}/>
    </ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  let resolve!: (v: {
    success: boolean;
  }) => void;
  biometrics.authenticateAsync.mockImplementation(() => new Promise(r => { resolve = r; }));
  fireEvent.press(view.getByText(action === 'run' ? 'Ejecutar ahora' : 'Reanudar'));
  await waitFor(() => expect(resolve).toBeDefined());
  if (kind === 'blur') {
    navigation.focused = false;
    act(() => redraw());
  }
  if (kind === 'lock') {
    act(() => setVisible(false));
    act(() => setVisible(true));
  }
  if (kind === 'profile') {
    respond(serverA.url, '/v1/agents/other/jobs/' + job.id, json({ ...job, agentId: 'other' }));
    respond(serverA.url, '/v1/agents/other/jobs/' + job.id + '/history?offset=0', json({ executions: [], hasMore: false }));
    act(() => switchAgent());
  }
  if (kind === 'background') {
    act(() => emitAppState('background'));
    act(() => emitAppState('active'));
  }
  if (kind === 'expiry')
    act(() => jest.advanceTimersByTime(60000));
  if (kind === 'revocation') {
    respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'Revocado' } }, 403));
    await act(async () => { view.probe.current!.refresh(); });
    await waitFor(() => expect(view.probe.current!.snapshot('A').reachable).toBe(false));
  }
  await act(async () => resolve({ success: true }));
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});
test('list shows paused jobs and form saves only visible editable fields after huella', async () => {
  setup();
  respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json(job), 'POST');
  const view = renderApp(<ChatVisibilityProvider value>
  <JobsScreen serverId="A"/>
  </ChatVisibilityProvider>);
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByLabelText('Nueva tarea'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Nueva');
  fireEvent.changeText(view.getByLabelText('Instrucción'), 'Revisar');
  fireEvent.changeText(view.getByLabelText('Horario'), 'every 30m');
  biometrics.authenticateAsync.mockResolvedValue({ success: false });
  fireEvent.press(view.getByText('Crear con huella'));
  await view.findByText('No se confirmó la huella.');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Crear con huella'));
  await waitFor(() => expect(requests.some(r => r.method === 'POST')).toBe(true));
  expect(requests.find(r => r.method === 'POST')!.body).toEqual({ name: 'Nueva', prompt: 'Revisar', schedule: 'every 30m', deliver: 'local', skills: [], repeat: null });
});
test('editing asks for huella and sends no model, directory or script; deletion asks for confirmation', async () => {
  setup();
  respond(serverA.url, route, json({ ...job, name: 'Actualizada' }), 'PATCH');
  respond(serverA.url, route, json({ ok: true }), 'DELETE');
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByText('Editar'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Actualizada');
  biometrics.authenticateAsync.mockResolvedValue({ success: false });
  fireEvent.press(view.getByText('Guardar con huella'));
  await view.findByText('No se confirmó la huella.');
  expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(0);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Guardar con huella'));
  await view.findByText('Actualizada');
  expect(requests.find(r => r.method === 'PATCH')!.body).toEqual({ name: 'Actualizada', prompt: job.prompt, schedule: job.schedule, deliver: 'local', skills: [], repeat: null });
  fireEvent.press(view.getByText('Borrar'));
  expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
  fireEvent.press(view.getByText('Confirmar borrado'));
  await waitFor(() => expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1));
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
});
test('history presents all ledger statuses and delivery separately from completion', async () => {
  setup();
  respond(serverA.url, route + '/history?offset=0', json({ hasMore: false, executions: ['claimed', 'running', 'completed', 'failed', 'unknown'].map((status, i) => ({ id: String(i), status, claimedAt: '2026-11-01T06:05:00Z', startedAt: null, finishedAt: null, deliveryOutcome: status === 'completed' ? 'failed' : null, scheduledInstant: null })) }));
  const view = renderApp(detail());
  await view.findByText(/RECLAMADA/);
  for (const label of ['EN CURSO', 'COMPLETADA', 'FALLÓ', 'DESCONOCIDO'])
    expect(view.getByText(new RegExp(label))).toBeTruthy();
  expect(view.getByText('Entrega: falló')).toBeTruthy();
});


test('a late resume response cannot replace the new Agente task', async () => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route + '/resume', pending.promise, 'POST');
  const other = { ...job, agentId: 'other', name: 'Tarea del otro Agente', enabled: false };
  respond(serverA.url, '/v1/agents/other/jobs/' + job.id, json(other));
  respond(serverA.url, '/v1/agents/other/jobs/' + job.id + '/history?offset=0', json({ executions: [], hasMore: false }));
  let changeScope!: () => void;
  function Controlled() {
    const [agent, setAgent] = useState(agentA.id);
    changeScope = () => setAgent('other');
    return <ChatVisibilityProvider value><JobDetailScreen serverId="A" agentId={agent} jobId={job.id}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Reanudar'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/resume')).toHaveLength(1));
  act(() => changeScope());
  await view.findByText('Tarea del otro Agente');
  await act(async () => pending.resolve(json({ ...job, name: 'Respuesta del Agente anterior', enabled: true })));
  expect(view.getByText('Tarea del otro Agente')).toBeVisible();
  expect(view.queryByText('Respuesta del Agente anterior')).toBeNull();
  expect(view.getByText('Reanudar')).toBeVisible();
});


function execution(index: number) {
  return { id: `execution-${index}`, status: 'completed', claimedAt: '2026-10-03T12:00:00Z', startedAt: null, finishedAt: null, deliveryOutcome: `registro-${index}`, scheduledInstant: null };
}
test('double load-more before ACK requests one exact page and skips no executions', async () => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route + '/history?offset=0', json({ executions: Array.from({ length: 50 }, (_, i) => execution(i + 1)), hasMore: true }));
  respond(serverA.url, route + '/history?offset=50', pending.promise);
  respond(serverA.url, route + '/history?offset=100', json({ executions: Array.from({ length: 50 }, (_, i) => execution(i + 101)), hasMore: false }));
  const view = renderApp(detail());
  await view.findByText('Entrega: registro-50');
  act(() => {
    fireEvent.press(view.getByText('Cargar más historial'));
    fireEvent.press(view.getByText('Cargar más historial'));
  });
  expect(requests.filter(r => r.path === route + '/history?offset=50')).toHaveLength(1);
  await act(async () => pending.resolve(json({ executions: Array.from({ length: 50 }, (_, i) => execution(i + 51)), hasMore: true })));
  expect(view.getAllByText(/^Entrega: registro-/)).toHaveLength(100);
  fireEvent.press(view.getByText('Cargar más historial'));
  await view.findByText('Entrega: registro-150');
  expect(requests.filter(r => r.path.startsWith(route + '/history')).map(r => r.path)).toEqual([
    route + '/history?offset=0', route + '/history?offset=50', route + '/history?offset=100',
  ]);
  expect(view.getAllByText(/^Entrega: registro-/)).toHaveLength(150);
  for (let i = 1; i <= 150; i++) expect(view.getAllByText(`Entrega: registro-${i}`)).toHaveLength(1);
  expect(view.queryByText('Cargar más historial')).toBeNull();
});


test('a late history page cannot append to the new task history', async () => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route + '/history?offset=0', json({ executions: [execution(1)], hasMore: true }));
  respond(serverA.url, route + '/history?offset=1', pending.promise);
  const otherId = 'abcdef123457';
  respond(serverA.url, `/v1/agents/${agentA.id}/jobs/${otherId}`, json({ ...job, id: otherId, name: 'Otra tarea' }));
  respond(serverA.url, `/v1/agents/${agentA.id}/jobs/${otherId}/history?offset=0`, json({ executions: [execution(1000)], hasMore: false }));
  let changeScope!: () => void;
  function Controlled() {
    const [id, setId] = useState(job.id);
    changeScope = () => setId(otherId);
    return <ChatVisibilityProvider value><JobDetailScreen serverId="A" agentId={agentA.id} jobId={id}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Entrega: registro-1');
  fireEvent.press(view.getByText('Cargar más historial'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/history?offset=1')).toHaveLength(1));
  act(() => changeScope());
  await view.findByText('Entrega: registro-1000');
  await act(async () => pending.resolve(json({ executions: [execution(2)], hasMore: false })));
  expect(view.getAllByText(/^Entrega: registro-/)).toHaveLength(1);
  expect(view.getByText('Entrega: registro-1000')).toBeVisible();
  expect(view.queryByText('Entrega: registro-2')).toBeNull();
});


test.each(['agent', 'job', 'server', 'client'] as const)('a late edit response preserves the current draft after changing %s scope', async kind => {
  setup();
  if (kind === 'server') seed([serverA, serverB]);
  polling(serverB, [agentA]);
  const pendingEdit = deferred<Response>();
  const pendingDetail = deferred<Response>();
  respond(serverA.url, route, pendingEdit.promise, 'PATCH');
  const targetAgent = kind === 'agent' ? 'other' : agentA.id;
  const targetJob = kind === 'job' ? 'abcdef123457' : job.id;
  const targetOrigin = kind === 'server' || kind === 'client' ? serverB.url : serverA.url;
  const targetPath = `/v1/agents/${targetAgent}/jobs/${targetJob}`;
  respond(targetOrigin, targetPath, pendingDetail.promise);
  respond(targetOrigin, targetPath + '/history?offset=0', json({ executions: [], hasMore: false }));
  let changeScope!: () => void;
  function Controlled() {
    const [scope, setScope] = useState({ server: 'A', agent: agentA.id, job: job.id });
    changeScope = () => setScope({ server: kind === 'server' ? 'B' : 'A', agent: targetAgent, job: targetJob });
    return <ChatVisibilityProvider value><JobDetailScreen serverId={scope.server} agentId={scope.agent} jobId={scope.job}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByText('Editar'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Edición anterior');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Guardar con huella'));
  await waitFor(() => expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(1));
  if (kind === 'client') await act(async () => { await view.probe.current!.replaceServer('A', serverB); });
  else act(() => changeScope());
  expect(view.queryByText('Resumen diario')).toBeNull();
  await act(async () => pendingDetail.resolve(json({ ...job, agentId: targetAgent, id: targetJob, name: 'Tarea actual' })));
  await view.findByText('Tarea actual');
  fireEvent.press(view.getByText('Editar'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Borrador actual');
  await act(async () => pendingEdit.resolve(json({ ...job, name: 'Respuesta antigua de edición' })));
  expect(view.queryByText('Respuesta antigua de edición')).toBeNull();
  expect(view.getByLabelText('Nombre').props.value).toBe('Borrador actual');
  expect(view.getByText('Guardar con huella')).toBeVisible();
});


test.each(['success', 'revoked-response'] as const)('a late resume %s after revocation changes neither data nor notices', async outcome => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route + '/resume', pending.promise, 'POST');
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Reanudar'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/resume')).toHaveLength(1));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'Revocado' } }, 403));
  await act(async () => view.probe.current!.refresh());
  await waitFor(() => expect(view.probe.current!.snapshot('A').reachable).toBe(false));
  await act(async () => pending.resolve(outcome === 'success' ? json({ ...job, enabled: true, name: 'Respuesta tras revocación' })
    : json({ error: { code: 'device_revoked', message: 'Revocado' } }, 403)));
  expect(view.getByText('Resumen diario')).toBeVisible();
  expect(view.getByText('Reanudar')).toBeVisible();
  expect(view.queryByText('Respuesta tras revocación')).toBeNull();
  expect(view.queryByText(/No se pudo confirmar la operación/)).toBeNull();
});

test('a late run response after locking cannot publish data or a success notice', async () => {
  setup();
  respond(serverA.url, route, json({ ...job, enabled: true }));
  const pending = deferred<Response>();
  respond(serverA.url, route + '/run', pending.promise, 'POST');
  let lock!: () => void;
  function Controlled() {
    const [visible, setVisible] = useState(true);
    lock = () => setVisible(false);
    return <ChatVisibilityProvider value={visible}><JobDetailScreen serverId="A" agentId={agentA.id} jobId={job.id}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/run')).toHaveLength(1));
  act(() => lock());
  await act(async () => pending.resolve(json({ ...job, enabled: true, name: 'Respuesta oculta' })));
  expect(view.getByText('Resumen diario')).toBeVisible();
  expect(view.queryByText('Respuesta oculta')).toBeNull();
  expect(view.queryByText(/Hermes aceptó ejecutar/)).toBeNull();
});

test('a late deletion response after blur cannot navigate', async () => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route, pending.promise, 'DELETE');
  let redraw!: () => void;
  function Controlled() {
    const [, tick] = useState(0);
    redraw = () => tick(n => n + 1);
    return detail();
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByText('Borrar'));
  fireEvent.press(view.getByText('Confirmar borrado'));
  await waitFor(() => expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1));
  navigation.focused = false;
  act(() => redraw());
  await act(async () => pending.resolve(json({ ok: true })));
  expect(router.back).not.toHaveBeenCalled();
});

test('a late edit response after background cannot dismiss the current editor', async () => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route, pending.promise, 'PATCH');
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByText('Editar'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Borrador pendiente');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Guardar con huella'));
  await waitFor(() => expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(1));
  act(() => emitAppState('background'));
  await act(async () => pending.resolve(json({ ...job, name: 'Respuesta en segundo plano' })));
  expect(view.getByLabelText('Nombre').props.value).toBe('Borrador pendiente');
  expect(view.getByText('Guardar con huella')).toBeVisible();
  expect(view.queryByText('Respuesta en segundo plano')).toBeNull();
});

test.each(['success', 'failure'] as const)('a late history %s after revocation changes neither the page nor notices', async outcome => {
  setup();
  const pending = deferred<Response>();
  respond(serverA.url, route + '/history?offset=0', json({ executions: [execution(1)], hasMore: true }));
  respond(serverA.url, route + '/history?offset=1', pending.promise);
  const view = renderApp(detail());
  await view.findByText('Entrega: registro-1');
  fireEvent.press(view.getByText('Cargar más historial'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/history?offset=1')).toHaveLength(1));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'Revocado' } }, 403));
  await act(async () => view.probe.current!.refresh());
  await waitFor(() => expect(view.probe.current!.snapshot('A').reachable).toBe(false));
  await act(async () => pending.resolve(outcome === 'success' ? json({ executions: [execution(2)], hasMore: false })
    : json({ error: { code: 'device_revoked', message: 'Revocado' } }, 403)));
  expect(view.getAllByText(/^Entrega: registro-/)).toHaveLength(1);
  expect(view.queryByText('Entrega: registro-2')).toBeNull();
  expect(view.queryByText('No se pudo cargar más historial. Reintenta.')).toBeNull();
});


test('an old response stays invalid after the screen locks and becomes visible again', async () => {
  setup();
  respond(serverA.url, route, json({ ...job, enabled: true }));
  const pending = deferred<Response>();
  respond(serverA.url, route + '/run', pending.promise, 'POST');
  let setVisible!: (visible: boolean) => void;
  function Controlled() {
    const [visible, update] = useState(true);
    setVisible = update;
    return <ChatVisibilityProvider value={visible}><JobDetailScreen serverId="A" agentId={agentA.id} jobId={job.id}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await waitFor(() => expect(requests.filter(r => r.path === route + '/run')).toHaveLength(1));
  act(() => setVisible(false));
  act(() => setVisible(true));
  await act(async () => pending.resolve(json({ ...job, enabled: true, name: 'Respuesta de la epoch anterior' })));
  expect(view.getByText('Resumen diario')).toBeVisible();
  expect(view.queryByText('Respuesta de la epoch anterior')).toBeNull();
  expect(view.queryByText(/Hermes aceptó ejecutar/)).toBeNull();
});

test('a late create response cannot close the form after choosing another Agente', async () => {
  setup();
  const other = { ...agentA, id: 'other', name: 'Otro Agente' };
  polling(serverA, [agentA, other]);
  respond(serverA.url, '/v1/agents/other/jobs', json({ agentId: 'other', timezone: job.timezone, jobs: [] }));
  const pending = deferred<Response>();
  respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, pending.promise, 'POST');
  const view = renderApp(<ChatVisibilityProvider value><JobsScreen serverId="A"/></ChatVisibilityProvider>);
  await view.findByText('Resumen diario');
  fireEvent.press(view.getByLabelText('Nueva tarea'));
  fireEvent.changeText(view.getByLabelText('Nombre'), 'Borrador de tarea');
  fireEvent.changeText(view.getByLabelText('Instrucción'), 'Revisar');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  fireEvent.press(view.getByText('Crear con huella'));
  await waitFor(() => expect(requests.filter(r => r.method === 'POST')).toHaveLength(1));
  fireEvent.press(view.getByText('Otro Agente'));
  await act(async () => pending.resolve(json({ ...job, enabled: true })));
  expect(view.getByLabelText('Nombre').props.value).toBe('Borrador de tarea');
  expect(view.getByText('Crear con huella')).toBeVisible();
  expect(requests.filter(r => r.method === 'POST').map(r => r.path)).toEqual([`/v1/agents/${agentA.id}/jobs`]);
});


test.each(['cancel', 'hardware', 'enrollment', 'reject'] as const)('run without successful strong huella after %s sends nothing', async failure => {
  setup();
  respond(serverA.url, route, json({ ...job, enabled: true }));
  respond(serverA.url, route + '/run', json({ ...job, enabled: true }), 'POST');
  if (failure === 'hardware') biometrics.hasHardwareAsync.mockResolvedValue(false);
  if (failure === 'enrollment') biometrics.isEnrolledAsync.mockResolvedValue(false);
  if (failure === 'reject') biometrics.authenticateAsync.mockRejectedValue(new Error('Synthetic authentication failure'));
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  await act(async () => { fireEvent.press(view.getByText('Ejecutar ahora')); });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  await view.findByText('No se confirmó la huella.');
  if (failure === 'hardware' || failure === 'enrollment') expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  else expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
});

test('a paused task stays disabled without prompting or running', async () => {
  setup();
  respond(serverA.url, route + '/run', json({ ...job, enabled: true }), 'POST');
  const view = renderApp(detail());
  await view.findByText('Resumen diario');
  expect(view.getByText('Ejecutar ahora')).toBeDisabled();
  expect(view.getByText('Hermes reanuda al ejecutar: reanuda primero con huella.')).toBeVisible();
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await act(async () => {});
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});

test.each(['locked', 'unlocked'] as const)('idle LockGate invalidates pending run huella resolved while %s before authorization expiry', async finish => {
  setup();
  respond(serverA.url, route, json({ ...job, enabled: true }));
  respond(serverA.url, route + '/run', json({ ...job, enabled: true }), 'POST');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  const view = renderApp(<LockGate><JobDetailScreen serverId="A" agentId={agentA.id} jobId={job.id}/></LockGate>);
  await view.findByText('Resumen diario');
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  expect(AppState.currentState).toBe('active');
  expect(view.getByText('Relay está bloqueado')).toBeVisible();
  expect(view.getByText('Resumen diario', { includeHiddenElements: true })).not.toBeVisible();
  if (finish === 'unlocked') {
    fireEvent.press(view.getByText('Usar el código del teléfono'));
    await waitFor(() => expect(view.getByText('Resumen diario')).toBeVisible());
    expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(3);
  }
  await act(async () => auth.resolve({ success: true }));
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});

test.each(['agent', 'job', 'server', 'origin', 'key', 'device'] as const)('late run huella cannot run either task after changing %s scope', async kind => {
  setup();
  seed([serverA, serverB]);
  polling(serverB, [agentA]);
  respond(serverA.url, route, json({ ...job, enabled: true }));
  respond(serverA.url, route + '/run', json({ ...job, enabled: true }), 'POST');
  const targetAgent = kind === 'agent' ? 'other' : agentA.id;
  const targetJob = kind === 'job' ? 'abcdef123457' : job.id;
  const targetOrigin = kind === 'server' || kind === 'origin' ? serverB.url : serverA.url;
  const targetPath = `/v1/agents/${targetAgent}/jobs/${targetJob}`;
  // Keep the current response until after authentication has started when its URL is unchanged.
  let changeScope!: () => void;
  function Controlled() {
    const [scope, setScope] = useState({ server: 'A', agent: agentA.id, job: job.id });
    changeScope = () => setScope({ server: kind === 'server' ? 'B' : 'A', agent: targetAgent, job: targetJob });
    return <ChatVisibilityProvider value><JobDetailScreen serverId={scope.server} agentId={scope.agent} jobId={scope.job}/></ChatVisibilityProvider>;
  }
  const view = renderApp(<Controlled />);
  await view.findByText('Resumen diario');
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  fireEvent.press(view.getByText('Ejecutar ahora'));
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  respond(targetOrigin, targetPath, json({ ...job, agentId: targetAgent, id: targetJob, name: 'Tarea actual', enabled: true }));
  respond(targetOrigin, targetPath + '/history?offset=0', json({ executions: [], hasMore: false }));
  respond(targetOrigin, targetPath + '/run', json({ ...job, enabled: true }), 'POST');
  if (kind === 'origin' || kind === 'key' || kind === 'device') {
    const replacement = { ...serverA, ...(kind === 'origin' ? { url: serverB.url } : kind === 'key' ? { key: 'replacement-fixture-key' } : { deviceId: 'replacement-fixture-device' }) };
    await act(async () => { await view.probe.current!.replaceServer('A', replacement); });
  } else act(() => changeScope());
  await view.findByText('Tarea actual');
  await act(async () => auth.resolve({ success: true }));
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});

describe('gestures of the Tareas list', () => {
  const active = { ...job, id: 'abcdef123457', name: 'Sincronizar métricas', enabled: true, state: 'scheduled', nextRunAt: Date.now() + 3_600_000, lastStatus: 'ok' };
  const row = (j: { id: string }) => `job-${agentA.id}-${j.id}`;
  const path = (j: { id: string }, action: string) => `/v1/agents/${agentA.id}/jobs/${j.id}/${action}`;
  function list() {
    seed(); polling(serverA, [agentA]);
    respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ agentId: agentA.id, timezone: job.timezone, jobs: [active, job] }));
    for (const j of [active, job]) for (const action of ['pause', 'resume', 'run']) respond(serverA.url, path(j, action), json(j), 'POST');
    return renderApp(<ChatVisibilityProvider value><JobsScreen serverId="A"/></ChatVisibilityProvider>);
  }
  const posts = (suffix?: string) => requests.filter(r => r.method === 'POST' && (!suffix || r.path.endsWith(suffix)));
  test('a swipe to the right pauses an active Tarea, and resumes a paused one with huella', async () => {
    const view = list();
    await view.findByText('Sincronizar métricas');
    drag(row(active), [{ x: 120 }]);
    await waitFor(() => expect(posts('/pause')).toHaveLength(1));
    expect(posts('/pause')[0].path).toBe(path(active, 'pause'));
    expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
    biometrics.authenticateAsync.mockResolvedValue({ success: true });
    drag(row(job), [{ x: 120 }]);
    await waitFor(() => expect(posts('/resume')).toHaveLength(1));
    expect(posts('/resume')[0].path).toBe(path(job, 'resume'));
    expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  });
  test('a swipe to the left asks before running, and only confirming sends it', async () => {
    const view = list();
    biometrics.authenticateAsync.mockResolvedValue({ success: true });
    await view.findByText('Sincronizar métricas');
    drag(row(active), [{ x: -120 }]);
    await view.findByText('¿Ejecutar ahora?');
    expect(posts()).toHaveLength(0);
    fireEvent.press(view.getByText('Cancelar'));
    act(() => { jest.advanceTimersByTime(400); });
    expect(view.queryByText('¿Ejecutar ahora?')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
    drag(row(active), [{ x: -120 }]);
    await view.findByText('¿Ejecutar ahora?');
    fireEvent.press(await view.findByText('Ejecutar ahora'));
    await waitFor(() => expect(posts('/run')).toHaveLength(1));
    expect(posts('/run')[0].path).toBe(path(active, 'run'));
    expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  });
  test('a swipe short of 90 px does nothing', async () => {
    const view = list();
    await view.findByText('Sincronizar métricas');
    drag(row(active), [{ x: 89 }]);
    drag(row(active), [{ x: -89 }]);
    await act(async () => {});
    expect(posts()).toHaveLength(0);
    expect(view.queryByText('¿Ejecutar ahora?')).toBeNull();
  });
  test('pulling 60 px reloads the list', async () => {
    const view = list();
    await view.findByText('Sincronizar métricas');
    const loads = () => requests.filter(r => r.method === 'GET' && r.path === `/v1/agents/${agentA.id}/jobs`).length;
    const before = loads();
    const finger = hold('pull-to-refresh', [{ y: 120 }]);
    finger.release();
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await waitFor(() => expect(view.queryByText('CARGANDO…')).toBeNull());
    await act(async () => { jest.advanceTimersByTime(400); });
  });
  test('a list that fails to load shows the error state, and «Reintentar» loads it again', async () => {
    seed(); polling(serverA, [agentA]);
    respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ error: { code: 'x', message: 'x' } }, 500));
    const view = renderApp(<ChatVisibilityProvider value><JobsScreen serverId="A"/></ChatVisibilityProvider>);
    await view.findByText(`No se pudo cargar las tareas de ${agentA.id}. Reintenta.`);
    respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ agentId: agentA.id, timezone: job.timezone, jobs: [active, job] }));
    fireEvent.press(view.getByText('Reintentar'));
    await view.findByText('Sincronizar métricas');
    expect(view.queryByText('Reintentar')).toBeNull();
  });
  test('a failed write keeps the safe text and offers «Reintentar», which reloads the list', async () => {
    const view = list();
    respond(serverA.url, path(active, 'pause'), json({ error: { code: 'x', message: 'SECRETO' } }, 500), 'POST');
    await view.findByText('Sincronizar métricas');
    drag(row(active), [{ x: 120 }]);
    await view.findByText(/puede haberse aplicado/);
    expect(view.queryByText(/SECRETO/)).toBeNull();
    const loads = () => requests.filter(r => r.method === 'GET' && r.path === `/v1/agents/${agentA.id}/jobs`).length;
    const before = loads();
    fireEvent.press(view.getByText('Reintentar'));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
  });
  test('an active Tarea with no Servidor zone shows «?» and says why, unlike a paused one', async () => {
    seed(); polling(serverA, [agentA]);
    respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ agentId: agentA.id, timezone: null, jobs: [{ ...active, timezone: null }, job] }));
    const view = renderApp(<ChatVisibilityProvider value><JobsScreen serverId="A"/></ChatVisibilityProvider>);
    await view.findByText('Sincronizar métricas');
    expect(view.getByText('?')).toBeVisible();
    expect(view.getByText(/ZONA NO DISPONIBLE/)).toBeVisible();
    expect(view.getByText('—')).toBeVisible();
  });
  test('the running Tarea rises to the command block, each row shows its window', async () => {
    const running = { ...active, state: 'running' };
    seed(); polling(serverA, [agentA]);
    respond(serverA.url, `/v1/agents/${agentA.id}/jobs`, json({ agentId: agentA.id, timezone: job.timezone, jobs: [running, job] }));
    const view = renderApp(<ChatVisibilityProvider value><JobsScreen serverId="A"/></ChatVisibilityProvider>);
    await view.findByText('EJECUTÁNDOSE');
    expect(view.getByText('Sincronizar métricas')).toBeVisible();
    expect(view.getByText('—')).toBeVisible();
  });
});
