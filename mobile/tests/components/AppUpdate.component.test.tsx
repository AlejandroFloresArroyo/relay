import { Pressable, Text } from 'react-native';
import { ThemeProvider, useThemePreference } from '@/theme/ThemeProvider';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/theme/tokens';
import { Profiler, useState } from 'react';
import { ServerScreen } from '@/screens/ServerScreen';
import { LockGate } from '@/screens/LockGate';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { AppUpdateScreen } from '@/screens/AppUpdateScreen';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { renderApp } from '../support/renderApp';
import { seed, serverA, serverB, agentA, polling, serverInfo } from '../support/fixtures';
import { json, binary, respond, requests } from '../support/transport';
import { deferred, emitAppState, navigation, biometrics, router } from '../support/native';
import { apkNative, resetApkNative, fixtureManifest, fixtureVerified, fixtureInstalled } from '../support/appUpdate';
jest.mock('expo', () => ({ ...jest.requireActual('expo'), requireOptionalNativeModule: (name: string) => name === 'RelayApkUpdate' ? require('../support/appUpdate').apkNative : null }));
const path = '/v1/app-update';
const metadata = () => ({ ...json(fixtureManifest), headers: new Headers({ ETag: '"' + fixtureManifest.revision + '"' }) });
const apk = () => ({ ...binary(new Uint8Array([1, 2, 3, 4]), 'application/vnd.android.package-archive'), headers: new Headers({ ETag: '"' + fixtureManifest.revision + '"', 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': '4' }) });
beforeEach(() => resetApkNative());
test('Servidor APK requires version review and local verification before a separate Android installation gesture', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  const verification = deferred<typeof fixtureVerified>(); apkNative.verify.mockReturnValue(verification.promise);
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>);
  await view.findByText('Actualización APK'); await view.findByText('COMPATIBLE SEGÚN PUBLICACIÓN');
  expect(view.getByText('INSTALADA')).toBeVisible(); expect(view.getByText('1.2.0 · 3')).toBeVisible(); expect(view.getByText('PUBLICADA')).toBeVisible(); expect(view.getByText('1.3.0 · 4')).toBeVisible();
  expect(requests.filter(r => r.path === path + '/apk')).toHaveLength(0); expect(apkNative.install).not.toHaveBeenCalled();
  fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK'));
  await view.findByText('Verificando APK local…'); expect(view.queryByText('Instalar · confirmar en Android')).toBeNull();
  await act(async () => verification.resolve(fixtureVerified)); await view.findByText('VERIFICADO EN ESTE TELÉFONO');
  expect(apkNative.install).not.toHaveBeenCalled();
  fireEvent.press(view.getByText('Instalar · confirmar en Android'));
  await waitFor(() => expect(apkNative.install).toHaveBeenCalledTimes(1));
  await view.findByText('Android solicita confirmación. Esto no confirma que el APK se haya instalado.');
  expect(requests.filter(r => r.path === path + '/apk')).toHaveLength(1); expect(apkNative.retire).toHaveBeenCalled();
});


test.each(['hidden', 'background', 'inactive', 'grouped-background', 'blur', 'lock', 'origin', 'key', 'device', 'revocation', 'protocol'] as const)('a verification retained across %s cannot publish or open an installer after returning', async kind => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  const verification = deferred<typeof fixtureVerified>(); apkNative.verify.mockReturnValue(verification.promise);
  if (kind === 'lock') biometrics.authenticateAsync.mockResolvedValue({ success: true });
  let toggle!: (visible: boolean) => void; let view!: ReturnType<typeof renderApp>; let armed = false; const commits: boolean[] = [];
  function Page() {
    const [visible, setVisible] = useState(true); toggle = setVisible;
    const screen = <AppUpdateScreen serverId="A"/>;
    return <Profiler id="apk-scope" onRender={() => { if (armed && view) commits.push(view.queryByText('VERIFICADO EN ESTE TELÉFONO', { includeHiddenElements: true }) !== null); }}>
      {kind === 'lock' ? <LockGate>{screen}</LockGate> : <ChatVisibilityProvider value={visible}>{screen}</ChatVisibilityProvider>}
    </Profiler>;
  }
  view = renderApp(<Page/>); await view.findByText('Revisar versiones');
  fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK')); await view.findByText('Verificando APK local…');
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise); armed = true;
  if (kind === 'hidden') { act(() => toggle(false)); act(() => toggle(true)); }
  if (kind === 'background' || kind === 'inactive') { act(() => emitAppState(kind)); act(() => emitAppState('active')); }
  if (kind === 'grouped-background') act(() => { emitAppState('background'); emitAppState('active'); });
  if (kind === 'blur') { navigation.focused = false; await act(async () => { await view.probe.current!.refresh(serverA.id); }); navigation.focused = true; await act(async () => { await view.probe.current!.refresh(serverA.id); }); }
  if (kind === 'lock') { biometrics.authenticateAsync.mockResolvedValue({ success: true }); await act(async () => { await jest.advanceTimersByTimeAsync(60000); }); expect(view.getByText('Relay está bloqueado')).toBeVisible(); fireEvent.press(view.getByText('Usar el código del teléfono')); await waitFor(() => expect(view.queryByText('Relay está bloqueado')).not.toBeOnTheScreen()); }
  if (kind === 'origin' || kind === 'key' || kind === 'device') {
    const replacement = { ...serverA, ...(kind === 'origin' ? { url: serverB.url } : kind === 'key' ? { key: 'fixture-new-key' } : { deviceId: 'fixture-new-device' }) };
    polling(replacement, [agentA]); respond(replacement.url, path, fresh.promise);
    await act(async () => { await view.probe.current!.replaceServer(serverA.id, replacement); });
  }
  if (kind === 'revocation' || kind === 'protocol') {
    respond(serverA.url, '/health', json({ error: { code: kind === 'revocation' ? 'device_revoked' : 'protocol_upgrade_required' } }, kind === 'revocation' ? 403 : 426));
    await act(async () => { await view.probe.current!.refresh(serverA.id); });
  }
  expect(apkNative.retire).toHaveBeenCalled();
  await act(async () => verification.resolve(fixtureVerified));
  expect(view.queryByText('VERIFICADO EN ESTE TELÉFONO', { includeHiddenElements: true })).toBeNull();
  expect(view.queryByText('Instalar · confirmar en Android', { includeHiddenElements: true })).toBeNull();
  expect(commits).not.toContain(true); expect(apkNative.install).not.toHaveBeenCalled();
});

