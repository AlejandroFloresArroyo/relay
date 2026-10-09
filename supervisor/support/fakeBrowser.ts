// Double of a Chrome speaking CDP over its pipe (the browser end of src/host.ts LaunchedBrowser). Fake
// pages hold a URL, a history, the input they received and a screencast that, like the real one, sends
// a frame and waits for its ack before the next. Methods it does not know answer like Chrome does to
// an unknown method, and a test can make any method unknown.
import fs from 'node:fs';
import path from 'node:path';
import type { LaunchedBrowser } from '../src/host.ts';

type Params = Record<string, unknown>;
export interface FakePage {
  id: string;
  url: string;
  title: string;
  history: string[];
  index: number;
  sessions: string[];
  /** Every Input.* call and DOM.setFileInputFiles, in order. */
  inputs: { method: string; params: Params }[];
  metrics: Params | null;
  screencast: Params | null;
  /** A frame was sent and its ack has not come. */
  awaitingAck: boolean;
  /** The page changed while a frame was unacked. */
  dirty: boolean;
  frames: number;
  dialog: boolean;
}

let nextTarget = 1;
const targetId = () => (nextTarget++).toString(16).toUpperCase().padStart(32, '0');

export class FakeBrowser implements LaunchedBrowser {
  exited: Promise<number | null>;
  argv: string[];
  env: NodeJS.ProcessEnv;
  pages = new Map<string, FakePage>();
  /** Every method received, with its session. */
  calls: { method: string; sessionId?: string }[] = [];
  /** Methods answered as unknown, as an older browser would. */
  unknown = new Set<string>();
  /** Decoded bytes of each frame. */
  frameBytes = 6000;
  downloadPath: string | null = null;
  /** GUIDs of the downloads Relay cancelled. */
  cancelled: string[] = [];
  closed = false;
  private listener: (message: string) => void = () => {};
  private end: (code: number | null) => void;
  private sessions = new Map<string, string>();
  private discovering = false;

  constructor(argv: string[], env: NodeJS.ProcessEnv) {
    this.argv = argv;
    this.env = env;
    const { promise, resolve } = Promise.withResolvers<number | null>();
    this.exited = promise;
    this.end = resolve;
    this.page('about:blank');
  }

  onMessage(listener: (message: string) => void): void { this.listener = listener; }

  /** Closing the pipe ends Chrome, with code 0 (docs/research/v3-cdp.md). */
  hangUp(): void { this.exit(0); }

  exit(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.end(code);
  }

  send(text: string): void {
    if (this.closed) return;
    const { id, method, params, sessionId } = JSON.parse(text) as { id: number; method: string; params: Params; sessionId?: string };
    this.calls.push({ method, ...(sessionId ? { sessionId } : {}) });
    setImmediate(() => {
      if (this.closed) return;
      try {
        const result = this.unknown.has(method) ? undefined : this.handle(method, params ?? {}, sessionId);
        if (result === undefined) this.reply({ id, error: { code: -32601, message: `'${method}' wasn't found` }, ...(sessionId ? { sessionId } : {}) });
        else this.reply({ id, result, ...(sessionId ? { sessionId } : {}) });
      } catch (error) {
        this.reply({ id, error: { code: -32000, message: (error as Error).message }, ...(sessionId ? { sessionId } : {}) });
      }
    });
  }

  /** A page opened by the page itself (window.open) or by the person. */
  page(url: string): FakePage {
    const page: FakePage = { id: targetId(), url, title: '', history: [url], index: 0, sessions: [], inputs: [], metrics: null, screencast: null, awaitingAck: false, dirty: false, frames: 0, dialog: false };
    this.pages.set(page.id, page);
    if (this.discovering) this.event('Target.targetCreated', { targetInfo: this.info(page) });
    return page;
  }

