import { BOARD_MAX_AGENTS } from '../../protocol/board.ts';
import { BOARD_WEB_BUNDLE_MAX_BYTES, BOARD_WEB_MAX_CONSUMERS, BOARD_WEB_SERVER_MAX_BYTES } from '../../protocol/boardWeb.ts';
import type { Hermes } from './hermes.ts';
import { BoardWebError } from './boardWebReader.ts';
import type { BoardWebSnapshot } from './boardWebReader.ts';
interface Entry { snapshot: BoardWebSnapshot; users: number; retired: boolean; disposal?: Promise<void> }
const key = (agent: string, bundle: string, revision: string) => `${agent}/${bundle}/${revision}`;
export class BoardWeb {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private consumers = 0;
  private building = false;
  private closed = false;
  private hermes: Hermes;
  constructor(hermes: Hermes) { this.hermes = hermes; }
  private async references(guard: () => void) {
    guard(); const profiles = await this.hermes.profiles(); guard();
    if (profiles.length > BOARD_MAX_AGENTS || !this.hermes.board || !this.hermes.boardWeb) throw new BoardWebError('board_web_unavailable', 404);
    const refs = new Set<string>();
    for (const profile of profiles) {
      try {
        const cards = await this.hermes.board.read(profile.id); guard();
        for (const card of cards) if (card.content.type === 'web' && card.status !== 'error' && card.state !== 'error') refs.add(key(profile.id, card.content.bundleRef, card.content.revision));
      } catch { guard(); }
    }
    return refs;
  }
  private async prune(refs: Set<string>) {
    for (const [id, entry] of this.entries) {
      if (!refs.has(id)) entry.retired = true;
      if (entry.retired && !entry.users) {
        // Retiring FDs remain part of the byte budget until disposal completes.
        entry.disposal ??= entry.snapshot.dispose().then(() => {
          if (this.entries.get(id) === entry) {
            this.entries.delete(id); this.bytes -= entry.snapshot.byteLength;
          }
        });
        await entry.disposal;
      }
    }
  }
  async read<T>(agent: string, bundle: string, revision: string, guard: () => void, consume: (snapshot: BoardWebSnapshot) => Promise<T>): Promise<T> {
    const check = () => { guard(); if (this.closed) throw new BoardWebError('board_web_unavailable', 404); };
    check(); if (this.consumers >= BOARD_WEB_MAX_CONSUMERS) throw new BoardWebError('board_web_busy', 429);
    this.consumers++; let entry: Entry | undefined;
    try {
      const id = key(agent, bundle, revision); const refs = await this.references(check); check(); await this.prune(refs); check();
      if (!refs.has(id)) throw new BoardWebError('board_web_unavailable', 404);
      entry = this.entries.get(id);
      if (entry?.retired) throw new BoardWebError('board_web_changed', 409);
      if (!entry) {
        if (this.building || this.bytes + BOARD_WEB_BUNDLE_MAX_BYTES > BOARD_WEB_SERVER_MAX_BYTES) throw new BoardWebError('board_web_busy', 429);
        this.building = true; this.bytes += BOARD_WEB_BUNDLE_MAX_BYTES;
        let snapshot: BoardWebSnapshot | undefined;
        try {
          snapshot = await this.hermes.boardWeb!.snapshot(agent, bundle, revision, check); check();
          const current = await this.references(check); check();
          if (!current.has(id)) throw new BoardWebError('board_web_changed', 409);
          await snapshot.verify(check); check();
          entry = { snapshot, users: 0, retired: false }; this.entries.set(id, entry);
          this.bytes += snapshot.byteLength; snapshot = undefined;
        } finally {
          try { if (snapshot) await snapshot.dispose(); } finally { this.bytes -= BOARD_WEB_BUNDLE_MAX_BYTES; this.building = false; }
        }
      }
      entry.users++;
      try {
        await entry.snapshot.verify(check); check();
        const current = await this.references(check); check();
        if (!current.has(id)) { entry.retired = true; throw new BoardWebError('board_web_changed', 409); }
        return await consume(entry.snapshot);
      } catch (error) { if (error instanceof BoardWebError && error.code === 'board_web_invalid') entry.retired = true; throw error; }
      finally { entry.users--; }
    } finally {
      this.consumers--;
      await this.prune(new Set([...this.entries].filter(([, value]) => !value.retired && !this.closed).map(([id]) => id)));
    }
  }
  async close() { this.closed = true; await this.prune(new Set()); }
}