test('blocking while the installed-app revalidation is pending retires the installer gesture permanently', async () => {
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  const view = renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>); await view.findByText('Revisar versiones');
  fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK')); await view.findByText('VERIFICADO EN ESTE TELÉFONO');
  const revalidation = deferred<typeof fixtureInstalled>(); apkNative.info.mockReturnValueOnce(revalidation.promise);
  fireEvent.press(view.getByText('Instalar · confirmar en Android'));
  await view.findByText('Preparando confirmación de Android…');
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); }); expect(view.getByText('Relay está bloqueado')).toBeVisible();
  await act(async () => revalidation.resolve(fixtureInstalled));
  expect(apkNative.install).not.toHaveBeenCalled(); expect(apkNative.retire).toHaveBeenCalled();
});

test('a manifest and native verification mismatch never offers installation or leaks native diagnostics', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  apkNative.verify.mockResolvedValue({ ...fixtureVerified, signerSha256: 'f'.repeat(64) });
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>); await view.findByText('Revisar versiones');
  fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK'));
  await view.findByText('La respuesta del Puente sobre la actualización no es válida.');
  expect(view.queryByText('VERIFICADO EN ESTE TELÉFONO')).toBeNull(); expect(apkNative.install).not.toHaveBeenCalled(); expect(apkNative.retire).toHaveBeenCalled();
});


test('Servidor administration opens its APK detail without downloading or installing from navigation', async () => {
  seed(); polling(serverA);
  respond(serverA.url, '/v1/server', json(serverInfo)); respond(serverA.url, '/v1/gateway', json({ state: 'stopped', pid: null, port: null, uptimeSeconds: null }));
  respond(serverA.url, '/v1/server/control', json({ paused: false, hermesPaused: false, phase: 'ready', action: null }));
  respond(serverA.url, '/v1/usage?period=week', json({ error: { code: 'unavailable', message: 'Fixture usage unsupported' } }, 503)); respond(serverA.url, '/v1/jobs', json({ jobs: [] })); respond(serverA.url, '/v1/logs?lines=100&level=DEBUG', json({ lines: [] }));
  const view = renderApp(<ChatVisibilityProvider value><ServerScreen serverId="A"/></ChatVisibilityProvider>); await view.findByText('DETENIDO');
  fireEvent.press(view.getByText('Actualización APK'));
  expect(router.push).toHaveBeenLastCalledWith({ pathname: '/app-update/[server]', params: { server: 'A' } });
  expect(requests.filter(r => r.path.startsWith(path))).toHaveLength(0); expect(apkNative.claim).not.toHaveBeenCalled(); expect(apkNative.install).not.toHaveBeenCalled();
});

