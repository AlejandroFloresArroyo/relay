import { THEME_READ_ERROR, THEME_WRITE_ERROR } from './theme.ts';
import { createDemoPresets, resetDemoPresets } from './demoPresets.ts';
export { SHARE_DEMOS, demoSharePayload } from './demoShare.ts';
import { createDemoActivity, resetDemoActivity } from './demoActivity.ts';
import { createDemoKanbanClient, resetDemoWork } from './demoKanban.ts';
import { createDemoAppUpdate, resetDemoAppUpdate } from './demoAppUpdate.ts';
import { demoUsage, resetDemoUsage } from './serverUsageDemo.ts';
import { createDemoBoardWeb } from './demoBoardWeb.ts';
import { demoBoardPage } from './demoBoard.ts';
import { createDemoServerControl, resetDemoServerControl } from './demoServerControl.ts';
import type { AgentTools, AgentSkills } from '../../../protocol/agentTools.ts';
import { createDemoMemory } from './demoMemory.ts';
import { createDemoScheduledJobs } from './demoScheduledJobs.ts';
// Demo fixtures: the exact content of the six prototype screens, served through the same
// RelayClient interface the real bridge uses. Timestamps are relative to "now" so labels like
// "ahora" / "ayer" / "EXPIRA 4:32" stay true whenever the demo is opened.

import type {
  Agent,
  Approval,
  DecisionRecord,
  DoctorCheck,
  GatewayStatus,
  Job,
  LogLine,
  LogLevel,
} from '../../../protocol/protocol.ts';
import { createDemoAgentDetails, resetDemoAgentDetails } from './demoAgentDetails.ts';
import { demoDecisionScenario, demoDecisionDelay, setDemoDecisionScenario } from './demoDecisions.ts';
import { RelayError, unavailableChat, type RelayClient } from './client.ts';
import { demoConnectionError, demoConnectionHealth } from './demoConnection.ts';
import { demoApprovalDecision, demoExpiredTranscript } from './demoApproval.ts';
import { createDemoConversations, resetDemoConversations } from './demoConversations.ts';
import { createDemoTurns, resetDemoTurns } from './demoTurns.ts';
import { createDemoModels, resetDemoModels } from './demoModels.ts';
import { createDemoImages, resetDemoImages } from './demoImages.ts';
import { createDemoFiles, resetDemoFiles } from './demoFiles.ts';
import { createDemoDictation, resetDemoDictation } from './demoDictation.ts';
import { applyRunEvent, type ChatItem } from './transcript.ts';

export { DEMO_PRESET_SCENARIOS, demoPresetScenario, setDemoPresetScenario } from './demoPresets.ts';
export { DEMO_TABLET_WINDOWS } from './demoTablet.ts';

export { DEMO_DECISION_SCENARIOS, demoDecisionScenario, setDemoDecisionScenario } from './demoDecisions.ts';
export { DEMO_ACTIVITY_SCENARIOS, demoActivityScenario, setDemoActivityScenario } from './demoActivity.ts';
export { demoBoardWebBundle, demoBoardWebPreview } from './demoBoardWeb.ts';
export { demoBoardPage, BOARD_DEMO_SCENARIOS } from './demoBoard.ts';
export { DEMO_SERVER_CONTROL_SCENARIOS, demoServerControlScenario, setDemoServerControlScenario } from './demoServerControl.ts';
export { DEMO_CONNECTION_SCENARIOS, demoConnectionScenario, setDemoConnection, demoVpnAvailability } from './demoConnection.ts';
export { demoApprovalDecision, demoExpiredTranscript } from './demoApproval.ts';
export { DEMO_MODEL_SCENARIOS, demoModelScenario, setDemoModelScenario } from './demoModels.ts';
export { DEMO_CONVERSATION_SCENARIOS, demoConversationScenario, setDemoConversationScenario } from './demoConversations.ts';

export interface DemoServer {
  id: string;
  name: string;
  url: string;
  isDefault: boolean;
  deviceId?: string;
}

export { DEMO_USAGE_SCENARIOS, demoUsageScenario, setDemoUsage } from './serverUsageDemo.ts';
export { DEMO_JOB_SCENARIOS, setDemoJobScenario } from './demoScheduledJobs.ts';

