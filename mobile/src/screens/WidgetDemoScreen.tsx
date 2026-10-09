import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { demoWidget, DEMO_WIDGET_SERVERS, DEMO_WIDGET_STATES, type DemoWidgetServer, type DemoWidgetState } from '@/core/demoWidget';
import { WIDGET_EXPLANATION } from '@/core/widget';
import { useNow } from '@/state/app';
import { goToTab, useReturn } from '@/state/navigation';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { Keycap, Segmented } from '@/ui/kit';
import { T } from '@/ui/primitives';
import { WidgetPreview } from '@/ui/WidgetPreview';

const SERVERS = DEMO_WIDGET_SERVERS.map(([id]) => id);
export function WidgetDemoScreen() {
  const { K } = usePalette();
  const back = useReturn();
  const now = useNow(1000);
  const [state, setState] = useState<DemoWidgetState>('current');
  const [server, setServer] = useState<DemoWidgetServer>('atlas');
  const view = demoWidget(state, now, server);
  const open = () => goToTab(view.state === 'current' ? 'approvals' : 'agents');
  return <View style={{ flex: 1, backgroundColor: K.background }}><StatusBarSpace />
    <DetailHeader back={back?.label ?? 'Ajustes'} onBack={back?.go ?? (() => {})} title="Widget" subtitle="VISTA PREVIA · DATOS SINTÉTICOS" />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <T {...TYPE.secondary} c={K.inkSecondary}>{WIDGET_EXPLANATION}</T>
      <Segmented options={SERVERS} value={server} onChange={setServer} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{DEMO_WIDGET_STATES.map(([value, label]) => <Keycap key={value} variant={value === state ? 'dark' : 'normal'} label={label} onPress={() => setState(value)} style={{ flexGrow: 0 }} />)}</View>
      <WidgetPreview view={view} wide onOpen={open} />
      <WidgetPreview view={view} wide={false} onOpen={open} />
    </ScrollView></View>;
}