test.each(['same-client', 'replacement'] as const)('late authorization headers after cancellation retire only the %s identity', async kind => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata());
  const old = deferred<Response>(); respond(serverA.url, path + '/apk', old.promise);
  let toggle!: (visible: boolean) => void;
  function Page() { const [visible, setVisible] = useState(true); toggle = setVisible; return <ChatVisibilityProvider value={visible}><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>; }
  const view = renderApp(<Page/>); await view.findByText('Revisar versiones');
  fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK'));
  await waitFor(() => expect(requests.filter(r => r.path === path + '/apk')).toHaveLength(1));
  if (kind === 'same-client') { act(() => toggle(false)); act(() => toggle(true)); }
  else { const replacement = { ...serverA, key: 'fixture-new-key' }; polling(replacement, [agentA]); await act(async () => { await view.probe.current!.replaceServer('A', replacement); }); }
  await view.findByText('Revisar versiones');
  await act(async () => old.resolve(json({ error: { code: 'device_revoked', message: 'private-late-fixture' } }, 403)));
  if (kind === 'same-client') {
    await view.findByText('LLAVE RECHAZADA'); expect(view.queryByText('1.3.0 · 4', { includeHiddenElements: true })).toBeNull();
    expect(view.queryByText('Revisar versiones')).toBeNull();
  } else { expect(view.getByText('Revisar versiones')).toBeVisible(); expect(view.queryByText('LLAVE RECHAZADA')).toBeNull(); }
  expect(view.queryByText('private-late-fixture')).toBeNull(); expect(apkNative.install).not.toHaveBeenCalled();
});

test('returning after hiding a verified APK never commits its retired verification before a fresh publication', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  let toggle!: (visible: boolean) => void; let view!: ReturnType<typeof renderApp>; let armed = false; const commits: boolean[] = [];
  function Page() { const [visible, setVisible] = useState(true); toggle = setVisible; return <Profiler id="apk-verified" onRender={() => { if (armed && view) commits.push(view.queryByText('VERIFICADO EN ESTE TELÉFONO') !== null); }}><ChatVisibilityProvider value={visible}><AppUpdateScreen serverId="A"/></ChatVisibilityProvider></Profiler>; }
  view = renderApp(<Page/>); await view.findByText('Revisar versiones'); fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK')); await view.findByText('VERIFICADO EN ESTE TELÉFONO');
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise);
  act(() => toggle(false)); armed = true; act(() => toggle(true)); await act(async () => {});
  expect(commits.length).toBeGreaterThan(0); expect(commits).not.toContain(true); expect(view.queryByText('Instalar · confirmar en Android')).toBeNull();
  expect(apkNative.retire).toHaveBeenCalled(); expect(apkNative.install).not.toHaveBeenCalled();
});

test('double taps serialize download and the separate install gesture', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>); await view.findByText('Revisar versiones'); fireEvent.press(view.getByText('Revisar versiones'));
  const download = view.getByText('Descargar APK'); act(() => { fireEvent.press(download); fireEvent.press(download); }); await view.findByText('VERIFICADO EN ESTE TELÉFONO');
  const install = view.getByText('Instalar · confirmar en Android'); act(() => { fireEvent.press(install); fireEvent.press(install); });
  await waitFor(() => expect(apkNative.install).toHaveBeenCalledTimes(1)); expect(requests.filter(r => r.path === path + '/apk')).toHaveLength(1);
});

