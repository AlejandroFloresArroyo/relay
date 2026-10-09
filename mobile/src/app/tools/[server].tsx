import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent } from 'react';
import { View } from 'react-native';

import { useApp } from '@/state/app';
import { useReturn } from '@/state/navigation';

// ServerToolsHost, beside the Stack in the root layout, shows the tools of this route's Servidor and
// draws its return; this screen holds the route's place in the history, selects its Servidor and owns the back key.
export default function ServerToolsRoute() {
  const { server } = useLocalSearchParams<{ server: string }>();
  const { selectServer } = useApp();
  // Only on entering: a Servidor chosen later in the rail selector stays chosen.
  const enter = useEffectEvent(() => { if (server) selectServer(server); });
  useEffect(() => { enter(); }, [server]);
  useReturn();
  return <View style={{ flex: 1 }}><Stack.Screen options={{ animation: 'none' }} /></View>;
}
