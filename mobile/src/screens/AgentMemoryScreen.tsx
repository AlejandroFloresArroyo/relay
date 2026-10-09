import { usePalette } from '@/theme/ThemeProvider';
import { DemoDocumentStates } from './DemoDocumentStates';
import { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { AgentMemory, MemoryBucket, MemoryNote } from '../../../protocol/agentMemory';
import { useAgentDocument } from '@/state/useAgentDocument';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { Keycap, ListBlock, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { Sheet } from '@/ui/sheet';
import { AgentDocumentChrome, DocumentCacheNotice, DocumentMissing, DocumentState, CONTEXT_REBUILD_NOTICE } from './AgentDocumentChrome';
interface Selection { bucket: MemoryBucket; note: MemoryNote; index: number; revision: string }
const label = { memory:'Memoria', user:'Sobre ti' };
export function AgentMemoryScreen({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { K } = usePalette();
  const doc = useAgentDocument<AgentMemory>(serverId, agentId, 'memory');
  const [editing, setEditing] = useState<Selection | null>(null);
  const [deleting, setDeleting] = useState<Selection | null>(null);
  const [draft, setDraft] = useState('');
  const agentName = doc.connection.agents.find(a => a.id === agentId)?.name ?? agentId;
  const data = doc.data;
  const editingWritable = !doc.readOnly && !!(editing && data?.buckets[editing.bucket].writable);
  const deletingWritable = !doc.readOnly && !!(deleting && data?.buckets[deleting.bucket].writable);
  const inaccessible = doc.revoked || !doc.server;
  const [selectionBoundary, setSelectionBoundary] = useState({ scope: doc.scope, inaccessible });
  if (inaccessible !== selectionBoundary.inaccessible || doc.scope !== selectionBoundary.scope) {
    setSelectionBoundary({ scope: doc.scope, inaccessible });
    if (inaccessible || doc.scope !== selectionBoundary.scope) { setEditing(null); setDeleting(null); setDraft(''); }
  }
  async function apply(selection: Selection, content: string | null) {
    if (doc.readOnly || !data?.buckets[selection.bucket].writable) return;
    const saved = await doc.write((client, current, guard) => guard() && current.buckets[selection.bucket].writable
      ? client.changeAgentMemory(agentId, { bucket: selection.bucket, revision: selection.revision, noteId: selection.note.id, content })
      : Promise.resolve(null));
    if (saved) { setEditing(null); setDeleting(null); }
  }
  const noNotes = !!data && data.buckets.memory.notes.length === 0 && data.buckets.user.notes.length === 0;
  const editingNumber = String((editing?.index ?? 0) + 1).padStart(2, '0');
  return <AgentDocumentChrome serverId={serverId} title="Memoria" subtitle={`${agentId.toUpperCase()} · MEMORIA`}>
    <ScrollView contentContainerStyle={{ paddingTop: 4, paddingBottom: 16, gap: 12 }} style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 12, gap: 12 }}>
        {data && (doc.cached || doc.offline) ? <DocumentCacheNotice at={data.capturedAt} /> : null}
        {!data ? <DocumentState kind="memory" loading={doc.loading} offline={doc.offline} serverName={doc.server?.name ?? 'el Servidor'} reload={doc.reload} /> : null}
        {noNotes ? <DocumentMissing kind="memory" agentName={agentName} serverName={doc.server?.name ?? 'el Servidor'} /> : null}
      </View>
      {data && !noNotes ? <>
        {(['memory', 'user'] as const).map(bucket => {
          const section = data.buckets[bucket];
          const disabled = doc.readOnly || !section.writable || doc.busy;
          return <View key={bucket} style={{ gap: 8 }}>
            <View style={{ paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionHeader title={bucket === 'memory' ? 'MEMORIA · LO QUE RECUERDA' : 'SOBRE TI · USER.md'} />
              <M {...TYPE.label} c={K.inkTertiary}>{section.notes.length} NOTAS</M>
            </View>
            <ListBlock>
              {!section.notes.length ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingVertical: 14 }}>{section.exists ? 'No hay notas.' : section.reason ?? 'El archivo no existe.'}</T> : section.notes.map((note, index) => {
                const number = String(index + 1).padStart(2, '0');
                const selection = { bucket, note, index, revision: section.revision };
                return <View key={note.id} style={{ minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <M s={9.5} w="600" c={K.accentText} style={{ width: 18 }}>{number}</M>
                  <Pressable accessibilityLabel={`Leer nota ${number} de ${label[bucket]}`} style={{ flex: 1 }} onPress={() => { setEditing(selection); setDraft(note.text); }}><T s={13} lh={1.4} c={K.ink}>{note.text}</T></Pressable>
                  {!doc.readOnly && section.writable ? <>
                    <Pressable disabled={disabled} hitSlop={9} accessibilityLabel={`Editar nota ${number} de ${label[bucket]}`} onPress={() => { setEditing(selection); setDraft(note.text); }} style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: K.key, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1 }}>
                      <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={K.inkSecondary} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><Path d="M4 20h4L19 9l-4-4L4 16z" /></Svg>
                    </Pressable>
                    <Pressable disabled={disabled} hitSlop={9} accessibilityLabel={`Borrar nota ${number} de ${label[bucket]}`} onPress={() => setDeleting(selection)} style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: K.key, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1 }}><T s={15} w="700" c={K.dangerText}>×</T></Pressable>
                  </> : null}
                </View>;
              })}
            </ListBlock>
            <M s={9.5} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>{section.characters} caracteres · límite {section.limit === null ? 'no conocido' : section.limit}</M>
            {section.reason && section.notes.length ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>{section.reason}</T> : null}
          </View>;
        })}
      </> : null}
      {data ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>Editar es libre; borrar pide confirmación. {CONTEXT_REBUILD_NOTICE}</T> : null}
      {data && doc.error ? <View style={{ marginHorizontal: 12, padding: 14, gap: 4, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}><T {...TYPE.secondary} c={K.dangerText}>{doc.error}</T><Keycap variant="link" label="Recargar" onPress={doc.reload} disabled={doc.busy} style={{ alignSelf: 'flex-start' }} /></View> : null}
      {data && doc.readOnly && !doc.loading ? <View style={{ paddingHorizontal: 12 }}><Keycap variant="link" label="Reintentar" onPress={doc.reload} style={{ alignSelf: 'flex-start' }} /></View> : null}
    </ScrollView>
    {doc.visible && data && editing && !deleting ? <Sheet visible onClose={() => { if (!doc.busy) setEditing(null); }} title={`Nota ${editingNumber}`}
      subtitle={editing ? `${label[editing.bucket].toUpperCase()} DE ${agentId.toUpperCase()}` : undefined}
      aside={<Keycap variant="link" label="Cancelar" disabled={doc.busy} onPress={() => setEditing(null)} />}
      action={editingWritable ? <>
        <Keycap variant="danger" label="Borrar nota" disabled={doc.busy} onPress={() => editing && setDeleting(editing)} style={{ flex: 1 }} />
        <Keycap variant="primary" label={doc.busy ? 'Guardando…' : 'Guardar'} disabled={doc.busy || !draft} onPress={() => editing && void apply(editing, draft)} style={{ flex: 1 }} />
      </> : undefined}>
      {editing ? <>
        <TextInput accessibilityLabel="Texto de la nota" multiline editable={editingWritable && !doc.busy} value={draft} onChangeText={setDraft} selectionColor={K.accent} textAlignVertical="top"
          style={{ minHeight: 145, maxHeight: 330, padding: 14, borderRadius: 16, backgroundColor: K.field, boxShadow: `${K.shadowField}, 0px 0px 0px 1.5px ${K.accent}`, fontFamily: F.sans['400'], fontSize: 16, lineHeight: 24, color: K.ink }} />
        {doc.error ? <T {...TYPE.secondary} c={K.dangerText}>{doc.error}</T> : null}
        <T {...TYPE.secondary} c={K.inkSecondary}>Borrar pide confirmación. {CONTEXT_REBUILD_NOTICE}</T>
      </> : null}
    </Sheet> : null}
    {doc.visible && data && deleting ? <Sheet visible onClose={() => { if (!doc.busy) setDeleting(null); }} title={`¿Borrar la nota ${String((deleting?.index ?? 0) + 1).padStart(2, '0')}?`}
      action={deleting ? <>
        <Keycap label="Cancelar" disabled={doc.busy} onPress={() => setDeleting(null)} style={{ flex: 1 }} />
        <Keycap variant="danger" label={doc.busy ? 'Borrando…' : 'Borrar'} disabled={doc.busy || !deletingWritable} onPress={() => deleting && void apply(deleting, null)} style={{ flex: 1 }} />
      </> : undefined}>
      {deleting ? <>
        <T {...TYPE.body} c={K.ink}>«{deleting.note.text}»</T>
        <T {...TYPE.secondary} c={K.inkSecondary}>Hermes dejará de recordarlo cuando reconstruya el contexto. Puede ocurrir en esta Conversación.</T>
        {doc.error ? <T {...TYPE.secondary} c={K.dangerText}>{doc.error}</T> : null}
      </> : null}
    </Sheet> : null}
    <DemoDocumentStates reload={doc.reload} />
  </AgentDocumentChrome>;
}
