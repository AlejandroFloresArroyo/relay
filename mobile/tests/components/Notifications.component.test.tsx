import { Pressable, Text } from 'react-native';
import { ThemeProvider, useThemePreference } from '@/theme/ThemeProvider';
import { DARK_PALETTE, LIGHT_PALETTE } from '@/theme/tokens';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { T } from '@/ui/primitives';
import { NotificationProvider } from '@/state/notifications';
import { notificationCacheKey } from '@/core/notificationCache';
import { LockGate } from '@/screens/LockGate';
import { NotificationNoticeScreen } from '@/screens/NotificationNoticeScreen';
import { NotificationSettingsScreen } from '@/screens/NotificationSettingsScreen';
import { polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { biometrics, router as routeBoundary, clockStart, deferred, emitAppState, emitAppBlur, emitAppFocus, navigation, secureStore, stored } from '../support/native';
import { notificationNative, notificationCacheScope } from '../support/notifications';
import { renderApp } from '../support/renderApp';
import { json, networkError, respond, requestsFor } from '../support/transport';

import { useState as reviewUseState } from 'react';
test('review-independent terminal refusal from previous route must retire preferences already loaded by current route',async()=>{
 let showSettings!:()=>void;
 function Routes(){
  const [settingsRoute,setSettingsRoute]=reviewUseState(false);showSettings=()=>setSettingsRoute(true);
  return <NotificationProvider><LockGate>{settingsRoute?<NotificationSettingsScreen serverId="A"/>:<NotificationNoticeScreen serverId="A" noticeId="notice-A"/>}</LockGate></NotificationProvider>;
 }
 seed([serverA],{...settings,faceid:false});polling(serverA);
 respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 const app=renderApp(<Routes/>);await app.ready();await screen.findByText('echo synthetic-private-command');
 const owner=app.probe.current!.clientFor('A');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 await act(async()=>showSettings());await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.getByText('Configurado')).toBeVisible();
 expect(app.probe.current!.clientFor('A')).toBe(owner);
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(notificationNative.forget).toHaveBeenCalledWith('A');
 expect(app.probe.current!.clientFor('A')).toBe(owner);
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 expect(screen.queryByText('Configurado')).toBeNull();
});

const status={schema:1,configured:true,transport:'ntfy-unifiedpush',availableKinds:['approval'],preferences:{enabled:false,types:{approval:true,task:true,error:true,server:true},preview:'generic'},revision:0,registration:null,delivery:'disabled',serverNow:clockStart};
const notice={schema:1,noticeId:'notice-A',registrationId:'registration-A',kind:'approval',target:{agentId:'agentA',runId:'run-A',approvalId:'approval-A'},approval:{id:'approval-A',agentId:'agentA',agentName:'Agente A',runId:'run-A',command:'echo synthetic-private-command',createdAt:clockStart,expiresAt:clockStart+300000,choices:['once','deny'],risk:null,cwd:null,reason:null,affects:null},expiresAt:clockStart+300000,serverNow:clockStart,state:'pending'};
async function mount(kind:'notice'|'settings',faceid=false) {
 seed([serverA],{...settings,faceid});polling(serverA);
 respond(serverA.url,'/v1/notifications',json(status));respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 const app=renderApp(<NotificationProvider><LockGate>{kind==='notice'?<NotificationNoticeScreen serverId="A" noticeId="notice-A"/>:<NotificationSettingsScreen serverId="A"/>}</LockGate></NotificationProvider>);await app.ready();return app;
}
test('Review shows a fresh command without biometrics; approve needs a new strong fingerprint and the exact target',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 biometrics.authenticateAsync.mockResolvedValue({success:true});await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({disableDeviceFallback:true,biometricsSecurityLevel:'strong'}));
 const posts=requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision');expect(posts).toHaveLength(1);expect(posts[0].body).toEqual({schema:1,registrationId:'registration-A',target:notice.target,choice:'once'});
 expect(screen.getByText('Aprobado')).toBeVisible();
 expect(notificationNative.clearNotice).toHaveBeenCalledWith('A','notice-A');
});
test('notification permission is requested only by gesture and unsupported producers remain unavailable',async()=>{
 await mount('settings');await screen.findByText('Avisos');expect(notificationNative.requestPermission).not.toHaveBeenCalled();
 expect(screen.getByRole('switch',{name:'Tareas'})).toBeDisabled();
 notificationNative.requestPermission.mockResolvedValue({granted:true});notificationNative.permission.mockReturnValue(true);
 await act(async()=>fireEvent.press(screen.getByText('Permitir avisos en Android')));
 expect(notificationNative.requestPermission).toHaveBeenCalledTimes(1);expect(requestsFor(serverA.url,'/v1/notifications/registration')).toHaveLength(0);
});