export const DEMO_SERVERS: DemoServer[] = [
  { id: 'atlas', name: 'atlas', url: 'http://atlas.tailnet-7f2c.ts.net:8650', deviceId: 'demo-atlas-device', isDefault: true },
  { id: 'homelab', name: 'homelab', url: 'http://nas.tailnet-7f2c.ts.net:8650', deviceId: 'demo-homelab-device', isDefault: false },
];

export const DEMO_KEY = 'demo-0000000000000000000000003f9a';
export const DEMO_LOCK_NOTICE = { seconds: 8, minutes: 1 };

const MIN = 60_000;
const HOUR = 60 * MIN;

function at(now: number, h: number, m: number, dayOffset = 0): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m).getTime();
}

const APPROVAL_ID = 'ap-demo-1';
/** research's Aprobación: no «Para la sesión», and it lapses 50 s in to show VENCIDA. */
const SHORT_APPROVAL_ID = 'ap-demo-2';

function transcriptDev(now: number, decision: 'pending' | 'ok' | 'no'): ChatItem[] {
  const t = now - 2 * MIN;
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: 'Los tests de integración fallan desde el merge de ayer. ¿Lo revisas y lo arreglas?', at: t },
    { kind: 'assistant', id: 'a1', text: 'Reproduzco el fallo primero.', at: t + 1000 },
    { kind: 'tool', id: 't1', tool: 'read_file', preview: 'vitest.config.ts', status: 'done', durationSeconds: 0.1, result: null, at: t + 2000 },
    {
      kind: 'tool',
      id: 't2',
      tool: 'terminal',
      preview: 'npm test -- integration',
      status: 'done',
      durationSeconds: 14.3,
      result: JSON.stringify({
        output: 'FAIL src/db/client.test.ts\nTypeError: createPool is not a fn\n1 failed · 23 passed',
        exit_code: 1,
      }),
      cwd: '/srv/app/web',
      at: t + 3000,
    },
    { kind: 'tool', id: 't3', tool: 'web_search', preview: 'vi.mock hoisting', status: 'done', durationSeconds: 2.1, result: null, at: t + 18_000 },
    { kind: 'assistant', id: 'a2', text: 'La factory de `vi.mock` se eleva sobre el import. Lo corrijo con `vi.hoisted`:', at: t + 21_000 },
    {
      kind: 'tool',
      id: 't4',
      tool: 'patch',
      preview: 'src/db/client.test.ts',
      status: 'done',
      durationSeconds: 0.5,
      result: '- const pool = { query: vi.fn() }\n+ const { pool } = vi.hoisted(() => ({\n+   pool: { query: vi.fn() } }))',
      at: t + 22_000,
    },
    { kind: 'assistant', id: 'a3', text: 'Limpio el build y vuelvo a correr la suite', at: t + 23_000 },
    {
      kind: 'tool',
      id: 't5',
      tool: 'terminal',
      preview: 'rm -rf ./build',
      status: 'running',
      durationSeconds: decision === 'ok' ? 0.2 : null,
      result: null,
      cwd: '/srv/app/web',
      // The step waiting for its Decisión started 17 s ago: the CARGA needle reads it (F-2).
      at: now - 17_000,
    },
  ];
  const waiting = applyRunEvent(items, { type: 'approval.request', approval: { id: APPROVAL_ID } as Approval }, t + 24_000);
  if (decision === 'pending') return waiting;
  const resolved = applyRunEvent(waiting, demoApprovalDecision(APPROVAL_ID, decision === 'ok' ? 'once' : 'deny'), now);
  return decision === 'ok' ? resolved.map((it) => it.kind === 'tool' && it.id === 't5' ? { ...it, status: 'done' } : it) : resolved;
}

const DOCTOR: DoctorCheck[] = [
  { label: 'Python', value: '3.11.9', ok: true },
  { label: 'Config', value: '~/.hermes/config.yaml', ok: true },
  { label: 'API server', value: ':8642', ok: true },
  { label: 'Proveedor de modelo', value: 'openrouter', ok: true },
  { label: 'Servidores MCP', value: '3/3', ok: true },
  { label: 'Disco /srv', value: '82 %', ok: false },
];

