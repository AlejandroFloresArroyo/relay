import { useState, type ReactNode } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import type { RemoteFileEntry, RemoteFileProtection } from '../../../../protocol/remoteFiles';
import { attachable } from '@/core/chatFiles';
import { fileSize } from '@/core/files';
import { nameProblem, permissions } from '@/core/remoteFiles';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS, TYPE, ledGlow } from '@/theme/tokens';
import { IconKey, Keycap, Lamp, Plate } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** A RemoteFailure carries the fixed text of its code; anything else never shows its own message. */
export const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';
export const isCode = (error: unknown, code: string) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

export const SPECIAL: Partial<Record<RemoteFileEntry['type'], string>> = {
  fifo: 'FIFO', socket: 'SOCKET', char_device: 'DISPOSITIVO DE CARACTERES', block_device: 'DISPOSITIVO DE BLOQUES', unknown: 'TIPO DESCONOCIDO',
};

export function entryKind(entry: RemoteFileEntry): string {
  if (entry.type === 'directory') return 'CARPETA';
  if (entry.type === 'symlink') return entry.link?.type === 'directory' ? 'ENLACE A CARPETA' : entry.link?.type === null ? 'ENLACE ROTO' : 'ENLACE';
  return SPECIAL[entry.type] ?? fileSize(entry.size);
}

const when = (ms: number) => new Date(ms).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).toUpperCase();

/**
 * #114: a row lifted out of the Archivos panel beside a Conversación. `grabX` is where the finger took
 * the row, from the row's left edge; `dx` how far it moved. Only the screen beside the Conversación passes it.
 */
export interface EntryDrag {
  onLift: (name: string) => void;
  onMove: (dx: number, grabX: number) => void;
  onDrop: (path: string, dx: number, grabX: number) => void;
  /** Lifted, dropped or cancelled by the system: the drag is over. */
  onEnd: () => void;
  /** The accessibility action: attach without dragging. */
  onAttach: (path: string) => void;
}

