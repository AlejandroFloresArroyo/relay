import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useApp } from '@/state/app';
import { CompactStatusContext } from '@/ui/ServerConnectionStatus';
import { StateRow } from '@/ui/states';
import { ServerToolsScreen } from './ServerToolsScreen';

/**
 * Keeps the tools of each Servidor mounted beside the route tree (outline step 7): going back to the
 * Conversación or to another Servidor's tools and returning keeps terminals, folder, draft and page.
 * The Herram. tab shows the selected Servidor's; `/tools/[server]` shows that one. Each Servidor has its
 * own instance, so no state, keyboard or action of one ever reaches another, and switching the selected
 * Servidor never unmounts the others. A Servidor that is no longer paired drops its.
 */
export function ServerToolsHost() {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ server?: string }>();
  const { servers, selectedServer, snapshot, refresh } = useApp();
  const tab = pathname === '/tools';
  const current = tab ? selectedServer : pathname.startsWith('/tools/') && params.server ? params.server : null;
  const [opened, setOpened] = useState<string[]>([]);
  if (current && !opened.includes(current)) setOpened([...opened, current]);
  const kept = opened.filter((id) => id === current || servers.some((s) => s.id === id));
  return (
    <View style={current ? StyleSheet.absoluteFill : { display: 'none' }}>
      {kept.map((id) => (
        <View key={id} style={id === current ? { flex: 1 } : { display: 'none' }}>
          {/* As a tab, like the other Servidor sections: the compact row of an unresponsive Servidor instead of the big block (the selector is in the gate's header A, phone only). */}
          <CompactStatusContext.Provider value={tab}>
            <ServerToolsScreen serverId={id} shown={id === current} root={tab} top={id === current && tab && snapshot(id).reachable === false
              ? <View style={{ paddingVertical: 8 }}><StateRow name={servers.find((s) => s.id === id)?.name ?? id} kind="unreachable" onRetry={() => { refresh(id); }} /></View> : null} />
          </CompactStatusContext.Provider>
        </View>
      ))}
    </View>
  );
}
