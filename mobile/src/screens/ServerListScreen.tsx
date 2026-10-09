import { usePalette } from '@/theme/ThemeProvider';
import { DiscoveryPanel } from './DiscoveryPanel';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { RelayError } from '@/core/client';
import { DEMO_SERVER_LIST_STATES, DEMO_SERVER_STORAGE_ERROR } from '@/core/demoPairing';
import { hostOf } from '@/core/format';
import { agentActivity, serverLight } from '@/core/machinery';
import { DEMO, useApp, usePoll } from '@/state/app';
import { RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';

import { StatusBarSpace } from '@/ui/chrome';
import { RootHeader } from '@/ui/headers';
import { IconKey, Keycap, Lamp } from '@/ui/kit';
import { Lights, RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { SubjectStateBlock } from '@/ui/states';
import { TailnetPill } from '@/ui/TailnetSheet';

const addServer = () => router.push('/connect');

/** La pestaña Servidores (D-06): every Servidor as a card; its actions live in its ficha. */
export function ServerListScreen() {
  const { K } = usePalette();
  const { servers, snapshot, serverStorageError } = useApp();
  const [demoCount, setDemoCount] = useState<number | null>(null);
  const [demoStorageError, setDemoStorageError] = useState(false);
  const storageError = demoStorageError ? DEMO_SERVER_STORAGE_ERROR : serverStorageError;
  const visible = demoCount === null ? servers : servers.slice(0, demoCount);
  const online = visible.filter((s) => snapshot(s.id).reachable === true).length;
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16, gap: 12 }}>
      <View style={{ gap: 2 }}>
        <RootHeader title="Servidores" right={<><TailnetPill /><IconKey round glyph="+" accessibilityLabel="Agregar Servidor" onPress={addServer} /></>} />
        <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>
          {visible.length} {visible.length === 1 ? 'SERVIDOR' : 'SERVIDORES'}{online ? ` · ${online} EN LÍNEA` : ''}
        </M>
      </View>
      {storageError ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'error', title: 'SIN ACCESO AL LLAVERO', phrase: storageError }} /></View> : null}
      {visible.length === 0
        ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'empty', title: 'SIN SERVIDORES', phrase: 'Empareja el primero con relayd pair.', action: { label: 'Agregar Servidor', onPress: addServer } }} /></View>
        : visible.map((s) => <ServerCard key={s.id} serverId={s.id} />)}
      <DiscoveryPanel />
      {DEMO ? <View style={{ gap: 6, paddingHorizontal: 16 }}>
        <M {...TYPE.label} c={K.inkTertiary}>ESTADOS DE DEMOSTRACIÓN</M>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12 }}>
          {DEMO_SERVER_LIST_STATES.map(({ count, label }) => <Keycap key={count} variant="link" label={label} onPress={() => { setDemoCount(count); setDemoStorageError(false); }} />)}
          <Keycap variant="link" label="Llavero" onPress={() => setDemoStorageError((value) => !value)} />
          <Keycap variant="link" label="Emparejar" onPress={addServer} />
        </View>
      </View> : null}
    </ScrollView>
  </View>;
}

/**
 * One Servidor: name, PREDETERMINADO, address and «›» open its ficha; the recessed strip says how it
 * answers, with foquitos while its Agentes work. A Servidor in trouble says so inside its card.
 */
function ServerCard({ serverId }: { serverId: string }) {
  const { K } = usePalette();
  const { servers, snapshot, clientFor, refresh } = useApp();
  const s = servers.find((server) => server.id === serverId)!;
  const snap = snapshot(serverId);
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const info = usePoll(() => client.server(), [client]);
  const rejected = !s.deviceId || !s.key || snap.down?.action === 'pair'
    || info.error instanceof RelayError && ['device_revoked', 'key_unknown', 'unauthorized'].includes(info.error.code);
  const outdated = snap.protocol !== null && snap.protocol.kind !== 'compatible';
  const down = snap.reachable === false;
  const trouble = rejected ? 'SIN ACCESO' : outdated ? 'NO DISPONIBLE' : down ? 'SIN RESPUESTA' : null;
  const light = serverLight(snap.agents.map(agentActivity));
  const agents = `${snap.agents.length} ${snap.agents.length === 1 ? 'AGENTE' : 'AGENTES'}`;
  return <View style={{ marginHorizontal: 12, padding: 12, gap: 12, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Abrir ${s.name}`} onPress={() => router.push({ pathname: '/server/[server]', params: { server: serverId } })}
      style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Lamp tone={trouble ? 'red' : snap.reachable ? 'green' : 'off'} size={9} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <T {...TYPE.subtitle} ls={-0.015} c={K.ink}>{s.name}</T>
          {s.isDefault ? <View style={{ paddingHorizontal: 6, paddingVertical: 4, borderRadius: RADIUS.chip, backgroundColor: K.ink }}><M s={9.5} c={K.block}>PREDETERMINADO</M></View> : null}
        </View>
        <M {...TYPE.data} c={K.inkSecondary} numberOfLines={1}>{hostOf(s.url)}</M>
      </View>
      <T s={18} c={K.inkTertiary}>›</T>
    </Pressable>
    <RecessedScreen style={{ minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8,
      boxShadow: trouble ? `${K.shadowScreen}, 0px 0px 0px 1px rgba(229,83,61,0.3), 0px 0px 16px rgba(229,83,61,0.14)` : K.shadowScreen }}>
      {trouble
        ? <M s={9.5} ls={0.06} c={K.dangerTextOnScreen} glow={TEXT_GLOW.danger}>{trouble}</M>
        : snap.reachable
          ? <M s={9.5} ls={0.06} c={K.okTextOnScreen} glow={TEXT_GLOW.ok}>{`EN LÍNEA${snap.latencyMs === null ? '' : ` · ${Math.round(snap.latencyMs)} MS`}`}</M>
          : <M s={9.5} ls={0.06} c={K.onScreenLabel}>CONECTANDO…</M>}
      <M s={9.5} ls={0.06} c={K.onScreen}>{`HERMES ${info.data?.hermesVersion ?? '—'} · ${agents}`}</M>
    </RecessedScreen>
    {light !== 'off' && !trouble ? <View style={{ paddingHorizontal: 2 }}><Lights tone={light} /></View> : null}
    {trouble ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <T {...TYPE.secondary} c={K.inkSecondary} style={{ flex: 1 }}>
        {rejected ? `Este dispositivo perdió el acceso a ${s.name}.` : outdated ? `El Puente de ${s.name} es de una versión que Relay no admite.` : 'Revisa Tailscale y que el Puente esté corriendo.'}
      </T>
      {rejected ? <Keycap variant="link" label="Emparejar de nuevo" onPress={() => router.push({ pathname: '/connect', params: { serverId } })} />
        : outdated ? null : <Keycap variant="link" label="Reintentar" onPress={() => refresh(serverId)} />}
    </View> : null}
  </View>;
}
