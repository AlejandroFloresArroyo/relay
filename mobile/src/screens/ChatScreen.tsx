import { usePalette } from '@/theme/ThemeProvider';
import { ConversationPersonalityControl } from './chat/ConversationPersonalityControl';
import { router } from 'expo-router';
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { ChatRunEvent, ChatRunTerminal, Conversation, RunSnapshot, SteerRequest } from '../../../protocol/protocol';

import { clearChatTransportError, planChatTranscript, recordChatTransportError, type ChatConnectionState } from '@/core/chatConnection';
import { RelayError, type RelayClient } from '@/core/client';
import { classifyConnectionError } from '@/core/connectionStatus';
import type { SendOutcome } from '@/core/sharedDrafts';
import { followChatScroll, initialScrollFollowing } from '@/core/scrollFollowing';
import { applyRunEvent, buildBlocks, onPhoneClock, reloadTranscript, type ChatItem } from '@/core/transcript';
import { DEMO, useApp, useNow, usePoll } from '@/state/app';
import { APP_REMOTE_CAPABILITIES } from '@/core/remoteCapabilities';
import { useChatVisible } from '@/state/chatVisibility';
import { useReturn, useReturnLink } from '@/state/navigation';

import { HomeIndicator, StatusBarSpace, useBottomInset, useFramed, useKeyboardVisible } from '@/ui/chrome';
import { PaneTopContext } from '@/ui/layoutContext';
import { M, T } from '@/ui/primitives';
import { ConnectionStatus } from '@/ui/ConnectionStatus';
import { ProtocolNotice } from '@/ui/ProtocolNotice';
import { relayLayout } from '@/core/relayLayout';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { Sheet } from '@/ui/sheet';
import { StateRow } from '@/ui/states';
import { TurnActivityPanel } from './chat/ActivityPanel';
// Shared presentation imports; feature imports stay in the ordered regions below.
// CONVERSATIONS (#36)
import { conversationRequestId, conversationTitle } from '@/core/conversations';
import { DEMO_CONVERSATION_SCENARIOS, demoConversationScenario, setDemoConversationScenario } from '@/core/demoConversations';
import { ConversationPanel } from './chat/ConversationPanel';
// TURN (#37)
import { mergeTurnSnapshot } from '@/core/turn';
import { DEMO_TURN_SCENARIOS, DEMO_WRITING_PROMPT, demoTurnScenario, setDemoTurnScenario } from '@/core/demoTurns';
import { ChatLoading, ChatStatePanel } from './chat/ChatStates';
// MODEL (#38)
import { DEMO_MODEL_SCENARIOS, demoModelScenario, setDemoModelScenario } from '@/core/demoModels';
import { ConversationModelSheet } from './chat/ConversationModelSheet';
// IMAGES (#39)
import type { PreparedImage } from '@/core/chatImages';
import { useChatImages } from './chat/useChatImages';
// FILES (#40)
import { useConversationFiles } from './chat/AssistantFiles';
import { DEMO_FILE_SCENARIOS, demoFileScenario, setDemoFileScenario } from '@/core/demoFiles';
// DICTATION (#41)
import { useDictation } from './chat/useDictation';
import { DictationButton, DictationNotice, DictationView } from './chat/DictationView';
import { DEMO_DICTATION_SCENARIOS, demoDictationScenario, setDemoDictationScenario } from '@/core/demoDictation';
import { ChatHeader } from './chat/ChatHeader';
import { ChatComposer } from './chat/ChatComposer';
import { ChatTranscript } from './chat/ChatTranscript';
import { canSubmit, type ImagesSlot } from './chat/chatSlots';
// SERVER FILES (#114)
import { withFileNotes } from '../../../protocol/chatFiles';
import { chatFilesOffered, overConversation } from '@/core/chatFiles';
import { ledGlow } from '@/theme/tokens';
import { ChatFilesPanel, FILES_ROW_INSET } from './chat/ChatFilesPanel';
import { useChatServerFiles } from './chat/useChatServerFiles';
import type { EntryDrag } from './files/parts';

/** Fixed texts for a file the Puente refused; the server's message is never shown. */
const FILE_REFUSALS: Record<string, string> = {
  remote_not_found: 'Ese archivo ya no está en el Servidor.',
  remote_bridge_protected: 'Los datos del Puente no se adjuntan.',
  remote_permission_denied: 'El Puente no puede leer ese archivo.',
};


interface ActiveTurn {
  runId: string;
  history: ChatItem[];
  startedAt: number;
  stopping: boolean;
}
interface SteeringInstruction extends SteerRequest {
  draft: string;
  accepted: boolean;
}
export function ChatScreen({ serverId, agentId, initialConversationId, initialPanelOpen = false, initialDraft, initialImage, onSharedDraftChange, onSharedDraftImageChange, beginSharedMutation, beginSharedSend, onSharedDraftFailure, preserveSharedImage }: { serverId: string; agentId: string; initialConversationId?: string; initialPanelOpen?: boolean; initialDraft?: string; initialImage?: PreparedImage; onSharedDraftChange?: (text: string) => void; onSharedDraftImageChange?: (image: PreparedImage | null) => void; beginSharedMutation?: () => (() => boolean) | null; beginSharedSend?: () => (outcome: SendOutcome) => void; onSharedDraftFailure?: (failure: unknown) => void; preserveSharedImage?: (image: PreparedImage) => boolean }) {
  const { clientFor } = useApp();
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const [scope, setScope] = useState({ client, serverId, agentId, initialConversationId, initialPanelOpen, initialDraft, revision: 0 });
  const [demoRevision, setDemoRevision] = useState(0);
  if (scope.client !== client || scope.serverId !== serverId || scope.agentId !== agentId || scope.initialConversationId !== initialConversationId || scope.initialPanelOpen !== initialPanelOpen || scope.initialDraft !== initialDraft) {
    setScope({ client, serverId, agentId, initialConversationId, initialPanelOpen, initialDraft, revision: scope.revision + 1 });
  }
  return <ConversationChat key={`${scope.revision}:${demoRevision}`} client={client} serverId={serverId} agentId={agentId} initialConversationId={initialConversationId} initialPanelOpen={initialPanelOpen} initialDraft={initialDraft} initialImage={initialImage} onSharedDraftChange={onSharedDraftChange} onSharedDraftImageChange={onSharedDraftImageChange} beginSharedMutation={beginSharedMutation} beginSharedSend={beginSharedSend} onSharedDraftFailure={onSharedDraftFailure} preserveSharedImage={preserveSharedImage} onDemoChange={() => setDemoRevision((revision) => revision + 1)} />;
}

