import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BigIntStats } from 'node:fs';
import { AGENT_FILE_MAX_BYTES } from '../../protocol/protocol.ts';
import type { ConversationFile, ConversationFiles, ConversationFilesQuery } from '../../protocol/protocol.ts';
import type { AnnouncedMedia, HermesMedia, ValidatedMedia } from './chatPorts.ts';
import { HermesError } from './hermes.ts';

interface Ticket extends AnnouncedMedia { agentId: string; conversationId: string; createdAt: number }
export interface StagedFile { file: FileHandle; name: string; mimeType: string; size: number; dispose(): Promise<void> }
const blocked = () => new HermesError('file_blocked', 'El archivo no se puede entregar.');
const missing = () => new HermesError('file_not_found', 'El archivo ya no está en el Servidor.');
const tooLarge = () => new HermesError('file_too_large', 'El archivo pesa más de 50 MB.');
const identity = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
const sameIdentity = (a: ValidatedMedia['identity'], b: ValidatedMedia['identity']) => a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Open every component relative to an already-open descriptor. Linux /proc is never client input.
export async function openArtifact(candidate: string, privateDirectory: string): Promise<FileHandle> {
  if (!path.isAbsolute(candidate) || candidate.split('/').some((part) => part === '..') || /[\x00-\x1f\x7f]/.test(candidate)) throw blocked();
  const normalized = path.resolve(candidate); const privateRoot = path.resolve(privateDirectory);
  if (normalized === privateRoot || normalized.startsWith(privateRoot + '/')) throw blocked();
  const parts = candidate.split('/').filter(Boolean);
  if (parts.length === 0) throw blocked();
  let directory: FileHandle | undefined;
  try {
    directory = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const component of parts.slice(0, -1)) {
      const next = await fs.open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const file = await fs.open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) { await file.close(); throw blocked(); }
    if (stat.size > BigInt(AGENT_FILE_MAX_BYTES)) { await file.close(); throw tooLarge(); }
    return file;
  } catch (error) {
    if (error instanceof HermesError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
    throw blocked();
  } finally { await directory?.close(); }
}

