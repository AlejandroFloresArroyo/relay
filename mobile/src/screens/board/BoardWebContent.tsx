import { useId } from 'react';
import Svg, { Defs, Pattern, Rect } from 'react-native-svg';
import { View } from 'react-native';
import type { BoardCard } from '../../../../protocol/board';
import type { RelayClient } from '@/core/client';
import { NativeBoardWebView } from '@/native/boardWeb';
import { DEMO } from '@/state/app';
import { demoBoardWebPreview } from '@/core/demoBoardWeb';
import { useBoardWeb } from '@/state/useBoardWeb';
import { usePalette } from '@/theme/ThemeProvider';
import { M, Spinner, T } from '@/ui/primitives';
import { Keycap } from '@/ui/kit';
export function BoardWebContent({ card, serverId, client, available, offline = false, demoScenario, onRetry }: { card: BoardCard; serverId: string; client: RelayClient; available: boolean; offline?: boolean; demoScenario?: string; onRetry?: () => void }) {
  const stripeId = useId().replace(/:/g, '');
  const { K } = usePalette(), preview = DEMO && demoScenario ? demoBoardWebPreview(demoScenario) : null;
  const live = useBoardWeb(serverId, client, card, available && !preview, offline);
  const web = preview ? { ...live, ...preview, id: undefined } : live;
  return <View style={{ borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: K.inkTertiary, padding: 5, gap: 5, backgroundColor: K.field, overflow: 'hidden' }}>
    <Svg pointerEvents="none" accessible={false} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}><Defs><Pattern id={stripeId} patternUnits="userSpaceOnUse" width={12} height={12} patternTransform="rotate(45)"><Rect width={6} height={12} fill={K.ink} opacity={0.04}/></Pattern></Defs><Rect width="100%" height="100%" fill={`url(#${stripeId})`}/></Svg>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, padding: 4 }}><M s={9.5} ls={0.04} c={K.inkTertiary}>CONTENIDO DEL AGENTE</M><M s={9.5} ls={0.04} c={K.inkTertiary}>{web.phase === 'ready' ? 'HTML · AISLADO' : 'HTML · NO ACTIVO'}</M></View>
    {web.phase === 'ready' && web.id ? <NativeBoardWebView snapshotId={web.id} onFailure={web.fail} style={{ height: 200, borderRadius: 9, overflow: 'hidden' }} accessibilityLabel={`Contenido web de ${card.agentName}: ${card.title}`} /> : <View style={{ padding: 12, gap: 10, minHeight: 112 }}>
      {web.phase === 'loading' ? <><Spinner/><T s={13} c={K.ink}>Verificando el contenido web…</T></> : <T s={13} lh={1.5} c={K.ink}>{web.phase === 'offline' ? 'Contenido web no disponible sin conexión. Solo se conserva la información de la Tarjeta.' : web.phase === 'retired' ? 'Contenido web retirado mientras Relay no está visible.' : web.message}</T>}
      {['error', 'unsupported', 'unverified'].includes(web.phase) ? <Keycap label="Reintentar" onPress={!available && onRetry ? onRetry : web.retry} /> : null}
    </View>}
  </View>;
}
