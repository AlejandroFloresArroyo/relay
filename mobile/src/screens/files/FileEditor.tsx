import { useEffect, useEffectEvent, useState } from 'react';
import { FlatList, Pressable, ScrollView, TextInput, View } from 'react-native';

import type { RemoteFileContentVersion, RemoteFileProtection } from '../../../../protocol/remoteFiles';
import type { TextFormat } from '../../../../protocol/textCodec';
import { fileSize } from '@/core/files';
import type { Admitted } from '@/core/remoteAccess';
import type { FilesApi, OpenedFile } from '@/core/remoteFiles';
import { editorPieces, editorText, openText, prepareSave, storedText, type LineEndings, type TextDocument, type TextReading } from '@/core/textDocument';
import { usePalette } from '@/theme/ThemeProvider';
import { F, TYPE } from '@/theme/tokens';
import { BackLink, Keycap, ListBlock } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { Confirm, failure, isCode, ProtectionBanner } from './parts';

export type RunFiles = <T>(work: (api: FilesApi) => Promise<T>) => Promise<Admitted<T>>;

const ENCODINGS: Record<TextFormat['encoding'], string> = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'iso-8859-1': 'ISO-8859-1', 'windows-1252': 'Windows-1252' };
export const formatLabel = (format: TextFormat) => `${ENCODINGS[format.encoding]}${format.bom ? ' con BOM' : ''}`;
const ENDINGS: Record<LineEndings, string> = { lf: 'LF', crlf: 'CRLF', cr: 'CR', none: 'SIN SALTOS', mixed: 'SALTOS MIXTOS' };
const SUSPENDED = 'Relay perdió el control antes de terminar (bloqueo o conexión). Tu borrador sigue aquí.';
const REFUSED = 'Ahora no hay control sobre este Servidor. Tu borrador sigue aquí.';

interface Loaded {
  path: string;
  realPath: string;
  protection: RemoteFileProtection;
  version: RemoteFileContentVersion;
  document: TextDocument;
  /** Every reading of the bytes the person can choose: the detected one first. */
  readings: TextReading[];
  certain: boolean;
  chosen: boolean;
  endings: LineEndings;
  /** The pieces the editor showed when this document was opened or saved: a draft equal to them is unchanged. */
  pieces: string[];
  /** A new one remounts the text fields. */
  revision: number;
}

type Prompt =
  | { kind: 'conflict'; intent: boolean }
  | { kind: 'overwrite'; intent: boolean; server: RemoteFileContentVersion }
  | { kind: 'reload' }
  | { kind: 'unrepresentable'; character: string; index: number }
  | { kind: 'utf8' }
  | { kind: 'discard' }
  | { kind: 'readings' };

