import type { ConversationFile, ConversationFiles } from '../../../protocol/protocol.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';

export const DEMO_FILE_SCENARIOS = [{ id: 'off', name: 'Sin archivos' }, { id: 'produced', name: 'Archivos producidos' }, { id: 'downloading', name: 'Descargando…' }, { id: 'states', name: 'Demasiado grande y ausente' }, { id: 'error', name: 'Error de lectura' }] as const;
export type DemoFileScenario = typeof DEMO_FILE_SCENARIOS[number]['id'];
const scenarios = new Map<string, DemoFileScenario>();
export function demoFileScenario(serverId: string) { return scenarios.get(serverId) ?? 'off'; }
export function setDemoFileScenario(serverId: string, scenario: DemoFileScenario) { scenarios.set(serverId, scenario); }
export function resetDemoFiles() { scenarios.clear(); }
const document = new TextEncoder().encode('# Informe de integración\n\nTodos los tests pasan.\n');
const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,11,73,68,65,84,120,156,99,0,2,0,0,5,0,1,165,246,69,64,0,0,0,0,73,69,78,68,174,66,96,130]);
const zip = Uint8Array.from([80,75,5,6,...Array<number>(18).fill(0)]);

export function createDemoFiles(serverId: string, now: () => number, conversations?: Pick<RelayClient, 'transcript' | 'conversation'>): Partial<RelayClient> {
  const guard = () => { const error = demoConnectionError(serverId); if (error) throw error; };
  const messageId = (conversationId: string) => `demo-files:${conversationId}`;
  const records = (conversationId: string): ConversationFile[] => {
    const scenario = demoFileScenario(serverId), mid = messageId(conversationId);
    if (scenario === 'off') return [];
    if (scenario === 'error') throw new RelayError('chat_unavailable', 'No se pudieron cargar los archivos de demostración. Reintenta.', 503);
    return scenario === 'states' ? [
      { id: 'demo-zip', messageId: mid, name: 'respaldo-2026-10-01.zip', mimeType: 'application/zip', size: zip.length, status: 'ready' },
      { id: 'demo-large', messageId: mid, name: 'grabacion-demo-v12.mp4', mimeType: 'video/mp4', size: 318 * 1024 * 1024, status: 'too_large' },
      { id: 'demo-missing', messageId: mid, name: 'metricas-septiembre.csv', mimeType: 'text/csv', size: 84 * 1024, status: 'missing' },
    ] : [
      { id: 'demo-document', messageId: mid, name: 'informe-tests-integracion-14-oct.md', mimeType: 'text/markdown', size: document.length, status: 'ready' },
      { id: 'demo-png', messageId: mid, name: 'cobertura.png', mimeType: 'image/png', size: png.length, status: 'ready' },
      { id: 'demo-zip', messageId: mid, name: 'respaldo-2026-10-01.zip', mimeType: 'application/zip', size: zip.length, status: 'ready' },
    ];
  };
  return {
    ...(conversations ? { async transcript(agentId: string, sessionId?: string | null) {
      const history = await conversations.transcript(agentId, sessionId);
      if (demoFileScenario(serverId) === 'off' || agentId !== 'dev' || !history.conversation) return history;
      return { ...history, items: [...history.items, { kind: 'assistant' as const, id: messageId(history.conversation.id), text: 'Listo, aquí están los archivos:\nMEDIA:/demo/informe.md', at: now() }] };
    } } : {}),
    async conversationFiles(agentId, conversationId, query = {}): Promise<ConversationFiles> {
      guard(); if (conversations) await conversations.conversation(agentId, conversationId);
      const all = agentId === 'dev' ? records(conversationId).filter((file) => query.messageId === undefined || file.messageId === query.messageId) : [];
      const offset = query.offset ?? 0, limit = query.limit ?? 50;
      return { files: all.slice(offset, offset + limit), displayMessages: [{ messageId: messageId(conversationId), text: 'Listo, aquí están los archivos:' }], nextOffset: offset + limit < all.length ? offset + limit : null };
    },
    async downloadConversationFile(agentId, conversationId, fileId, sink, signal) {
      guard(); if (conversations) await conversations.conversation(agentId, conversationId);
      const file = agentId === 'dev' ? records(conversationId).find((candidate) => candidate.id === fileId) : undefined;
      if (!file || file.status === 'missing') throw new RelayError('file_not_found', 'El archivo ya no está en el Servidor.', 404);
      if (file.status === 'too_large') throw new RelayError('file_too_large', 'El archivo pesa más de 50 MB.', 413);
      if (signal?.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
      const bytes = fileId === 'demo-png' ? png : fileId === 'demo-zip' ? zip : document;
      await sink(bytes); guard(); if (signal?.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
      return { bytes: bytes.length, mimeType: file.mimeType };
    },
  };
}