test('Tareas, Errores and Servidor say «No disponible en este Puente» and are dim and disabled when the Puente lacks them; Aprobaciones is not',async()=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 expect(screen.getAllByText('No disponible en este Puente')).toHaveLength(3);
 for(const label of ['Tareas','Errores','Servidor']){
  const row=screen.getByRole('switch',{name:label});
  expect(row).toBeDisabled();expect(row).toHaveStyle({opacity:0.45});
  expect(within(row).getByText('No disponible en este Puente')).toBeVisible();
 }
 expect(screen.getByRole('switch',{name:'Aprobaciones'})).not.toHaveStyle({opacity:0.45});
});

test('a Puente that offers every kind leaves Tareas, Errores and Servidor enabled',async()=>{
 notificationNative.permission.mockReturnValue(true);
 const all={...status,revision:1,availableKinds:['approval','task','error','server'],preferences:{...status.preferences,enabled:true},registration:{id:'all-kind-registration',expiresAt:clockStart+604800000},delivery:'unknown'};
 seed([serverA],{...settings,faceid:false});polling(serverA);respond(serverA.url,'/v1/notifications',json(all));
 const app=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await app.ready();
 await screen.findByText('Configurado');
 await waitFor(()=>expect(screen.getByRole('switch',{name:'Servidor'})).not.toBeDisabled());
 expect(screen.queryByText('No disponible en este Puente')).toBeNull();
 expect(screen.getByRole('switch',{name:'Errores'})).not.toHaveStyle({opacity:0.45});
});

test('explicit private distributor enrollment uses device CAS and only available preference controls',async()=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 expect(notificationNative.begin).not.toHaveBeenCalled();
 const registered={...status,revision:1,preferences:{...status.preferences,enabled:true},registration:{id:'registration-A',expiresAt:clockStart+604800000},delivery:'unknown'};
 respond(serverA.url,'/v1/notifications/registration',json(registered),'PUT');
 await act(async()=>fireEvent.press(screen.getByText('Activar con ntfy privado')));
 const writes=requestsFor(serverA.url,'/v1/notifications/registration');expect(writes).toHaveLength(1);
 expect(writes[0].body).toEqual({schema:1,revision:0,endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',preferences:registered.preferences});
 expect(notificationNative.begin).toHaveBeenCalledWith(JSON.stringify({serverId:'A',url:serverA.url,key:serverA.key,deviceId:serverA.deviceId}),'io.heckel.ntfy');
 expect(notificationNative.commit).toHaveBeenCalledWith('A',1,JSON.stringify(registered));
 expect(screen.getByRole('switch',{name:'Aprobaciones'})).not.toBeDisabled();
 expect(screen.getByRole('switch',{name:'Tareas'})).toBeDisabled();
 const disabled={...registered,revision:2,preferences:{...registered.preferences,enabled:false},registration:null,delivery:'disabled'};
 respond(serverA.url,'/v1/notifications/registration',json(disabled),'DELETE');
 await act(async()=>fireEvent.press(screen.getByRole('switch',{name:'Avisos de este Servidor'})));
 expect(requestsFor(serverA.url,'/v1/notifications/registration').find(request=>request.method==='DELETE')!.body).toEqual({schema:1,revision:1});
 expect(notificationNative.forget).toHaveBeenCalledWith('A');
});


test('a notification authorization refusal purges cached preferences before offline fallback',async()=>{
 await mount('settings');await screen.findByText('Configurado');
 const key=notificationCacheKey(notificationCacheScope(serverA));await waitFor(()=>expect(stored.has(key)).toBe(true));
 respond(serverA.url,'/v1/notifications',json({error:{code:'device_revoked'}},403));
 await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active')); 
 await screen.findByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.');
 await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(notificationNative.forget).toHaveBeenCalledWith('A');
 expect(screen.queryByText('Configurado')).toBeNull();
});

test('AppProvider polling retires a pending cache write and an offline remount cannot resurrect it',async()=>{
 const release=deferred<void>();const key=notificationCacheKey(notificationCacheScope(serverA));
 secureStore.setItemAsync.mockImplementation(async(name,value)=>{if(name===key)await release.promise;stored.set(name,value);});
 const app=await mount('settings');await screen.findByText('Configurado');
 await waitFor(()=>expect(secureStore.setItemAsync).toHaveBeenCalledWith(key,expect.any(String)));
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));
 await act(async()=>app.probe.current!.refresh('A'));await screen.findByText('DISPOSITIVO REVOCADO');
 await act(async()=>release.resolve());await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(notificationNative.reconcile.mock.calls.some(([raw])=>JSON.parse(raw).some((scope:{revoked:boolean})=>scope.revoked))).toBe(true);
 await act(async()=>app.unmount());
 respond(serverA.url,'/v1/agents',json({error:{code:'unreachable'}},503));
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const offline=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await offline.ready();
 await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.queryByText('Configurado')).toBeNull();
});


