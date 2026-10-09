// The bounded actions of a shared tab, checked again here before any CDP command: the native channel
// only reaches the browser through them. Same rules as validBrowserAction in protocol/remoteBrowser.ts,
// except `frame`, the Puente's own request for the stream (bridge/test/habitualBrowser.test.ts runs
// both over the same cases). Nothing here forwards a CDP method or parameters chosen by the phone or
// the Puente: `files` fills only the chooser Relay's own tap opened (background.js).

export const EXTENSION_PROTOCOL = 3;

export const LIMITS = Object.freeze({
  urlChars: 2048, textChars: 1000, coord: 20000, scroll: 10000,
  frameMinWidth: 64, frameMaxWidth: 1600, frameQuality: 60, frameQualityMin: 20, frameQualityMax: 85,
  // Decoded JPEG bytes per frame (REMOTE_LIMITS.browserFrameBytes): a larger one fails, never sent.
  frameMaxBytes: 700000,
  tabs: 100, titleChars: 300,
  filePaths: 10, pathBytes: 4096,
  // Finished downloads waiting for the Puente to ask; the oldest goes first when more arrive.
  downloads: 20,
});

const FRAME_VIEWPORT_RETRIES = 10;

// windowsVirtualKeyCode is what makes Chrome act on the key (submit, delete, move the caret).
const KEYS = Object.freeze({
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
});

/** A failure the Puente maps to a fixed error; `limitation` also marks the tab. */
export class Failure extends Error {
  constructor(code, limitation = null) {
    super(code);
    this.code = code;
    this.limitation = limitation;
  }
}

const plain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v, keys, optional = []) => keys.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => keys.includes(k) || optional.includes(k));
const number = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v, min, max) => Number.isInteger(v) && number(v, min, max);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v.isWellFormed();
/** An absolute path of the Server without NUL, at most pathBytes in UTF-8. */
export const serverPath = (v) => typeof v === 'string' && v.startsWith('/') && !v.includes('\0') && v.isWellFormed() && new TextEncoder().encode(v).length <= LIMITS.pathBytes;

