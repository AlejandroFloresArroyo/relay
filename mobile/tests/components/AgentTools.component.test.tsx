import { act, cleanupAsync, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { createDemoClient, resetDemo, setDemoAgentToolsScenario } from '@/core/demo';
import { RelayError } from '@/core/client';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { useAgentTools } from '@/state/agentTools';
import { AgentToolsScreen } from '@/screens/AgentToolsScreen';
import type { AgentTools, AgentSkills } from '../../../protocol/agentTools';
import { agentA, polling, seed, serverA, serverB } from '../support/fixtures';
import { biometrics, clockStart, deferred, emitAppState, navigation, router, secureStore, stored } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requests, respond } from '../support/transport';

const catalog: AgentTools = { platform: 'api_server', observedAt: clockStart, appliesTo: 'next_turn', toolsets: [
  { name: 'terminal', label: 'Terminal', description: 'Ejecutar comandos', enabled: false, configured: true, tools: ['terminal'] },
  { name: 'web', label: 'Web', description: 'Buscar', enabled: true, configured: true, tools: ['web_search'] },
  { name: 'browser', label: 'Navegador', description: 'Navegar', enabled: false, configured: false, tools: ['browser_navigate'] },
] };
const skills: AgentSkills = { observedAt: clockStart, scope: 'profile_installed', limited: false, skills: [{ name: 'review-pr', description: 'Revisa cambios', category: 'desarrollo', availability: 'unknown' }] };
const endpoint = '/v1/agents/agentA/tools';
async function mount(gate = false) {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json(catalog)); respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  if (gate) biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const content = <AgentToolsScreen serverId="A" agentId="agentA" />;
  const app = renderApp(gate ? <LockGate>{content}</LockGate> : <ChatVisibilityProvider value={true}>{content}</ChatVisibilityProvider>); await app.ready();
  await screen.findByRole('switch', { name: 'Terminal' }); return app;
}
const posts = () => requests.filter((request) => request.method === 'POST');

test('enable needs explicit confirmation and successful fingerprint; configured guard and disable use real handlers', async () => {
  await mount();
  expect(screen.queryAllByText('Para el chat de Relay. Se aplica desde el siguiente Turno, también en una Conversación que ya existe. Encender pide huella; apagar no.')).toHaveLength(1);
  expect(screen.queryByText(/No cambia lo que el Agente|Se aplica a Conversaciones nuevas/)).toBeNull();
  expect(screen.getByRole('switch', { name: 'Navegador' })).toBeDisabled();
  fireEvent.press(screen.getByRole('switch', { name: 'Navegador' })); expect(posts()).toEqual([]);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  expect(screen.getByText('¿Encender Terminal para el chat de Relay?')).toBeVisible();
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Cancelar')); expect(posts()).toEqual([]);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(screen.getByText('Encender con huella')); });
  expect(posts()).toEqual([]);
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  const updated = { ...catalog, toolsets: catalog.toolsets.map((tool) => tool.name === 'terminal' ? { ...tool, enabled: true } : tool) };
  respond(serverA.url, endpoint + '/terminal', json(updated), 'POST');
  fireEvent.press(screen.getByText('Encender con huella')); expect(posts()).toEqual([]);
  await act(async () => { pending.resolve({ success: true }); });
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toMatchObject({ path: endpoint + '/terminal', body: { enabled: true } });
  expect(posts()[0].headers.get('X-Relay-Protocol')).toBe('2');
  expect(screen.getByRole('switch', { name: 'Terminal' })).toBeChecked();
  expect(screen.queryAllByText('Cambio guardado para el chat de Relay. Puede aplicarse en el siguiente Turno, también en una Conversación existente.')).toHaveLength(1);
  const disabled = { ...updated, toolsets: updated.toolsets.map((tool) => tool.name === 'web' ? { ...tool, enabled: false } : tool) };
  respond(serverA.url, endpoint + '/web', json(disabled), 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('switch', { name: 'Web' })); });
  expect(posts()).toHaveLength(2); expect(posts()[1].body).toEqual({ enabled: false });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(screen.queryAllByText('Cambio guardado para el chat de Relay. Puede aplicarse en el siguiente Turno, también en una Conversación existente.')).toHaveLength(1);
  expect(screen.getByText('review-pr')).toBeVisible();
  expect(screen.queryByText('ACTIVA')).toBeNull();
});