test.each(['blur','background','navigation','scope','unmount','revocation'] as const)('late approval fingerprint is permanently invalid after %s, even when visible again',async event=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 await waitFor(()=>expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 if(event==='blur'){await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());}
 if(event==='background'){await act(async()=>emitAppState('background'));await act(async()=>emitAppState('active'));}
 if(event==='navigation'){
   navigation.focused=false;await act(async()=>app.probe.current!.refresh('A'));
   navigation.focused=true;await act(async()=>app.probe.current!.refresh('A'));
 }
 if(event==='scope'){
   await act(async()=>app.probe.current!.replaceServer('A',{name:'Servidor nuevo',url:serverA.url,key:'synthetic-rotated-key',deviceId:'synthetic-rotated-device'}));
   await act(async()=>app.probe.current!.replaceServer('A',serverA));
 }
 if(event==='unmount')await act(async()=>app.unmount());
 if(event==='revocation'){
   respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));
   await act(async()=>app.probe.current!.refresh('A'));await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.label).toBe('DISPOSITIVO REVOCADO'));
 }
 await act(async()=>auth.resolve({success:true}));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
});

test('LockGate auto-lock retires an approval fingerprint even after a separate unlock succeeds',async()=>{
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 const app=await mount('notice',true);await screen.findByText('echo synthetic-private-command');
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 await act(async()=>jest.advanceTimersByTimeAsync(60001));await screen.findByText('Relay está bloqueado');
 biometrics.authenticateAsync.mockResolvedValueOnce({success:true});
 await act(async()=>fireEvent.press(screen.getByText('Usar el código del teléfono')));
 await screen.findByText('echo synthetic-private-command');
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 await act(async()=>auth.resolve({success:true}));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
 expect(app.probe.current!.settings.faceid).toBe(true);
});

test('fresh command changes and server expiry after fingerprint prevent a POST',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 const auth=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 respond(serverA.url,'/v1/notifications/notices/notice-A',json({...notice,serverNow:notice.expiresAt+1}));
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 await act(async()=>auth.resolve({success:true}));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
 await screen.findByText('El comando cambió o expiró. Revísalo antes de decidir.');
});


test('blur after the last fresh read started blocks a decision even when the read succeeds later',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 const read=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A',read.promise);
 biometrics.authenticateAsync.mockResolvedValue({success:true});
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A')).toHaveLength(2);
 await act(async()=>emitAppBlur());
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 await act(async()=>read.resolve(json(notice)));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
});

test('an opposite or uncertain ACK cannot become success or allow an automatic resend',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'rejected'}),'POST');
 biometrics.authenticateAsync.mockResolvedValue({success:true});
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 await screen.findByText('DECISIÓN SIN CONFIRMAR. Relay no la enviará otra vez.');
 expect(screen.queryByText('Aprobado')).toBeNull();expect(screen.queryByText('Aprobar con huella')).toBeNull();
 await act(async()=>jest.advanceTimersByTimeAsync(10000));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});


test('lease renewal is an explicit gesture, rotates its registration and preserves per-device preferences',async()=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 const enrolled={...status,revision:4,preferences:{...status.preferences,enabled:true,types:{...status.preferences.types,approval:false}},registration:{id:'old-registration',expiresAt:clockStart+10000},delivery:'unknown'};
 respond(serverA.url,'/v1/notifications',json(enrolled));
 await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());await screen.findByText('Renovar inscripción');
 expect(notificationNative.begin).not.toHaveBeenCalled();
 const renewed={...enrolled,revision:5,registration:{id:'renewed-registration',expiresAt:clockStart+604800000}};
 respond(serverA.url,'/v1/notifications/registration',json(renewed),'PUT');
 await act(async()=>fireEvent.press(screen.getByText('Renovar inscripción')));
 expect(requestsFor(serverA.url,'/v1/notifications/registration')[0].body).toEqual({schema:1,revision:4,endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',preferences:enrolled.preferences});
 expect(notificationNative.commit).toHaveBeenCalledWith('A',1,JSON.stringify(renewed));
 expect(notificationNative.begin).toHaveBeenCalledWith(JSON.stringify({serverId:'A',url:serverA.url,key:serverA.key,deviceId:serverA.deviceId}),'io.heckel.ntfy');
});


test('a fresh changed command requires another review and fingerprint before any decision',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 respond(serverA.url,'/v1/notifications/notices/notice-A',json({...notice,approval:{...notice.approval,command:'echo changed-synthetic-command'}}));
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 biometrics.authenticateAsync.mockResolvedValue({success:true});
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 await screen.findByText('echo changed-synthetic-command');
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
 expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
});

test('a local notification cleanup failure cannot relabel the confirmed server ACK as uncertain',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'approved'}),'POST');
 biometrics.authenticateAsync.mockResolvedValue({success:true});
 notificationNative.clearNotice.mockImplementation(()=>{throw new Error('Synthetic local storage failure');});
 await act(async()=>fireEvent.press(screen.getByText('Aprobar con huella')));
 expect(screen.getByText('Aprobado')).toBeVisible();
 expect(screen.queryByText('Decisión sin confirmar')).toBeNull();
 expect(screen.getByText('El aviso de Android no se retiró. La Decisión confirmada se conserva.')).toBeVisible();
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});


