// Bounded action protocol between the phone and a Server browser page.
// The same module runs in the lab Puente (dedicated browser over CDP) and inside the extension
// (usual browser over chrome.debugger), so both modes accept exactly the same actions.
// Nothing here forwards a CDP method or parameters chosen by the phone.

export const LIMITS = Object.freeze({
  urlChars: 2048,
  textChars: 1000,
  coord: 20000,
  scroll: 10000,
  frameMaxWidth: 1600,
  frameMinWidth: 64,
  frameQuality: 60,
  frameQualityMin: 20,
  frameQualityMax: 85,
  // Decoded JPEG bytes per frame. A frame over it fails instead of loading a slow phone link.
  frameMaxBytes: 700_000,
  filePaths: 10,
  pathChars: 4096,
});

const FRAME_VIEWPORT_RETRIES = 10;

// windowsVirtualKeyCode is what makes Chrome act on the key (submit, delete, move caret).
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

function invalid(reason) {
  return new Error(`invalid action: ${reason}`);
}

function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(name);
  return value;
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value)) throw invalid(name);
  return number(value, min, max, name);
}

function string(value, max, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalid(name);
  return value;
}

function httpUrl(value) {
  string(value, LIMITS.urlChars, 'url');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid('url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('url scheme');
  return value;
}

/** Returns a fresh object holding only the fields of a known action, or throws "invalid action". */
export function validateAction(a) {
  if (!a || typeof a !== 'object') throw invalid('not an object');
  switch (a.type) {
    case 'navigate':
      return { type: 'navigate', url: httpUrl(a.url) };
    case 'back':
    case 'forward':
    case 'reload':
      return { type: a.type };
    case 'tap':
      return { type: 'tap', x: number(a.x, 0, LIMITS.coord, 'x'), y: number(a.y, 0, LIMITS.coord, 'y') };
    case 'scroll':
      return {
        type: 'scroll',
        x: number(a.x, 0, LIMITS.coord, 'x'),
        y: number(a.y, 0, LIMITS.coord, 'y'),
        dx: number(a.dx, -LIMITS.scroll, LIMITS.scroll, 'dx'),
        dy: number(a.dy, -LIMITS.scroll, LIMITS.scroll, 'dy'),
      };
    case 'text':
      return { type: 'text', text: string(a.text, LIMITS.textChars, 'text') };
    case 'key':
      if (typeof a.key !== 'string' || !Object.hasOwn(KEYS, a.key)) throw invalid('key');
      return { type: 'key', key: a.key };
    case 'frame':
      return {
        type: 'frame',
        maxWidth: integer(a.maxWidth ?? LIMITS.frameMaxWidth, LIMITS.frameMinWidth, LIMITS.frameMaxWidth, 'maxWidth'),
        quality: integer(a.quality ?? LIMITS.frameQuality, LIMITS.frameQualityMin, LIMITS.frameQualityMax, 'quality'),
      };
    case 'dialog': {
      if (typeof a.accept !== 'boolean') throw invalid('accept');
      const out = { type: 'dialog', accept: a.accept };
      if (a.text !== undefined) out.text = string(a.text, LIMITS.textChars, 'text');
      return out;
    }
    case 'files': {
      // Which Server paths may be offered is the Puente's file-explorer decision, not this module's.
      if (!Array.isArray(a.paths) || a.paths.length === 0 || a.paths.length > LIMITS.filePaths) throw invalid('paths');
      const paths = a.paths.map((p) => {
        string(p, LIMITS.pathChars, 'path');
        if (!p.startsWith('/') || p.includes('\0')) throw invalid('path');
        return p;
      });
      return { type: 'files', backendNodeId: integer(a.backendNodeId, 1, Number.MAX_SAFE_INTEGER, 'backendNodeId'), paths };
    }
    default:
      throw invalid('type');
  }
}

/** Domains and interceptions every controlled page needs before actions and events work. */
export async function prepare(send) {
  await send('Page.enable', {});
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
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

/** Runs one action through `send(method, params)`, the CDP transport of either mode. */
export async function perform(action, send) {
  const a = validateAction(action);
  switch (a.type) {
    case 'navigate': {
      const { errorText } = await send('Page.navigate', { url: a.url });
      if (errorText) throw new Error(`navigation failed: ${errorText}`);
      return {};
    }
    case 'back':
      return moveInHistory(send, -1);
    case 'forward':
      return moveInHistory(send, 1);
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
      // The viewport reads 0x0 for a moment right after the first attach (Chromium 152: the
      // "debugging this browser" bar resizes the page). Retry briefly, then report it as retryable.
      let v;
      for (let attempt = 0; ; attempt++) {
        ({ cssVisualViewport: v } = await send('Page.getLayoutMetrics', {}));
        if (v.clientWidth > 0 && v.clientHeight > 0) break;
        if (attempt === FRAME_VIEWPORT_RETRIES) throw new Error('frame unavailable: page has no viewport yet');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const scale = Math.min(1, a.maxWidth / v.clientWidth);
      const { data } = await send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: a.quality,
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
      });
      const bytes = (data.length * 3) / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (bytes > LIMITS.frameMaxBytes) throw new Error(`frame too large: ${bytes} bytes`);
      return { data, width: Math.round(v.clientWidth * scale), height: Math.round(v.clientHeight * scale), bytes };
    }
    case 'dialog':
      await send('Page.handleJavaScriptDialog', a.text === undefined ? { accept: a.accept } : { accept: a.accept, promptText: a.text });
      return {};
    case 'files':
      await send('DOM.setFileInputFiles', { files: a.paths, backendNodeId: a.backendNodeId });
      return {};
  }
}
