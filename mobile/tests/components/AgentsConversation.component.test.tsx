import { StyleSheet } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ChatRunEvent } from '../../../protocol/protocol';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { ChatScreen } from '@/screens/ChatScreen';
import { ActivityCommand } from '@/screens/chat/ActivityPanel';
import { agentA, approval, conversationA, polling, seed, serverA, serverB, serverInfo } from '../support/fixtures';
import { LIGHT_PALETTE } from '@/theme/tokens';
import { drag, hold } from '../support/gestures';
import { animatedStyle } from '../support/motion';
import { deferred, navigation, resizeWindow, router, stackOf, tabsRoute } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond, streamFixture } from '../support/transport';

const deciding = { ...agentA, status: 'busy' as const, pendingApprovals: 1 };
const working = { ...agentA, id: 'agentB', name: 'Agente B', status: 'busy' as const };
const idle = { ...agentA, id: 'agentC', name: 'Agente C' };
const root = '/v1/agents/agentA';

function listSetup(agents = [deciding, working, idle], pending = true) {
  seed(); polling(serverA, agents);
  if (pending) respond(serverA.url, '/v1/approvals', json({ approvals: [approval().approval] }));
}

test('a pending Aprobación heads the list as a command block that opens it', async () => {
  listSetup();
  const app = renderApp(<AgentsScreen />); await app.ready();
  fireEvent.press(await screen.findByText('1 APROBACIÓN PENDIENTE'));
  expect(app.probe.current!.sheet?.approval.id).toBe('approval-A');
});

test('with nothing pending there is no command block', async () => {
  listSetup([idle], false);
  const app = renderApp(<AgentsScreen />); await app.ready();
  await screen.findByText('Agente C');
  expect(screen.queryByText(/APROBACI.N PENDIENTE/)).toBeNull();
});

test('each Agente\'s strip says its state by label, and an idle one has none; the voice box stays out of the list', async () => {
  listSetup();
  const app = renderApp(<AgentsScreen />); await app.ready();
  expect(await screen.findByLabelText('Agente A: espera una Decisión')).toBeVisible();
  expect(screen.getByLabelText('Agente B: trabajando')).toBeVisible();
  expect(screen.getByText('Agente C')).toBeVisible();
  expect(screen.queryByLabelText(/^Agente C:/)).toBeNull();
  expect(screen.queryByLabelText('Escribiendo')).toBeNull();
});

test.each([[false], [true]])('an Agente whose Turno runs with no Decisión waiting reads «está escribiendo…» (pane: %s)', async (pane) => {
  listSetup();
  const app = renderApp(<AgentsScreen pane={pane} />); await app.ready();
  await screen.findByLabelText('Agente B: trabajando');
  expect(screen.getAllByText('está escribiendo…')).toHaveLength(1);
});

test('swiping an Agente 90 px right opens its Conversación; left does nothing', async () => {
  listSetup([idle], false);
  const app = renderApp(<AgentsScreen />); await app.ready();
  await screen.findByText('Agente C');
  const settle = () => act(() => { jest.advanceTimersByTime(320); });
  drag('agente-A-agentC', [{ x: -40 }, { x: -120 }]); settle();
  drag('agente-A-agentC', [{ x: 40 }, { x: 89 }]); settle();
  expect(router.push).not.toHaveBeenCalled();
  drag('agente-A-agentC', [{ x: 40 }, { x: 90 }]); settle();
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/[server]/[agent]', params: { server: 'A', agent: 'agentC' } });
});

test('pulling the list down reloads the Agentes and keeps «CARGANDO…» until they arrive', async () => {
  listSetup([idle], false);
  const app = renderApp(<AgentsScreen />); await app.ready();
  await screen.findByText('Agente C');
  const reply = deferred<Response>();
  respond(serverA.url, '/v1/agents', reply.promise);
  hold('pull-to-refresh', [{ y: 120 }]).release();
  await screen.findByText('CARGANDO…');
  expect(screen.queryByText('Agente B')).toBeNull();
  await act(async () => { reply.resolve(json({ agents: [idle, working] })); });
  await screen.findByText('Agente B');
  await waitFor(() => expect(screen.queryByText('CARGANDO…')).toBeNull());
});

test('a Servidor without response is a compact row with «Reintentar», never the big block', async () => {
  seed([serverA, serverB]); polling(serverA, [idle]);
  respond(serverB.url, '/health', networkError); respond(serverB.url, '/v1/agents', networkError);
  respond(serverB.url, '/v1/approvals', networkError); respond(serverB.url, '/v1/server/control', networkError);
  const app = renderApp(<AgentsScreen />); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('B').reachable).toBe(false));
  expect(screen.getByText('SERVIDOR B · SIN RESPUESTA')).toBeVisible();
  expect(screen.queryByText(/Relay no alcanza/)).toBeNull();
  const reads = requestsFor(serverB.url, '/health').length;
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  expect(requestsFor(serverB.url, '/health').length).toBeGreaterThan(reads);
});