test('Herramientas y skills is one screen: sentence-case rows with plaquita and status chip, the note, and read-only skills', async () => {
  await mount();
  for (const text of ['Herramientas y skills', 'PARA EL CHAT DE RELAY', '1 DE 3', 'TERM', 'WEB', 'BROW', 'Terminal', 'Navegador', 'SKILLS', 'SOLO LECTURA', 'review-pr', 'DESARROLLO', 'INSTALADA', 'Revisa cambios']) expect(screen.getByText(text)).toBeVisible();
  expect(screen.getAllByText('CONFIGURADA')).toHaveLength(2);
  expect(screen.getAllByText('SIN CONFIGURAR')).toHaveLength(1);
  expect(screen.queryByText('TERMINAL')).toBeNull();
  expect(screen.queryByText('NORMAL')).toBeNull();
});

test('offline retains the dated last reading, disables every switch, and retries the server', async () => {
  await mount();
  respond(serverA.url, endpoint, () => { throw new Error('offline'); });
  // Keep the real provider alive while unmounting only the screen, as route navigation does.
  const retry = screen.getByRole('switch', { name: 'Web' });
  respond(serverA.url, endpoint + '/web', json({ error: { code: 'unavailable', message: 'Servidor sin respuesta' } }, 503), 'POST');
  await act(async () => { fireEvent.press(retry); });
  expect(screen.getByText(/Última lectura:.*2026/)).toBeVisible();
  expect(screen.getByRole('switch', { name: 'Terminal' })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Web' })).toBeDisabled();
  expect(screen.getByText('review-pr')).toBeVisible();
  const count = posts().length;
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  expect(posts()).toHaveLength(count);
  respond(serverA.url, endpoint, json(catalog));
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Terminal' })).toBeEnabled());
});

test('fingerprint resolving after leaving the screen cannot send a change', async () => {
  const app = await mount();
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  fireEvent.press(screen.getByText('Encender con huella'));
  await app.unmountAsync();
  await act(async () => { pending.resolve({ success: true }); });
  expect(posts()).toEqual([]);
});

test('missing biometric hardware never sends an enable request', async () => {
  await mount(); biometrics.hasHardwareAsync.mockResolvedValue(false);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(screen.getByText('Encender con huella')); });
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled(); expect(posts()).toEqual([]);
});

test('skills route is read only and empty/error states never fabricate a catalog', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json({ ...catalog, toolsets: [] }));
  respond(serverA.url, '/v1/agents/agentA/skills', json({ ...skills, skills: [] }));
  const app = renderApp(<AgentToolsScreen serverId="A" agentId="agentA" skillsOnly />); await app.ready();
  expect(await screen.findByText('No hay skills instaladas en el directorio del Agente.')).toBeVisible();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(requests.filter((request) => request.path === endpoint)).toHaveLength(0);
  expect(posts()).toEqual([]);
});

test('last known readings survive remounting AppProvider while offline, and remain read only', async () => {
  await mount(); await cleanupAsync();
  respond(serverA.url, endpoint, () => { throw new Error('offline'); });
  respond(serverA.url, '/v1/agents/agentA/skills', () => { throw new Error('offline'); });
  const second = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await second.ready();
  expect(await screen.findByText('review-pr')).toBeVisible();
  expect(screen.getByText(/Última lectura:.*2026/)).toBeVisible();
  expect(screen.getByRole('switch', { name: 'Terminal' })).toBeDisabled();
  expect(posts()).toEqual([]);
});

test('malformed tools metadata never enables a switch and never creates an invented catalog', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json({ ...catalog, platform: 'discord' }));
  respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  expect(await screen.findByText('Reintentar')).toBeVisible();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(posts()).toEqual([]);
});

test('an unavailable skills reading leaves canonical tools usable and reports the missing skills data', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json(catalog));
  respond(serverA.url, '/v1/agents/agentA/skills', json({ error: { code: 'agent_tools_unavailable', message: 'No se pudieron leer las skills.' } }, 503));
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByRole('switch', { name: 'Web' });
  expect(screen.getByRole('switch', { name: 'Web' })).toBeEnabled();
  expect(screen.getByText('El Puente de Servidor A no informa las skills.')).toBeVisible();
  expect(screen.getByText('NO DISPONIBLE · ACTUALIZA EL PUENTE')).toBeVisible();
});

