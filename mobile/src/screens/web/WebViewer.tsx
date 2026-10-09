import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewSource } from 'react-native-webview/lib/WebViewTypes';

import type { RemoteWebApp } from '../../../../protocol/remoteWeb';
import { RemoteFailure } from '@/core/remoteClient';
import { webAddress, webNavigation, webPathInput, webPathOf, type WebApi } from '@/core/remoteWeb';
import { DEMO } from '@/state/app';
import { useChatVisible } from '@/state/chatVisibility';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS } from '@/theme/tokens';
import { Keycap, Lamp } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { card } from './WebAccess';

type Phase =
  | { kind: 'opening' }
  /**
   * `serial` remounts the page for each entry: a new session starts a new page. `load` remounts it
   * for the same address asked again, which an unchanged `source` would not load.
   */
  | { kind: 'showing'; origin: string; source: WebViewSource; serial: number; load: number }
  | { kind: 'failed'; error: unknown };

/** Nothing of the Servidor's control API reaches the page: it gets the app's origin and a single-use ticket. */
export function WebViewer({ app, web, admit, path, onPath, onBack, onForget, onServerBrowser, keyboard = true }: {
  app: RemoteWebApp; web: WebApi; admit: ServerRemoteAccess['admit']; path: string;
  onPath: (path: string) => void; onBack: () => void; onForget: () => void; onServerBrowser: () => void;
  /** False while another panel, tool or route has the keyboard: the page's focused field lets go of it. */
  keyboard?: boolean;
}) {
  const { K } = usePalette();
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [typed, setTyped] = useState(path);
  const [pathError, setPathError] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const page = useRef<WebView>(null);
  const shown = useChatVisible();
  // Outside render: the entry in flight, where the page is, and whether it just entered.
  const flow = useRef({ path, serial: 0, started: false, entered: false, errored: false, typing: false, release: null as (() => void) | null, revoked: false });

  /** A single-use entry at `at`: the Puente checks the app again and replaces this device's previous session. */
  const request = (at: string) => {
    const serial = ++flow.current.serial;
    flow.current.path = at;
    // An HTTP error right after entering is the app's own page, never a reason to enter again.
    flow.current.entered = true;
    web.open(app, at).then((entry) => {
      if (serial !== flow.current.serial) return;
      setPhase({ kind: 'showing', origin: entry.origin, source: { uri: entry.uri, method: 'POST', body: entry.body }, serial, load: 0 });
    }, (error: unknown) => {
      if (serial === flow.current.serial) setPhase({ kind: 'failed', error });
    });
  };
  const enter = (at: string) => {
    setLocal(null);
    setPhase({ kind: 'opening' });
    request(at);
  };
  // Admitted by the verified entry (#82). Hiding Relay (a file chooser for an upload does) only gives
  // the admission back and keeps the page; locking, losing the connection or a revocation take the
  // tool off the screen, and leaving ends the in-Relay session (ADR 0006, #89: Relay closes it on lock).
  const admitted = () => {
    if (flow.current.release) return true;
    flow.current.release = admit((reason) => {
      flow.current.release = null;
      if (reason === 'revoked') { flow.current.revoked = true; onForget(); }
    });
    return flow.current.release !== null;
  };
  const begin = useEffectEvent(() => {
    if (!admitted() || flow.current.started) return;
    flow.current.started = true;
    request(flow.current.path);
  });
  const leave = useEffectEvent(() => {
    flow.current.serial++;
    flow.current.release?.();
    flow.current.release = null;
    // A revoked device sends nothing more: the Puente already cut its sessions.
    if (flow.current.started && !flow.current.revoked) web.close(app.id).catch(() => {});
  });
  useEffect(() => { if (shown) begin(); }, [shown]);
  useEffect(() => () => leave(), []);
  // A page field keeps a physical keyboard after a touch on another panel's button; only a blur inside the page lets it go.
  useEffect(() => { if (!keyboard) page.current?.injectJavaScript('document.activeElement && document.activeElement.blur(); true;'); }, [keyboard]);

  const origin = phase.kind === 'showing' ? phase.origin : app.origin;
  /** Where a navigation goes: the app stays here, other webs open in the phone's browser and grant nothing. */
  const route = (url: string): boolean => {
    if (!origin) return false;
    const kind = webNavigation(url, origin);
    if (kind === 'external') Linking.openURL(url).catch(() => {});
    if (kind === 'local') setLocal(url);
    return kind === 'inside';
  };
  const show = (uri: string) => {
    if (phase.kind !== 'showing') return;
    const again = 'method' in phase.source || !('uri' in phase.source) || phase.source.uri !== uri ? 0 : 1;
    setPhase({ ...phase, source: { uri }, load: phase.load + again });
  };
  const go = () => {
    const next = webPathInput(typed);
    setPathError(next === null);
    if (next !== null && origin) show(`${origin}${next}`);
  };

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Keycap variant="link" accessibilityLabel="Volver a las aplicaciones" label="‹ Apps" onPress={onBack} />
        <Lamp tone={phase.kind === 'showing' ? 'green' : phase.kind === 'failed' ? 'red' : 'orange'} />
        <T s={14} w="700" c={K.ink} style={{ flex: 1 }} numberOfLines={1}>{app.name}</T>
        <Keycap accessibilityLabel="Atrás en la página" label="←" disabled={!canGoBack || phase.kind !== 'showing'} onPress={() => page.current?.goBack()} />
        <Keycap accessibilityLabel="Recargar" label="↻" disabled={phase.kind !== 'showing'} onPress={() => page.current?.reload()} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <TextInput accessibilityLabel="Ruta de la aplicación" value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} returnKeyType="go"
          onFocus={() => { flow.current.typing = true; }} onBlur={() => { flow.current.typing = false; }} onSubmitEditing={go}
          placeholder="/" placeholderTextColor={K.inkTertiary} selectionColor={K.accent}
          style={{ flex: 1, height: 48, paddingHorizontal: 12, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.mono['400'], fontSize: 12, color: K.ink }} />
        <Keycap accessibilityLabel="Ir a la ruta" label="Ir" disabled={phase.kind !== 'showing'} onPress={go} />
      </View>
      {pathError ? <T s={12.5} c={K.dangerText}>Escribe una ruta de esta aplicación, como /pedidos.</T> : null}
      {local ? (
        <View style={[card(K), { padding: 12, gap: 8, boxShadow: `${K.shadowBlock}, ${K.shadowAccentRim}` }]}>
          <M s={9.5} w="600" ls={0.57} c={K.accentText}>DIRECCIÓN LOCAL BLOQUEADA</M>
          <T s={12.5} c={K.inkSecondary} lh={1.4}>{`La aplicación intentó abrir ${local}. En el teléfono esa dirección es el propio teléfono, no el Servidor. Ajústala para usar rutas relativas o ábrela en el navegador del Servidor.`}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Keycap accessibilityLabel="Cerrar aviso" label="Entendido" onPress={() => setLocal(null)} style={{ flex: 1 }} />
            <Keycap accessibilityLabel="Usar el navegador del Servidor" label="Navegador del Servidor" onPress={onServerBrowser} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}
      {phase.kind === 'showing' ? (
        <View style={{ flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: K.key }}>
          <M s={9.5} ls={0.57} c={K.inkSecondary} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>APLICACIÓN DE LOCALHOST</M>
          {DEMO ? <DemoPage origin={phase.origin} path={path} route={route} /> : (
            <WebView key={`${phase.serial}.${phase.load}`} ref={page} source={phase.source} style={{ flex: 1 }}
              // Every navigation reaches `route`: with the default list, react-native-webview would hand
              // intent:, tel: and other schemes to Linking by itself.
              originWhitelist={['*']}
              onShouldStartLoadWithRequest={(request) => route(request.url)}
              setSupportMultipleWindows
              onOpenWindow={({ nativeEvent }) => {
                const kind = origin ? webNavigation(nativeEvent.targetUrl, origin) : 'refused';
                const inside = origin ? webPathOf(nativeEvent.targetUrl, origin) : null;
                if (kind === 'inside' && inside !== null) show(`${origin}${inside}`);
                else if (kind !== 'inside') route(nativeEvent.targetUrl);
              }}
              onNavigationStateChange={(state) => {
                setCanGoBack(state.canGoBack);
                const at = origin ? webPathOf(state.url, origin) : null;
                if (at === null) return;
                flow.current.path = at;
                onPath(at);
                if (!flow.current.typing) setTyped(at);
              }}
              onLoadStart={() => { flow.current.errored = false; }}
              onLoadEnd={() => { if (!flow.current.errored) flow.current.entered = false; }}
              onHttpError={({ nativeEvent }) => {
                flow.current.errored = true;
                if (nativeEvent.statusCode !== 401 && nativeEvent.statusCode !== 502) return;
                const at = origin ? webPathOf(nativeEvent.url, origin) : null;
                // The Puente's own answer to a session it ended (lock elsewhere, Puente restart, app
                // forgotten, app down): enter once more there, which checks the app again. Right after
                // entering, a 401 is the app's own page and stays; a 502 means it still refuses.
                if (at === null) setPhase({ kind: 'failed', error: 'entry' });
                else if (!flow.current.entered) enter(at);
                else if (nativeEvent.statusCode === 502) setPhase({ kind: 'failed', error: 'down' });
              }}
              onError={() => setPhase({ kind: 'failed', error: 'load' })}
              allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never" thirdPartyCookiesEnabled={false} />
          )}
        </View>
      ) : phase.kind === 'failed' ? (
        <Failure app={app} error={phase.error} onRetry={() => { if (admitted()) enter(flow.current.path); }} onServerBrowser={onServerBrowser} />
      ) : (
        <M s={9.5} ls={0.57} c={K.inkTertiary}>ABRIENDO…</M>
      )}
    </View>
  );
}

