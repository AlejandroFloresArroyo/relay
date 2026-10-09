import { act, cleanupAsync, fireEvent, waitFor } from '@testing-library/react-native';
import UsageRoute from '@/app/usage/[server]';
import { ServerScreen } from '@/screens/ServerScreen';
import { UsageScreen } from '@/screens/UsageScreen';
import { renderApp } from '../support/renderApp';
import { polling, seed, serverA, serverB } from '../support/fixtures';
import { json, respond, requestsFor, networkError } from '../support/transport';
import { deferred, navigation, router, stored, secureStore } from '../support/native';
import { demoServerUsage } from '@/core/serverUsageDemo';

function replies(server = serverA) {
  for (const period of ['day','week','month'] as const) respond(server.url, `/v1/usage?period=${period}`, json(demoServerUsage(period)));
}
test('real provider loads all periods for this Server and switches Agent/model breakdown without inventing unknown costs', async () => {
  seed([serverA,serverB]); polling(serverA); polling(serverB); replies();
  navigation.params={server:serverA.id};
  const view = renderApp(<UsageRoute />); await view.ready();
  await waitFor(() => expect(view.getByText('POR AGENTE · SEMANA')).toBeTruthy());
  expect(view.getByText('Por inicio de Conversación')).toBeTruthy();
  expect(view.getAllByText('No informa costo').length).toBeGreaterThan(0);
  await act(async()=>{fireEvent.press(view.getByRole('button',{name:'Mes'}));});
  expect(view.getByText('POR AGENTE · MES')).toBeTruthy();
  await act(async()=>{fireEvent.press(view.getByRole('button',{name:'Por modelo'}));});
  expect(view.getByText('POR MODELO · MES')).toBeTruthy();
  expect(view.getByText('qwen3-coder')).toBeTruthy();
  expect(requestsFor(serverB.url).filter(r=>r.path.startsWith('/v1/usage'))).toEqual([]);
  expect(requestsFor(serverA.url).filter(r=>r.path.startsWith('/v1/usage')).map(r=>r.path).sort()).toEqual(['/v1/usage?period=day','/v1/usage?period=month','/v1/usage?period=week']);
});
test('cached calculation survives remount offline with a date and returns live after retry', async () => {
  seed(); polling(serverA); replies();
  const first = renderApp(<UsageScreen serverId={serverA.id} />); await first.ready();
  await waitFor(() => expect(first.getByText('POR AGENTE · SEMANA')).toBeTruthy());
  await waitFor(() => expect([...stored.keys()].some(k=>k.startsWith('relay.usage.'))).toBe(true));
  await cleanupAsync();
  for (const period of ['day','week','month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
  const offline = renderApp(<UsageScreen serverId={serverA.id} />); await offline.ready();
  await waitFor(() => expect(offline.getByText('Último cálculo · solo lectura')).toBeTruthy());
  expect(offline.getByText(/CÁLCULO GUARDADO 14 OCT 12:00/)).toBeTruthy();
  expect(offline.getByText('POR AGENTE · SEMANA')).toBeTruthy();
  replies(); await act(async()=>{fireEvent.press(offline.getByRole('button',{name:'Reintentar'}));});
  await waitFor(() => expect(offline.queryByText('Último cálculo · solo lectura')).toBeNull());
});
test('the header says it is an estimate and dates the calculation in 24 h, in the Server\'s hour', async () => {
  seed(); polling(serverA); replies();
  const view = renderApp(<UsageScreen serverId={serverA.id} />); await view.ready();
  await waitFor(() => expect(view.getByText('POR AGENTE · SEMANA')).toBeTruthy());
  expect(view.getByText('≈ ESTIMADO')).toBeTruthy();
  expect(view.getByText(`12–14 OCT · CÁLCULO GUARDADO 14 OCT 12:00 (HORA DE ${serverA.name.toUpperCase()})`)).toBeTruthy();
  expect(view.getByText('COSTO POR DÍA · SEMANA')).toBeTruthy();
  for (const label of ['ENTRADA', 'SALIDA', 'CACHÉ LEÍDA']) expect(view.getByText(label)).toBeTruthy();
});
test('empty, partial and unavailable states never claim a complete zero', async () => {
  seed(); polling(serverA);
  for (const period of ['day','week','month'] as const) respond(serverA.url, `/v1/usage?period=${period}`, json(demoServerUsage(period,'partial')));
  const view = renderApp(<UsageScreen serverId={serverA.id} />); await view.ready();
  await waitFor(() => expect(view.getByText('DATOS PARCIALES')).toBeTruthy());
  expect(view.getByText('ops · error de lectura')).toBeTruthy();
  await cleanupAsync();
  for (const period of ['day','week','month'] as const) respond(serverA.url, `/v1/usage?period=${period}`, json(demoServerUsage(period,'empty')));
  const empty = renderApp(<UsageScreen serverId={serverA.id} />); await empty.ready();
  await waitFor(() => expect(empty.getByText('SIN USO REGISTRADO')).toBeTruthy());
});

test('unknown prices switch the chart to tokens and a confirmed zero remains an estimate', async () => {
  seed(); polling(serverA);
  for (const period of ['day','week','month'] as const) {
    const data=demoServerUsage(period,'unknown');
    data.agents[0].amount.estimatedCostUsd=0; data.agents[0].totalsKnown.estimatedCostUsd=0;
    respond(serverA.url,`/v1/usage?period=${period}`,json(data));
  }
  const app=renderApp(<UsageScreen serverId={serverA.id}/>); await app.ready();
  await waitFor(()=>expect(app.getByText('TOKENS POR DÍA · SEMANA')).toBeTruthy());
  expect(app.getByText('≈ $0.00')).toBeTruthy();
  expect(app.getAllByText('No informa costo').length).toBeGreaterThan(0);
  await act(async()=>{fireEvent.press(app.getByRole('button',{name:/2026-10-12:/}));});
  expect(app.getByText(/^2026-10-12 · 17\s*k tokens$/)).toBeTruthy();
});
test('loading settles into unavailable without displaying fabricated usage or retaining a foreign cache', async () => {
  seed(); polling(serverA);
  const response=deferred<Response>();
  for (const period of ['day','week','month']) respond(serverA.url,`/v1/usage?period=${period}`,response.promise);
  stored.set('relay.usage.v1.A.week',JSON.stringify({source:'foreign-device',report:demoServerUsage('week')}));
  const app=renderApp(<UsageScreen serverId={serverA.id}/>); await app.ready();
  expect(app.getByLabelText('Calculando uso…')).toBeTruthy();
  await act(async()=>{response.resolve(json({error:{code:'unavailable',message:'Fixture usage unsupported'}},503));});
  await waitFor(()=>expect(app.getByText('Sin un cálculo guardado para este período.')).toBeTruthy());
  expect(app.queryByText('SIN USO REGISTRADO')).toBeNull();
  expect(app.queryByText('≈ $0.00')).toBeNull();
});
test('Servidor opens its own public usage route', async () => {
  seed(); polling(serverA);
  respond(serverA.url,'/v1/server',json({host:'fixture',hermesVersion:'fixture',profiles:0,chat:{available:true,reason:null}}));
  respond(serverA.url,'/v1/gateway',json({state:'stopped',pid:null,uptimeSeconds:null,port:null}));
  respond(serverA.url,'/v1/usage?period=week',json(demoServerUsage('week')));
  respond(serverA.url,'/v1/jobs',json({jobs:[]}));
  respond(serverA.url,'/v1/logs?lines=100&level=DEBUG',json({lines:[]}));
  respond(serverA.url,'/v1/server/control',json({paused:false,hermesPaused:false,phase:'ready',action:null}));
  const app=renderApp(<ServerScreen serverId={serverA.id}/>); await app.ready();
  await act(async()=>{fireEvent.press(app.getByText('Uso y costo'));});
  expect(router.push).toHaveBeenCalledWith({pathname:'/usage/[server]',params:{server:'A'}});
});


test.each([
  ['device_revoked', 'DISPOSITIVO REVOCADO', true],
  ['key_unknown', 'LLAVE RECHAZADA', true],
  ['cleartext_blocked', 'HTTP BLOQUEADO POR ANDROID', false],
] as const)('Usage preserves the safe %s diagnosis without advertising revoked cache', async (code, label, pairing) => {
  seed(); polling(serverA); replies();
  const first = renderApp(<UsageScreen serverId="A" />); await first.ready();
  await waitFor(() => expect(first.getByText('POR AGENTE · SEMANA')).toBeVisible());
  await cleanupAsync();
  for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, code === 'cleartext_blocked'
    ? () => { throw new Error('CLEARTEXT communication to a.fixture.ts.net not permitted; private-fixture-detail'); }
    : json({ error: { code, message: 'private-fixture-detail' } }, 401));
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(app.queryByText(new RegExp(label))).toBeVisible());
  expect(app.queryByText(/private-fixture-detail/)).toBeNull();
  expect(app.queryByText('Abrir Tailscale')).toBeNull();
  if (pairing) {
    expect(app.queryByText('POR AGENTE · SEMANA')).toBeNull();
    expect(app.queryByText('Último cálculo · solo lectura')).toBeNull();
    fireEvent.press(app.getByText('Emparejar de nuevo'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
    await cleanupAsync();
    for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
    const offline = renderApp(<UsageScreen serverId="A" />); await offline.ready();
    await waitFor(() => expect(offline.queryByText('Sin un cálculo guardado para este período.')).not.toBeNull());
    expect(offline.getByText('Sin un cálculo guardado para este período.')).toBeVisible();
    expect(offline.queryByText('POR AGENTE · SEMANA')).toBeNull();
  } else expect(app.getByText('Último cálculo · solo lectura')).toBeVisible();
});

test('Usage re-pairing immediately hides the previous device calculation while fresh requests are pending', async () => {
  seed(); polling(serverA); replies();
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(app.getByText('POR AGENTE · SEMANA')).toBeVisible());
  const pending = deferred<Response>();
  for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, pending.promise);
  await act(async () => { await app.probe.current!.replaceServer('A', { ...serverA, deviceId: 'replacement-device', key: 'replacement-fixture-key' }); });
  expect(app.queryByText('POR AGENTE · SEMANA')).toBeNull();
  await act(async () => { pending.resolve(json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401)); });
  await waitFor(() => expect(app.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  expect(app.queryByText('POR AGENTE · SEMANA')).toBeNull();
});

test('a late successful usage period cannot restore content after another period rejects the device', async () => {
  seed(); polling(serverA); replies();
  const pending = deferred<Response>();
  respond(serverA.url, '/v1/usage?period=day', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  respond(serverA.url, '/v1/usage?period=week', pending.promise);
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(app.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  await act(async () => { pending.resolve(json(demoServerUsage('week'))); });
  expect(app.queryByText('POR AGENTE · SEMANA')).toBeNull();
  expect(app.queryAllByText(/≈ \$[0-9]/)).toHaveLength(0);
});


test('polling revocation hides every previously available usage period immediately', async () => {
  seed(); polling(serverA); replies();
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(app.getByText('POR AGENTE · SEMANA')).toBeVisible());
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  await act(async () => { app.probe.current!.refresh('A'); });
  await waitFor(() => expect(app.queryByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  expect(app.queryByText('POR AGENTE · SEMANA')).toBeNull();
  expect(app.queryAllByText(/≈ \$[0-9]/)).toHaveLength(0);
});


test('a usage cache write finishing after revocation is purged before an offline remount', async () => {
  seed(); polling(serverA); replies();
  const write = deferred<void>();
  const response = deferred<Response>();
  let held = false;
  const key = 'relay.usage.v1.A.day';
  secureStore.setItemAsync.mockImplementation(async (entry, value) => {
    if (entry === key && value !== '' && !held) { held = true; await write.promise; }
    stored.set(entry, value);
  });
  respond(serverA.url, '/v1/usage?period=week', response.promise);
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(held).toBe(true));
  await act(async () => { response.resolve(json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401)); });
  await waitFor(() => expect(app.queryByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  await act(async () => { write.resolve(undefined); });
  expect(stored.get(key)).toBe('');
  await cleanupAsync();
  for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
  const offline = renderApp(<UsageScreen serverId="A" />); await offline.ready();
  await waitFor(() => expect(offline.getByText('Sin un cálculo guardado para este período.')).toBeVisible());
  fireEvent.press(offline.getByRole('button', { name: 'Hoy' }));
  expect(offline.queryByText('POR AGENTE · HOY')).toBeNull();
});


test('polling revocation purges pending Usage writes before every offline period remounts', async () => {
  seed(); polling(serverA); replies();
  const write = deferred<void>();
  let held = 0;
  secureStore.setItemAsync.mockImplementation(async (key, value) => {
    if (key.startsWith('relay.usage.') && value !== '') { held++; await write.promise; }
    stored.set(key, value);
  });
  const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
  await waitFor(() => expect(held).toBe(3));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  await act(async () => { app.probe.current!.refresh('A'); });
  await waitFor(() => expect(app.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  expect(app.queryAllByText(/≈ \$[0-9]/)).toHaveLength(0);
  await cleanupAsync();
  await act(async () => { write.resolve(undefined); });
  polling(serverA);
  for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
  const offline = renderApp(<UsageScreen serverId="A" />); await offline.ready();
  for (const period of ['Hoy', 'Semana', 'Mes']) {
    fireEvent.press(offline.getByRole('button', { name: period }));
    await waitFor(() => expect(offline.queryByText('Sin un cálculo guardado para este período.')).not.toBeNull());
    expect(offline.getByText('Sin un cálculo guardado para este período.')).toBeVisible();
    expect(offline.queryByText(/^POR AGENTE/)).toBeNull();
    expect(offline.queryAllByText(/≈ \$[0-9]/)).toHaveLength(0);
  }
});


for (const cause of ['cleartext', 'rate_limited'] as const) {
  test(`Usage displays the known AppProvider ${cause} cause while its own reads only report offline`, async () => {
    seed(); polling(serverA);
    respond(serverA.url, '/v1/agents', cause === 'cleartext'
      ? () => { throw new Error('CLEARTEXT communication to a.fixture.ts.net not permitted; private-fixture-detail'); }
      : json({ error: { code: 'rate_limited', message: 'private-fixture-detail' } }, 429));
    for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
    const app = renderApp(<UsageScreen serverId="A" />); await app.ready();
    const label = cause === 'cleartext' ? 'HTTP BLOQUEADO POR ANDROID' : 'DEMASIADOS INTENTOS';
    await waitFor(() => expect(app.probe.current!.snapshot('A').down?.label).toBe(label));
    await waitFor(() => expect(app.queryByText(new RegExp(label))).not.toBeNull());
    expect(app.getByText(new RegExp(label))).toBeVisible();
    expect(app.queryByText('SIN RESPUESTA')).toBeNull();
    expect(app.queryByText('Abrir Tailscale')).toBeNull();
    expect(app.queryByText(/private-fixture-detail/)).toBeNull();
  });
}


test('an offline Usage remount waits for a pending revocation purge instead of reading the old calculation', async () => {
  seed(); polling(serverA); replies();
  const first = renderApp(<UsageScreen serverId="A" />); await first.ready();
  await waitFor(() => expect(first.getByText('POR AGENTE · SEMANA')).toBeVisible());
  await cleanupAsync();
  const write = deferred<void>(); let held = 0;
  secureStore.setItemAsync.mockImplementation(async (key, value) => {
    if (key.startsWith('relay.usage.') && value !== '') { held++; await write.promise; }
    stored.set(key, value);
  });
  const fresh = renderApp(<UsageScreen serverId="A" />); await fresh.ready();
  await waitFor(() => expect(held).toBe(3));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'private-fixture-detail' } }, 401));
  await act(async () => { fresh.probe.current!.refresh('A'); });
  await waitFor(() => expect(fresh.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  await cleanupAsync();
  polling(serverA);
  for (const period of ['day', 'week', 'month']) respond(serverA.url, `/v1/usage?period=${period}`, networkError);
  const offline = renderApp(<UsageScreen serverId="A" />); await offline.ready();
  expect(offline.queryByText('POR AGENTE · SEMANA')).toBeNull();
  expect(offline.queryAllByText(/≈ \$[0-9]/)).toHaveLength(0);
  await act(async () => { write.resolve(undefined); });
  await waitFor(() => expect(offline.getByText('Sin un cálculo guardado para este período.')).toBeVisible());
  expect(offline.queryByText('POR AGENTE · SEMANA')).toBeNull();
});
