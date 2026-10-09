import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE, ledGlow } from '@/theme/tokens';
import { useReturnLink } from '@/state/navigation';
import { useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { DEMO_REMOTE_ENTRY_SCENARIOS, demoRemoteEntry, setDemoRemoteEntry } from '@/core/demoRemote';
import { relayLayout } from '@/core/relayLayout';
import { describeRemoteToolState, type RemoteTool } from '@/core/remoteCapabilities';
import { focusPanel, pickTool, placeTool, revealTool, splitWorkspace, WORKSPACE_START, workspacePanels, type PanelIndex, type Placement, type WorkspaceTool } from '@/core/workspace';
import { DEMO, useApp } from '@/state/app';
import { useRemoteAccess } from '@/state/remoteAccess';
import { useRemoteTools } from '@/state/remoteTools';
import { BrowserTool } from './browser/BrowserTool';
import { FilesTool } from './files/FilesTool';
import { TerminalTool } from './terminal/TerminalTool';
import { WebTool, type WebPlace } from './web/WebTool';

import { PaneTopContext, ShellNavigationContext } from '@/ui/layoutContext';
import { HomeIndicator, StatusBarSpace, useBottomInset, useFramed, useKeyboardVisible } from '@/ui/chrome';
import { RootHeader, ToolHeader } from '@/ui/headers';
import { goToTab } from '@/state/navigation';
import { TabBar } from '@/ui/TabBar';
import { Lamp, ListBlock, ListRow, Segmented } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { ServerSelector, serverLed } from '@/ui/ServerSelector';
import { LedKey } from './tools/LedKey';
import { RemoteGate } from './tools/RemoteGate';

const TOOLS: Record<WorkspaceTool, { label: string; modes: readonly (readonly [RemoteTool, string | null])[] }> = {
  terminal: { label: 'Terminal', modes: [['terminal', null]] },
  files: { label: 'Archivos', modes: [['files', null]] },
  web: { label: 'Web', modes: [['webInRelay', 'En Relay'], ['webExternal', 'En el navegador del teléfono']] },
  browser: { label: 'Navegador', modes: [['browserDedicated', 'Dedicado'], ['browserHabitual', 'Habitual']] },
};
const ORDER: readonly WorkspaceTool[] = ['terminal', 'files', 'web', 'browser'];
// Two panels: each a framed block with its keyboard mark and its tool row above the tool.
const GAP = 10;
const INSET = 10;
// A panel's head: its title row and tool keys. One panel has none: the tool bar is at the bottom.
const HEAD = { single: 0, split: INSET + 30 + 6 + 32 + 8 };
/** Where a panel sits in the panels area: whole, or one half with the gap between them. */
function area(side: Placement['side']): ViewStyle {
  return side === 'full' ? { left: 0, right: 0 } : side === 'left' ? { left: 0, right: '50%', marginRight: GAP / 2 } : { left: '50%', right: 0, marginLeft: GAP / 2 };
}

export interface ServerToolsScreenProps {
  serverId: string;
  /** False while another route shows: the tools stay mounted, and none of them receives the keyboard. */
  shown?: boolean;
  /** Drawn under the header (the Herram. tab's compact row of an unresponsive Servidor). */
  top?: ReactNode;
  /** The Herram. tab: with no parent, the gate wears header A with the Servidor selector. */
  root?: boolean;
}

/**
 * The tools of one Servidor (docs/planning/relay-v3-workspace-outline.md), behind the system verification.
 * A phone shows one tool; a wide window one or two panels. Every tool stays mounted once opened, whatever
 * panel or tool shows, so terminals, folder, draft and page are kept; only the focused panel types.
 */
export function ServerToolsScreen({ serverId, shown = true, top = null, root = false }: ServerToolsScreenProps) {
  const { K } = usePalette();
  const shell = useContext(ShellNavigationContext);
  const { servers, snapshot } = useApp();
  const server = servers.find((s) => s.id === serverId);
  const name = server?.name ?? 'Servidor';
  const ret = useReturnLink();
  const access = useRemoteAccess(serverId);
  const [workspace, setWorkspace] = useState(WORKSPACE_START);
  // The Web and Navegador tools mount on their first visit and then stay, like the terminal; where the web was survives a lock.
  const [webSeen, setWebSeen] = useState(false);
  const [browserSeen, setBrowserSeen] = useState(false);
  const [webPlace, setWebPlace] = useState<WebPlace | null>(null);
  const [scenario, setScenario] = useState(demoRemoteEntry);
  const [newTerminal, setNewTerminal] = useState<{ cwd: string; serial: number } | null>(null);
  const snap = snapshot(serverId);
  const { tools, terminals, web, browsers, files } = useRemoteTools(serverId);
  const bottom = useBottomInset(12);
  const keyboardUp = useKeyboardVisible();
  const paneTop = useContext(PaneTopContext);
  const { width, fontScale } = useWindowDimensions();
  const framed = useFramed();
  // Two panels need about 390 dp each, the terminal's key bar included: a window of the split layout,
  // where the tools take the whole width beside the rail. A narrower tablet (portrait) keeps one panel.
  // ponytail: side by side only; stacked panels if two tools are wanted in portrait.
  const wide = relayLayout(framed ? 370 : width, fontScale).kind === 'split';
  const open = access.view === 'open';
  const panels = open ? workspacePanels(workspace, wide) : [];
  const split = panels.length === 2;
  const head = split ? HEAD.split : HEAD.single;
  const ready: Record<WorkspaceTool, boolean> = { terminal: terminals !== null, files: tools.files?.state === 'available', web: web !== null, browser: browsers !== null };
  const place = (tool: WorkspaceTool) => (open && ready[tool] ? placeTool(workspace, wide, tool) : null);
  // Archivos stays mounted once opened, hidden while another tool shows, Relay locks or the connection
  // drops, so its folder, draft and transfers are kept. A revocation or a new pairing discards it.
  const [filesMounted, setFilesMounted] = useState(false);
  if (access.view === 'revoked' && filesMounted) setFilesMounted(false);
  if (access.view !== 'revoked' && place('files') && !filesMounted) setFilesMounted(true);
  if (place('web') && !webSeen) setWebSeen(true);
  if (place('browser') && !browserSeen) setBrowserSeen(true);
  const toolShown = ORDER.some((tool) => place(tool) !== null);

  // The one tool that may type: the focused panel's, while this Servidor's tools show. Whenever it
  // changes (another panel, tool, route or Servidor, or a lock) the field that had the keyboard lets it go.
  const typing = shown && open ? workspace.tools[workspace.focus] : null;
  useLayoutEffect(() => { Keyboard.dismiss(); }, [typing]);
  const focus = (panel: PanelIndex) => setWorkspace((current) => focusPanel(current, panel));
  const reveal = (tool: WorkspaceTool) => setWorkspace((current) => revealTool(current, wide, tool));
  /** A mounted tool: positioned in its panel, or hidden while it waits; never moved in the tree, so never remounted. */
  const slot = (tool: WorkspaceTool): ViewStyle => {
    const placed = place(tool);
    if (!placed) return { display: 'none' };
    const inset = split ? INSET : 0;
    const sides = area(placed.side);
    return { position: 'absolute', top: head, bottom: inset, ...sides,
      marginLeft: (typeof sides.marginLeft === 'number' ? sides.marginLeft : 0) + inset,
      marginRight: (typeof sides.marginRight === 'number' ? sides.marginRight : 0) + inset };
  };
  const toolTouch = (tool: WorkspaceTool) => () => {
    const placed = place(tool);
    if (placed) focus(placed.panel);
  };

  // The gate is header A, with no return (D-21); inside the tools, or in a route that has a parent, the tool header (F-5).
  const segmented = open && wide ? <View style={{ width: 240 }}><Segmented options={['Un panel', 'Dos paneles'] as const} value={workspace.split ? 'Dos paneles' : 'Un panel'}
    onChange={(option) => setWorkspace((current) => splitWorkspace(current, option === 'Dos paneles'))} /></View> : null;
  const header = root && !open
    ? <RootHeader title="Herramientas" right={shell ? null : <ServerSelector variant="header" />} />
    : <ToolHeader back={ret?.label} onBack={ret?.go} server={name} led={serverLed(snap.reachable)} extra={segmented} />;
  const status = (
    <>
      {DEMO ? (
        <Pressable accessibilityRole="button" style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 }} onPress={() => {
          const next = DEMO_REMOTE_ENTRY_SCENARIOS[(DEMO_REMOTE_ENTRY_SCENARIOS.findIndex((s) => s.id === scenario) + 1) % DEMO_REMOTE_ENTRY_SCENARIOS.length]!;
          setScenario(next.id); setDemoRemoteEntry(next.id);
        }}>
          <T s={12} c={K.accentText}>Demostración: {DEMO_REMOTE_ENTRY_SCENARIOS.find((s) => s.id === scenario)?.name} · Cambiar</T>
        </Pressable>
      ) : null}
      <ServerConnectionStatus serverId={serverId} />
      {snap.serverControl?.paused && access.view !== 'revoked' ? (
        <M {...TYPE.label} c={K.accentText} style={{ paddingHorizontal: 16 }}>PAUSA GENERAL · LAS HERRAMIENTAS SIGUEN DISPONIBLES</M>
      ) : null}
    </>
  );

  /** A panel's frame: its head (two panels: title, state and keyboard mark, and its tool keys) and, for a tool that is not offered, why. */
  const frame = (panel: PanelIndex) => {
    const tool = workspace.tools[panel];
    const focused = workspace.focus === panel;
    const where = split ? ` en el panel ${panel + 1}` : '';
    const body = (
      <>
        {split ? (
          <>
            <View style={{ minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T s={16} w="700" c={K.ink} accessibilityRole="header">{TOOLS[tool].label}</T>
              <View style={{ minHeight: 22, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Lamp tone={ready[tool] ? 'green' : 'off'} size={6} />
                <M s={9.5} w="600" ls={0} c={ready[tool] ? K.okText : K.inkTertiary}>{ready[tool] ? 'CONECTADA' : 'NO DISPONIBLE'}</M>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Teclado${where}`} accessibilityState={{ selected: focused }} hitSlop={{ top: 8, bottom: 8 }} onPress={() => focus(panel)}
                style={{ marginLeft: 'auto', minHeight: 28, paddingHorizontal: 10, borderRadius: 8, justifyContent: 'center', backgroundColor: focused ? K.accent : K.key, boxShadow: focused ? ledGlow(K.accent) : K.shadowKey }}>
                <M s={9.5} w={focused ? '600' : '400'} ls={0.06} c={focused ? K.onAccent : K.inkSecondary}>{focused ? 'RECIBE EL TECLADO' : 'TOCA PARA ESCRIBIR AQUÍ'}</M>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
              {ORDER.map((each) => (
                <Pressable key={each} accessibilityRole="button" accessibilityLabel={`${TOOLS[each].label}${where}`} accessibilityState={{ selected: each === tool }} hitSlop={{ top: 6, bottom: 6 }}
                  onPress={() => setWorkspace((current) => pickTool(current, panel, each))}
                  style={{ flex: 1, minHeight: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: each === tool ? K.ink : K.key, boxShadow: each === tool ? undefined : K.shadowKey }}>
                  <M s={9.5} ls={0} c={each === tool ? K.block : K.inkSecondary} numberOfLines={1}>{TOOLS[each].label.toUpperCase()}</M>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        {ready[tool] ? null : (
          <ScrollView style={{ flex: 1, marginTop: 10 }} contentContainerStyle={{ gap: 14, paddingBottom: 12 }}>
            {TOOLS[tool].modes.map(([mode, modeLabel]) => {
              const state = tools[mode];
              const { label, hint } = state ? describeRemoteToolState(state)
                : { label: 'Aún no está en Relay', hint: 'Esta versión de Relay todavía no incluye esta herramienta.' };
              return (
                <ListBlock key={mode} style={{ marginHorizontal: 0 }}>
                  <ListRow title={label.toUpperCase()} meta={`${TOOLS[tool].label.toUpperCase()}${modeLabel ? ` · ${modeLabel.toUpperCase()}` : ''}`} description={hint ?? undefined} />
                </ListBlock>
              );
            })}
          </ScrollView>
        )}
      </>
    );
    const sides = area(split ? (panel === 0 ? 'left' : 'right') : 'full');
    return split ? (
      <View key={panel} onTouchStart={() => focus(panel)} style={{ position: 'absolute', top: 0, bottom: 0, ...sides }}>
        <View style={{ flex: 1, padding: INSET - 2, borderRadius: 24, backgroundColor: focused ? K.key : K.block,
          boxShadow: focused ? `0px 0px 0px 2px ${K.accent}, ${ledGlow(K.accent)}` : K.shadowBlock }}>{body}</View>
      </View>
    ) : (
      <View key={panel} style={{ position: 'absolute', top: 0, bottom: 0, ...sides }}>{body}</View>
    );
  };
  return (
    // Android 16 draws edge to edge and the window does not shrink for the keyboard (#77): the
    // terminal's rows and key bar stay above it only through this, at the root of the screen.
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={paneTop} style={{ flex: 1, backgroundColor: K.background }}>
      <StatusBarSpace />
      {header}
      {top}
      <View style={{ flex: 1, paddingHorizontal: 12, paddingBottom: open ? 6 : 0, gap: 10 }}>
        {toolShown ? null : status}
        {/* Archivos stays here while the tools are closed; the terminal and the web come back with the entry. */}
        <View style={open ? { flex: 1 } : { display: 'none' }}>
          {panels.map(frame)}
          {open && terminals ? (
            <View onTouchStart={toolTouch('terminal')} style={slot('terminal')}>
              <TerminalTool serverName={name} terminals={terminals} admit={access.admit} newAt={newTerminal} keyboard={typing === 'terminal'} />
            </View>
          ) : null}
          {filesMounted ? (
            <View onTouchStart={toolTouch('files')} style={slot('files')}>
              <FilesTool key={JSON.stringify([server?.url, server?.deviceId])} serverId={serverId} client={files} admit={access.admit} active={open && ready.files}
                onOpenTerminal={terminals ? (cwd) => { setNewTerminal((last) => ({ cwd, serial: (last?.serial ?? 0) + 1 })); reveal('terminal'); } : null} />
            </View>
          ) : null}
          {open && web && webSeen ? (
            <View onTouchStart={toolTouch('web')} style={slot('web')}>
              <WebTool web={web} inRelay={tools.webInRelay} external={tools.webExternal} admit={access.admit} keyboard={typing === 'web'}
                place={webPlace} onPlace={setWebPlace} onServerBrowser={() => reveal('browser')} />
            </View>
          ) : null}
          {open && browsers && browserSeen ? (
            <View onTouchStart={toolTouch('browser')} style={slot('browser')}>
              <BrowserTool serverName={name} browsers={browsers} admit={access.admit} files={files} filesState={tools.files}
                modes={{ browser_dedicated: tools.browserDedicated, browser_habitual: tools.browserHabitual }} />
            </View>
          ) : null}
        </View>
        {open ? null : <RemoteGate access={access} name={name} />}
      </View>
      {open && !split && !keyboardUp ? (
        // The tool bar replaces the tab bar once the tools are entered (G-1); on its way out the tabs come back.
        <View style={{ paddingBottom: bottom, backgroundColor: K.background }}>
          <View style={{ flexDirection: 'row', gap: 6, padding: 12 }}>
            {ORDER.map((each) => (
              <LedKey key={each} label={TOOLS[each].label.toUpperCase()} accessibilityLabel={TOOLS[each].label} look={each === workspace.tools[0] ? 'active' : 'idle'} radius={RADIUS.key} size={9.5} weight="400" ink={K.inkSecondary}
                onPress={() => setWorkspace((current) => pickTool(current, 0, each))} />
            ))}
          </View>
          <HomeIndicator />
        </View>
      ) : null}
      {/* The host covers the tabs' own bar: the gate, SIN CONTROL and the revoked state draw it here (D-21); the shell and the open tools return null. */}
      {root && !open ? <TabBar active="tools" onSelect={goToTab} /> : null}
    </KeyboardAvoidingView>
  );
}
