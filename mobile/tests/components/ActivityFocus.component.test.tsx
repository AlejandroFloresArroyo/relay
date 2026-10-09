import { Profiler } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import type { ActivityItem } from '../../../protocol/activity';
import { ActivityScreen } from '@/screens/ActivityScreen';
import { LockGate } from '@/screens/LockGate';
import { renderApp } from '../support/renderApp';
import { agentA, polling, seed, serverA } from '../support/fixtures';
import { json, networkError, requests, respond } from '../support/transport';
import { biometrics, clockStart, deferred, emitAppBlur, emitAppFocus, emitAppState, router } from '../support/native';

const path = '/v1/activity?limit=50';
const event: ActivityItem = { id: 'initial', at: clockStart, actor: { kind: 'device', id: serverA.deviceId! }, action: 'job.run', category: 'tasks', result: 'requested', scope: { kind: 'agent', agentId: agentA.id }, conversationId: null };
const page = (items: ActivityItem[] = [event], nextCursor: string | null = null) => ({ items, nextCursor, capturedAt: clockStart });
const mount = () => renderApp(<LockGate><ActivityScreen/></LockGate>);

// Android window focus is independent of both AppState changes and route focus.
test('Android blur hides the real Activity feed and permanently retires its deferred page', async () => {
  seed(); polling(serverA, [agentA]); biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, path, json(page([event], 'old-cursor')));
  const old = deferred<Response>(); respond(serverA.url, path + '&cursor=old-cursor', old.promise);
  const view = mount(); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=old-cursor'))).toHaveLength(1));
  act(() => emitAppBlur());
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  expect(view.queryByText('CARGANDO…', { includeHiddenElements: true })).toBeNull();
  act(() => emitAppState('active'));
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  await act(async () => old.resolve(json(page([{ ...event, id: 'retired-private', action: 'agent.soul.edit', category: 'configuration', result: 'succeeded' }], 'retired-cursor'))));
  expect(view.queryByText('Edición de personalidad', { includeHiddenElements: true })).toBeNull();
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  act(() => emitAppFocus());
  await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(2));
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  await act(async () => fresh.resolve(json(page([{ ...event, id: 'fresh', result: 'accepted' }]))));
  await view.findByText('ACEPTADO');
  expect(view.queryByText('Edición de personalidad', { includeHiddenElements: true })).toBeNull();
});

function retainedPress(node: ReactTestInstance): () => void {
  let button: ReactTestInstance | null = node;
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  expect(button).not.toBeNull();
  return button!.props.onPress;
}

test('gestures captured before Android blur cannot navigate, reload or reuse a cursor after returning', async () => {
  seed(); polling(serverA, [agentA]); biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, path, json(page([event], 'retired-gesture-cursor')));
  respond(serverA.url, path + '&cursor=retired-gesture-cursor', json(page([{ ...event, id: 'forbidden-cursor-reading' }])));
  const view = mount(); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  const navigate = retainedPress(view.getByText('VER AGENTE ›'));
  const more = retainedPress(view.getByText('CARGAR MÁS · SERVIDOR A'));
  const refresh = retainedPress(view.getByText('ACTUALIZAR · SERVIDOR A'));
  const select = retainedPress(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  const healthReads = requests.filter(r => r.path === '/health').length;
  act(() => {
    emitAppBlur();
    // Native gestures may finish before React commits the hidden surface.
    navigate(); more(); refresh(); select();
  });
  expect(router.push).not.toHaveBeenCalled();
  await act(async () => {});
  expect(requests.filter(r => r.path === path)).toHaveLength(1);
  expect(requests.filter(r => r.path === '/health')).toHaveLength(healthReads);
  expect(requests.filter(r => r.path.includes('&cursor='))).toHaveLength(0);
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  act(() => emitAppFocus());
  await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(2));
  await act(async () => fresh.resolve(json(page([{ ...event, id: 'fresh-gesture', result: 'accepted' }], 'fresh-gesture-cursor'))));
  await view.findByText('ACEPTADO');
  await act(async () => { navigate(); more(); refresh(); select(); });
  expect(router.push).not.toHaveBeenCalled();
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(2);
  expect(requests.filter(r => r.path === '/health')).toHaveLength(healthReads);
  fireEvent.press(view.getByLabelText('Ejecución de tarea, ACEPTADO'));
  fireEvent.press(view.getByText('VER AGENTE ›'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/agent/[server]/[agent]', params: { server: serverA.id, agent: agentA.id } });
});

test('batched Android blur and focus retire the cursor before the first commit and cannot revive a deferred page', async () => {
  seed(); polling(serverA, [agentA]); biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, path, json(page([event], 'batched-old-cursor')));
  const old = deferred<Response>(); respond(serverA.url, path + '&cursor=batched-old-cursor', old.promise);
  let view!: ReturnType<typeof renderApp>; let armed = false;
  const commits: { cursor: boolean; late: boolean }[] = [];
  view = renderApp(<Profiler id="android-window-focus" onRender={() => {
    if (armed && view) commits.push({ cursor: view.queryByText('CARGAR MÁS · SERVIDOR A') !== null || view.queryByText('CARGANDO…') !== null,
      late: view.queryByText('Edición de personalidad', { includeHiddenElements: true }) !== null });
  }}><LockGate><ActivityScreen/></LockGate></Profiler>);
  await view.findByText('SOLICITADO');
  fireEvent.press(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  const navigate = retainedPress(view.getByText('VER AGENTE ›'));
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=batched-old-cursor'))).toHaveLength(1));
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  armed = true;
  act(() => { emitAppBlur(); navigate(); emitAppFocus(); navigate(); });
  expect(router.push).not.toHaveBeenCalled();
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.some(commit => commit.cursor)).toBe(false);
  expect(view.queryByText('CARGANDO…')).toBeNull();
  await act(async () => old.resolve(json(page([{ ...event, id: 'batched-late-private', action: 'agent.soul.edit', category: 'configuration', result: 'succeeded' }], 'batched-late-cursor'))));
  await waitFor(() => expect(requests.filter(r => r.path === path)).toHaveLength(2));
  expect(commits.some(commit => commit.cursor || commit.late)).toBe(false);
  expect(view.queryByText('CONFIRMADO', { includeHiddenElements: true })).toBeNull();
  await act(async () => fresh.resolve(json(page([{ ...event, id: 'batched-fresh', result: 'accepted' }]))));
  await view.findByText('ACEPTADO');
  expect(commits.some(commit => commit.cursor || commit.late)).toBe(false);
});

test('returning to an offline Server keeps its dated last reading without restoring the cursor', async () => {
  seed(); polling(serverA, [agentA]); biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, path, json(page([event], 'offline-retired-cursor')));
  const view = mount(); await view.findByText('SOLICITADO');
  act(() => emitAppBlur());
  respond(serverA.url, '/health', () => networkError());
  await act(async () => { await view.probe.current!.refresh(serverA.id); });
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  act(() => emitAppFocus());
  await view.findByText('Sin conexión. Última lectura en memoria; solo lectura.');
  expect(view.getByText(/Fecha del Servidor · UTC .*ÚLTIMA LECTURA/)).toBeVisible();
  expect(view.getByText('SOLICITADO')).toBeVisible();
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(1);
  fireEvent.press(view.getByLabelText('Ejecución de tarea, SOLICITADO'));
  fireEvent.press(view.getByText('VER AGENTE ›'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/agent/[server]/[agent]', params: { server: serverA.id, agent: agentA.id } });
});
