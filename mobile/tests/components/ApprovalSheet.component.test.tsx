import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert, AppState, BackHandler } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import type { PendingApproval } from '@/state/app';
import { ApprovalSheet } from '@/screens/ApprovalSheet';
import { Keycap } from '@/ui/kit';
import { RelayShell } from '@/ui/RelayShell';
import { approval, polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { drag } from '../support/gestures';
import { animatedStyle, animatedViews } from '../support/motion';
import { biometrics, deferred, emitAppState, pressBack } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requests, respond } from '../support/transport';

async function mountApp(faceApprove = false) {
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed([serverA, serverB], { ...settings, faceApprove }); polling(serverA); polling(serverB);
  const app = renderApp(<ChatVisibilityProvider value={true}><ApprovalSheet /></ChatVisibilityProvider>); await app.ready();
  return app;
}
async function mountSheet(pending: PendingApproval = approval(), faceApprove = false) {
  const app = await mountApp(faceApprove);
  await act(async () => { app.probe.current!.openApproval(pending); });
  return app;
}
const decisions = () => requests.filter((request) => request.method === 'POST');
const advance = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
/** Jumps the clock past `ms` and lets the countdown tick once: five minutes of barrido frames would outlast the test timeout. */
const lapse = async (ms: number) => { jest.setSystemTime(Date.now() + ms); await advance(1000); };
const safety = () => screen.getByRole('switch', { name: 'Seguro' });
const approveKey = () => screen.getByRole('button', { name: 'Aprobar' });
const sessionKey = () => screen.getByRole('button', { name: 'Para la sesión' });
/** The six LEDs of a held key, 0 (off) to 1 (lit). */
const strip = (key: ReactTestInstance = approveKey()) =>
  key.findAll((node) => typeof node.type === 'string' && node.props.jestAnimatedStyle !== undefined).map((led) => Number(Number(animatedStyle(led).opacity).toFixed(2)));
/** Takes the seguro off and holds `key` for its full second, then lets go if the key is still there. */
async function approveWith(key: () => ReactTestInstance) {
  fireEvent.press(safety());
  const name = key().props.accessibilityLabel as string;
  fireEvent(key(), 'pressIn');
  await advance(1000);
  const held = screen.queryByRole('button', { name });
  if (held) fireEvent(held, 'pressOut');
}

