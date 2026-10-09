import { usePalette } from '@/theme/ThemeProvider';
import type { ProtocolCompatibility } from '@/core/protocolVersion';

import { RecessedScreen } from './machinery';
import { M, T } from './primitives';

export function ProtocolNotice({ protocol, stale }: { protocol: ProtocolCompatibility | null; stale: boolean }) {
  const { K } = usePalette();
  if (!protocol || protocol.kind === 'compatible') return null;
  return (
    <RecessedScreen rim radius={16} style={{ paddingVertical: 11, paddingHorizontal: 14, gap: 4 }}>
      <T s={14} w="700" c={K.accent} accessibilityRole="header">{protocol.message}</T>
      <T s={12.5} lh={1.5} c={K.onScreen}>
        {protocol.kind === 'invalid' ? 'El Puente respondió con una declaración de protocolo inválida.' : 'Puedes seguir usando las funciones compatibles.'}
      </T>
      {stale ? <M s={9.5} c={K.onScreenLabel}>ÚLTIMO DATO CONOCIDO · SIN VERIFICAR</M> : null}
    </RecessedScreen>
  );
}
