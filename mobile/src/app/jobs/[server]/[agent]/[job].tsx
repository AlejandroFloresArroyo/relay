import { useLocalSearchParams } from 'expo-router';
import { JobDetailScreen } from '@/screens/JobsScreen';
export default function JobRoute(){const {server,agent,job}=useLocalSearchParams<{server:string;agent:string;job:string}>();return <JobDetailScreen key={JSON.stringify([server,agent,job])} serverId={server} agentId={agent} jobId={job}/>;}
