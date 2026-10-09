import { View } from 'react-native';

import { useRemoteAccess } from '@/state/remoteAccess';
import { useRemoteTools } from '@/state/remoteTools';
import { usePalette } from '@/theme/ThemeProvider';
import { IconKey } from '@/ui/kit';
import { M } from '@/ui/primitives';
import { FilesTool } from '../files/FilesTool';
import type { EntryDrag } from '../files/parts';
import { RemoteGate } from '../tools/RemoteGate';

const PADDING = 12;
/** From the panel's left edge to a file row's: the panel's padding and the list block's (ListBlock, 12). */
export const FILES_ROW_INSET = PADDING + 12;

/**
 * #114: Archivos beside a Conversación on a tablet (D-TB-3), in ACTIVIDAD's place. The same tool and
 * fingerprint entry as Herramientas: entered there, it opens here straight to the folder.
 */
export function ChatFilesPanel({ serverId, serverName, onClose, drag }: { serverId: string; serverName: string; onClose: () => void; drag: EntryDrag }) {
  const { K } = usePalette();
  const access = useRemoteAccess(serverId);
  const { tools, files } = useRemoteTools(serverId);
  return <View style={{ flex: 1, width: 320, padding: PADDING, gap: 8, borderRadius: 20, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <M s={9.5} w="600" ls={0.08} c={K.inkTertiary} accessibilityRole="header" style={{ flex: 1 }}>ARCHIVOS DEL SERVIDOR</M>
      <IconKey glyph="✕" accessibilityLabel="Cerrar Archivos" onPress={onClose} />
    </View>
    {access.view === 'open'
      ? <FilesTool serverId={serverId} client={files} admit={access.admit} active={tools.files?.state === 'available'} onOpenTerminal={null} drag={drag} />
      : <RemoteGate access={access} name={serverName} />}
  </View>;
}
