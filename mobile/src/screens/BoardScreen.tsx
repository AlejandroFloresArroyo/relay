import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS } from '@/theme/tokens';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import type { BoardCard } from '../../../protocol/board';
import { boardTitle, cardKey, emptyBoardPreferences, moveBoardCard, orderedCards, parseBoardPreferences, type BoardPreferences } from '@/core/board';
import { BOARD_DEMO_SCENARIOS, demoBoardPage, type BoardDemoScenario } from '@/core/demoBoard';
import { RelayError } from '@/core/client';
import { DEMO, useApp, usePoll } from '@/state/app';
import { loadServers, saveServers } from '@/state/storage';

import { StatusBarSpace } from '@/ui/chrome';
import { PullToRefresh } from '@/ui/gestures';
import { RootHeader } from '@/ui/headers';
import { IconKey, Keycap, ListBlock, ListRow, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { HeaderServerSelector, ServerDown } from '@/ui/ServerSelector';
import { Sheet } from '@/ui/sheet';
import { StateRow, SubjectStateBlock } from '@/ui/states';
import { BoardWebContent } from './board/BoardWebContent';
import { BoardCardView } from './board/BoardCardView';
import { boardWebNative } from '@/native/boardWeb';

export function BoardScreen({ serverId }: { serverId: string }) {
  const { clientFor, ready, servers } = useApp();
  const client = clientFor(serverId);
  const [scope, setScope] = useState({ client, revision: 0 });
  if (scope.client !== client) setScope({ client, revision: scope.revision + 1 });
  if (!ready) return <SubjectStateBlock spec={{ kind: 'loading', what: 'tablero' }} />;
  if (!servers.some(s => s.id === serverId)) return <T>Selecciona un Servidor.</T>;
  return <ScopedBoard key={`${serverId}:${scope.revision}`} serverId={serverId} client={client} />;
}
function ScopedBoard({ serverId, client }: { serverId: string; client: ReturnType<ReturnType<typeof useApp>['clientFor']> }) {
  const { K } = usePalette();
  const { servers, snapshot, refresh } = useApp();
  const server = servers.find(s => s.id === serverId), snap = snapshot(serverId);
  const [more, setMore] = useState(false);
  const [scenario, setScenario] = useState<BoardDemoScenario>('normal');
  const board = usePoll(() => {
    if (DEMO) {
      if (scenario === 'loading') return new Promise<ReturnType<typeof demoBoardPage>>(() => {});
      if (scenario === 'error' || scenario === 'offline') return Promise.reject(new RelayError(scenario === 'offline' ? 'unreachable' : 'http', 'Tablero no disponible'));
      return Promise.resolve(demoBoardPage(Date.now(), 'dev', scenario));
    }
    // The web negotiation header is sent only when this phone can actually show web Tarjetas.
    const web = client.boardWeb && boardWebNative.capability().state === 'verified';
    return web ? client.boardWeb!.page(new AbortController().signal).then(value => value.page) : client.board ? client.board() : Promise.reject(new RelayError('unavailable', 'Actualiza el Puente para ver el Tablero.'));
  }, [client, scenario], snap.down?.automaticRetry === false ? null : 15000);
  const [preferences, setPreferences] = useState<BoardPreferences>(emptyBoardPreferences);
  const current = useRef(preferences);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const writes = useRef(Promise.resolve());
  const [editing, setEditing] = useState(false);
  const [remove, setRemove] = useState<BoardCard | null>(null);
  const [proposal, setProposal] = useState<{ agentId: string; agentName: string; message: string } | null>(null);
  const storageKey = `relay.board.${serverId}`;
  useEffect(() => {
    let alive = true;
    void loadServers(storageKey).then(raw => { if (alive) { const next = parseBoardPreferences(raw); current.current = next; setPreferences(next); setLoaded(true); } }, () => { if (alive) { setStorageError(true); setLoaded(true); } });
    return () => { alive = false; };
  }, [storageKey]);
  const persist = (next: BoardPreferences) => {
    current.current = next; setPreferences(next);
    writes.current = writes.current.then(() => saveServers(storageKey, JSON.stringify(next))).then(() => setStorageError(false), () => setStorageError(true));
  };
  const cards = useMemo(() => orderedCards(board.data?.cards ?? [], preferences), [board.data, preferences]);
  const visible = cards.filter(c => !preferences.hidden.includes(cardKey(c)));
  const offline = snap.reachable === false || board.error instanceof RelayError && ['unreachable', 'timeout'].includes(board.error.code);
  const failure = !!board.error;
  const disabled = offline || failure || !loaded || !board.data;
  const retry = () => { refresh(serverId); board.reload(); };
  const suggest = (message: string) => { const agent = snap.agents[0]; if (agent) setProposal({ agentId: agent.id, agentName: agent.name, message }); };
  const acknowledge = () => persist({ ...current.current, seen: (board.data?.cards ?? []).map(cardKey) });
  const sheetKey = (action: () => void) => () => { setMore(false); action(); };
  const fresh = visible.filter(c => c.status === 'ready' && !preferences.seen.includes(cardKey(c))).length;
  const refreshAll = async () => { refresh(serverId); await board.reloaded(); };
  const card = (c: BoardCard, compact: boolean, isFresh: boolean, available: boolean, offlineCard = false) => <View key={cardKey(c)} style={{ width: compact ? '48.7%' : '100%', flexGrow: 1 }}><BoardCardView webContent={c.content.type === 'web' ? <BoardWebContent card={c} serverId={serverId} client={client} demoScenario={scenario} onRetry={retry} available={available} offline={offlineCard} /> : undefined} card={c} compact={compact} fresh={isFresh} onAction={() => { if (c.content.type === 'action') setProposal({ agentId: c.agentId, agentName: c.agentName, message: c.content.message }); }} onRefresh={() => setProposal({ agentId: c.agentId, agentName: c.agentName, message: `Actualiza la Tarjeta «${c.title}» del Tablero (id: ${c.id}).` })} /></View>;
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <RootHeader title="Tablero" right={<>
      <HeaderServerSelector />
      {editing ? <Keycap variant="primary" label="Listo" onPress={() => { acknowledge(); setEditing(false); }} style={{ flexGrow: 0 }} /> : <IconKey glyph="⋯" accessibilityLabel="Más del Tablero" onPress={() => setMore(true)} />}
    </>} />
    <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>{boardTitle(visible.length, fresh, editing)}</M>
    <Sheet visible={more} onClose={() => setMore(false)} title="Tablero" subtitle={(server?.name ?? 'Servidor').toUpperCase()}>
      <Keycap label="Administrar Servidor" onPress={sheetKey(() => router.push({ pathname: '/server/[server]', params: { server: serverId } }))} />
      <Keycap label="Editar Tablero" disabled={disabled} onPress={sheetKey(() => setEditing(true))} />
    </Sheet>
    <Sheet visible={remove !== null} onClose={() => setRemove(null)} title="¿Quitar del Tablero?" subtitle={remove?.title}
      aside={<Keycap variant="link" label="Cancelar" onPress={() => setRemove(null)} />}
      action={<Keycap variant="danger" label="Quitar del Tablero" onPress={() => { if (remove) persist({ ...current.current, removed: [...current.current.removed, cardKey(remove)] }); setRemove(null); }} />}>
      <T s={15} c={K.ink}>¿Quitar «{remove?.title}» de este Tablero? La publicación del Agente se conserva.</T>
    </Sheet>
    <Sheet visible={proposal !== null} onClose={() => setProposal(null)} title={`Mensaje a ${proposal?.agentName ?? ''}`} subtitle={`MENSAJE A ${(proposal?.agentName ?? '').toUpperCase()}`}
      aside={<Keycap variant="link" label="Cancelar" onPress={() => setProposal(null)} />}
      action={<Keycap variant="primary" label="Abrir Conversación nueva" disabled={disabled} onPress={() => { if (!proposal) return; acknowledge(); router.push({ pathname: '/chat/[server]/[agent]', params: { server: serverId, agent: proposal.agentId, boardDraft: proposal.message } }); setProposal(null); }} />}>
      <T s={15} lh={1.5} c={K.ink}>{proposal?.message}</T>
      <T s={13} c={K.inkSecondary}>Se abrirá una Conversación nueva. Revisa el mensaje y decide si lo envías desde el chat.</T>
    </Sheet>
    <PullToRefresh onRefresh={refreshAll} contentContainerStyle={{ paddingBottom: 24, gap: 12 }}>
      {DEMO ? <View style={{ paddingHorizontal: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{BOARD_DEMO_SCENARIOS.map(s => <Keycap key={s} label={{ normal: 'Normal', states: 'Estados', empty: 'Vacío', loading: 'Cargando', error: 'Error', offline: 'Sin respuesta', web: 'Web local', 'web-loading': 'Web cargando', 'web-error': 'Web error', 'web-offline': 'Web offline', 'web-unsupported': 'Web sin módulo', 'web-unverified': 'Web sin verificar', 'web-retired': 'Web retirada' }[s]} onPress={() => { board.setData(null); setScenario(s); }} style={{ flexGrow: 0 }} />)}</View> : null}
      <ServerDown serverId={serverId} />
      {offline && snap.reachable !== false ? <StateRow name={server?.name ?? 'Servidor'} kind="unreachable" onRetry={retry} /> : null}
      {storageError ? <T s={13} c={K.dangerText} style={{ paddingHorizontal: 16 }}>Las preferencias no se guardaron o no se leyeron. Los cambios pueden perderse al cerrar Relay.</T> : null}
      {failure && !offline ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'error', verb: 'cargar el Tablero', onRetry: retry }} /></View> : !board.data && !offline ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'tablero' }} /></View> : null}
      {board.data && !loaded ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'tablero' }} /></View> : null}
      {board.data && loaded ? <>
        {board.data.failedAgents.length ? <View style={{ marginHorizontal: 12, padding: 16, gap: 4, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}><T s={13} c={K.dangerText}>No se pudieron leer las Tarjetas de {board.data.failedAgents.join(', ')}. Reintenta.</T><Keycap variant="link" label="Reintentar" onPress={retry} style={{ alignSelf: 'flex-start' }} /></View> : null}
        {editing ? <>
          <SectionHeader title={`REORDENA CON SUBIR Y BAJAR · ${visible.length} VISIBLES`} />
          {cards.map((c, i) => {
            const key = cardKey(c), hidden = preferences.hidden.includes(key);
            return <View key={key} style={{ marginHorizontal: 12, padding: 12, gap: 8, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, opacity: hidden ? 0.6 : 1 }}>
              <T s={15} w="700" c={K.ink}>{c.title}</T>
              <M s={9.5} ls={0.04} c={K.inkTertiary}>{{ number: 'DATO', meter: 'MEDIDOR', states: 'ESTADOS', series: 'SERIE', log: 'REGISTRO', text: 'TEXTO', action: 'ACCIÓN', web: 'WEB' }[c.content.type]} · {c.agentName}</M>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Keycap label="Subir" accessibilityLabel={`Subir ${c.title}`} disabled={i === 0} onPress={() => persist(moveBoardCard(board.data!.cards, current.current, key, -1))} />
                <Keycap label="Bajar" accessibilityLabel={`Bajar ${c.title}`} disabled={i === cards.length - 1} onPress={() => persist(moveBoardCard(board.data!.cards, current.current, key, 1))} />
                <Keycap label={hidden ? 'Mostrar' : 'Ocultar'} accessibilityLabel={`${hidden ? 'Mostrar' : 'Ocultar'} ${c.title}`} onPress={() => persist({ ...current.current, hidden: hidden ? current.current.hidden.filter(k => k !== key) : [...current.current.hidden, key] })} />
                <Keycap variant="danger" label="Quitar" accessibilityLabel={`Quitar ${c.title}`} onPress={() => setRemove(c)} />
              </View>
            </View>;
          })}
          {preferences.removed.length ? <View style={{ marginHorizontal: 12 }}><Keycap label="Restaurar Tarjetas quitadas" onPress={() => persist({ ...current.current, removed: [] })} /></View> : null}
        </> : <>
          {!visible.length ? <>
            <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'empty', title: 'SIN TARJETAS', phrase: 'Los Agentes arman este Tablero. Pídele a uno en el chat lo que quieras tener a la vista.' }} /></View>
            <SectionHeader title="PRUEBA A PEDIR" />
            <ListBlock>{['Agrega al Tablero el estado de mis backups', 'Muéstrame aquí el uso de disco de /srv', 'Pon un botón para limpiar la caché de build'].map(message => <ListRow key={message} title={`«${message}»`} chevron disabled={!snap.agents.length} onPress={() => suggest(message)} />)}</ListBlock>
            {!snap.agents.length ? <T s={13} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>No hay Agentes disponibles en este Servidor.</T> : null}
          </> : null}
          <View style={{ paddingHorizontal: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>{visible.map(c => card(c, !['states', 'series', 'log', 'web'].includes(c.content.type), !preferences.seen.includes(cardKey(c)), !disabled, offline))}</View>
        </>}
        <M s={9.5} ls={0.04} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>Horas en la zona del teléfono. Estado calculado por el Puente. Consulta: {new Date(board.data.observedAt).toLocaleTimeString('es-MX')}</M>
      </> : null}
    </PullToRefresh>
  </View>;
}