export function EntryRow({ entry, onOpen, onActions, drag }: { entry: RemoteFileEntry; onOpen: () => void; onActions: (() => void) | null; drag?: EntryDrag & { path: string } }) {
  const { K } = usePalette();
  const [lifted, setLifted] = useState(false);
  const grabX = useSharedValue(0);
  const attach = drag && attachable(entry) ? () => drag.onAttach(drag.path) : null;
  const folder = entry.type === 'directory' || (entry.type === 'symlink' && entry.link?.type === 'directory');
  const badge = folder ? 'DIR' : entry.type === 'symlink' ? 'LNK' : SPECIAL[entry.type] ? 'ESP' : (entry.name.includes('.') ? entry.name.split('.').at(-1)! : 'FILE').slice(0, 4).toUpperCase();
  const row = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, ...(lifted ? { borderRadius: 12, backgroundColor: K.key, boxShadow: `0px 0px 0px 2px ${K.accent}, ${ledGlow(K.accent)}` } : {}) }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Abrir ${entry.name}`} onPress={onOpen} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}
        accessibilityActions={attach ? [{ name: 'attach', label: 'Adjuntar a la Conversación' }] : undefined}
        onAccessibilityAction={attach ? ({ nativeEvent }) => { if (nativeEvent.actionName === 'attach') attach(); } : undefined}>
        <Plate label={badge} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T {...TYPE.body} numberOfLines={1} c={entry.nameUtf8 ? K.ink : K.inkTertiary}>{entry.name}</T>
          {entry.type === 'symlink' ? (
            <M s={9.5} c={entry.link?.realPath ? K.inkTertiary : K.dangerText} numberOfLines={1}>→ {entry.link?.realPath ?? `${entry.link?.target ?? ''} · ROTO`}</M>
          ) : null}
          <M s={9.5} ls={0.04} c={K.inkTertiary} numberOfLines={1}>{entryKind(entry)} · {permissions(entry.mode, entry.type)} · {when(entry.mtime)}</M>
          {!entry.nameUtf8 ? <M s={9.5} c={K.dangerText}>NOMBRE NO UTF-8 · RELAY NO PUEDE OPERAR SOBRE ÉL</M> : null}
        </View>
      </Pressable>
      {onActions ? <IconKey glyph="⋯" accessibilityLabel={`Acciones de ${entry.name}`} onPress={onActions} /> : null}
    </View>
  );
  // Only a file the Puente would take can be lifted: a folder, a special file or a broken link has no gesture.
  if (!drag || !attach) return row;
  // A long press lifts the row, so a quick swipe still scrolls the list; on the web, a vertical touch scroll too.
  const pan = Gesture.Pan().withTestId(`archivo-${entry.name}`).activateAfterLongPress(250).runOnJS(true)
    .onStart((event) => { grabX.set(event.x); setLifted(true); drag.onLift(entry.name); })
    .onUpdate((event) => drag.onMove(event.translationX, grabX.get()))
    .onEnd((event, success) => { if (success) drag.onDrop(drag.path, event.translationX, grabX.get()); })
    .onFinalize(() => { setLifted(false); drag.onEnd(); });
  return <GestureDetector gesture={pan} touchAction="pan-y">{row}</GestureDetector>;
}

/** Where writes land, said before the person writes. */
export function ProtectionBanner({ protection }: { protection: RemoteFileProtection }) {
  const { K } = usePalette();
  if (!protection) return null;
  return (
    <View accessibilityRole="text" style={{ backgroundColor: protection === 'profile' ? K.field : K.dangerSurface, borderRadius: RADIUS.field, padding: 12, gap: 3 }}>
      <M s={9.5} w="600" ls={0.06} c={protection === 'profile' ? K.accentText : K.dangerText}>{protection === 'profile' ? 'PERFIL DE HERMES' : 'DATOS DEL PUENTE'}</M>
      <T {...TYPE.secondary} c={K.inkSecondary}>
        {protection === 'profile' ? 'Antes de cada cambio aquí, Relay guarda la versión anterior en el Servidor y lo registra.' : 'Relay no escribe aquí: crear, subir, mover o borrar se hace en la computadora.'}
      </T>
    </View>
  );
}

/** One row of an action sheet: `label` is what a screen reader says, `detail` the mono note on the right. */
export function SheetAction({ label, detail, danger, onPress }: { label: string; detail?: string; danger?: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <T {...TYPE.body} c={danger ? K.dangerText : K.ink}>{label}</T>
      {detail ? <M s={9.5} w="600" c={K.inkTertiary} style={{ flexShrink: 1, textAlign: 'right' }}>{detail}</M> : null}
    </Pressable>
  );
}

/** Canvas 07a·4: what is lost, said before it is lost. */
export function Confirm({ title, subject, children, confirm, busy, error, onConfirm, onCancel, danger = true }: {
  title: string; subject: string; children: ReactNode; confirm: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void; danger?: boolean;
}) {
  const { K } = usePalette();
  return (
    <View style={{ gap: 12 }}>
      <RecessedScreen style={{ padding: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Lamp tone={danger ? 'red' : 'orange'} size={8} onScreen />
          <M s={9.5} w="600" ls={0.06} c={danger ? K.dangerTextOnScreen : K.accent}>{title}</M>
        </View>
        <T {...TYPE.block} c={K.onScreenBright} numberOfLines={2}>{subject}</T>
      </RecessedScreen>
      <T {...TYPE.secondary} c={K.inkSecondary}>{children}</T>
      {error ? <T {...TYPE.secondary} c={K.dangerText} accessibilityRole="alert">{error}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Keycap label="Cancelar" accessibilityLabel="Cancelar" disabled={busy} onPress={onCancel} style={{ flex: 1 }} />
        <Keycap label={busy ? 'Un momento…' : confirm} accessibilityLabel={`Confirmar: ${confirm}`} variant={danger ? 'danger' : 'primary'} disabled={busy} onPress={onConfirm} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/** Canvas 07a·3: the current name ready to edit, or an empty field for a new one. */
export function NameForm({ caption, before, initial, submit, busy, error, onSubmit, onCancel }: {
  caption: string; before: string | null; initial: string; submit: string; busy: boolean; error: string | null; onSubmit: (name: string) => void; onCancel: () => void;
}) {
  const { K } = usePalette();
  const [name, setName] = useState(initial);
  const problem = name === initial && before !== null ? 'Escribe un nombre distinto.' : nameProblem(name);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 3 }}>
        <M {...TYPE.label} c={K.inkTertiary}>{caption}</M>
        {before !== null ? <T {...TYPE.secondary} c={K.inkSecondary}>Antes: {before}</T> : null}
      </View>
      <TextInput accessibilityLabel="Nombre" value={name} onChangeText={setName} editable={!busy} autoFocus autoCapitalize="none" autoCorrect={false}
        selectionColor={K.accent} placeholder="Nombre" placeholderTextColor={K.inkTertiary}
        style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.sans['400'], fontSize: 16, color: K.ink }} />
      {error ? <T {...TYPE.secondary} c={K.dangerText} accessibilityRole="alert">{error}</T> : name !== '' && problem ? <T {...TYPE.secondary} c={K.inkTertiary}>{problem}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Keycap label="Cancelar" accessibilityLabel="Cancelar" disabled={busy} onPress={onCancel} style={{ flex: 1 }} />
        <Keycap label={busy ? 'Un momento…' : submit} variant="primary" disabled={busy || problem !== null} onPress={() => onSubmit(name)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

export function ProgressBar({ label, done, total }: { label: string; done: number; total: number | null }) {
  const { K } = usePalette();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: total ?? Math.max(done, 1), now: done }}
      style={{ height: 8, backgroundColor: K.field, borderRadius: 4, overflow: 'hidden', boxShadow: K.shadowField }}>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: K.accent, width: total ? `${Math.min(done / total * 100, 100)}%` : '25%' }} />
    </View>
  );
}
