// The `browser` capability (ADR 0006, docs/relay-v3.md §6): one contract for both modes. The dedicated
// browser (#92) runs in the supervisor over CDP, environment kind 'browser_dedicated', ownership 'own'.
// The habitual one (#93) is reached through the Relay extension, kind 'browser_habitual', ownership
// 'shared': ending it or revoking its device disconnects and keeps the browser and every tab, also
// those Relay opened. Either is addressed by its environment ID, a tab by its `id`. The phone never
// sends a CDP method or parameter: only the bounded actions below, validated here by the Puente
// before anything reaches a browser (and again by the extension). Transport, as for terminals: an SSE
// stream for frames and tab state, plain requests for the rest, all through route(). What a mode
// cannot do answers `remote_unsupported`, never a silent no-op: the habitual browser never closes a
// tab and opens only http(s) pages. Files go through the `files` transfer (#87) in both modes: the
// phone's file is uploaded to the Server first and `files` names it; a download stays on the Server
// and the stream names its path for the phone to download.
// Types, constants and pure checks only; no platform imports.

/** Bounds of every action (docs/research/v3-cdp.md, criterion 5). */
export const BROWSER_LIMITS = {
  urlChars: 2048,
  textChars: 1000,
  /** What a tab reports about itself: a page sets its title and URL. */
  titleChars: 300,
  /** Open tabs of a dedicated browser: its whole list travels in each `tabs` line of the supervisor. */
  dedicatedTabs: 20,
  /** Tabs the extension lists: those the person shared and those Relay opened. */
  habitualTabs: 100,
  /** A download that grows past this is cancelled: a page never fills the Server's disk with one file. */
  downloadBytes: 1_073_741_824,
  /** Tap and scroll positions, in CSS pixels of the viewport. */
  coord: 20_000,
  scroll: 10_000,
  filePaths: 10,
  pathBytes: 4096,
  /** Viewport the phone asks for, in CSS pixels. */
  viewportMin: 64,
  viewportMax: 4096,
  scaleMax: 3,
  qualityMin: 20,
  qualityMax: 85,
  quality: 60,
} as const;

/** The only keys an action may press. */
export const BROWSER_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'] as const;
export type BrowserKey = typeof BROWSER_KEYS[number];

/** POST /v1/remote/browsers/:id/tabs/:tab/action. */
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' } | { type: 'forward' } | { type: 'reload' }
  /** CSS pixels of the tab's viewport, as in the last frame's `viewport`. */
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: BrowserKey }
  /** Answers the tab's open JavaScript dialog; `text` only for a prompt. */
  | { type: 'dialog'; accept: boolean; text?: string }
  /**
   * Fills the tab's open file chooser with files of the Server: existing regular files the account can
   * read. In the habitual browser, only a chooser Relay's own `tap` opened; the person's stay theirs.
   */
  | { type: 'files'; paths: string[] };
/** `moved` only for back and forward: false at the end of the history. */
export interface BrowserActionResult { moved?: boolean }

/** Why a tab cannot be controlled from Relay now, shown with BROWSER_LIMITATION_MESSAGES until it clears. */
export type BrowserLimitation = 'internal_page' | 'debugger_busy' | 'restricted' | 'method_unavailable' | 'canceled_by_user';
export const BROWSER_LIMITATIONS: readonly BrowserLimitation[] = ['internal_page', 'debugger_busy', 'restricted', 'method_unavailable', 'canceled_by_user'];
export const BROWSER_LIMITATION_MESSAGES = {
  internal_page: 'Es una página interna del navegador: Relay no puede controlarla.',
  debugger_busy: 'Las DevTools u otra herramienta de depuración ocupan esta pestaña. Ciérralas en la computadora.',
  restricted: 'El navegador o una política de la organización no dejan controlar esta pestaña.',
  method_unavailable: 'Este navegador no ofrece esta acción. Hazla en la computadora.',
  canceled_by_user: 'Se canceló el control de Relay en la computadora. Vuelve a compartir la pestaña allí para seguir.',
} as const satisfies Record<BrowserLimitation, string>;

export type BrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';
export const BROWSER_DIALOG_TYPES: readonly BrowserDialogType[] = ['alert', 'confirm', 'prompt', 'beforeunload'];

