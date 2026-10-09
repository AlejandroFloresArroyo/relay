import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { Image, PixelRatio, Pressable, ScrollView, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import type { BrowserKey, BrowserTab } from '../../../../protocol/remoteBrowser';
import { BROWSER_KEYS, BROWSER_LIMITATION_MESSAGES } from '../../../../protocol/remoteBrowser';
import { conversationRequestId } from '@/core/conversations';
import type { BrowserEnvironment, BrowserKind } from '@/core/browsers';
import { createBrowserSession, type BrowserSession, type BrowserState } from '@/core/browserSession';
import { addressUrl, frameRect, pagePoint, scrollDelta, type Size } from '@/core/browserView';
import { describeRemoteToolState, type RemoteToolState } from '@/core/remoteCapabilities';
import type { RemoteClient } from '@/core/remoteClient';
import { useChatVisible } from '@/state/chatVisibility';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { createChannels, type Channels } from '@/state/remoteChannels';
import type { RemoteBrowsers } from '@/state/remoteTools';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS, TYPE, type Palette } from '@/theme/tokens';
import { Keycap, Lamp, type LampTone } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { Card, TransferPanel, useBrowserTransfer } from './BrowserTransfer';

export interface BrowserToolProps {
  serverName: string;
  browsers: RemoteBrowsers;
  /** The state of each mode, for one that is not available. */
  modes: Record<BrowserKind, RemoteToolState | undefined>;
  admit: ServerRemoteAccess['admit'];
  /** The files transfer (#87), for phone files to a page and its downloads to the phone. */
  files: () => RemoteClient;
  filesState: RemoteToolState | undefined;
}

const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';
const live = (browser: BrowserEnvironment) => browser.state === 'starting' || browser.state === 'running' || browser.state === 'terminating';
/** The habitual browser sends frames one after another while a tab is shared: none for this long is a stale image. */
const HABITUAL_STALE_MS = 5000;

const MODES: Record<BrowserKind, { label: string; open: string; intro: string; ended: string }> = {
  browser_dedicated: {
    label: 'Dedicado', open: 'Abrir navegador dedicado', ended: 'TERMINADO',
    intro: 'Un navegador del Servidor solo para Relay, con su propio perfil e inicios de sesión. Sigue abierto con sus pestañas aunque salgas de Relay; terminarlo lo cierra.',
  },
  browser_habitual: {
    label: 'Habitual', open: 'Conectar con el navegador habitual', ended: 'DESCONECTADO',
    intro: 'El navegador que usas en la computadora, con sus inicios de sesión. Relay controla solo las pestañas que compartas allí con el botón de Relay, y quien esté en la computadora sigue usándolas a la vez.',
  },
};

