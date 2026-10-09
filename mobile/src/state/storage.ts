import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// Server entries include their device key, so on a phone everything goes to the keychain /
// keystore. The browser has no equivalent: there it is localStorage, which is only acceptable
// because web is the preview target, not the product.

export async function load(key: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function save(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // storage unavailable (private mode, locked keychain): keep running with in-memory state
  }
}

/** Server credentials must never be acknowledged after a failed keychain operation. */
export async function loadServers(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (!globalThis.localStorage) throw new Error('Server storage unavailable');
    return globalThis.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

export async function saveServers(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (!globalThis.localStorage) throw new Error('Server storage unavailable');
    globalThis.localStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}
