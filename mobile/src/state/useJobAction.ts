import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { RelayError } from '@/core/client';
import { jobAuthorizationCurrent, type JobAuthorization } from '@/core/scheduledJobs';
import { useChatVisible } from './chatVisibility';
import { confirmWithFingerprint } from './confirmWithFingerprint';
export function useJobAction(identity: string, connected: boolean) {
  const visible = useChatVisible();
  const state = useRef<JobAuthorization>({ identity, epoch: 0, visible: false, connected: false, now: 0 });
  const focused = useRef(false);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    state.current = { identity, epoch: state.current.epoch + 1, visible: visible && focused.current && AppState.currentState === 'active', connected, now: 0 };
    return () => { state.current.epoch++; state.current.visible = false; };
  }, [identity, visible, connected]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    state.current.visible = visible && AppState.currentState === 'active';
    return () => { focused.current = false; state.current.visible = false; state.current.epoch++; };
  }, [visible]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', value => {
      if (value === 'background') {
        state.current.visible = false;
        state.current.epoch++;
      }
      else if (value === 'active')
        state.current.visible = visible && focused.current;
    });
    return () => sub.remove();
  }, [visible]);
  function capture() {
    const start = { ...state.current, now: Date.now() };
    return () => jobAuthorizationCurrent(start, { ...state.current, now: Date.now() });
  }
  async function perform(fingerprint: boolean, operation: (isCurrent: () => boolean) => Promise<void>) {
    if (running.current)
      return;
    const isCurrent = capture();
    if (!isCurrent()) {
      setError('Vuelve a conectar el Servidor antes de continuar.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (fingerprint && !await confirmWithFingerprint('Confirmar tarea con huella')) {
        if (isCurrent()) setError('No se confirmó la huella.');
        return;
      }
      if (!isCurrent()) return;
      await operation(isCurrent);
    }
    catch (error) {
      if (!isCurrent()) return;
      setError(error instanceof RelayError && error.status === 400 ? 'Hermes rechazó los datos. Revisa el horario y los campos de la tarea.'
        : error instanceof RelayError && error.status === 404 ? 'La tarea ya no existe en este Agente. Actualiza la lista.'
          : error instanceof RelayError && error.status === 409 ? error.message
            : 'La operación quedó sin confirmar. Actualiza antes de reintentar; puede haberse aplicado en el Servidor.');
    }
    finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, perform, capture };
}
