import { useLocalSearchParams } from 'expo-router';
import { AgentToolsScreen } from '@/screens/AgentToolsScreen';
export default function ToolsRoute() {
  const { server, agent } = useLocalSearchParams<{ server: string; agent: string }>();
  return <AgentToolsScreen serverId={server} agentId={agent} />;
}
