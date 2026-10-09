import { usePalette } from '@/theme/ThemeProvider';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { DEMO } from '@/state/app';
import { DEMO_MEMORY_SCENARIOS, demoMemoryScenario, setDemoMemoryScenario } from '@/core/demoMemory';
import { DEMO_AGENT_TOOLS_SCENARIOS, setDemoAgentToolsScenario, type DemoAgentToolsScenario } from '@/core/demo';

import { M } from '@/ui/primitives';
const labels: Record<(typeof DEMO_MEMORY_SCENARIOS)[number], string> = { ready:'Listo', empty:'Vacío', missing:'Archivos ausentes', read_only:'Solo lectura', loading:'Cargando', error:'Error', offline_empty:'Sin red · sin caché', offline_cached:'Sin red · caché', conflict:'Conflicto', over_limit:'Sobre cuota', soul_truncated:'SOUL truncado' };
export function DemoDocumentStates({reload}:{reload:()=>void}) {
  const { K } = usePalette();
 const [selected,setSelected]=useState(()=>demoMemoryScenario());
 if(!DEMO)return null;
 return <View style={{paddingHorizontal:12,paddingVertical:4,gap:4}}><M s={9.5} c={K.inkTertiary}>DEMO · ESTADOS DE MEMORIA Y PERSONALIDAD</M><ScrollView horizontal contentContainerStyle={{gap:8}}>{DEMO_MEMORY_SCENARIOS.map(value=><Pressable key={value} accessibilityRole="button" onPress={()=>{setDemoMemoryScenario(value);setSelected(value);reload();}} style={{paddingVertical:6,paddingHorizontal:8,borderRadius:8,backgroundColor:value===selected?K.accent:K.block}}><M s={9.5} c={value===selected?K.onAccent:K.ink}>{labels[value]}</M></Pressable>)}</ScrollView></View>;
}
const toolLabels: Record<DemoAgentToolsScenario, string> = { normal: 'Normal', empty: 'Vacío', partial: 'Parcial', 'skills-unavailable': 'Skills sin actualizar', unavailable: 'Sin respuesta' };
/** Demo only: the states of Herramientas y skills, kept out of the screen's own layout (D-13_D-14). */
export function DemoToolsStates({serverId,agentId,refresh}:{serverId:string;agentId:string;refresh:()=>void}) {
  const { K } = usePalette();
 const [selected,setSelected]=useState<DemoAgentToolsScenario>('normal');
 return <View style={{paddingHorizontal:12,paddingVertical:4,gap:4}}><M s={9.5} c={K.inkTertiary}>DEMO · ESTADOS DE HERRAMIENTAS Y SKILLS</M><ScrollView horizontal contentContainerStyle={{gap:8}}>{DEMO_AGENT_TOOLS_SCENARIOS.map(value=><Pressable key={value} accessibilityRole="button" onPress={()=>{setDemoAgentToolsScenario(serverId,agentId,value);setSelected(value);refresh();}} style={{paddingVertical:6,paddingHorizontal:8,borderRadius:8,backgroundColor:value===selected?K.accent:K.block}}><M s={9.5} c={value===selected?K.onAccent:K.ink}>{toolLabels[value]}</M></Pressable>)}</ScrollView></View>;
}
