// #114: a Servidor file attached to a Conversación by reference (docs/research/chat-file-reference-114.md).
// The app sends only paths; the Puente checks them and gives Hermes a note to read the file itself.
import { CHAT_FILE_MAX_COUNT, CHAT_FILES_CAPABILITY_NAME } from '../../../protocol/protocol.ts';
import type { RemoteFileEntry } from '../../../protocol/remoteFiles.ts';
import { negotiate, type AppCapability } from './remoteCapabilities.ts';

/** The contract version this app implements: a code constant, never the APK version. */
export const APP_CHAT_FILES_CAPABILITY: AppCapability = { version: 1, minBridgeVersion: 1 };

/** An older Puente refuses the `files` key: only a compatible advertisement lets the app send it. */
export function chatFilesOffered(health: unknown): boolean {
  return negotiate(health, CHAT_FILES_CAPABILITY_NAME, APP_CHAT_FILES_CAPABILITY).state === 'available';
}

/** What the Puente accepts: a regular file, or a link to one, whose name Relay can address. */
export function attachable(entry: Pick<RemoteFileEntry, 'nameUtf8' | 'type' | 'link'>): boolean {
  return entry.nameUtf8 && (entry.type === 'file' || (entry.type === 'symlink' && entry.link?.type === 'file'));
}

/**
 * Whether a drag from the Archivos panel ends over the Conversación column, which lies right to its
 * left: x is the finger relative to the panel's left edge, so the column is [-column, 0).
 * ponytail: horizontal only; a release high over the chat header counts too. Add a vertical bound from layout if that matters on the device.
 */
export function overConversation({ inset, grabX, dx, column }: { inset: number; grabX: number; dx: number; column: number }): boolean {
  const x = inset + grabX + dx;
  return Number.isFinite(x) && column > 0 && x < 0 && x >= -column;
}

/** The list with `path` once; null when it is already full. */
export function addFile(paths: readonly string[], path: string): string[] | null {
  if (paths.includes(path)) return [...paths];
  return paths.length >= CHAT_FILE_MAX_COUNT ? null : [...paths, path];
}
