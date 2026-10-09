import { View } from 'react-native';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { classifyConnectionError } from '@/core/connectionStatus';
import type { PreparedImage } from '@/core/chatImages';
import { useApp } from '@/state/app';
import { useDraftStore } from '@/state/sharedDrafts';
import { useShareScope } from '@/state/useShareScope';
import { usePalette } from '@/theme/ThemeProvider';
import { SubjectStateBlock } from '@/ui/states';
import { ChatScreen } from './ChatScreen';
interface Props { serverId: string; agentId: string; shareDraft?: string; initialDraft?: string; initialConversationId?: string; initialPanelOpen?: boolean }
export function ChatRouteContent(props: Props) {
  return props.shareDraft ? <SharedChat {...props} shareDraft={props.shareDraft} /> : <ChatScreen {...props} />;
}
function SharedChat({ serverId, agentId, shareDraft }: Props & { shareDraft: string }) {
  const { clientFor, servers, snapshot } = useApp(); const store = useDraftStore();
  const { K } = usePalette();
  const client = clientFor(serverId);
  const target = useMemo(() => ({ serverId, agentId, client }), [serverId, agentId, client]);
  // A store read, not a memoizable value: purge on lock must withdraw the row.
  const row = useSyncExternalStore(store.subscribe, () => store.byId(target, shareDraft));
  const [accepted, setAccepted] = useState(false);
  const [retired, setRetired] = useState(false);
  const control = useShareScope(client);
  const valid = servers.some((server) => server.id === serverId) && snapshot(serverId).down?.action !== 'pair';
  // Frozen seed: later composer edits must not remount the Conversation on a poll.
  const [seed] = useState(() => row ? { text: row.text, image: row.image ?? undefined, client } : null);
  
  if (retired || store.isRetired(client) || !valid || (!row && !accepted) || !seed || seed.client !== client) return <View style={{ flex: 1, backgroundColor: K.background, padding: 16 }}><SubjectStateBlock spec={{ kind: 'empty', title: 'BORRADOR NO DISPONIBLE', phrase: 'Este borrador ya no está disponible para este destino. Comparte el contenido de nuevo.' }} /></View>;
  return <View style={{ flex: 1, display: control.visible ? 'flex' : 'none' }} accessibilityElementsHidden={!control.visible} importantForAccessibility={control.visible ? 'auto' : 'no-hide-descendants'}><ChatScreen serverId={serverId} agentId={agentId} initialDraft={seed.text} initialImage={seed.image as PreparedImage | undefined}
    onSharedDraftFailure={(failure) => {
      if (classifyConnectionError(failure).action === 'pair') { store.retire(client); setRetired(true); }
    }}
    onSharedDraftChange={(text) => store.update(target, shareDraft, text)}
    onSharedDraftImageChange={(image) => store.updateImage(target, shareDraft, image)} beginSharedMutation={control.begin}
    beginSharedSend={() => { const settle = store.send(shareDraft); return (outcome) => { if (settle(outcome)) setAccepted(true); }; }} preserveSharedImage={(image) => store.byId(target, shareDraft)?.image?.image.attachmentId === image.image.attachmentId} /></View>;
}
