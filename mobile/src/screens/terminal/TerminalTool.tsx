import * as Clipboard from 'expo-clipboard';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import type { TerminalShells } from '../../../../protocol/remoteTerminal';
import { conversationRequestId } from '@/core/conversations';
import type { BarKey, Mods } from '@/core/terminalInput';
import { createTerminalSession, type TerminalLink, type TerminalPort, type TerminalSession } from '@/core/terminalSession';
import { folderLabel, shellName, type Terminal, type TerminalsApi } from '@/core/terminals';
import { useChatVisible } from '@/state/chatVisibility';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { createChannels, type Channels } from '@/state/remoteChannels';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { Keycap, Lamp, type LampTone } from '@/ui/kit';
import { EngravedRule, RecessedScreen, Sweep } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { LedKey } from '../tools/LedKey';
import TerminalSurface from './TerminalSurface';
import { withTap, type KeyTap } from './useKeyTaps';

export interface TerminalToolProps {
  serverName: string;
  terminals: { api: TerminalsApi; port: (environmentId: string) => TerminalPort };
  admit: ServerRemoteAccess['admit'];
  /** «Abrir terminal aquí» from Archivos: each new serial shows a new terminal's form in `cwd`. */
  newAt?: { cwd: string; serial: number } | null;
  /** False while another panel, tool or route has the keyboard: the terminal shows but takes no keys or paste. */
  keyboard?: boolean;
}

const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';
const live = (terminal: Terminal) => terminal.state === 'starting' || terminal.state === 'running' || terminal.state === 'terminating';

/** The Terminal tool of one Servidor: the device's terminals as tabs, a new one, and each terminal at full size. */
export function TerminalTool({ serverName, terminals, admit, newAt = null, keyboard = true }: TerminalToolProps) {
  const { K } = usePalette();
  const [list, setList] = useState<Terminal[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Tabs shown once stay mounted, so switching keeps their screen and their connection.
  const [opened, setOpened] = useState<string[]>([]);
  const [shells, setShells] = useState<TerminalShells | null>(null);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const [channels] = useState(createChannels<TerminalSession>);
  const home = shells?.home ?? null;

  const apply = (next: Terminal[]) => {
    setList(next);
    setListError(null);
    setActive((current) => current === 'new' || (current && next.some((t) => t.id === current)) ? current : (next.findLast(live) ?? next.at(-1))?.id ?? 'new');
  };
  const refresh = () => terminals.api.list().then(apply, (error: unknown) => setListError(failure(error)));
  const load = useEffectEvent(() => {
    void refresh();
    // The shells and the home folder: for a new terminal, and to show folders as «~/…».
    terminals.api.shells().then(setShells, (error: unknown) => setShellsError(failure(error)));
  });
  useEffect(() => { load(); }, []);
  const select = (id: string) => {
    setOpened((ids) => active && active !== 'new' && !ids.includes(active) ? [...ids, active] : ids);
    setActive(id);
  };
  const mounted = (list ?? []).filter((t) => t.id === active || opened.includes(t.id));

  // Each «Abrir terminal aquí» shows the form for a new terminal in that folder, once.
  const asked = newAt?.serial ?? 0;
  const [answered, setAnswered] = useState(asked);
  if (asked !== answered) { setAnswered(asked); select('new'); }

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 2, paddingVertical: 2 }}>
        {(list ?? []).map((terminal) => (
          <TerminalTab key={terminal.id} terminal={terminal} home={home} selected={terminal.id === active} onPress={() => select(terminal.id)} />
        ))}
        <Tab accessibilityLabel="Nueva terminal" selected={active === 'new'} onPress={() => select('new')}><M s={13} c={active === 'new' ? K.block : K.inkSecondary}>+</M></Tab>
      </ScrollView>
      {listError ? <T {...TYPE.secondary} c={K.dangerText}>{listError}</T> : null}
      {list === null && !listError ? <M {...TYPE.label} c={K.inkTertiary}>CARGANDO TERMINALES…</M> : null}
      <View style={{ flex: 1 }}>
        {active === 'new' && shells ? (
          <NewTerminal key={asked} api={terminals.api} shells={shells} cwd={newAt?.cwd ?? shells.home} onCancel={list?.length ? () => select(list.at(-1)!.id) : null}
            onCreated={(terminal) => { setList((items) => [...(items ?? []).filter((t) => t.id !== terminal.id), terminal]); select(terminal.id); }} />
        ) : active === 'new' ? (
          shellsError ? <T {...TYPE.secondary} c={K.dangerText}>{shellsError}</T> : <M {...TYPE.label} c={K.inkTertiary}>CARGANDO SHELLS…</M>
        ) : null}
        {mounted.map((terminal) => (
          <View key={terminal.id} style={{ flex: 1, display: terminal.id === active ? 'flex' : 'none' }}>
            <TerminalPane terminal={terminal} home={home} serverName={serverName} api={terminals.api} port={terminals.port} channels={channels}
              admit={admit} visible={terminal.id === active} keyboard={keyboard} onChanged={() => void refresh()}
              onDiscarded={() => { setOpened((ids) => ids.filter((id) => id !== terminal.id)); void refresh(); }} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** A terminal tab: 32 high, Mono 9.5, the chosen one inverted (F-5). Reaches 44 with its slop. */
function Tab({ accessibilityLabel, selected, onPress, children }: { accessibilityLabel: string; selected: boolean; onPress: () => void; children: ReactNode }) {
  const { K } = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected }} hitSlop={{ top: 6, bottom: 6 }} onPress={onPress}
      style={{ minHeight: 32, paddingHorizontal: 11, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: selected ? K.ink : K.key, boxShadow: selected ? '0px 2px 3px rgba(0,0,0,0.2)' : K.shadowKey }}>
      {children}
    </Pressable>
  );
}

