import { usePalette } from '@/theme/ThemeProvider';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import type { AgentStatus } from '../../../../protocol/protocol';

import { Avatar, BackLink, IconKey, LedTrio } from '@/ui/kit';
import { PauseSymbol } from '@/ui/PauseStrip';
import { M, T } from '@/ui/primitives';
import { avatarFor } from '../AgentsScreen';

export interface ChatHeaderProps {
  agentId: string; agentName: string; serverName: string; model: string; status: AgentStatus;
  /** The return, «‹ <label>»; none when the router has no place to name. */
  onBack?: () => void; backLabel?: string;
  /** The mono line under the name (the model control); `serverName · model` by default. */
  modelControl?: ReactNode;
  /** The Conversación and Personalidad selectors, under the identity. */
  selectors?: ReactNode;
  onAgent?: () => void; paused?: boolean;
  /** The Servidor's tools (`>_`); going back from them returns to this Conversación. */
  onTools?: () => void;
  /** «⋯»: the Conversación's actions. */
  onActions?: () => void;
}

/** Encabezado B of the Conversación (F-2, D-09): return and keys, the identity with ON/BSY/ERR, then its selectors. */
export function ChatHeader({ agentId, agentName, serverName, model, status, onBack, backLabel, modelControl, selectors, onAgent, paused, onTools, onActions }: ChatHeaderProps) {
  const { K } = usePalette();
  return (
    <View style={{ paddingLeft: 16, paddingRight: 12, paddingBottom: 8, gap: 8 }}>
      <View style={{ minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {onBack && backLabel ? <BackLink to={backLabel} onPress={onBack} /> : null}
        <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {onTools ? <IconKey glyph=">_" accessibilityLabel={`Herramientas de ${serverName}`} onPress={onTools} /> : null}
          {onActions ? <IconKey glyph="⋯" accessibilityLabel="Acciones de la Conversación" onPress={onActions} /> : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Ver ficha del Agente" onPress={onAgent} disabled={!onAgent}>
          {paused ? <PauseSymbol size={40} /> : <Avatar source={avatarFor(agentId)} size={40} />}
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <T s={20} w="800" ls={-0.015} c={K.ink} numberOfLines={1} accessibilityRole="header">{agentName}</T>
          {modelControl ?? <M s={9.5} ls={0.04} c={K.inkTertiary} numberOfLines={1}>{serverName.toUpperCase()} · {model.toUpperCase()}</M>}
        </View>
        <LedTrio state={status} />
      </View>
      {selectors ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginLeft: -4 }}>{selectors}</View> : null}
    </View>
  );
}
