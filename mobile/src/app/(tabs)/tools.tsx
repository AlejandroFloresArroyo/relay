import { View } from 'react-native';
import { useReturn } from '@/state/navigation';

// ServerToolsHost draws the selected Servidor's tools over this place; it only owns the back key.
export default function ToolsTab() {
  useReturn();
  return <View style={{ flex: 1 }} />;
}
