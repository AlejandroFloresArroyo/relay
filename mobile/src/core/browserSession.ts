// One browser's page stream on the app's side (protocol/remoteBrowser.ts, ADR 0006 «Lo que fijó la
// integración de #92 y #93»). Every frame is acked as it arrives, so the next one can come; the screen
// shows the last frame of the chosen tab. The page may be touched only while that frame is `live`: the
// stream is connected, the frame belongs to the view last asked for, the tab takes input, and, in the
// habitual browser, frames keep coming. Anything else is a stale image, and input on it is never sent.
// The dedicated browser draws its tab at the size of the view, so a frame of another size is of an
// earlier view even if it comes after the new one was asked for; the habitual one keeps the size of the
// person's window, so its frame's viewport is the page's whatever the view. Closing disconnects; it
// never ends the browser nor closes a tab.
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { BrowserAction, BrowserActionResult, BrowserTab } from '../../../protocol/remoteBrowser.ts';
import { BROWSER_LIMITATION_MESSAGES, BROWSER_LIMITS, BROWSER_TAB_PATTERN, validBrowserTab } from '../../../protocol/remoteBrowser.ts';
import { TERMINAL_CHANNEL_PATTERN } from '../../../protocol/remoteTerminal.ts';
import type { BrowserPort } from './browsers.ts';
import { viewFor, type Size } from './browserView.ts';
import { RemoteFailure } from './remoteClient.ts';
import { BACKOFF_MS, BASE64, sleep, type TerminalLink } from './terminalSession.ts';

export interface BrowserFrame { seq: number; tab: string; data: string; viewport: Size }
export interface BrowserDownload { name: string; path: string }

export interface BrowserState {
  link: TerminalLink;
  tabs: BrowserTab[] | null;
  /** The tab the person chose to view and control; null until they choose one. */
  tab: string | null;
  /** The last frame of the chosen tab: maybe stale, see `live`. */
  frame: BrowserFrame | null;
  /** The frame shows the chosen tab as it is now: the only state in which the page may be touched or typed on. */
  live: boolean;
  /** The habitual browser stopped sending frames: the extension or the computer may be gone. */
  aged: boolean;
  /** Finished downloads: each stays on the Servidor until the person brings it or dismisses it here. */
  downloads: BrowserDownload[];
  /** Why the last thing asked for did not happen. */
  notice: string | null;
}

export interface BrowserSession {
  state(): BrowserState;
  subscribe(listener: () => void): () => void;
  select(tab: string | null): void;
  /** The box the frame is drawn in, in dp, and the screen's density: the view asked for follows them. */
  resize(box: Size, pixelRatio: number): void;
  /** Null when refused here, with nothing sent, or when the Servidor refused it (see `notice`). */
  act(action: BrowserAction): Promise<BrowserActionResult | null>;
  /** A new tab, chosen at once. The habitual browser needs a `url`. */
  open(url: string | null): Promise<boolean>;
  closeTab(tab: string): Promise<boolean>;
  dismissDownload(path: string): void;
  /** After `replaced` or `failed`: opens the stream again. */
  reconnect(): void;
  close(): void;
}

export interface BrowserSessionOptions {
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The habitual browser sends frames one after another while a tab is shared: none for this long makes the frame stale. */
  staleAfterMs?: number;
  /** The tab chosen in a previous session of this browser: viewed again once listed, never with that session's frame. */
  tab?: string | null;
  /** The dedicated browser: it renders the tab at the view's width × height, and only a frame of that size is current. */
  dedicated?: boolean;
}

/** What needs the frame as it is now: a position on it, or keys for what it shows focused. */
const PAGE_INPUT = new Set<BrowserAction['type']>(['tap', 'scroll', 'text', 'key']);
const CHANNEL = new RegExp(TERMINAL_CHANNEL_PATTERN);
const TAB = new RegExp(BROWSER_TAB_PATTERN);
const FRAME_CHARS = Math.ceil(REMOTE_LIMITS.browserFrameBytes / 3) * 4;
const NOTICES = {
  history: 'No hay más páginas en el historial de esta pestaña.',
  unsupported: 'Relay no puede hacer esto en este navegador o en esta página. Hazlo en la computadora.',
  oversized: 'Esta página no cabe en una captura para el teléfono. Mírala en la computadora.',
  dialog: 'Responde primero al diálogo de la página.',
  gone: 'La pestaña se cerró.',
  unexpected: 'El Puente respondió algo inesperado.',
};
const seqOk = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const within = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

