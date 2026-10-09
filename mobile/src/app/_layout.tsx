import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
  HankenGrotesk_800ExtraBold,
} from '@expo-google-fonts/hanken-grotesk';
import { MartianMono_400Regular, MartianMono_500Medium, MartianMono_600SemiBold } from '@expo-google-fonts/martian-mono';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ApprovalSheet } from '@/screens/ApprovalSheet';
import { AutoLockSheet } from '@/screens/SettingsScreen';
import { DraftProvider } from '@/state/sharedDrafts';
import { ShareLauncher } from '@/screens/ShareLauncher';
import { ServerToolsHost } from '@/screens/ServerToolsHost';
import { LockGate } from '@/screens/LockGate';
import { WidgetBridge, WidgetTarget } from '@/state/WidgetBridge';
import { NotificationProvider } from '@/state/notifications';
import { AppProvider } from '@/state/app';
import { ThemeProvider, usePalette } from '@/theme/ThemeProvider';
import { RelayShell } from '@/ui/RelayShell';
import { SelectorToast } from '@/ui/ServerSelector';
import { DeviceFrame } from '@/ui/chrome';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    HankenGrotesk_800ExtraBold,
    MartianMono_400Regular,
    MartianMono_500Medium,
    MartianMono_600SemiBold,
  });

  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);

  if (!loaded && !error) return null;

  // gesture-handler's gestures work only under its root view: one, for the whole app.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}><ThemeProvider><ThemedApp /></ThemeProvider></GestureHandlerRootView>
  );
}

function ThemedApp() {
  const { K, mode } = usePalette();
  return (
    <AppProvider><NotificationProvider>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <WidgetTarget />
      <DeviceFrame>
        <DraftProvider><LockGate><ShareLauncher />
          <WidgetBridge />
          <RelayShell><View style={{ flex: 1 }}>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: K.background } }} />
            <ServerToolsHost />
          </View></RelayShell>
          <AutoLockSheet />
          <ApprovalSheet />
          <SelectorToast />
        </LockGate></DraftProvider>
      </DeviceFrame>
    </NotificationProvider></AppProvider>
  );
}