test('a Servidor down with a known diagnosis keeps its Agentes dark: no strips, no badge, status off', async () => {
  listSetup();
  const app = renderApp(<AgentsScreen />); await app.ready();
  await screen.findByLabelText('Agente A: espera una Decisión');
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'opaque' } }, 403));
  await act(async () => app.probe.current!.refresh('A'));
  await waitFor(() => expect(app.probe.current!.snapshot('A').down?.kind).toBe('known'));
  expect(screen.getByText('Agente A')).toBeVisible();
  expect(screen.queryByLabelText(/^Agente [AB]:/)).toBeNull();
  expect(screen.queryByText('1')).toBeNull();
  expect(screen.queryByLabelText(/^Estado: (ocupado|encendido|con error)$/)).toBeNull();
  expect(screen.getAllByLabelText('Estado: apagado')).toHaveLength(3);
});

// ---------------------------------------------------------------- Conversación

type Step = { status: 'running' | 'waiting' | 'done' | 'error'; at: number; result?: string | null };
function chatSetup(steps: Step[] = [], pending = false) {
  seed(); polling(serverA, [pending ? deciding : agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  if (pending) respond(serverA.url, '/v1/approvals', json({ approvals: [approval().approval] }));
  const items = [
    { kind: 'user', id: 'ask', text: 'Los tests fallan.', at: Date.now() - 60_000 },
    ...steps.map((step, i) => ({ kind: 'tool', id: `step${i}`, tool: 'terminal', preview: 'npm test -- integration', durationSeconds: step.status === 'done' || step.status === 'error' ? 14.3 : null, result: null, cwd: '/srv/app/web', ...step })),
  ];
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items };
  respond(serverA.url, `${root}/transcript`, json(history));
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
}
async function mountChat() {
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Los tests fallan.');
  await act(async () => { await jest.advanceTimersByTimeAsync(500); });
  return app;
}
/** The CARGA needle: its angle (−50° at 0 s, +50° at 60 s) and its color. */
function needle() {
  const dial = screen.getByTestId('aguja-carga');
  const arm = dial.findAll(node => typeof node.type === 'string' && node.props.jestAnimatedStyle !== undefined)[0];
  const rotate = (animatedStyle(arm).transform as { rotate: string }[])[0].rotate;
  const [lit] = dial.findAll(node => typeof node.type === 'string' && ['#E5533D', '#F29A1A'].includes(StyleSheet.flatten(node.props.style)?.backgroundColor as string));
  return { angle: parseFloat(rotate), color: StyleSheet.flatten(lit.props.style).backgroundColor };
}

test('the needle reads the running step\'s seconds on the fixed 0–60 s scale: 17 s is 17 s, not the stop', async () => {
  chatSetup([{ status: 'done', at: Date.now() - 40_000 }, { status: 'running', at: Date.now() - 17_000 }]);
  await mountChat();
  const { angle, color } = needle();
  // 17 s → 17/60 of the 100° arc from −50°; one more second may tick while the screen loads.
  expect(angle).toBeGreaterThanOrEqual(-22);
  expect(angle).toBeLessThanOrEqual(-20);
  expect(color).toBe('#F29A1A');
});

test('the needle turns red from 45 s', async () => {
  chatSetup([{ status: 'waiting', at: Date.now() - 46_000 }]);
  await mountChat();
  expect(needle().color).toBe('#E5533D');
});

test('with no step in progress the needle rests at 0', async () => {
  chatSetup([{ status: 'done', at: Date.now() - 40_000 }]);
  await mountChat();
  expect(needle().angle).toBe(-50);
});

test('the needle reads a loaded step on the phone clock: a Puente 30 s behind still reads 17 s', async () => {
  const skew = 30_000;
  chatSetup([{ status: 'running', at: Date.now() - skew - 17_000 }]);
  respond(serverA.url, '/v1/approvals', json({ approvals: [], serverNow: Date.now() - skew }));
  await mountChat();
  expect(screen.getByTestId('aguja-carga').props.accessibilityLabel).toMatch(/^Carga: 1[78] s$/);
});

test('a terminal step that ended in error says «FALLÓ», never an exit code', async () => {
  chatSetup([{ status: 'error', at: Date.now() - 40_000, result: JSON.stringify({ output: 'FAIL src/db/client.test.ts', exit_code: 1 }) }]);
  await mountChat();
  expect(screen.getByText('FALLÓ')).toBeVisible();
  expect(screen.getByText('TERMINAL · /srv/app/web')).toBeVisible();
  expect(screen.queryByText(/EXIT/)).toBeNull();
});

test('an expired Aprobación in the thread is a grey VENCIDA chip that says what happened', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [
    { kind: 'user', id: 'ask', text: 'Los tests fallan.', at: Date.now() - 60_000 },
    { kind: 'tool', id: 'approval:x', tool: 'terminal', preview: 'rm -rf ./papers/tmp', status: 'error', durationSeconds: null, result: null, at: Date.now() - 50_000, feedbackOnly: true, approval: { id: 'x', outcome: 'expired' } },
  ] };
  respond(serverA.url, `${root}/transcript`, json(history));
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  await mountChat();
  expect(screen.getByText('VENCIDA')).toBeVisible();
  expect(screen.getByText('La Aprobación venció sin Decisión. El comando no se ejecutó.')).toBeVisible();
  expect(screen.queryByText(/EXPIRÓ/)).toBeNull();
});

