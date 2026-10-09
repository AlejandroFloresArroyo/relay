import { useLocalSearchParams } from 'expo-router';
import { AppUpdateScreen } from '@/screens/AppUpdateScreen';
export default function AppUpdateRoute() {
  const { server } = useLocalSearchParams<{ server: string | string[] }>();
  return <AppUpdateScreen serverId={typeof server === 'string' && server.length <= 256 ? server : ''}/>;
}
