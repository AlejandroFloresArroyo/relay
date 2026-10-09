import { usePalette } from '@/theme/ThemeProvider';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { checkProtocolVersion } from '@/core/protocolVersion';
import { DEMO, useApp, usePoll } from '@/state/app';
import { DEMO_DISCOVERY_STATES, setDemoDiscovery } from '@/core/demo';
import { RADIUS, TYPE } from '@/theme/tokens';

import { Keycap, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';

/** «ENCONTRADOS POR <SERVIDOR>» (D-06): unpaired Puentes a paired one sees on the tailnet, each with «Emparejar». */
export function DiscoveryPanel() {
  const { K } = usePalette();
  const { servers, snapshot, clientFor } = useApp();
  const [demoState, setDemoState] = useState('normal');
  const connecting = servers.some(s => s.deviceId && s.key && snapshot(s.id).reachable === null);
  const source = servers.find(s => s.deviceId && s.key && snapshot(s.id).reachable === true);
  const result = usePoll(() => source ? clientFor(source.id).discovery().then(data => ({ ...data, sourceId: source.id })) : Promise.resolve(null), [source?.id, clientFor, demoState]);
  if (!servers.some(s => s.deviceId && s.key)) return null;
  const discovered = result.data?.sourceId === source?.id ? result.data : null;
  const bridges = source && !result.error ? discovered?.bridges.filter(b => !servers.some(s => s.url.replace(/\/$/, '') === b.url)) ?? [] : [];
  const message = !source ? connecting ? 'Conectando con un Puente emparejado…' : 'SIN RESPUESTA · Conecta con un Puente emparejado para buscar.'
    : result.error ? 'No se pudo consultar la tailnet. Reintenta.'
      : !discovered ? 'Buscando Puentes…'
        : bridges.length === 0 ? 'No se encontraron Puentes sin emparejar.' : null;
  return <View style={{ gap: 8, paddingTop: 12 }}>
    <SectionHeader title={source ? `ENCONTRADOS POR ${source.name.toUpperCase()}` : 'EN TU TAILNET'} action={source ? { label: 'Buscar otra vez', onPress: result.reload } : undefined} />
    {message ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>{message}</T> : null}
    {bridges.map(bridge => {
      const compatibility = checkProtocolVersion({ ok: true, service: 'relayd', version: '', ...(bridge.protocolVersion === null ? {} : { protocolVersion: bridge.protocolVersion }), ...(bridge.minAppProtocolVersion === null ? {} : { minAppProtocolVersion: bridge.minAppProtocolVersion }) });
      return <View key={bridge.url} style={{ marginHorizontal: 12, padding: 12, borderRadius: RADIUS.block, boxShadow: `inset 0px 0px 0px 1.5px ${K.inkTertiary}`, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: K.accent }} />
        <View style={{ flex: 1, gap: 3 }}>
          <T s={15} w="700" c={K.ink}>{bridge.name}</T>
          <M s={9.5} ls={0.06} c={K.inkTertiary}>{compatibility.kind === 'compatible' ? 'PUENTE SIN EMPAREJAR' : compatibility.message}</M>
        </View>
        <Keycap variant="dark" label="Emparejar" accessibilityLabel={`Emparejar ${bridge.name}`} onPress={() => router.push({ pathname: '/connect', params: { discoveredUrl: bridge.url } })} />
      </View>;
    })}
    {discovered?.truncated ? <T {...TYPE.secondary} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>Se consultaron los primeros 24 equipos de la tailnet.</T> : null}
    {DEMO ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, paddingHorizontal: 16 }}>
      {DEMO_DISCOVERY_STATES.map(state => <Keycap key={state} variant="link" label={state} onPress={() => { setDemoDiscovery(state); setDemoState(state); }} />)}
    </View> : null}
  </View>;
}