test.each([['VENCIDA', LIGHT_PALETTE.K.onScreen], ['RECHAZADO', LIGHT_PALETTE.K.dangerTextOnScreen]])('a step whose Aprobación ended %s reads it in ACTIVIDAD\'s right column in its ink, never «FALLÓ»', (outcome, ink) => {
  const step = { id: 's', label: 'EJEC · rm -rf ./papers/tmp', status: 'error' as const, seconds: null, at: 0, outcome };
  renderApp(<ActivityCommand block={{ kind: 'activity', id: 'a', steps: [step], totalSeconds: 0, running: false }} now={0} onWaitingPress={() => {}} />);
  expect(screen.queryByText('FALLÓ')).toBeNull();
  expect(screen.getByText(outcome)).toHaveStyle({ color: ink });
  expect(screen.getByText(step.label)).toHaveStyle({ color: ink });
  expect(screen.getByText(outcome)).toBeVisible();
});

test('the Conversación returns «‹ Agentes»', async () => {
  chatSetup();
  navigation.state = stackOf(tabsRoute('agents'), { name: 'chat/[server]/[agent]', key: 'chat', params: { server: 'A', agent: 'agentA' } });
  await mountChat();
  expect(screen.getByText('‹ Agentes')).toBeVisible();
});

test('the voice box shows in the Conversación only while the Agente\'s text arrives', async () => {
  chatSetup();
  respond(serverA.url, `${root}/runs`, json({ runId: 'turn-fixture', sessionId: conversationA.sessionId, conversationId: conversationA.id, inputMessageId: 'wire-input' }), 'POST');
  const stream = streamFixture(); respond(serverA.url, '/v1/runs/turn-fixture/events', stream.reply);
  await mountChat();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Arréglalo.');
  fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  expect(screen.queryByLabelText('Escribiendo')).toBeNull();
  let sequence = 0;
  const emit = (event: ChatRunEvent) => act(async () => { stream.emit(`id: ${sequence++}\ndata: ${JSON.stringify(event)}\n\n`); });
  await emit({ type: 'message.delta', text: 'Reproduzco el fallo.' });
  expect(await screen.findByLabelText('Escribiendo')).toBeVisible();
  // A step after the text, or a Decisión awaited, is not text arriving.
  await emit({ type: 'tool.started', toolCallId: 'call-1', tool: 'terminal', preview: 'npm test' });
  expect(screen.queryByLabelText('Escribiendo')).toBeNull();
  await emit({ type: 'message.delta', text: 'Necesito limpiar el build.' });
  expect(screen.getByLabelText('Escribiendo')).toBeVisible();
  await emit({ type: 'approval.request', approval: { ...approval().approval, runId: 'turn-fixture' } });
  expect(screen.queryByLabelText('Escribiendo')).toBeNull();
  await emit({ type: 'run.completed', output: 'Necesito limpiar el build.' });
  await waitFor(() => expect(screen.queryByLabelText('Escribiendo')).toBeNull());
});

test('on a tablet ACTIVIDAD DEL TURNO stays fixed on the right and its key opens the Aprobación', async () => {
  chatSetup([{ status: 'waiting', at: Date.now() - 17_000 }], true);
  resizeWindow(1280, 800);
  const app = await mountChat();
  expect(screen.getByText('ACTIVIDAD DEL TURNO')).toBeVisible();
  expect(screen.getAllByTestId('aguja-carga')).toHaveLength(1);
  fireEvent.press(screen.getByText('Revisar la Aprobación'));
  expect(app.probe.current!.sheet?.approval.id).toBe('approval-A');
});

test('on a phone ACTIVIDAD stays in the thread', async () => {
  chatSetup([{ status: 'waiting', at: Date.now() - 17_000 }], true);
  await mountChat();
  expect(screen.queryByText('ACTIVIDAD DEL TURNO')).toBeNull();
  expect(screen.getByText('ACTIVIDAD · 1')).toBeVisible();
});