test('unknown-source permission is an explicit Android gesture and returning never resumes a download', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); apkNative.info.mockResolvedValue({ ...fixtureInstalled, canInstall: false });
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>); await view.findByText('Permitir fuente en Android');
  expect(view.queryByText('Descargar APK')).toBeNull(); expect(apkNative.requestInstallPermission).not.toHaveBeenCalled();
  apkNative.requestInstallPermission.mockImplementation(async () => { emitAppState('background'); });
  fireEvent.press(view.getByText('Permitir fuente en Android')); await waitFor(() => expect(apkNative.requestInstallPermission).toHaveBeenCalledTimes(1));
  apkNative.info.mockResolvedValue(fixtureInstalled); act(() => emitAppState('active')); await view.findByText('Revisar versiones');
  expect(apkNative.retire).toHaveBeenCalled(); expect(requests.filter(r => r.path === path + '/apk')).toHaveLength(0); expect(apkNative.install).not.toHaveBeenCalled();
});

test.each(['unpublished', 'current', 'incompatible', 'unsupported', 'unavailable', 'busy', 'offline'] as const)('APK %s state is explicit and cannot start download or installation', async kind => {
  seed(); polling(serverA, [agentA]);
  let response = metadata(); let label = '';
  if (kind === 'unpublished') { response = json({ state: 'unpublished' }) as typeof response; label = 'NO DISPONIBLE · ACTUALIZA EL PUENTE'; }
  if (kind === 'current') { response = { ...json({ ...fixtureManifest, artifact: { ...fixtureManifest.artifact, versionCode: 3, versionName: '1.2.0' } }), headers: response.headers }; label = 'PUBLICACIÓN ACTUAL'; }
  if (kind === 'incompatible') { response = { ...json({ ...fixtureManifest, artifact: { ...fixtureManifest.artifact, applicationId: 'io.fixture.other' } }), headers: response.headers }; label = 'PUBLICACIÓN NO COMPATIBLE'; }
  if (kind === 'unsupported') { apkNative.info.mockResolvedValue({ ...fixtureInstalled, supported: false }); label = 'MÓDULO APK NO DISPONIBLE'; }
  if (kind === 'unavailable') { response = json({ error: { code: 'not_found', message: 'private-detail' } }, 404) as typeof response; label = 'Este Puente no ofrece actualización APK.'; }
  if (kind === 'busy') { response = json({ error: { code: 'busy', message: 'private-detail' } }, 429) as typeof response; label = 'El Puente está ocupado. Reintenta más tarde.'; }
  if (kind === 'offline') { respond(serverA.url, path, () => Promise.reject(new Error('private-detail'))); label = 'Sin conexión o sin respuesta. Reintenta cuando el Puente responda.'; }
  else respond(serverA.url, path, response);
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>); await view.findByText(label);
  expect(view.queryByText('Descargar APK')).toBeNull(); expect(view.queryByText('Instalar · confirmar en Android')).toBeNull(); expect(view.queryByText('private-detail')).toBeNull();
  expect(apkNative.claim).not.toHaveBeenCalled(); expect(apkNative.install).not.toHaveBeenCalled();
});


test('APK theme changes preserve the reviewed version and never start a download or installer',async()=>{
 seed();polling(serverA,[agentA]);respond(serverA.url,path,metadata());
 function Toggle(){const {setPreference}=useThemePreference();return <Pressable onPress={()=>setPreference('dark')}><Text>Choose dark APK</Text></Pressable>;}
 const view=renderApp(<ThemeProvider><Toggle/><ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider></ThemeProvider>);
 await view.findByText('COMPATIBLE SEGÚN PUBLICACIÓN');
 expect(view.getByLabelText('Actualización APK del Servidor')).toHaveStyle({backgroundColor:LIGHT_PALETTE.K.background});
 fireEvent.press(view.getByText('Revisar versiones'));await view.findByText('Descargar APK');
 const nativeClaims=apkNative.claim.mock.calls.length;
 fireEvent.press(view.getByText('Choose dark APK'));
 await waitFor(()=>expect(view.getByLabelText('Actualización APK del Servidor')).toHaveStyle({backgroundColor:DARK_PALETTE.K.background}));
 expect(view.getByText('Descargar APK')).toBeEnabled();expect(requests.filter(r=>r.path===path+'/apk')).toHaveLength(0);
 expect(apkNative.claim).toHaveBeenCalledTimes(nativeClaims);expect(apkNative.install).not.toHaveBeenCalled();
});

