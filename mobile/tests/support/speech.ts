import { useEffect } from 'react';
import type { ExpoSpeechRecognitionNativeEventMap } from 'expo-speech-recognition';
const listeners = new Map<string, Set<(event: never) => void>>();
const unavailable = () => { throw new Error('Speech fixture is not configured'); };
function addListener(name: string, callback: (event: never) => void) {
    const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(callback);
    return { remove: () => { set.delete(callback); if (!set.size) listeners.delete(name); } };
}
export const speech = {
  start: jest.fn<void, [unknown]>(unavailable), stop: jest.fn(), abort: jest.fn(),
  isRecognitionAvailable: jest.fn(() => false), supportsOnDeviceRecognition: jest.fn(() => false),
  getSupportedLocales: jest.fn(async (_options?: unknown): Promise<{ locales: string[]; installedLocales: string[] }> => unavailable()),
  requestPermissionsAsync: jest.fn(async (): Promise<{ granted: boolean; canAskAgain: boolean; status: string }> => unavailable()),
  getPermissionsAsync: jest.fn(async (): Promise<{ granted: boolean; canAskAgain: boolean; status: string }> => unavailable()),
  addListener: jest.fn(addListener),
};
export function useSpeechRecognitionEvent<K extends keyof ExpoSpeechRecognitionNativeEventMap>(name: K, listener: (event: ExpoSpeechRecognitionNativeEventMap[K]) => void) {
  useEffect(() => { const subscription = speech.addListener(name, listener as (event: never) => void); return () => subscription.remove(); }, [name, listener]);
}
export function emitSpeech<K extends keyof ExpoSpeechRecognitionNativeEventMap>(name: K, event: ExpoSpeechRecognitionNativeEventMap[K]) {
  for (const listener of listeners.get(name) ?? []) listener(event as never);
}
export function speechListenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
export function resetSpeech() {
  listeners.clear();
  for (const mock of Object.values(speech)) mock.mockClear();
  speech.addListener.mockReset().mockImplementation(addListener);
  speech.start.mockReset().mockImplementation(unavailable); speech.stop.mockReset(); speech.abort.mockReset();
  speech.isRecognitionAvailable.mockReset().mockReturnValue(false); speech.supportsOnDeviceRecognition.mockReset().mockReturnValue(false);
  speech.getSupportedLocales.mockReset().mockImplementation(async () => unavailable());
  speech.requestPermissionsAsync.mockReset().mockImplementation(async () => unavailable());
  speech.getPermissionsAsync.mockReset().mockImplementation(async () => unavailable());
}
