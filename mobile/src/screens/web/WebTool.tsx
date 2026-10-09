import { useEffect, useEffectEvent, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import type { RemoteWebApp, RemoteWebCandidate } from '../../../../protocol/remoteWeb';
import { conversationRequestId } from '@/core/conversations';
import { describeRemoteToolState, type RemoteToolState } from '@/core/remoteCapabilities';
import { webAddress, type WebApi } from '@/core/remoteWeb';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS } from '@/theme/tokens';
import { Keycap, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { card, WebAccess } from './WebAccess';
import { WebViewer } from './WebViewer';

/** Where the Web tool is: an app open in Relay at a path, or its external authorization. Kept by the tools screen across a lock. */
export interface WebPlace { appId: string; mode: 'viewer' | 'external'; path: string }

export interface WebToolProps {
  web: WebApi;
  inRelay: RemoteToolState | undefined;
  external: RemoteToolState | undefined;
  admit: ServerRemoteAccess['admit'];
  place: WebPlace | null;
  onPlace: (place: WebPlace | null) => void;
  /** Switches to the Servidor's browser tool; it never opens nor authorizes anything by itself. */
  onServerBrowser: () => void;
  /** False while another panel, tool or route has the keyboard: the page lets go of its field. */
  keyboard?: boolean;
}

const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';
const folderName = (directory: string) => directory.slice(directory.lastIndexOf('/') + 1) || directory;

/** The Web tool of one Servidor: the apps chosen, the services discovered, and each app in Relay or in the phone's browser. */
export function WebTool({ web, inRelay, external, admit, place, onPlace, onServerBrowser, keyboard = true }: WebToolProps) {
  const { K } = usePalette();
  const [apps, setApps] = useState<RemoteWebApp[] | null>(null);
  const [candidates, setCandidates] = useState<RemoteWebCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inRelayOpen = inRelay?.state === 'available';
  const externalOpen = external?.state === 'available';

  const refresh = () => {
    web.apps().then((list) => { setApps(list); setError(null); }, (failed: unknown) => setError(failure(failed)));
    // Discovery only lists: it never opens, publishes nor authorizes anything.
    if (inRelayOpen) web.candidates().then(setCandidates, (failed: unknown) => setError(failure(failed)));
  };
  const load = useEffectEvent(refresh);
  useEffect(() => { load(); }, []);

  const current = place ? apps?.find((app) => app.id === place.appId) : undefined;
  if (place && current) {
    if (place.mode === 'external') {
      return <ScrollView style={{ flex: 1 }}><WebAccess app={current} web={web} onBack={() => onPlace(null)} /></ScrollView>;
    }
    return (
      <WebViewer key={current.id} app={current} web={web} admit={admit} path={place.path} onServerBrowser={onServerBrowser} keyboard={keyboard}
        onPath={(path) => onPlace({ ...place, path })} onBack={() => onPlace(null)} onForget={() => onPlace(null)} />
    );
  }

  const forget = async (app: RemoteWebApp) => {
    setBusy(true);
    try {
      await web.forget(app.id);
      setForgetting(null);
      refresh();
    } catch (failed) {
      setError(failure(failed));
    } finally {
      setBusy(false);
    }
  };
  const registered = (candidate: RemoteWebCandidate) => (apps ?? []).some((app) => app.address === candidate.address && app.port === candidate.port);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, paddingBottom: 12 }}>
      {error ? <T s={13} c={K.dangerText} lh={1.4}>{error}</T> : null}
      {([['EN RELAY', inRelay], ['EN EL NAVEGADOR DEL TELÉFONO', external]] as const).map(([mode, state]) => {
        if (!state || state.state === 'available') return null;
        const { label, hint } = describeRemoteToolState(state);
        return <T key={mode} s={12.5} c={K.inkSecondary} lh={1.4}>{`${mode}: ${label}.${hint ? ` ${hint}` : ''}`}</T>;
      })}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}><SectionHeader title="APLICACIONES" /></View>
          <Keycap variant="link" accessibilityLabel="Actualizar aplicaciones" label="Actualizar" onPress={refresh} />
        </View>
        {apps === null && !error ? <M s={9.5} ls={0.57} c={K.inkTertiary}>CARGANDO APLICACIONES…</M> : null}
        {apps?.length === 0 ? <T s={13} c={K.inkSecondary} lh={1.4}>Aún no elegiste ninguna. Elige un servicio descubierto para abrirlo en Relay o en el navegador del teléfono.</T> : null}
        {(apps ?? []).map((app) => (
          <View key={app.id} style={[card(K), { gap: 10 }]}>
            <View style={{ gap: 2 }}>
              <T s={16} w="700" c={K.ink}>{app.name}</T>
              <M s={11} c={K.inkTertiary}>{webAddress(app)}{app.origin ? '' : ' · SIN PUBLICAR'}</M>
            </View>
            {forgetting === app.id ? (
              <View style={{ gap: 8 }}>
                <T s={13} c={K.inkSecondary} lh={1.4}>Relay deja de servir {app.name}: se cortan sus sesiones en Relay y sus autorizaciones en el navegador. La aplicación sigue funcionando en el Servidor.</T>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Keycap accessibilityLabel="Cancelar" label="Cancelar" disabled={busy} onPress={() => setForgetting(null)} style={{ flex: 1 }} />
                  <Keycap variant="danger" accessibilityLabel="Confirmar olvidar" label="Olvidar" disabled={busy} onPress={() => void forget(app)} style={{ flex: 1 }} />
                </View>
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Keycap accessibilityLabel={`Abrir ${app.name} en Relay`} label="En Relay" disabled={!inRelayOpen} onPress={() => onPlace({ appId: app.id, mode: 'viewer', path: '/' })} style={{ flex: 1 }} />
                  <Keycap accessibilityLabel={`Abrir ${app.name} en el navegador del teléfono`} label="En el navegador" disabled={!externalOpen} onPress={() => onPlace({ appId: app.id, mode: 'external', path: '/' })} style={{ flex: 1 }} />
                </View>
                <Keycap variant="danger" accessibilityLabel={`Olvidar ${app.name}`} label="Olvidar" onPress={() => setForgetting(app.id)} />
              </View>
            )}
          </View>
        ))}
      </View>
      {inRelayOpen ? (
        <View style={{ gap: 8 }}>
          <SectionHeader title="SERVICIOS DESCUBIERTOS" />
          <T s={12.5} c={K.inkSecondary} lh={1.4}>Programas tuyos que escuchan en este Servidor. Descubrirlos no los abre ni los autoriza, y Relay no ofrece los servicios de Hermes ni del Puente.</T>
          {candidates === null ? <M s={9.5} ls={0.57} c={K.inkTertiary}>BUSCANDO SERVICIOS…</M> : null}
          {(candidates ?? []).filter((candidate) => !registered(candidate)).map((candidate) => (
            <Candidate key={webAddress(candidate)} candidate={candidate} web={web} onSaved={refresh} />
          ))}
          {candidates?.length === 0 ? <T s={13} c={K.inkSecondary}>No hay servicios escuchando en este Servidor.</T> : null}
        </View>
      ) : null}
      <View style={[card(K), { gap: 8 }]}>
        <T s={13} c={K.inkSecondary} lh={1.4}>¿Una aplicación no funciona en el teléfono? Ajústala para usar rutas relativas, o ábrela en el navegador del Servidor.</T>
        <Keycap accessibilityLabel="Usar el navegador del Servidor" label="Navegador del Servidor" onPress={onServerBrowser} />
      </View>
    </ScrollView>
  );
}

