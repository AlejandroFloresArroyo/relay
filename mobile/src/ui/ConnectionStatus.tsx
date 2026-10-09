import { useState } from 'react';
import { View } from 'react-native';

import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import { describeTailscaleButton, transitionTailscaleButton, type TailscaleButtonState } from '@/core/tailscaleButton';
import { openTailscale } from '@/state/openTailscale';

import { Keycap } from './kit';
import { StateRow, SubjectStateBlock, type StateSpec } from './states';

/**
 * A Servidor that does not answer or refuses this phone. As the screen's subject (its ficha) it is
 * the big block with the diagnosis, its hint and «Abrir Tailscale»; anywhere else, the compact row (D-ES).
 */
export function ConnectionStatus({ serverName, diagnosis = classifyConnectionError(null), onRetry, onPair, subject = false }: {
  serverName: string;
  diagnosis?: ConnectionDiagnosis;
  onRetry: () => void;
  onPair?: () => void;
  subject?: boolean;
}) {
  const [tailscaleState, setTailscaleState] = useState<TailscaleButtonState>('ready');
  const pair = diagnosis.action === 'pair' && onPair ? { label: 'Emparejar de nuevo' as const, onPress: onPair } : undefined;
  if (!subject) {
    return <StateRow name={serverName} kind={diagnosis.kind === 'unreachable' ? 'unreachable' : pair ? 'noAccess' : 'error'} label={diagnosis.label}
      onRetry={onRetry} action={pair} />;
  }
  const tailscaleButton = describeTailscaleButton(tailscaleState);
  const launch = async () => {
    const transition = transitionTailscaleButton(tailscaleState, { type: 'press' });
    setTailscaleState(transition.state);
    if (transition.effect === 'retry') onRetry();
    if (transition.effect === 'open') {
      const opened = await openTailscale();
      setTailscaleState((state) => transitionTailscaleButton(state, { type: 'result', opened }).state);
    }
  };
  const spec: StateSpec = diagnosis.kind === 'unreachable'
    ? { kind: 'unreachable', title: diagnosis.label === 'SIN RESPUESTA' ? undefined : diagnosis.label, phrase: `Relay no alcanza a ${serverName}. ${diagnosis.hint}`, onRetry }
    : { kind: 'error', title: diagnosis.label, phrase: diagnosis.hint, action: pair, onRetry };
  return <View style={{ gap: 12 }}>
    <SubjectStateBlock spec={spec} />
    {diagnosis.action === 'tailscale' ? <Keycap variant="primary" label={tailscaleButton.label} disabled={tailscaleButton.disabled} onPress={() => { void launch(); }} /> : null}
  </View>;
}