export function httpUrl(value) {
  if (!text(value, LIMITS.urlChars)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Exactly one known action with its fields in range, as a fresh object; null otherwise. */
export function validateAction(a) {
  if (!plain(a)) return null;
  const L = LIMITS;
  switch (a.type) {
    case 'navigate': return exact(a, ['type', 'url']) && httpUrl(a.url) ? { type: 'navigate', url: a.url } : null;
    case 'back': case 'forward': case 'reload': return exact(a, ['type']) ? { type: a.type } : null;
    case 'tap': return exact(a, ['type', 'x', 'y']) && number(a.x, 0, L.coord) && number(a.y, 0, L.coord) ? { type: 'tap', x: a.x, y: a.y } : null;
    case 'scroll':
      return exact(a, ['type', 'x', 'y', 'dx', 'dy']) && number(a.x, 0, L.coord) && number(a.y, 0, L.coord) && number(a.dx, -L.scroll, L.scroll) && number(a.dy, -L.scroll, L.scroll)
        ? { type: 'scroll', x: a.x, y: a.y, dx: a.dx, dy: a.dy } : null;
    case 'text': return exact(a, ['type', 'text']) && text(a.text, L.textChars) ? { type: 'text', text: a.text } : null;
    case 'key': return exact(a, ['type', 'key']) && typeof a.key === 'string' && Object.hasOwn(KEYS, a.key) ? { type: 'key', key: a.key } : null;
    case 'frame': {
      if (!exact(a, ['type'], ['maxWidth', 'quality'])) return null;
      const maxWidth = a.maxWidth ?? L.frameMaxWidth;
      const quality = a.quality ?? L.frameQuality;
      return integer(maxWidth, L.frameMinWidth, L.frameMaxWidth) && integer(quality, L.frameQualityMin, L.frameQualityMax) ? { type: 'frame', maxWidth, quality } : null;
    }
    case 'dialog':
      if (!exact(a, ['type', 'accept'], ['text']) || typeof a.accept !== 'boolean') return null;
      if (a.text === undefined) return { type: 'dialog', accept: a.accept };
      return typeof a.text === 'string' && a.text.length <= L.textChars && a.text.isWellFormed() ? { type: 'dialog', accept: a.accept, text: a.text } : null;
    case 'files':
      return exact(a, ['type', 'paths']) && Array.isArray(a.paths) && a.paths.length > 0 && a.paths.length <= L.filePaths && a.paths.every(serverPath)
        ? { type: 'files', paths: [...a.paths] } : null;
    default: return null;
  }
}

function mouse(send, type, x, y, extra = {}) {
  return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}

async function moveInHistory(send, step) {
  const { currentIndex, entries } = await send('Page.getNavigationHistory', {});
  const entry = entries[currentIndex + step];
  if (!entry) return { moved: false };
  await send('Page.navigateToHistoryEntry', { entryId: entry.id });
  return { moved: true };
}

/**
 * Runs one validated action through `send(method, params)`, chrome.debugger on the shared tab.
 * `chooser` is the file chooser Relay's tap opened on it, the only one `files` may fill.
 */
export async function perform(a, send, chooser = null) {
  switch (a.type) {
    case 'navigate': {
      const { errorText } = await send('Page.navigate', { url: a.url });
      if (errorText) throw new Failure('failed');
      return {};
    }
    case 'back': return moveInHistory(send, -1);
    case 'forward': return moveInHistory(send, 1);
    case 'reload':
      await send('Page.reload', {});
      return {};
    case 'tap':
      await mouse(send, 'mouseMoved', a.x, a.y, { button: 'none', clickCount: 0 });
      await mouse(send, 'mousePressed', a.x, a.y);
      await mouse(send, 'mouseReleased', a.x, a.y);
      return {};
    case 'scroll':
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: a.x, y: a.y, deltaX: a.dx, deltaY: a.dy });
      return {};
    case 'text':
      await send('Input.insertText', { text: a.text });
      return {};
    case 'key': {
      const k = KEYS[a.key];
      const common = { key: a.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
      await send('Input.dispatchKeyEvent', k.text ? { type: 'keyDown', text: k.text, ...common } : { type: 'rawKeyDown', ...common });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
      return {};
    }
    case 'frame': {
      // The viewport reads 0x0 for a moment right after the first attach, while the "debugging this
      // browser" bar resizes the page (#78). Retry briefly, then answer it as retryable.
      let v;
      for (let attempt = 0; ; attempt++) {
        ({ cssVisualViewport: v } = await send('Page.getLayoutMetrics', {}));
        if (v.clientWidth > 0 && v.clientHeight > 0) break;
        if (attempt === FRAME_VIEWPORT_RETRIES) throw new Failure('frame_unavailable');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const scale = Math.min(1, a.maxWidth / v.clientWidth);
      const { data } = await send('Page.captureScreenshot', {
        format: 'jpeg', quality: a.quality,
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
      });
      const bytes = (data.length * 3) / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (bytes > LIMITS.frameMaxBytes) throw new Failure('frame_too_large');
      // The viewport in CSS pixels, the coordinates of a tap; the image's own size is in the JPEG.
      return { data, viewport: { width: Math.max(1, Math.round(v.clientWidth)), height: Math.max(1, Math.round(v.clientHeight)) } };
    }
    case 'dialog':
      await send('Page.handleJavaScriptDialog', a.text === undefined ? { accept: a.accept } : { accept: a.accept, promptText: a.text });
      return {};
    case 'files':
      if (!chooser) throw new Failure('no_chooser');
      if (!chooser.multiple && a.paths.length > 1) throw new Failure('invalid');
      await send('DOM.setFileInputFiles', { files: a.paths, backendNodeId: chooser.backendNodeId });
      return {};
  }
}

/** chrome.debugger's error text as a limitation of the tab; null when it is not one. */
export function limitationOf(message) {
  if (/another debugger is already attached/i.test(message)) return 'debugger_busy';
  if (/cannot access a (chrome|chrome-extension|devtools)/i.test(message)) return 'internal_page';
  if (/wasn't found|was not found/i.test(message)) return 'method_unavailable';
  if (/cannot access|cannot attach|not allowed|policy/i.test(message)) return 'restricted';
  return null;
}
