import { ScrollView, View } from 'react-native';
import { DEMO } from '@/state/app';
import { DEMO_PRESET_SCENARIOS, demoPresetScenario, setDemoPresetScenario } from '@/core/demoPresets';
import { usePalette } from '@/theme/ThemeProvider';
import { Keycap } from '@/ui/kit';
import { M } from '@/ui/primitives';
const labels={ready:'Listo',empty:'Vacío',loading:'Cargando',offline:'Sin conexión',revoked:'Revocado',error:'Error',conflict:'Conflicto',uncertain:'Incierto',soul_changed:'SOUL cambió',mid_turn:'Turno activo',external:'Otro canal',limit:'Límite',read_only:'Protegido',key_unknown:'Llave rechazada',cleartext:'HTTP bloqueado',fingerprint_denied:'Huella rechazada'};
export function DemoPresetStates({reload}:{reload:()=>void}) {
 const {K}=usePalette();
 if(!DEMO)return null;
 return <View style={{paddingVertical:8,gap:6}}><M s={9.5} w="600" ls={0.08} c={K.inkTertiary} style={{paddingHorizontal:16}}>DEMO · PRESETS</M><ScrollView horizontal contentContainerStyle={{gap:6,paddingHorizontal:12}}>{DEMO_PRESET_SCENARIOS.map(s=><Keycap key={s} variant={s===demoPresetScenario()?'dark':'normal'} label={labels[s]} onPress={()=>{setDemoPresetScenario(s);reload();}}/>)}</ScrollView></View>;
}