/** The Navegador tool of one Servidor: the dedicated browser or the habitual one, chosen explicitly, never opened by itself. */
export function BrowserTool({ serverName, browsers, modes, admit, files, filesState }: BrowserToolProps) {
  const { K } = usePalette();
  const [list, setList] = useState<BrowserEnvironment[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [kind, setKind] = useState<BrowserKind>(modes.browser_dedicated?.state === 'available' || modes.browser_habitual?.state !== 'available' ? 'browser_dedicated' : 'browser_habitual');
  // Browsers shown once stay mounted, so switching mode keeps their page and their connection.
  const [opened, setOpened] = useState<string[]>([]);
  const [channels] = useState(createChannels<BrowserSession>);

  const refresh = () => browsers.api.list().then((next) => { setList(next); setListError(null); }, (error: unknown) => setListError(failure(error)));
  const load = useEffectEvent(() => { void refresh(); });
  useEffect(() => { load(); }, []);

  const current = list?.findLast((browser) => browser.kind === kind && live(browser)) ?? null;
  const ended = (list ?? []).filter((browser) => browser.kind === kind && !live(browser));
  const mounted = (list ?? []).filter((browser) => live(browser) && (browser.id === current?.id || opened.includes(browser.id)));
  const choose = (next: BrowserKind) => {
    if (current && !opened.includes(current.id)) setOpened((ids) => [...ids, current.id]);
    setKind(next);
  };

  return (
    <View style={{ flex: 1, gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {(['browser_dedicated', 'browser_habitual'] as const).map((each) => {
          const connected = (list ?? []).some((browser) => browser.kind === each && live(browser));
          return (
            <SmallKey key={each} accessibilityLabel={`Navegador ${MODES[each].label.toLowerCase()}`} label={MODES[each].label.toUpperCase()}
              selected={each === kind} lamp={connected ? 'green' : 'off'} onPress={() => choose(each)} style={{ flex: 1 }} />
          );
        })}
      </View>
      {listError ? <T {...TYPE.secondary} c={K.dangerText} lh={1.4}>{listError}</T> : null}
      {list === null && !listError ? <M {...TYPE.label} c={K.inkTertiary}>CARGANDO NAVEGADORES…</M> : null}
      {list !== null && !current ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }}>
          {ended.map((browser) => <EndedBrowser key={browser.id} browser={browser} onDiscard={async () => { await browsers.api.discard(browser.id); await refresh(); }} />)}
          <BrowserIntro kind={kind} state={modes[kind]} create={browsers.api.create} onCreated={(browser) => { setList((items) => [...(items ?? []).filter((b) => b.id !== browser.id), browser]); }} />
        </ScrollView>
      ) : null}
      {mounted.map((browser) => (
        <View key={browser.id} style={{ flex: 1, display: browser.id === current?.id ? 'flex' : 'none' }}>
          <BrowserPane browser={browser} serverName={serverName} browsers={browsers} channels={channels} admit={admit} visible={browser.id === current?.id}
            files={files} filesAvailable={filesState?.state === 'available'} onChanged={() => void refresh()} />
        </View>
      ))}
    </View>
  );
}

function EndedBrowser({ browser, onDiscard }: { browser: BrowserEnvironment; onDiscard: () => Promise<void> }) {
  const { K } = usePalette();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Lamp tone={browser.state === 'lost' ? 'red' : 'off'} />
        <M {...TYPE.label} c={K.ink} style={{ flex: 1 }}>{browser.state === 'lost' ? 'NO RECUPERABLE' : MODES[browser.kind].ended}</M>
        <Keycap label="Quitar" accessibilityLabel="Quitar de la lista" onPress={() => { setError(null); onDiscard().catch((e: unknown) => setError(failure(e))); }} />
      </View>
      {browser.state === 'lost' ? <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>El Servidor perdió este navegador, por ejemplo al reiniciarse. Relay no abre otro por su cuenta.</T> : null}
      {error ? <T {...TYPE.secondary} c={K.dangerText} lh={1.4}>{error}</T> : null}
    </Card>
  );
}

