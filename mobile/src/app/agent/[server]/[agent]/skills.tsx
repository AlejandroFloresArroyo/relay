import { useLocalSearchParams } from 'expo-router';
import { AgentToolsScreen } from '@/screens/AgentToolsScreen';
export default function SkillsRoute() {
  const { server, agent } = useLocalSearchParams<{ server: string; agent: string }>();
  return <AgentToolsScreen serverId={server} agentId={agent} skillsOnly />;
}
