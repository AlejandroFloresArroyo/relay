// Additive wire contract. Protocol 2 and this capability are negotiated independently.
export const BOARD_WEB_HEADER = 'X-Relay-Board-Web';
export const BOARD_WEB_VERSION = '1';
export const BOARD_WEB_MANIFEST_MAX_BYTES = 16_384;
export const BOARD_WEB_MAX_FILES = 32;
export const BOARD_WEB_FILE_MAX_BYTES = 262_144;
export const BOARD_WEB_BUNDLE_MAX_BYTES = 1_048_576;
export const BOARD_WEB_SERVER_MAX_BYTES = 8_388_608;
export const BOARD_WEB_MAX_CONSUMERS = 32;
export const BOARD_WEB_ENTRY = 'index.html';
export const BOARD_WEB_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
export const BOARD_WEB_ASSET_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]*\\.(html|js|css|png|jpg|jpeg|webp)$';
export const BOARD_WEB_MIME = {
  html: 'text/html', js: 'application/javascript', css: 'text/css',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
} as const;
export interface WebBoardContent { type: 'web'; bundleRef: string; revision: string }
export interface BoardWebFile { name: string; mime: (typeof BOARD_WEB_MIME)[keyof typeof BOARD_WEB_MIME]; bytes: number; sha256: string }
export interface BoardWebManifest { schemaVersion: 1; entry: typeof BOARD_WEB_ENTRY; files: BoardWebFile[] }
// revision = SHA256(UTF8(JSON.stringify({schemaVersion:1,entry:'index.html',files}))).
// files are sorted by ASCII name, with each object's keys ordered name,mime,bytes,sha256.
// Unknown fields, duplicate names and noncanonical scalar types are rejected before hashing.
export interface BoardWebManifestResponse { bundleRef: string; revision: string; manifest: BoardWebManifest }
export type BoardWebErrorCode = 'board_web_unsupported' | 'board_web_invalid' | 'board_web_unavailable' | 'board_web_changed' | 'board_web_busy';
export const BOARD_WEB_MESSAGES: Record<BoardWebErrorCode, string> = {
  board_web_unsupported: 'El Puente no admite esta versión de contenido web.',
  board_web_invalid: 'La publicación web no es válida o no se puede leer.',
  board_web_unavailable: 'Esta Tarjeta no tiene contenido web disponible.',
  board_web_changed: 'El contenido web cambió; actualiza el Tablero.',
  board_web_busy: 'El contenido web está ocupado. Reintenta más tarde.',
};
export const BOARD_WEB_LEGACY_TEXT = 'Esta Tarjeta requiere soporte de contenido web. Actualiza Relay para verla.';
