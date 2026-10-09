import { BoardScreen } from '@/screens/BoardScreen';
import { ServerSection } from '@/ui/ServerSelector';

export default function BoardTab() {
  return <ServerSection>{(id) => <BoardScreen serverId={id} />}</ServerSection>;
}
