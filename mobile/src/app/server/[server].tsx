import { useLocalSearchParams } from 'expo-router';
import { ServerScreen } from '@/screens/ServerScreen';
export default function ServerRoute() {
  const { server } = useLocalSearchParams<{ server: string }>();
  return <ServerScreen serverId={server} />;
}
