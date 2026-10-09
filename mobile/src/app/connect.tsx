import { useLocalSearchParams } from 'expo-router';
import { useApp } from '@/state/app';
import { ConnectScreen } from '@/screens/ConnectScreen';

export default function ConnectRoute() {
  const { ready } = useApp();
  const { serverId, discoveredUrl } = useLocalSearchParams<{ serverId?: string; discoveredUrl?: string }>();
  if (!ready) return null;
  return <ConnectScreen key={serverId ?? 'new'} discoveredUrl={typeof discoveredUrl === 'string' ? discoveredUrl : undefined} serverId={typeof serverId === 'string' ? serverId : undefined} />;
}
