import { JobsScreen } from '@/screens/JobsScreen';
import { ServerSection } from '@/ui/ServerSelector';

export default function JobsTab() {
  return <ServerSection>{(id) => <JobsScreen serverId={id} />}</ServerSection>;
}