const LOG_SEVERITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const LOGS: LogLine[] = [
  { t: '09:40:58', level: 'INFO', msg: 'gateway: session dev#a81 resumed' },
  { t: '09:41:01', level: 'INFO', msg: 'tool terminal: npm test -- integration' },
  { t: '09:41:15', level: 'WARN', msg: 'terminal exit=1 (14.3s)' },
  { t: '09:41:16', level: 'INFO', msg: 'tool web_search: "vitest vi.mock hoisting"' },
  { t: '09:41:18', level: 'INFO', msg: 'tool patch: src/db/client.test.ts +2 −1' },
  { t: '09:41:19', level: 'WARN', msg: 'approval required: rm -rf ./build' },
  { t: '09:41:19', level: 'INFO', msg: 'push → relay device iphone-dev' },
  { t: '09:41:20', level: 'ERROR', msg: 'homelab: connect ETIMEDOUT 100.71.3.9:8642' },
  { t: '09:41:22', level: 'INFO', msg: 'research: idle, memory flushed (12 items)' },
  { t: '09:41:30', level: 'WARN', msg: 'disk /srv 82% used' },
  { t: '09:41:31', level: 'INFO', msg: 'api: GET /v1/profiles 200 4ms' },
  { t: '09:41:33', level: 'INFO', msg: 'api: GET /v1/approvals 200 3ms' },
];

// One mutable world shared by every demo client so a decision taken in the sheet shows up in
// the agents list, the inbox and the chat alike.
interface World {
  startedAt: number;
  decision: 'pending' | 'ok' | 'no';
  shortDecided: boolean;
  gatewayUp: boolean;
  gatewaySince: number;
}

let world: World | null = null;
function getWorld(now: number): World {
  world ??= { startedAt: now, decision: 'pending', shortDecided: false, gatewayUp: true, gatewaySince: now - (6 * 24 * HOUR + 4 * HOUR + 12 * MIN) };
  return world;
}
export function resetDemo() {
  resetDemoPresets();
  resetDemoActivity();
  resetDemoWork();
  setDemoDecisionScenario('mixed');
  discoveryState = 'normal'; logState = 'normal'; metricsState = 'reading';
  world = null;
  resetDemoServerControl();
  resetDemoConversations();
  resetDemoTurns();
  resetDemoModels();
  resetDemoImages();
  resetDemoFiles();
  resetDemoDictation();
  resetDemoAgentDetails();
  resetDemoUsage();
  resetDemoAppUpdate();
}

function demoApproval(w: World): Approval {
  return {
    id: APPROVAL_ID,
    runId: 'run-demo-1',
    agentId: 'dev',
    agentName: 'dev',
    command: 'rm -rf ./build',
    cwd: '/srv/app/web',
    reason: 'Limpiar artefactos cacheados antes de re-ejecutar los tests',
    affects: './build · 1 284 archivos · 48 MB',
    risk: {
      level: 3,
      label: 'RIESGO MEDIO',
      summary: 'Borrado recursivo e irreversible, limitado a la carpeta del proyecto. No toca archivos fuera del repo.',
    },
    createdAt: w.startedAt - 28_000,
    expiresAt: w.startedAt + 272_000, // EXPIRA 4:32 when the demo opens
    choices: ['once', 'session', 'always', 'deny'],
  };
}

function demoShortApproval(w: World): Approval {
  return {
    id: SHORT_APPROVAL_ID,
    runId: 'run-demo-2',
    agentId: 'research',
    agentName: 'research',
    command: 'git push --force origin main',
    cwd: '/srv/papers',
    reason: 'Publicar el resumen corregido sobre la versión anterior',
    affects: 'rama main · 3 commits',
    risk: { level: 4, label: 'RIESGO ALTO', summary: 'Reescribe la historia de main en el remoto; los otros clones quedan desfasados.' },
    createdAt: w.startedAt - 250_000,
    expiresAt: w.startedAt + 50_000,
    choices: ['once', 'deny'],
  };
}

