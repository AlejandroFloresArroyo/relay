import { MachineryDemoScreen } from '@/screens/MachineryDemoScreen';
import { DEMO } from '@/state/app';
export default function MachineryPreviewRoute() { return DEMO ? <MachineryDemoScreen /> : null; }