class BadEvent extends Error {}

function readTabs(value: unknown): BrowserTab[] {
  if (!Array.isArray(value) || value.length > BROWSER_LIMITS.habitualTabs || !value.every(validBrowserTab)) throw new BadEvent();
  return value;
}

/** A long text in order, in pieces the contract takes, never splitting a character. */
function pieces(text: string): string[] {
  const all: string[] = [];
  let piece = '';
  for (const char of text) {
    if (piece.length + char.length > BROWSER_LIMITS.textChars) { all.push(piece); piece = ''; }
    piece += char;
  }
  if (piece) all.push(piece);
  return all;
}

export function createBrowserSession(port: BrowserPort, options: BrowserSessionOptions = {}): BrowserSession {
  const wait = options.wait ?? sleep;
  const listeners = new Set<() => void>();
  let link: TerminalLink = { state: 'connecting' };
  let stopped = false;
  let running = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let ending: 'replaced' | 'exited' | null = null;

  let tabs: BrowserTab[] | null = null;
  let chosen: string | null = options.tab ?? null;
  let frame: BrowserFrame | null = null;
  let aged = false;
  let ageTimer: ReturnType<typeof setTimeout> | undefined;
  let downloads: BrowserDownload[] = [];
  let notice: string | null = null;
  let box: Size | null = null;
  let ratio = 1;
  /** Steps down after each `oversized` of the chosen tab (viewFor). */
  let step: 0 | 1 | 2 = 0;

  // Per channel. `epoch` grows with every view sent: a frame counts only for the latest one.
  let channel: string | null = null;
  let sent: { key: string; tab: string; width: number; height: number } | null = null;
  let epoch = 0;
  let frameEpoch = -1;
  let viewing = false;
  let viewAgain = false;
  let received = 0;
  let acked = 0;
  let acking = false;

  const shown = () => tabs?.find((each) => each.id === chosen) ?? null;
  const compute = (): BrowserState => {
    const tab = shown();
    const live = !stopped && link.state === 'connected' && tab !== null && !tab.dialog && !tab.limitation
      && frame !== null && sent !== null && frameEpoch === epoch && !aged;
    return { link, tabs, tab: chosen, frame, live, aged, downloads, notice };
  };
  let snapshot = compute();
  const changed = () => { snapshot = compute(); for (const listener of [...listeners]) listener(); };
  const setLink = (next: TerminalLink) => { link = next; changed(); };

  /** Why it failed, for the screen; a refusal about the tab reads the tabs again, which say which limitation. */
  function trouble(error: unknown) {
    if (!(error instanceof RemoteFailure)) { notice = NOTICES.unexpected; return; }
    if (error.code === 'remote_browser_limited' || error.code === 'remote_conflict' || error.code === 'remote_not_found') refresh();
    notice = error.code === 'remote_unsupported' ? NOTICES.unsupported : error.message;
  }

  function refresh() {
    port.tabs().then((body) => {
      if (!stopped && plain(body)) applyTabs(readTabs(body.tabs));
    }).catch(() => {});
  }

  function applyTabs(list: BrowserTab[]) {
    tabs = list;
    const tab = shown();
    if (chosen !== null && !tab) {
      chosen = null;
      frame = null;
      notice = NOTICES.gone;
    } else if (tab?.limitation) {
      notice = BROWSER_LIMITATION_MESSAGES[tab.limitation];
      // Asked again once it clears.
      sent = null;
    }
    sendView();
    changed();
  }

  function sendView() {
    const tab = shown();
    if (stopped || !channel || !tab || tab.limitation || !box) return;
    const view = { tab: tab.id, ...viewFor(box, ratio, step) };
    const key = JSON.stringify(view);
    if (key === sent?.key) return;
    // One at a time: two views in flight could be applied in either order.
    if (viewing) { viewAgain = true; return; }
    const on = channel;
    sent = { key, tab: tab.id, width: view.width, height: view.height };
    epoch += 1;
    viewing = true;
    changed();
    const settled = (failed: boolean, error?: unknown) => {
      viewing = false;
      const again = viewAgain;
      viewAgain = false;
      if (failed && channel === on && sent?.key === key) {
        sent = null;
        trouble(error);
        changed();
      }
      if (again) sendView();
    };
    port.view(on, view).then(() => settled(false), (error: unknown) => settled(true, error));
  }

  function sendAck() {
    if (acking || !channel || received <= acked) return;
    const on = channel, seq = received;
    acking = true;
    port.ack(on, seq).then(() => {
      acking = false;
      if (channel === on && seq > acked) acked = seq;
      sendAck();
    }, () => {
      acking = false;
      // The next frame waits for this ack: a new stream starts again with a new view.
      if (channel === on) controller?.abort();
      else sendAck();
    });
  }

  function choose(id: string | null) {
    chosen = id;
    frame = null;
    step = 0;
    notice = null;
    aged = false;
    clearTimeout(ageTimer);
    sendView();
    changed();
  }

  function onData(text: string) {
    let event: unknown;
    try { event = JSON.parse(text); } catch { throw new BadEvent(); }
    if (!plain(event)) throw new BadEvent();
    if (event.type === 'open') {
      if (typeof event.channel !== 'string' || !CHANNEL.test(event.channel)) throw new BadEvent();
      channel = event.channel;
      received = 0;
      acked = 0;
      sent = null;
      attempt = 0;
      setLink({ state: 'connected' });
      sendView();
    } else if (event.type === 'frame') {
      const { seq, tab, data, viewport } = event;
      if (!seqOk(seq) || typeof tab !== 'string' || !TAB.test(tab) || typeof data !== 'string' || data.length > FRAME_CHARS || !BASE64.test(data)
        || !plain(viewport) || !within(viewport.width, BROWSER_LIMITS.coord) || !within(viewport.height, BROWSER_LIMITS.coord)) throw new BadEvent();
      if (seq > received) received = seq;
      sendAck();
      if (tab !== chosen || sent?.tab !== tab) return;
      if (options.dedicated && (viewport.width !== sent.width || viewport.height !== sent.height)) return;
      frame = { seq, tab, data, viewport: { width: viewport.width as number, height: viewport.height as number } };
      frameEpoch = epoch;
      aged = false;
      clearTimeout(ageTimer);
      if (options.staleAfterMs !== undefined) ageTimer = setTimeout(() => { aged = true; changed(); }, options.staleAfterMs);
      changed();
    } else if (event.type === 'tabs') {
      applyTabs(readTabs(event.tabs));
    } else if (event.type === 'oversized') {
      if (typeof event.tab !== 'string' || !TAB.test(event.tab)) throw new BadEvent();
      if (event.tab !== chosen) return;
      if (step < 2) {
        step += 1;
        sendView();
      } else {
        notice = NOTICES.oversized;
        changed();
      }
    } else if (event.type === 'download') {
      const { name, path } = event;
      if (typeof name !== 'string' || name.length > 255 || typeof path !== 'string' || !path.startsWith('/') || path.length > BROWSER_LIMITS.pathBytes) throw new BadEvent();
      downloads = [...downloads.filter((each) => each.path !== path), { name, path }].slice(-20);
      changed();
    } else if (event.type === 'closed') {
      if (event.reason !== 'replaced' && event.reason !== 'exited') throw new BadEvent();
      ending = event.reason;
    } else throw new BadEvent();
  }

  async function run() {
    if (running) return;
    running = true;
    while (!stopped) {
      ending = null;
      controller = new AbortController();
      let failure: unknown = null;
      try { await port.frames(onData, controller.signal); } catch (error) { failure = error; }
      channel = null;
      if (stopped) break;
      if (ending) { setLink({ state: ending }); break; }
      if (failure instanceof RemoteFailure && failure.kind === 'remote' && (failure.code === 'remote_ended' || failure.code === 'remote_not_found')) {
        setLink({ state: 'ended', message: failure.message });
        break;
      }
      const retry = failure === null || controller.signal.aborted || (failure instanceof RemoteFailure
        && (['no_response', 'not_offered', 'bridge_changed'].includes(failure.kind) || failure.code === 'remote_unavailable'));
      if (!retry) {
        setLink({ state: 'failed', message: failure instanceof RemoteFailure ? failure.message : NOTICES.unexpected });
        break;
      }
      setLink({ state: 'reconnecting', message: failure instanceof RemoteFailure ? failure.message : 'Se cortó la conexión.' });
      if (!controller.signal.aborted) await wait(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!, (controller = new AbortController()).signal);
    }
    running = false;
  }

  void run();

  return {
    state: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id) {
      if (stopped || id === chosen) return;
      choose(id);
    },
    resize(next, pixelRatio) {
      // A hidden box lays out at 0: the browser keeps the last real view.
      if (stopped || !(next.width > 0 && next.height > 0)) return;
      box = next;
      ratio = pixelRatio;
      sendView();
    },
    async act(action) {
      const tab = shown();
      if (stopped || link.state !== 'connected' || !tab) return null;
      if (action.type === 'dialog' ? !tab.dialog : action.type === 'files' && !tab.fileChooser) return null;
      if (tab.limitation || (tab.dialog && action.type !== 'dialog')) {
        notice = tab.limitation ? BROWSER_LIMITATION_MESSAGES[tab.limitation] : NOTICES.dialog;
        changed();
        return null;
      }
      if (PAGE_INPUT.has(action.type) && !snapshot.live) return null;
      if (action.type === 'text' && !action.text.isWellFormed()) return null;
      const actions: BrowserAction[] = action.type === 'text' ? pieces(action.text).map((text) => ({ type: 'text', text })) : [action];
      notice = null;
      let result: BrowserActionResult = {};
      try {
        for (const each of actions) {
          // Between the pieces of a long text the page may have changed under the person: stop there.
          if (stopped || (each !== actions[0] && !snapshot.live)) return null;
          const body = await port.act(tab.id, each);
          if (!plain(body) || (body.moved !== undefined && typeof body.moved !== 'boolean')) throw new RemoteFailure('unexpected', { status: 200 });
          result = body.moved === undefined ? {} : { moved: body.moved };
        }
      } catch (error) {
        if (stopped) return null;
        trouble(error);
        changed();
        return null;
      }
      if (result.moved === false) { notice = NOTICES.history; changed(); }
      return result;
    },
    async open(url) {
      if (stopped || link.state !== 'connected') return false;
      notice = null;
      try {
        const opened = await port.open(url);
        if (!validBrowserTab(opened)) throw new RemoteFailure('unexpected', { status: 200 });
        if (stopped) return false;
        tabs = [...(tabs ?? []).filter((each) => each.id !== opened.id), opened];
        choose(opened.id);
        return true;
      } catch (error) {
        if (!stopped) { trouble(error); changed(); }
        return false;
      }
    },
    async closeTab(id) {
      if (stopped || link.state !== 'connected') return false;
      try { await port.close(id); } catch (error) {
        if (!stopped) { trouble(error); changed(); }
        return false;
      }
      if (!stopped) applyTabs((tabs ?? []).filter((each) => each.id !== id));
      return true;
    },
    dismissDownload(path) {
      downloads = downloads.filter((each) => each.path !== path);
      changed();
    },
    reconnect() {
      if (stopped || running) return;
      attempt = 0;
      setLink({ state: 'connecting' });
      void run();
    },
    close() {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      clearTimeout(ageTimer);
      setLink({ state: 'closed' });
    },
  };
}
