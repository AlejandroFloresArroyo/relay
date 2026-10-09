import { readServerUsage } from './serverUsage.ts';
import type { UsagePeriod } from '../../protocol/serverUsage.ts';
import { createBoardWebReader } from './boardWebReader.ts';
import { createBoardReader } from './board.ts';
import { readLogTail } from './logTail.ts';
import { createHermesServerControl } from './hermesServerControl.ts';
import { createHermesAgentTools } from './hermesAgentTools.ts';
import type { HermesAgentTools } from './agentToolsPort.ts';
import { createAgentMemory } from './agentMemory.ts';
import { HermesJobs } from './hermesJobs.ts';
import type { HermesMedia, PreparedRunRequest } from './chatPorts.ts';
import { AgentConfig } from './agentConfig.ts';
import { readAgentUsage } from './agentUsage.ts';
import type { HermesAgentDetails } from './agentDetailsPorts.ts';
import { hermesRunBody } from './chatImages.ts';
// Hermes as it exists on disk and on the wire (verified against v0.21.5).
//
// Where each piece of information comes from, and why:
//
//   profiles, model      files   <home>/config.yaml and <home>/profiles/<name>/config.yaml
//   gateway status       files   <home>/gateway_state.json + /proc/<pid>/stat (same liveness proof Hermes uses)
//   logs                 files   <home>/logs/agent.log
//   jobs                 files   <profile home>/cron/jobs.json
//   last message, transcript  files  <profile home>/state.db (SQLite, opened read-only)
//   version, gateway start|stop|restart, doctor   CLI   `hermes ...`
//   runs, approvals      HTTP    the Hermes API server (port 8642), per-profile key from that profile's .env
//
// The dashboard HTTP API (port 9119) is deliberately not used: once it is published through
// `dashboard.public_url` it only accepts a browser login (cookie) and rejects local processes,
// and it is an optional process that may not be running at all. Files and the CLI always exist.

import fs from 'node:fs';
import path from 'node:path';

import type {
  ConversationQuery,
  ConversationSearchQuery,
  ApprovalChoice,
  DoctorCheck,
  GatewayStatus,
  Job,
  LogLevel,
  LogLine,
  ModelInfo,
  RunCreated,
  RunRequest,
} from '../../protocol/protocol.ts';
import type { Exec } from './exec.ts';
import { HermesError, unavailableChatPort } from './hermes.ts';
import type {
  AgentProfile,
  ChatStatus,
  GatewayAction,
  Hermes,
  ProfileState,
  Transcript,
  UpstreamEvent,
  UpstreamRunStatus,
} from './hermes.ts';
import { parseSse } from './sse.ts';
import { parseDotenv } from './util/dotenv.ts';
import { redact } from './util/redact.ts';
import { yamlGet } from './util/yaml.ts';
import { isModelSelection } from './conversationStore.ts';
import { createHermesMedia } from './hermesMedia.ts';
import { HermesConversations } from './hermes_conversations.ts';

export interface RealHermesOptions {
  mediaSource?: string;
  mediaPython?: string;
  home: string;
  bin: string;
  exec: Exec;
  fetch?: typeof fetch;
  procRoot?: string;
  now?: () => number;
  media?: HermesMedia;
  toolsPython?: string;
}

interface ApiTarget {
  origin: string; // http://127.0.0.1:8642
  prefix: string; // "" or "/p/<profile>"
  key: string;
  address: string; // host:port, for messages
  port: number;
}

interface GatewayCore {
  state: GatewayStatus['state'];
  pid: number | null;
  uptimeSeconds: number | null;
  record: Record<string, any> | null;
}