test('a terminal unknown notice never claims a confirmed decision when Android cleanup fails',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 notificationNative.clearNotice.mockImplementation(()=>{throw new Error('Synthetic local failure');});
 respond(serverA.url,'/v1/notifications/notices/notice-A',json({...notice,state:'unknown'}));
 await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());
 await screen.findByText('Aviso desconocido');
 expect(screen.queryByText('El aviso de Android no se retiró. La Decisión confirmada se conserva.')).toBeNull();
 await screen.findByText('El aviso de Android no se retiró.');
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
});


test.each(['task','error','server'] as const)('a native generic %s gesture opens Relay through LockGate without any decision or private lookup',async kind=>{
 seed([serverA],{...settings,faceid:true});polling(serverA);
 const unlock=deferred<{success:boolean}>();biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
 notificationNative.takeOpen.mockReturnValueOnce({serverId:'A',noticeId:'generic-notice',kind});
 const app=renderApp(<NotificationProvider><LockGate><T>Relay seguro</T></LockGate></NotificationProvider>);await app.ready();
 await screen.findByText('Relay está bloqueado');
 expect(routeBoundary.dismissTo).toHaveBeenCalledWith('/board');
 expect(app.probe.current!.selectedServer).toBe('A');
 expect(requestsFor(serverA.url,'/v1/notifications/notices/generic-notice')).toHaveLength(0);
 expect(requestsFor(serverA.url,'/v1/notifications/notices/generic-notice/decision')).toHaveLength(0);
 await act(async()=>unlock.resolve({success:true}));await screen.findByText('Relay seguro');
 expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
 expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({promptMessage:'Desbloquear Relay con huella',disableDeviceFallback:false}));
});


test.each([['task','Tareas'],['error','Errores'],['server','Servidor']] as const)('preference %s is enabled only when the paired Puente advertises its producer',async(kind,label)=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 const active={...status,revision:1,availableKinds:['approval','task','error','server'],preferences:{...status.preferences,enabled:true},registration:{id:'all-kind-registration',expiresAt:clockStart+604800000},delivery:'unknown'};
 respond(serverA.url,'/v1/notifications',json(active));
 await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());
 await waitFor(()=>expect(screen.getByRole('switch',{name:label})).not.toBeDisabled());
 const next={...active,revision:2,registration:{...active.registration,id:'next-registration'},preferences:{...active.preferences,types:{...active.preferences.types,[kind]:false}}};
 respond(serverA.url,'/v1/notifications/registration',json(next),'PUT');
 await act(async()=>fireEvent.press(screen.getByRole('switch',{name:label})));
 expect(requestsFor(serverA.url,'/v1/notifications/registration')[0].body).toEqual({schema:1,revision:1,endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',preferences:next.preferences});
 expect(notificationNative.begin).not.toHaveBeenCalled();
});


test('a local enrollment read failure is shown without crashing or submitting a renewal',async()=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 const active={...status,revision:1,preferences:{...status.preferences,enabled:true},registration:{id:'registration-A',expiresAt:clockStart+604800000},delivery:'unknown'};
 respond(serverA.url,'/v1/notifications',json(active));
 await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());await screen.findByText('Renovar inscripción');
 notificationNative.status.mockImplementation(()=>{throw new Error('Synthetic private local state unavailable');});
 await act(async()=>fireEvent.press(screen.getByText('Renovar inscripción')));
 await screen.findByText('No se pudo consultar la inscripción de Android. Reintenta.');
 expect(requestsFor(serverA.url,'/v1/notifications/registration')).toHaveLength(0);
});


test.each(['settings','notice'] as const)('changing theme preserves %s without enrollment or a Decisión',async kind=>{
 seed([serverA],{...settings,faceid:false});polling(serverA);respond(serverA.url,'/v1/notifications',json(status));respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 function Toggle(){const {setPreference}=useThemePreference();return <Pressable onPress={()=>setPreference('dark')}><Text>Choose dark notices</Text></Pressable>;}
 const view=renderApp(<ThemeProvider><Toggle/><NotificationProvider><LockGate>{kind==='notice'?<NotificationNoticeScreen serverId="A" noticeId="notice-A"/>:<NotificationSettingsScreen serverId="A"/>}</LockGate></NotificationProvider></ThemeProvider>);await view.ready();await screen.findByText(kind==='notice'?'echo synthetic-private-command':'Configurado');
 const label=kind==='notice'?'Aprobación desde aviso':'Ajustes de avisos del Servidor';
 expect(view.getByLabelText(label)).toHaveStyle({backgroundColor:LIGHT_PALETTE.K.background});
 const nativeReads=notificationNative.request.mock.calls.length;
 await act(async()=>fireEvent.press(view.getByText('Choose dark notices')));
 expect(view.getByLabelText(label)).toHaveStyle({backgroundColor:DARK_PALETTE.K.background});
 expect(view.getByText(kind==='notice'?'echo synthetic-private-command':'Configurado')).toBeVisible();
 expect(notificationNative.request).toHaveBeenCalledTimes(nativeReads);expect(notificationNative.begin).not.toHaveBeenCalled();expect(notificationNative.commit).not.toHaveBeenCalled();expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test('SPEC: a decision device_revoked retires the private command and preference cache across remounts',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({error:{code:'device_revoked',message:'opaque'}},403),'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await screen.findByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.');
 expect(screen.queryByText('echo synthetic-private-command')).toBeNull();await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(notificationNative.forget).toHaveBeenCalledWith('A');
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 await act(async()=>app.unmount());
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const offline=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await offline.ready();
 await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.queryByText('Configurado')).toBeNull();expect(stored.has(key)).toBe(false);
});


