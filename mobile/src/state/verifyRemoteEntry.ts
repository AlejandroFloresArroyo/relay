import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { demoRemoteEntry } from '@/core/demoRemote';
import type { EntryOutcome } from '@/core/remoteAccess';

/**
 * The system verification for entering the remote tools: fingerprint, or the phone code when the
 * person prefers it or has no fingerprint (docs/relay-v3.md §2). Unlike confirmWithFingerprint, the
 * device credential is accepted here, as when unlocking Relay. Expo 57 asks for the code itself when
 * no biometric is enrolled (BiometricPrompt with DEVICE_CREDENTIAL), and answers `not_enrolled` when the
 * phone has no secure lock at all: that is the only way to have no verification, and it denies entry.
 */
export async function verifyRemoteEntry(prompt: string): Promise<EntryOutcome> {
  if (process.env.EXPO_PUBLIC_RELAY_DEMO === '1') return demoRemoteEntry();
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt, fallbackLabel: 'Usar el código del teléfono', disableDeviceFallback: false,
    });
    if (result.success === true) return 'verified';
    return result.error === 'not_enrolled' || result.error === 'not_available' || result.error === 'passcode_not_set' ? 'unavailable' : 'cancelled';
  } catch {
    return 'cancelled';
  }
}