function TerminalTab({ terminal, home, selected, onPress }: { terminal: Terminal; home: string | null; selected: boolean; onPress: () => void }) {
  const { K } = usePalette();
  const tone: LampTone = terminal.state === 'lost' ? 'red' : terminal.state === 'exited' ? 'off' : terminal.state === 'running' ? 'green' : 'orange';
  const label = `${shellName(terminal.shell)} · ${folderLabel(terminal.cwd, home)}`;
  return (
    <Tab accessibilityLabel={`Terminal ${label}`} selected={selected} onPress={onPress}>
      <Lamp tone={tone} size={6} />
      <M s={9.5} ls={0} c={selected ? K.block : K.inkSecondary}>{label}</M>
    </Tab>
  );
}

function NewTerminal({ api, shells, cwd: initialCwd, onCreated, onCancel }: {
  api: TerminalsApi; shells: TerminalShells; cwd: string; onCreated: (terminal: Terminal) => void; onCancel: (() => void) | null;
}) {
  const { K } = usePalette();
  const [shell, setShell] = useState(shells.defaultShell && shells.shells.includes(shells.defaultShell) ? shells.defaultShell : shells.shells[0] ?? null);
  const [cwd, setCwd] = useState(initialCwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One ID per terminal asked for: a retry after a lost answer gets the same terminal, never a second one.
  const [requestId, setRequestId] = useState(conversationRequestId);

  const open = async () => {
    if (!shell || !cwd.startsWith('/') || busy) return;
    setBusy(true);
    setError(null);
    try {
      const terminal = await api.create(requestId, shell, cwd.trim());
      setRequestId(conversationRequestId());
      onCreated(terminal);
    } catch (failed) {
      setError(failure(failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ padding: 16, gap: 14, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
      <View style={{ gap: 4 }}>
        <T {...TYPE.block} c={K.ink} accessibilityRole="header">Nueva terminal</T>
        <T {...TYPE.secondary} lh={1.4} c={K.inkSecondary}>Elige el shell y la carpeta donde empieza. Sigue abierta en el Servidor aunque cambies de herramienta o vuelvas a la Conversación.</T>
      </View>
      <View style={{ gap: 6 }}>
        <M {...TYPE.label} c={K.inkTertiary}>SHELL</M>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {shells.shells.map((each) => (
            <Pressable key={each} role="button" accessibilityLabel={`Shell ${each}`} accessibilityState={{ selected: each === shell }} hitSlop={{ top: 8, bottom: 8 }} onPress={() => setShell(each)}
              style={{ minHeight: 32, paddingHorizontal: 12, borderRadius: 10, justifyContent: 'center', backgroundColor: each === shell ? K.ink : K.key, boxShadow: each === shell ? undefined : K.shadowKey }}>
              <M s={9.5} ls={0} c={each === shell ? K.block : K.inkSecondary}>{each}</M>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <M {...TYPE.label} c={K.inkTertiary}>CARPETA</M>
        <TextInput accessibilityLabel="Carpeta de la terminal" value={cwd} onChangeText={setCwd} editable={!busy} autoCapitalize="none" autoCorrect={false}
          placeholder="/home/…" placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
          style={{ minHeight: 48, paddingHorizontal: 12, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.mono['400'], fontSize: 12, color: K.ink }} />
      </View>
      {error ? <T {...TYPE.secondary} c={K.dangerText}>{error}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {onCancel ? <Keycap label="Cancelar" onPress={onCancel} style={{ flex: 1 }} /> : null}
        <Keycap variant="primary" label={busy ? 'Abriendo…' : 'Abrir terminal'} disabled={!shell || !cwd.startsWith('/') || busy} onPress={() => void open()} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const LINK: Record<TerminalLink['state'], { label: string; tone: LampTone }> = {
  connecting: { label: 'CONECTANDO…', tone: 'orange' },
  connected: { label: 'CONECTADA', tone: 'green' },
  reconnecting: { label: 'RECONECTANDO…', tone: 'orange' },
  replaced: { label: 'ABIERTA EN OTRA PANTALLA', tone: 'off' },
  exited: { label: 'TERMINADA', tone: 'off' },
  ended: { label: 'NO RECUPERABLE', tone: 'red' },
  failed: { label: 'SIN CONEXIÓN', tone: 'red' },
  closed: { label: 'DESCONECTADA', tone: 'off' },
};

function TerminalPane({ terminal, home, serverName, api, port, channels, admit, visible, keyboard, onChanged, onDiscarded }: {
  terminal: Terminal; home: string | null; serverName: string; api: TerminalsApi; port: (id: string) => TerminalPort; channels: Channels<TerminalSession>;
  admit: ServerRemoteAccess['admit']; visible: boolean; keyboard: boolean; onChanged: () => void; onDiscarded: () => void;
}) {
  const { K } = usePalette();
  const [confirming, setConfirming] = useState(false);
  const [mods, setMods] = useState(RELEASED);
  const [taps, setTaps] = useState<KeyTap[]>([]);
  const [writing, noteOutput] = useOutputActivity();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const opens = live(terminal);
  const shown = useChatVisible();

  // One channel per open terminal, admitted by the verified entry (#82). Its close is the only thing
  // that suspends the channel while the tool stays mounted: hiding Relay closes it this way, and so do
  // a lock, a lost connection or a revocation before the screen changes. Closing only disconnects; the
  // terminal goes on. Shown again, it is admitted again and the screen recovers from what the Servidor
  // holds. A terminal the list reports ended keeps its channel until its stream ends by itself.
  const open = useEffectEvent(() => {
    const id = terminal.id;
    const previous = channels.get(id);
    if (!opens || previous?.session) return;
    let session: TerminalSession | null = null;
    const release = admit(() => {
      session?.close();
      if (channels.get(id)?.session === session) channels.set(id, null, null);
    });
    if (!release) { channels.set(id, null, null); return; }
    session = createTerminalSession(port(id));
    channels.set(id, session, release);
  });
  const leave = useEffectEvent(() => {
    const current = channels.get(terminal.id);
    current?.session?.close();
    current?.release?.();
    channels.set(terminal.id, null, null);
  });
  useEffect(() => { open(); return () => leave(); }, [terminal.id]);
  useEffect(() => { if (shown) open(); }, [shown]);

  const channel = useSyncExternalStore(channels.subscribe, () => channels.get(terminal.id));
  // The sticky keys live in the page; a new page (new channel) starts with all of them released.
  const [modsOf, setModsOf] = useState(channel?.serial);
  if (modsOf !== channel?.serial) { setModsOf(channel?.serial); setMods(RELEASED); }
  const session = channel?.session ?? null;
  const refused = channel !== null && channel.session === null;
  const link = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.link ?? connectingLink);
  const ended = link.state === 'exited' || link.state === 'ended';
  const changed = useEffectEvent(() => onChanged());
  useEffect(() => { if (ended) changed(); }, [ended]);

  const terminate = async () => {
    setBusy(true);
    setResult(null);
    try {
      const final = await api.terminate(terminal.id);
      setResult(final.state === 'exited' || final.state === 'lost' ? 'Terminada. Se detuvieron el shell y todo lo que arrancó dentro.'
        : final.terminationError === 'processes_remaining' ? 'Quedan procesos de esta terminal en el Servidor. Relay sigue intentando terminarlos.'
          : final.terminationError === 'supervisor_unreachable' ? 'El supervisor del Servidor no responde. Relay lo reintenta en cuanto vuelva.'
            : 'Terminando…');
      setConfirming(false);
      onChanged();
    } catch (error) {
      setResult(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try { await api.discard(terminal.id); onDiscarded(); } catch (error) { setResult(failure(error)); setBusy(false); }
  };

  const state = !opens
    ? terminal.state === 'lost' ? { label: 'NO RECUPERABLE', tone: 'red' as const } : { label: terminal.exitCode === null ? 'TERMINADA' : `TERMINADA · CÓDIGO ${terminal.exitCode}`, tone: 'off' as const }
    : refused ? { label: 'SIN CONTROL', tone: 'off' as const } : LINK[link.state];
  const detail = !opens
    ? terminal.state === 'lost' ? 'El Servidor perdió esta terminal, por ejemplo al reiniciarse. No se puede reconectar.' : 'El programa terminó. Su salida ya no se puede recuperar.'
    : link.state === 'reconnecting' ? `${link.message}${link.message.endsWith('.') ? '' : '.'} La terminal sigue en el Servidor; Relay se reconecta sin tocarla.`
      : link.state === 'ended' || link.state === 'failed' ? link.message
        : link.state === 'replaced' ? 'Otra pantalla de este dispositivo abrió esta terminal.' : null;

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 }}>
        <Lamp tone={state.tone} size={7} />
        <M {...TYPE.label} c={K.ink} style={{ flex: 1 }} accessibilityLiveRegion="polite">{state.label}</M>
        {opens && (link.state === 'replaced' || link.state === 'failed') ? (
          <Keycap variant="link" label="Conectar aquí" accessibilityLabel="Conectar aquí" onPress={() => session?.reconnect()} />
        ) : null}
        {opens && terminal.state !== 'terminating' ? (
          <Keycap variant="danger" label="Terminar" accessibilityLabel="Terminar terminal" disabled={busy} onPress={() => { setResult(null); setConfirming(true); }} style={{ flexGrow: 0 }} />
        ) : !opens ? (
          <Keycap variant="link" label="Quitar" accessibilityLabel="Quitar de la lista" disabled={busy} onPress={() => void discard()} />
        ) : null}
      </View>
      {detail ? <T {...TYPE.secondary} c={K.inkSecondary}>{detail}</T> : null}
      {result ? <T {...TYPE.secondary} c={K.inkSecondary} accessibilityLiveRegion="polite">{result}</T> : null}
      {confirming ? (
        <View style={{ padding: 14, gap: 10, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
          <M {...TYPE.label} c={K.accentText}>¿TERMINAR ESTA TERMINAL?</M>
          <T {...TYPE.secondary} lh={1.45} c={K.ink}>
            {shellName(terminal.shell)} en {folderLabel(terminal.cwd, home)}, en {serverName}.{' '}
            {terminal.ownership === 'own'
              ? 'La abrió este dispositivo: se detienen el shell y todo lo que arrancó dentro, como tmux o herdr.'
              : 'Es trabajo compartido: Relay se desconecta y ese trabajo sigue en el Servidor.'}
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Keycap label="Cancelar" accessibilityLabel="Cancelar" disabled={busy} onPress={() => setConfirming(false)} style={{ flex: 1 }} />
            <Keycap variant="danger" label={busy ? 'Terminando…' : 'Terminar'} accessibilityLabel="Confirmar terminar" disabled={busy} onPress={() => void terminate()} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
      {session ? (
        <>
          {/* The output screen (F-5): its header sweeps while the program writes, and the engraved rule closes it. */}
          <RecessedScreen radius={18} style={{ flex: 1, overflow: 'hidden' }}>
            <View style={{ minHeight: 28, paddingHorizontal: 12, paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <M {...TYPE.label} w="400" c={K.onScreenLabel}>SALIDA</M>
              <View style={{ flex: 1 }}>{writing ? <Sweep tone="orange" /> : null}</View>
              {writing ? <M s={9.5} c={K.accent}>EN CURSO</M> : null}
            </View>
            <View style={{ flex: 1 }}>
              {/* A new channel starts a new screen: it is redrawn from what the Servidor still holds. */}
              <TerminalSurface key={channel!.serial}
                dom={{ style: { flex: 1, position: 'relative' } }}
                colors={{ background: K.screen, foreground: K.onScreenBright, cursor: K.accent, selection: 'rgba(242,154,26,0.35)' }}
                input={visible && keyboard && link.state === 'connected'}
                pull={async () => { const frames = await session.pull(); if (frames.length) noteOutput(); return frames; }}
                write={async (text) => session.write(text)}
                resize={async (cols, rows) => session.resize(cols, rows)}
                copy={async (text) => { await Clipboard.setStringAsync(text); }}
                paste={() => Clipboard.getStringAsync()}
                taps={taps}
                onMods={async (next) => { setMods(next); }} />
            </View>
            <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}><EngravedRule onScreen /></View>
          </RecessedScreen>
          <TerminalKeys mods={mods} onPress={(key) => setTaps((last) => withTap(last, key))} />
        </>
      ) : !opens ? (
        <RecessedScreen radius={16} style={{ padding: 16 }}>
          <M s={12} c={K.onScreenLabel}>{shellName(terminal.shell)} · {folderLabel(terminal.cwd, home)}</M>
        </RecessedScreen>
      ) : null}
    </View>
  );
}

const RELEASED: Mods = { ctrl: false, alt: false, select: false };
const KEYS: readonly [BarKey, string, string][] = [
  ['esc', 'Esc', 'Escape'], ['ctrl', 'Ctrl', 'Control'], ['alt', 'Alt', 'Alt'], ['tab', 'Tab', 'Tabulador'],
  ['left', '←', 'Flecha izquierda'], ['up', '↑', 'Flecha arriba'], ['down', '↓', 'Flecha abajo'], ['right', '→', 'Flecha derecha'],
];
const EDIT_KEYS: readonly [BarKey, string][] = [['select', 'Selec.'], ['copy', 'Copiar'], ['paste', 'Pegar']];

/** The special keys (F-5): an LED above each, and Ctrl or Alt stuck orange with PEGADA until the next key. */
function TerminalKeys({ mods, onPress }: { mods: Mods; onPress: (key: BarKey) => void }) {
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="Teclas de terminal" style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {KEYS.map(([key, label, name]) => {
          const stuck = (key === 'ctrl' || key === 'alt') && mods[key];
          return <LedKey key={key} label={label} accessibilityLabel={name} look={stuck ? 'sticky' : 'idle'} caption={stuck ? 'PEGADA' : undefined} onPress={() => onPress(key)} />;
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {EDIT_KEYS.map(([key, label]) => <LedKey key={key} label={label} accessibilityLabel={label === 'Selec.' ? 'Seleccionar' : label} look={key === 'select' && mods.select ? 'sticky' : 'idle'} onPress={() => onPress(key)} />)}
      </View>
    </View>
  );
}

/** How long after the last output frame the program counts as still writing. */
const OUTPUT_QUIET_MS = 1500;

/** True while output keeps arriving: each frame renews it and it ends after a quiet moment. Only `writing` is state, so a frame re-renders nothing while it holds. */
function useOutputActivity() {
  const [writing, setWriting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const note = () => {
    setWriting(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setWriting(false); }, OUTPUT_QUIET_MS);
  };
  return [writing, note] as const;
}

const noSubscribe = () => () => {};
const CONNECTING: TerminalLink = { state: 'connecting' };
const connectingLink = () => CONNECTING;