// A bare `hermes gateway ...` acts on the sticky profile in <home>/active_profile, which may be a
// named profile with no gateway of its own (Hermes then refuses with exit 78). The gateway relayd
// reports on is the host one, so lifecycle commands always name the default profile.
const HOST_PROFILE = ['-p', 'default'];
const DEFAULT_API_PORT = 8642;
const MIN_API_KEY_LENGTH = 16; // Hermes refuses to start the API server with a shorter key
const VERSION_CACHE_MS = 10 * 60 * 1000;
const LOG_TAIL_BYTES = 512 * 1024;
const CLOCK_TICKS_PER_SECOND = 100; // USER_HZ, the unit of /proc/<pid>/stat start time on Linux
const SEVERITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const HERMES_LEVELS: Record<string, LogLevel> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARN',
  WARN: 'WARN',
  ERROR: 'ERROR',
  CRITICAL: 'ERROR',
};

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tail(text: string, max = 400): string {
  const trimmed = redact(text.trim());
  return trimmed.length > max ? `...${trimmed.slice(-max)}` : trimmed;
}

export class RealHermes implements Hermes {
  readonly details: HermesAgentDetails;
  readonly boardWeb = createBoardWebReader((profile) => this.profileHome(profile));
  readonly board = createBoardReader((profile) => this.profileHome(profile), () => this.now());
  readonly memory: import('./agentMemory.ts').HermesMemory;
  // BEGIN CONVERSATIONS (#36)
  async listConversations(profile: string, query: ConversationQuery = {}) {
    return new HermesConversations(this.profileHome(profile)).list(query);
  }
  async getConversation(profile: string, id: string) {
    return new HermesConversations(this.profileHome(profile)).get(id);
  }
  async searchConversations(profile: string, query: ConversationSearchQuery) {
    return new HermesConversations(this.profileHome(profile)).search(query);
  }
  async deletionPreview(profile: string, id: string) {
    return new HermesConversations(this.profileHome(profile)).deletionPreview(id);
  }
  async createConversation(profile: string, id: string): Promise<void> {
    // Configuration absence is definitive: no upstream effect has been attempted.
    const target = this.target(profile);
    let response: Response;
    try {
      response = await this.open(profile, 'POST', '/api/sessions', { body: { id, source: 'api_server' }, target });
    } catch (error) {
      if (error instanceof HermesError && error.code === 'conflict') {
        throw new HermesError('operation_uncertain', 'The conversation creation could not be confirmed.');
      }
      if (error instanceof HermesError && error.code === 'unavailable') {
        throw new HermesError('operation_uncertain', 'The conversation creation could not be confirmed.');
      }
      throw new HermesError('upstream_failure', 'Hermes could not create the conversation.');
    }
    let created: unknown;
    try { created = await response.json(); } catch {
      throw new HermesError('operation_uncertain', 'The conversation creation could not be confirmed.');
    }
    if (response.status !== 201 || !created || typeof created !== 'object' || !('session' in created) ||
        !created.session || typeof created.session !== 'object' || !('id' in created.session) ||
        created.session.id !== id) {
      throw new HermesError('operation_uncertain', 'The conversation creation could not be confirmed.');
    }
  }
  async renameConversation(profile: string, sessionId: string, title: string): Promise<void> {
    if (Array.from(title).length > 100) throw new HermesError('invalid_title', 'The conversation title is invalid.');
    try {
      const response = await this.open(profile, 'PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, { body: { title } });
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof HermesError && error.code === 'bad_request') throw new HermesError('invalid_title', 'The conversation title is invalid or already in use.');
      if (error instanceof HermesError && error.code === 'not_found') throw new HermesError('conversation_not_found', 'The conversation was not found.');
      throw new HermesError('upstream_failure', 'Hermes could not rename the conversation.');
    }
  }
  async deleteSession(profile: string, sessionId: string): Promise<void> {
    let response: Response;
    try {
      response = await this.open(profile, 'DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      if (error instanceof HermesError && error.code === 'not_found') throw new HermesError('conversation_not_found', 'The conversation was not found.');
      if (error instanceof HermesError && error.code === 'unavailable') throw new HermesError('operation_uncertain', 'The conversation deletion could not be confirmed.');
      throw new HermesError('upstream_failure', 'Hermes could not delete the conversation.');
    }
    let deleted: unknown;
    try { deleted = await response.json(); } catch {
      throw new HermesError('operation_uncertain', 'The conversation deletion could not be confirmed.');
    }
    if (!deleted || typeof deleted !== 'object' || !('id' in deleted) || deleted.id !== sessionId ||
        !('deleted' in deleted) || deleted.deleted !== true) {
      throw new HermesError('operation_uncertain', 'The conversation deletion could not be confirmed.');
    }
  }
  // END CONVERSATIONS
  // BEGIN MODEL (#38)
  async models(profile: string): Promise<import('../../protocol/protocol.ts').ModelOptions> {
    try {
      const payload: unknown = await (await this.open(profile, 'GET', '/api/model/options')).json();
      if (!payload || typeof payload !== 'object' || !('model' in payload) || !('provider' in payload) || !('providers' in payload)
        || !isModelSelection({ model: payload.model, provider: payload.provider }) || !Array.isArray(payload.providers)) throw new Error('Invalid catalog');
      const models: import('../../protocol/protocol.ts').ModelOption[] = [];
      let defaultProvider = payload.provider as string;
      for (const provider of payload.providers) {
        if (!provider || typeof provider !== 'object' || provider.authenticated !== true) continue;
        if (typeof provider.slug !== 'string' || !Array.isArray(provider.models)) throw new Error('Invalid provider');
        if (provider.slug === payload.provider || Array.isArray(provider.aliases) && provider.aliases.includes(payload.provider)) defaultProvider = provider.slug;
        if (provider.unavailable_models !== undefined && (!Array.isArray(provider.unavailable_models) || !provider.unavailable_models.every((model: unknown) => typeof model === 'string'))) throw new Error('Invalid unavailable models');
        for (const model of provider.models) {
          const selection = { provider: provider.slug, model };
          if (!isModelSelection(selection)) throw new Error('Invalid model');
          if (provider.unavailable_models?.includes(model)) continue;
          if (!models.some((existing) => existing.provider === selection.provider && existing.model === selection.model)) models.push({ ...selection, label: model });
        }
      }
      return { defaultModel: { model: payload.model as string, provider: defaultProvider }, models };
    } catch {
      throw new HermesError('chat_unavailable', 'No se pudo consultar el catálogo de modelos de este Agente. Reintenta.');
    }
  }
  // END MODEL
  async steerRun(profile: string, runId: string, input: string): Promise<void> {
    let response: Response;
    try {
      response = await this.open(profile, 'POST', `/v1/runs/${encodeURIComponent(runId)}/steer`, { body: { input }, steer: true });
    } catch (error) {
      if (error instanceof HermesError && ['run_not_accepting_steer', 'steer_not_accepted', 'invalid_steer_input', 'run_not_found'].includes(error.code)) throw error;
      throw new HermesError('operation_uncertain', 'La redirección quedó sin confirmar. Conserva la misma solicitud.');
    }
    let receipt: unknown;
    try { receipt = await response.json(); } catch {
      throw new HermesError('operation_uncertain', 'La redirección quedó sin confirmar.');
    }
    if (!receipt || typeof receipt !== 'object' || !('run_id' in receipt) || receipt.run_id !== runId
      || !('accepted' in receipt) || receipt.accepted !== true) {
      throw new HermesError('operation_uncertain', 'Hermes no confirmó la redirección.');
    }
  }
  // BEGIN FILES (#40)
  readonly serverControl: import('../../protocol/serverControl.ts').HermesServerControl;
  readonly media: HermesMedia;
  readonly agentTools: HermesAgentTools;
  // END FILES
  readonly jobsManager: HermesJobs;
  private home: string;
  private bin: string;
  private exec: Exec;
  private fetchFn: typeof fetch;
  private procRoot: string;
  private now: () => number;
  private cachedVersion: { value: string; at: number } | null = null;

  constructor(options: RealHermesOptions) {
    const source = options.mediaSource ?? path.join(options.home, 'hermes-agent');
    this.agentTools = createHermesAgentTools({ profileHome: (profile) => this.profileHome(profile),
      toolsets: async (profile) => (await this.open(profile, 'GET', '/v1/toolsets')).json(),
      exec: options.exec, now: options.now,
      python: options.toolsPython ?? options.mediaPython ?? path.join(source, fs.existsSync(path.join(source, 'venv', 'bin', 'python')) ? 'venv' : '.venv', 'bin', 'python') });
    this.memory = createAgentMemory({ home: options.home, source: options.mediaSource, python: options.mediaPython });
    this.media = options.media ?? createHermesMedia({ home: options.home, source: options.mediaSource, python: options.mediaPython, exec: options.exec, transcript: (profile, sessionId) => this.transcript(profile, sessionId) });
    const security = new AgentConfig({ home: options.home, source: options.mediaSource, python: options.mediaPython, exec: options.exec });
    this.details = { security: (profile) => security.security(profile), writeSecurity: (...args) => security.writeSecurity(...args), usage: async (profile, at) => readAgentUsage(this.profileHome(profile), at) };
    this.serverControl = createHermesServerControl(options);
    this.home = options.home;
    this.bin = options.bin;
    this.exec = options.exec;
    this.fetchFn = options.fetch ?? fetch;
    this.procRoot = options.procRoot ?? '/proc';
    this.now = options.now ?? Date.now;
    this.jobsManager = new HermesJobs({
      home: (agent) => this.profileHome(agent),
      timezone: (agent) => {
        const multiplex = yamlGet(this.config('default'), ['gateway', 'multiplex_profiles']) === 'true';
        const name = (!multiplex && this.env(agent).HERMES_TIMEZONE) || yamlGet(this.config(agent), ['timezone']);
        if (!name) return null;
        try { return new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone; } catch { return null; }
      },
      request: async (agent, method, route, body) => (await this.open(agent, method, route, { body })).json(),
    });
  }

  // ---- profiles ---------------------------------------------------------------------------

  async usage(period: UsagePeriod) {
    return readServerUsage(this.home, this.profileIds().map(id => ({ id, name: id })), this.now(), period);
  }

  private profileIds(): string[] {
    let named: string[] = [];
    try {
      named = fs
        .readdirSync(path.join(this.home, 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      // no named profiles
    }
    return ['default', ...named.filter((name) => name !== 'default')];
  }

  // A profile id is only ever used to build a path or a URL after it was found in the listing.
  private profileHome(profile: string): string {
    if (!this.profileIds().includes(profile)) throw new HermesError('not_found', `Unknown agent: ${profile}`);
    return profile === 'default' ? this.home : path.join(this.home, 'profiles', profile);
  }

  private config(profile: string): string {
    return readText(path.join(this.profileHome(profile), 'config.yaml')) ?? '';
  }

  async profiles(): Promise<AgentProfile[]> {
    return this.profileIds().map((id) => {
      const config = this.config(id);
      return {
        id,
        name: id,
        model: yamlGet(config, ['model', 'default']) ?? 'unknown',
        provider: yamlGet(config, ['model', 'provider']) ?? 'unknown',
      };
    });
  }

  async model(): Promise<ModelInfo> {
    const config = this.config('default');
    return {
      model: yamlGet(config, ['model', 'default']) ?? 'unknown',
      provider: yamlGet(config, ['model', 'provider']) ?? 'unknown',
    };
  }

  async version(): Promise<string> {
    if (this.cachedVersion && this.now() - this.cachedVersion.at < VERSION_CACHE_MS) return this.cachedVersion.value;
    let value: string | null = null;
    try {
      const result = await this.exec(this.bin, ['--version'], { timeoutMs: 20_000 });
      value = /v(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null;
    } catch {
      value = null;
    }
    if (!value) {
      const recorded = this.gatewayRecord()?.code_version;
      if (typeof recorded !== 'string') return 'unknown';
      value = recorded;
    }
    this.cachedVersion = { value, at: this.now() };
    return value;
  }

  // ---- gateway ----------------------------------------------------------------------------

  private gatewayRecord(): Record<string, any> | null | undefined {
    const raw = readText(path.join(this.home, 'gateway_state.json'));
    if (raw === null) return null; // never started
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
      return undefined; // unreadable
    }
  }

  // Is `pid` still the process Hermes recorded? null when this machine has no /proc to ask.
  private process(pid: number, recordedStart: unknown): { alive: boolean | null; uptimeSeconds: number | null } {
    if (!fs.existsSync(this.procRoot)) return { alive: null, uptimeSeconds: null };
    const stat = readText(path.join(this.procRoot, String(pid), 'stat'));
    if (stat === null) return { alive: false, uptimeSeconds: null };
    // "pid (comm) state ppid ..." where comm may itself contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const startTicks = Number(fields[19]); // field 22: start time in clock ticks since boot
    if (!Number.isFinite(startTicks)) return { alive: true, uptimeSeconds: null };
    // A different start time means the pid was recycled by an unrelated process.
    if (typeof recordedStart === 'number' && recordedStart !== startTicks) return { alive: false, uptimeSeconds: null };
    const sinceBoot = Number.parseFloat(readText(path.join(this.procRoot, 'uptime')) ?? '');
    const uptime = Number.isFinite(sinceBoot) ? Math.floor(sinceBoot - startTicks / CLOCK_TICKS_PER_SECOND) : null;
    return { alive: true, uptimeSeconds: uptime !== null && uptime >= 0 ? uptime : null };
  }

  private gatewayCore(): GatewayCore {
    const record = this.gatewayRecord();
    if (record === null) return { state: 'stopped', pid: null, uptimeSeconds: null, record: null };
    if (record === undefined || !Number.isInteger(record.pid)) {
      return { state: 'unknown', pid: null, uptimeSeconds: null, record: null };
    }
    const { alive, uptimeSeconds } = this.process(record.pid, record.start_time);
    const recorded = String(record.gateway_state ?? '');
    if (alive === false || recorded === 'stopped' || recorded === 'startup_failed') {
      return { state: 'stopped', pid: null, uptimeSeconds: null, record };
    }
    const running = recorded === 'running' || recorded === 'degraded' || recorded === 'draining';
    return { state: alive && running ? 'active' : 'unknown', pid: record.pid, uptimeSeconds, record };
  }

  async gateway(): Promise<GatewayStatus> {
    const { state, pid, uptimeSeconds } = this.gatewayCore();
    let port: number | null = null;
    try {
      const target = this.target('default');
      if (await this.healthy(target)) port = target.port;
    } catch {
      port = null; // API server not enabled
    }
    return { state, pid, uptimeSeconds, port };
  }

  async profileStates(ids: string[]): Promise<Record<string, ProfileState>> {
    const { state, record } = this.gatewayCore();
    const served: unknown = record?.served_profiles;
    const platforms: Record<string, any> = record?.platforms && typeof record.platforms === 'object' ? record.platforms : {};
    const out: Record<string, ProfileState> = {};
    for (const id of ids) {
      const isServed = Array.isArray(served) ? served.includes(id) : id === 'default';
      if (state !== 'active' || !isServed) {
        out[id] = 'off';
        continue;
      }
      // Platform keys are "<platform>" for the default profile and "<profile>:<platform>" otherwise.
      const broken = Object.entries(platforms).some(([key, value]) => {
        const owner = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'default';
        return owner === id && (value?.needs_attention === true || /fatal|error|failed/.test(String(value?.state ?? '')));
      });
      out[id] = broken ? 'err' : 'on';
    }
    return out;
  }

  async gatewayAction(action: GatewayAction): Promise<void> {
    let result;
    try {
      result = await this.exec(this.bin, [...HOST_PROFILE, 'gateway', action], { timeoutMs: 120_000, env: { NO_COLOR: '1' } });
    } catch (error) {
      throw new HermesError('upstream', `hermes gateway ${action}: ${redact(errorMessage(error))}`);
    }
    if (result.code !== 0) {
      throw new HermesError(
        'upstream',
        `hermes gateway ${action} failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
      );
    }
  }

  // ---- doctor -----------------------------------------------------------------------------

  // Plain `hermes doctor`: no --fix (it would change the install) and no --live.
  async doctor(): Promise<DoctorCheck[]> {
    let result;
    try {
      result = await this.exec(this.bin, [...HOST_PROFILE, 'doctor'], { timeoutMs: 180_000, env: { NO_COLOR: '1' } });
    } catch (error) {
      throw new HermesError('upstream', `hermes doctor: ${redact(errorMessage(error))}`);
    }
    const checks: DoctorCheck[] = [];
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = redact(rawLine.replace(/\u001b\[[0-9;]*m/g, ''));
      const match = /^\s*([✓⚠✗])\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const ok = match[1] === '✓';
      const detail = /^(.*?)\s*\((.*)\)$/.exec(match[2]);
      checks.push({
        label: detail ? detail[1] : match[2],
        value: detail ? detail[2] : ok ? 'ok' : match[1] === '⚠' ? 'warning' : 'failed',
        ok,
      });
    }
    if (checks.length === 0 && result.code !== 0) {
      throw new HermesError(
        'upstream',
        `hermes doctor failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
      );
    }
    return checks;
  }

  // ---- logs -------------------------------------------------------------------------------

  async logs(query: { level: LogLevel; lines: number; agentId?: string }): Promise<LogLine[]> {
    const file = path.join(this.profileHome(query.agentId ?? 'default'), 'logs', 'agent.log');
    // Redact before parsing: a quoted credential can contain log-shaped continuation lines.
    const text = redact(readLogTail(file, LOG_TAIL_BYTES));

    const entries: LogLine[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}),\d+ ([A-Z]+) (.*)$/.exec(line);
      if (match && HERMES_LEVELS[match[2]]) {
        entries.push({ t: match[1], level: HERMES_LEVELS[match[2]], msg: match[3] });
      } else if (line.trim() && entries.length > 0) {
        // A traceback or wrapped line belongs to the entry before it.
        const last = entries[entries.length - 1];
        last.msg += `\n${line}`;
      }
    }
    return entries
      .filter((entry) => SEVERITY[entry.level] >= SEVERITY[query.level])
      .slice(-query.lines)
      .map((entry) => ({ ...entry, msg: redact(entry.msg).slice(0, 4000) }));
  }

  // ---- jobs -------------------------------------------------------------------------------

  async jobs(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const profile of this.profileIds()) {
      const raw = readText(path.join(this.profileHome(profile), 'cron', 'jobs.json'));
      if (raw === null) continue;
      let list: unknown;
      try {
        const parsed = JSON.parse(raw);
        list = Array.isArray(parsed) ? parsed : parsed?.jobs;
      } catch {
        continue; // one unreadable file must not hide the other profiles' jobs
      }
      if (!Array.isArray(list)) continue;
      for (const job of list) {
        if (!job || typeof job !== 'object' || job.id === undefined) continue;
        const schedule = job.schedule ?? {};
        const enabled = job.enabled === true;
        const next = enabled && job.state !== 'paused' ? Date.parse(String(job.next_run_at ?? '')) : Number.NaN;
        jobs.push({
          id: String(job.id),
          name: String(job.name ?? job.id),
          // Only `kind: cron` jobs have a cron expression; intervals and one-shots carry Hermes's
          // own description ("every 5m") instead of a made-up expression.
          cron: schedule.kind === 'cron' && schedule.expr ? String(schedule.expr) : String(schedule.display ?? job.schedule_display ?? ''),
          agent: profile,
          nextRunAt: Number.isFinite(next) ? next : null,
          enabled,
        });
      }
    }
    return jobs;
  }

