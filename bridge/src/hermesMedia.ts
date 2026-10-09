import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnnouncedMedia, HermesMedia, ValidatedMedia } from './chatPorts.ts';
import type { Exec } from './exec.ts';
import type { Transcript } from './hermes.ts';
import { HermesError } from './hermes.ts';

const unavailable = () => new HermesError('chat_unavailable', 'La entrega de archivos de Hermes no está disponible.');
export function createHermesMedia(options: { home: string; source?: string; python?: string; exec: Exec; transcript(profile: string, sessionId: string): Promise<Transcript> }): HermesMedia {
  const source = options.source ?? path.join(options.home, 'hermes-agent');
  const python = options.python ?? path.join(source, fs.existsSync(path.join(source, 'venv', 'bin', 'python')) ? 'venv' : '.venv', 'bin', 'python');
  const observed = new Map<string, { scope: string; messageId: string; fingerprint: string; entries: AnnouncedMedia[] }>();
  const fingerprint = (text: string) => createHash('sha256').update(text, 'utf16le').digest('hex');
  const adapter = fileURLToPath(new URL('./hermes_media.py', import.meta.url));
  async function invoke(profile: string, input: unknown): Promise<unknown> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) throw unavailable();
    const home = profile === 'default' ? options.home : path.join(options.home, 'profiles', profile);
    try {
      const result = await options.exec(python, ['-I', '-B', adapter, source, home], { timeoutMs: 10_000, env: { HERMES_HOME: home, PYTHONDONTWRITEBYTECODE: '1' }, input: JSON.stringify(input) });
      if (result.code !== 0) throw unavailable();
      const decoded: unknown = JSON.parse(result.stdout);
      if (decoded && typeof decoded === 'object' && 'error' in decoded) {
        if (decoded.error === 'missing') throw new HermesError('file_not_found', 'El archivo ya no está en el Servidor.');
        if (decoded.error === 'blocked') throw new HermesError('file_blocked', 'El archivo no se puede entregar.');
        throw unavailable();
      }
      return decoded;
    } catch (error) { if (error instanceof HermesError) throw error; throw unavailable(); }
  }
  return {
    async announcements(profile, sessionId, messageId) {
      const transcript = await options.transcript(profile, sessionId);
      const scope = JSON.stringify([profile, sessionId]);
      const allMessages = transcript.items.filter((item) => item.kind === 'assistant').map((item) => ({ id: item.id, text: item.kind === 'assistant' ? item.text : '' }));
      for (const [key, cached] of observed) if (cached.scope === scope && !allMessages.some((message) => message.id === cached.messageId && fingerprint(message.text) === cached.fingerprint)) observed.delete(key);
      const messages = allMessages.filter((item) => messageId === undefined || item.id === messageId);
      const result = await invoke(profile, { operation: 'extract', messages });
      if (!Array.isArray(result) || !result.every((entry) => entry && typeof entry === 'object' && typeof entry.messageId === 'string' && messages.some((message) => message.id === entry.messageId) && typeof entry.path === 'string' && entry.path.length < 4096 && (entry.displayText === undefined || typeof entry.displayText === 'string'))) throw unavailable();
      const entries: AnnouncedMedia[] = [];
      for (const message of messages) {
        const key = JSON.stringify([profile, sessionId, message.id]);
        const previous = observed.get(key)?.entries ?? [];
        const fresh: AnnouncedMedia[] = result.filter((entry: AnnouncedMedia) => entry.messageId === message.id).map((entry: AnnouncedMedia) => ({ messageId: entry.messageId, path: entry.path, ...(entry.displayText !== undefined ? { displayText: Buffer.byteLength(entry.displayText) <= 64_000 ? entry.displayText : 'Archivos del Agente.' } : {}) }));
        const merged = [...previous, ...fresh.filter((entry) => !previous.some((cached) => cached.path === entry.path))];
        entries.push(...merged);
        if (merged.length && merged.length <= 2048) observed.set(key, { scope, messageId: message.id, fingerprint: fingerprint(message.text), entries: merged });
      }
      while (observed.size > 128 || [...observed.values()].reduce((count, value) => count + value.entries.length, 0) > 2048) observed.delete(observed.keys().next().value!);
      return entries;
    },
    async validate(profile, candidate) {
      const result = await invoke(profile, { operation: 'validate', path: candidate });
      if (!result || typeof result !== 'object') throw unavailable();
      const value = result as Partial<ValidatedMedia>;
      if (typeof value.path !== 'string' || typeof value.name !== 'string' || value.name.length > 255 || value.name !== path.basename(value.path) || /[\x00-\x1f\x7f]/.test(value.name)
        || typeof value.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mimeType) || !Number.isSafeInteger(value.size) || Number(value.size) < 0
        || !value.identity || !Object.values(value.identity).every((field) => typeof field === 'string' && /^\d+$/.test(field)) || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every((field) => field in value.identity!)) throw unavailable();
      return value as ValidatedMedia;
    },
  };
}
