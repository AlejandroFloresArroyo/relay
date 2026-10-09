import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { RunRequest } from '../../../../protocol/protocol';
import { addFile } from '@/core/chatFiles';
import { usePalette } from '@/theme/ThemeProvider';
import { M } from '@/ui/primitives';

const scopeKey = (server: string, agent: string, conversation: string | null) => JSON.stringify([server, agent, conversation ?? '@new']);

/** A Servidor file attached by reference: its name, and its path below in mono. In the composer it has a «Quitar archivo» key. */
export function ServerFileChip({ path, onRemove, disabled = false, onInk = false }: { path: string; onRemove?: () => void; disabled?: boolean; onInk?: boolean }) {
  const { K } = usePalette();
  const name = path.slice(path.lastIndexOf('/') + 1);
  return <View accessibilityLabel={`Archivo del Servidor ${name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: onInk ? 'rgba(255,255,255,0.08)' : K.field, boxShadow: onInk ? undefined : K.shadowField, maxWidth: '100%' }}>
    <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
      <M s={9.5} w="600" ls={0.06} c={onInk ? K.accent : K.accentText} numberOfLines={1}>ARCHIVO DEL SERVIDOR · {name}</M>
      <M s={9.5} c={onInk ? K.block : K.inkTertiary} numberOfLines={1} ellipsizeMode="middle">{path}</M>
    </View>
    {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel="Quitar archivo" disabled={disabled} onPress={onRemove} hitSlop={8}
      style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: K.key, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      <Svg width={10} height={10} viewBox="0 0 12 12"><Path d="M3 3l6 6M3 9l6-6" stroke={K.ink} strokeWidth={2} /></Svg>
    </Pressable> : null}
  </View>;
}

/**
 * #114: the Servidor files a draft names, per Conversación like the image draft. Only paths: nothing
 * is read; the Puente checks each one when the Turno is sent.
 */
export function useChatServerFiles({ serverId, agentId, conversationId, disabled }: { serverId: string; agentId: string; conversationId: string | null; disabled: boolean }) {
  const scope = scopeKey(serverId, agentId, conversationId);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const paths = drafts[scope] ?? [];
  const set = (key: string, next: string[]) => setDrafts((current) => ({ ...current, [key]: next }));
  return {
    hasAttachment: paths.length > 0,
    /** False when the draft already names CHAT_FILE_MAX_COUNT files. */
    add(path: string): boolean {
      const next = addFile(paths, path);
      if (next) set(scope, next);
      return next !== null;
    },
    prepareSend: (request: RunRequest): RunRequest => paths.length ? { ...request, files: paths.map((path) => ({ path })) } : request,
    moveDraft(conversation: string) { if (paths.length) { set(scope, []); set(scopeKey(serverId, agentId, conversation), paths); } },
    /** The Turno exists: the files went with it. A refusal keeps them, like the text. */
    accepted(conversation: string) { set(scopeKey(serverId, agentId, conversation), []); },
    preview: paths.length ? <View style={{ marginHorizontal: 12, gap: 6 }}>
      {paths.map((path) => <ServerFileChip key={path} path={path} disabled={disabled} onRemove={() => set(scope, paths.filter((each) => each !== path))} />)}
    </View> : undefined,
  };
}
