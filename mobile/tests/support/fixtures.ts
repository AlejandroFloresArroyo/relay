import type { Agent, Approval, Conversation, Health, ServerInfo } from '../../../protocol/protocol';
import type { ServerEntry, Settings, PendingApproval } from '@/state/app';
import { clockStart, stored } from './native';
import { json, respond } from './transport';

export const serverA: ServerEntry = { id: 'A', name: 'Servidor A', url: 'http://a.fixture.ts.net:17651', deviceId: 'fixture-device-A', key: 'fixture-key-A', isDefault: true };
export const serverB: ServerEntry = { id: 'B', name: 'Servidor B', url: 'http://b.fixture.ts.net:17651', deviceId: 'fixture-device-B', key: 'fixture-key-B', isDefault: false };
export const agentA: Agent = { id: 'agentA', name: 'Agente A', model: 'fixture-model', provider: 'fixture', status: 'on', pendingApprovals: 0, lastMessage: null };
export const health: Health = { ok: true, service: 'relayd', version: 'fixture', protocolVersion: 2, minAppProtocolVersion: 2 };
export const conversationA: Conversation = { id: 'fixture-conversation', sessionId: 'fixture-conversation', title: 'Conversación de prueba', source: 'api_server', origin: 'relay', originLabel: 'Relay', kind: 'interactive', writable: true, archived: false, hidden: false, state: 'ready', startedAt: clockStart, lastActiveAt: clockStart, messageCount: 1, preview: 'Conversación recuperada', model: null };
export const serverInfo: ServerInfo = { host: 'fixture', hermesVersion: 'fixture', profiles: 1, chat: { available: true, reason: null } };
export const settings: Settings = { faceid: true, faceApprove: true, autoLockMs: 60000 };
export function seed(servers: ServerEntry[] = [serverA], preferences: Settings = settings) {
  stored.set('relay.servers.v1', JSON.stringify(servers));
  stored.set('relay.settings.v1', JSON.stringify(preferences));
}
export function polling(server: ServerEntry, agents: Agent[] = []) {
  respond(server.url, '/health', json(health));
  respond(server.url, '/v1/agents', json({ agents }));
  respond(server.url, '/v1/approvals', json({ approvals: [] }));
  respond(server.url, '/v1/server/control', json({ paused: false, hermesPaused: false, phase: 'ready', action: null }));
  for (const agent of agents) respond(server.url, `/v1/agents/${encodeURIComponent(agent.id)}/chat`, json({ available: true, reason: null }));
}
export function approval(id = 'approval-A', server = serverA, choices: Approval['choices'] = ['once', 'session', 'deny']): PendingApproval {
  return { serverId: server.id, serverName: server.name, approval: {
    id, agentId: 'agentA', agentName: 'Agente A', runId: 'fixture-run', command: 'echo fixture',
    choices, createdAt: clockStart, cwd: null, reason: null, affects: null, risk: null, expiresAt: clockStart + 300000,
  } };
}
