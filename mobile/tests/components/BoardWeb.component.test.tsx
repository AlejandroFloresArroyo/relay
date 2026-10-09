import { Profiler, useState } from 'react';
import { Text, Pressable } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { BoardScreen } from '@/screens/BoardScreen';
import { LockGate } from '@/screens/LockGate';
import { polling, seed, serverA, serverB, agentA, settings } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, respond, requestsFor } from '../support/transport';
import { clockStart, deferred, emitAppState, emitAppBlur, emitAppFocus, biometrics, stored } from '../support/native';
import { boardWebNative, resetBoardWeb, nativeFailures } from '../support/boardWeb';
jest.mock('@/native/boardWeb', () => require('../support/boardWeb'));
const revision = 'a'.repeat(64);
const file = { name: 'index.html', mime: 'text/html', bytes: 9, sha256: 'b'.repeat(64) };
const card = { agentId: agentA.id, agentName: agentA.name, id: 'web', title: 'Certificados TLS', updatedAt: clockStart, maxAgeMs: 60000, state: 'ready', status: 'ready', content: { type: 'web', bundleRef: 'counter', revision } };
const resource = `/v1/agents/${agentA.id}/board-web/counter/${revision}`;
const webJson = (data: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return { ...json(data), headers: new Headers({ 'X-Relay-Board-Web': '1' }), body: { getReader: () => {
    let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: bytes }), cancel: async () => {}, releaseLock() {} };
  } } } as unknown as Response;
};
function fixtures() {
  seed([serverA, serverB], { ...settings, faceid: false }); polling(serverA, [agentA]); polling(serverB, [agentA]); resetBoardWeb();
  respond(serverA.url, '/v1/board', webJson({ cards: [card], failedAgents: [], observedAt: clockStart }));
  respond(serverA.url, resource + '/manifest', webJson({ bundleRef: 'counter', revision, manifest: { schemaVersion: 1, entry: 'index.html', files: [file] } }));
  respond(serverA.url, resource + '/assets/index.html', { ...json(''), headers: new Headers({ 'X-Relay-Board-Web': '1', 'Content-Type': 'text/html' }), body: { getReader: () => {
    let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: new TextEncoder().encode('<p>OK</p>') }), cancel: async () => {}, releaseLock() {} };
  } } } as unknown as Response);
}
beforeEach(() => { resetBoardWeb(); });
test('web content keeps native attribution and passes only hashed bytes and a snapshot id across the native boundary', async () => {
  fixtures(); const app = renderApp(<LockGate><BoardScreen serverId="A" /></LockGate>); await app.ready();
  await screen.findByTestId('board-web-native');
  expect(screen.getByText('Certificados TLS')).toBeVisible(); expect(screen.getByText('CONTENIDO DEL AGENTE')).toBeVisible();
  expect(boardWebNative.createSnapshot).toHaveBeenCalledWith('generation-1', revision, JSON.stringify({ schemaVersion: 1, entry: 'index.html', files: [file] }));
  expect(boardWebNative.putAsset).toHaveBeenCalledWith('generation-1', 'snapshot-fixture', 'index.html', 'PHA+T0s8L3A+');
  expect(requestsFor(serverA.url, resource + '/manifest')[0].headers.get('X-Relay-Board-Web')).toBe('1');
  expect(requestsFor(serverA.url, '/v1/board')[0].headers.get('X-Relay-Board-Web')).toBe('1');
  expect(JSON.stringify(boardWebNative.createSnapshot.mock.calls)).not.toContain(serverA.key);
});
for (const event of ['background', 'blur', 'unmount', 'scope'] as const) {
  test(`${event} retires native bytes before a late native copy can publish a view`, async () => {
    fixtures(); const copy = deferred<string>(); boardWebNative.createSnapshot.mockImplementation(() => copy.promise);
    function Switch() { const [id, set] = useState('A'); return <><Pressable accessibilityLabel="Switch scope" onPress={() => set('B')}><Text>Switch</Text></Pressable><LockGate><BoardScreen serverId={id}/></LockGate></>; }
    polling(serverB, [agentA]); respond(serverB.url, '/v1/board', webJson({ cards: [], failedAgents: [], observedAt: clockStart }));
    const app = renderApp(<Switch/>); await app.ready(); await waitFor(() => expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (event === 'background') emitAppState('background');
      if (event === 'blur') emitAppBlur();
      if (event === 'unmount') app.unmount();
      if (event === 'scope') fireEvent.press(screen.getByLabelText('Switch scope'));
    });
    expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
    await act(async () => copy.resolve('late-snapshot'));
    expect(boardWebNative.putAsset).not.toHaveBeenCalled(); expect(boardWebNative.sealSnapshot).not.toHaveBeenCalled();
    if (event !== 'unmount') expect(screen.queryByTestId('board-web-native')).toBeNull();
  });
}
test('an unverified provider reports its cause and never downloads or mounts arbitrary JS', async () => {
  fixtures(); boardWebNative.capability.mockReturnValue({ state: 'unverified', cause: 'provider_unverified' });
  const app = renderApp(<LockGate><BoardScreen serverId="A" /></LockGate>); await app.ready();
  await screen.findByText('Este proveedor WebView todavía no tiene aislamiento verificado.');
  expect(boardWebNative.beginGeneration).not.toHaveBeenCalled(); expect(requestsFor(serverA.url, resource + '/manifest')).toHaveLength(0);
  expect(screen.queryByTestId('board-web-native')).toBeNull();
});
test.each([['unverified', 'provider_unverified'], ['unsupported', 'native_missing']] as const)('a %s provider never asks the Puente for web Tarjetas', async (state, cause) => {
  fixtures(); boardWebNative.capability.mockReturnValue({ state, cause });
  const app = renderApp(<LockGate><BoardScreen serverId="A" /></LockGate>); await app.ready();
  await waitFor(() => expect(requestsFor(serverA.url, '/v1/board').length).toBeGreaterThan(0));
  expect(requestsFor(serverA.url, '/v1/board').every(request => request.headers.get('X-Relay-Board-Web') === null)).toBe(true);
});