  // BEGIN CONVERSATION READER (#36)
  // ---- session store ----------------------------------------------------------------------

  async lastMessage(profile: string): Promise<{ text: string; at: number } | null> {
    return new HermesConversations(this.profileHome(profile)).lastMessage();
  }

  async decisionHistory(profile: string) {
    return new HermesConversations(this.profileHome(profile)).decisionHistory(profile);
  }

  async transcript(profile: string, sessionId: string | null): Promise<Transcript> {
    return new HermesConversations(this.profileHome(profile)).transcript(sessionId);
  }

  // ---- API server -------------------------------------------------------------------------

  private env(profile: string): Record<string, string> {
    return parseDotenv(readText(path.join(this.profileHome(profile), '.env')) ?? '');
  }

  // Where and how to reach the API server for one profile. The key values read here are only
  // ever sent to Hermes itself: they are never logged and never part of an error message.
  private target(profile: string): ApiTarget {
    const profileHome = this.profileHome(profile);
    // With gateway.multiplex_profiles one gateway serves every profile: only the default
    // profile binds the port, and the others are reached under /p/<profile>/ with their own key.
    const multiplex = yamlGet(this.config('default'), ['gateway', 'multiplex_profiles']) === 'true';
    const listener = multiplex ? 'default' : profile;
    const listenerHome = this.profileHome(listener);
    const listenerEnv = this.env(listener);
    if ((listenerEnv.API_SERVER_KEY ?? '').length < MIN_API_KEY_LENGTH) {
      throw new HermesError(
        'unavailable',
        `The Hermes API server is not enabled: no usable API_SERVER_KEY in ${path.join(listenerHome, '.env')}.`,
      );
    }
    const key = this.env(profile).API_SERVER_KEY ?? '';
    if (key.length < MIN_API_KEY_LENGTH) {
      throw new HermesError(
        'unavailable',
        `Profile "${profile}" has no API_SERVER_KEY of its own in ${path.join(profileHome, '.env')}; Hermes requires one per profile.`,
      );
    }
    const configured =
      yamlGet(this.config(listener), ['platforms', 'api_server', 'extra', 'port']) ?? listenerEnv.API_SERVER_PORT;
    const port = /^\d+$/.test(configured ?? '') ? Number(configured) : DEFAULT_API_PORT;
    let host = listenerEnv.API_SERVER_HOST || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    return {
      origin: `http://${authority}`,
      prefix: multiplex && profile !== 'default' ? `/p/${encodeURIComponent(profile)}` : '',
      key,
      address: authority,
      port,
    };
  }

