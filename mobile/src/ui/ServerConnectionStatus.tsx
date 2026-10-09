import { router } from 'expo-router';
import { createContext, useContext } from 'react';
import { View } from 'react-native';
import { vpnConnectionDiagnosis } from '@/core/vpn';
import { serverConnectionPresentation } from '@/core/connectionStatus';
import { demoVpnAvailability } from '@/core/demo';
import { DEMO, useApp } from '@/state/app';
import { ConnectionStatus } from './ConnectionStatus';
import { ProtocolNotice } from './ProtocolNotice';

/** Inside a ServerSection the compact «SIN RESPUESTA» row stands for the unreachable block. */
export const CompactStatusContext = createContext(false);

/** `subject`: the Servidor is what the screen is about (its ficha), so it gets the big block. */
export function ServerConnectionStatus({ serverId, subject = false }: { serverId: string; subject?: boolean }) {
  const { servers, snapshot, refresh, vpnReading } = useApp();
  const compact = useContext(CompactStatusContext);
  const server = servers.find((s) => s.id === serverId);
  const snap = snapshot(serverId);
  const presentation = serverConnectionPresentation(snap);
  if (!server || !presentation) return null;
  const diagnosis = presentation.diagnosis?.kind === 'known' ? presentation.diagnosis
    : presentation.protocol || (compact && presentation.diagnosis) ? null
    : presentation.diagnosis ? vpnConnectionDiagnosis(presentation.diagnosis, DEMO ? demoVpnAvailability(serverId) : vpnReading.vpn, !snap.protocolStale) : null;
  return (
    <View style={{ gap: 8 }}>
      <ProtocolNotice protocol={presentation.protocol} stale={presentation.stale} />
      {diagnosis ? (
        <ConnectionStatus serverName={server.name} diagnosis={diagnosis} subject={subject} onRetry={() => refresh(serverId)}
          onPair={() => router.push({ pathname: '/connect', params: { serverId } })} />
      ) : null}
    </View>
  );
}
