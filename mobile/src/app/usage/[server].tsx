import { useLocalSearchParams } from 'expo-router';
import { UsageScreen } from '@/screens/UsageScreen';
export default function UsageRoute() {
  const { server } = useLocalSearchParams<{ server: string }>();
  return <UsageScreen serverId={server} />;
}