function BrowserIntro({ kind, state, create, onCreated }: {
  kind: BrowserKind; state: RemoteToolState | undefined; create: RemoteBrowsers['api']['create']; onCreated: (browser: BrowserEnvironment) => void;
}) {
  const { K } = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One ID per browser asked for: a retry after a lost answer gets the same browser, never a second one.
  const [requestId, setRequestId] = useState(conversationRequestId);
  const available = state?.state === 'available';
  const unavailable = state && !available ? describeRemoteToolState(state) : null;

  const open = async () => {
    if (!available || busy) return;
    setBusy(true);
    setError(null);
    try {
      const browser = await create(requestId, kind);
      setRequestId(conversationRequestId());
      onCreated(browser);
    } catch (failed) {
      setError(failure(failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ padding: 16, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <T {...TYPE.block} c={K.ink}>Navegador {MODES[kind].label.toLowerCase()}</T>
        <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>{MODES[kind].intro}</T>
      </View>
      {unavailable ? (
        <View style={{ gap: 4 }}>
          <M {...TYPE.label} c={K.accentText}>{unavailable.label.toUpperCase()}</M>
          {unavailable.hint ? <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>{unavailable.hint}</T> : null}
        </View>
      ) : null}
      {error ? <T {...TYPE.secondary} c={K.dangerText} lh={1.4}>{error}</T> : null}
      <Keycap variant="primary" label={busy ? 'Abriendo…' : MODES[kind].open} disabled={!available || busy} onPress={() => void open()} />
    </Card>
  );
}

const LINK: Record<BrowserState['link']['state'], { label: string; tone: LampTone }> = {
  connecting: { label: 'CONECTANDO…', tone: 'orange' },
  connected: { label: 'CONECTADO', tone: 'green' },
  reconnecting: { label: 'RECONECTANDO…', tone: 'orange' },
  replaced: { label: 'ABIERTO EN OTRA PANTALLA', tone: 'off' },
  exited: { label: 'CERRADO', tone: 'off' },
  ended: { label: 'NO RECUPERABLE', tone: 'red' },
  failed: { label: 'SIN CONEXIÓN', tone: 'red' },
  closed: { label: 'DESCONECTADO', tone: 'off' },
};

function BrowserPane({ browser, serverName, browsers, channels, admit, visible, files, filesAvailable, onChanged }: {
  browser: BrowserEnvironment; serverName: string; browsers: RemoteBrowsers; channels: Channels<BrowserSession>;
  admit: ServerRemoteAccess['admit']; visible: boolean; files: () => RemoteClient; filesAvailable: boolean; onChanged: () => void;
}) {
  const { K } = usePalette();
  const own = browser.ownership === 'own';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const shown = useChatVisible();
  // The tab chosen in the last channel: a new one views it again, with its own frames.
  const lastTab = useRef<string | null>(null);
  const transfers = useBrowserTransfer({ files, available: filesAvailable, admit, folder: browser.id });
  // The phone's file reaches the Servidor first; then the page's chooser takes its path, if it still waits.
  const upload = async () => {
    const path = await transfers.upload();
    if (path) await channels.get(browser.id)?.session?.act({ type: 'files', paths: [path] });
  };

  // One channel per browser, admitted by the verified entry (#82). Its close is the only thing that
  // suspends it while the tool stays mounted: hiding Relay closes it this way, and so do a lock, a lost
  // connection or a revocation before the screen changes. Closing only disconnects; the browser and its
  // tabs go on. Shown again, it is admitted again and views the same tab from scratch: no stale frame is reused.
  const open = useEffectEvent(() => {
    const id = browser.id;
    if (channels.get(id)?.session) return;
    let session: BrowserSession | null = null;
    const release = admit(() => {
      if (session) lastTab.current = session.state().tab;
      session?.close();
      if (channels.get(id)?.session === session) channels.set(id, null, null);
    });
    if (!release) { channels.set(id, null, null); return; }
    session = createBrowserSession(browsers.port(id), { tab: lastTab.current, ...(own ? { dedicated: true } : { staleAfterMs: HABITUAL_STALE_MS }) });
    channels.set(id, session, release);
  });
  const leave = useEffectEvent(() => {
    const entry = channels.get(browser.id);
    entry?.session?.close();
    entry?.release?.();
    channels.set(browser.id, null, null);
  });
  useEffect(() => { open(); return () => leave(); }, [browser.id]);
  useEffect(() => { if (shown) open(); }, [shown]);

  const channel = useSyncExternalStore(channels.subscribe, () => channels.get(browser.id));
  const session = channel?.session ?? null;
  const state = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.state ?? closedState);
  const ended = state.link.state === 'exited' || state.link.state === 'ended';
  const changed = useEffectEvent(() => onChanged());
  useEffect(() => { if (ended) changed(); }, [ended]);

  const end = async () => {
    setBusy(true);
    setResult(null);
    try {
      const final = await browsers.api.terminate(browser.id);
      setResult(!own ? 'Desconectado. El navegador y todas sus pestañas siguen abiertos en la computadora.'
        : final.state === 'exited' || final.state === 'lost' ? 'Terminado. Se cerró el navegador dedicado.'
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

  const status = channel !== null && session === null ? { label: 'SIN CONTROL', tone: 'off' as const }
    : state.link.state === 'exited' ? { label: MODES[browser.kind].ended, tone: 'off' as const } : LINK[state.link.state];
  const detail = state.link.state === 'reconnecting' ? `${state.link.message}${state.link.message.endsWith('.') ? '' : '.'} El navegador sigue en el Servidor; Relay se reconecta sin tocarlo.`
    : state.link.state === 'ended' || state.link.state === 'failed' ? state.link.message
      : state.link.state === 'replaced' ? 'Otra pantalla de este dispositivo abrió este navegador.' : null;

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48 }}>
        <Lamp tone={status.tone} />
        <M {...TYPE.label} c={K.ink} style={{ flex: 1 }} accessibilityLiveRegion="polite">{status.label} · {own ? 'PROPIO' : 'COMPARTIDO'}</M>
        {state.link.state === 'replaced' || state.link.state === 'failed' ? (
          <Keycap label="Conectar aquí" accessibilityLabel="Conectar aquí" onPress={() => session?.reconnect()} />
        ) : null}
        {browser.state !== 'terminating' ? (
          <Keycap variant={own ? 'danger' : 'normal'} accessibilityLabel={own ? 'Terminar navegador' : 'Desconectar navegador'} label={own ? 'Terminar' : 'Desconectar'}
            disabled={busy} onPress={() => { setResult(null); setConfirming(true); }} />
        ) : null}
      </View>
      {own ? null : (
        <Card accent style={{ paddingVertical: 10, gap: 2 }}>
          <M {...TYPE.label} c={K.accentText}>CONTROL COMPARTIDO</M>
          <T {...TYPE.secondary} c={K.inkSecondary} lh={1.35}>Quien esté en la computadora usa estas pestañas a la vez. Los diálogos del propio navegador y los selectores de archivos que abre allí se resuelven en la computadora.</T>
        </Card>
      )}
      {detail ? <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>{detail}</T> : null}
      {result ? <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4} accessibilityLiveRegion="polite">{result}</T> : null}
      {confirming ? (
        <Card accent style={{ gap: 10 }}>
          <M {...TYPE.label} c={K.accentText}>{own ? '¿TERMINAR EL NAVEGADOR DEDICADO?' : '¿DESCONECTAR DEL NAVEGADOR HABITUAL?'}</M>
          <T {...TYPE.secondary} c={K.ink} lh={1.45}>
            {own
              ? `Se cierra el navegador dedicado de ${serverName} con sus pestañas. Su perfil y sus inicios de sesión quedan en el Servidor para el próximo navegador dedicado de este dispositivo.`
              : `Relay deja de controlar el navegador de la computadora en ${serverName}. El navegador y todas sus pestañas siguen abiertos, también las que abrió Relay.`}
          </T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Keycap label="Cancelar" accessibilityLabel="Cancelar" disabled={busy} onPress={() => setConfirming(false)} style={{ flex: 1 }} />
            <Keycap variant={own ? 'danger' : 'dark'} accessibilityLabel={own ? 'Confirmar terminar' : 'Confirmar desconectar'} label={busy ? 'Un momento…' : own ? 'Terminar' : 'Desconectar'}
              disabled={busy} onPress={() => void end()} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : null}
      {transfers.transfer ? <TransferPanel transfer={transfers.transfer} onCancel={transfers.cancel} onDismiss={transfers.dismiss} /> : null}
      {session ? (
        <BrowserPage session={session} state={state} own={own} visible={visible} filesReady={transfers.ready}
          uploaded={transfers.transfer?.direction === 'up' ? transfers.transfer.path : null}
          onUpload={() => void upload()} onDownload={(download) => void transfers.download(download)} />
      ) : null}
    </View>
  );
}

/** Tabs, address, the page and its keyboard: everything here goes through the session, which refuses input on a stale frame. */
function BrowserPage({ session, state, own, visible, filesReady, uploaded, onUpload, onDownload }: {
  session: BrowserSession; state: BrowserState; own: boolean; visible: boolean;
  /** Phone files can move now: the Servidor has the files tool and this is Android. */
  filesReady: boolean; uploaded: string | null; onUpload: () => void; onDownload: (download: { name: string; path: string }) => void;
}) {
  const { K } = usePalette();
  const tab = state.tabs?.find((each) => each.id === state.tab) ?? null;
  const connected = state.link.state === 'connected';
  const [address, setAddress] = useState<string | null>(null);
  const [newTab, setNewTab] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const field = fieldStyle(K);

  const go = async () => {
    const url = addressUrl(address ?? '');
    if (newTab) {
      // A blank tab only in the dedicated browser: the habitual one opens pages only.
      if (!url && (!own || (address ?? '').trim())) return;
      if (await session.open(url)) { setNewTab(false); setAddress(null); }
      return;
    }
    if (url && await session.act({ type: 'navigate', url })) setAddress(null);
  };
  const send = async (enter: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (typed && !await session.act({ type: 'text', text: typed })) return;
      setTyped('');
      if (enter) await session.act({ type: 'key', key: 'Enter' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 2 }}>
        {(state.tabs ?? []).map((each) => <TabChip key={each.id} tab={each} selected={each.id === state.tab} onPress={() => { setNewTab(false); setAddress(null); session.select(each.id); }} />)}
        <SmallKey accessibilityLabel="Pestaña nueva" label="+" selected={newTab} disabled={!connected} onPress={() => { setNewTab(true); setAddress(''); }} />
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {newTab ? null : (
          <>
            <SmallKey accessibilityLabel="Atrás" label="‹" disabled={!tab || !connected} onPress={() => void session.act({ type: 'back' })} />
            <SmallKey accessibilityLabel="Adelante" label="›" disabled={!tab || !connected} onPress={() => void session.act({ type: 'forward' })} />
            <SmallKey accessibilityLabel="Recargar" label="↻" disabled={!tab || !connected} onPress={() => void session.act({ type: 'reload' })} />
          </>
        )}
        <TextInput accessibilityLabel="Dirección" value={address ?? tab?.url ?? ''} onChangeText={setAddress} editable={connected && (newTab || tab !== null)}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={() => void go()}
          placeholder={newTab ? (own ? 'Dirección, o vacía para una pestaña en blanco' : 'Dirección de la pestaña nueva') : 'Dirección'} placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
          style={[field, { flex: 1 }]} />
        <Keycap accessibilityLabel={newTab ? 'Abrir pestaña' : 'Ir'} label={newTab ? 'Abrir' : 'Ir'} disabled={!connected} onPress={() => void go()} />
        {newTab ? <SmallKey accessibilityLabel="Cancelar pestaña nueva" label="×" onPress={() => { setNewTab(false); setAddress(null); }} />
          : own && tab ? <SmallKey accessibilityLabel="Cerrar pestaña" label="×" disabled={!connected} onPress={() => void session.closeTab(tab.id)} /> : null}
      </View>
      <PageView session={session} state={state} tab={tab} own={own} />
      {tab?.dialog ? <DialogPanel key={`${tab.id}:${tab.dialog.type}:${tab.dialog.message}`} dialog={tab.dialog} onAnswer={(accept, text) => void session.act(text === undefined ? { type: 'dialog', accept } : { type: 'dialog', accept, text })} /> : null}
      {tab?.limitation ? (
        <Card accent style={{ gap: 4 }}>
          <M {...TYPE.label} c={K.accentText}>NECESITA LA COMPUTADORA</M>
          <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>{BROWSER_LIMITATION_MESSAGES[tab.limitation]}</T>
        </Card>
      ) : null}
      {tab?.fileChooser ? (
        <ChooserPanel key={`${tab.id}:${uploaded ?? ''}`} multiple={tab.fileChooser.multiple} suggested={uploaded} filesReady={filesReady} onUpload={onUpload}
          onPaths={(paths) => void session.act({ type: 'files', paths })} />
      ) : null}
      {state.downloads.map((download) => (
        <Card key={download.path} style={{ gap: 6 }}>
          <M {...TYPE.label} c={K.inkTertiary}>DESCARGA EN EL SERVIDOR</M>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T {...TYPE.body} c={K.ink} numberOfLines={1} style={{ flex: 1 }}>{download.name}</T>
            <SmallKey accessibilityLabel={`Descartar ${download.name}`} label="×" onPress={() => session.dismissDownload(download.path)} />
          </View>
          <M {...TYPE.data} c={K.inkTertiary} numberOfLines={1}>{download.path}</M>
          {filesReady ? (
            <Keycap accessibilityLabel={`Traer ${download.name} al teléfono`} label="Traer al teléfono" onPress={() => onDownload(download)} />
          ) : <T {...TYPE.secondary} c={K.inkSecondary} lh={1.35}>{FILES_MISSING}</T>}
        </Card>
      ))}
      {state.notice ? <T {...TYPE.secondary} c={K.dangerText} lh={1.4} accessibilityLiveRegion="polite">{state.notice}</T> : null}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {/* Editable on a stale frame too: the phone's keyboard shrinks the page, which makes it stale, and an
            editable={false} field loses focus and the keyboard. The session sends nothing until it is live again. */}
        <TextInput accessibilityLabel="Escribir en la página" value={typed} onChangeText={setTyped} editable={visible} blurOnSubmit={false}
          autoCapitalize="none" autoCorrect={false} returnKeyType="send" onSubmitEditing={() => void send(true)} onKeyPress={(event) => {
            // An empty field has nothing of its own to edit, so the key is the page's. Intro goes with the text
            // (onSubmitEditing); a modifier would change the key, and the contract carries none.
            const { key, ctrlKey, altKey, metaKey, shiftKey } = event.nativeEvent as typeof event.nativeEvent & Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>>;
            if (typed || !state.live || ctrlKey || altKey || metaKey || shiftKey || key === 'Enter' || !(BROWSER_KEYS as readonly string[]).includes(key)) return;
            event.preventDefault();
            void session.act({ type: 'key', key: key as BrowserKey });
          }}
          placeholder={state.live ? 'Texto para la página; Intro lo envía' : 'Sin control de la página'} placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
          style={[field, { flex: 1 }]} />
        <Keycap accessibilityLabel="Enviar texto" label="Enviar" disabled={!state.live || !typed || busy} onPress={() => void send(false)} />
      </View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {KEYS.map(([key, glyph, label]) => (
          <SmallKey key={key} accessibilityLabel={label} label={glyph} disabled={!state.live} onPress={() => void session.act({ type: 'key', key })} style={{ flex: 1, minWidth: 0, minHeight: 44 }} />
        ))}
      </View>
    </View>
  );
}

const KEYS: readonly (readonly [BrowserKey, string, string])[] = [
  ['Enter', '⏎', 'Tecla Intro'], ['Backspace', '⌫', 'Tecla Borrar'], ['Tab', 'TAB', 'Tecla Tab'], ['Escape', 'ESC', 'Tecla Esc'],
  ['ArrowLeft', '←', 'Flecha izquierda'], ['ArrowUp', '↑', 'Flecha arriba'], ['ArrowDown', '↓', 'Flecha abajo'], ['ArrowRight', '→', 'Flecha derecha'],
];

/** A small key for glyphs and tabs: a keycap too short for `Keycap`'s 48 minimum, with an optional lamp. */
function SmallKey({ label, accessibilityLabel, onPress, selected = false, disabled = false, lamp, style }: {
  label: string; accessibilityLabel: string; onPress: () => void; selected?: boolean; disabled?: boolean; lamp?: LampTone; style?: StyleProp<ViewStyle>;
}) {
  const { K } = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled, selected }} disabled={disabled} hitSlop={4} onPress={onPress}
      style={[{ minHeight: 40, minWidth: 40, paddingHorizontal: 10, borderRadius: RADIUS.field, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
        backgroundColor: selected ? K.ink : K.key, boxShadow: K.shadowKey, opacity: disabled ? 0.45 : 1 }, style]}>
      {lamp ? <Lamp tone={lamp} size={6} onScreen={selected} /> : null}
      <M {...TYPE.data} c={selected ? K.block : K.ink} numberOfLines={1}>{label}</M>
    </Pressable>
  );
}