function failureText(app: RemoteWebApp, error: unknown): { label: string; detail: string } {
  const at = webAddress(app);
  if (error === 'load') return { label: 'LA PÁGINA NO CARGÓ', detail: 'El teléfono no llegó a la aplicación. Comprueba la conexión con tu tailnet y reintenta.' };
  if (error === 'entry') return { label: 'NO SE PUDO ENTRAR', detail: 'La entrada de Relay caducó antes de usarse. Reintenta.' };
  if (error === 'down') return { label: 'LA APLICACIÓN NO RESPONDE', detail: `La aplicación no contesta en ${at} en el Servidor. Cuando vuelva a funcionar, reintenta; Relay no abre otro puerto.` };
  if (!(error instanceof RemoteFailure)) return { label: 'NO SE PUDO ABRIR', detail: 'No se pudo completar la acción. Reintenta.' };
  switch (error.code) {
    case 'remote_ended': return { label: 'LA APLICACIÓN NO RESPONDE', detail: `Nada escucha en ${at} en el Servidor. Arráncala allí y reintenta; Relay no abre otro puerto.` };
    case 'remote_conflict': return { label: 'OTRO PROGRAMA EN ESE PUERTO', detail: `En ${at} escucha ahora otro programa, o se arrancó desde otra carpeta. Relay no lo abre: si es tu aplicación, olvídala y vuelve a elegirla.` };
    case 'remote_unavailable': return { label: 'SIN PUBLICAR', detail: 'La aplicación no tiene su nombre de Tailscale publicado en el Servidor. Revísalo con el instalador del Puente.' };
    case 'remote_not_found': return { label: 'YA NO ESTÁ REGISTRADA', detail: 'Se olvidó en este Servidor. Vuelve a elegirla entre los servicios descubiertos.' };
    default: return { label: error.kind === 'no_response' ? 'SIN RESPUESTA' : 'NO SE PUDO ABRIR', detail: error.message };
  }
}