export function createDemoClient(serverId: string, now: () => number = Date.now): RelayClient {
  const guard = async <T>(fn: () => T): Promise<T> => {
    const error = demoConnectionError(serverId);
    if (error) throw error;
    return fn();
  };
  const w = () => getWorld(now());

  const gateway = (): GatewayStatus =>
    w().gatewayUp
      ? { state: 'active', pid: 2291, uptimeSeconds: Math.floor((now() - w().gatewaySince) / 1000), port: 8642 }
      : { state: 'stopped', pid: null, uptimeSeconds: null, port: null };
  const conversations = createDemoConversations(serverId, now, (agentId) => agentId === 'dev' ? transcriptDev(now(), w().decision) : agentId === 'research' ? demoExpiredTranscript(now()) : []);
  const turns = createDemoTurns(serverId, now, conversations);
  const details = createDemoAgentDetails(serverId, now, conversations.conversations, createDemoImages(serverId, now, turns.startRun).startRun ?? turns.startRun);
  const toolsByAgent = new Map<string, AgentTools>();
  const toolState = (agentId: string) => { let value = toolsByAgent.get(agentId); if (!value) { value = demoAgentTools(now()); toolsByAgent.set(agentId, value); } return value; };

  const control = createDemoServerControl(serverId, {
      ...turns, ...createDemoImages(serverId, now, turns.startRun), startRun: details.startRun ?? turns.startRun,
      gateway: () => guard(gateway),
      gatewayAction: (action) => guard(() => {
        w().gatewayUp = action !== 'stop';
        if (action !== 'stop') w().gatewaySince = now();
        return gateway();
      }),
    });

  return {
    activity: createDemoActivity(serverId, now),
    kanban: createDemoKanbanClient(serverId,['dev','research'],now(),async(agent,requestId,input)=>{
      if((await control.serverControl()).paused)throw new RelayError('server_paused','Pausa general.');
      const conversation=await conversations.createConversation(agent,{requestId});
      if((await control.serverControl()).paused)throw new RelayError('server_paused','Pausa general.');
      const run=await control.startRun(agent,{input,sessionId:conversation.sessionId});
      return {conversationId:conversation.id,runId:run.runId};
    }),
    ...createDemoAppUpdate(serverId),
    agentTools: (agentId) => guard(() => {
      const scenario = toolsScenario(serverId, agentId);
      if (scenario === 'unavailable') throw new RelayError('agent_tools_unavailable', 'No se pudieron leer las herramientas o skills del Agente. Reintenta.');
      return { ...toolState(agentId), observedAt: now(), ...(scenario === 'empty' ? { toolsets: [] } : {}) };
    }),
    agentSkills: (agentId) => guard(() => {
      const scenario = toolsScenario(serverId, agentId);
      if (scenario === 'unavailable' || scenario === 'skills-unavailable') throw new RelayError('agent_tools_unavailable', 'No se pudieron leer las herramientas o skills del Agente. Reintenta.');
      return { ...demoAgentSkills(now()), limited: scenario === 'partial', ...(scenario === 'empty' ? { skills: [] } : {}) };
    }),
    setToolset: (agentId, name, enabled) => guard(() => {
      const current = toolState(agentId);
      const tool = current.toolsets.find((entry) => entry.name === name);
      if (!tool || (enabled && !tool.configured)) throw new RelayError('unavailable', 'Configura la herramienta en el Servidor.');
      const updated = { ...current, observedAt: now(), toolsets: current.toolsets.map((entry) => entry.name === name ? { ...entry, enabled } : entry) };
      toolsByAgent.set(agentId, updated); return updated;
    }),
    ...createDemoMemory(serverId, now),
    ...createDemoPresets(serverId, now, createDemoMemory(serverId, now)),
    ...createDemoScheduledJobs(serverId),
    health: async () => demoConnectionHealth(serverId),
    whoami: () => guard(() => ({ tailscale: true, device: 'iphone-dev', ip: '100.84.12.7', tailnet: 'tailnet-7f2c' })),
    server: () => guard(() => ({ host: 'atlas', hermesVersion: '0.9.2', profiles: 2, chat: { available: true, reason: null } })),
    boardWeb: createDemoBoardWeb(),
    board: async () => demoBoardPage(Date.now()),
    agents: () =>
      guard((): Agent[] => {
        const pending = w().decision === 'pending';
        return [
          {
            id: 'dev',
            name: 'dev',
            model: 'qwen3-coder-480b',
            provider: 'openrouter',
            status: pending ? 'busy' : 'on',
            pendingApprovals: pending ? 1 : 0,
            lastMessage: {
              text: pending ? 'Esperando aprobación para limpiar ./build…' : w().decision === 'ok' ? 'Build limpio, suite en verde.' : 'Comando rechazado; espero instrucciones.',
              at: now(),
            },
          },
          {
            id: 'research',
            name: 'research',
            model: 'claude-sonnet-4.5',
            provider: 'anthropic',
            // Working on a Turno: orange lights in Agentes, and its Conversación writes (voice box).
            status: 'busy',
            pendingApprovals: 0,
            lastMessage: { text: 'Resumen listo: 12 papers sobre KV-cache', at: earlierToday(now()) },
          },
        ];
      }),
    conversationFiles: unavailableChat,
    downloadConversationFile: unavailableChat,
    decisions: async (query = {}) => {
      await demoDecisionDelay();
      return guard(() => ({ decisions: demoDecisionScenario() === 'empty' || demoDecisionScenario() === 'uncertain' ? []:demoDecisions(serverId,now(),w().decision).filter(record => (!query.agentId || record.agentId === query.agentId) && (!query.origin || record.origin === query.origin)),capturedAt:now(),
        uncertain:demoDecisionScenario() === 'uncertain' ? [{id:`${serverId}:uncertain`,agentId:'dev',agentName:'dev',command:'git push origin dev',choice:'once' as const,at:now(),origin:'relay' as const}]:[] }));
    },
    serverClockOffsetMs: () => 0,
    approvals: () => guard(() => demoDecisionScenario() !== 'mixed' ? [] : [
      ...(w().decision === 'pending' ? [demoApproval(w())] : []),
      ...(!w().shortDecided && now() < demoShortApproval(w()).expiresAt! ? [demoShortApproval(w())] : []),
    ]),
    decide: (id, choice) =>
      guard(() => {
        if (id === SHORT_APPROVAL_ID) w().shortDecided = true;
        else w().decision = choice === 'deny' ? 'no' : 'ok';
      }),
    doctor: () => guard(() => ({ ranAt: now(), checks: DOCTOR })),
    discovery: () => guard(() => {
      if (discoveryState === 'error') throw new Error('Demo unavailable');
      return { bridges: discoveryState === 'vacío' ? [] : [{ name: 'nas-garage', url: 'http://nas-garage.demo.ts.net:17651', protocolVersion: discoveryState === 'incompatible' ? 1 : 2, minAppProtocolVersion: 1 }], truncated: false };
    }),
    // atlas advertises `metrics` (demoConnectionHealth); CPU changes every 5 s so its needle moves.
    metrics: () => guard(() => {
      if (metricsState === 'failure') throw new RelayError('unavailable', 'Lectura de demostración fallida.');
      return { cpuPercent: [61, 57, 66, 59][Math.floor(now() / 5000) % 4], memoryPercent: 31, diskPercent: 82, measuredAt: now() };
    }),
    logs: (level, _lines, agentId) => guard(() => {
      if (logState === 'error') throw new Error('Demo unavailable');
      return logState === 'vacío' ? [] : LOGS.filter(l => LOG_SEVERITY[l.level] >= LOG_SEVERITY[level ?? 'INFO']).map(l => ({ ...l, msg: agentId ? `${agentId}: ${l.msg}` : l.msg }));
    }),
    model: () => guard(() => ({ model: 'qwen3-coder-480b', provider: 'OpenRouter' })),
    usage: (period) => demoUsage(serverId,period),
    jobs: () =>
      guard((): Job[] => [
        { id: 'j1', name: 'Resumen diario de PRs', cron: '0 9 * * 1-5', agent: 'dev', nextRunAt: at(now(), 9, 0, 1), enabled: true },
        { id: 'j2', name: 'Backup de memoria', cron: '0 3 * * *', agent: 'ops', nextRunAt: null, enabled: false },
        { id: 'j3', name: 'Auditoría de dependencias', cron: '0 10 * * 1', agent: 'dev', nextRunAt: nextWeekday(now(), 1, 10), enabled: true },
      ]),
    // BEGIN CONVERSATIONS (#36)
    ...conversations,
    // END CONVERSATIONS
    // BEGIN TURN (#37)
    ...turns,
    // END TURN
    // BEGIN MODEL (#38)
    ...createDemoModels(serverId, now),
    // END MODEL
    // BEGIN IMAGES (#39)
    ...createDemoImages(serverId, now, turns.startRun),
    // END IMAGES
    // BEGIN FILES (#40)
    ...createDemoFiles(serverId, now, { ...conversations, ...turns }),
    // END FILES
    // BEGIN DICTATION (#41): local simulated native scenarios; no automatic sends.
    ...createDemoDictation(serverId, now),
    // END DICTATION
    ...details,
    ...control,
  };
}