  /** The page repaints: a frame goes now, or after the ack of the one in flight. */
  paint(page: FakePage): void {
    if (!page.screencast) return;
    if (page.awaitingAck) { page.dirty = true; return; }
    page.awaitingAck = true;
    page.dirty = false;
    page.frames++;
    this.event('Page.screencastFrame', {
      data: Buffer.alloc(this.frameBytes, page.frames).toString('base64'), sessionId: page.frames,
      metadata: { deviceWidth: page.metrics?.width ?? 800, deviceHeight: page.metrics?.height ?? 600, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
    }, page.sessions[0]);
  }

  /** The page changes its own URL or title (history.pushState, document.title). */
  update(page: FakePage, url: string, title = page.title): void {
    page.title = title;
    this.go(page, url);
  }

  dialog(page: FakePage, type: string, message: string): void {
    page.dialog = true;
    this.event('Page.javascriptDialogOpening', { url: page.url, type, message, defaultPrompt: '', hasBrowserHandler: false }, page.sessions[0]);
  }

  chooser(page: FakePage, multiple: boolean): void {
    this.event('Page.fileChooserOpened', { frameId: 'F', mode: multiple ? 'selectMultiple' : 'selectSingle', backendNodeId: 42 }, page.sessions[0]);
  }

  /**
   * A download the page started: written under its GUID, as behavior allowAndName does. One still in
   * progress reports `receivedBytes` (its size so far, without writing that much) until cancelled.
   */
  download(name: string, body: string, state: 'completed' | 'canceled' | 'inProgress' = 'completed', receivedBytes = body.length): string {
    const guid = `guid-${targetId()}`;
    this.event('Browser.downloadWillBegin', { frameId: 'F', guid, url: 'http://127.0.0.1/file', suggestedFilename: name });
    if (state !== 'canceled') fs.writeFileSync(path.join(this.downloadPath!, guid), body);
    this.event('Browser.downloadProgress', { guid, totalBytes: 0, receivedBytes, state, ...(state === 'completed' ? { filePath: path.join(this.downloadPath!, guid) } : {}) });
    return guid;
  }

  private info(page: FakePage) { return { targetId: page.id, type: 'page', url: page.url, title: page.title, attached: page.sessions.length > 0 }; }
  private reply(message: unknown): void { if (!this.closed) this.listener(JSON.stringify(message)); }
  private event(method: string, params: Params, sessionId?: string): void { this.reply({ method, params, ...(sessionId ? { sessionId } : {}) }); }

  private go(page: FakePage, url: string): void {
    page.url = url;
    this.event('Target.targetInfoChanged', { targetInfo: this.info(page) });
    this.paint(page);
  }

  private handle(method: string, params: Params, sessionId?: string): unknown {
    const page = sessionId ? this.pages.get(this.sessions.get(sessionId) ?? '') : undefined;
    if (sessionId && !page) throw new Error(`Session with given id not found.`);
    const target = () => {
      const found = this.pages.get(params.targetId as string);
      if (!found) throw new Error('No target with given id found');
      return found;
    };
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: 'FakeChrome/1.0' };
      case 'Browser.setDownloadBehavior': this.downloadPath = params.downloadPath as string; return {};
      // Leaves the partial file in place: the supervisor removes it.
      case 'Browser.cancelDownload':
        this.cancelled.push(params.guid as string);
        this.event('Browser.downloadProgress', { guid: params.guid, totalBytes: 0, receivedBytes: 0, state: 'canceled' });
        return {};
      case 'Target.setDiscoverTargets':
        this.discovering = params.discover === true;
        for (const each of this.pages.values()) this.event('Target.targetCreated', { targetInfo: this.info(each) });
        return {};
      case 'Target.createTarget': return { targetId: this.page(params.url as string).id };
      case 'Target.closeTarget': {
        const closing = target();
        this.pages.delete(closing.id);
        for (const session of closing.sessions) this.event('Target.detachedFromTarget', { sessionId: session, targetId: closing.id });
        this.event('Target.targetDestroyed', { targetId: closing.id });
        return { success: true };
      }
      case 'Target.attachToTarget': {
        const attaching = target();
        const session = `S${targetId()}`;
        this.sessions.set(session, attaching.id);
        attaching.sessions.push(session);
        return { sessionId: session };
      }
      case 'Target.activateTarget': target(); return {};
    }
    if (!page) return undefined;
    switch (method) {
      case 'Page.enable': case 'Page.setInterceptFileChooserDialog': case 'Emulation.setFocusEmulationEnabled': return {};
      case 'Emulation.setDeviceMetricsOverride': page.metrics = params; return {};
      case 'Page.startScreencast':
        page.screencast = params;
        page.awaitingAck = false;
        this.paint(page);
        return {};
      case 'Page.stopScreencast': page.screencast = null; return {};
      case 'Page.screencastFrameAck':
        page.awaitingAck = false;
        if (page.dirty) this.paint(page);
        return {};
      case 'Page.navigate':
        page.history = [...page.history.slice(0, page.index + 1), params.url as string];
        page.index = page.history.length - 1;
        this.go(page, params.url as string);
        return { frameId: 'F', loaderId: 'L' };
      case 'Page.getNavigationHistory': return { currentIndex: page.index, entries: page.history.map((url, id) => ({ id, url, title: '' })) };
      case 'Page.navigateToHistoryEntry':
        page.index = params.entryId as number;
        this.go(page, page.history[page.index]!);
        return {};
      case 'Page.reload': this.paint(page); return {};
      case 'Input.dispatchMouseEvent': case 'Input.dispatchKeyEvent': case 'Input.insertText': case 'DOM.setFileInputFiles':
        page.inputs.push({ method, params });
        this.paint(page);
        return {};
      case 'Page.handleJavaScriptDialog':
        if (!page.dialog) throw new Error('No dialog is showing');
        page.dialog = false;
        page.inputs.push({ method, params });
        this.event('Page.javascriptDialogClosed', { result: params.accept, userInput: params.promptText ?? '' }, sessionId);
        return {};
    }
    return undefined;
  }
}