const fieldStyle = (K: Palette['K']) => ({
  minHeight: 44, paddingHorizontal: 12, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.mono['400'], fontSize: 12, color: K.ink,
}) as const;

function TabChip({ tab, selected, onPress }: { tab: BrowserTab; selected: boolean; onPress: () => void }) {
  const title = tab.title || tab.url || 'Pestaña en blanco';
  return <SmallKey accessibilityLabel={`Pestaña ${title}`} label={title} selected={selected} onPress={onPress} style={{ maxWidth: 220 }}
    lamp={tab.limitation ? 'red' : tab.dialog || tab.fileChooser ? 'orange' : selected ? 'green' : 'off'} />;
}

/** Why the image cannot be touched now, over the image; null while it is live. */
function staleLabel(state: BrowserState, tab: BrowserTab | null): string | null {
  if (state.live) return null;
  if (state.link.state !== 'connected') return 'SIN CONEXIÓN · IMAGEN ANTERIOR';
  if (tab?.limitation) return 'SIN CONTROL DESDE RELAY';
  if (tab?.dialog) return 'LA PÁGINA ESPERA UNA RESPUESTA';
  if (state.aged) return 'LA CAPTURA NO SE ACTUALIZA';
  return 'ACTUALIZANDO LA CAPTURA…';
}