/** A tab of a dedicated browser, or of the habitual one: shared at the computer or opened by Relay. Nothing else is listed. */
export interface BrowserTab {
  /** The browser's own tab ID: a CDP target ID, or the extension's tab number in decimal. */
  id: string;
  url: string;
  title: string;
  /** Actions answer `remote_browser_limited` while it is set; null when the tab takes them. */
  limitation: BrowserLimitation | null;
  /** Relay opened it. In the habitual browser it stays when Relay lets go, like every other tab. */
  createdByRelay: boolean;
  /** A JavaScript dialog waits for an answer: every other action is refused until then. */
  dialog: { type: BrowserDialogType; message: string; defaultPrompt: string } | null;
  /** The page opened a file chooser a `files` action fills; in the habitual browser, only one Relay's tap opened. */
  fileChooser: { multiple: boolean } | null;
}
/**
 * GET /v1/remote/browsers/:id/tabs. POST …/tabs `{ url? }` opens one and answers it (the habitual
 * browser in the background, and only with a `url`); DELETE …/tabs/:tab closes it (dedicated only).
 * URLs and page content travel only in bodies, never in a path or a query.
 */
export interface BrowserTabList { tabs: BrowserTab[] }
export interface BrowserOpenRequest { url?: string }

/**
 * POST /v1/remote/browsers/:id/view: what the stream `channel` shows. A dedicated tab renders at `width`
 * × `height` CSS pixels; the habitual one keeps the size of the person's window, and `width` × `scale`
 * only bounds its frame's width. Frames come at up to `scale` device pixels per CSS pixel; taps use CSS pixels.
 */
export interface BrowserViewRequest { channel: string; tab: string; width: number; height: number; scale?: number; quality?: number }
/** POST /v1/remote/browsers/:id/ack: the last frame received. The next frame waits for it. */
export interface BrowserAckRequest { channel: string; seq: number }

// GET /v1/remote/browsers/:id/frames: text/event-stream, one JSON object per `data:` line. One stream
// per browser: opening another replaces it (`closed: replaced`). Frames go one at a time; a frame
// replaces the previous one, so nothing piles up without an ack and there is no gap.
export type BrowserStreamEvent =
  | { type: 'open'; channel: string }
  /** JPEG in base64, at most REMOTE_LIMITS.browserFrameBytes decoded. `viewport` is in CSS pixels. */
  | { type: 'frame'; seq: number; tab: string; data: string; viewport: { width: number; height: number } }
  /** A frame over the limit was dropped: ask for a lower scale or quality. */
  | { type: 'oversized'; tab: string }
  /** Every change of a tab, its dialog, its limitation or its file chooser: the whole list again. */
  | { type: 'tabs'; tabs: BrowserTab[] }
  /**
   * A download that finished: the file stays on the Server at `path`, for the files transfer. In the
   * habitual browser, only a shared tab's (its page is the download's referrer), to every open stream.
   */
  | { type: 'download'; name: string; path: string }
  | { type: 'closed'; reason: 'replaced' | 'exited' };

/** A browser's tab ID: CDP target IDs, extension tab numbers. */
export const BROWSER_TAB_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const within = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed();