test('SPEC: a terminal refusal during the fresh decision read also retires the command',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 respond(serverA.url,'/v1/notifications/notices/notice-A',json({error:{code:'device_revoked'}},403));
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 await screen.findByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.');
 expect(screen.queryByText('echo synthetic-private-command')).toBeNull();await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
});

test('SPEC: an old decision refusal cannot retire the replacement client or its cache',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 const replacement={...serverA,key:'synthetic-new-key'};
 polling(replacement);respond(replacement.url,'/v1/notifications/notices/notice-A',json({...notice,approval:{...notice.approval,command:'echo synthetic-new-command'}}));
 await act(async()=>app.probe.current!.replaceServer('A',replacement));await screen.findByText('echo synthetic-new-command');
 const key=notificationCacheKey(notificationCacheScope(replacement));stored.set(key,JSON.stringify(status));notificationNative.forget.mockClear();
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(screen.getByText('echo synthetic-new-command')).toBeVisible();expect(stored.has(key)).toBe(true);
 expect(notificationNative.forget).not.toHaveBeenCalled();expect(screen.queryByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.')).toBeNull();
});

test('SPEC: decision revocation retires a preference write that finishes late before offline remount',async()=>{
 const release=deferred<void>();const key=notificationCacheKey(notificationCacheScope(serverA));
 secureStore.setItemAsync.mockImplementation(async(name,value)=>{if(name===key)await release.promise;stored.set(name,value);});
 seed([serverA],{...settings,faceid:false});polling(serverA);respond(serverA.url,'/v1/notifications',json(status));respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 const app=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/><NotificationNoticeScreen serverId="A" noticeId="notice-A"/></LockGate></NotificationProvider>);await app.ready();
 await screen.findByText('echo synthetic-private-command');await waitFor(()=>expect(secureStore.setItemAsync).toHaveBeenCalledWith(key,expect.any(String)));
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({error:{code:'device_revoked'}},403),'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await screen.findByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.');
 expect(screen.queryByText('echo synthetic-private-command')).toBeNull();await act(async()=>release.resolve());await waitFor(()=>expect(stored.has(key)).toBe(false));
 await act(async()=>app.unmount());respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const offline=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await offline.ready();await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.queryByText('Configurado')).toBeNull();expect(stored.has(key)).toBe(false);
});


test('integration SPEC: replacing only the key cannot inherit persisted preferences offline after remount',async()=>{
 const app=await mount('settings');await screen.findByText('Configurado');
 const oldKey=notificationCacheKey(notificationCacheScope(serverA));await waitFor(()=>expect(stored.has(oldKey)).toBe(true));
 await act(async()=>app.unmount());const replacement={...serverA,key:'synthetic-key-only-replacement'};seed([replacement],{...settings,faceid:false});polling(replacement);
 respond(replacement.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const next=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await next.ready();await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.queryByText('Configurado')).toBeNull();
});

test('integration SPEC: replacing only the key after a terminal refusal enables the new client without provider remount',async()=>{
 const app=await mount('settings');await screen.findByText('Configurado');
 respond(serverA.url,'/v1/notifications',json({error:{code:'device_revoked'}},403));await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());
 await screen.findByText('Este teléfono no está autorizado. Empareja de nuevo el Servidor.');
 const replacement={...serverA,key:'synthetic-key-only-replacement'};polling(replacement);respond(replacement.url,'/v1/notifications',json(status));
 const before=requestsFor(serverA.url,'/v1/notifications').length;
 await act(async()=>app.probe.current!.replaceServer('A',replacement));
 await screen.findByText('Configurado');expect(requestsFor(serverA.url,'/v1/notifications').length).toBeGreaterThan(before);
 expect(notificationCacheScope(replacement)).not.toBe(notificationCacheScope(serverA));
});

