import { Pressable, View } from 'react-native';
import { DEMO_WORK_SCENARIOS, demoWorkPage, setDemoWorkScenario, type WorkDemoScenario } from '@/core/demoKanban';
import { workCache } from '@/core/kanban';
import { useApp, useNow } from '@/state/app';
import { save } from '@/state/storage';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE } from '@/theme/tokens';
import { M } from '@/ui/primitives';
export function DemoWorkStates({serverId,scenario,onSelect}: {serverId:string;scenario:WorkDemoScenario;onSelect:(value:WorkDemoScenario)=>void}) {
 const {K}=usePalette();
 const {servers}=useApp(),now=useNow();
 const choose=async(value:WorkDemoScenario)=>{
   const server=servers.find(s=>s.id===serverId);if(!server)return;
   const key=`relay.work.v1.${encodeURIComponent(serverId)}`;
   await save(key,value==='offline'?workCache(JSON.stringify([server.id,server.url,server.deviceId]),demoWorkPage(now-3600000)):'');
   setDemoWorkScenario(serverId,value);onSelect(value);
 };
 return <View style={{flexDirection:'row',flexWrap:'wrap',gap:5,padding:12}}>{DEMO_WORK_SCENARIOS.map(mode=>{
  const active=mode.id===scenario;
  return <Pressable key={mode.id} role="button" accessibilityState={{selected:active}} onPress={()=>void choose(mode.id)}
   style={{minHeight:32,paddingHorizontal:11,borderRadius:RADIUS.chip,justifyContent:'center',backgroundColor:active?K.ink:K.key,boxShadow:active?undefined:K.shadowKey}}>
   <M {...TYPE.label} c={active?K.block:K.inkSecondary}>{mode.name}</M>
  </Pressable>;
 })}</View>;
}