test('the real LockGate retires ready JS on idle lock and never lends a pending old copy to unlock', async () => {
  fixtures(); stored.set('relay.settings.v1', JSON.stringify(settings)); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await screen.findByTestId('board-web-native');
  await act(async () => { await jest.advanceTimersByTimeAsync(61000); });
  await screen.findByText('Relay está bloqueado'); expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
  expect(screen.queryByTestId('board-web-native', { includeHiddenElements: true })).toBeNull();
});
test('revocation from real AppProvider polling retires ready JS and prevents another copy', async () => {
  fixtures(); const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await screen.findByTestId('board-web-native');
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'synthetic' } }, 403));
  await act(async () => { app.probe.current!.refresh(); });
  await waitFor(() => expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1'));
  expect(screen.queryByTestId('board-web-native')).toBeNull();
  expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(1);
});
test('an older bridge cannot cause asset downloads even if it supplies an unnegotiated web type', async () => {
  fixtures(); respond(serverA.url, '/v1/board', json({ cards: [card], failedAgents: [], observedAt: clockStart }));
  const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await screen.findByText('Esta Tarjeta requiere soporte de contenido web. Actualiza Relay para verla.');
  expect(requestsFor(serverA.url, resource + '/manifest')).toHaveLength(0); expect(boardWebNative.beginGeneration).not.toHaveBeenCalled();
});

test('replacement pairing on the same Server retires its pending snapshot before accepting new credentials', async () => {
  fixtures(); const copy = deferred<string>(); boardWebNative.createSnapshot.mockImplementationOnce(() => copy.promise);
  const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await waitFor(() => expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(1));
  boardWebNative.capability.mockReturnValue({ state: 'unverified', cause: 'provider_unverified' });
  await act(async () => { await app.probe.current!.replaceServer('A', { name: serverA.name, url: serverA.url, deviceId: 'replacement-fixture-device', key: 'replacement-fixture-key' }); });
  expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
  await act(async () => copy.resolve('late-old-pairing'));
  expect(boardWebNative.putAsset).not.toHaveBeenCalled(); expect(boardWebNative.sealSnapshot).not.toHaveBeenCalled();
});
test('offline retains web metadata but retires all executable content', async () => {
  fixtures(); const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await screen.findByTestId('board-web-native');
  respond(serverA.url, '/v1/board', () => Promise.reject(new Error('synthetic offline')));
  await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
  expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
  expect(screen.queryByTestId('board-web-native')).toBeNull();
  expect(screen.getByText('Certificados TLS')).toBeVisible();
  expect(screen.getByText('Contenido web no disponible sin conexión. Solo se conserva la información de la Tarjeta.')).toBeVisible();
});

test('a failure callback from a retired native view cannot retire the new generation after focus returns', async () => {
  fixtures(); const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
  await screen.findByTestId('board-web-native'); const late = nativeFailures[0];
  await act(async () => emitAppBlur()); expect(screen.queryByTestId('board-web-native')).toBeNull();
  await act(async () => emitAppFocus()); await screen.findByTestId('board-web-native');
  expect(boardWebNative.beginGeneration).toHaveBeenCalledTimes(2);
  await act(async () => late());
  expect(boardWebNative.retireGeneration).not.toHaveBeenCalledWith('generation-2');
  expect(screen.getByTestId('board-web-native')).toBeVisible();
});

