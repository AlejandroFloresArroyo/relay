import { useLocalSearchParams } from 'expo-router';
import { NotificationSettingsScreen } from '@/screens/NotificationSettingsScreen';
export default function NotificationSettingsRoute() {
  const {server,state}=useLocalSearchParams<{server:string;state?:string}>();
  return <NotificationSettingsScreen key={`${server}:${state}`} serverId={server} demoState={state}/>;
}
