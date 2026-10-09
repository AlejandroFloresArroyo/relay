import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import type { AgentToolset } from '../../../protocol/agentTools';
import { DEMO, useApp } from '@/state/app';
import { useAgentTools } from '@/state/agentTools';
import { useControlScope } from '@/state/useControlScope';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';

import { StatusBarSpace, useBottomInset } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { Keycap, Lamp, ListBlock, Plate, SectionHeader } from '@/ui/kit';
import { SwitchTrack } from '@/ui/settingRows';
import { M, T } from '@/ui/primitives';
import { Sheet } from '@/ui/sheet';
import { SubjectStateBlock } from '@/ui/states';
import { ConnectionStatus } from '@/ui/ConnectionStatus';
import { ProtocolNotice } from '@/ui/ProtocolNotice';
import { useReturn } from '@/state/navigation';
import { RADIUS, TYPE } from '@/theme/tokens';
import { DemoToolsStates } from './DemoDocumentStates';

function ConfiguredChip({ configured }: { configured: boolean }) {
  const { K } = usePalette();
  return <View style={{ alignSelf: 'flex-start', minHeight: 22, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <Lamp size={6} tone={configured ? 'green' : 'orange'} />
    <M s={9.5} w="600" ls={0.06} c={configured ? K.okText : K.accentText}>{configured ? 'CONFIGURADA' : 'SIN CONFIGURAR'}</M>
  </View>;
}
export function AgentToolsScreen(props: { serverId: string; agentId: string; skillsOnly?: boolean }) {
  return <AgentToolsContent key={`${props.serverId}/${props.agentId}/${props.skillsOnly}`} {...props} />;
}
function AgentToolsContent({ serverId, agentId, skillsOnly = false }: { serverId: string; agentId: string; skillsOnly?: boolean }) {
  const { K } = usePalette();
  const state = useAgentTools(serverId, agentId, !skillsOnly);
  const snapshot = useApp().snapshot(serverId);
  // The Puente answers but this reading is not valid: the Herramientas themselves are the subject.
  const invalidTools = !skillsOnly && state.failed && snapshot.reachable === true && snapshot.protocol?.kind === 'compatible' && state.diagnosis?.kind === 'unreachable';
  const diagnosis: typeof state.diagnosis = invalidTools
    ? { kind: 'known', label: 'HERRAMIENTAS SIN LECTURA VÁLIDA',
      hint: 'La lectura de Herramientas no es válida o no está disponible. Si el Puente usa un contrato anterior de Herramientas, actualízalo antes de editar. El chat conserva su compatibilidad propia.',
      action: 'retry', automaticRetry: false }
    : state.diagnosis;
  const [selected, setSelected] = useState<{ tool: AgentToolset; current: () => boolean } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const modalScope = useControlScope(state.server, state.writable);
  const decisionGeneration = useRef(0);
  const [selectionScope, setSelectionScope] = useState({ server: state.server, visible: modalScope.visible, revision: modalScope.revision });
  // LockGate preserves the mounted screen; retire the decision before displaying another scope.
  if (selectionScope.server !== state.server || selectionScope.visible !== modalScope.visible || selectionScope.revision !== modalScope.revision) {
    setSelectionScope({ server: state.server, visible: modalScope.visible, revision: modalScope.revision }); setSelected(null);
  }
  const cancelSelection = () => { decisionGeneration.current++; setSelected(null); };
  const selectTool = (tool: AgentToolset) => {
    const current = modalScope.begin();
    if (!current || !state.canWrite()) return;
    const generation = ++decisionGeneration.current;
    setMessage(null); setSelected({ tool, current: () => current() && generation === decisionGeneration.current });
  };
  useEffect(() => () => { active.current = false; }, []);
  const tools = state.tools?.toolsets ?? [];
  const name = state.agent?.name ?? agentId;
  const ret = useReturn();
  const bottom = useBottomInset(16);
  async function change(tool: AgentToolset, enabled: boolean) {
    if (inFlight.current || !state.canWrite() || (enabled && !tool.configured)) return;
    const authorized = state.authorizeWrite();
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      if (enabled && !await confirmWithFingerprint(`Encender ${tool.label} para el chat de Relay`)) {
        if (active.current) setMessage('No se confirmó la huella. La herramienta sigue apagada.');
        return;
      }
      if (!active.current || !authorized()) return;
      const saved = await state.setToolset(tool.name, enabled);
      if (!active.current || !authorized()) return;
      if (saved) { setSelected(null); setMessage('Cambio guardado para el chat de Relay. Puede aplicarse en el siguiente Turno, también en una Conversación existente.'); }
      else { setSelected(null); setMessage('El cambio quedó sin confirmar. Reintenta para consultar el estado del Servidor.'); }
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  const stamp = skillsOnly ? state.skills?.observedAt : state.tools?.observedAt ?? state.skills?.observedAt;
  const serverName = state.server?.name ?? 'el Servidor';
  const enabledCount = tools.filter((tool) => tool.enabled).length;
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <DetailHeader back={ret?.label ?? name} onBack={ret?.go ?? (() => router.back())} title={skillsOnly ? 'Skills' : 'Herramientas y skills'} />
    <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: bottom, gap: 12 }}>
      <View style={{ paddingHorizontal: 12, gap: 12 }}>
        <ProtocolNotice protocol={state.protocol} stale={state.protocolStale} />
        {state.loading ? <T {...TYPE.secondary} c={K.inkSecondary}>Consultando al Servidor…</T> : null}
        {diagnosis && !state.loading ? invalidTools
          ? <SubjectStateBlock spec={{ kind: 'error', title: diagnosis.label, phrase: diagnosis.hint, onRetry: state.refresh }} />
          : <ConnectionStatus serverName={serverName} diagnosis={diagnosis} onRetry={state.refresh}
            onPair={() => router.push({ pathname: '/connect', params: { serverId } })} /> : null}
        {state.readOnly && !state.loading && diagnosis?.action !== 'pair' ? <View style={{ padding: 12, gap: 6, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
          <M {...TYPE.label} c={K.accentText}>SOLO LECTURA</M>
          <T {...TYPE.secondary} c={K.inkSecondary}>{stamp ? `Última lectura: ${new Date(stamp).toLocaleString('es-MX')}` : 'No hay una lectura anterior de este Agente.'}</T>
          {!diagnosis ? <Keycap variant="link" label="Reintentar" onPress={state.refresh} style={{ alignSelf: 'flex-start' }} /> : null}
        </View> : null}
      </View>
      {!skillsOnly ? <>
        <View style={{ paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <SectionHeader title="PARA EL CHAT DE RELAY" />
          <M {...TYPE.label} ls={0.08} c={K.inkTertiary}>{enabledCount} DE {tools.length}</M>
        </View>
        <ListBlock>
          {tools.map((tool) => {
            const blocked = !state.writable || busy || (!tool.enabled && !tool.configured);
            return <View key={tool.name}>
              <View style={{ minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Plate label={tool.name.slice(0, 4).toUpperCase()} />
                <Pressable accessibilityRole="button" accessibilityLabel={`Detalles de ${tool.label}`} onPress={() => setExpanded(expanded === tool.name ? null : tool.name)} style={{ flex: 1, gap: 4, minHeight: 44, justifyContent: 'center' }}>
                  <T {...TYPE.body} c={K.ink}>{tool.label}</T>
                  <ConfiguredChip configured={tool.configured} />
                </Pressable>
                <Pressable accessibilityRole="switch" accessibilityLabel={tool.label} accessibilityState={{ checked: tool.enabled, disabled: blocked }} disabled={blocked} onPress={() => tool.enabled ? void change(tool, false) : selectTool(tool)} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'flex-end', opacity: !state.writable || !tool.configured ? 0.4 : 1 }}><SwitchTrack on={tool.enabled} /></Pressable>
              </View>
              {expanded === tool.name ? <View style={{ paddingBottom: 12, gap: 5 }}><T {...TYPE.secondary} c={K.inkSecondary}>{tool.description}</T><M s={9.5} c={K.inkTertiary}>{tool.tools.length ? tool.tools.join(' · ') : 'Hermes no reportó herramientas concretas.'}</M></View> : null}
            </View>;
          })}
          {!state.loading && state.tools && !tools.length ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingVertical: 14 }}>Hermes no reportó conjuntos de herramientas.</T> : null}
        </ListBlock>
        <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>Para el chat de Relay. Se aplica desde el siguiente Turno, también en una Conversación que ya existe. Encender pide huella; apagar no.</T>
      </> : null}
      <View style={{ paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionHeader title="SKILLS" />
        <M {...TYPE.label} ls={0.08} c={K.inkTertiary}>SOLO LECTURA</M>
      </View>
      {state.skillsFailed && !state.skills && !state.loading
        ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'unavailable', phrase: `El Puente de ${serverName} no informa las skills.` }} /></View>
        : <ListBlock>
          {state.skills?.skills.map((skill, index) => <View key={`${skill.name}/${index}`} style={{ minHeight: 62, paddingVertical: 10, gap: 4, opacity: skill.availability === 'disabled' ? 0.55 : 1 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <M s={13} w="600" c={K.ink}>{skill.name}</M>
              {skill.category ? <M s={9.5} c={K.inkSecondary} style={{ backgroundColor: K.field, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 }}>{skill.category.toUpperCase()}</M> : null}
              <M s={9.5} w="600" ls={0.06} c={skill.availability === 'disabled' ? K.inkTertiary : K.okText} style={{ marginLeft: 'auto' }}>{skill.availability === 'disabled' ? 'DESHABILITADA' : 'INSTALADA'}</M>
            </View>
            <T {...TYPE.secondary} c={K.inkSecondary}>{skill.description || 'Sin descripción instalada.'}</T>
          </View>)}
          {!state.loading && state.skills && !state.skills.skills.length ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingVertical: 14 }}>{state.skills.limited ? 'Relay no pudo listar las skills de forma segura.' : 'No hay skills instaladas en el directorio del Agente.'}</T> : null}
        </ListBlock>}
      <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>Se cambian en el Servidor. Lista instalada del Agente; no comprueba requisitos de ejecución ni incluye skills de proyectos o plugins.</T>
      {state.skillsFailed && state.skills ? <T {...TYPE.secondary} c={K.accentText} style={{ paddingHorizontal: 16 }}>No se pudieron actualizar las skills del Agente. Reintenta.</T> : null}
      {state.skillsFailed && state.skills ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>Última lectura de skills: {new Date(state.skills.observedAt).toLocaleString('es-MX')}</T> : null}
      {state.skills?.limited ? <T {...TYPE.secondary} c={K.accentText} style={{ paddingHorizontal: 16 }}>Lectura parcial: se omitieron rutas o metadata que no se pudieron leer de forma segura.</T> : null}
      {state.error ? <T accessibilityRole="alert" {...TYPE.secondary} c={K.accentText} style={{ paddingHorizontal: 16 }}>{state.error}</T> : null}
      {message && !selected ? <T accessibilityRole="alert" {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>{message}</T> : null}
    </ScrollView>
    {DEMO ? <DemoToolsStates serverId={serverId} agentId={agentId} refresh={state.refresh} /> : null}
    <Sheet visible={!!selected && modalScope.visible} onClose={() => { if (!busy) cancelSelection(); }}
      title={selected ? `¿Encender ${selected.tool.label} para el chat de Relay?` : ''} subtitle="PIDE HUELLA"
      action={selected ? <>
        <Keycap label="Cancelar" disabled={busy} onPress={cancelSelection} style={{ flex: 1 }} />
        <Keycap variant="primary" label={busy ? 'Confirmando…' : 'Encender con huella'} disabled={busy || !state.writable} onPress={() => { if (selected.current()) void change(selected.tool, true); }} style={{ flex: 1.3 }} />
      </> : undefined}>
      {selected ? <>
        <T {...TYPE.body} c={K.ink}>{name} podrá usar {selected.tool.label} en {serverName} cuando se lo pidas desde Relay.</T>
        <T {...TYPE.secondary} c={K.inkSecondary}>Las reglas de bloqueo y el Modo de aprobación del Agente siguen vigentes.</T>
        {message ? <T accessibilityRole="alert" {...TYPE.secondary} c={K.accentText}>{message}</T> : null}
      </> : null}
    </Sheet>
  </View>;
}
