import type { BoardPage } from '../../../protocol/board.ts';
import { BOARD_WEB_HEADER, BOARD_WEB_VERSION, BOARD_WEB_ID_PATTERN, BOARD_WEB_LEGACY_TEXT, BOARD_WEB_MANIFEST_MAX_BYTES } from '../../../protocol/boardWeb.ts';
import type { BoardWebManifest, WebBoardContent } from '../../../protocol/boardWeb.ts';
import { parseBoardWebManifest } from '../../../protocol/boardWebValidation.ts';
import { RelayError } from './client.ts';
export interface DownloadedBoardWeb { revision: string; manifest: BoardWebManifest; assets: { name: string; bytes: Uint8Array }[] }
export interface BoardWebClient {
  page(signal: AbortSignal): Promise<{ page: BoardPage; supported: boolean }>;
  bundle(agentId: string, content: WebBoardContent, signal: AbortSignal): Promise<DownloadedBoardWeb>;
}
export type BoardWebRequest = (path: string, signal: AbortSignal) => Promise<Response>;
const unavailable = () => new RelayError('unavailable', 'La respuesta del Puente sobre el contenido web del Agente no es válida.');
// React Native Android's AbortSignal lacks throwIfAborted.
export function checkBoardWebSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new RelayError('cancelled', 'Lectura retirada.');
}
/** Bounded streaming only: unsupported native transports cannot fall back to an unbounded body. */
export async function boardWebBytes(response: Response, limit: number, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    checkBoardWebSignal(signal);
    const length = response.headers?.get('Content-Length');
    if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) throw unavailable();
    if (!response.body) throw unavailable();
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    const payload = async () => {
      while (true) {
        checkBoardWebSignal(signal); const chunk = await reader!.read(); checkBoardWebSignal(signal);
        if (chunk.done) break;
        size += chunk.value.byteLength; if (size > limit) throw unavailable();
        chunks.push(chunk.value);
      }
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    };
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(new RelayError('cancelled', 'Lectura retirada.'));
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => reject(new RelayError('timeout', 'Contenido web sin respuesta.')), timeoutMs);
    });
    const result = await Promise.race([payload(), interrupted]); checkBoardWebSignal(signal); return result;
  } catch (error) { if (signal.aborted) throw new RelayError('cancelled', 'Lectura retirada.'); if (error instanceof RelayError) throw error; throw unavailable(); }
  finally {
    clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* A pending native read is cancelled asynchronously. */ } }
  }
}
export function createBoardWebClient(request: BoardWebRequest, timeoutMs: number): BoardWebClient {
  let negotiated = false;
  const parse = (bytes: Uint8Array): unknown => {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw unavailable(); }
  };
  async function checked(response: Response, signal: AbortSignal, limit: number, capability: boolean) {
    checkBoardWebSignal(signal);
    if (!response.ok) {
      const value = parse(await boardWebBytes(response, BOARD_WEB_MANIFEST_MAX_BYTES, signal, timeoutMs));
      const code = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error ? value.error.code : null;
      const safe = ['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required', 'protocol_upgrade_required', 'tailnet_required', 'rate_limited'] as const;
      const known = safe.find(c => c === code); throw known ? new RelayError(known, 'El Puente rechazó la lectura de contenido web.', response.status) : unavailable();
    }
    if (capability && response.headers?.get(BOARD_WEB_HEADER) !== BOARD_WEB_VERSION) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
    return boardWebBytes(response, limit, signal, timeoutMs);
  }
  return {
    async page(signal) {
      negotiated = false;
      const response = await request('/v1/board', signal), supported = response.headers?.get(BOARD_WEB_HEADER) === BOARD_WEB_VERSION;
      const value = parse(await checked(response, signal, 33554432, false)); checkBoardWebSignal(signal);
      if (!value || typeof value !== 'object' || !('cards' in value) || !Array.isArray(value.cards) || value.cards.length > 1024 || !('failedAgents' in value) || !Array.isArray(value.failedAgents) || !('observedAt' in value) || !Number.isSafeInteger(value.observedAt)) throw unavailable();
      const page = value as BoardPage;
      for (const card of page.cards) {
        if (card.content?.type === 'web') {
          const content = card.content;
          if (Object.keys(content).length !== 3 || typeof content.bundleRef !== 'string' || typeof content.revision !== 'string' || !new RegExp(BOARD_WEB_ID_PATTERN).test(content.bundleRef) || !/^[a-f0-9]{64}$/.test(content.revision)) throw unavailable();
          if (!supported) card.content = { type: 'text', text: BOARD_WEB_LEGACY_TEXT };
        }
      }
      negotiated = supported; return { page, supported };
    },
    async bundle(agentId, content, signal) {
      checkBoardWebSignal(signal);
      if (!negotiated || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId) || !new RegExp(BOARD_WEB_ID_PATTERN).test(content.bundleRef) || !/^[a-f0-9]{64}$/.test(content.revision)) throw unavailable();
      const path = `/v1/agents/${agentId}/board-web/${content.bundleRef}/${content.revision}`;
      const raw = parse(await checked(await request(path + '/manifest', signal), signal, BOARD_WEB_MANIFEST_MAX_BYTES + 256, true)); checkBoardWebSignal(signal);
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length !== 3 || !('bundleRef' in raw) || raw.bundleRef !== content.bundleRef || !('revision' in raw) || raw.revision !== content.revision || !('manifest' in raw)) throw unavailable();
      const manifest = parseBoardWebManifest(raw.manifest); if (!manifest) throw unavailable();
      const assets: DownloadedBoardWeb['assets'] = [];
      for (const file of manifest.files) {
        if (!negotiated) throw unavailable(); checkBoardWebSignal(signal);
        const response = await request(path + '/assets/' + file.name, signal);
        const bytes = await checked(response, signal, file.bytes, true); checkBoardWebSignal(signal);
        if (bytes.byteLength !== file.bytes || response.headers.get('Content-Type') !== file.mime) throw unavailable();
        assets.push({ name: file.name, bytes });
      }
      return { revision: content.revision, manifest, assets };
    },
  };
}
