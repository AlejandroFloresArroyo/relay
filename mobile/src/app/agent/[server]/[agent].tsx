import { useLocalSearchParams } from 'expo-router';
import { AgentDetailScreen } from '@/screens/AgentDetailScreen';
export default function AgentDetailRoute(){const {server,agent}=useLocalSearchParams<{server:string;agent:string}>();return <AgentDetailScreen serverId={server} agentId={agent}/>;}
