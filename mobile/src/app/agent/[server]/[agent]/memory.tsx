import { useLocalSearchParams } from 'expo-router';
import { AgentMemoryScreen } from '@/screens/AgentMemoryScreen';
export default function MemoryRoute() {
  const { server, agent } = useLocalSearchParams<{server:string;agent:string}>();
  return <AgentMemoryScreen serverId={server} agentId={agent}/>;
}
