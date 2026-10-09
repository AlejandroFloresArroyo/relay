import { usePalette } from '@/theme/ThemeProvider';
import { Modal, View } from 'react-native';

import { TEXT_GLOW, TYPE } from '@/theme/tokens';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

export function GatewayConfirmation({ action, visible, serverName, onConfirm, onCancel }: {
  action: 'stop' | 'restart'; visible: boolean; serverName: string; onConfirm: () => void; onCancel: () => void;
}) {
  const { K } = usePalette();
  return <Modal transparent visible={visible} onRequestClose={onCancel}>
    <View style={{ flex: 1, backgroundColor: K.sheetBackdrop, justifyContent: 'center', paddingHorizontal: 20 }}>
      <View style={{ backgroundColor: K.block, borderRadius: 28, padding: 14, gap: 12, boxShadow: K.shadowSheet }}>
        <RecessedScreen radius={18} style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: K.dangerText }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Lamp tone="red" size={9} />
            <M s={10} w="600" ls={0.06} c={K.dangerTextOnScreen} glow={TEXT_GLOW.danger} style={{ flex: 1 }}>
              ¿{action === 'stop' ? 'DETENER' : 'REINICIAR'} EL GATEWAY DE {serverName.toUpperCase()}?
            </M>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <M {...TYPE.label} c={K.dangerTextOnScreen} style={{ width: 74 }}>CANALES</M>
            <T s={13} c={K.onScreenBright} style={{ flex: 1 }}>Se interrumpe la conexión con los canales del gateway.</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <M {...TYPE.label} c={K.dangerTextOnScreen} style={{ width: 74 }}>HERMES</M>
            <T s={13} c={K.onScreenBright} style={{ flex: 1 }}>Los Turnos y tareas que corran en procesos aparte pueden continuar.</T>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <M {...TYPE.label} c={K.dangerTextOnScreen} style={{ width: 74 }}>RELAY</M>
            <T s={13} c={K.onScreenBright} style={{ flex: 1 }}>El Puente permanece disponible; puedes volver a iniciar el gateway desde aquí.</T>
          </View>
        </RecessedScreen>
        <T s={12} c={K.inkSecondary} style={{ paddingHorizontal: 4 }}>Para retener trabajo nuevo, usa Pausa general. Este control solo cambia el gateway.</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Keycap label="Cancelar" onPress={onCancel} style={{ flex: 1 }} />
          <Keycap variant="danger" label={action === 'stop' ? 'Detener gateway' : 'Reiniciar gateway'} onPress={onConfirm} style={{ flex: 1.2 }} />
        </View>
      </View>
    </View>
  </Modal>;
}
