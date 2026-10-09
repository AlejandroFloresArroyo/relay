import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { AgentToolsScreen } from '@/screens/AgentToolsScreen';
import { ActivityScreen } from '@/screens/ActivityScreen';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { agentA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { biometrics, clockStart, deferred, emitAppState } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requests, respond } from '../support/transport';

function setup() { seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo)); }

test('Tools content and an already open native Modal follow the palette, without editing or widening late fingerprint authorization', async () => {
  setup();
  respond(serverA.url, '/v1/agents/agentA/tools', json({ platform: 'api_server', appliesTo: 'next_turn', observedAt: clockStart, toolsets: [{ name: 'terminal', label: 'Terminal', description: 'Ejecutar comandos', enabled: false, configured: true, tools: ['terminal'] }] }));
  respond(serverA.url, '/v1/agents/agentA/skills', json({ observedAt: clockStart, scope: 'profile_installed', limited: false, skills: [] }));
  const view = renderApp(<ThemeProvider><ChatVisibilityProvider value><AgentToolsScreen serverId="A" agentId="agentA" /><SettingsScreen /></ChatVisibilityProvider></ThemeProvider>);
  await view.ready(); await view.findByRole('switch', { name: 'Terminal' });
  fireEvent.press(view.getByRole('switch', { name: 'Terminal' }));
  await act(async () => { fireEvent.press(view.getByRole('radio', { name: 'Oscuro' })); });
  expect(view.getByText('PARA EL CHAT DE RELAY', { includeHiddenElements: true })).toHaveStyle({ color: '#8D8A82' });
  expect(view.getByText('Encender con huella')).toHaveStyle({ color: '#1A1A19' });
  expect(view.getByText('Las reglas de bloqueo y el Modo de aprobación del Agente siguen vigentes.')).toHaveStyle({ color: '#C9C6BE' });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  const pending = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(pending.promise);
  fireEvent.press(view.getByText('Encender con huella'));
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { fireEvent.press(view.getByRole('radio', { name: 'Claro' })); emitAppState('background'); });
  await act(async () => { pending.resolve({ success: true }); });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
});

test('Activity failure surface and current filters react without a reload or losing selection', async () => {
  setup();
  respond(serverA.url, '/v1/activity?limit=50', json({ capturedAt: clockStart, nextCursor: null, items: [{ id: 'fixture-event', at: clockStart, actor: { kind: 'device', id: serverA.deviceId }, action: 'job.run', category: 'tasks', result: 'failed', scope: { kind: 'agent', agentId: agentA.id }, conversationId: null }] }));
  const view = renderApp(<ThemeProvider><ChatVisibilityProvider value><ActivityScreen /><SettingsScreen /></ChatVisibilityProvider></ThemeProvider>);
  await view.findByText('Ejecución de tarea');
  const row = view.getByLabelText('Ejecución de tarea, NO CONFIRMADO');
  fireEvent.press(row);
  const reads = requests.filter(r => r.path.startsWith('/v1/activity')).length;
  await act(async () => { fireEvent.press(view.getByRole('radio', { name: 'Oscuro' })); });
  expect(view.getByRole('header', { name: 'Agentes' })).toHaveStyle({ color: '#E8E6E1' });
  expect(row).toHaveStyle({ backgroundColor: '#321B18' });
  expect(view.getByText('El resultado quedó sin confirmar; el cambio pudo tener efectos.')).toBeVisible();
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(reads);
});