function Failure({ app, error, onRetry, onServerBrowser }: { app: RemoteWebApp; error: unknown; onRetry: () => void; onServerBrowser: () => void }) {
  const { K } = usePalette();
  const { label, detail } = failureText(app, error);
  return (
    <View style={[card(K), { gap: 10 }]}>
      <M s={12} ls={0.57} c={K.dangerText} accessibilityLiveRegion="polite">{label}</M>
      <T s={13} c={K.inkSecondary} lh={1.4}>{detail}</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Keycap accessibilityLabel="Reintentar" label="Reintentar" onPress={onRetry} style={{ flex: 1 }} />
        <Keycap accessibilityLabel="Usar el navegador del Servidor" label="Navegador del Servidor" onPress={onServerBrowser} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

/** npm run demo has no WebView: a stand-in page with the three kinds of link the viewer tells apart. */
function DemoPage({ origin, path, route }: { origin: string; path: string; route: (url: string) => boolean }) {
  const { K } = usePalette();
  return (
    <View style={{ flex: 1, padding: 16, gap: 10 }}>
      <M s={11} c={K.inkTertiary}>{origin}{path}</M>
      <T s={20} w="700" c={K.ink}>Tienda · demostración</T>
      <T s={13} c={K.inkSecondary} lh={1.4}>La página de la aplicación se muestra aquí, servida por el Puente desde el Servidor.</T>
      <Keycap label="Enlace a otra web" onPress={() => route('https://docs.example.com/')} />
      <Keycap label="Recurso fijo a localhost" onPress={() => route('http://127.0.0.1:3000/static/app.js')} />
    </View>
  );
}
