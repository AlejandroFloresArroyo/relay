import { WidgetDemoScreen } from '@/screens/WidgetDemoScreen';
import { DEMO } from '@/state/app';
export default function WidgetPreviewRoute() { return DEMO ? <WidgetDemoScreen /> : null; }
