import { usePalette } from '@/theme/ThemeProvider';
import { Redirect, Tabs } from 'expo-router';

import { TABS } from '@/core/navigation';
import { useApp } from '@/state/app';

import { TabBar } from '@/ui/TabBar';

export default function TabsLayout() {
  const { K } = usePalette();
  const { ready, servers } = useApp();
  if (!ready) return null;
  if (servers.length === 0) return <Redirect href="/connect" />;

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: K.background } }}
      tabBar={({ state, navigation }) => <TabBar active={state.routes[state.index].name} onSelect={(name) => navigation.navigate(name)} />}>
      {TABS.map((tab) => <Tabs.Screen key={tab.key} name={tab.key} />)}
    </Tabs>
  );
}