test('batched Android blur and focus retire the ready view in the first commit and start a fresh copy', async () => {
  fixtures(); stored.set('relay.settings.v1', JSON.stringify(settings)); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const fresh = deferred<string>();
  boardWebNative.createSnapshot.mockResolvedValueOnce('snapshot-before-blur').mockImplementationOnce(() => fresh.promise);
  let observing = false;
  const commits: (string | null)[] = [];
  const app = renderApp(<Profiler id="board-focus" onRender={() => {
    if (observing) commits.push(screen.queryByTestId('board-web-native', { includeHiddenElements: true })?.props.accessibilityLabel ?? null);
  }}><LockGate><BoardScreen serverId="A"/></LockGate></Profiler>);
  await app.ready(); await screen.findByLabelText('Web snapshot snapshot-before-blur');
  observing = true;
  await act(async () => {
    emitAppBlur();
    expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
    emitAppFocus();
  });
  expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
  expect(screen.queryByTestId('board-web-native', { includeHiddenElements: true })).toBeNull();
  expect(commits.length).toBeGreaterThan(0);
  expect(commits).not.toContain('Web snapshot snapshot-before-blur');
  await waitFor(() => expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(2));
  await act(async () => fresh.resolve('snapshot-after-focus'));
  await screen.findByLabelText('Web snapshot snapshot-after-focus');
  expect(boardWebNative.putAsset).toHaveBeenLastCalledWith('generation-2', 'snapshot-after-focus', 'index.html', 'PHA+T0s8L3A+');
});

for (const event of ['blur/focus', 'background/active'] as const) {
  test(`batched ${event} during a pending native copy starts a fresh generation and discards the old completion`, async () => {
    fixtures(); stored.set('relay.settings.v1', JSON.stringify(settings)); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
    const old = deferred<string>(), fresh = deferred<string>();
    boardWebNative.createSnapshot.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const app = renderApp(<LockGate><BoardScreen serverId="A"/></LockGate>); await app.ready();
    await waitFor(() => expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(1));
    await act(async () => {
      if (event === 'blur/focus') { emitAppBlur(); emitAppFocus(); }
      else { emitAppState('background'); emitAppState('active'); }
    });
    expect(boardWebNative.retireGeneration).toHaveBeenCalledWith('generation-1');
    await waitFor(() => expect(boardWebNative.createSnapshot).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve('retired-pending-snapshot'));
    expect(boardWebNative.putAsset).not.toHaveBeenCalled(); expect(boardWebNative.sealSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByTestId('board-web-native', { includeHiddenElements: true })).toBeNull();
    await act(async () => fresh.resolve('current-pending-snapshot'));
    await screen.findByLabelText('Web snapshot current-pending-snapshot');
    expect(boardWebNative.putAsset).toHaveBeenCalledTimes(1);
    expect(boardWebNative.putAsset).toHaveBeenCalledWith('generation-2', 'current-pending-snapshot', 'index.html', 'PHA+T0s8L3A+');
    expect(boardWebNative.sealSnapshot).toHaveBeenCalledWith('generation-2', 'current-pending-snapshot');
  });
}

test('focus after a separate blur never commits the previous ready snapshot while a fresh copy is pending', async () => {
  fixtures(); const fresh = deferred<string>();
  boardWebNative.createSnapshot.mockResolvedValueOnce('snapshot-before-separated-blur').mockImplementationOnce(() => fresh.promise);
  const commits: (string | null)[] = []; let observing = false;
  const app = renderApp(<Profiler id="board-separated-focus" onRender={() => {
    if (observing) commits.push(screen.queryByTestId('board-web-native', { includeHiddenElements: true })?.props.accessibilityLabel ?? null);
  }}><LockGate><BoardScreen serverId="A"/></LockGate></Profiler>);
  await app.ready(); await screen.findByLabelText('Web snapshot snapshot-before-separated-blur');
  await act(async () => emitAppBlur());
  observing = true;
  await act(async () => emitAppFocus());
  expect(commits.length).toBeGreaterThan(0);
  expect(commits).not.toContain('Web snapshot snapshot-before-separated-blur');
  expect(screen.queryByTestId('board-web-native', { includeHiddenElements: true })).toBeNull();
  await act(async () => fresh.resolve('snapshot-after-separated-focus'));
  await screen.findByLabelText('Web snapshot snapshot-after-separated-focus');
});