function ConversationChat({ client, serverId, agentId, initialConversationId, initialPanelOpen, initialDraft, initialImage, onSharedDraftChange, onSharedDraftImageChange, beginSharedMutation, beginSharedSend, onSharedDraftFailure, preserveSharedImage, onDemoChange }: { client: RelayClient; serverId: string; agentId: string; initialConversationId?: string; initialPanelOpen: boolean; initialDraft?: string; initialImage?: PreparedImage; onSharedDraftChange?: (text: string) => void; onSharedDraftImageChange?: (image: PreparedImage | null) => void; beginSharedMutation?: () => (() => boolean) | null; beginSharedSend?: () => (outcome: SendOutcome) => void; onSharedDraftFailure?: (failure: unknown) => void; preserveSharedImage?: (image: PreparedImage) => boolean; onDemoChange: () => void }) {
  const { K } = usePalette();
  const { servers, snapshot, pending, openApproval, refresh } = useApp();
  const chatVisible = useChatVisible();
  const server = servers.find((s) => s.id === serverId);
  const snap = snapshot(serverId);
  const paused = snap.serverControl?.paused === true;
  const agent = snap.agents.find((a) => a.id === agentId);
  const bottom = useBottomInset(30);
  const typing = useKeyboardVisible();
  const paneTop = useContext(PaneTopContext);
  const now = useNow(1000);
  // A tablet's split frame (T-1) takes ACTIVIDAD out of the thread into a fixed panel on the right.
  const { width, fontScale } = useWindowDimensions();
  const framed = useFramed();
  const wide = relayLayout(framed ? 370 : width, fontScale).kind === 'split';

  const [items, setItems] = useState<ChatItem[]>([]);
  // BEGIN CONVERSATIONS (#36): selection, title control and conversation drafts.
  const [panelOpen, setPanelOpen] = useState(initialPanelOpen);
  // The panel closes first on back: its own listener usually sits above ours, but not when it opened with the chat.
  const link = useReturnLink();
  useReturn(panelOpen && link ? { label: link.label, go: () => setPanelOpen(false) } : null);
  const [modelOpen, setModelOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [modelScenario, setModelScenario] = useState(() => demoModelScenario(serverId));
  const modelRevision = useRef(0);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const selectedRef = useRef<Conversation | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const loadedSession = useRef<string | null>(null);
  const drafts = useRef(new Map<string, string>(initialDraft ? [["@new", initialDraft]] : []));
  const [transcriptLoading, setTranscriptLoading] = useState(initialDraft === undefined && !initialImage);
  const requestEpoch = useRef(0);
  const contextEpoch = useRef(0);
  const [creating, setCreating] = useState(false);
  const creationLock = useRef(false);
  const creationRequest = useRef<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [demoScenario, setDemoScenario] = useState(() => demoConversationScenario(serverId));
  const [panelWorking, setPanelWorking] = useState(false);
  // END CONVERSATIONS
  // BEGIN TURN (#37): lifecycle, transport, send/stop/steer and retry.
  const [running, setRunning] = useState(false);
  const [pauseCut, setPauseCut] = useState<number | null>(null);
  // A poll that started after the cut and saw no pause disowns it: the Turn stopped for another
  // reason, or the Servidor resumed since. Without this the marker would claim a later pause.
  const pollStartedAt = snap.lastContactAt === null ? null : snap.lastContactAt - (snap.latencyMs ?? 0);
  if (pauseCut !== null && !paused && pollStartedAt !== null && pollStartedAt > pauseCut) setPauseCut(null);
  const runningRef = useRef(false);
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [transportError, setTransportError] = useState<unknown>(null);
  const transcriptState = useRef<ChatConnectionState>({ previous: null, error: null });
  const [transcriptRequest, setTranscriptRequest] = useState<{ client: RelayClient; agentId: string; sessionId?: string | null; epoch: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const activeTurn = useRef<ActiveTurn | null>(null);
  const instructions = useRef(new Map<string, SteeringInstruction>());
  const uncertainSteer = useRef<SteeringInstruction | null>(null);
  const steerLock = useRef(false);
  const recoveryLock = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [steering, setSteering] = useState(false);
  const [connection, setConnection] = useState<'connected' | 'reconnecting' | 'lost'>('connected');
  const [recovering, setRecovering] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retryCountdown, setRetryCountdown] = useState(5);
  const [resync, setResync] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [turnScenario] = useState(() => demoTurnScenario(serverId));
  // research opens writing in the default demo (story 42): its Turno keeps sending text.
  const demoWriting = DEMO && turnScenario === 'normal' && agentId === 'research';
  const demoStart = useRef(demoWriting || (DEMO && ['working', 'redirected', 'rejected', 'lost', 'recovered'].includes(turnScenario)));
  const demoSteer = useRef(DEMO && (turnScenario === 'redirected' || turnScenario === 'rejected'));
  const scroll = useRef<ScrollView>(null);
  // Follow the end of the conversation until the user scrolls away from it.
  const following = useRef(initialScrollFollowing);
  const toEnd = () => {
    if (!following.current.following) return;
    // Next frame: on Android a scroll requested during the layout pass that grew the content is
    // dropped, which left long conversations open on their first message.
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
  };
  const recordScrollPosition = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    following.current = followChatScroll(following.current, { type: 'position', offset: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height });
  };
  const [column, setColumn] = useState(0);

  const info = usePoll(() => client.agentChat(agentId), [client, agentId]);
  const chatOff = info.data ? !info.data.available : false;

  const myPending = pending.filter((p) => p.serverId === serverId && p.approval.agentId === agentId);
  const pendingCount = myPending.length;

  // BEGIN SERVER FILES (#114): Archivos beside the Conversación on a tablet; dropped files travel as paths.
  const offerFiles = wide && chatFilesOffered(snap.health?.body);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesShown = filesOpen && offerFiles;
  // END SERVER FILES
  // BEGIN IMAGES (#39): slots and pure prepareSend decorator consumed by TURN.
  const attachDisabled = running || panelOpen || modelOpen || panelWorking || creating || transcriptLoading || chatOff || paused || !info.data || !!info.error || snap.reachable === false || !!transportError || (selected !== null && (!selected.writable || selected.state !== 'ready' || selected.origin !== 'relay'));
  const images: ImagesSlot = useChatImages({ initialImage, preserveSharedImage, beginImageChange: beginSharedMutation, onDraftImageChange: (image) => { if (!selectedRef.current) onSharedDraftImageChange?.(image); }, serverId, agentId, conversationId: selected?.id ?? null, bottom: typing ? 8 : bottom,
    disabled: attachDisabled, serverFiles: offerFiles ? () => setFilesOpen(true) : undefined });
  // END IMAGES
  // BEGIN SERVER FILES (#114)
  const serverFiles = useChatServerFiles({ serverId, agentId, conversationId: selected?.id ?? null, disabled: attachDisabled });
  const [dragging, setDragging] = useState<{ name: string; over: boolean } | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  // The rows keep the drag they were rendered with: what it reads must be current.
  const dropState = useRef({ columnWidth, attachDisabled, add: serverFiles.add });
  useEffect(() => { dropState.current = { columnWidth, attachDisabled, add: serverFiles.add }; });
  const over = (dx: number, grabX: number) => overConversation({ inset: FILES_ROW_INSET, grabX, dx, column: dropState.current.columnWidth });
  const attachFile = (path: string) => {
    if (dropState.current.attachDisabled) return;
    if (!dropState.current.add(path)) setConversationError('Hasta 5 archivos por mensaje.');
  };
  const fileDrag: EntryDrag = {
    onLift: (name) => setDragging({ name, over: false }),
    // Same object while the target stays lit or dark: React skips the re-render on every other move.
    onMove: (dx, grabX) => setDragging((current) => { const lit = over(dx, grabX); return current && current.over !== lit ? { ...current, over: lit } : current; }),
    onDrop: (path, dx, grabX) => { if (over(dx, grabX)) attachFile(path); },
    onEnd: () => setDragging(null),
    onAttach: attachFile,
  };
  const dropLit = filesShown && dragging?.over === true && !attachDisabled;
  // END SERVER FILES

  // BEGIN CONVERSATIONS (#36)
  useEffect(() => {
    const context = contextEpoch;
    const requests = requestEpoch;
    return () => { context.current++; requests.current++; abort.current?.abort(); };
  }, []);

  const selectConversation = (conversation: Conversation) => {
    if (runningRef.current || creationLock.current) return;
    const epoch = ++requestEpoch.current;
    selectedRef.current = conversation; setSelected(conversation); setSessionId(conversation.sessionId);
    setDraft(drafts.current.get(conversation.id) ?? ''); setItems([]); setPanelOpen(false); setModelOpen(false);
    following.current = followChatScroll(following.current, { type: 'follow' }); setTranscriptLoading(true); setConversationError(null);
    transcriptState.current = clearChatTransportError(transcriptState.current); setTransportError(null);
    setTranscriptRequest({ client, agentId, sessionId: conversation.sessionId, epoch });
  };
  const createConversation = async () => {
    if (runningRef.current || creationLock.current || snap.reachable === false || chatOff) return;
    creationLock.current = true; setCreating(true); setConversationError(null);
    const context = contextEpoch.current;
    creationRequest.current ??= conversationRequestId();
    try {
      const conversation = await client.createConversation(agentId, { requestId: creationRequest.current });
      if (context !== contextEpoch.current) return;
      creationRequest.current = null; creationLock.current = false;
      if (!selectedRef.current && drafts.current.has('@new')) {
        drafts.current.set(conversation.id, drafts.current.get('@new') ?? ''); drafts.current.delete('@new');
      }
      selectConversation(conversation);
    } catch (failure) {
      if (context === contextEpoch.current) setConversationError(failure instanceof Error ? failure.message : 'No se pudo crear la conversación. Reintenta.');
      throw failure;
    } finally {
      if (context === contextEpoch.current) { creationLock.current = false; setCreating(false); }
    }
  };
  const changeDraft = (value: string) => {
    drafts.current.set(selectedRef.current?.id ?? '@new', value); setDraft(value);
    if (!selectedRef.current) onSharedDraftChange?.(value);
  };
  const conversationControl = <Pressable accessibilityRole="button" accessibilityLabel={panelOpen ? 'Cerrar conversaciones' : 'Abrir conversaciones'} accessibilityState={{ expanded: panelOpen }} disabled={panelWorking || creating} onPress={() => { setModelOpen(false); setPanelOpen(!panelOpen); }}
    style={{ minHeight: 40, maxWidth: 260, flexShrink: 1, paddingHorizontal: 12, borderRadius: 12, backgroundColor: panelOpen ? K.ink : K.field, boxShadow: panelOpen ? undefined : K.shadowField, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    <T s={14} w="600" c={panelOpen ? K.block : K.ink} numberOfLines={1} style={{ flexShrink: 1 }}>{transcriptLoading ? 'Cargando conversación…' : selected ? !selected.title?.trim() && selected.messageCount === 0 ? 'Conversación nueva' : conversationTitle(selected) : sessionId ? 'Conversación sin título' : 'Sin conversaciones'}</T>
    <T s={16} c={panelOpen ? K.accent : K.inkSecondary}>{panelOpen ? '▴' : '▾'}</T>
  </Pressable>;
  // END CONVERSATIONS
  // Reload when the inbox for this agent changes: a decision taken in the sheet alters the transcript.
  useEffect(() => {
    if ((initialDraft !== undefined || initialImage) && !selectedRef.current) return;
    const plan = planChatTranscript(transcriptState.current, { client, agentId, pendingCount, retry, reachable: snap.reachable }, runningRef.current);
    transcriptState.current = plan.state;
    if (plan.load) {
      const epoch = ++requestEpoch.current;
      setTranscriptLoading(true);
      setTranscriptRequest({ client, agentId, sessionId: selectedRef.current?.sessionId ?? initialConversationId, epoch });
    }
    // The live stream owns the transcript while running; its completion does not request a reload.
  }, [client, agentId, pendingCount, retry, snap.reachable, transportError, initialConversationId, initialDraft, initialImage]);

  // Reachability alone must not cancel a request: only a newly planned load replaces it.
  useEffect(() => {
    if (!transcriptRequest) return;
    let alive = true;
    const modelRevisionAtRead = modelRevision.current;
    // Reconcile only when both history and the current approval list are authoritative.
    Promise.all([
      transcriptRequest.client.transcript(transcriptRequest.agentId, transcriptRequest.sessionId),
      transcriptRequest.client.approvals(),
    ]).then(
      ([t, pendingApprovals]) => {
        if (!alive || transcriptRequest.epoch !== requestEpoch.current || runningRef.current) return;
        transcriptState.current = clearChatTransportError(transcriptState.current);
        setTransportError(transcriptState.current.error);
        const previousSession = loadedSession.current;
        loadedSession.current = t.sessionId;
        const offset = transcriptRequest.client.serverClockOffsetMs?.() ?? 0;
        setItems((prev) => reloadTranscript(prev, previousSession, { ...t, items: onPhoneClock(t.items, offset) }, pendingApprovals));
        setSessionId(t.sessionId);
        const loadedConversation = t.conversation ?? null;
        // A history read started before a successful model write cannot undo its receipt.
        const conversation = loadedConversation && modelRevisionAtRead !== modelRevision.current && loadedConversation.id === selectedRef.current?.id
          ? { ...loadedConversation, model: selectedRef.current.model } : loadedConversation;
        const previousId = selectedRef.current?.id;
        selectedRef.current = conversation; setSelected(conversation);
        if (previousId !== conversation?.id) setDraft(drafts.current.get(conversation?.id ?? '@new') ?? '');
        setTranscriptLoading(false);
      },
      (e) => {
        if (!alive || transcriptRequest.epoch !== requestEpoch.current || runningRef.current) return;
        setTranscriptLoading(false);
        transcriptState.current = recordChatTransportError(transcriptState.current, e);
        setTransportError(transcriptState.current.error);
        refresh();
      },
    );
    return () => {
      alive = false;
    };
  }, [transcriptRequest, refresh]);


  function returnInstruction(text: string, uncertain = false) {
    if (!text.trim()) return;
    const key = selectedRef.current?.id ?? '@new';
    const current = drafts.current.get(key) ?? '';
    if (!`\n${current.trim()}\n`.includes(`\n${text.trim()}\n`)) changeDraft(current ? `${current}\n${text}` : text);
    setConversationError(uncertain ? 'No se confirmó la entrega de esta instrucción. El texto se conserva; revisa antes de reenviarlo.' : 'Esta instrucción no se entregó. Se conserva en el compositor para reenviarla.');
  }

  function acceptInstruction(turn: ActiveTurn, requestId: string) {
    const instruction = instructions.current.get(requestId);
    if (activeTurn.current !== turn || !instruction || instruction.accepted) return;
    instruction.accepted = true;
    if (uncertainSteer.current === instruction) uncertainSteer.current = null;
    const current = drafts.current.get(selectedRef.current?.id ?? '@new') ?? '';
    if (current === instruction.draft) changeDraft('');
    setItems((previous) => previous.some((item) => item.kind === 'user' && item.clientMessageId === requestId)
      ? previous.map((item) => item.kind === 'user' && item.clientMessageId === requestId ? { ...item, redirected: true } : item)
      : [...previous, { kind: 'user', id: `steer:${requestId}`, clientMessageId: requestId, runId: turn.runId, text: instruction.input, at: Date.now(), redirected: true }]);
    setConversationError(null);
  }

  function finishTurn(turn: ActiveTurn, event: ChatRunTerminal) {
    if (activeTurn.current !== turn) return;
    if (event.pendingSteer) returnInstruction(event.pendingSteer);
    // An in-flight request is not delivery evidence, even if its HTTP response arrives later.
    for (const instruction of instructions.current.values()) {
      if (!instruction.accepted && !event.pendingSteer?.includes(instruction.input)) returnInstruction(instruction.input, true);
    }
    activeTurn.current = null;
    abort.current?.abort();
    uncertainSteer.current = null;
    runningRef.current = false; setRunning(false); setStopping(false); setSteering(false);
    // Not our stop: if the Servidor turns out to be paused, the chat marks where the Turn stopped.
    // run.cancelled carries no time, so the marker shows this phone's clock when the event arrived.
    setPauseCut(event.type === 'run.cancelled' && !turn.stopping ? Date.now() : null);
    steerLock.current = false; setRetryAt(null); setRecovering(false);
    setConnection('connected'); setTransportError(null);
    transcriptState.current = clearChatTransportError(transcriptState.current);
    setItems((previous) => {
      const finalized = applyRunEvent(previous, event, Date.now(), turn.runId);
      const last = finalized[finalized.length - 1];
      return event.type === 'run.completed' && event.output.trim() && last?.kind === 'assistant'
        ? [...finalized.slice(0, -1), { ...last, text: event.output }] : finalized;
    });
    refresh();
  }

  function markLost(failure: unknown) {
    if (!activeTurn.current) return;
    setConnection('lost');
    setRetryAt(classifyConnectionError(failure).automaticRetry ? Date.now() + 5000 : null);
    setRetryCountdown(5);
    setTransportError(failure);
  }

  function consumeEvent(turn: ActiveTurn, event: ChatRunEvent) {
    if (activeTurn.current !== turn) return;
    if (event.type === 'run.input') { images.inputReceipt?.(event); return; }
    if (event.type === 'run.steered') { if (event.accepted === true) acceptInstruction(turn, event.requestId); return; }
    if (event.type === 'run.steer_pending') { returnInstruction(event.text); return; }
    if (event.type === 'run.connection') {
      if (event.connection === 'connected') { setConnection('connected'); setRetryAt(null); setTransportError(null); }
      else { setConnection(event.connection); setRetryAt(Date.now() + 5000); setRetryCountdown(5); }
      return;
    }
    if (event.type === 'run.resync_required') { setResync(true); return; }
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') { finishTurn(turn, event); return; }
    setItems((previous) => applyRunEvent(previous, event, Date.now(), turn.runId));
    if (event.type === 'approval.request') {
      refresh();
      openApproval({ serverId, serverName: server?.name ?? '', approval: event.approval });
    }
  }

  async function subscribeTurn(turn: ActiveTurn, ctrl: AbortController, cursor?: number) {
    const context = contextEpoch.current;
    try {
      await client.runEvents(turn.runId, (event) => {
        if (context === contextEpoch.current && !ctrl.signal.aborted) consumeEvent(turn, event);
      }, ctrl.signal, cursor);
      if (context === contextEpoch.current && !ctrl.signal.aborted && activeTurn.current === turn) markLost(new RelayError('unreachable', 'La respuesta se cortó antes de terminar.'));
    } catch (failure) {
      if (context === contextEpoch.current && !ctrl.signal.aborted && activeTurn.current === turn) markLost(failure);
    }
  }

  function reconcileSnapshot(turn: ActiveTurn, state: RunSnapshot) {
    if (activeTurn.current !== turn) return false;
    if (state.runId !== turn.runId || state.conversationId !== selectedRef.current?.id) throw new RelayError('http', 'El Puente devolvió otro Turno. Se conserva la respuesta actual.');
    if (!Array.isArray(state.items) || !Array.isArray(state.steers) || !Number.isSafeInteger(state.lastEventId) || state.lastEventId < -1) throw new RelayError('http', 'El estado del Turno que envió el Puente no es válido. La respuesta recibida se conserva.');
    if (!state.complete) setResync(true);
    const loaded = { ...state, items: onPhoneClock(state.items, client.serverClockOffsetMs?.() ?? 0) };
    setItems((previous) => mergeTurnSnapshot(turn.history, previous, loaded));
    for (const receipt of state.steers) {
      if (receipt.status === 'accepted') acceptInstruction(turn, receipt.requestId);
      else if (receipt.status === 'rejected') {
        const instruction = instructions.current.get(receipt.requestId);
        if (instruction) returnInstruction(instruction.input);
        if (uncertainSteer.current?.requestId === receipt.requestId) uncertainSteer.current = null;
        instructions.current.delete(receipt.requestId);
      }
    }
    setSessionId(state.sessionId);
    if (selectedRef.current && selectedRef.current.sessionId !== state.sessionId) {
      const selected = { ...selectedRef.current, sessionId: state.sessionId };
      selectedRef.current = selected; setSelected(selected);
    }
    if (state.terminal) { finishTurn(turn, state.terminal); return false; }
    if (state.phase === 'stopping') { turn.stopping = true; setStopping(true); }
    return true;
  }

  async function recoverRun() {
    const turn = activeTurn.current;
    if (!turn || recoveryLock.current) return;
    const context = contextEpoch.current;
    recoveryLock.current = true; setRecovering(true); setRetryAt(null); setConnection('reconnecting');
    abort.current?.abort();
    try {
      const state = await client.runSnapshot(turn.runId);
      if (context !== contextEpoch.current || activeTurn.current !== turn || !reconcileSnapshot(turn, state)) return;
      const recovered = await client.reconnectRun(turn.runId);
      if (context !== contextEpoch.current || activeTurn.current !== turn || !reconcileSnapshot(turn, recovered)) return;
      if (recovered.connection !== 'connected') {
        markLost(new RelayError('unreachable', 'El Turno sigue sin conexión. Reintenta sin reenviar el mensaje.'));
        return;
      }
      setTransportError(null); setConnection('connected'); setConversationError(null);
      const ctrl = new AbortController(); abort.current = ctrl;
      void subscribeTurn(turn, ctrl, recovered.lastEventId);
    } catch (failure) {
      if (context === contextEpoch.current && activeTurn.current === turn) markLost(failure);
    } finally {
      if (context === contextEpoch.current) { recoveryLock.current = false; setRecovering(false); }
    }
  }

  const retryTurn = useEffectEvent(() => { void recoverRun(); });
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setRetryCountdown(seconds);
      if (seconds === 0) retryTurn();
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  async function steer() {
    const turn = activeTurn.current;
    if (dictation.isListening() || !turn || turn.stopping || steerLock.current || connection !== 'connected' || snap.reachable === false || chatOff) return;
    const current = drafts.current.get(selectedRef.current?.id ?? '@new') ?? '';
    if (!current.trim()) return;
    const instruction = uncertainSteer.current ?? { requestId: conversationRequestId(), input: current.trim(), draft: current, accepted: false };
    instructions.current.set(instruction.requestId, instruction);
    uncertainSteer.current = instruction;
    const context = contextEpoch.current;
    steerLock.current = true; setSteering(true); setConversationError(null);
    try {
      const accepted = await client.steerRun(turn.runId, { requestId: instruction.requestId, input: instruction.input });
      if (context !== contextEpoch.current || activeTurn.current !== turn) return;
      if (accepted.runId !== turn.runId || accepted.requestId !== instruction.requestId || accepted.accepted !== true) throw new RelayError('operation_uncertain', 'No se confirmó la entrega. Reintenta la misma instrucción.');
      acceptInstruction(turn, accepted.requestId);
    } catch (failure) {
      if (context !== contextEpoch.current || activeTurn.current !== turn || instruction.accepted) return;
      // A definite rejection may be edited/re-sent; network uncertainty must reuse its receipt.
      if (failure instanceof RelayError && failure.status !== null && failure.status < 500 && failure.code !== 'operation_uncertain') {
        returnInstruction(instruction.input);
        uncertainSteer.current = null; instructions.current.delete(instruction.requestId);
      }
      setConversationError(failure instanceof Error ? failure.message : 'La instrucción no se entregó. Se conserva para reintentar.');
    } finally {
      if (context === contextEpoch.current && activeTurn.current === turn) { steerLock.current = false; setSteering(false); }
    }
  }

  async function stop() {
    const turn = activeTurn.current;
    if (!turn || turn.stopping || connection !== 'connected') return;
    const context = contextEpoch.current;
    turn.stopping = true; setStopping(true); setConversationError(null);
    try { await client.stopRun(turn.runId); }
    catch (failure) {
      if (context !== contextEpoch.current || activeTurn.current !== turn) return;
      turn.stopping = false; setStopping(false);
      setConversationError(failure instanceof Error ? failure.message : 'No se pudo detener el Turno. Reintenta.');
    }
  }

  // BEGIN DICTATION (#41): microphone control updating the shared draft.
  const [dictationScenario, setDictationScenario] = useState(() => demoDictationScenario(serverId));
  const dictation = useDictation({ scope: `${serverId}:${agentId}:${selected?.id ?? '@new'}`, draft, onDraft: changeDraft,
    disabled: !chatVisible || panelOpen || modelOpen || chatOff || paused || !info.data || !!info.error || transcriptLoading || creating || snap.reachable === false || !!transportError || running || stopping || (sessionId !== null && (!selected?.writable || selected.state !== 'ready')),
    demoScenario: DEMO ? dictationScenario : undefined });
  const dictationControl = dictation.listening || (!draft.trim() && !images.hasAttachment && !serverFiles.hasAttachment) ? <DictationButton large={dictation.listening} disabled={dictation.phase === 'finishing' || panelOpen || modelOpen || chatOff || paused || !info.data || !!info.error || transcriptLoading || creating || snap.reachable === false || !!transportError}
    onBegin={() => { void dictation.begin(); }} onRelease={dictation.release} onCancel={dictation.cancel} /> : undefined;
  const demoDictationStarted = useRef(false);
  const startDemoDictation = useEffectEvent(() => {
    void dictation.begin().then(() => { if (dictationScenario === 'finishing') dictation.release(); });
  });
  useEffect(() => {
    if (!DEMO || (dictationScenario === 'idle' || dictationScenario === 'blocked') || transcriptLoading || !info.data || running || demoDictationStarted.current) return;
    demoDictationStarted.current = true; startDemoDictation();
  }, [dictationScenario, transcriptLoading, info.data, running]);
  // END DICTATION
  async function send(demoInput?: string) {
    const sharedPermission = beginSharedMutation ? beginSharedMutation() : () => true;
    if (!sharedPermission) return;
    const input = (demoInput ?? draft).trim();
    if (images.preparing || runningRef.current || creationLock.current || panelWorking || transcriptLoading || transportError || !info.data || info.error || snap.reachable === false
      || (sessionId !== null && (!selectedRef.current?.writable || selectedRef.current.state !== 'ready'))
      || !canSubmit({ draft: demoInput ?? draft, hasAttachment: images.hasAttachment || serverFiles.hasAttachment, listening: dictation.isListening(), running, chatOff })) return;
    // #114: a Puente that no longer offers chat_files would refuse the key; nothing is sent and the chips stay.
    if (serverFiles.hasAttachment && !chatFilesOffered(snap.health?.body)) { setConversationError('Actualiza el Puente para adjuntar archivos del Servidor.'); return; }
    setPauseCut(null);
    const context = contextEpoch.current;
    const selectedAtSend = selectedRef.current;
    const originalDraft = draft;
    let preparedRequest;
    try { preparedRequest = serverFiles.prepareSend(images.prepareSend({ input, sessionId: selectedAtSend?.sessionId })); }
    catch (failure) { setConversationError(failure instanceof Error ? failure.message : 'Esta imagen no se puede preparar. Elige otra.'); return; }
    const optimisticId = `u${conversationRequestId()}`;
    const history = items;
    runningRef.current = true; requestEpoch.current++;
    setRunning(true); setTurnStartedAt(null); setConversationError(null); setResync(false); setConnection('connected');
    instructions.current.clear(); uncertainSteer.current = null;
    following.current = followChatScroll(following.current, { type: 'follow' });
    const ctrl = new AbortController(); abort.current = ctrl;
    let runAttempted = false;
    const withdrawSharedAttempt = () => {
      images.rejected?.(preparedRequest);
      if (context === contextEpoch.current && !ctrl.signal.aborted) {
        runningRef.current = false; setRunning(false);
        setConversationError(runAttempted
          ? 'No se confirmó el resultado del envío. Revisa la Conversación antes de volver a enviar.'
          : 'Se interrumpió el envío. La Conversación puede haberse creado; el Turno no se inició. Revisa antes de volver a enviar.');
      }
    };
    // A shared draft stays out of a lock purge until the Server answers.
    const settleShared = beginSharedSend?.();
    let outcome: SendOutcome = 'refused';
    try {
      let target = selectedAtSend;
      if (!target) {
        creationRequest.current ??= conversationRequestId();
        target = await client.createConversation(agentId, { requestId: creationRequest.current });
        if (context !== contextEpoch.current || ctrl.signal.aborted) { images.rejected?.(preparedRequest); return; }
        if (!sharedPermission()) { withdrawSharedAttempt(); return; }
        images.moveDraft?.(target.id); serverFiles.moveDraft(target.id);
        creationRequest.current = null; selectedRef.current = target; setSelected(target); setSessionId(target.sessionId);
        const nextDraft = drafts.current.get('@new') ?? '';
        drafts.current.delete('@new'); drafts.current.set(target.id, nextDraft); setDraft(nextDraft);
      }
      const request = { ...preparedRequest, sessionId: target.sessionId };
      runAttempted = true;
      const accepted = await client.startRun(agentId, request);
      // The Turno exists now: its image becomes a local receipt even if this scope was hidden.
      outcome = 'accepted';
      images.accepted?.(request, accepted, target.id, accepted.inputMessageId ?? optimisticId);
      serverFiles.accepted(target.id);
      if (!sharedPermission()) { withdrawSharedAttempt(); return; }
      if (context !== contextEpoch.current || ctrl.signal.aborted) return;
      const turn: ActiveTurn = { runId: accepted.runId, history, startedAt: Date.now(), stopping: false };
      activeTurn.current = turn; setTurnStartedAt(turn.startedAt);
      if ((drafts.current.get(target.id) ?? '') === originalDraft) changeDraft('');
      setItems((previous) => [...previous, { kind: 'user', id: accepted.inputMessageId ?? optimisticId, clientMessageId: accepted.clientMessageId, runId: accepted.runId, text: withFileNotes(input, request.files?.map((file) => file.path) ?? []), at: turn.startedAt }]);
      if (accepted.sessionId) {
        setSessionId(accepted.sessionId); loadedSession.current = accepted.sessionId;
        const continued = { ...target, sessionId: accepted.sessionId };
        selectedRef.current = continued; setSelected(continued);
      }
      void subscribeTurn(turn, ctrl);
    } catch (failure) {
      // Terminal authorization belongs to this exact client, even after visibility ends.
      onSharedDraftFailure?.(failure);
      // Validation refusals happen before Hermes accepts input. Authorization or transport
      // failures can arrive after acceptance, so their local copies stay reserved.
      // Every remote_* code comes from the Puente's file check, which runs before anything starts (503 remote_unavailable too).
      const refused = !runAttempted || (failure instanceof RelayError && (failure.code.startsWith('remote_') || failure.status !== null && failure.status >= 400 && failure.status < 500
        && (failure.code.startsWith('invalid_') || ['bad_request', 'image_too_large', 'conversation_read_only', 'conversation_not_found', 'protocol_upgrade_required', 'run_busy', 'conversation_busy', 'model_not_configured'].includes(failure.code))));
      if (refused) images.rejected?.(preparedRequest);
      else if (outcome === 'refused') outcome = 'uncertain';
      if (context !== contextEpoch.current || ctrl.signal.aborted) return;
      runningRef.current = false; setRunning(false);
      if (failure instanceof RelayError && failure.code === 'conversation_read_only') {
        const current = selectedRef.current;
        if (current) { const readOnly = { ...current, writable: false, origin: 'external' as const }; selectedRef.current = readOnly; setSelected(readOnly); }
      }
      setConversationError(failure instanceof RelayError && failure.code.startsWith('remote_') ? FILE_REFUSALS[failure.code] ?? 'No se pudo adjuntar el archivo. Reintenta.'
        : beginSharedMutation ? 'El envío quedó sin confirmar. Se conserva el borrador. Revisa la Conversación antes de reintentar.' : failure instanceof Error ? failure.message : 'No se pudo enviar el mensaje. Reintenta.');
    } finally {
      settleShared?.(outcome);
    }
  }

  useEffect(() => {
    if (!DEMO) return;
    if (demoStart.current && !transcriptLoading && info.data?.available && !info.error && !transportError && snap.reachable !== false) {
      demoStart.current = false;
      void send(demoWriting ? DEMO_WRITING_PROMPT : 'Los tests de integración fallan desde el merge de ayer. ¿Lo revisas y lo arreglas?');
    }
    if (demoSteer.current && activeTurn.current) {
      demoSteer.current = false;
      changeDraft('Ignora los tests e2e, solo integración.');
      void steer();
    }
  });

  // END TURN
  // BEGIN MODEL (#38): selection and header control.
  const chosenModel = selected?.model ?? (agent ? { provider: agent.provider, model: agent.model } : null);
  const modelDisabled = modelOpen || panelOpen || creating || transcriptLoading || !selected?.writable || selected.state !== 'ready' || selected.origin !== 'relay' || snap.reachable === false || (running && turnStartedAt === null);
  const modelControl: ReactNode = <Pressable accessibilityRole="button" accessibilityLabel="Cambiar modelo de esta conversación"
    disabled={modelDisabled} accessibilityState={{ expanded: modelOpen }} onPress={() => setModelOpen(true)} style={{ minHeight: 24, maxWidth: '100%', justifyContent: 'center', alignSelf: 'flex-start' }}>
    <M accessibilityLabel={`${running ? 'Modelo del siguiente Turno' : 'Modelo de esta conversación'}: ${chosenModel?.provider ?? ''} / ${chosenModel?.model ?? ''}`} s={9.5} ls={0.04} c={K.inkTertiary} numberOfLines={1}>
      {server?.name.toUpperCase()} · {running && connection !== 'connected' ? 'SIN RESPUESTA' : chosenModel?.model.toUpperCase()}{running ? ' · SIGUIENTE TURNO' : ''}{modelDisabled ? '' : ' ▾'}
    </M>
  </Pressable>;
  // END MODEL
  // BEGIN FILES (#40): assistant file renderer.
  const files = useConversationFiles({ client, serverId, agentId, conversationId: selected?.id ?? null, revision: items.map((item) => item.id).join('|'), enabled: items.some((item) => item.kind === 'assistant' && /MED[Iİı]A:/i.test(item.text)) && !running, errorMessageId: items.find((item) => item.kind === 'assistant' && /MED[Iİı]A:/i.test(item.text))?.id ?? null });
  const fileReloads = useRef(new Set<string>());
  useEffect(() => {
    if (running) return;
    const announced = items.flatMap((item) => item.kind === 'assistant' && item.runId && /MED[Iİı]A:/i.test(item.text) ? [item.runId] : []);
    if (announced.some((runId) => !fileReloads.current.has(runId))) {
      for (const runId of announced) fileReloads.current.add(runId);
      setRetry((value) => value + 1);
    }
  }, [items, running]);
  const renderAssistantFiles = (itemId: string) => <>{files.render(itemId)}{DEMO && items.find((item) => item.kind === 'assistant')?.id === itemId ? <Pressable accessibilityRole="button" accessibilityLabel="Cambiar escenario de archivos" onPress={() => {
    const index = DEMO_FILE_SCENARIOS.findIndex((scenario) => scenario.id === demoFileScenario(serverId));
    setDemoFileScenario(serverId, DEMO_FILE_SCENARIOS[(index + 1) % DEMO_FILE_SCENARIOS.length].id); onDemoChange();
  }} style={{ minHeight: 44, justifyContent: 'center' }}><T s={12} w="600" c={K.accentText}>Archivos demo: {DEMO_FILE_SCENARIOS.find((scenario) => scenario.id === demoFileScenario(serverId))?.name} · Cambiar</T></Pressable> : null}</>;
  // END FILES

  const waiting = items.some((it) => it.kind === 'tool' && it.status === 'waiting');
  const blocks = useMemo(() => buildBlocks(items, running || waiting), [items, running, waiting]);
  const offlineTurn = running && connection !== 'connected';
  const status = offlineTurn || snap.reachable === false ? 'off' : waiting || running ? 'busy' : (agent?.status ?? 'off');
  const loadError = !running && transportError instanceof RelayError && transportError.status !== null && classifyConnectionError(transportError).kind === 'unreachable';
  const retryChat = () => {
    if (runningRef.current && activeTurn.current) { void recoverRun(); return; }
    setRetry((n) => n + 1); info.reload(); refresh(serverId);
  };
  const elapsed = Math.max(0, Math.floor((now - (turnStartedAt ?? now)) / 1000));
  const lastActivity = blocks.findLast((block) => block.kind === 'activity') ?? null;
  const openWaiting = () => { if (myPending[0]) openApproval(myPending[0]); };
  const diagnosis = snap.down ?? classifyConnectionError(transportError ?? info.error);

  return (
    // Android draws edge to edge: the window does not shrink for the keyboard, so both platforms pad.
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: K.background }} behavior="padding" keyboardVerticalOffset={paneTop}>
      <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} aria-hidden={modelOpen} accessibilityElementsHidden={modelOpen} importantForAccessibility={modelOpen ? 'no-hide-descendants' : 'auto'}>
      <StatusBarSpace />
      <ChatHeader paused={paused} onAgent={() => router.push({ pathname: '/agent/[server]/[agent]', params: { server: serverId, agent: agentId } })} agentId={agentId} agentName={agent?.name ?? agentId} serverName={server?.name ?? ''} model={agent?.model ?? ''} status={status}
        modelControl={modelControl}
        selectors={<>{conversationControl}<ConversationPersonalityControl serverId={serverId} agentId={agentId} conversation={selected} running={running} disabled={modelOpen || panelOpen || creating || transcriptLoading || (running && turnStartedAt === null)}/></>}
        onTools={DEMO || Object.keys(APP_REMOTE_CAPABILITIES).length > 0 ? () => router.push({ pathname: '/tools/[server]', params: { server: serverId } }) : undefined}
        onActions={() => setActionsOpen(true)}
        onBack={link?.go} backLabel={link?.label} />

      <View style={{ flex: 1, flexDirection: 'row' }}>

      <View testID="conversacion-destino" onLayout={(event) => setColumnWidth(event.nativeEvent.layout.width)}
        style={{ flex: 1, ...(dropLit ? { borderRadius: 20, boxShadow: `0px 0px 0px 2px ${K.accent}, ${ledGlow(K.accent)}` } : {}) }}>
      <View style={{ flex: 1 }} aria-hidden={panelOpen || modelOpen} accessibilityElementsHidden={panelOpen || modelOpen} importantForAccessibility={panelOpen || modelOpen ? 'no-hide-descendants' : 'auto'}>
      <ScrollView
        ref={scroll}
        accessibilityLabel="Mensajes de esta Conversación"
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onLayout={(e) => {
          setColumn(e.nativeEvent.layout.width - 24);
          // the keyboard shrinks the list: keep the newest message in view
          toEnd();
        }}
        onContentSizeChange={toEnd}
        onScrollBeginDrag={() => { following.current = followChatScroll(following.current, { type: 'drag' }); }}
        onScroll={recordScrollPosition}
        onScrollEndDrag={recordScrollPosition}
        onMomentumScrollEnd={recordScrollPosition}
        scrollEventThrottle={64}
        contentContainerStyle={{ padding: 12, gap: 10, flexGrow: 1, justifyContent: !items.length && !chatOff ? 'flex-end' : undefined }}>
        {sessionId !== null && (!selected?.writable || selected.state !== 'ready') ? <RecessedScreen radius={14} style={{ padding: 12 }}><T s={13} c={K.onScreen}>Esta conversación nació en {selected?.originLabel ?? 'un origen sin verificar'}. Solo lectura.</T></RecessedScreen> : null}
        {transcriptLoading ? <ChatLoading /> : !items.length && !transportError && !chatOff ? <ChatStatePanel title={selected?.writable === false ? 'SIN MENSAJES' : 'CONVERSACIÓN NUEVA'}>{sessionId ? 'Esta conversación todavía no tiene mensajes.' : 'Escribe el primer mensaje o crea una conversación nueva.'}</ChatStatePanel> : null}
        <ChatTranscript renderUserAttachment={images.renderUserAttachment} renderAssistantFiles={renderAssistantFiles} assistantText={files.displayText} blocks={blocks} column={column} now={now} hideActivity={wide && !filesShown} writing={running && !waiting} onWaitingPress={openWaiting} />
        {paused && pauseCut !== null ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: K.accent }}>
          <Lamp tone="orange" /><M s={9.5} ls={0.06} c={K.accentText} style={{ flex: 1 }}>PAUSA GENERAL · {new Date(pauseCut).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })} · EL TURNO SE DETUVO AQUÍ</M>
        </View> : null}
        {resync ? <T accessibilityRole="alert" s={13} lh={1.5} c={K.inkSecondary}>La respuesta tiene un corte: no se pudieron recuperar todos los eventos. Lo recibido se conserva.</T> : null}
        {chatOff ? <ChatStatePanel title={`CHAT NO DISPONIBLE EN ${(server?.name ?? 'ESTE SERVIDOR').toUpperCase()}`}>{info.data?.reason ?? 'Activa el chat de este Agente en Hermes para conversar desde Relay.'}</ChatStatePanel> : null}
        {offlineTurn ? <ChatStatePanel offline title={`CONEXIÓN PERDIDA CON ${(server?.name ?? 'ESTE SERVIDOR').toUpperCase()}`}
          action={recovering ? 'Reconectando…' : 'Reintentar'} onAction={recovering ? undefined : retryChat}
          countdown={retryAt === null ? null : retryCountdown}>
          La respuesta se cortó en este punto. Lo que llegó hasta aquí se conserva.
        </ChatStatePanel> : null}
        {loadError ? <ChatStatePanel error title="NO SE PUDO CARGAR LA CONVERSACIÓN" action="Reintentar" onAction={retryChat}>
          {transportError instanceof Error ? transportError.message : 'El Servidor respondió con un error al pedir los mensajes.'}
        </ChatStatePanel> : null}
        <ProtocolNotice protocol={snap.protocol} stale={snap.protocolStale} />
        {!offlineTurn && !loadError && (snap.reachable === false || transportError || info.error) ? (
          // A Servidor without response is a compact row here; other causes keep their way out.
          diagnosis.kind === 'unreachable'
            ? <View style={{ marginHorizontal: -12 }}><StateRow name={server?.name ?? 'Servidor'} kind="unreachable" onRetry={retryChat} /></View>
            : <ConnectionStatus serverName={server?.name ?? 'este Servidor'} diagnosis={diagnosis} onRetry={retryChat}
              onPair={() => router.push({ pathname: '/connect', params: { serverId } })} />
        ) : null}
      </ScrollView>
      {conversationError ? <T accessibilityRole="alert" s={13} c={K.dangerText} style={{ marginHorizontal: 12, marginBottom: 8 }}>{conversationError}</T> : null}

      <DictationNotice phase={dictation.phase} />
      {dictation.listening ? <DictationView phase={dictation.phase} text={dictation.text} elapsed={Math.max(0, Math.floor((now - (dictation.startedAt ?? now)) / 1000))} /> : null}
      {sessionId !== null && (!selected?.writable || selected.state !== 'ready') ? <View style={{ marginHorizontal: 12, marginBottom: typing ? 8 : bottom, gap: 8 }}>
        <T s={15} c={K.inkTertiary} style={{ padding: 14, borderRadius: 24, backgroundColor: K.field, boxShadow: K.shadowField }}>Se responde desde {selected?.originLabel ?? 'el canal de origen'}</T>
        <Keycap variant="primary" disabled={running || creating || snap.reachable === false || chatOff} onPress={() => { void createConversation().catch(() => {}); }} label={creating ? 'Creando conversación…' : 'Conversación nueva'} />
      </View> : <ChatComposer dictationActive={dictation.listening} attachmentControl={images.control} attachmentPreview={images.preview || serverFiles.preview ? <>{images.preview}{serverFiles.preview}</> : undefined} dictationControl={dictationControl}
        disabled={panelOpen || modelOpen || chatOff || paused || !info.data || !!info.error || transcriptLoading || creating || snap.reachable === false || !!transportError || offlineTurn}
        busy={running} stopping={stopping} steering={steering} stopBlocked={running && turnStartedAt === null}
        workingLabel={turnStartedAt === null ? 'ENVIANDO…' : `${(agent?.name ?? agentId).toUpperCase()} TRABAJANDO · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}
        hasAttachment={images.hasAttachment || serverFiles.hasAttachment} sendBlocked={images.preparing || dictation.listening || panelOpen || modelOpen || transcriptLoading || creating || (running && turnStartedAt === null)} draft={draft} onDraftChange={changeDraft} onSend={() => { void send(); }}
        onStop={stop} onSteer={steer} placeholder={paused ? 'El chat no acepta mensajes en pausa' : chatOff ? `Chat desactivado en ${server?.name ?? 'este Servidor'}` : offlineTurn ? `Sin conexión con ${server?.name ?? 'este Servidor'}` : running && turnStartedAt !== null ? 'Redirigir sin detener…' : `Mensaje a ${agent?.name ?? agentId}…`} bottom={bottom} typing={typing} />}
      </View>
      {panelOpen ? <ConversationPanel key={`${serverId}:${agentId}:${demoScenario}`} client={client} agentId={agentId} agentName={agent?.name ?? agentId} serverName={server?.name ?? 'este Servidor'} selectedId={selected?.id ?? null} busy={running || creating} offline={snap.reachable === false} bottom={typing ? 8 : bottom} onClose={() => setPanelOpen(false)} onSelect={selectConversation} onNew={createConversation}
        onWorkingChange={setPanelWorking}
        demoControl={DEMO ? <Pressable accessibilityRole="button" disabled={running || creating} onPress={() => {
          const index = DEMO_CONVERSATION_SCENARIOS.findIndex((scenario) => scenario.id === demoScenario);
          const next = DEMO_CONVERSATION_SCENARIOS[(index + 1) % DEMO_CONVERSATION_SCENARIOS.length];
          setDemoConversationScenario(serverId, next.id); setDemoScenario(next.id);
          const epoch = ++requestEpoch.current;
          selectedRef.current = null; loadedSession.current = null; setSelected(null); setSessionId(null); setItems([]); setDraft(''); setTranscriptLoading(true);
          setTranscriptRequest({ client, agentId, epoch });
        }} style={{ minHeight: 40, justifyContent: 'center' }}><T s={12} w="600" c={K.accentText}>Demostración: {DEMO_CONVERSATION_SCENARIOS.find((scenario) => scenario.id === demoScenario)?.name} · Cambiar</T></Pressable> : null}
        onRename={(conversation) => { if (selectedRef.current?.id === conversation.id) { selectedRef.current = conversation; setSelected(conversation); } }}
        onDelete={(id) => {
          drafts.current.delete(id);
          if (selectedRef.current?.id !== id) return;
          const epoch = ++requestEpoch.current;
          selectedRef.current = null; loadedSession.current = null; setSelected(null); setSessionId(null); setItems([]); setDraft(drafts.current.get('@new') ?? ''); setTranscriptLoading(true);
          setTranscriptRequest({ client, agentId, epoch });
        }}
        onRetryConnection={() => { setRetry((n) => n + 1); info.reload(); refresh(serverId); }}
        onPair={() => router.push({ pathname: '/connect', params: { serverId } })} /> : null}
      {dropLit ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <M s={13} w="600" ls={0.08} c={K.accentText}>SUELTA PARA ADJUNTAR</M>
        <M s={9.5} c={K.inkSecondary} numberOfLines={1}>{dragging?.name}</M>
      </View> : null}
      </View>
      {wide ? <View style={{ paddingRight: 12, paddingBottom: typing ? 8 : bottom }}>
        {filesShown ? <ChatFilesPanel serverId={serverId} serverName={server?.name ?? 'este Servidor'} onClose={() => setFilesOpen(false)} drag={fileDrag} />
          : <TurnActivityPanel block={lastActivity?.kind === 'activity' ? lastActivity : null} now={now} onWaitingPress={openWaiting} onReview={myPending[0] ? openWaiting : undefined} />}
      </View> : null}
      </View>
      {DEMO ? <Pressable accessibilityRole="button" accessibilityLabel="Cambiar escenario del Turno" onPress={() => {
        const index = DEMO_TURN_SCENARIOS.findIndex((scenario) => scenario.id === turnScenario);
        const next = DEMO_TURN_SCENARIOS[(index + 1) % DEMO_TURN_SCENARIOS.length];
        setDemoTurnScenario(serverId, next.id); setDemoConversationScenario(serverId, 'populated'); onDemoChange();
      }} style={{ minHeight: 40, paddingHorizontal: 18, justifyContent: 'center' }}>
        <T s={12} w="600" c={K.accentText}>Turno demo: {DEMO_TURN_SCENARIOS.find((scenario) => scenario.id === turnScenario)?.name} · Cambiar</T>
      </Pressable> : null}
      {DEMO ? <Pressable accessibilityRole="button" accessibilityLabel="Cambiar escenario de dictado" onPress={() => {
        dictation.cancel(); const index = DEMO_DICTATION_SCENARIOS.findIndex((scenario) => scenario.id === dictationScenario);
        const next = DEMO_DICTATION_SCENARIOS[(index + 1) % DEMO_DICTATION_SCENARIOS.length];
        setDemoDictationScenario(serverId, next.id); setDictationScenario(next.id); onDemoChange();
      }} style={{ minHeight: 40, paddingHorizontal: 18, justifyContent: 'center' }}><T s={12} w="600" c={K.accentText}>Dictado demo: {DEMO_DICTATION_SCENARIOS.find((scenario) => scenario.id === dictationScenario)?.name} · Cambiar</T></Pressable> : null}
      <HomeIndicator />
      </View>
      {images.overlay}
      <Sheet visible={actionsOpen} onClose={() => setActionsOpen(false)} title="Conversación" subtitle={`${(agent?.name ?? agentId).toUpperCase()} · ${(server?.name ?? '').toUpperCase()}`}>
        <View style={{ gap: 8 }}>
          <Keycap label="Conversaciones" disabled={panelWorking || creating} onPress={() => { setActionsOpen(false); setModelOpen(false); setPanelOpen(true); }} />
          <Keycap label="Modelo de esta Conversación" disabled={modelDisabled} onPress={() => { setActionsOpen(false); setModelOpen(true); }} />
          <Keycap label="Ficha del Agente" onPress={() => { setActionsOpen(false); router.push({ pathname: '/agent/[server]/[agent]', params: { server: serverId, agent: agentId } }); }} />
        </View>
      </Sheet>
      {modelOpen && selected ? <ConversationModelSheet key={modelScenario} demoControl={DEMO ? <Pressable accessibilityRole="button" accessibilityLabel="Cambiar escenario de modelos" onPress={() => {
        const index = DEMO_MODEL_SCENARIOS.findIndex((scenario) => scenario.id === modelScenario);
        const next = DEMO_MODEL_SCENARIOS[(index + 1) % DEMO_MODEL_SCENARIOS.length];
        setDemoModelScenario(serverId, next.id); setModelScenario(next.id);
      }} style={{ minHeight: 40, justifyContent: 'center' }}><T s={12} w="600" c={K.accentText}>Modelos demo: {DEMO_MODEL_SCENARIOS.find((scenario) => scenario.id === modelScenario)?.name} · Cambiar</T></Pressable> : null} client={client} agentId={agentId} contextKey={serverId} conversation={selected} busy={running}
        onClose={() => setModelOpen(false)} onApplied={(conversation) => {
          if (selectedRef.current?.id !== conversation.id) return;
          modelRevision.current++;
          selectedRef.current = conversation; setSelected(conversation); setModelOpen(false);
        }} /> : null}
      </View>
    </KeyboardAvoidingView>
  );
}
