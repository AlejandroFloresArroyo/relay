// Builds a throwaway HERMES_HOME in the OS temp dir, shaped like a real install (files copied
// from what Hermes 0.21.5 writes), so RealHermes can be tested without touching ~/.hermes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_KEY = 'default-profile-api-key-0123456789';
export const CODING_KEY = 'coding-profile-api-key-9876543210';
export const GATEWAY_PID = 4242;
export const GATEWAY_START_TICKS = 1147;

export interface FakeHome {
  home: string;
  procRoot: string;
  write(relative: string, content: string): void;
  remove(relative: string): void;
  cleanup(): void;
}

export interface FakeHomeOptions {
  apiPort?: number | null; // null: API server not configured at all
}

export function createHermesHome(options: FakeHomeOptions = {}): FakeHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relayd-test-'));
  const home = path.join(root, 'hermes');
  const procRoot = path.join(root, 'proc');
  const apiPort = options.apiPort === undefined ? 18642 : options.apiPort;

  const write = (relative: string, content: string) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  write(
    'config.yaml',
    [
      'model:',
      '  default: deepseek-v4.1-flash',
      '  provider: opencode-go',
      '  base_url: https://opencode.ai/zen/go/v1',
      'gateway:',
      '  multiplex_profiles: true',
      'approvals:',
      '  mode: manual',
      '  timeout: 120',
      '',
    ].join('\n'),
  );
  write(
    '.env',
    apiPort === null
      ? 'OPENCODE_GO_API_KEY=provider-secret-should-never-leak\n'
      : [
          'OPENCODE_GO_API_KEY=provider-secret-should-never-leak',
          'API_SERVER_ENABLED=true',
          `API_SERVER_KEY=${DEFAULT_KEY}`,
          `API_SERVER_PORT=${apiPort}`,
          '',
        ].join('\n'),
  );
  write(
    'profiles/coding/config.yaml',
    ['model:', '  default: qwen3.8-max', '  provider: opencode-go', '  aliases:', '    builder: opencode-go/x', ''].join('\n'),
  );
  write('profiles/coding/.env', `API_SERVER_KEY=${CODING_KEY}\n`);
  // "personal" has no model section and no API key of its own.
  write('profiles/personal/config.yaml', 'tts:\n  edge:\n    voice: es-MX-DaliaNeural\n');
  write('profiles/personal/.env', '# API_SERVER_KEY=commented-out\n');

  write(
    'gateway_state.json',
    JSON.stringify({
      pid: GATEWAY_PID,
      kind: 'hermes-gateway',
      start_time: GATEWAY_START_TICKS,
      gateway_state: 'running',
      active_agents: 0,
      platforms: {
        discord: { state: 'connected', error_code: null, needs_attention: false },
        'personal:discord': { state: 'fatal', error_code: 'discord_auth', needs_attention: true },
      },
      code_version: '0.21.5',
      served_profiles: ['default', 'coding', 'personal'],
    }),
  );

  write(
    'logs/agent.log',
    [
      '2026-10-01 15:08:35,573 ERROR gateway.run: Fatal discord adapter error (stale): reconnecting',
      'Traceback (most recent call last):',
      '  File "gateway/run.py", line 10, in tick',
      '2026-10-01 15:08:35,574 WARNING gateway.run: No connected messaging platforms remain',
      '2026-10-01 15:08:36,304 INFO gateway.run: Reconnecting discord (attempt 1)...',
      '2026-10-01 15:08:36,400 DEBUG gateway.run: socket opened',
      '2026-10-01 15:08:39,754 INFO gateway.run: discord reconnected, token=abcdef0123456789abcdef',
      '2026-10-02 04:58:41,377 CRITICAL hermes_cli.mem_trim: out of memory',
      '',
    ].join('\n'),
  );

  write(
    'profiles/coding/cron/jobs.json',
    JSON.stringify({
      jobs: [
        {
          id: '02e9b6866f94',
          name: 'TFV morning digest',
          prompt: 'a long private prompt',
          schedule: { kind: 'cron', expr: '30 8 * * 1-5', display: 'weekdays at 8:30am' },
          enabled: false,
          state: 'paused',
          next_run_at: '2026-09-29T08:30:00-06:00',
        },
        {
          id: 'aa11bb22cc33',
          name: 'poll inbox',
          schedule: { kind: 'interval', minutes: 5, display: 'every 5m' },
          enabled: true,
          state: 'scheduled',
          next_run_at: '2026-10-02T05:05:00-06:00',
        },
      ],
      updated_at: '2026-10-02T05:00:00-06:00',
    }),
  );

  // /proc stand-in: field 22 of <pid>/stat is the start time in clock ticks since boot.
  fs.mkdirSync(path.join(procRoot, String(GATEWAY_PID)), { recursive: true });
  const statFields = ['S', '1', ...new Array(17).fill('0'), String(GATEWAY_START_TICKS), '0', '0'];
  fs.writeFileSync(path.join(procRoot, String(GATEWAY_PID), 'stat'), `${GATEWAY_PID} (hermes (gw)) ${statFields.join(' ')}\n`);
  fs.writeFileSync(path.join(procRoot, 'uptime'), '5011.47 40000.00\n');

  return {
    home,
    procRoot,
    write,
    remove(relative: string) {
      fs.rmSync(path.join(home, relative), { recursive: true, force: true });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface FakeMessage {
  session: string;
  role: string;
  content: string | null;
  at: number; // epoch seconds, like Hermes stores it
  toolCalls?: { id: string; name: string; args: Record<string, unknown> | string }[];
  toolCallId?: string;
  toolName?: string;
  active?: number;
  compressedSummary?: number;
  reasoning?: string;
}

export interface FakeSession {
  id: string;
  source: string;
  startedAt: number;
  lastActivityAt?: number | null;
  parent?: string | null;
  archived?: number;
  hidden?: number;
  title?: string | null;
  endReason?: string | null;
  endedAt?: number | null;
  modelConfig?: Record<string, unknown> | string | null;
}

// Canonical Hermes 0.21.5 sessions/messages schema (hermes_state_common.py:338–429).
export function writeStateDb(
  file: string,
  sessions: FakeSession[],
  messages: FakeMessage[],
  options: { wal?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Historical/corrupt lineage fixtures are deliberate; production never changes this pragma.
  db.exec('PRAGMA foreign_keys = OFF');
  if (options.wal) db.exec('PRAGMA journal_mode = WAL'); // what Hermes uses
  db.exec(`
    CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, session_key TEXT, chat_id TEXT,
      chat_type TEXT, thread_id TEXT, display_name TEXT, origin_json TEXT,
      expiry_finalized INTEGER DEFAULT 0, model TEXT, model_config TEXT, system_prompt TEXT,
      system_prompt_hash TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
      ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT, git_branch TEXT,
      git_repo_root TEXT, git_metadata_generation INTEGER NOT NULL DEFAULT 0, billing_provider TEXT,
      billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
      cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT, title_source TEXT,
      last_activity_at REAL, last_activity_description TEXT, last_activity_provenance TEXT,
      api_call_count INTEGER DEFAULT 0, handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT,
      compression_failure_cooldown_until REAL, compression_failure_error TEXT,
      compression_fallback_streak INTEGER NOT NULL DEFAULT 0, compression_ineffective_count INTEGER NOT NULL DEFAULT 0,
      compression_recovery_deadline REAL, profile_name TEXT, transport_profile TEXT,
      rewind_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, last_read_at REAL, tool_names TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
      FOREIGN KEY (system_prompt_hash) REFERENCES system_prompts(hash)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
      effect_disposition TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
      reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
      codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
      _compressed_summary INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0, api_content TEXT, display_kind TEXT, display_metadata TEXT,
      display_identity BLOB, display_order INTEGER
    );
  `);
  const insertSession = db.prepare(
    'INSERT INTO sessions (id, source, parent_session_id, started_at, last_activity_at, archived, hidden, title, end_reason, ended_at, model_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.source,
      session.parent ?? null,
      session.startedAt,
      session.lastActivityAt ?? null,
      session.archived ?? 0,
      session.hidden ?? 0,
      session.title ?? null,
      session.endReason ?? null,
      session.endedAt ?? null,
      typeof session.modelConfig === 'string' ? session.modelConfig : session.modelConfig ? JSON.stringify(session.modelConfig) : null,
    );
  }
  const insertMessage = db.prepare(
    'INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active, _compressed_summary, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const message of messages) {
    const toolCalls = message.toolCalls
      ? JSON.stringify(
          message.toolCalls.map((call) => ({
            id: call.id,
            call_id: call.id,
            type: 'function',
            function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args) },
          })),
        )
      : null;
    insertMessage.run(
      message.session,
      message.role,
      message.content,
      message.toolCallId ?? null,
      toolCalls,
      message.toolName ?? null,
      message.at,
      message.active ?? 1,
      message.compressedSummary ?? 0,
      message.reasoning ?? null,
    );
  }
  db.close();
}
