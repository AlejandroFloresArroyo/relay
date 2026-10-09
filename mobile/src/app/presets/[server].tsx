import { useLocalSearchParams } from 'expo-router';
import { PersonalityPresetsScreen } from '@/screens/PersonalityPresetsScreen';
export default function PersonalityPresetsRoute() {
 const {server}=useLocalSearchParams<{server:string}>();return <PersonalityPresetsScreen serverId={server}/>;
}