/** "14:02" in the prototype: a few hours ago, but never before midnight so the row shows a time. */
function earlierToday(now: number): number {
  return Math.max(at(now, 0, 1), now - 3 * HOUR - 39 * MIN);
}

function nextWeekday(now: number, weekday: number, hour: number): number {
  const d = new Date(now);
  let delta = (weekday - d.getDay() + 7) % 7;
  if (delta < 2) delta += 7; // keep it a named day ("LUN 10:00"), not HOY/MAÑ
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta, hour, 0).getTime();
}

export const DEMO_AGENT_TOOLS_SCENARIOS = ['normal', 'empty', 'partial', 'skills-unavailable', 'unavailable'] as const;
export type DemoAgentToolsScenario = typeof DEMO_AGENT_TOOLS_SCENARIOS[number];
const toolsScenarios = new Map<string, DemoAgentToolsScenario>();
export function setDemoAgentToolsScenario(serverId: string, agentId: string, scenario: DemoAgentToolsScenario) {
  toolsScenarios.set(JSON.stringify([serverId, agentId]), scenario);
}
function toolsScenario(serverId: string, agentId: string) { return toolsScenarios.get(JSON.stringify([serverId, agentId])) ?? 'normal'; }

/** #45 fixtures mirror installed metadata; availability is deliberately unknown. */
export function demoAgentTools(now: number): AgentTools {
  return { platform: 'api_server', observedAt: now, appliesTo: 'next_turn', toolsets: [
    { name: 'terminal', label: 'Terminal', description: 'Ejecuta comandos en el Servidor.', enabled: true, configured: true, tools: ['terminal'] },
    { name: 'file', label: 'Archivos', description: 'Lee y edita archivos.', enabled: true, configured: true, tools: ['read_file', 'write_file'] },
    { name: 'web', label: 'Web', description: 'Busca información en la web.', enabled: true, configured: true, tools: ['web_search'] },
    { name: 'browser', label: 'Navegador', description: 'Opera un navegador.', enabled: false, configured: false, tools: ['browser_navigate'] },
  ] };
}
export function demoAgentSkills(now: number): AgentSkills {
  return { observedAt: now, scope: 'profile_installed', limited: false, skills: [
    { name: 'revisar-pr', description: 'Revisa un PR y deja comentarios en línea', category: 'desarrollo', availability: 'unknown' },
    { name: 'resumen-diario', description: 'Resume la actividad del repo de las últimas 24 h', category: 'informes', availability: 'unknown' },
    { name: 'migraciones-db', description: 'Genera y valida migraciones de Knex', category: 'base de datos', availability: 'unknown' },
    { name: 'buscar-papers', description: 'Busca y resume artículos científicos', category: 'investigación', availability: 'disabled' },
  ] };
}