test('independent SPEC: Android window blur permanently retires a pending APK verification',async()=>{
 const {emitAppBlur,emitAppFocus}=require('../support/native');biometrics.authenticateAsync.mockResolvedValue({success:true});
 seed();polling(serverA,[agentA]);respond(serverA.url,path,metadata());respond(serverA.url,path+'/apk',apk());
 const verification=deferred<typeof fixtureVerified>();apkNative.verify.mockReturnValue(verification.promise);
 const view=renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>);await view.findByText('Revisar versiones');
 fireEvent.press(view.getByText('Revisar versiones'));fireEvent.press(view.getByText('Descargar APK'));await view.findByText('Verificando APK local…');
 act(()=>emitAppBlur());act(()=>emitAppFocus());await act(async()=>verification.resolve(fixtureVerified));
 console.log('SPEC_APK_WINDOW_BLUR',JSON.stringify({verified:!!view.queryByText('VERIFICADO EN ESTE TELÉFONO'),installVisible:!!view.queryByText('Instalar · confirmar en Android'),retired:apkNative.retire.mock.calls.length}));
 expect(view.queryByText('VERIFICADO EN ESTE TELÉFONO')).toBeNull();expect(view.queryByText('Instalar · confirmar en Android')).toBeNull();
});


test('independent SPEC: Android blur retires an install gesture waiting for installed identity',async()=>{
 const {emitAppBlur,emitAppFocus}=require('../support/native');biometrics.authenticateAsync.mockResolvedValue({success:true});
 seed();polling(serverA,[agentA]);respond(serverA.url,path,metadata());respond(serverA.url,path+'/apk',apk());
 const view=renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>);await view.findByText('Revisar versiones');
 fireEvent.press(view.getByText('Revisar versiones'));fireEvent.press(view.getByText('Descargar APK'));await view.findByText('VERIFICADO EN ESTE TELÉFONO');
 const info=deferred<typeof fixtureInstalled>();apkNative.info.mockReturnValueOnce(info.promise);fireEvent.press(view.getByText('Instalar · confirmar en Android'));await view.findByText('Preparando confirmación de Android…');
 act(()=>emitAppBlur());act(()=>emitAppFocus());await act(async()=>info.resolve(fixtureInstalled));
 console.log('SPEC_APK_BLUR_INSTALL',JSON.stringify({installCalls:apkNative.install.mock.calls.length}));expect(apkNative.install).not.toHaveBeenCalled();
});

test.each(['separate', 'batched'] as const)('Android window %s blur/focus never commits a retired verified APK before the fresh reading', async kind => {
  const { emitAppBlur, emitAppFocus } = require('../support/native');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); respond(serverA.url, path + '/apk', apk());
  let view!: ReturnType<typeof renderApp>; let armed = false; const commits: boolean[] = [];
  view = renderApp(<Profiler id="apk-window-focus" onRender={() => { if (armed) commits.push(view.queryByText('VERIFICADO EN ESTE TELÉFONO', { includeHiddenElements: true }) !== null); }}><LockGate><AppUpdateScreen serverId="A"/></LockGate></Profiler>);
  await view.findByText('Revisar versiones'); fireEvent.press(view.getByText('Revisar versiones')); fireEvent.press(view.getByText('Descargar APK')); await view.findByText('VERIFICADO EN ESTE TELÉFONO');
  const fresh = deferred<Response>(); respond(serverA.url, path, fresh.promise); armed = true;
  if (kind === 'batched') act(() => { emitAppBlur(); emitAppFocus(); });
  else { act(() => emitAppBlur()); act(() => emitAppFocus()); }
  expect(apkNative.retire).toHaveBeenCalledWith('private-fixture-1');
  expect(commits.length).toBeGreaterThan(0); expect(commits).not.toContain(true);
  expect(view.queryByText('Instalar · confirmar en Android', { includeHiddenElements: true })).toBeNull();
  await act(async () => fresh.resolve(metadata())); await view.findByText('Revisar versiones');
  expect(view.queryByText('Descargar APK')).toBeNull(); expect(apkNative.install).not.toHaveBeenCalled();
  expect(requests.filter(request => request.path === path + '/apk')).toHaveLength(1);
});

test('Android window blur retires a reviewed download gesture even when focus returns in the same batch', async () => {
  const { emitAppBlur, emitAppFocus } = require('../support/native');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata());
  const view = renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>); await view.findByText('Revisar versiones');
  fireEvent.press(view.getByText('Revisar versiones')); const staleDownload = view.getByText('Descargar APK');
  act(() => { emitAppBlur(); fireEvent.press(staleDownload); emitAppFocus(); });
  await view.findByText('Revisar versiones'); expect(view.queryByText('Descargar APK')).toBeNull();
  expect(apkNative.claim).not.toHaveBeenCalled(); expect(apkNative.install).not.toHaveBeenCalled();
  expect(requests.filter(request => request.path === path + '/apk')).toHaveLength(0);
});

