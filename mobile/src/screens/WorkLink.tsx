import { useOpenSection } from '@/state/navigation';
import { Keycap } from '@/ui/kit';

// Activity can place this same link in its selector without adding a fifth main tab.
export function WorkLink({serverId,name}: {serverId:string;name?:string}) {
 const open=useOpenSection();
 return <Keycap label={`Trabajo${name?` · ${name}`:''} ›`} accessibilityLabel={`Abrir Trabajo${name?` de ${name}`:''}`} onPress={()=>open(serverId,'work')}/>;
}
