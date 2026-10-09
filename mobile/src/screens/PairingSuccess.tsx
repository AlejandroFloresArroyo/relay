import { usePalette } from '@/theme/ThemeProvider';
import { useMemo } from 'react';
import { View } from 'react-native';
import type { PairingResponse } from '../../../protocol/protocol';
import { createPairedBridgeClient } from '@/core/bridgeClient';
import { createDemoClient } from '@/core/demo';
import { fetch as expoFetch } from 'expo/fetch';
import { DEMO, usePoll } from '@/state/app';
import { TEXT_GLOW } from '@/theme/tokens';

import { Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** Optional server details load after the key has been saved; they cannot fail the pairing. */
export function PairingSuccess({ response, url, name }: { response: PairingResponse; url: string; name?: string }) {
  const { K } = usePalette();
  const client = useMemo(() => DEMO ? createDemoClient('atlas') : createPairedBridgeClient({ baseUrl: url, key: response.deviceKey, deviceId: response.device.id, fetch: expoFetch as unknown as typeof fetch }), [response, url]);
  const info = usePoll(() => client.server(), [client]);
  return <RecessedScreen radius={20} style={{ padding: 20, gap: 12, boxShadow: `${K.shadowScreen}, 0px 0px 0px 1px rgba(76,199,116,0.25), 0px 0px 16px rgba(76,199,116,0.14)` }}>
    <View style={{ flexDirection: 'row', gap: 6 }}><Lamp tone="green" size={9} onScreen /><Lamp tone="off" size={9} onScreen /><Lamp tone="off" size={9} onScreen /></View>
    <M s={13} w="600" ls={0.08} c={K.okTextOnScreen} glow={TEXT_GLOW.ok}>EMPAREJADO</M>
    <M s={11} c={K.onScreenBright}>{name ?? response.server.name}{info.data ? ` · HERMES ${info.data.hermesVersion} · ${info.data.profiles} AGENTES` : ''}</M>
    <T s={15} lh={1.45} c={K.onScreen}>Este teléfono quedó emparejado como {response.device.name}.</T>
  </RecessedScreen>;
}