test('losing the Server connection while fingerprint is pending cannot send an enable', async () => {
  const app = await mount();
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  fireEvent.press(screen.getByText('Encender con huella'));
  respond(serverA.url, '/v1/agents', () => { throw new Error('offline'); });
  await act(async () => { app.probe.current!.refresh(serverA.id); });
  await waitFor(() => expect(app.probe.current!.snapshot(serverA.id).reachable).toBe(false));
  await act(async () => { pending.resolve({ success: true }); });
  expect(posts()).toEqual([]);
});


test.each(['background', 'blur', 'autolock'] as const)('a pending fingerprint is permanently invalidated by %s even after returning', async (loss) => {
  const app = await mount(true);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Terminal' })).toBeVisible());
  const pending = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  respond(serverA.url, endpoint + '/terminal', json(catalog), 'POST');
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(screen.getByText('Encender con huella')); });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  expect(biometrics.authenticateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  if (loss === 'blur') {
    navigation.focused = false;
    await act(async () => { app.probe.current!.refresh('A'); });
    navigation.focused = true;
    await act(async () => { app.probe.current!.refresh('A'); });
  } else if (loss === 'autolock') {
    await act(async () => { jest.advanceTimersByTime(61000); });
    expect(screen.getByText('Relay está bloqueado')).toBeVisible();
    biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
    await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  } else {
    await act(async () => { emitAppState('background'); });
    await act(async () => { emitAppState('active'); });
  }
  await act(async () => { pending.resolve({ success: true }); });
  expect(posts()).toEqual([]);
});

test('replacing the paired client invalidates a pending fingerprint even after its new reading succeeds', async () => {
  const app = await mount(true);
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  respond(serverA.url, endpoint + '/terminal', json(catalog), 'POST');
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(screen.getByText('Encender con huella')); });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  await act(async () => { await app.probe.current!.replaceServer('A', { ...serverA, deviceId: 'replacement-device', key: 'replacement-fixture-key' }); });
  await waitFor(() => expect(requests.filter(request => request.path === endpoint)).toHaveLength(2));
  await act(async () => { pending.resolve({ success: true }); });
  expect(posts()).toEqual([]);
});

test('the real hook refuses free disable while its mounted screen is hidden', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json(catalog)); respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  respond(serverA.url, endpoint + '/web', json(catalog), 'POST');
  let hook: ReturnType<typeof useAgentTools> | undefined;
  function Probe() { const value = useAgentTools('A', 'agentA'); useEffect(() => { hook = value; }); return null; }
  const app = renderApp(<ChatVisibilityProvider value={true}><Probe /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(hook?.writable).toBe(true));
  await act(async () => { emitAppState('background'); });
  await act(async () => { expect(await hook!.setToolset('web', false)).toBe(false); });
  expect(posts()).toEqual([]); expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});


test.each([
  ['device_revoked', 'DISPOSITIVO REVOCADO', true],
  ['key_unknown', 'LLAVE RECHAZADA', true],
  ['cleartext_blocked', 'HTTP BLOQUEADO POR ANDROID', false],
  ['tailnet_required', 'TAILNET NECESARIA', false],
] as const)('Tools preserves the safe %s diagnosis and rejects revoked cached metadata', async (code, label, pairing) => {
  await mount(); await cleanupAsync();
  const failure = code === 'cleartext_blocked'
    ? () => { throw new Error('CLEARTEXT communication to a.fixture.ts.net not permitted; private-fixture-detail'); }
    : json({ error: { code, message: 'private-fixture-detail' } }, 401);
  respond(serverA.url, endpoint, failure);
  respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.queryByText(new RegExp(label))).toBeVisible());
  // An Agente's tools are not the Servidor's ficha: its state is the compact row (D-ES).
  expect(screen.getByText(`${serverA.name.toUpperCase()} · ${label}`)).toBeVisible();
  expect(screen.queryByText(/private-fixture-detail/)).toBeNull();
  expect(screen.queryByText('Abrir Tailscale')).toBeNull();
  if (pairing) {
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByText('review-pr')).toBeNull();
    fireEvent.press(screen.getByText('Emparejar de nuevo'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
    await cleanupAsync();
    respond(serverA.url, endpoint, () => { throw new Error('offline'); });
    respond(serverA.url, '/v1/agents/agentA/skills', () => { throw new Error('offline'); });
    const offline = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await offline.ready();
    await screen.findByText('Reintentar');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  } else expect(screen.getByRole('switch', { name: 'Web' })).toBeDisabled();
});


