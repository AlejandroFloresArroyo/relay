import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
interface WidgetNative {
  /** The Servidor the widget follows (widgetTarget JSON), or null to retire it. */
  target(raw: string | null): void;
  takeOpenRequest(): unknown;
  addListener(event: 'openRequested', listener: () => void): { remove(): void };
}
// Optional: web and older native binaries still render the app normally.
export const widgetNative = Platform.OS === 'android' ? requireOptionalNativeModule<WidgetNative>('RelayWidget') : null;
