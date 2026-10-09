import { useLocalSearchParams } from 'expo-router';
import { AgentSoulScreen } from '@/screens/AgentSoulScreen';
export default function SoulRoute() {
  const { server, agent } = useLocalSearchParams<{server:string;agent:string}>();
  return <AgentSoulScreen serverId={server} agentId={agent}/>;
}