  private async healthy(target: ApiTarget): Promise<boolean> {
    const fetchFn = this.fetchFn;
    try {
      const response = await fetchFn(`${target.origin}/health`, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  // END CONVERSATION READER
  // BEGIN TURN ADAPTER (#37)
  async chat(profile?: string): Promise<ChatStatus> {
    const selected = profile ?? 'default';
    let target: ApiTarget;
    try {
      target = this.target(selected);
    } catch (error) {
      return { available: false, reason: profile === undefined ? errorMessage(error) : 'Este Agente no tiene chat habilitado en Hermes.' };
    }
    if (profile !== undefined) {
      try {
        const response = await this.open(selected, 'GET', '/v1/models', { target, signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        return { available: true, reason: null };
      } catch { return { available: false, reason: 'El chat de este Agente no responde en el Servidor.' }; }
    }
    if (await this.healthy(target)) return { available: true, reason: null };
    return {
      available: false,
      reason: profile === undefined ? `The Hermes API server is not answering on ${target.address} (is the gateway running?).` : 'El chat de este Agente no responde en el Servidor.',
    };
  }

  async approvalTimeoutSeconds(profile: string): Promise<number> {
    const raw = yamlGet(this.config(profile), ['approvals', 'timeout']);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) && value > 0 ? value : 300;
  }

  private async open(
    profile: string,
    method: string,
    route: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; target?: ApiTarget; steer?: boolean } = {},
  ): Promise<Response> {
    const target = init.target ?? this.target(profile);
    let response: Response;
    const fetchFn = this.fetchFn;
    try {
      response = await fetchFn(`${target.origin}${target.prefix}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${target.key}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new HermesError('unavailable', `The Hermes API server is not reachable on ${target.address}.`);
    }
    if (response.ok) return response;

    let detail = '';
    let code = '';
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
        if ('message' in body.error && typeof body.error.message === 'string') detail = redact(body.error.message);
        if ('code' in body.error && typeof body.error.code === 'string') code = body.error.code;
      }
    } catch {
      detail = '';
    }
    if (init.steer) {
      if (response.status === 404) throw new HermesError('run_not_found', 'El Turno ya no existe en Hermes.');
      if (response.status === 409 && code === 'run_not_accepting_steer') throw new HermesError('run_not_accepting_steer', 'El Turno ya no admite redirección.');
      if (response.status === 409 && code === 'steer_not_accepted') throw new HermesError('steer_not_accepted', 'Hermes no aceptó la instrucción.');
      if (response.status === 400 && code === 'invalid_steer_input') throw new HermesError('invalid_steer_input', 'La instrucción no es válida.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new HermesError('upstream', `The Hermes API server rejected the API_SERVER_KEY of profile "${profile}".`);
    }
    if (response.status === 404) throw new HermesError('not_found', detail || 'Hermes does not know that run.');
    if (response.status === 409) throw new HermesError('conflict', detail || 'Hermes refused: conflicting state.');
    if (response.status === 400) throw new HermesError('bad_request', detail || 'Hermes rejected the request.');
    throw new HermesError('upstream', `Hermes API server answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  // END TURN ADAPTER
  // BEGIN UPSTREAM BODY (#39); MODEL decoration (#38) is supplied by RunStartPorts.
  async createRun(profile: string, request: PreparedRunRequest): Promise<RunCreated> {
    const body = hermesRunBody(request);
    const created: any = await (await this.open(profile, 'POST', '/v1/runs', { body })).json();
    const runId = typeof created?.run_id === 'string' ? created.run_id : '';
    if (!runId) throw new HermesError('upstream', 'Hermes accepted the run but returned no run_id.');

    // POST /v1/runs does not say which session the run landed in; the run status does.
    let sessionId: string | null = request.sessionId ?? null;
    try {
      const status: any = await (await this.open(profile, 'GET', `/v1/runs/${encodeURIComponent(runId)}`)).json();
      if (typeof status?.session_id === 'string' && status.session_id) sessionId = status.session_id;
    } catch {
      // keep what the caller asked for
    }
    return { runId, sessionId };
  }

  // END UPSTREAM BODY
  // BEGIN TURN EVENTS/STATUS (#37)
  async *runEvents(
    profile: string,
    runId: string,
    afterSeq: number | null,
    signal: AbortSignal,
  ): AsyncGenerator<UpstreamEvent> {
    const response = await this.open(profile, 'GET', `/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: 'text/event-stream', ...(afterSeq === null ? {} : { 'Last-Event-ID': String(afterSeq) }) },
      signal,
    });
    if (!response.body) return;
    for await (const frame of parseSse(response.body)) {
      let payload: any;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (!payload || typeof payload.event !== 'string') continue;
      const seq = typeof payload.seq === 'number' ? payload.seq : frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
      yield { ...payload, seq };
    }
  }

  async runStatus(profile: string, runId: string): Promise<UpstreamRunStatus | null> {
    let status: any;
    try {
      status = await (await this.open(profile, 'GET', `/v1/runs/${encodeURIComponent(runId)}`)).json();
    } catch (error) {
      if (error instanceof HermesError && error.code === 'not_found') return null;
      throw error;
    }
    return {
      status: String(status?.status ?? 'unknown'),
      output: typeof status?.output === 'string' ? status.output : null,
      error: typeof status?.error === 'string' && status.error ? status.error : null,
      ...(isModelSelection(status?.runtime && { provider: status.runtime.provider, model: status.runtime.model }) ? { runtime: { provider: status.runtime.provider, model: status.runtime.model } } : {}),
      ...(typeof status?.pending_steer === 'string' && status.pending_steer ? { pendingSteer: status.pending_steer } : {}),
    };
  }

  async stopRun(profile: string, runId: string): Promise<void> {
    const response = await this.open(profile, 'POST', `/v1/runs/${encodeURIComponent(runId)}/stop`);
    await response.body?.cancel();
  }

  async resolveApproval(
    profile: string,
    runId: string,
    choice: ApprovalChoice,
    requestId: string | null,
  ): Promise<void> {
    const body: Record<string, unknown> = { choice };
    if (requestId) body.request_id = requestId;
    const response = await this.open(profile, 'POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { body });
    await response.body?.cancel();
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
