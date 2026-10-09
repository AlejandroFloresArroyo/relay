import { router } from 'expo-router';
import { View } from 'react-native';
import type { ReactNode } from 'react';
import { usePalette } from '@/theme/ThemeProvider';
import { useReturn } from '@/state/navigation';
import { useNow } from '@/state/app';
import { RADIUS, TYPE } from '@/theme/tokens';
import { HomeIndicator, StatusBarSpace } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { Lamp } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { SubjectStateBlock } from '@/ui/states';

export const CONTEXT_REBUILD_NOTICE = 'Hermes puede aplicar los cambios al reconstruir el contexto, incluso en esta Conversación.';
export type DocumentKind = 'memory' | 'soul';
const FILE: Record<DocumentKind, string> = { memory: 'la memoria', soul: 'SOUL.md' };

/** Encabezado B «‹ <Agente>» with the document's title and its mono line (D-11_D-12). */
export function AgentDocumentChrome({ title, subtitle, serverId, children }: { title: string; subtitle: string; serverId: string; children: ReactNode }) {
  const { K } = usePalette();
  const ret = useReturn();
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <ServerConnectionStatus serverId={serverId} />
    <DetailHeader back={ret?.label ?? 'Agentes'} onBack={ret?.go ?? (() => router.back())} title={title} subtitle={subtitle} />
    {children}
    <HomeIndicator />
  </View>;
}
export function DocumentCacheNotice({ at }: { at: number }) {
  const { K } = usePalette();
  const now = useNow();
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return <View style={{ padding: 12, gap: 6, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Lamp tone="red" /><M {...TYPE.label} c={K.dangerText}>SOLO LECTURA · ÚLTIMO CONOCIDO</M></View>
    <T {...TYPE.secondary} c={K.inkSecondary}>Guardado {new Date(at).toLocaleString('es-MX')} · hace {minutes} min</T>
  </View>;
}
/** The state of a document that has no data: loading, SIN RESPUESTA (the subject is the document, so the big block) or a read error. */
export function DocumentState({ kind, loading, offline, serverName, reload }: { kind: DocumentKind; loading: boolean; offline: boolean; serverName: string; reload: () => void }) {
  if (loading) return <View accessibilityLabel="Cargando datos del Agente…"><SubjectStateBlock spec={{ kind: 'loading', what: kind === 'memory' ? 'memoria' : 'SOUL.md' }} /></View>;
  return <SubjectStateBlock spec={offline
    ? { kind: 'unreachable', phrase: `${serverName} no contesta; no se pudo leer ${FILE[kind]}. Relay lo reintenta solo.`, onRetry: reload }
    : { kind: 'error', verb: `leer ${FILE[kind]}`, onRetry: reload }} />;
}
/** Memoria or SOUL.md absent (D-ES). */
export function DocumentMissing({ kind, agentName, serverName }: { kind: DocumentKind; agentName: string; serverName: string }) {
  return <SubjectStateBlock spec={{ kind: 'empty', title: 'SIN MEMORIA · SIN SOUL.md', phrase: `${agentName} todavía no tiene ${kind === 'memory' ? 'memoria' : 'SOUL.md'} guardad${kind === 'memory' ? 'a' : 'o'} en ${serverName}.` }} />;
}