test.each(['Servidor', 'Agente'] as const)('a pending fingerprint cannot survive switching %s away and back', async (scope) => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]);
  for (const server of [serverA, serverB]) for (const agent of ['agentA', 'agentB']) {
    respond(server.url, `/v1/agents/${agent}/tools`, json(catalog));
    respond(server.url, `/v1/agents/${agent}/skills`, json(skills));
  }
  respond(serverA.url, endpoint + '/terminal', json(catalog), 'POST');
  function Switcher() {
    const [other, setOther] = useState(false);
    return <ChatVisibilityProvider value={true}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cambiar ámbito" onPress={() => setOther(!other)}><Text>Cambiar ámbito</Text></Pressable>
      <AgentToolsScreen serverId={other && scope === 'Servidor' ? 'B' : 'A'} agentId={other && scope === 'Agente' ? 'agentB' : 'agentA'} />
    </ChatVisibilityProvider>;
  }
  const app = renderApp(<Switcher />); await app.ready();
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Terminal' })).toBeEnabled());
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(screen.getByText('Encender con huella')); });
  fireEvent.press(screen.getByText('Cambiar ámbito'));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Terminal' })).toBeEnabled());
  fireEvent.press(screen.getByText('Cambiar ámbito'));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Terminal' })).toBeEnabled());
  await act(async () => { pending.resolve({ success: true }); });
  expect(posts()).toEqual([]);
});

test('the skills-unavailable demo drives the real screen with updated Tools and dated cached skills', async () => {
  resetDemo(); seed(); polling(serverA, [agentA]);
  let now = clockStart;
  const client = createDemoClient('atlas', () => now);
  respond(serverA.url, endpoint, async () => json(await client.agentTools!('dev')));
  respond(serverA.url, '/v1/agents/agentA/skills', async () => {
    try { return json(await client.agentSkills!('dev')); }
    catch (error) { if (error instanceof RelayError) return json({ error: { code: error.code, message: error.message } }, 503); throw error; }
  });
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('revisar-pr');
  setDemoAgentToolsScenario('atlas', 'dev', 'skills-unavailable'); now += 60000;
  await act(async () => { app.probe.current!.refresh('A'); });
  // Retry the real Tools read through a failed write; no hook or AppProvider is replaced.
  respond(serverA.url, endpoint + '/terminal', json({ error: { code: 'unavailable', message: 'Fixture update unavailable' } }, 503), 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('switch', { name: 'Terminal' })); });
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  expect(screen.getByText('No se pudieron actualizar las skills del Agente. Reintenta.')).toBeVisible();
  expect(screen.getByText(/Última lectura de skills:/)).toBeVisible();
  expect(screen.getByText('revisar-pr')).toBeVisible();
  expect(screen.getByRole('switch', { name: 'Terminal' })).toBeEnabled();
  expect(screen.queryByText('SIN RESPUESTA')).toBeNull();
  setDemoAgentToolsScenario('atlas', 'dev', 'normal');
  resetDemo();
});