/** What the unreachable demo server remembers from its last contact (screen 02, HOMELAB block). */
export function demoOffline(serverId: string, now: number): { agents: Agent[]; lastContactAt: number } | null {
  if (serverId !== 'homelab') return null;
  return {
    lastContactAt: now - 9 * HOUR - 5 * MIN,
    agents: [
      {
        id: 'ops',
        name: 'ops',
        model: 'llama-3.3-70b · local',
        provider: 'local',
        status: 'off',
        pendingApprovals: 0,
        lastMessage: { text: 'Backup nocturno completado (3.2 GB)', at: at(now, 3, 0, -1) },
      },
    ],
  };
}

export { DEMO_PAIRING_STATES, DEMO_PAIRING_RESPONSE, demoPairingFetch } from './demoPairing.ts';

/** Every history actor/state is inspectable without a Servidor; network states use demoConnection. */
export function demoDecisions(serverId: string, now: number, decision: 'pending'|'ok'|'no' = 'pending'): DecisionRecord[] {
  const base: DecisionRecord = { id:'demo-guardian',agentId:'dev',agentName:'dev',sessionId:'demo-history',runId:null,approvalId:null,toolCallId:'demo-call',command:'rm -rf ./dist',actor:'guardian',outcome:'approved',choice:null,at:now-60000,timeKind:'result',origin:'other',source:'discord',originLabel:'Discord' };
  const records: DecisionRecord[] = [base,{...base,id:'demo-person',command:'git push origin fix/pool-mock',actor:'person',choice:'once',origin:'relay',originLabel:'Relay',timeKind:'decision',at:now-120000},
    {...base,id:'demo-expired',agentId:'research',agentName:'research',command:'docker system prune -af',actor:'expired',outcome:'expired',choice:'deny',origin:'relay',originLabel:'Relay',timeKind:'decision',at:now-3600000},
    {...base,id:'demo-rejected',command:'DROP TABLE sessions_old',actor:'person',outcome:'rejected',choice:'deny',origin:'relay',originLabel:'Relay',timeKind:'decision',at:now-7200000},
    {...base,id:'demo-unknown',command:'echo canal externo',actor:'unknown',outcome:'executed',at:now-10800000}];
  if (decision !== 'pending') records.unshift({...base,id:'demo-current',command:'rm -rf ./build',actor:'person',outcome:decision === 'ok' ? 'approved':'rejected',choice:decision === 'ok' ? 'once':'deny',origin:'relay',originLabel:'Relay',timeKind:'decision',at:now});
  if (demoDecisionScenario() === 'limited') return Array.from({length:180},(_,i) => ({...records[i % records.length],id:`${serverId}:limited-${i}`,at:now-i*1000,command:'echo vista previa sintética '+ 'x'.repeat(1200)}));
  return records.map(record=>({...record,id:`${serverId}:${record.id}`}));
}
export const DEMO_DISCOVERY_STATES = ['normal', 'vacío', 'error', 'incompatible'] as const;
let discoveryState: string = 'normal';
export function setDemoDiscovery(state: string) { discoveryState = state; }
export const DEMO_LOG_STATES = ['normal', 'vacío', 'error'] as const;
let logState: string = 'normal';
export function setDemoLogs(state: string) { logState = state; }
export const DEMO_METRICS_STATES = [{ id: 'reading', name: 'Lectura' }, { id: 'failure', name: 'Lectura fallida' }] as const;
type DemoMetricsState = typeof DEMO_METRICS_STATES[number]['id'];
let metricsState: DemoMetricsState = 'reading';
export function demoMetricsState() { return metricsState; }
export function setDemoMetricsState(state: DemoMetricsState) { metricsState = state; }
export { DEMO_MEMORY_SCENARIOS, demoMemoryScenario, setDemoMemoryScenario } from './demoMemory.ts';

export { THEME_OPTIONS as DEMO_THEME_SCENARIOS } from './theme.ts';

export const DEMO_THEME_NOTICES = [
  { label: 'Ver aviso de lectura del tema', message: THEME_READ_ERROR },
  { label: 'Ver aviso de guardado del tema', message: THEME_WRITE_ERROR },
] as const;

export { DEMO_WIDGET_STATES, demoWidget } from './demoWidget.ts';
export { NOTIFICATION_DEMO_STATES, NOTIFICATION_SETTINGS_DEMO_STATES, notificationDemoNotice, notificationDemoStatus } from './notificationDemo.ts';
