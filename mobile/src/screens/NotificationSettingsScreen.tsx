import { useReturn } from '@/state/navigation';
import { DEMO } from '@/state/app';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { NotificationStatus, NotificationPreferences } from '../../../protocol/notifications';
import { notificationAuthorizationFailed, notificationError, validNotificationStatus } from '@/core/notifications';
import { notificationNative, notificationCacheScope } from '@/native/notifications';
import { useNotificationCache, useNotificationSession } from '@/state/notifications';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader, RootHeader } from '@/ui/headers';
import { Keycap, Lamp, ListBlock, ListRow } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { SwitchRow } from '@/ui/settingRows';

export function NotificationSettingsScreen({ serverId, demoState }: { serverId: string; demoState?: string }) {
  const { K } = usePalette();
  const session = useNotificationSession(serverId, DEMO && demoState ? demoState : 'settings');
  const cache = useNotificationCache();
  const ret = useReturn();
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState(()=>notificationNative?.permission() ?? false);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [distributors] = useState(() => { try { return notificationNative?.distributors() ?? []; } catch { return []; } });
  useEffect(() => {
    void Promise.resolve().then(() => { setStatus(null); setOffline(false); if (!session.blocked) setError(null); });
    if (!session.visible || !session.server || !session.client) return;
    const current = session.capture(); const retire = session.captureRetirement(); const scope = notificationCacheScope(session.server);
    void Promise.resolve().then(()=>{if(current())setPermission(notificationNative?.permission() ?? false);});
    void session.client.status().then(value => {
      if (!current()) return; setStatus(value);
      if (scope) void cache.write(scope,value).catch(()=>{if(current())setError('No se guardaron los ajustes de avisos en este teléfono.');});
    }, async failure => {
      const present = current();
      if (notificationAuthorizationFailed(failure) && retire()) { setStatus(null); setOffline(false); if (present) setError(notificationError(failure)); return; }
      if (!current()) return; setError(notificationError(failure));
      setOffline(true);
      const value = scope ? await cache.read(scope).catch(()=>null) : null;
      if (current() && validNotificationStatus(value)) setStatus(value);
    });
  }, [session, serverId, cache]);
  async function requestPermission() {
    const current = session.capture(); if (!current() || !notificationNative) return;
    try { const result = await notificationNative.requestPermission(); if (current()) setPermission(result.granted); }
    catch { if (current()) setError('Android no confirmó el permiso de avisos.'); }
  }
  async function update(preferences: NotificationPreferences, distributor?: string) {
    if (running.current || !status || !session.server?.deviceId || !session.client || !notificationNative || offline) return;
    const current = session.capture(); let retire = session.captureRetirement(); if (!current()) return;
    running.current = true; setBusy(true); setError(null);
    try {
      let native = notificationNative.status(serverId);
      if (preferences.enabled && distributor) {
        native = notificationNative.begin(JSON.stringify({serverId,url:session.server.url,key:session.server.key,deviceId:session.server.deviceId}),distributor);
        const started = Date.now();
        while (!native.endpoint && Date.now() - started < 10000) {
          await new Promise<void>(resolve=>setTimeout(resolve,250));
          if (!current()) return;
          native = notificationNative.status(serverId);
        }
      }
      if (!current()) return;
      if (preferences.enabled && (!permission || !native.endpoint)) { setError('Falta el permiso Android o el endpoint del distribuidor privado.'); return; }
      retire = session.captureRetirement();
      const value = preferences.enabled
        ? await session.client.register({schema:1,revision:status.revision,endpoint:native.endpoint!,preferences})
        : await session.client.unregister(status.revision);
      if (!current()) return;
      if (preferences.enabled) notificationNative.commit(serverId,native.generation,JSON.stringify(value));
      else notificationNative.forget(serverId);
      setStatus(value);
      const scope = notificationCacheScope(session.server);
      if (scope) await cache.write(scope,value);
    } catch (failure) {
      const present = current();
      if (notificationAuthorizationFailed(failure) && retire()) { setStatus(null); setOffline(false); if (present) setError(notificationError(failure)); }
      else if (current()) setError(notificationError(failure));
    }
    finally { running.current = false; setBusy(false); }
  }
  function renew() {
    if (!session.capture()() || !status) return;
    try {
      const distributor = notificationNative?.status(serverId).distributor;
      if (distributor) void update(status.preferences,distributor);
      else setError('Elige de nuevo el distribuidor privado después de desactivar los avisos.');
    } catch { setError('No se pudo consultar la inscripción de Android. Reintenta.'); }
  }
  const kinds = [['approval','Aprobaciones'],['task','Tareas'],['error','Errores'],['server','Servidor']] as const;
  // One note: the canal's own state first, then the distributor, then the lease.
  const note = !status ? null : !status.configured ? 'El Puente no tiene un canal de avisos configurado.'
    : !distributors.length ? 'Hace falta el distribuidor ntfy privado en Android antes de encender los avisos. Que ntfy los acepte no garantiza que lleguen.'
    : `${status.registration ? 'Inscripción vigente; se renueva explícitamente durante siete días.' : 'Avisos desactivados o inscripción vencida.'} Que ntfy los acepte no garantiza que lleguen.`;
  const title = 'Avisos';
  const subtitle = `${(session.server?.name ?? 'SERVIDOR NO EMPAREJADO').toUpperCase()} · ESTE TELÉFONO`;
  const shownPermission = DEMO ? demoState !== 'permission-denied' : permission;
  return <View accessibilityLabel="Ajustes de avisos del Servidor" style={{flex:1,backgroundColor:K.background}}><StatusBarSpace/><ScrollView contentContainerStyle={{paddingBottom:16,gap:12,maxWidth:640,width:'100%',alignSelf:'center'}}>
    {ret ? <DetailHeader back={ret.label} onBack={ret.go} title={title} subtitle={subtitle} /> : <View style={{paddingHorizontal:16}}><RootHeader title={title}/><M s={9.5} ls={0.04} c={K.inkTertiary}>{subtitle}</M></View>}
    <T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>Relay avisa por un ntfy privado dentro de Tailscale. Lo que dice cada comando se lee al abrir Relay.</T>
    {!DEMO && !notificationNative ? <T {...TYPE.secondary} c={K.dangerText} style={{paddingHorizontal:16}}>El módulo Android no está disponible en esta compilación.</T> : !shownPermission ? <Keycap label="Permitir avisos en Android" disabled={!session.visible} onPress={()=>{void requestPermission();}} style={{marginHorizontal:12}}/> : null}
    {session.diagnosis ? <ListBlock><ListRow title={session.diagnosis.label} description={session.diagnosis.hint}/></ListBlock> : null}
    {offline ? <T {...TYPE.secondary} c={K.inkSecondary} style={{paddingHorizontal:16}}>Sin conexión · últimos ajustes, solo lectura</T> : null}
    {status && session.visible ? <>
      <ListBlock>
        <SwitchRow title="Canal privado" description={status.configured ? 'Configurado' : 'Sin configurar'} on={status.configured} readOnly />
        <SwitchRow title="Avisos de este Servidor" description={status.preferences.enabled ? 'Activados' : 'Apagados'} on={status.preferences.enabled} disabled={busy || offline || !status.preferences.enabled} onChange={()=>{void update({...status.preferences,enabled:false});}} />
        {kinds.map(([kind,label])=>{
          const available = status.availableKinds.includes(kind);
          return <SwitchRow key={kind} title={label} description={available ? undefined : 'No disponible en este Puente'} on={available && status.preferences.types[kind]} dim={!available}
            disabled={busy || offline || !status.registration || !available} onChange={next=>{void update({...status.preferences,types:{...status.preferences.types,[kind]:next}});}} />;
        })}
      </ListBlock>
      {status.preferences.enabled && status.configured && permission && !offline && notificationNative ? <Keycap label="Renovar inscripción" disabled={busy} onPress={renew} style={{marginHorizontal:12}}/> : null}
      {!status.preferences.enabled && status.configured && permission && !offline && notificationNative ? distributors.map(distributor=><Keycap key={distributor.packageName} label={`Activar con ${distributor.label}`} disabled={busy} onPress={()=>{void update({...status.preferences,enabled:true},distributor.packageName);}} style={{marginHorizontal:12}}/>) : null}
      <View style={{marginHorizontal:12,padding:12,borderRadius:RADIUS.keyLarge,backgroundColor:K.block,boxShadow:K.shadowBlock,flexDirection:'row',gap:12,alignItems:'flex-start'}}>
        <View style={{paddingTop:6}}><Lamp tone="off"/></View>
        <T {...TYPE.secondary} c={K.inkSecondary} style={{flex:1}}>{note}</T>
      </View>
    </> : null}
    {error ? <T {...TYPE.secondary} c={K.dangerText} style={{paddingHorizontal:16}}>{error}</T> : null}
  </ScrollView></View>;
}
