import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BOARD_FILE_MAX_BYTES, BOARD_MAX_CARDS_PER_AGENT } from '../../protocol/board.ts';
import { BOARD_WEB_ID_PATTERN } from '../../protocol/boardWeb.ts';
import type { BoardPublication, PublishedBoardCard } from '../../protocol/board.ts';

export interface HermesBoard { read(profile: string): Promise<PublishedBoardCard[]> }
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const object = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12;
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 946684800000 && (v as number) <= 4102444800000;
const list = (v: unknown, max: number, valid: (v: unknown) => boolean) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(valid);
function validPublication(v: unknown, now: number): v is BoardPublication {
  if (!object(v, ['title', 'updatedAt', 'maxAgeMs', 'state', 'content']) || !text(v.title, 100) || !(v.title as string).trim() || !timestamp(v.updatedAt) || v.updatedAt > now + 300000 || !Number.isSafeInteger(v.maxAgeMs) || (v.maxAgeMs as number) < 1000 || (v.maxAgeMs as number) > 2592000000 || !['ready', 'updating', 'error'].includes(v.state as string)) return false;
  if (!v.content || typeof v.content !== 'object' || Array.isArray(v.content)) return false;
  const c = v.content as Record<string, unknown>;
  const updatedAt = v.updatedAt;
  switch (c.type) {
    case 'number': return object(c, ['type', 'value', 'unit', 'detail']) && text(c.value, 32) && text(c.unit, 24) && text(c.detail, 120);
    case 'meter': return object(c, ['type', 'value', 'max', 'unit']) && number(c.value) && number(c.max) && c.max > 0 && c.value >= 0 && c.value <= c.max && text(c.unit, 24);
    case 'states': return object(c, ['type', 'items']) && list(c.items, 20, item => object(item, ['label', 'state', 'detail']) && text(item.label, 100) && text(item.detail, 100) && ['ok', 'warning', 'error', 'off'].includes(item.state as string));
    case 'series': return object(c, ['type', 'unit', 'points']) && text(c.unit, 24) && list(c.points, 120, p => object(p, ['at', 'value']) && timestamp(p.at) && p.at <= updatedAt && number(p.value)) && (c.points as { at: number }[]).every((p, i, a) => !i || p.at > a[i - 1].at);
    case 'log': return object(c, ['type', 'lines']) && list(c.lines, 50, line => text(line, 300));
    case 'text': return object(c, ['type', 'text']) && text(c.text, 4000);
    case 'web': return object(c, ['type', 'bundleRef', 'revision']) && typeof c.bundleRef === 'string' && new RegExp(BOARD_WEB_ID_PATTERN).test(c.bundleRef) && typeof c.revision === 'string' && /^[a-f0-9]{64}$/.test(c.revision);
    case 'action': return object(c, ['type', 'label', 'message']) && text(c.label, 60) && text(c.message, 4000) && !!(c.message as string).trim();
    default: return false;
  }
}

// Linux descriptor-relative traversal: no pathname is re-resolved after opening its parent.
async function openDirectory(candidate: string): Promise<FileHandle> {
  if (!path.isAbsolute(candidate) || candidate.split('/').some(p => p === '..' || p === '.') || /[\x00-\x1f]/.test(candidate)) throw new Error('Invalid publication directory');
  let current = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of candidate.split('/').filter(Boolean)) {
      const next = await fs.open(`/proc/self/fd/${current.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close(); current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}
async function readPublication(directory: FileHandle, name: string, now: number): Promise<BoardPublication> {
  const file = await fs.open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(BOARD_FILE_MAX_BYTES)) throw new Error('Invalid publication file');
    const buffer = Buffer.alloc(BOARD_FILE_MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break; length += chunk.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (length > BOARD_FILE_MAX_BYTES || BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw new Error('Publication changed');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (!validPublication(parsed, now)) throw new Error('Invalid publication schema');
    return parsed;
  } finally { await file.close(); }
}
export function createBoardReader(profileHome: (profile: string) => string, now: () => number = Date.now): HermesBoard {
  const cache = new Map<string, PublishedBoardCard[]>();
  return { async read(profile) {
    if (!identifier.test(profile)) throw new Error('Invalid profile');
    let directory: FileHandle;
    try { directory = await openDirectory(`${profileHome(profile)}/relay-board`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(profile); return []; } throw new Error('Publication unavailable'); }
    try {
      const names: string[] = [];
      const entries = await fs.opendir(`/proc/self/fd/${directory.fd}`);
      for await (const entry of entries) {
        names.push(entry.name);
        if (names.length > BOARD_MAX_CARDS_PER_AGENT) throw new Error('Publication limit exceeded');
      }
      const cards: PublishedBoardCard[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith('.json') || !identifier.test(name.slice(0, -5))) throw new Error('Invalid publication name');
        const id = name.slice(0, -5);
        try {
          const data = await readPublication(directory, name, now());
          cards.push({ ...data, id, status: data.state === 'error' ? 'error' : data.state === 'updating' ? 'updating' : now() - data.updatedAt > data.maxAgeMs ? 'stale' : 'ready' });
        } catch {
          const previous = cache.get(profile)?.find(c => c.id === id);
          cards.push(previous ? { ...previous, status: 'error' } : { id, title: 'Tarjeta no disponible', updatedAt: null, maxAgeMs: 60000, state: 'error', status: 'error', content: { type: 'text', text: 'La publicación no es válida o no se puede leer.' } });
        }
      }
      if (cache.size >= 32 && !cache.has(profile)) cache.delete(cache.keys().next().value!);
      cache.set(profile, cards); return cards;
    } finally { await directory.close(); }
  } };
}
