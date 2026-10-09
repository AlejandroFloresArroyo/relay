import type { ExpoSpeechRecognitionModule, ExpoSpeechRecognitionNativeEventMap } from 'expo-speech-recognition';
import type { RelayClient } from './client.ts';
type ExpoSpeechRecognitionModuleType = typeof ExpoSpeechRecognitionModule;
export const DEMO_DICTATION_SCENARIOS = [
  { id: 'idle', name: 'Listo para dictar' }, { id: 'listening', name: 'Dictando' },
  { id: 'finishing', name: 'Terminando' }, { id: 'model-missing', name: 'Falta el modelo de voz' },
  { id: 'permission-missing', name: 'Sin permiso de micrófono' },
  { id: 'checking', name: 'Comprobando modelo local…' }, { id: 'error', name: 'Error de dictado' },
  { id: 'blocked', name: 'Micrófono sin respuesta' },
] as const;
export type DemoDictationScenario = typeof DEMO_DICTATION_SCENARIOS[number]['id'];
const scenarios = new Map<string, DemoDictationScenario>();
export function demoDictationScenario(serverId: string) { return scenarios.get(serverId) ?? 'idle'; }
export function resetDemoDictation() { scenarios.clear(); }
export function setDemoDictationScenario(serverId: string, scenario: DemoDictationScenario) { scenarios.set(serverId, scenario); }
// Dictation is local. The composition point intentionally adds no Puente method.
export function createDemoDictation(_serverId: string, _now: () => number): Partial<RelayClient> { return {}; }
export function createDemoSpeech(scenario: DemoDictationScenario): Pick<ExpoSpeechRecognitionModuleType, 'supportsOnDeviceRecognition' | 'getSupportedLocales' | 'getPermissionsAsync' | 'requestPermissionsAsync' | 'start' | 'stop' | 'abort' | 'addListener'> {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const emit = <K extends keyof ExpoSpeechRecognitionNativeEventMap>(name: K, event: ExpoSpeechRecognitionNativeEventMap[K]) => {
    for (const listener of listeners.get(name) ?? []) listener(event as never);
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const finish = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); emit('end', null); };
  const partial = (transcript: string) => emit('result', { isFinal: false, results: [{ transcript, confidence: 1, segments: [] }] });
  const permission = { granted: scenario !== 'permission-missing', canAskAgain: false, status: scenario === 'permission-missing' ? 'denied' : 'granted', expires: 'never', restricted: false };
  return {
    supportsOnDeviceRecognition: () => true,
    getSupportedLocales: async () => {
      if (scenario === 'checking') return new Promise(() => {});
      if (scenario === 'error') throw new Error('Demo local recognition unavailable');
      return { locales: ['es-US'], installedLocales: scenario === 'model-missing' ? [] : ['es-US'] };
    },
    getPermissionsAsync: async () => permission as Awaited<ReturnType<ExpoSpeechRecognitionModuleType['getPermissionsAsync']>>,
    requestPermissionsAsync: async () => permission as Awaited<ReturnType<ExpoSpeechRecognitionModuleType['requestPermissionsAsync']>>,
    start: () => {
      partial('Revisa');
      timers.add(setTimeout(() => partial('Revisa también el test de pagos'), 500));
      timers.add(setTimeout(() => partial('Revisa también el test de pagos y dime si falla por lo mismo'), 1500));
    },
    stop: finish, abort: finish,
    addListener: (name, listener) => {
      const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(listener as (event: never) => void);
      return { remove: () => { set.delete(listener as (event: never) => void); } };
    },
  };
}
