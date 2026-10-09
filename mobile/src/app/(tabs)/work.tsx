import { WorkScreen } from '@/screens/WorkScreen';
import { ServerSection } from '@/ui/ServerSelector';

export default function WorkTab() {
  return <ServerSection>{(id) => <WorkScreen serverId={id} />}</ServerSection>;
}
