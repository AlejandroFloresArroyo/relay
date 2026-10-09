import { useLocalSearchParams } from 'expo-router';
import { NotificationNoticeScreen } from '@/screens/NotificationNoticeScreen';
export default function NotificationNoticeRoute() {
  const {server,notice}=useLocalSearchParams<{server:string;notice:string}>();
  return <NotificationNoticeScreen key={`${server}:${notice}`} serverId={server} noticeId={notice}/>;
}