/** A responder event of the page: where the touch landed in it, and where on the screen. */
type Touch = { nativeEvent: { locationX: number; locationY: number; pageX: number; pageY: number } };

/** The last frame, drawn whole; a touch is a tap, a drag scrolls. Both only on a live frame. */
function PageView({ session, state, tab, own }: { session: BrowserSession; state: BrowserState; tab: BrowserTab | null; own: boolean }) {
  const { K } = usePalette();
  const [box, setBox] = useState<Size | null>(null);
  const start = useRef<{ x: number; y: number; pageX: number; pageY: number } | null>(null);
  const frame = state.frame;
  const rect = frame && box ? frameRect(box, frame.viewport) : null;
  const stale = staleLabel(state, tab);
  const release = (event: Touch) => {
    const from = start.current;
    start.current = null;
    if (!from || !box || !frame || !state.live) return;
    const point = pagePoint(from, box, frame.viewport);
    if (!point) return;
    const drag = { dx: event.nativeEvent.pageX - from.pageX, dy: event.nativeEvent.pageY - from.pageY };
    if (Math.hypot(drag.dx, drag.dy) < 10) void session.act({ type: 'tap', ...point });
    else void session.act({ type: 'scroll', ...point, ...scrollDelta(drag, box, frame.viewport) });
  };

  return (
    <RecessedScreen style={{ flex: 1, overflow: 'hidden' }}>
    <View accessibilityLabel="Página del navegador" style={{ flex: 1 }}
      onLayout={(event) => {
        const next = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
        setBox(next);
        session.resize(next, PixelRatio.get());
      }}
      // The page box takes every touch, so none falls through to what is under it; a stale frame ignores them.
      onStartShouldSetResponder={() => true}
      onResponderGrant={(event: Touch) => { start.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY, pageX: event.nativeEvent.pageX, pageY: event.nativeEvent.pageY }; }}
      onResponderRelease={release}
      onResponderTerminate={() => { start.current = null; }}>
      {frame && rect ? (
        // Never the touch target: a touch's position is always relative to the page box.
        <View style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height, opacity: stale ? 0.35 : 1, pointerEvents: 'none' }}>
          <Image accessibilityLabel="Captura de la página" source={{ uri: `data:image/jpeg;base64,${frame.data}` }} resizeMode="stretch" fadeDuration={0} style={{ width: '100%', height: '100%' }} />
        </View>
      ) : null}
      {!state.tab ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: 20, gap: 6, pointerEvents: 'none' }}>
          <M {...TYPE.label} c={K.onScreenBright}>ELIGE UNA PESTAÑA</M>
          <T {...TYPE.secondary} c={K.onScreen} lh={1.4}>
            {own ? 'Las pestañas de este navegador están arriba; «+» abre otra.'
              : 'Solo aparecen las pestañas que compartiste con el botón de Relay en la computadora y las que abrió Relay.'}
          </T>
        </View>
      ) : stale ? (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <M {...TYPE.label} c={K.onScreenBright} accessibilityLiveRegion="polite" style={{ backgroundColor: K.screen, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>{stale}</M>
        </View>
      ) : null}
    </View>
    </RecessedScreen>
  );
}