test('Android window blur rejects a retained permission button and returning requires a new permission gesture', async () => {
  const { emitAppBlur, emitAppFocus } = require('../support/native');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); apkNative.info.mockResolvedValue({ ...fixtureInstalled, canInstall: false });
  const view = renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>); await view.findByText('Permitir fuente en Android');
  const stalePermission = view.getByText('Permitir fuente en Android');
  act(() => { emitAppBlur(); fireEvent.press(stalePermission); emitAppFocus(); });
  await view.findByText('Permitir fuente en Android');
  expect(apkNative.claim).not.toHaveBeenCalled(); expect(apkNative.requestInstallPermission).not.toHaveBeenCalled();
  fireEvent.press(view.getByText('Permitir fuente en Android'));
  await waitFor(() => expect(apkNative.requestInstallPermission).toHaveBeenCalledTimes(1));
  expect(apkNative.install).not.toHaveBeenCalled(); expect(requests.filter(request => request.path === path + '/apk')).toHaveLength(0);
});

test('Android window blur permanently retires a permission request pending at the native boundary', async () => {
  const { emitAppBlur, emitAppFocus } = require('../support/native');
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata()); apkNative.info.mockResolvedValue({ ...fixtureInstalled, canInstall: false });
  const permission = deferred<void>(); apkNative.requestInstallPermission.mockReturnValue(permission.promise);
  const view = renderApp(<LockGate><AppUpdateScreen serverId="A"/></LockGate>); await view.findByText('Permitir fuente en Android');
  fireEvent.press(view.getByText('Permitir fuente en Android')); await waitFor(() => expect(apkNative.requestInstallPermission).toHaveBeenCalledTimes(1));
  act(() => { emitAppBlur(); emitAppFocus(); });
  expect(apkNative.retire).toHaveBeenCalledWith('private-fixture-1'); await view.findByText('Permitir fuente en Android');
  await act(async () => permission.resolve());
  expect(apkNative.requestInstallPermission).toHaveBeenCalledTimes(1); expect(apkNative.claim).toHaveBeenCalledTimes(1);
  expect(requests.filter(request => request.path === path)).toHaveLength(2);
  expect(apkNative.install).not.toHaveBeenCalled(); expect(requests.filter(request => request.path === path + '/apk')).toHaveLength(0);
});

test('a publication reads as label/value rows with one primary key and «Actualizar publicación» secondary', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, metadata());
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>);
  await view.findByText('COMPATIBLE SEGÚN PUBLICACIÓN');
  for (const [label, value] of [['PAQUETE', 'io.fixture.relay'], ['COMPILACIÓN', 'ccccccc · 0.00 MiB']]) { expect(view.getByText(label)).toBeVisible(); expect(view.getByText(value)).toBeVisible(); }
  expect(view.queryByText('REVISAR VERSIONES')).toBeNull(); expect(view.queryByText('ACTUALIZAR PUBLICACIÓN')).toBeNull();
  expect(view.getByText('Actualizar publicación')).toBeEnabled();
  expect(view.getByText('La publicación declara que es compatible; la verificación en este teléfono se hace después de descargar. Revisa las dos versiones antes de seguir.')).toBeVisible();
});

test.each([['unpublished', 'NO DISPONIBLE · ACTUALIZA EL PUENTE', 'Este Puente no tiene un APK publicado.'], ['unsupported', 'MÓDULO APK NO DISPONIBLE', 'Necesitas Android 12 o posterior.']] as const)('APK %s is a screen state with the D-ES phrase', async (kind, title, phrase) => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, path, kind === 'unpublished' ? json({ state: 'unpublished' }) : metadata());
  if (kind === 'unsupported') apkNative.info.mockResolvedValue({ ...fixtureInstalled, supported: false });
  const view = renderApp(<ChatVisibilityProvider value><AppUpdateScreen serverId="A"/></ChatVisibilityProvider>);
  await view.findByText(title); expect(view.getByText(phrase)).toBeVisible();
});