/** An absolute http(s) URL of at most urlChars: never chrome://, file:, data:, javascript: or the like. */
export function browserUrl(value: unknown): value is string {
  if (!text(value, BROWSER_LIMITS.urlChars)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** What a tab may be controlled on: a web page, or a blank one ('' until a new tab reports its URL). */
export function controllableUrl(url: string): boolean {
  return url === '' || url === 'about:blank' || browserUrl(url);
}

/** An absolute Server path without NUL, at most BROWSER_LIMITS.pathBytes in UTF-8. */
function serverPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.isWellFormed()
    && new TextEncoder().encode(value).length <= BROWSER_LIMITS.pathBytes;
}

/** Exactly one known action, as a fresh object; anything else is null. */
export function validBrowserAction(value: unknown): BrowserAction | null {
  if (!plain(value)) return null;
  const a = value;
  switch (a.type) {
    case 'navigate': return keys(a, ['type', 'url']) && browserUrl(a.url) ? { type: 'navigate', url: a.url } : null;
    case 'back': case 'forward': case 'reload': return keys(a, ['type']) ? { type: a.type } : null;
    case 'tap': return keys(a, ['type', 'x', 'y']) && within(a.x, 0, BROWSER_LIMITS.coord) && within(a.y, 0, BROWSER_LIMITS.coord) ? { type: 'tap', x: a.x, y: a.y } : null;
    case 'scroll':
      return keys(a, ['type', 'x', 'y', 'dx', 'dy']) && within(a.x, 0, BROWSER_LIMITS.coord) && within(a.y, 0, BROWSER_LIMITS.coord)
        && within(a.dx, -BROWSER_LIMITS.scroll, BROWSER_LIMITS.scroll) && within(a.dy, -BROWSER_LIMITS.scroll, BROWSER_LIMITS.scroll)
        ? { type: 'scroll', x: a.x, y: a.y, dx: a.dx, dy: a.dy } : null;
    case 'text': return keys(a, ['type', 'text']) && text(a.text, BROWSER_LIMITS.textChars) ? { type: 'text', text: a.text } : null;
    case 'key': return keys(a, ['type', 'key']) && (BROWSER_KEYS as readonly unknown[]).includes(a.key) ? { type: 'key', key: a.key as BrowserKey } : null;
    case 'dialog':
      if (!keys(a, ['type', 'accept'], ['text']) || typeof a.accept !== 'boolean') return null;
      if (a.text === undefined) return { type: 'dialog', accept: a.accept };
      return typeof a.text === 'string' && a.text.length <= BROWSER_LIMITS.textChars && a.text.isWellFormed() ? { type: 'dialog', accept: a.accept, text: a.text } : null;
    case 'files':
      return keys(a, ['type', 'paths']) && Array.isArray(a.paths) && a.paths.length > 0 && a.paths.length <= BROWSER_LIMITS.filePaths && a.paths.every(serverPath)
        ? { type: 'files', paths: [...a.paths] } : null;
    default: return null;
  }
}

/** What a stream shows: a BrowserViewRequest without its channel, with scale and quality resolved. */
export interface BrowserView { tab: string; width: number; height: number; scale: number; quality: number }

export function validBrowserView(value: unknown): value is BrowserView {
  if (!plain(value) || !keys(value, ['tab', 'width', 'height', 'scale', 'quality'])) return false;
  const whole = (field: unknown, min: number, max: number) => Number.isSafeInteger(field) && within(field, min, max);
  return typeof value.tab === 'string' && new RegExp(BROWSER_TAB_PATTERN).test(value.tab)
    && whole(value.width, BROWSER_LIMITS.viewportMin, BROWSER_LIMITS.viewportMax) && whole(value.height, BROWSER_LIMITS.viewportMin, BROWSER_LIMITS.viewportMax)
    && whole(value.scale, 1, BROWSER_LIMITS.scaleMax) && whole(value.quality, BROWSER_LIMITS.qualityMin, BROWSER_LIMITS.qualityMax);
}

/** Exactly a BrowserTab within BROWSER_LIMITS: what the Puente passes on from either browser. */
export function validBrowserTab(value: unknown): value is BrowserTab {
  if (!plain(value) || !keys(value, ['id', 'url', 'title', 'limitation', 'createdByRelay', 'dialog', 'fileChooser'])) return false;
  const { id, url, title, limitation, createdByRelay, dialog, fileChooser } = value;
  const bounded = (field: unknown, max: number) => typeof field === 'string' && field.length <= max;
  return typeof id === 'string' && new RegExp(BROWSER_TAB_PATTERN).test(id) && bounded(url, BROWSER_LIMITS.urlChars) && bounded(title, BROWSER_LIMITS.titleChars)
    && (limitation === null || BROWSER_LIMITATIONS.includes(limitation as BrowserLimitation)) && typeof createdByRelay === 'boolean'
    && (dialog === null || (plain(dialog) && keys(dialog, ['type', 'message', 'defaultPrompt']) && BROWSER_DIALOG_TYPES.includes(dialog.type as BrowserDialogType)
      && bounded(dialog.message, BROWSER_LIMITS.textChars) && bounded(dialog.defaultPrompt, BROWSER_LIMITS.textChars)))
    && (fileChooser === null || (plain(fileChooser) && keys(fileChooser, ['multiple']) && typeof fileChooser.multiple === 'boolean'));
}