/** The text editor of one file (#88, especificación §4): up to 5 MiB, nothing normalized, every loss confirmed. */
export function FileEditor({ path, name, run, onClose, onRevoked, onSaved }: {
  path: string; name: string; run: RunFiles; onClose: () => void; onRevoked: () => void; onSaved: () => void;
}) {
  const { K } = usePalette();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  // The text as the person edits it, piece by piece (editorPieces): a keystroke lays out one piece, not 5 MiB.
  const [draft, setDraft] = useState<string[]>([]);
  const dirty = loaded !== null && draft !== loaded.pieces && draft.some((piece, index) => piece !== loaded.pieces[index]);

  const adopt = (read: OpenedFile, revision: number) => {
    const opening = openText(read.bytes);
    if (opening.kind !== 'opened') {
      setLoaded(null);
      setProblem({ text: opening.kind === 'too_large' ? 'Pesa más de 5 MiB: el editor no lo abre. Puedes descargarlo al teléfono.'
        : 'No es texto en una codificación que Relay lea: no se edita aquí. Puedes descargarlo al teléfono.', retry: false });
      return;
    }
    const { text, endings } = editorText(opening.document.text);
    const pieces = editorPieces(text);
    setDraft(pieces);
    setProblem(null);
    setLoaded({
      path: read.path, realPath: read.realPath, protection: read.protection, version: read.version, document: opening.document,
      readings: [{ format: opening.document.format, preview: opening.document.text.slice(0, 400) }, ...opening.alternatives],
      certain: opening.certain, chosen: false, endings, pieces, revision,
    });
  };

  const fetchFile = (revision: number) => run((api) => api.read(path)).then((result) => {
    setBusy(false);
    if (result.state === 'revoked') { onRevoked(); return; }
    if (result.state !== 'done') { setProblem({ text: result.state === 'refused' ? 'Ahora no hay control sobre este Servidor.' : SUSPENDED, retry: true }); return; }
    adopt(result.value, revision);
  }, (error: unknown) => {
    setBusy(false);
    setProblem({
      text: isCode(error, 'remote_too_large') ? 'Pesa más de 5 MiB: el editor no lo abre. Puedes descargarlo al teléfono.'
        : isCode(error, 'remote_invalid_request') ? 'No es un archivo regular: Relay no lo abre ni lo trata como texto.' : failure(error),
      retry: !isCode(error, 'remote_too_large') && !isCode(error, 'remote_invalid_request'),
    });
  });
  const load = (revision: number) => { setBusy(true); setMessage(null); void fetchFile(revision); };
  const first = useEffectEvent(() => { void fetchFile(0); });
  useEffect(() => { first(); }, []);

  const current = () => draft.join('');

  const save = async (intent: boolean, against: RemoteFileContentVersion) => {
    if (!loaded) return;
    const text = storedText(current(), loaded.endings);
    const prepared = prepareSave(loaded.document, text, intent ? { convertToUtf8: true } : undefined);
    if (prepared.kind === 'unrepresentable') {
      if (intent) { setMessage('Este texto tiene un carácter que ninguna codificación puede guardar (un sustituto suelto). Quítalo para guardar.'); return; }
      setPrompt({ kind: 'unrepresentable', character: prepared.character, index: prepared.index });
      return;
    }
    if (prepared.kind === 'too_large') { setMessage('Así codificado, el texto supera 5 MiB. Relay no lo guarda.'); return; }
    setBusy(true);
    setMessage(null);
    setPrompt(null);
    try {
      const result = await run((api) => api.save(loaded.path, against, prepared.bytes, prepared.format));
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state !== 'done') {
        setMessage(result.state === 'refused' ? REFUSED : `${SUSPENDED} No se sabe si llegó a guardarse: al guardar otra vez, Relay comprueba la versión del Servidor.`);
        return;
      }
      let version = result.value?.version ?? null;
      if (!version) {
        // Saved, but its answer was lost: the version is read again, and only bytes equal to these are this save.
        const again = await run((api) => api.read(loaded.path));
        if (again.state !== 'done' || again.value.bytes.length !== prepared.bytes.length || !again.value.bytes.every((byte, index) => byte === prepared.bytes[index])) {
          setPrompt({ kind: 'conflict', intent });
          return;
        }
        version = again.value.version;
      }
      setLoaded({ ...loaded, version, document: { bytes: prepared.bytes, format: prepared.format, text }, pieces: draft, certain: true, chosen: loaded.chosen || intent });
      setMessage(intent ? 'Guardado en UTF-8.' : 'Guardado.');
      onSaved();
    } catch (error) {
      if (isCode(error, 'remote_conflict')) setPrompt({ kind: 'conflict', intent });
      else setMessage(failure(error));
    } finally {
      setBusy(false);
    }
  };

  /** Overwriting after a conflict: the version on the Servidor now, shown before the person confirms. */
  const review = async (intent: boolean) => {
    setBusy(true);
    try {
      const result = await run((api) => api.read(path));
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state !== 'done') { setMessage(result.state === 'refused' ? REFUSED : SUSPENDED); return; }
      setPrompt({ kind: 'overwrite', intent, server: result.value.version });
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setBusy(false);
    }
  };

  const choose = (reading: TextReading) => {
    if (!loaded) return;
    const opening = openText(loaded.document.bytes, reading.format);
    if (opening.kind !== 'opened') return;
    const { text, endings } = editorText(opening.document.text);
    const pieces = editorPieces(text);
    setDraft(pieces);
    setPrompt(null);
    setLoaded({ ...loaded, document: opening.document, endings, pieces, chosen: true, revision: loaded.revision + 1 });
  };

  const close = () => { if (dirty) setPrompt({ kind: 'discard' }); else onClose(); };
  const editable = loaded !== null && loaded.endings !== 'mixed' && !busy && prompt === null;

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackLink to="Archivos" onPress={close} />
        <T {...TYPE.block} c={K.ink} numberOfLines={1} style={{ flex: 1 }}>{name}</T>
        {dirty ? <M {...TYPE.label} c={K.accentText}>BORRADOR</M> : null}
      </View>
      {loaded ? (
        <View style={{ gap: 6 }}>
          <M s={9.5} ls={0.04} c={K.inkTertiary} numberOfLines={2}>
            {loaded.realPath}{loaded.realPath !== loaded.path ? ` (POR ${loaded.path})` : ''} · {fileSize(loaded.document.bytes.length)}
          </M>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <M {...TYPE.label} c={K.ink}>{formatLabel(loaded.document.format).toUpperCase()} · {ENDINGS[loaded.endings]}</M>
            {!loaded.certain && !loaded.chosen ? <M {...TYPE.label} c={K.accentText}>· CODIFICACIÓN ESTIMADA</M> : null}
            {loaded.readings.length > 1 ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Elegir codificación" disabled={dirty || busy} onPress={() => setPrompt({ kind: 'readings' })}
                style={{ minHeight: 48, justifyContent: 'center', opacity: dirty ? 0.45 : 1 }}>
                <M {...TYPE.label} c={K.accentText}>ELEGIR OTRA</M>
              </Pressable>
            ) : null}
          </View>
          {loaded.readings.length > 1 && dirty ? <T {...TYPE.secondary} c={K.inkTertiary}>Para leerlo con otra codificación, guarda o descarta antes tus cambios.</T> : null}
          <ProtectionBanner protection={loaded.protection} />
          {loaded.endings === 'mixed' ? (
            <T {...TYPE.secondary} c={K.dangerText}>Este archivo mezcla tipos de salto de línea. Relay no lo edita para no cambiarlos: edítalo en la computadora o descárgalo.</T>
          ) : null}
        </View>
      ) : null}
      {problem ? (
        <ListBlock style={{ marginHorizontal: 0, paddingVertical: 14 }}>
          <View style={{ gap: 10 }}>
            <T {...TYPE.secondary} c={K.inkSecondary} accessibilityRole="alert">{problem.text}</T>
            {problem.retry ? <Keycap label="Reintentar" accessibilityLabel="Reintentar" disabled={busy} onPress={() => load(0)} /> : null}
          </View>
        </ListBlock>
      ) : null}
      {!loaded && !problem ? <M {...TYPE.label} c={K.inkTertiary}>ABRIENDO…</M> : null}
      {message ? <T {...TYPE.secondary} c={K.inkSecondary} accessibilityLiveRegion="polite">{message}</T> : null}

      {prompt && loaded ? (
        <ListBlock style={{ marginHorizontal: 0, paddingVertical: 14 }}>
         <View>
          {prompt.kind === 'readings' ? (
            <View style={{ gap: 10 }}>
              <M {...TYPE.label} c={K.inkTertiary}>{loaded.certain ? 'CODIFICACIÓN' : 'NO ES SEGURO CÓMO ESTÁ CODIFICADO'}</M>
              <T {...TYPE.secondary} c={K.inkSecondary}>Estas codificaciones leen los mismos bytes de forma distinta. Elige la que muestra bien el texto; Relay guarda en la que elijas.</T>
              <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 8 }}>
                {loaded.readings.map((reading, index) => (
                  <Pressable key={formatLabel(reading.format)} accessibilityRole="button" accessibilityLabel={`Leer como ${formatLabel(reading.format)}`}
                    accessibilityState={{ selected: reading.format.encoding === loaded.document.format.encoding && reading.format.bom === loaded.document.format.bom }}
                    onPress={() => choose(reading)}>
                    <RecessedScreen rim={reading.format.encoding === loaded.document.format.encoding} style={{ padding: 10, gap: 4 }}>
                      <M s={9.5} ls={0.05} c={K.accent}>{formatLabel(reading.format).toUpperCase()}{index === 0 ? ' · LA MÁS PROBABLE' : ''}</M>
                      <M s={10} c={K.onScreenBright} numberOfLines={3}>{reading.preview}</M>
                    </RecessedScreen>
                  </Pressable>
                ))}
              </ScrollView>
              <Keycap label="Cancelar" accessibilityLabel="Cancelar" onPress={() => setPrompt(null)} />
            </View>
          ) : prompt.kind === 'conflict' ? (
            <View style={{ gap: 10 }}>
              <M {...TYPE.label} c={K.dangerText}>CAMBIÓ EN EL SERVIDOR</M>
              <T {...TYPE.secondary} c={K.inkSecondary}>Alguien cambió {name} mientras lo editabas. Relay no guardó. Tu borrador sigue aquí: elige qué hacer.</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Keycap label="Recargar" accessibilityLabel="Recargar del Servidor" disabled={busy} onPress={() => setPrompt({ kind: 'reload' })} style={{ flex: 1 }} />
                <Keycap label="Sobrescribir" accessibilityLabel="Sobrescribir" variant="danger" disabled={busy} onPress={() => void review(prompt.intent)} style={{ flex: 1 }} />
              </View>
              <Keycap label="Seguir editando" accessibilityLabel="Seguir editando" disabled={busy} onPress={() => setPrompt(null)} />
            </View>
          ) : prompt.kind === 'overwrite' ? (
            <Confirm title="¿SOBRESCRIBIR LA VERSIÓN DEL SERVIDOR?" subject={name} confirm="Sobrescribir" busy={busy} error={null}
              onCancel={() => setPrompt({ kind: 'conflict', intent: prompt.intent })} onConfirm={() => void save(prompt.intent, prompt.server)}>
              La versión que hay ahora en el Servidor ({fileSize(prompt.server.size)}) se reemplaza por tu borrador y se pierde
              {loaded.protection === 'profile' ? ', salvo la copia que Relay guarda del perfil de Hermes.' : '. No hay papelera.'}
            </Confirm>
          ) : prompt.kind === 'reload' ? (
            <Confirm title="¿DESCARTAR TU BORRADOR?" subject={name} confirm="Recargar" busy={busy} error={null}
              onCancel={() => setPrompt({ kind: 'conflict', intent: false })} onConfirm={() => { setPrompt(null); load(loaded.revision + 1); }}>
              Se abre la versión que hay ahora en el Servidor y se pierden tus cambios sin guardar.
            </Confirm>
          ) : prompt.kind === 'unrepresentable' ? (
            <View style={{ gap: 10 }}>
              <M {...TYPE.label} c={K.dangerText}>NO SE PUEDE GUARDAR SIN PÉRDIDA</M>
              <T {...TYPE.secondary} c={K.inkSecondary}>
                «{prompt.character}» (posición {prompt.index + 1}) no existe en {formatLabel(loaded.document.format)}. Relay no lo sustituye por otro carácter.
                Quítalo o guarda el archivo en UTF-8.
              </T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Keycap label="Seguir editando" accessibilityLabel="Seguir editando" onPress={() => setPrompt(null)} style={{ flex: 1 }} />
                <Keycap label="Cambiar a UTF-8" accessibilityLabel="Cambiar a UTF-8" onPress={() => setPrompt({ kind: 'utf8' })} style={{ flex: 1 }} />
              </View>
            </View>
          ) : prompt.kind === 'utf8' ? (
            <Confirm title="¿GUARDAR EN UTF-8?" subject={name} confirm="Guardar en UTF-8" danger={false} busy={busy} error={null}
              onCancel={() => setPrompt(null)} onConfirm={() => void save(true, loaded.version)}>
              El archivo deja de estar en {formatLabel(loaded.document.format)} y pasa a UTF-8 sin BOM. Los saltos de línea no cambian. Un programa que lo lea
              como {formatLabel(loaded.document.format)} verá mal los caracteres que no son ASCII.
            </Confirm>
          ) : (
            <Confirm title="¿DESCARTAR TU BORRADOR?" subject={name} confirm="Descartar" busy={false} error={null} onCancel={() => setPrompt(null)} onConfirm={onClose}>
              Tus cambios sin guardar se pierden. El archivo del Servidor no cambia.
            </Confirm>
          )}
         </View>
        </ListBlock>
      ) : null}

      {loaded ? (
        <RecessedScreen rim={editable} radius={16} style={{ flex: 1, padding: 2 }}>
          <FlatList key={loaded.revision} data={draft} keyExtractor={(_, index) => String(index)} keyboardShouldPersistTaps="handled" initialNumToRender={4} windowSize={5}
            contentContainerStyle={{ padding: 12 }} renderItem={({ item, index }) => (
              <TextInput accessibilityLabel={draft.length === 1 ? `Texto de ${name}` : `Texto de ${name} · tramo ${index + 1} de ${draft.length}`}
                value={item} multiline editable={editable} scrollEnabled={false}
                onChangeText={(text) => setDraft((pieces) => pieces.map((piece, at) => at === index ? text : piece))}
                autoCapitalize="none" autoCorrect={false} spellCheck={false} textAlignVertical="top" selectionColor={K.accent}
                style={{ padding: 0, minHeight: draft.length === 1 ? 300 : undefined, fontFamily: F.mono['400'], fontSize: 12.5, lineHeight: 19, color: K.onScreenBright }} />
            )} />
        </RecessedScreen>
      ) : <View style={{ flex: 1 }} />}
      {loaded ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Keycap label="Cerrar" accessibilityLabel="Cerrar el editor" disabled={busy} onPress={close} style={{ flex: 1 }} />
          <Keycap label={busy ? 'Guardando…' : 'Guardar'} variant="primary" disabled={!dirty || !editable} onPress={() => void save(false, loaded.version)} style={{ flex: 1 }} />
        </View>
      ) : null}
    </View>
  );
}