test('the full sequence — seguro off, a 1 s hold, the huella — sends once from the Aprobación\'s Servidor, turns the command green and shows the toast', async () => {
  const app = await mountSheet(approval('approval-B', serverB));
  respond(serverB.url, '/v1/approvals/approval-B', json({}), 'POST');
  expect(safety()).toBeChecked();
  expect(screen.getByText('SEGURO PUESTO')).toBeVisible();
  await approveWith(approveKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(decisions()).toEqual([expect.objectContaining({ method: 'POST', origin: serverB.url, path: '/v1/approvals/approval-B', body: { choice: 'once' } })]);
  expect(screen.getByText('$ echo fixture')).toHaveStyle({ color: '#6FD08C' });
  expect(screen.getByText('Aprobado. Agente A continúa.')).toBeVisible();
  await advance(1400);
  expect(app.probe.current!.sheet).toBeNull();
  // The toast outlives the sheet and goes at 2 s.
  expect(screen.getByText('Aprobado. Agente A continúa.')).toBeVisible();
  await advance(600);
  expect(screen.queryByText('Aprobado. Agente A continúa.')).toBeNull();
});

test('«Para la sesión» exists only when the Aprobación offers it and sends session through the same seguro, hold and huella', async () => {
  const app = await mountSheet(approval('approval-A', serverA, ['once', 'deny']));
  expect(screen.queryByRole('button', { name: 'Para la sesión' })).toBeNull();
  await act(async () => { app.probe.current!.openApproval(approval('approval-B', serverA, ['once', 'session', 'deny'])); });
  respond(serverA.url, '/v1/approvals/approval-B', json({}), 'POST');
  expect(sessionKey()).toBeDisabled();
  await approveWith(sessionKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(decisions()).toEqual([expect.objectContaining({ origin: serverA.url, path: '/v1/approvals/approval-B', body: { choice: 'session' } })]);
  await advance(1400);
});

test('«Rechazar» sends the rejection without seguro or huella', async () => {
  const app = await mountSheet();
  respond(serverA.url, '/v1/approvals/approval-A', json({}), 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Rechazar' })); });
  expect(decisions()).toEqual([expect.objectContaining({ path: '/v1/approvals/approval-A', body: { choice: 'deny' } })]);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(screen.getByText('RECHAZADO · AGENTE A NOTIFICADO')).toBeVisible();
  expect(screen.queryByText(/^Aprobado\./)).toBeNull();
  await advance(1400);
  expect(app.probe.current!.sheet).toBeNull();
});

test('letting go before 1 s sends nothing, asks no huella and empties the strip in 150 ms', async () => {
  await mountSheet();
  fireEvent.press(safety());
  fireEvent(approveKey(), 'pressIn');
  await advance(500);
  expect(strip()).toEqual([1, 1, 1, 0, 0, 0]);
  await advance(499);
  fireEvent(approveKey(), 'pressOut');
  await advance(150);
  expect(strip()).toEqual([0, 0, 0, 0, 0, 0]);
  await advance(2000);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(decisions()).toEqual([]);
});

test('with the seguro on the key cannot be held or confirmed; taking it off arms the key and putting it back disarms it', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mountSheet();
  expect(approveKey()).toBeDisabled();
  fireEvent(approveKey(), 'pressIn');
  await advance(1500);
  fireEvent(approveKey(), 'pressOut');
  expect(strip()).toEqual([0, 0, 0, 0, 0, 0]);
  fireEvent(approveKey(), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(alert).not.toHaveBeenCalled();
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(decisions()).toEqual([]);
  fireEvent.press(safety());
  expect(safety()).not.toBeChecked();
  expect(screen.getByText('SEGURO QUITADO')).toBeVisible();
  expect(screen.getByText('Ahora la tecla de aprobar responde.')).toBeVisible();
  expect(approveKey()).toBeEnabled();
  fireEvent.press(safety());
  expect(safety()).toBeChecked();
  expect(approveKey()).toBeDisabled();
  alert.mockRestore();
});

test('expiring during the hold sends nothing: the strip empties, VENCIDA shows and the seguro goes back on', async () => {
  const app = await mountApp();
  const pending = approval(); pending.approval.expiresAt = Date.now() + 600;
  await act(async () => { app.probe.current!.openApproval(pending); });
  fireEvent.press(safety());
  fireEvent(approveKey(), 'pressIn');
  await advance(500);
  expect(strip()).toEqual([1, 1, 1, 0, 0, 0]);
  await advance(100);
  expect(screen.getByText('VENCIDA')).toBeVisible();
  expect(safety()).toBeChecked();
  expect(safety()).toBeDisabled();
  await advance(150);
  expect(strip()).toEqual([0, 0, 0, 0, 0, 0]);
  await advance(1000);
  fireEvent(approveKey(), 'pressOut');
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(decisions()).toEqual([]);
});

test('expiring during the huella sends nothing once it is given: VENCIDA shows and the seguro goes back on', async () => {
  const app = await mountApp();
  const pending = approval(); pending.approval.expiresAt = Date.now() + 1500;
  await act(async () => { app.probe.current!.openApproval(pending); });
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  await advance(600);
  expect(screen.getByText('VENCIDA')).toBeVisible();
  expect(safety()).toBeChecked();
  await act(async () => { auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
  expect(screen.queryByText(/^Aprobado\./)).toBeNull();
});

test('with a screen reader, the seguro, a confirmation in place of the hold and the huella still come before sending once', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mountSheet();
  respond(serverA.url, '/v1/approvals/approval-A', json({}), 'POST');
  fireEvent.press(safety());
  fireEvent(approveKey(), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(alert).toHaveBeenCalledTimes(1);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  await act(async () => { alert.mock.calls[0][2]![1].onPress!(); });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(decisions()).toEqual([expect.objectContaining({ path: '/v1/approvals/approval-A', body: { choice: 'once' } })]);
  alert.mockRestore();
  await advance(1400);
});

test('the red barrido moves in the overlay sheet until there is a Decisión', async () => {
  await mountSheet();
  const head = () => animatedStyle(animatedViews().find((view) => view.props.jestAnimatedStyle.value?.left !== undefined)!).left;
  await advance(50);
  const before = head();
  await advance(100);
  expect(head()).not.toBe(before);
});

test('a cancelled huella sends nothing; the next one sends once, and the next sheet inherits no seguro, busy or result', async () => {
  const app = await mountSheet(approval(), true);
  const cancelled = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(cancelled.promise);
  await approveWith(approveKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  await act(async () => { cancelled.resolve({ success: false }); });
  expect(decisions()).toEqual([]);
  const auth = deferred<{ success: boolean }>();
  const post = deferred<Response>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  respond(serverA.url, '/v1/approvals/approval-A', post.promise, 'POST');
  fireEvent(approveKey(), 'pressIn');
  await advance(1000);
  fireEvent(approveKey(), 'pressOut');
  expect(decisions()).toEqual([]);
  await act(async () => { auth.resolve({ success: true }); });
  await waitFor(() => expect(decisions()).toHaveLength(1));
  expect(decisions()[0].body).toEqual({ choice: 'once' });
  expect(approveKey()).toBeDisabled();
  await act(async () => { post.resolve(json({})); });
  expect(screen.getByText('APROBADO · AGENTE A CONTINÚA')).toBeVisible();
  await advance(1400);
  expect(app.probe.current!.sheet).toBeNull();
  await act(async () => { app.probe.current!.openApproval(approval('approval-B')); });
  expect(screen.queryByText('APROBADO · AGENTE A CONTINÚA')).toBeNull();
  expect(safety()).toBeChecked();
  fireEvent.press(safety());
  expect(approveKey()).toBeEnabled();
  await advance(600);
});

test.each(['pending', 'result'] as const)('directly replacing %s A with B resets the seguro, busy and result without closing', async (phase) => {
  const app = await mountSheet();
  const post = deferred<Response>();
  respond(serverA.url, '/v1/approvals/approval-A', post.promise, 'POST');
  await approveWith(approveKey);
  await waitFor(() => expect(decisions()).toHaveLength(1));
  expect(decisions()[0].body).toEqual({ choice: 'once' });
  expect(approveKey()).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Rechazar' })).toBeDisabled();
  const next = approval('approval-B');
  next.approval = { ...next.approval, agentId: 'agentB', agentName: 'Agente B', command: 'echo approval-B' };
  function expectFreshB() {
    expect(screen.getByText('Agente B quiere ejecutar')).toBeVisible();
    expect(screen.getByText('$ echo approval-B')).toBeVisible();
    expect(screen.queryByText(/^(APROBADO|RECHAZADO) ·/)).toBeNull();
    expect(safety()).toBeChecked();
    expect(screen.getByRole('button', { name: 'Rechazar' })).toBeEnabled();
  }
  try {
    if (phase === 'result') {
      await act(async () => { post.resolve(json({})); });
      expect(screen.getByText('APROBADO · AGENTE A CONTINÚA')).toBeVisible();
    }
    // Replace the identity while A is still open, before its delayed close can run.
    await act(async () => { app.probe.current!.openApproval(next); });
    expectFreshB();
    if (phase === 'pending') {
      await act(async () => { post.resolve(json({})); });
      expectFreshB();
    }
    expect(decisions()).toHaveLength(1);
  } finally {
    // Retire A's close timer and its toast even when a visible-state assertion fails.
    await advance(2000);
  }
});

test('approval requires huella even when the old preference is false and does not authorize missing enrollment', async () => {
  await mountSheet(approval(), false);
  biometrics.isEnrolledAsync.mockResolvedValue(false);
  await approveWith(approveKey);
  expect(decisions()).toEqual([]);
  expect(screen.getByText('Configura una huella en los ajustes del teléfono para aprobar.')).toBeVisible();
});

test.each(['close', 'replace', 'expire'] as const)('a late huella after %s never sends an old decision, and holding again starts no second prompt', async (change) => {
  const app = await mountSheet();
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  fireEvent(approveKey(), 'pressIn');
  await advance(1000);
  fireEvent(approveKey(), 'pressOut');
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  if (change === 'close') await act(async () => { app.probe.current!.closeApproval(); });
  if (change === 'replace') await act(async () => { app.probe.current!.openApproval(approval('approval-B')); });
  if (change === 'expire') await lapse(300001);
  await act(async () => { auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
});

test.each([-600000, 600000])('the countdown and the expiry at sending use the Puente clock with phone skew %i ms', async (skew) => {
  seed(); polling(serverA);
  const phoneNow = Date.now(); const pending = approval();
  pending.approval.expiresAt = phoneNow - skew + 300000;
  respond(serverA.url, '/v1/approvals', json({ approvals: [pending.approval], serverNow: phoneNow - skew }));
  const app = renderApp(<ChatVisibilityProvider value={true}><ApprovalSheet /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(app.probe.current!.pending).toHaveLength(1));
  await act(async () => { app.probe.current!.openApproval(app.probe.current!.pending[0]); });
  expect(screen.getByText('05:00')).toBeVisible();
  const auth = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  await lapse(300001);
  await act(async () => { auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
  expect(screen.getByText('VENCIDA')).toBeVisible();
});

test('huella requires biometrics without phone-code fallback and missing hardware never authorizes', async () => {
  await mountSheet(); biometrics.hasHardwareAsync.mockResolvedValueOnce(false);
  await approveWith(approveKey);
  expect(decisions()).toEqual([]); expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  const post = deferred<Response>(); respond(serverA.url, '/v1/approvals/approval-A', post.promise, 'POST');
  fireEvent(approveKey(), 'pressIn'); await advance(1000); fireEvent(approveKey(), 'pressOut');
  expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  await act(async () => { post.resolve(json({})); });
  await advance(2000);
});

test('going to background invalidates an ongoing huella even if the app returns before authentication completes', async () => {
  await mountSheet(); const auth = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  await act(async () => { emitAppState('background'); emitAppState('active'); auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
});

test('changing the paired server while huella is pending cannot redirect the old choice to new credentials', async () => {
  const app = await mountSheet(); const auth = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  await act(async () => { await app.probe.current!.replaceServer(serverA.id, { name: serverA.name, url: serverA.url, key: 'fixture-replaced-key', deviceId: 'fixture-replaced-device' }); });
  await act(async () => { auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
});

test('an uncertain response does not render approved and disables another submission', async () => {
  await mountSheet(); respond(serverA.url, '/v1/approvals/approval-A', json({ error: { code: 'decision_uncertain', message: 'fixture' } }, 409), 'POST');
  await approveWith(approveKey);
  await waitFor(() => expect(screen.getByText('DECISIÓN SIN CONFIRMAR. Relay no enviará esta elección otra vez.')).toBeVisible());
  expect(screen.queryByText('APROBADO · AGENTE A CONTINÚA')).toBeNull();
  expect(screen.queryByText(/^Aprobado\./)).toBeNull();
  expect(approveKey()).toBeDisabled(); expect(screen.getByRole('button', { name: 'Rechazar' })).toBeDisabled();
  expect(decisions()).toHaveLength(1);
});

const closeKey = () => screen.queryByRole('button', { name: 'Cerrar la Aprobación' });

test('an expired Aprobación closes with Android\'s back key or its «Cerrar» key, and nothing is sent', async () => {
  const app = await mountSheet();
  await lapse(300001);
  expect(screen.getByText('VENCIDA')).toBeVisible();
  act(() => pressBack());
  expect(app.probe.current!.sheet).toBeNull();
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
  await act(async () => { app.probe.current!.openApproval(approval()); });
  expect(screen.getByText('VENCIDA')).toBeVisible();
  fireEvent.press(closeKey()!);
  expect(app.probe.current!.sheet).toBeNull();
  expect(decisions()).toEqual([]);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test('back closes a pending Aprobación without deciding it; while the sheet is open the screen\'s own back handler waits', async () => {
  const underneath = jest.fn(() => true);
  const subscription = BackHandler.addEventListener('hardwareBackPress', underneath);
  const app = await mountSheet();
  expect(closeKey()).toBeNull();
  fireEvent.press(safety());
  act(() => pressBack());
  expect(app.probe.current!.sheet).toBeNull();
  expect(underneath).not.toHaveBeenCalled();
  act(() => pressBack());
  expect(underneath).toHaveBeenCalledTimes(1);
  subscription.remove();
  expect(decisions()).toEqual([]);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test.each(['rejected', 'approved', 'failed'] as const)('once %s, the sheet shows «Cerrar», which closes it at once', async (outcome) => {
  const app = await mountSheet();
  respond(serverA.url, '/v1/approvals/approval-A', outcome === 'failed' ? json({ error: { code: 'upstream', message: 'fixture' } }, 502) : json({}), 'POST');
  if (outcome === 'rejected') await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Rechazar' })); });
  else await approveWith(approveKey);
  expect(screen.getByText({ rejected: 'RECHAZADO · AGENTE A NOTIFICADO', approved: 'APROBADO · AGENTE A CONTINÚA', failed: 'NO SE PUDO ENVIAR LA DECISIÓN' }[outcome])).toBeVisible();
  fireEvent.press(closeKey()!);
  expect(app.probe.current!.sheet).toBeNull();
  expect(decisions()).toHaveLength(1);
});

test('back, the backdrop and the grip do nothing while the decision is on its way: it is sent once and its result still shows', async () => {
  const app = await mountSheet();
  const reply = deferred<Response>();
  respond(serverA.url, '/v1/approvals/approval-A', reply.promise, 'POST');
  await approveWith(approveKey);
  expect(decisions()).toHaveLength(1);
  act(() => pressBack());
  fireEvent.press(screen.getByLabelText('Cerrar', { includeHiddenElements: true }));
  drag('approval-grip', [{ y: 60 }, { y: 140 }]);
  await advance(0);
  expect(app.probe.current!.sheet).not.toBeNull();
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
  await act(async () => { reply.resolve(json({})); });
  expect(screen.getByText('APROBADO · AGENTE A CONTINÚA')).toBeVisible();
  expect(screen.getByText('Aprobado. Agente A continúa.')).toBeVisible();
  expect(decisions()).toHaveLength(1);
});

test('dragging the grip more than 110 px down closes the sheet; 110 px or less brings it back', async () => {
  const app = await mountSheet();
  drag('approval-grip', [{ y: 60 }, { y: 110 }]);
  await advance(300);
  expect(app.probe.current!.sheet).not.toBeNull();
  drag('approval-grip', [{ y: 60 }, { y: 111 }]);
  await advance(0);
  expect(app.probe.current!.sheet).toBeNull();
  expect(decisions()).toEqual([]);
});

test('a screen reader reaches the sheet and not the screen under it, and back on Android returns to that screen', async () => {
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed([serverA], settings); polling(serverA);
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><Keycap label="Debajo" onPress={() => {}} /></RelayShell><ApprovalSheet /></ChatVisibilityProvider>);
  await app.ready();
  expect(screen.getByRole('button', { name: 'Debajo' })).toBeVisible();
  await act(async () => { app.probe.current!.openApproval(approval()); });
  expect(screen.queryByRole('button', { name: 'Debajo' })).toBeNull();
  expect(screen.getByRole('header', { name: 'Agente A quiere ejecutar' })).toBeVisible();
  expect(safety()).toBeVisible();
  expect(screen.getByRole('button', { name: 'Rechazar' })).toBeVisible();
  act(() => pressBack());
  expect(screen.getByRole('button', { name: 'Debajo' })).toBeVisible();
});

test('while Relay is locked, back is not the hidden sheet\'s to take', async () => {
  seed([serverA], { ...settings, autoLockMs: 60000 }); polling(serverA);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  const app = renderApp(<LockGate><ApprovalSheet /></LockGate>); await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { app.probe.current!.openApproval(approval()); });
  await advance(60000);
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  act(() => pressBack());
  expect(app.probe.current!.sheet).not.toBeNull();
});

test.each(['locked', 'unlocked'] as const)('idle lock permanently invalidates pending approval huella resolved while %s', async (finish) => {
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed([serverA], { ...settings, autoLockMs: 60000 }); polling(serverA);
  respond(serverA.url, '/v1/approvals/approval-A', json({}), 'POST');
  const app = renderApp(<LockGate><ApprovalSheet /></LockGate>); await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { app.probe.current!.openApproval(approval()); });
  expect(screen.getByText('05:00')).toBeVisible();
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await approveWith(approveKey);
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  await advance(59000);
  expect(AppState.currentState).toBe('active');
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.getByText('04:00', { includeHiddenElements: true })).not.toBeVisible();
  if (finish === 'unlocked') {
    await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
    expect(approveKey()).toBeVisible();
  }
  await act(async () => { auth.resolve({ success: true }); });
  expect(decisions()).toEqual([]);
  expect(screen.queryByText('APROBADO · AGENTE A CONTINÚA', { includeHiddenElements: true })).toBeNull();
});