test('integration SPEC: replacing only the key retires the old pending cache write and keeps the new scope usable',async()=>{
 const oldKey=notificationCacheKey(notificationCacheScope(serverA));const release=deferred<void>();
 secureStore.setItemAsync.mockImplementation(async(name,value)=>{if(name===oldKey)await release.promise;stored.set(name,value);});
 const app=await mount('settings');await screen.findByText('Configurado');await waitFor(()=>expect(secureStore.setItemAsync).toHaveBeenCalledWith(oldKey,expect.any(String)));
 const replacement={...serverA,key:'synthetic-key-only-replacement'};polling(replacement);respond(replacement.url,'/v1/notifications',json({...status,revision:2}));
 await act(async()=>app.probe.current!.replaceServer('A',replacement));await act(async()=>release.resolve());
 await waitFor(()=>expect(stored.has(oldKey)).toBe(false));
 const newKey=notificationCacheKey(notificationCacheScope(replacement));await waitFor(()=>expect(stored.has(newKey)).toBe(true));
 expect(JSON.parse(stored.get(newKey)!)).toEqual({...status,revision:2});expect(newKey).not.toBe(oldKey);
 expect(notificationCacheScope(replacement)).not.toContain(replacement.key);expect(newKey).not.toContain(replacement.key);
});

test('review-independent terminal decision refusal while hidden must purge the captured preference cache',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 await act(async()=>emitAppBlur());
 await act(async()=>response.resolve(json({error:{code:'device_revoked',message:'opaque'}},403)));
 // Real JS storage, no mirror: hidden presentation must not erase the authorization fact.
 expect(stored.has(key)).toBe(false);
 await act(async()=>app.unmount());
});

test('review-independent terminal decision refusal while hidden cannot restore private metadata on an offline remount',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 await act(async()=>emitAppBlur());await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 await act(async()=>app.unmount());
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const offline=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);
 await offline.ready();await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.queryByText('Configurado')).toBeNull();
});


test.each(['background','navigation','unmount','expiry'] as const)('terminal retirement remains causal after %s without authorizing another action',async(event)=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 if(event==='background')await act(async()=>emitAppState('background'));
 if(event==='navigation'){navigation.focused=false;await act(async()=>app.probe.current!.refresh('A'));}
 if(event==='unmount')await act(async()=>app.unmount());
 if(event==='expiry')await act(async()=>jest.advanceTimersByTimeAsync(60001));
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(stored.has(key)).toBe(false);expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});

test('hidden refusal cannot retire a later enrollment of the same pairing',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await act(async()=>emitAppBlur());
 const newer={...status,revision:2};stored.set(key,JSON.stringify(newer));
 notificationNative.status.mockReturnValue({generation:2,state:'registered',endpoint:'http://ntfy.fixture.ts.net/upSyntheticNewEndpoint123?up=1',distributor:'io.heckel.ntfy'});
 notificationNative.forget.mockClear();await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(stored.get(key)).toBe(JSON.stringify(newer));expect(notificationNative.forget).not.toHaveBeenCalled();
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
 await act(async()=>app.unmount());
});

test('hidden refusal cannot retire a replacement key or another Server',async()=>{
 const app=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await act(async()=>emitAppBlur());
 const replacement={...serverA,key:'synthetic-key-after-blur'};polling(replacement);await act(async()=>app.probe.current!.replaceServer('A',replacement));
 const replacementKey=notificationCacheKey(notificationCacheScope(replacement));stored.set(replacementKey,JSON.stringify({...status,revision:2}));
 const otherKey=notificationCacheKey(notificationCacheScope({...serverA,id:'B',key:'synthetic-key-B'}));stored.set(otherKey,JSON.stringify({...status,revision:3}));notificationNative.forget.mockClear();
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(stored.has(replacementKey)).toBe(true);expect(stored.has(otherKey)).toBe(true);expect(notificationNative.forget).not.toHaveBeenCalled();
});

test('a settings read authorization fact retires its cache even after blur',async()=>{
 await mount('settings');await screen.findByText('Configurado');
 const key=notificationCacheKey(notificationCacheScope(serverA));await waitFor(()=>expect(stored.has(key)).toBe(true));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications',response.promise);
 await act(async()=>emitAppBlur());await act(async()=>emitAppFocus());await act(async()=>emitAppBlur());
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(stored.has(key)).toBe(false);
});


test('independent SPEC: cached polling denial cannot permanently retire replacement notification credentials',async()=>{
 const app=await mount('settings');await screen.findByText('Configurado');
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked',message:'opaque'}},403));
 await act(async()=>app.probe.current!.refresh('A'));
 await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.action).toBe('pair'));
 const replacement={...serverA,key:'synthetic-new-poll-owner'};
 const pending=deferred<Response>();respond(replacement.url,'/v1/agents',pending.promise);
 respond(replacement.url,'/v1/notifications',json({...status,revision:2}));
 await act(async()=>app.probe.current!.replaceServer('A',replacement));
 await act(async()=>pending.resolve(json({agents:[]})));
 await waitFor(()=>expect(app.probe.current!.snapshot('A').reachable).toBe(true));
 console.log('SPEC_NOTICE_POLL_REPLACEMENT',JSON.stringify({reachable:app.probe.current!.snapshot('A').reachable,newClientConfigured:!!screen.queryByText('Configurado'),nativeReconciledRevoked:notificationNative.reconcile.mock.calls.some(([raw])=>JSON.parse(raw).some((scope:{key:string;revoked:boolean})=>scope.key===replacement.key&&scope.revoked))}));
 await waitFor(()=>expect(screen.queryByText('Configurado')).not.toBeNull());
});