test('a rejected Tools reading hides the cache before a pending skills response finishes', async () => {
  await mount(); await cleanupAsync();
  const pending = deferred<Response>();
  respond(serverA.url, endpoint, json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  respond(serverA.url, '/v1/agents/agentA/skills', pending.promise);
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  expect(await screen.findByText(/DISPOSITIVO REVOCADO/)).toBeVisible();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  await act(async () => { pending.resolve(json(skills)); });
  expect(screen.queryByText('review-pr')).toBeNull();
});


test('polling revocation immediately hides previously available Tools and skills', async () => {
  const app = await mount();
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  await act(async () => { app.probe.current!.refresh('A'); });
  await waitFor(() => expect(screen.queryByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.queryByText('review-pr')).toBeNull();
});


for (const source of ['reading', 'change'] as const) {
  test(`polling revocation retires a pending Tools cache ${source} before offline remount`, async () => {
    const write = deferred<void>();
    let held = false;
    let holdWrites = source === 'reading';
    secureStore.setItemAsync.mockImplementation(async (key, value) => {
      if (key.startsWith('relay.agent-tools.') && value !== '{}' && holdWrites && !held) {
        held = true; await write.promise;
      }
      stored.set(key, value);
    });
    const app = await mount();
    if (source === 'change') {
      holdWrites = true;
      respond(serverA.url, endpoint + '/web', json({ ...catalog, toolsets: catalog.toolsets.map(tool => tool.name === 'web' ? { ...tool, enabled: false } : tool) }), 'POST');
      await act(async () => { fireEvent.press(screen.getByRole('switch', { name: 'Web' })); });
    }
    await waitFor(() => expect(held).toBe(true));
    respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
    await act(async () => { app.probe.current!.refresh('A'); });
    await screen.findByText(/DISPOSITIVO REVOCADO/);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    // Remove the mounted reader while its native write is still pending.
    await cleanupAsync();
    await act(async () => { write.resolve(undefined); });
    polling(serverA, [agentA]);
    respond(serverA.url, endpoint, () => { throw new Error('offline'); });
    respond(serverA.url, '/v1/agents/agentA/skills', () => { throw new Error('offline'); });
    const offline = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>);
    await offline.ready(); await screen.findByText('Reintentar');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByText('review-pr')).toBeNull();
  });
}


for (const loss of ['autolock', 'blur', 'background', 'background-batched', 'revocation'] as const) {
  test(`Tools confirmation is retired on ${loss} and cannot return with a stale callback`, async () => {
    const app = await mount(true);
    fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
    const title = '¿Encender Terminal para el chat de Relay?';
    expect(screen.getByText(title)).toBeVisible();
    let button = screen.getByText('Encender con huella').parent;
    while (button && typeof button.props.onPress !== 'function') button = button.parent;
    const confirm = button!.props.onPress;
    respond(serverA.url, endpoint + '/terminal', json(catalog), 'POST');
    if (loss === 'autolock') {
      await act(async () => { jest.advanceTimersByTime(60000); });
      expect(screen.getByText('Relay está bloqueado')).toBeVisible();
    } else if (loss === 'blur') {
      navigation.focused = false; await act(async () => { app.probe.current!.refresh('A'); });
    } else if (loss === 'background') {
      await act(async () => { emitAppState('background'); });
    } else if (loss === 'background-batched') {
      await act(async () => { emitAppState('background'); emitAppState('active'); });
    } else {
      respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
      await act(async () => { app.probe.current!.refresh('A'); });
      await screen.findByText(/DISPOSITIVO REVOCADO/);
    }
    expect(screen.queryByText(title, { includeHiddenElements: true })).toBeNull();
    if (loss === 'autolock') {
      biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
      await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
    } else if (loss === 'blur') {
      navigation.focused = true; await act(async () => { app.probe.current!.refresh('A'); });
    } else if (loss === 'background') {
      await act(async () => { emitAppState('active'); });
    }
    biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
    await act(async () => { confirm(); });
    expect(screen.queryByText(title, { includeHiddenElements: true })).toBeNull();
    expect(posts()).toEqual([]);
  });
}


