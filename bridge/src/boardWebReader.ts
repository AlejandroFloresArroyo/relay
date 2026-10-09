import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BOARD_WEB_ID_PATTERN, BOARD_WEB_MANIFEST_MAX_BYTES, BOARD_WEB_MESSAGES } from '../../protocol/boardWeb.ts';
import type { BoardWebErrorCode, BoardWebManifest } from '../../protocol/boardWeb.ts';
import { parseBoardWebManifest, canonicalBoardWebManifest } from '../../protocol/boardWebValidation.ts';
export class BoardWebError extends Error {
  readonly code: BoardWebErrorCode; readonly status: number;
  constructor(code: BoardWebErrorCode = 'board_web_invalid', status = 503) { super(BOARD_WEB_MESSAGES[code]); this.code = code; this.status = status; }
}
export interface BoardWebSnapshot { revision: string; manifest: BoardWebManifest; byteLength: number; assets: ReadonlyMap<string, Buffer>; verify(guard: () => void): Promise<void>; dispose(): Promise<void> }
export interface HermesBoardWeb { snapshot(profile: string, bundle: string, revision: string, guard: () => void): Promise<BoardWebSnapshot> }
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const unchanged = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const invalid = (): never => { throw new BoardWebError(); };
interface Pin { file: FileHandle; stat: BigIntStats; name: string }
export function createBoardWebReader(profileHome: (profile: string) => string): HermesBoardWeb {
  return { async snapshot(profile, bundle, revision, guard) {
    const directories: Pin[] = [], files: Pin[] = []; let retained = false;
    const close = async () => { for (const pin of files) await pin.file.close(); for (const pin of [...directories].reverse()) await pin.file.close(); };
    try {
      guard();
      if (process.platform !== 'linux' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || !new RegExp(BOARD_WEB_ID_PATTERN).test(bundle) || !/^[a-f0-9]{64}$/.test(revision)) invalid();
      const home = profileHome(profile);
      if (!path.isAbsolute(home) || home === '/' || path.resolve(home) !== home || home.length > 4096 || home.split('/').length > 64 || /[\x00-\x1f\x7f]/.test(home)) invalid();
      for (const name of ['/', ...home.split('/').filter(Boolean), 'relay-board-web', bundle, revision]) {
        guard(); const file = await fs.open(directories.length ? `/proc/self/fd/${directories.at(-1)!.file.fd}/${name}` : '/', directoryFlags);
        const pin = { file, name, stat: undefined as unknown as BigIntStats }; directories.push(pin); guard();
        pin.stat = await file.stat({ bigint: true }); guard(); if (!pin.stat.isDirectory()) invalid();
      }
      const directory = directories.at(-1)!;
      async function verify(check = guard) {
        for (let i = 0; i < directories.length; i++) {
          const pin = directories[i]; check();
          const entry = await fs.open(i ? `/proc/self/fd/${directories[i - 1].file.fd}/${pin.name}` : '/', directoryFlags);
          try {
            check(); const named = await entry.stat({ bigint: true }); check(); const held = await pin.file.stat({ bigint: true }); check();
            if (!same(pin.stat, named) || !same(pin.stat, held) || (i === directories.length - 1 && !unchanged(pin.stat, held))) invalid();
          } finally { await entry.close(); }
        }
        for (const pin of files) {
          check(); const entry = await fs.open(`/proc/self/fd/${directory.file.fd}/${pin.name}`, fileFlags);
          try {
            check(); const named = await entry.stat({ bigint: true }); check(); const held = await pin.file.stat({ bigint: true }); check();
            if (!unchanged(pin.stat, named) || !unchanged(pin.stat, held)) invalid();
          } finally { await entry.close(); }
        }
      }
      async function read(name: string, limit: number): Promise<Buffer> {
        guard(); const file = await fs.open(`/proc/self/fd/${directory.file.fd}/${name}`, fileFlags);
        const pin = { file, name, stat: undefined as unknown as BigIntStats }; files.push(pin); guard();
        pin.stat = await file.stat({ bigint: true }); guard();
        if (!pin.stat.isFile() || pin.stat.nlink !== 1n || pin.stat.size < 1n || pin.stat.size > BigInt(limit) || pin.stat.uid !== BigInt(process.getuid!())) invalid();
        const buffer = Buffer.alloc(Number(pin.stat.size) + 1); let length = 0;
        while (length < buffer.length) {
          guard(); const result = await file.read(buffer, length, buffer.length - length, length); guard();
          if (!result.bytesRead) break; length += result.bytesRead;
        }
        const after = await file.stat({ bigint: true }); guard();
        if (BigInt(length) !== pin.stat.size || !unchanged(pin.stat, after)) invalid();
        return buffer.subarray(0, length);
      }
      const raw = await read('manifest.json', BOARD_WEB_MANIFEST_MAX_BYTES); guard();
      const manifest = parseBoardWebManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      if (!manifest) throw new BoardWebError();
      if (createHash('sha256').update(canonicalBoardWebManifest(manifest)).digest('hex') !== revision) invalid();
      const assets = new Map<string, Buffer>(); let byteLength = 0;
      for (const asset of manifest.files) {
        const bytes = await read(asset.name, asset.bytes); guard();
        if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) invalid();
        assets.set(asset.name, bytes); byteLength += bytes.length;
      }
      await verify(); guard(); retained = true; let disposed = false;
      return { revision, manifest, assets, byteLength,
        async verify(check) {
          try { check(); if (disposed) invalid(); await verify(check); check(); }
          catch (error) { check(); if (error instanceof BoardWebError) throw error; return invalid(); }
        },
        async dispose() { if (disposed) return; disposed = true; await close(); },
      };
    } catch (error) {
      guard(); if (error instanceof BoardWebError) throw error; return invalid();
    } finally {
      if (!retained) await close();
    }
  } };
}