function DialogPanel({ dialog, onAnswer }: { dialog: NonNullable<BrowserTab['dialog']>; onAnswer: (accept: boolean, text?: string) => void }) {
  const { K } = usePalette();
  const [text, setText] = useState(dialog.defaultPrompt);
  const leaving = dialog.type === 'beforeunload';
  return (
    <Card accent style={{ gap: 8 }}>
      <M {...TYPE.label} c={K.accentText}>DIÁLOGO DE LA PÁGINA</M>
      <T {...TYPE.secondary} c={K.ink} lh={1.4}>{leaving ? 'La página pregunta si quieres salir. Puedes perder lo que no guardaste.' : dialog.message || '(sin texto)'}</T>
      {dialog.type === 'prompt' ? (
        <TextInput accessibilityLabel="Respuesta del diálogo" value={text} onChangeText={setText} autoCorrect={false} selectionColor={K.accent}
          style={fieldStyle(K)} />
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {dialog.type === 'alert' ? null : (
          <Keycap accessibilityLabel="Cancelar diálogo" label={leaving ? 'Quedarse' : 'Cancelar'} onPress={() => onAnswer(false)} style={{ flex: 1 }} />
        )}
        <Keycap variant="dark" accessibilityLabel="Aceptar diálogo" label={leaving ? 'Salir' : 'Aceptar'} onPress={() => onAnswer(true, dialog.type === 'prompt' ? text : undefined)} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

const FILES_MISSING = 'Para pasar archivos entre el teléfono y el Servidor hace falta la herramienta Archivos en el Servidor y Relay en Android.';

/** The page opened a file chooser: files of the Servidor fill it; a phone file goes to the Servidor first. */
function ChooserPanel({ multiple, suggested, filesReady, onUpload, onPaths }: {
  multiple: boolean; suggested: string | null; filesReady: boolean; onUpload: () => void; onPaths: (paths: string[]) => void;
}) {
  const { K } = usePalette();
  const [path, setPath] = useState(suggested ?? '');
  const paths = path.split('\n').map((each) => each.trim()).filter(Boolean);
  const usable = paths.length > 0 && (multiple || paths.length === 1) && paths.every((each) => each.startsWith('/'));
  return (
    <Card accent style={{ gap: 8 }}>
      <M {...TYPE.label} c={K.accentText}>{multiple ? 'LA PÁGINA PIDE ARCHIVOS' : 'LA PÁGINA PIDE UN ARCHIVO'}</M>
      {filesReady ? (
        <Keycap accessibilityLabel="Subir desde el teléfono" label="Subir desde el teléfono" onPress={onUpload} />
      ) : <T {...TYPE.secondary} c={K.inkSecondary} lh={1.35}>{FILES_MISSING}</T>}
      <T {...TYPE.secondary} c={K.inkSecondary} lh={1.4}>{multiple ? 'O rutas de archivos del Servidor, una por línea.' : 'O la ruta de un archivo del Servidor.'}</T>
      <TextInput accessibilityLabel="Ruta del archivo en el Servidor" value={path} onChangeText={setPath} multiline={multiple} autoCapitalize="none" autoCorrect={false}
        placeholder="/home/…" placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
        style={fieldStyle(K)} />
      <Keycap variant="dark" accessibilityLabel="Usar archivo del Servidor" label="Usar en la página" disabled={!usable} onPress={() => onPaths(paths)} />
    </Card>
  );
}

const noSubscribe = () => () => {};
const CLOSED: BrowserState = { link: { state: 'connecting' }, tabs: null, tab: null, frame: null, live: false, aged: false, downloads: [], notice: null };
const closedState = () => CLOSED;
