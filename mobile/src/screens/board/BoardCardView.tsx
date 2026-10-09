import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TEXT_GLOW } from '@/theme/tokens';
import { Pressable, View } from 'react-native';
import Svg, { Line, Polyline } from 'react-native-svg';
import type { BoardCard } from '../../../../protocol/board';

import { boardTime } from '@/core/board';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, Spinner, T } from '@/ui/primitives';

// D-03: a Tarjeta is a block; NUEVA is the orange rim plus one chip, never both chips.
export function BoardCardView({ card, compact, fresh, onAction, onRefresh, webContent }: { card: BoardCard; compact: boolean; fresh: boolean; onAction: () => void; onRefresh: () => void; webContent?: import("react").ReactNode }) {
  const { K } = usePalette();
  const content = card.content;
  const failed = card.status === 'error', stale = card.status === 'stale';
  const isNew = fresh && card.status === 'ready';
  const newChip = isNew ? <M s={9.5} w="600" c={K.ink} numberOfLines={1} style={{ backgroundColor: K.accent, paddingVertical: 4, paddingHorizontal: 8, borderRadius: RADIUS.chip, flexShrink: 0 }}>NUEVA</M> : null;
  const time = card.updatedAt === null ? 'SIN ACTUALIZACIÓN VÁLIDA' : boardTime(card.updatedAt);
  const rim = failed ? `, 0px 0px 0px 1.5px ${K.danger}` : isNew ? `, 0px 0px 0px 1.5px ${K.accent}` : '';
  return <View style={{ padding: 12, gap: 8, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: `${K.shadowBlock}${rim}` }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <M s={9.5} c={K.block} numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={card.agentName} style={{ backgroundColor: K.ink, borderRadius: RADIUS.chip, paddingVertical: 4, paddingHorizontal: 8, flexShrink: 0, maxWidth: '34%' }}>{card.agentName.toUpperCase()}</M>
      <T s={compact ? 15 : 16} w="700" c={K.ink} numberOfLines={1} ellipsizeMode="tail" accessibilityLabel={card.title} style={{ flex: 1, minWidth: 0 }}>{card.title}</T>
      {!compact ? newChip : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Actualizar ${card.title}`} onPress={onRefresh} style={{ minWidth: 32, minHeight: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
        {card.status === 'updating' ? <Spinner /> : <Svg width={15} height={15} viewBox="0 0 24 24"><Polyline points="18,3 18,8 13,8" fill="none" stroke={K.inkSecondary} strokeWidth={2}/><Polyline points="6,21 6,16 11,16" fill="none" stroke={K.inkSecondary} strokeWidth={2}/><Polyline points="4,12 5,7 10,4 15,4 18,8" fill="none" stroke={K.inkSecondary} strokeWidth={2}/><Polyline points="20,12 19,17 14,20 9,20 6,16" fill="none" stroke={K.inkSecondary} strokeWidth={2}/></Svg>}
      </Pressable>
    </View>
    <View style={{ gap: 8, opacity: failed || stale ? 0.6 : 1 }}>
      {content.type === 'web' ? webContent : null}
      {content.type === 'number' ? <RecessedScreen radius={14} style={{ padding: 12, gap: 4 }}><M s={9.5} ls={0.04} c={K.onScreenLabel}>{content.detail}</M><View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}><M s={32} w="600" c={K.accent} glow={TEXT_GLOW.accent}>{content.value}</M><M s={20} w="600" c={K.accent}>{content.unit}</M></View></RecessedScreen> : null}
      {content.type === 'meter' ? <><View accessibilityLabel={`${content.value} de ${content.max} ${content.unit}`} style={{ flexDirection: 'row', gap: 3 }}>{Array.from({ length: 10 }, (_, i) => <View key={i} style={{ flex: 1, height: 16, borderRadius: 3, backgroundColor: i < Math.round(content.value / content.max * 10) ? K.ok : K.field }} />)}</View><M s={9.5} c={K.inkSecondary}>{content.value} / {content.max} {content.unit} · {Math.round(content.value / content.max * 100)} %</M></> : null}
      {content.type === 'states' ? content.items.map((item, i) => <View key={i} accessible accessibilityLabel={`${item.label}: ${{ ok: 'correcto', warning: 'aviso', error: 'error', off: 'apagado' }[item.state]}, ${item.detail}`} style={{ minHeight: 41, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: i ? 1 : 0, borderColor: K.line }}><Lamp tone={{ ok: 'green', warning: 'orange', error: 'red', off: 'off' }[item.state] as 'green' | 'orange' | 'red' | 'off'} /><T s={15} c={K.ink} style={{ flex: 1 }}>{item.label}</T><M s={11} c={K.inkSecondary}>{item.detail}</M></View>) : null}
      {content.type === 'text' ? <T s={13} lh={1.5} c={K.ink}>{content.text}</T> : null}
      {content.type === 'log' ? <RecessedScreen radius={14} style={{ padding: 12, gap: 6 }}>{content.lines.map((line, i) => <M key={i} s={10} lh={1.6} c={K.onScreen}>{line}</M>)}</RecessedScreen> : null}
      {content.type === 'series' ? <Series content={content} /> : null}
      {content.type === 'action' ? <><T s={13} lh={1.4} c={K.ink} numberOfLines={4}>{content.message}</T><Keycap variant="primary" label={content.label} onPress={onAction} /><M s={9.5} ls={0.04} c={K.inkTertiary}>CONVERSACIÓN NUEVA</M></> : null}
    </View>
    {failed ? <T s={13} c={K.dangerText}>La última actualización falló. Se muestra el contenido anterior si está disponible.</T> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
      <M s={9.5} ls={0.04} c={failed ? K.dangerText : stale ? K.accentText : K.inkTertiary} style={{ maxWidth: '100%' }}>{card.status === 'updating' ? 'ACTUALIZANDO · ' : failed ? 'FALLIDA · ' : stale ? 'VIEJA · ' : ''}{time}</M>
      {compact ? newChip : null}
    </View>
  </View>;
}
function Series({ content }: { content: Extract<BoardCard['content'], { type: 'series' }> }) {
  const { K } = usePalette();
  const min = Math.min(0, ...content.points.map(p => p.value)), max = Math.max(1, ...content.points.map(p => p.value));
  const start = content.points[0].at, end = content.points.at(-1)!.at;
  const points = content.points.map(p => `${8 + (p.at - start) / Math.max(1, end - start) * 284},${68 - (p.value - min) / (max - min) * 60}`).join(' ');
  return <RecessedScreen radius={14} style={{ padding: 12, gap: 4 }}><M s={9.5} ls={0.04} c={K.onScreenLabel}>{content.unit.toUpperCase()} · {content.points.at(-1)!.value} AHORA</M><Svg accessibilityLabel={`Serie temporal: ${content.points.map(p => `${new Date(p.at).toISOString()}: ${p.value}`).join(', ')}`} width="100%" height={80} viewBox="0 0 300 80"><Line x1={8} y1={70} x2={292} y2={70} stroke={K.onScreenLabel} strokeOpacity={0.4}/><Polyline points={points} fill="none" stroke={K.okTextOnScreen} strokeWidth={3} /></Svg><M s={9.5} c={K.onScreenLabel}>{new Date(start).toLocaleDateString('es-MX')} — {new Date(end).toLocaleDateString('es-MX')}</M></RecessedScreen>;
}