test('a registration refusal retires the enrollment actually sent, even after blur',async()=>{
 notificationNative.permission.mockReturnValue(true);
 await mount('settings');await screen.findByText('Configurado');
 const key=notificationCacheKey(notificationCacheScope(serverA));await waitFor(()=>expect(stored.has(key)).toBe(true));
 notificationNative.begin.mockImplementation(()=>{
  const native={generation:2,state:'endpoint',endpoint:'http://ntfy.fixture.ts.net/upSyntheticRenewedEndpoint123?up=1',distributor:'io.heckel.ntfy'};
  notificationNative.status.mockReturnValue(native);return native;
 });
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/registration',response.promise,'PUT');
 await act(async()=>fireEvent.press(screen.getByText('Activar con ntfy privado')));
 expect(requestsFor(serverA.url,'/v1/notifications/registration')).toHaveLength(1);
 await act(async()=>emitAppBlur());await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(stored.has(key)).toBe(false);expect(notificationNative.commit).not.toHaveBeenCalled();
});

test('a hidden terminal refusal retires pending preference writes before offline remount',async()=>{
 const release=deferred<void>();const key=notificationCacheKey(notificationCacheScope(serverA));
 secureStore.setItemAsync.mockImplementation(async(name,value)=>{if(name===key)await release.promise;stored.set(name,value);});
 seed([serverA],{...settings,faceid:false});polling(serverA);
 respond(serverA.url,'/v1/notifications',json(status));respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 const app=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/><NotificationNoticeScreen serverId="A" noticeId="notice-A"/></LockGate></NotificationProvider>);await app.ready();
 await screen.findByText('echo synthetic-private-command');await waitFor(()=>expect(secureStore.setItemAsync).toHaveBeenCalledWith(key,expect.any(String)));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await act(async()=>emitAppBlur());
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));await act(async()=>release.resolve());
 await waitFor(()=>expect(stored.has(key)).toBe(false));await act(async()=>app.unmount());
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const offline=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await offline.ready();
 await screen.findByText('Sin conexión · últimos ajustes, solo lectura');expect(screen.queryByText('Configurado')).toBeNull();
 expect(stored.has(key)).toBe(false);expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});

test('polling retirement preserves another Server enrollment, preferences and status',async()=>{
 seed([serverA,serverB],{...settings,faceid:false});polling(serverA);polling(serverB);
 const other={...status,revision:3};respond(serverA.url,'/v1/notifications',json(status));respond(serverB.url,'/v1/notifications',json(other));
 const app=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/><NotificationSettingsScreen serverId="B"/></LockGate></NotificationProvider>);await app.ready();
 const otherKey=notificationCacheKey(notificationCacheScope(serverB));await waitFor(()=>expect(stored.get(otherKey)).toBe(JSON.stringify(other)));
 respond(serverA.url,'/v1/agents',json({error:{code:'device_revoked'}},403));await act(async()=>app.probe.current!.refresh('A'));
 await waitFor(()=>expect(app.probe.current!.snapshot('A').down?.action).toBe('pair'));
 const replacement={...serverA,key:'synthetic-poll-owner-again'};const response=deferred<Response>();respond(replacement.url,'/v1/agents',response.promise);
 respond(replacement.url,'/v1/notifications',json({...status,revision:2}));await act(async()=>app.probe.current!.replaceServer('A',replacement));
 await act(async()=>response.resolve(json({agents:[]})));await waitFor(()=>expect(app.probe.current!.snapshot('A').reachable).toBe(true));
 expect(app.probe.current!.snapshot('B').reachable).toBe(true);expect(app.probe.current!.snapshot('B').down).toBeNull();
 expect(stored.get(otherKey)).toBe(JSON.stringify(other));
 const scopes=JSON.parse(notificationNative.reconcile.mock.calls.at(-1)![0]);
 expect(scopes).toContainEqual({serverId:'B',url:serverB.url,key:serverB.key,deviceId:serverB.deviceId,revoked:false});
 expect(scopes).toContainEqual({serverId:'A',url:replacement.url,key:replacement.key,deviceId:replacement.deviceId,revoked:false});
 expect(screen.getAllByText('Configurado')).toHaveLength(2);
});



test('review-independent terminal refusal after offline provider remount must retire already loaded private preferences',async()=>{
 const first=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 await act(async()=>first.unmount());
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const second=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);
 await second.ready();await screen.findByText('Sin conexión · últimos ajustes, solo lectura');
 expect(screen.getByText('Configurado')).toBeVisible();
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 await waitFor(()=>expect(stored.has(key)).toBe(false));
 expect(notificationNative.forget).toHaveBeenCalledWith('A');
 expect(screen.queryByText('Configurado')).toBeNull();
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});