function Candidate({ candidate, web, onSaved }: { candidate: RemoteWebCandidate; web: WebApi; onSaved: () => void }) {
  const { K } = usePalette();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One ID per app asked for: a retry after a lost answer registers the same app, never a second one.
  const [requestId, setRequestId] = useState(conversationRequestId);
  const label = `${candidate.process.name} · ${webAddress(candidate)}`;

  const save = async () => {
    if (!name?.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await web.register(requestId, name.trim(), candidate);
      setRequestId(conversationRequestId());
      setName(null);
      onSaved();
    } catch (failed) {
      setError(failure(failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[card(K), { padding: 12, borderRadius: 16, gap: 8 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T s={13.5} w="600" c={K.ink}>{candidate.process.name} · {candidate.process.directory}</T>
          <M s={11} c={K.inkTertiary}>{webAddress(candidate)}</M>
        </View>
        {name === null ? (
          <Keycap accessibilityLabel={`Elegir ${label}`} label="Elegir" onPress={() => setName(folderName(candidate.process.directory))} />
        ) : null}
      </View>
      {name !== null ? (
        <View style={{ gap: 8 }}>
          <SectionHeader title="NOMBRE" />
          <TextInput accessibilityLabel="Nombre de la aplicación" value={name} onChangeText={setName} editable={!busy} maxLength={60} autoCorrect={false}
            placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
            style={{ height: 48, paddingHorizontal: 12, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.mono['400'], fontSize: 12, color: K.ink }} />
          {error ? <T s={13} c={K.dangerText} lh={1.4}>{error}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Keycap label="Cancelar" disabled={busy} onPress={() => setName(null)} style={{ flex: 1 }} />
            <Keycap variant="primary" accessibilityLabel="Guardar aplicación" label={busy ? 'Guardando…' : 'Guardar'} disabled={!name.trim() || busy} onPress={() => void save()} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
