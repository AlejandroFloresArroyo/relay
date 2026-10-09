import { useState } from 'react';
import { Pressable, ScrollView } from 'react-native';

import type { EntryResult } from '@/core/remoteAccess';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { TEXT_GLOW, TYPE } from '@/theme/tokens';
import { Keycap } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { SubjectStateBlock } from '@/ui/states';
import { FingerprintRing } from './FingerprintRing';

const NOTICES: Record<Exclude<EntryResult, 'verified'>, string> = {
  unavailable: 'Este teléfono no tiene huella ni código configurados. Configura uno en los ajustes del teléfono para entrar.',
  cancelled: 'No se verificó. Las herramientas siguen cerradas.',
  locked: 'Relay se bloqueó durante la verificación. Vuelve a entrar.',
  refused: 'Este dispositivo perdió el acceso durante la verificación.',
};

/**
 * What a Servidor's tools show while they are not entered (D-21): the fingerprint gate inside the
 * recessed screen, or, when control or access was lost, why (D-ES). Herramientas and the Archivos
 * panel beside a Conversación share it, and the entry it opens.
 */
export function RemoteGate({ access, name }: { access: ServerRemoteAccess; name: string }) {
  const { K } = usePalette();
  const [notice, setNotice] = useState<string | null>(null);
  const verifying = access.view === 'verifying';
  const enter = async () => {
    setNotice(null);
    const result = await access.enter(`Entrar a las herramientas de ${name}`);
    if (result && result !== 'verified') setNotice(NOTICES[result]);
  };
  if (access.view === 'revoked' || access.view === 'suspended') {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
        {access.view === 'revoked'
          ? <SubjectStateBlock spec={{ kind: 'noAccess', phrase: `Este dispositivo ya no tiene acceso a ${name}. Relay cortó sus conexiones, transferencias y controles con las herramientas.` }} />
          : <SubjectStateBlock spec={{ kind: 'noControl', phrase: `Ahora no hay control sobre ${name}. Tus terminales siguen ahí.`, action: { label: 'Volver a entrar con huella', onPress: () => { void enter(); } } }} />}
      </ScrollView>
    );
  }
  return (
    <RecessedScreen radius={20} style={{ flex: 1, marginBottom: 12, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 18 }}>
      <FingerprintRing />
      <M s={13} w="600" ls={0.08} c={K.accent} glow={TEXT_GLOW.accent} style={{ textAlign: 'center' }}>{verifying ? 'VERIFICANDO…' : 'PON TU HUELLA PARA ENTRAR'}</M>
      <T s={15} lh={1.45} c={K.onScreen} style={{ textAlign: 'center', maxWidth: 280 }}>
        Verifica que eres tú con tu huella o con el código del teléfono. Vale para {name} hasta que Relay se bloquee.
      </T>
      <Keycap variant="primary" label="Entrar con huella" accessibilityLabel="Entrar con huella" disabled={verifying} onPress={() => { void enter(); }} style={{ width: 280, maxWidth: '100%' }} />
      <Pressable accessibilityRole="button" disabled={verifying} onPress={() => { void enter(); }} style={{ minHeight: 48, justifyContent: 'center', opacity: verifying ? 0.45 : 1 }}>
        <T {...TYPE.body} c={K.accent}>Usar el código del teléfono</T>
      </Pressable>
      {notice ? <T {...TYPE.secondary} c={K.dangerTextOnScreen} style={{ textAlign: 'center' }}>{notice}</T> : null}
    </RecessedScreen>
  );
}
