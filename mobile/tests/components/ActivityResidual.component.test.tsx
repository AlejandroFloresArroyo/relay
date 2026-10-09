import { Profiler, useState } from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { ActivityScreen } from '@/screens/ActivityScreen';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { agentA, polling, seed, serverA, serverB } from '../support/fixtures';
import { json, requests, respond } from '../support/transport';
import { clockStart, deferred } from '../support/native';
const path = '/v1/activity?limit=50';
const event = { id: 'event-A', at: clockStart, actor: { kind: 'device', id: serverA.deviceId }, action: 'job.run', category: 'tasks', result: 'requested', scope: { kind: 'agent', agentId: agentA.id }, conversationId: 'fixture-conversation' };
const page = (items = [event], nextCursor: string | null = null, capturedAt = clockStart) => ({ items, capturedAt, nextCursor });
const mount = () => renderApp(<ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider>);
test('returning after hidden interval never commits the retired cursor before a fresh read',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,path,json(page([event],'retired-cursor')));
 let toggle!:(v:boolean)=>void;let view!:ReturnType<typeof renderApp>;let armed=false;const commits:boolean[]=[];
 function Page(){const [visible,setVisible]=useState(true);toggle=setVisible;
  return <Profiler id="visibility-review" onRender={()=>{if(armed&&view)commits.push(view.queryByText('CARGAR MÁS · SERVIDOR A')!==null);}}><ChatVisibilityProvider value={visible}><ActivityScreen/></ChatVisibilityProvider></Profiler>;
 }
 view=renderApp(<Page/>);await view.findByText('CARGAR MÁS · SERVIDOR A');
 act(()=>toggle(false));expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull();
 const fresh=deferred<Response>();respond(serverA.url,path,fresh.promise);
 armed=true;act(()=>toggle(true));await waitFor(()=>expect(requests.filter(r=>r.path===path)).toHaveLength(2));
 expect(commits).not.toContain(true);
});

test.each([
  ['refresh', 'device_revoked', 403, 'DISPOSITIVO REVOCADO'],
  ['refresh', 'protocol_upgrade_required', 426, 'Actualiza Relay para consultar Actividad.'],
  ['filter', 'device_revoked', 403, 'DISPOSITIVO REVOCADO'],
  ['filter', 'protocol_upgrade_required', 426, 'Actualiza Relay para consultar Actividad.'],
] as const)('same-client late %s denial %s purges metadata and retires the queued read', async (change, code, status, label) => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'late-denial-cursor')));
  const old = deferred<Response>(); respond(serverA.url, path + '&cursor=late-denial-cursor', old.promise);
  let toggle!: (visible: boolean) => void;
  function Remount() { const [visible, setVisible] = useState(true); toggle = setVisible; return visible ? <ChatVisibilityProvider value><ActivityScreen/></ChatVisibilityProvider> : null; }
  const view = renderApp(<Remount/>); await view.findByText('SOLICITADO');
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=late-denial-cursor'))).toHaveLength(1));
  const fresh = deferred<Response>(); const freshPath = change === 'filter' ? path + '&category=tasks' : path;
  respond(serverA.url, freshPath, fresh.promise);
  fireEvent.press(view.getByText(change === 'filter' ? 'TAREAS' : 'ACTUALIZAR ACTIVIDAD'));
  await act(async () => {});
  await act(async () => old.resolve(json({ error: { code, message: 'hidden-denial-detail' } }, status)));
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  await view.findByText(label);
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(2);
  expect(view.queryByText('CARGAR MÁS · SERVIDOR A')).toBeNull(); expect(view.queryByText('hidden-denial-detail')).toBeNull();
  fireEvent.press(view.getByText('ACTUALIZAR ACTIVIDAD')); await act(async () => {});
  act(() => toggle(false)); act(() => toggle(true)); await act(async () => {});
  expect(view.queryByText('SOLICITADO', { includeHiddenElements: true })).toBeNull();
  expect(requests.filter(r => r.path.startsWith('/v1/activity'))).toHaveLength(2);
});

test.each(['origin', 'key', 'device'] as const)('a late terminal denial belongs to the old %s client and cannot block its replacement', async kind => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, json(page([event], 'old-client')));
  const old = deferred<Response>(); respond(serverA.url, path + '&cursor=old-client', old.promise);
  const view = mount(); await view.findByText('SOLICITADO'); fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A'));
  await waitFor(() => expect(requests.filter(r => r.path.endsWith('cursor=old-client'))).toHaveLength(1));
  const replacement = { ...serverA, ...(kind === 'origin' ? { url: serverB.url } : kind === 'key' ? { key: 'fixture-new-key' } : { deviceId: 'fixture-new-device' }) };
  polling(replacement, [agentA]); respond(replacement.url, path, json(page([{ ...event, id: 'replacement', result: 'recorded' }], 'replacement-cursor')));
  await act(async () => { await view.probe.current!.replaceServer(serverA.id, replacement); });
  await view.findByText('REGISTRADO');
  await act(async () => old.resolve(json({ error: { code: 'device_revoked' } }, 403)));
  expect(view.getByText('REGISTRADO')).toBeVisible(); expect(view.queryByText('DISPOSITIVO REVOCADO')).toBeNull();
  expect(view.getByText('CARGAR MÁS · SERVIDOR A')).toBeVisible();
  respond(replacement.url, path + '&cursor=replacement-cursor', json(page([{ ...event, id: 'next', result: 'accepted' }])));
  fireEvent.press(view.getByText('CARGAR MÁS · SERVIDOR A')); await view.findByText('ACEPTADO');
});
