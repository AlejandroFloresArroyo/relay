import { useState } from 'react';
import { DEMO } from '@/state/app';
import { DEMO_APP_UPDATE_SCENARIOS, demoAppUpdateScenario, setDemoAppUpdateScenario } from '@/core/demoAppUpdate';
import { ScrollView, View } from 'react-native';
import { useReturn } from '@/state/navigation';
import { useAppUpdate } from '@/state/useAppUpdate';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { DetailHeader, RootHeader } from '@/ui/headers';
import { Keycap, Lamp, ListBlock } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { StatusBarSpace } from '@/ui/chrome';
import { SubjectStateBlock } from '@/ui/states';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';

/** A label/value row in Mono: the label on the left, the value on the right (`strong` for the one that matters). */
function DataRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  const { K } = usePalette();
  return <View style={{ minHeight: 44, paddingVertical: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12 }}>
    <M {...TYPE.label} ls={0.06} c={K.inkTertiary}>{label}</M>
    <M {...TYPE.data} w={strong ? '600' : '400'} c={K.ink} style={{ flexShrink: 1, textAlign: 'right' }}>{value}</M>
  </View>;
}
export function AppUpdateScreen({ serverId }: { serverId: string }) {
  const { K } = usePalette();
  const [scenario, setScenario] = useState(() => demoAppUpdateScenario(serverId));
  const update = useAppUpdate(serverId); const read = update.reading; const ret = useReturn();
  const published = read?.manifest?.state === 'published' ? read.manifest.artifact : null;
  const working = read && ['downloading', 'verifying', 'installing'].includes(read.phase);
  if (!update.presenting) return null;
  const compat = update.compatibility;
  const side = { paddingHorizontal: 16 } as const;
  const note = (text: string, color = K.inkSecondary) => <T {...TYPE.secondary} c={color} style={side}>{text}</T>;
  return <View accessibilityLabel="Actualización APK del Servidor" style={{ flex: 1, backgroundColor: K.background }}><StatusBarSpace/><ScrollView contentContainerStyle={{ paddingBottom: 24, gap: 12 }}>
    {ret ? <DetailHeader back={ret.label} onBack={ret.go} title="Actualización APK"/> : <RootHeader title="Actualización APK"/>}
    {update.server ? <ServerConnectionStatus serverId={serverId}/> : note('Este Servidor ya no está disponible.', K.ink)}
    {update.blocked ? note(update.diagnosis?.label ?? 'Empareja de nuevo con el Puente.', K.dangerText) : !update.active ? note('Conecta con un Puente compatible para consultar la publicación.') : null}
    {update.active && (!read || read.phase === 'loading') ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'publicación', phrase: 'Consultando la publicación y la identidad instalada…' }}/></View> : null}
    {read?.manifest?.state === 'unpublished' ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'unavailable', phrase: 'Este Puente no tiene un APK publicado.' }}/></View> : null}
    {published && read?.installed && compat === 'unsupported' ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'unavailable', title: 'MÓDULO APK NO DISPONIBLE', phrase: 'Necesitas Android 12 o posterior.' }}/></View> : null}
    {published && read?.installed && compat !== 'unsupported' ? <>
      <ListBlock>
        <View style={{ minHeight: 48, justifyContent: 'center', alignItems: 'flex-start' }}>
          <View style={{ minHeight: 24, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Lamp tone={compat === 'new' || compat === 'current' ? 'green' : 'red'}/>
            <M {...TYPE.label} ls={0.06} c={compat === 'new' || compat === 'current' ? K.okText : K.dangerText}>{compat === 'new' ? 'COMPATIBLE SEGÚN PUBLICACIÓN' : compat === 'current' ? 'PUBLICACIÓN ACTUAL' : 'PUBLICACIÓN NO COMPATIBLE'}</M>
          </View>
        </View>
        <DataRow label="INSTALADA" value={`${read.installed.versionName || 'desconocida'} · ${read.installed.versionCode || '—'}`}/>
        <DataRow strong label="PUBLICADA" value={`${published.versionName} · ${published.versionCode}`}/>
        <DataRow label="PAQUETE" value={published.applicationId}/>
        <DataRow label="COMPILACIÓN" value={`${published.sourceCommit.slice(0, 7)} · ${(published.byteLength / 1048576).toFixed(2)} MiB`}/>
      </ListBlock>
      {note(compat === 'new' ? 'La publicación declara que es compatible; la verificación en este teléfono se hace después de descargar. Revisa las dos versiones antes de seguir.' : 'La publicación declara compatibilidad. La verificación local ocurre después de descargar.')}
      {compat === 'incompatible' ? note('Paquete, firma o versión no corresponden a esta app instalada.', K.dangerText) : null}
      {compat === 'new' && !read.installed.canInstall ? <View style={{ gap: 12 }}>
        {note('Permite a Relay solicitar instalaciones desde esta fuente en Ajustes de Android. Android pedirá consentimiento para cada APK.', K.ink)}
        <View style={{ marginHorizontal: 12 }}><Keycap variant="primary" label="Permitir fuente en Android" onPress={() => void update.permit()}/></View>
      </View> : null}
      {compat === 'new' && read.installed.canInstall && read.phase === 'ready' ? <View style={{ gap: 12 }}>
        {note(read.reviewed ? 'Versiones revisadas. Descarga el archivo privado para verificarlo en este teléfono.' : 'Revisa las versiones instalada y publicada antes de descargar.', K.ink)}
      </View> : null}
      {working ? <View style={{ gap: 12 }}>{note(read.phase === 'downloading' ? DEMO ? 'Descargando APK simulado…' : 'Descargando APK privado…' : read.phase === 'verifying' ? 'Verificando APK local…' : 'Preparando confirmación de Android…', K.ink)}<M s={11} c={K.inkSecondary} style={side}>{read.received} / {published.byteLength} bytes</M></View> : null}
      {read.phase === 'verified' ? <View style={{ gap: 12 }}><M {...TYPE.label} c={K.okText} style={side}>{DEMO ? 'VERIFICACIÓN SIMULADA' : 'VERIFICADO EN ESTE TELÉFONO'}</M>{note(DEMO ? 'Simulación de SHA256, paquete, versión y firma; no verifica un APK real.' : 'SHA256 local, paquete, versión y firma coinciden con la publicación y la app instalada.', K.ink)}</View> : null}
      {read.phase === 'handoff' ? note(DEMO ? 'Simulación de confirmación Android. No se instala ningún APK.' : 'Android solicita confirmación. Esto no confirma que el APK se haya instalado.', K.ink) : null}
    </> : null}
    {read?.notice ? note(read.notice, K.dangerText) : null}
    <View style={{ marginHorizontal: 12, gap: 12 }}>
      {published && read?.installed && compat === 'new' && read.installed.canInstall && read.phase === 'ready' ? <Keycap variant="primary" label={read.reviewed ? 'Descargar APK' : 'Revisar versiones'} onPress={read.reviewed ? () => void update.download() : update.review}/> : null}
      {published && read?.installed && read.phase === 'verified' ? <Keycap variant="primary" label="Instalar · confirmar en Android" onPress={() => void update.install()}/> : null}
      {working ? <Keycap label="Cancelar" onPress={update.cancel}/> : null}
      {update.active && !working ? <Keycap label="Actualizar publicación" onPress={update.refresh}/> : null}
    </View>
    {DEMO ? <View style={{ gap: 8 }}>
      <M {...TYPE.label} c={K.inkTertiary} style={side}>DEMO · ESTADOS</M>{note('Demostración: publicación, archivos y verificación simulados.', K.accentText)}
      <ScrollView horizontal contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }}>{DEMO_APP_UPDATE_SCENARIOS.map(entry => <Keycap key={entry.id} variant={scenario === entry.id ? 'dark' : 'normal'} label={entry.label} onPress={() => { setDemoAppUpdateScenario(serverId, entry.id); setScenario(entry.id); update.refresh(); }}/>)}</ScrollView>
    </View> : null}
    {note('Al salir, bloquear o perder la autorización, la descarga se retira. El APK queda en almacenamiento privado y se borra al invalidarse. Instalar pide otro gesto y la confirmación de Android.', K.inkTertiary)}
  </ScrollView></View>;
}
