import { resetWidget, widgetListenerCount } from './widget';
jest.unmock('react-native/Libraries/Utilities/useColorScheme');

import { resetVpn, vpnListeners } from './vpn';
import { resetNotifications } from './notifications';
import { resetSpeech, speechListenerCount } from './dictation';
import { resetImages } from './images';
import { resetFiles } from './files';
import { resetClipboard } from './clipboard';
import { resetTerminalSurfaces } from './terminalSurface';
import { resetWebViews } from './webView';
import { act, cleanup } from '@testing-library/react-native';
import { appearanceSubscriptionCount, cancelDeferred, clockStart, reduceMotionListenerCount, resetNative, subscriptionCounts } from './native';
import { cancelStreams, resetTransport, streamCount, unexpectedRequests } from './transport';
import { Animated, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

// React Native loads these components and its renderer lazily, on first render. With a cold
// transform cache that costs seconds inside the first test of each file and its 5 s timeout;
// loading them here moves that cost to file setup, which has no timeout.
void [Animated, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, Text, TextInput, View];

jest.mock('expo', () => {
  const actual = jest.requireActual('expo');
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'RelayVpnStatus' ? require('./vpn').vpn : actual.requireOptionalNativeModule(name) };
});

jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'RelayWidget' ? require('./widget').widgetNative : actual.requireOptionalNativeModule(name) };
});
jest.mock('@/native/notifications', () => require('./notifications'));
jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: require('./dictation').speech, useSpeechRecognitionEvent: require('./dictation').useSpeechRecognitionEvent }));
jest.mock('expo-image-picker', () => require('./images').imagePicker);
jest.mock('expo-image-manipulator', () => require('./images').imageManipulator);
jest.mock('expo-file-system', () => require('./files').fileSystem);
jest.mock('expo-file-system/legacy', () => require('./files').legacyFileSystem);
jest.mock('expo-sharing', () => require('./files').sharing);
jest.mock('expo-intent-launcher', () => require('./files').intentLauncher);
jest.mock('expo-clipboard', () => require('./clipboard').clipboard);
// The 'use dom' terminal is a WebView on Android: a native boundary.
jest.mock('@/screens/terminal/TerminalSurface', () => require('./terminalSurface'));
// The web viewer's react-native-webview is the other native WebView boundary.
jest.mock('react-native-webview', () => require('./webView'));
jest.mock('expo-secure-store', () => require('./native').secureStore);
jest.mock('expo-local-authentication', () => require('./native').biometrics);
jest.mock('expo-camera', () => ({
  useCameraPermissions: require('./native').useCameraPermissions,
  CameraView: 'CameraView',
}));
jest.mock('expo/fetch', () => ({ fetch: require('./transport').controlledFetch }));
jest.mock('expo-router', () => ({
  Stack: require('./native').NativeStack,
  router: require('./native').router,
  usePathname: () => require('./native').usePathname(),
  useGlobalSearchParams: () => require('./native').useGlobalSearchParams(),
  useNavigationContainerRef: () => require('./native').navigationContainer,
  useLocalSearchParams: () => require('./native').navigation.params,
  useFocusEffect: require('./native').useFocusEffect,
}));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(clockStart);
  resetNative(); resetNotifications(); resetVpn(); resetWidget(); resetTransport(); resetSpeech(); resetImages(); resetFiles(); resetClipboard(); resetTerminalSurfaces(); resetWebViews();
});
afterEach(async () => {
  await act(async () => { cleanup(); });
  await act(async () => { cancelStreams(); await cancelDeferred(); await jest.advanceTimersByTimeAsync(1000); });
  jest.runAllTicks();
  try {
    expect(unexpectedRequests).toEqual([]);
    expect(subscriptionCounts()).toEqual({ app: 0, links: 0 });
    expect(streamCount()).toBe(0);
    expect(appearanceSubscriptionCount()).toBe(0);
    expect(reduceMotionListenerCount()).toBe(0);
    expect(speechListenerCount()).toBe(0);
    expect(vpnListeners()).toBe(0);
    expect(widgetListenerCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers(); jest.useRealTimers();
  }
});
