import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

/** Sensitive actions require biometrics; unlocking Relay has a separate fallback policy. */
export async function confirmWithFingerprint(prompt: string, guard: () => boolean = () => true): Promise<boolean> {
  if (!guard()) return false;
  if (process.env.EXPO_PUBLIC_RELAY_DEMO === '1') return guard();
  if (Platform.OS !== 'android') return false;
  try {
    if (!(await LocalAuthentication.hasHardwareAsync()) || !guard()) return false;
    if (!(await LocalAuthentication.isEnrolledAsync()) || !guard()) return false;
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Cancelar', disableDeviceFallback: true, biometricsSecurityLevel: 'strong' });
    return guard() && result.success === true;
  } catch { return false; }
}
