import { BOARD_WEB_ASSET_PATTERN, BOARD_WEB_BUNDLE_MAX_BYTES, BOARD_WEB_ENTRY, BOARD_WEB_FILE_MAX_BYTES, BOARD_WEB_MAX_FILES, BOARD_WEB_MIME } from './boardWeb.ts';
import type { BoardWebManifest, BoardWebFile } from './boardWeb.ts';
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const assetName = new RegExp(BOARD_WEB_ASSET_PATTERN);
export function parseBoardWebManifest(value: unknown): BoardWebManifest | null {
  if (!exact(value, ['schemaVersion', 'entry', 'files']) || value.schemaVersion !== 1 || value.entry !== BOARD_WEB_ENTRY || !Array.isArray(value.files) || !value.files.length || value.files.length > BOARD_WEB_MAX_FILES) return null;
  const files: BoardWebFile[] = []; const names = new Set<string>(); let bytes = 0;
  for (const raw of value.files) {
    if (!exact(raw, ['name', 'mime', 'bytes', 'sha256']) || typeof raw.name !== 'string' || raw.name.length > 64 || !assetName.test(raw.name) || names.has(raw.name)
      || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 1 || Number(raw.bytes) > BOARD_WEB_FILE_MAX_BYTES
      || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) return null;
    const extension = raw.name.split('.').at(-1)! as keyof typeof BOARD_WEB_MIME;
    if (raw.mime !== BOARD_WEB_MIME[extension]) return null;
    bytes += Number(raw.bytes); if (bytes > BOARD_WEB_BUNDLE_MAX_BYTES) return null;
    names.add(raw.name); files.push({ name: raw.name, mime: raw.mime as BoardWebFile['mime'], bytes: Number(raw.bytes), sha256: raw.sha256 });
  }
  if (!names.has(BOARD_WEB_ENTRY)) return null;
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { schemaVersion: 1, entry: BOARD_WEB_ENTRY, files };
}
export const canonicalBoardWebManifest = (manifest: BoardWebManifest): string => JSON.stringify(manifest);