test('a new Tools device rejection outranks an older known AppProvider cause', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/agents', () => { throw new Error('CLEARTEXT communication to a.fixture.ts.net not permitted; private-fixture-detail'); });
  const reading = deferred<Response>();
  respond(serverA.url, endpoint, reading.promise);
  respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  const app = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('A').down?.label).toBe('HTTP BLOQUEADO POR ANDROID'));
  await act(async () => { reading.resolve(json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401)); });
  await waitFor(() => expect(screen.queryByText(/DISPOSITIVO REVOCADO/)).not.toBeNull());
  expect(screen.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible();
  expect(screen.queryByText(/HTTP BLOQUEADO POR ANDROID/)).toBeNull();
  expect(screen.queryByText(/private-fixture-detail/)).toBeNull();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  fireEvent.press(screen.getByText('Emparejar de nuevo'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
});


test('an offline Tools remount cannot read the old cache while a revoked native write is pending', async () => {
  const app = await mount();
  const write = deferred<void>(); let held = false;
  secureStore.setItemAsync.mockImplementation(async (key, value) => {
    if (key.startsWith('relay.agent-tools.') && value !== '{}' && !held) { held = true; await write.promise; }
    stored.set(key, value);
  });
  respond(serverA.url, endpoint + '/web', json(catalog), 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('switch', { name: 'Web' })); });
  await waitFor(() => expect(held).toBe(true));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  await act(async () => { app.probe.current!.refresh('A'); });
  await screen.findByText(/DISPOSITIVO REVOCADO/);
  await cleanupAsync();
  polling(serverA, [agentA]);
  respond(serverA.url, endpoint, () => { throw new Error('offline'); });
  respond(serverA.url, '/v1/agents/agentA/skills', () => { throw new Error('offline'); });
  const offline = renderApp(<ChatVisibilityProvider value={true}><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>);
  await offline.ready();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.queryByText('review-pr')).toBeNull();
  await act(async () => { write.resolve(undefined); });
  await screen.findByText('Reintentar');
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.queryByText('review-pr')).toBeNull();
});

test('cancelling Tools confirmation retires its callback before another tool decision opens', async () => {
  await mount(true);
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  let button = screen.getByText('Encender con huella').parent;
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  const confirm = button!.props.onPress;
  fireEvent.press(screen.getByText('Cancelar'));
  fireEvent.press(screen.getByRole('switch', { name: 'Terminal' }));
  respond(serverA.url, endpoint + '/terminal', json(catalog), 'POST');
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { confirm(); });
  expect(posts()).toEqual([]);
  expect(screen.getByText('¿Encender Terminal para el chat de Relay?')).toBeVisible();
});


test.each(['new_conversations', 'current_turn', 'all_channels'] as const)('a live unsupported %s claim never exposes writable Tools', async appliesTo => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, endpoint, json({ ...catalog, appliesTo }));
  respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  const app = renderApp(<ChatVisibilityProvider value><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>);
  await app.ready();
  await screen.findByText('Reintentar');
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByText('review-pr')).toBeVisible();
  expect(posts()).toEqual([]);
  expect(app.probe.current!.snapshot('A').protocol?.kind).toBe('compatible');
  expect(screen.queryAllByText('La lectura de Herramientas no es válida o no está disponible. Si el Puente usa un contrato anterior de Herramientas, actualízalo antes de editar. El chat conserva su compatibilidad propia.')).toHaveLength(1);
  expect(screen.queryByText('SIN RESPUESTA')).toBeNull();
});

test('an unsupported application claim in the save ACK never becomes a confirmed toggle or next-Turn message', async () => {
  await mount();
  respond(serverA.url, endpoint + '/web', json({ ...catalog, appliesTo: 'new_conversations', toolsets: catalog.toolsets.map(tool => ({ ...tool, enabled: false })) }), 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('switch', { name: 'Web' })); });
  await screen.findByText('Reintentar');
  expect(posts()).toHaveLength(1);
  expect(screen.getByRole('switch', { name: 'Web' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Web' })).toBeDisabled();
  expect(screen.queryByText(/^Cambio guardado/)).toBeNull();
});

test('an obsolete cached Tools claim is discarded on offline reopening without migrating it', async () => {
  await mount(); await cleanupAsync();
  for (const [key, value] of stored) {
    if (!key.startsWith('relay.agent-tools.')) continue;
    const previous = JSON.parse(value);
    if (previous.tools) stored.set(key, JSON.stringify({ ...previous, tools: { ...previous.tools, appliesTo: 'new_conversations' } }));
  }
  respond(serverA.url, endpoint, () => { throw new Error('offline'); });
  respond(serverA.url, '/v1/agents/agentA/skills', json(skills));
  const app = renderApp(<ChatVisibilityProvider value><AgentToolsScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>);
  await app.ready();
  await screen.findByText('Reintentar');
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(posts()).toEqual([]);
});