export class AgentFiles {
  private tickets = new Map<string, Ticket>();
  constructor(privateOptions: { media: HermesMedia; privateDirectory: string; now?: () => number }) { this.options = privateOptions; }
  private options: { media: HermesMedia; privateDirectory: string; now?: () => number };
  private now() { return (this.options.now ?? Date.now)(); }
  private prune() {
    for (const [id, ticket] of this.tickets) if (this.now() - ticket.createdAt >= 10 * 60 * 1000) this.tickets.delete(id);
  }
  private ticket(agentId: string, conversationId: string, announcement: AnnouncedMedia): string {
    this.prune();
    for (const [id, previous] of this.tickets) if (previous.agentId === agentId && previous.conversationId === conversationId && previous.messageId === announcement.messageId && previous.path === announcement.path) return id;
    if (this.tickets.size >= 2048) this.tickets.delete(this.tickets.keys().next().value!);
    const id = randomUUID(); this.tickets.set(id, { ...announcement, agentId, conversationId, createdAt: this.now() }); return id;
  }
  private async validate(agentId: string, candidate: string): Promise<ValidatedMedia> {
    const file = await openArtifact(candidate, this.options.privateDirectory);
    try {
      const before = identity(await file.stat({ bigint: true }));
      const validated = await this.options.media.validate(agentId, candidate);
      if (validated.path !== path.resolve(candidate) || !sameIdentity(before, validated.identity) || !sameIdentity(before, identity(await file.stat({ bigint: true })))) throw blocked();
      return validated;
    } finally { await file.close(); }
  }
  async list(agentId: string, conversationId: string, sessionId: string, query: ConversationFilesQuery, guard: () => void): Promise<ConversationFiles> {
    const announcements = await this.options.media.announcements(agentId, sessionId, query.messageId); guard();
    const offset = query.offset ?? 0, limit = query.limit ?? 50;
    const records: ConversationFile[] = [];
    const displayMessages: { messageId: string; text: string }[] = []; let displayBytes = 0;
    for (const announcement of announcements.slice(offset, offset + limit)) {
      guard();
      if (!displayMessages.some((entry) => entry.messageId === announcement.messageId) && announcement.displayText !== undefined) {
        const size = Buffer.byteLength(announcement.displayText);
        const text = displayBytes + size <= 64_000 ? announcement.displayText : 'Archivos del Agente.';
        displayMessages.push({ messageId: announcement.messageId, text }); displayBytes += Buffer.byteLength(text);
      }
      const id = this.ticket(agentId, conversationId, announcement);
      let record: ConversationFile = { id, messageId: announcement.messageId, name: path.basename(announcement.path).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'Archivo', mimeType: 'application/octet-stream', size: null, status: 'ready' };
      try {
        const validated = await this.validate(agentId, announcement.path); guard();
        record = { ...record, name: validated.name, mimeType: validated.mimeType, size: validated.size };
      } catch (error) {
        guard(); if (!(error instanceof HermesError) || !['file_blocked', 'file_not_found', 'file_too_large'].includes(error.code)) throw error;
        record.status = error.code === 'file_not_found' ? 'missing' : error.code === 'file_too_large' ? 'too_large' : 'blocked';
        if (record.status === 'too_large') { const stat = await fs.lstat(announcement.path).catch(() => null); record.size = stat?.isFile() ? stat.size : null; }
      }
      records.push(record);
    }
    guard(); return { files: records, ...(displayMessages.length ? { displayMessages } : {}), nextOffset: offset + limit < announcements.length ? offset + limit : null };
  }
  async stage(agentId: string, conversationId: string, sessionId: string, id: string, guard: () => void): Promise<StagedFile> {
    this.prune(); const ticket = this.tickets.get(id);
    if (!ticket) throw new HermesError('file_ticket_expired', 'Actualiza la lista de archivos y vuelve a descargarlo.');
    if (ticket.agentId !== agentId || ticket.conversationId !== conversationId) throw missing();
    const assertAnnounced = async () => {
      const current = await this.options.media.announcements(agentId, sessionId, ticket.messageId); guard();
      if (!current.some((entry) => entry.messageId === ticket.messageId && entry.path === ticket.path)) throw missing();
    };
    await assertAnnounced();
    const validated = await this.validate(agentId, ticket.path); guard();
    const source = await openArtifact(ticket.path, this.options.privateDirectory);
    let temporary: string | undefined; let staged: FileHandle | undefined;
    try {
      if (!sameIdentity(validated.identity, identity(await source.stat({ bigint: true })))) throw blocked();
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-')); await fs.chmod(temporary, 0o700);
      staged = await fs.open(path.join(temporary, 'attachment'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const buffer = Buffer.alloc(64 * 1024); let size = 0;
      for (;;) {
        guard(); const read = await source.read(buffer, 0, buffer.length, size); if (read.bytesRead === 0) break;
        size += read.bytesRead; if (size > AGENT_FILE_MAX_BYTES) throw tooLarge();
        let written = 0;
        while (written < read.bytesRead) { guard(); const result = await staged.write(buffer, written, read.bytesRead - written, size - read.bytesRead + written); if (result.bytesWritten === 0) throw blocked(); written += result.bytesWritten; }
      }
      if ((await staged.stat()).size !== size || size !== validated.size || !sameIdentity(validated.identity, identity(await source.stat({ bigint: true })))) throw blocked();
      await assertAnnounced(); const fresh = await this.validate(agentId, ticket.path); guard();
      if (!sameIdentity(validated.identity, fresh.identity)) throw blocked();
      const file = staged, directory = temporary; staged = undefined; temporary = undefined;
      return { file, name: validated.name, mimeType: validated.mimeType, size, async dispose() { await file.close(); await fs.rm(directory, { recursive: true, force: true }); } };
    } finally { await source.close(); await staged?.close(); if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
  }
}