test('observable terminal retirement removes only the exact scope already displayed on another route',async()=>{
 let showSettings!:()=>void;
 function Routes(){
  const [settingsRoute,setSettingsRoute]=reviewUseState(false);showSettings=()=>setSettingsRoute(true);
  return <NotificationProvider><LockGate>{settingsRoute?<><NotificationSettingsScreen serverId="A"/><NotificationSettingsScreen serverId="B"/></>:<NotificationNoticeScreen serverId="A" noticeId="notice-A"/>}</LockGate></NotificationProvider>;
 }
 seed([serverA,serverB],{...settings,faceid:false});polling(serverA);polling(serverB);
 respond(serverA.url,'/v1/notifications/notices/notice-A',json(notice));
 const app=renderApp(<Routes/>);await app.ready();await screen.findByText('echo synthetic-private-command');
 const key=notificationCacheKey(notificationCacheScope(serverA));stored.set(key,JSON.stringify(status));
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const other={...status,configured:false,revision:3};respond(serverB.url,'/v1/notifications',json(other));
 await act(async()=>showSettings());await screen.findByText('Configurado');await screen.findByText('El Puente no tiene un canal de avisos configurado.');
 const otherKey=notificationCacheKey(notificationCacheScope(serverB));await waitFor(()=>expect(stored.get(otherKey)).toBe(JSON.stringify(other)));
 await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(screen.queryByText('Configurado')).toBeNull();expect(screen.getByText('El Puente no tiene un canal de avisos configurado.')).toBeVisible();
 expect(stored.get(otherKey)).toBe(JSON.stringify(other));expect(app.probe.current!.snapshot('B').reachable).toBe(true);
 expect(notificationNative.forget).toHaveBeenCalledWith('A');expect(notificationNative.forget).not.toHaveBeenCalledWith('B');
});

test('an old refusal cannot publish retirement into a provider displaying a newer enrollment',async()=>{
 const first=await mount('notice');await screen.findByText('echo synthetic-private-command');
 const response=deferred<Response>();respond(serverA.url,'/v1/notifications/notices/notice-A/decision',response.promise,'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));await act(async()=>first.unmount());
 const key=notificationCacheKey(notificationCacheScope(serverA));const newer={...status,revision:5};stored.set(key,JSON.stringify(newer));
 notificationNative.status.mockReturnValue({generation:2,state:'registered',endpoint:'http://ntfy.fixture.ts.net/upSyntheticRenewal123?up=1',distributor:'io.heckel.ntfy'});
 respond(serverA.url,'/v1/notifications',json({error:{code:'unavailable'}},503));
 const second=renderApp(<NotificationProvider><LockGate><NotificationSettingsScreen serverId="A"/></LockGate></NotificationProvider>);await second.ready();
 await screen.findByText('Configurado');expect(screen.getByText('Sin conexión · últimos ajustes, solo lectura')).toBeVisible();
 notificationNative.forget.mockClear();await act(async()=>response.resolve(json({error:{code:'device_revoked'}},403)));
 expect(screen.getByText('Configurado')).toBeVisible();expect(stored.get(key)).toBe(JSON.stringify(newer));expect(notificationNative.forget).not.toHaveBeenCalled();
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(1);
});

test('Rechazar from the notice sends deny without asking for a fingerprint',async()=>{
 await mount('notice');await screen.findByText('echo synthetic-private-command');
 respond(serverA.url,'/v1/notifications/notices/notice-A/decision',json({ok:true,outcome:'rejected'}),'POST');
 await act(async()=>fireEvent.press(screen.getByText('Rechazar')));
 const posts=requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision');expect(posts).toHaveLength(1);
 expect(posts[0].body).toEqual({schema:1,registrationId:'registration-A',target:notice.target,choice:'deny'});
 expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
 expect(screen.getByText('Rechazado')).toBeVisible();
});

test.each(['initial','fresh'] as const)('a network failure on the %s notice read keeps the notification and claims no Decisión',async read=>{
 if(read==='initial'){seed([serverA],{...settings,faceid:false});polling(serverA);respond(serverA.url,'/v1/notifications/notices/notice-A',networkError);
  renderApp(<NotificationProvider><LockGate><NotificationNoticeScreen serverId="A" noticeId="notice-A"/></LockGate></NotificationProvider>);}
 else{await mount('notice');await screen.findByText('echo synthetic-private-command');
  respond(serverA.url,'/v1/notifications/notices/notice-A',networkError);
  await act(async()=>fireEvent.press(screen.getByText('Rechazar')));}
 await waitFor(()=>expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A').length).toBeGreaterThan(read==='initial'?0:1));
 await act(async()=>jest.advanceTimersByTimeAsync(0));
 expect(requestsFor(serverA.url,'/v1/notifications/notices/notice-A/decision')).toHaveLength(0);
 expect(screen.queryByText('Decisión sin confirmar')).toBeNull();
 expect(screen.getByText('La operación quedó sin confirmar. Revisa la conexión y el estado del Servidor.')).toBeVisible();
 expect(notificationNative.clearNotice).not.toHaveBeenCalled();
});
