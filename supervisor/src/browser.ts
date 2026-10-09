// A device's dedicated browser (ADR 0006, docs/relay-v3.md §6, docs/research/v3-cdp.md): Chrome or
// Chromium on its own profile, inside its environment's cgroup, spoken to over the CDP pipe only this
// process holds. Nothing from outside becomes a CDP method or parameter: the Puente sends the bounded
// actions of protocol/remoteBrowser.ts, already validated, and this module translates them.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { BROWSER_DIALOG_TYPES, BROWSER_LIMITS, controllableUrl } from '../../protocol/remoteBrowser.ts';
import type { BrowserAction, BrowserActionResult, BrowserKey, BrowserTab, BrowserView } from '../../protocol/remoteBrowser.ts';
import type { ChannelEvent } from '../../protocol/supervisor.ts';
import type { LaunchedBrowser } from './host.ts';
import { SupervisorFailure } from './supervisor.ts';

/** A capture can hang (Chromium 152, background tab): every request has a deadline. */
const CDP_TIMEOUT_MS = 15_000;

// windowsVirtualKeyCode is what makes Chrome act on the key (submit, delete, move the caret).
const KEYS: Record<BrowserKey, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Backspace: { code: 'Backspace', keyCode: 8 }, Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 }, Delete: { code: 'Delete', keyCode: 46 }, Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

type Params = Record<string, unknown>;
const plain = (value: unknown): value is Params => typeof value === 'object' && value !== null && !Array.isArray(value);
/** What a page says about itself (URL, title, dialog), cut to its limit: every tab travels in each `tabs` line. */
const clip = (value: unknown, max: number) => {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(0, max).toWellFormed();
};

/** The browser refused a request; its text never leaves this module. */
class CdpError extends Error {
  code: unknown;
  constructor(code: unknown, message: string) {
    super(message);
    this.code = code;
  }
}

/** Fixed codes only: a CDP error text may carry URLs. */
function failure(error: unknown): SupervisorFailure {
  if (error instanceof SupervisorFailure) return error;
  if (error instanceof CdpError) {
    // An older or different browser without the method: explicit, never a silent no-op.
    if (error.code === -32601 || / wasn't found$/.test(error.message)) return new SupervisorFailure('unsupported');
    if (/no target|session with given id not found/i.test(error.message)) return new SupervisorFailure('not_found');
  }
  return new SupervisorFailure('unavailable');
}

interface Tab {
  id: string;
  url: string;
  title: string;
  /** Attached once, on discovery, so a dialog or a file chooser is never missed. */
  session: Promise<string> | null;
  sessionId: string | null;
  /** Opened by Relay (openTab), not by a page or at launch. */
  createdByRelay: boolean;
  dialog: BrowserTab['dialog'];
  chooser: { multiple: boolean; backendNodeId: number } | null;
}

interface Channel {
  id: string;
  seq: number;
  view: BrowserView | null;
  /** The session whose screencast feeds this channel. */
  casting: string | null;
  /** The frame sent and not acked: the browser sends no other until it is. */
  pending: { seq: number; frame: unknown; session: string } | null;
}

export interface BrowserFolders {
  /** Where the browser writes downloads, each under its GUID, until they finish. */
  staging: string;
  /** Where finished downloads stay on the Server, never replacing a file. */
  downloads: string;
}

/** `name (n).ext` for the nth try; an empty, dot or path-like suggestion becomes a plain name. */
function downloadName(suggested: string, attempt: number): string {
  let name = path.basename(suggested.replace(/\0/g, '')).slice(0, 200);
  if (!name || name === '.' || name === '..') name = 'descarga';
  if (attempt === 0) return name;
  const extension = path.extname(name);
  return `${name.slice(0, name.length - extension.length)} (${attempt})${extension}`;
}

/** An existing regular file the account can read: what a file chooser may be filled with. */
async function regularFile(file: string): Promise<void> {
  let handle;
  try {
    // Non-blocking: a FIFO never holds the open.
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new SupervisorFailure((error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission' : 'not_found');
  }
  try {
    if (!(await handle.stat()).isFile()) throw new SupervisorFailure('invalid');
  } finally {
    await handle.close();
  }
}

export class DedicatedBrowser {
  done = false;
  private pipe: LaunchedBrowser;
  private folders: BrowserFolders;
  private emit: (event: ChannelEvent) => void;
  private timeoutMs: number;
  private next = 1;
  private requests = new Map<number, { resolve: (result: Params) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string; sessionId?: string }>();
  private tabs = new Map<string, Tab>();
  private channel: Channel | null = null;
  /** Suggested names of downloads in progress, by GUID. */
  private downloads = new Map<string, string>();
  private publishing = Promise.resolve();

  constructor(pipe: LaunchedBrowser, folders: BrowserFolders, emit: (event: ChannelEvent) => void, timeoutMs = CDP_TIMEOUT_MS) {
    this.pipe = pipe;
    this.folders = folders;
    this.emit = emit;
    this.timeoutMs = timeoutMs;
    pipe.onMessage((text) => this.receive(text));
    void pipe.exited.then(() => this.ended());
  }

  /** The browser answers, keeps downloads in staging and reports its tabs. */
  async start(): Promise<void> {
    try {
      await this.send('Browser.getVersion');
      await this.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.folders.staging, eventsEnabled: true });
      await this.send('Target.setDiscoverTargets', { discover: true });
    } catch (error) {
      throw failure(error);
    }
  }

  list(): BrowserTab[] { return [...this.tabs.values()].map((tab) => this.public(tab)); }

  async open(url: string | null): Promise<BrowserTab> {
    if (this.done) throw new SupervisorFailure('ended');
    if (this.tabs.size >= BROWSER_LIMITS.dedicatedTabs) throw new SupervisorFailure('limit');
    let targetId: unknown;
    try { ({ targetId } = await this.send('Target.createTarget', { url: url ?? 'about:blank' })); } catch (error) { throw failure(error); }
    if (typeof targetId !== 'string') throw new SupervisorFailure('unavailable');
    const tab = this.tabs.get(targetId) ?? this.discovered(targetId, url ?? 'about:blank', '');
    if (!tab) throw new SupervisorFailure('limit');
    tab.createdByRelay = true;
    this.tabsChanged();
    return this.public(tab);
  }

  async close(id: string): Promise<void> {
    this.tab(id);
    try { await this.send('Target.closeTarget', { targetId: id }); } catch (error) { throw failure(error); }
  }

  async act(id: string, action: BrowserAction): Promise<BrowserActionResult> {
    const tab = this.tab(id);
    try {
      if (action.type === 'dialog') {
        if (!tab.dialog) throw new SupervisorFailure('conflict');
        const session = await this.session(tab);
        await this.send('Page.handleJavaScriptDialog', action.text === undefined ? { accept: action.accept } : { accept: action.accept, promptText: action.text }, session);
        tab.dialog = null;
        this.tabsChanged();
        return {};
      }
      // A JavaScript dialog holds the page: anything else would wait on it.
      if (tab.dialog) throw new SupervisorFailure('conflict');
      const session = await this.session(tab);
      const send = (method: string, params: Params) => this.send(method, params, session);
      switch (action.type) {
        case 'navigate': await send('Page.navigate', { url: action.url }); return {};
        case 'reload': await send('Page.reload', {}); return {};
        case 'back': case 'forward': {
          const { currentIndex, entries } = await send('Page.getNavigationHistory', {});
          const entry = Array.isArray(entries) && typeof currentIndex === 'number' ? entries[currentIndex + (action.type === 'back' ? -1 : 1)] : undefined;
          if (!plain(entry)) return { moved: false };
          await send('Page.navigateToHistoryEntry', { entryId: entry.id });
          return { moved: true };
        }
      }
      // Input and files only reach web pages, never an internal page of the browser.
      if (!controllableUrl(tab.url)) throw new SupervisorFailure('limited');
      switch (action.type) {
        case 'tap':
          for (const [type, extra] of [['mouseMoved', { button: 'none', clickCount: 0 }], ['mousePressed', {}], ['mouseReleased', {}]] as const) {
            await send('Input.dispatchMouseEvent', { type, x: action.x, y: action.y, button: 'left', clickCount: 1, ...extra });
          }
          return {};
        case 'scroll': await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.dx, deltaY: action.dy }); return {};
        case 'text': await send('Input.insertText', { text: action.text }); return {};
        case 'key': {
          const key = KEYS[action.key];
          const common = { key: action.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
          await send('Input.dispatchKeyEvent', key.text ? { type: 'keyDown', text: key.text, ...common } : { type: 'rawKeyDown', ...common });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
          return {};
        }
        case 'files': {
          const chooser = tab.chooser;
          if (!chooser) throw new SupervisorFailure('conflict');
          if (!chooser.multiple && action.paths.length > 1) throw new SupervisorFailure('invalid');
          for (const file of action.paths) await regularFile(file);
          await send('DOM.setFileInputFiles', { files: action.paths, backendNodeId: chooser.backendNodeId });
          tab.chooser = null;
          this.tabsChanged();
          return {};
        }
      }
    } catch (error) {
      throw failure(error);
    }
  }

  /** A new stream; the previous one ends with `replaced`. Frames wait for a view. */
  attach(channel: string): void {
    if (this.done) throw new SupervisorFailure('ended');
    if (this.channel) {
      this.emit({ channel: this.channel.id, type: 'closed', reason: 'replaced' });
      this.stopCasting(this.channel);
    }
    this.channel = { id: channel, seq: 0, view: null, casting: null, pending: null };
    this.emit({ channel, type: 'opened', inputSeq: 0 });
    this.tabsChanged();
  }

  async view(channel: string, view: BrowserView): Promise<void> {
    const current = this.current(channel);
    const tab = this.tab(view.tab);
    if (!controllableUrl(tab.url)) throw new SupervisorFailure('limited');
    this.stopCasting(current);
    current.view = view;
    try {
      const session = await this.session(tab);
      if (this.channel !== current || current.view !== view) return;
      // Before the request: the first frame may come before its answer.
      current.casting = session;
      await this.send('Target.activateTarget', { targetId: tab.id });
      await this.send('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: false }, session);
      await this.send('Page.startScreencast', { format: 'jpeg', quality: view.quality, maxWidth: view.width * view.scale, maxHeight: view.height * view.scale }, session);
    } catch (error) {
      if (current.view === view) this.stopCasting(current);
      throw failure(error);
    }
  }

  ack(channel: string, seq: number): void {
    const current = this.current(channel);
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > current.seq) throw new SupervisorFailure('invalid');
    const pending = current.pending;
    if (!pending || seq < pending.seq) return;
    current.pending = null;
    void this.send('Page.screencastFrameAck', { sessionId: pending.frame }, pending.session).catch(() => {});
  }

  detach(channel: string): void {
    if (this.channel?.id !== channel) return;
    this.stopCasting(this.channel);
    this.channel = null;
  }

  detachAny(): void {
    if (this.channel) this.detach(this.channel.id);
  }

  private current(channel: string): Channel {
    if (this.done) throw new SupervisorFailure('ended');
    if (this.channel?.id !== channel) throw new SupervisorFailure('not_found');
    return this.channel;
  }

  private tab(id: string): Tab {
    if (this.done) throw new SupervisorFailure('ended');
    const tab = this.tabs.get(id);
    if (!tab) throw new SupervisorFailure('not_found');
    return tab;
  }

  private public(tab: Tab): BrowserTab {
    return {
      id: tab.id, url: tab.url, title: tab.title, limitation: controllableUrl(tab.url) ? null : 'internal_page', createdByRelay: tab.createdByRelay,
      dialog: tab.dialog, fileChooser: tab.chooser ? { multiple: tab.chooser.multiple } : null,
    };
  }

  private tabsChanged(): void {
    if (this.channel) this.emit({ channel: this.channel.id, type: 'tabs', tabs: this.list() });
  }

  private stopCasting(channel: Channel): void {
    if (channel.casting) void this.send('Page.stopScreencast', {}, channel.casting).catch(() => {});
    channel.casting = null;
    channel.pending = null;
    channel.view = null;
  }

  private send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    if (this.done) return Promise.reject(new SupervisorFailure('ended'));
    const id = this.next++;
    const { promise, resolve, reject } = Promise.withResolvers<Params>();
    const timer = setTimeout(() => { this.requests.delete(id); reject(new SupervisorFailure('unavailable')); }, this.timeoutMs);
    this.requests.set(id, { resolve, reject, timer, method, sessionId });
    this.pipe.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }

  private session(tab: Tab): Promise<string> {
    if (tab.session) return tab.session;
    const attempt = (async () => {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId: tab.id, flatten: true });
      if (typeof sessionId !== 'string') throw new SupervisorFailure('unavailable');
      tab.sessionId = sessionId;
      // Dialogs and file choosers become events Relay answers; the page keeps its focus while headless.
      await Promise.all([
        this.send('Page.enable', {}, sessionId),
        this.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId),
        this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
      ]);
      // A page that loaded before Page.enable sent no load event: its title is asked for now.
      this.retitle(tab);
      return sessionId;
    })();
    tab.session = attempt;
    attempt.catch(() => { if (tab.session === attempt) { tab.session = null; tab.sessionId = null; } });
    return attempt;
  }

  /** A tab over BROWSER_LIMITS.dedicatedTabs (window.open, or one opened meanwhile) is closed, never listed. */
  private discovered(id: string, url: unknown, title: unknown): Tab | null {
    if (this.tabs.size >= BROWSER_LIMITS.dedicatedTabs) {
      void this.send('Target.closeTarget', { targetId: id }).catch(() => {});
      return null;
    }
    const tab: Tab = {
      id, url: clip(url, BROWSER_LIMITS.urlChars), title: clip(title, BROWSER_LIMITS.titleChars), session: null, sessionId: null, createdByRelay: false, dialog: null, chooser: null,
    };
    this.tabs.set(id, tab);
    void this.session(tab).catch(() => {});
    this.tabsChanged();
    return tab;
  }

  private receive(text: string): void {
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!plain(message)) return;
    if (typeof message.id === 'number') {
      const request = this.requests.get(message.id);
      if (!request) return;
      this.requests.delete(message.id);
      clearTimeout(request.timer);
      if (plain(message.error)) request.reject(new CdpError(message.error.code, String(message.error.message)));
      else request.resolve(plain(message.result) ? message.result : {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = plain(message.params) ? message.params : {};
    const session = typeof message.sessionId === 'string' ? message.sessionId : null;
    const tab = session ? [...this.tabs.values()].find((candidate) => candidate.sessionId === session) : undefined;
    const info = plain(params.targetInfo) ? params.targetInfo : {};
    switch (message.method) {
      case 'Target.targetCreated':
        if (info.type === 'page' && typeof info.targetId === 'string' && !this.tabs.has(info.targetId)) this.discovered(info.targetId, info.url, info.title);
        return;
      case 'Target.targetInfoChanged':
        this.infoChanged(info);
        return;
      case 'Target.targetDestroyed': {
        const id = String(params.targetId);
        if (!this.tabs.delete(id)) return;
        if (this.channel?.view?.tab === id) this.stopCasting(this.channel);
        this.tabsChanged();
        return;
      }
      case 'Target.detachedFromTarget': {
        const detached = [...this.tabs.values()].find((candidate) => candidate.sessionId === params.sessionId);
        if (detached) { detached.session = null; detached.sessionId = null; }
        return;
      }
      case 'Page.javascriptDialogOpening':
        if (!tab) return;
        tab.dialog = {
          type: BROWSER_DIALOG_TYPES.find((type) => type === params.type) ?? 'alert', message: clip(params.message, BROWSER_LIMITS.textChars),
          defaultPrompt: clip(params.defaultPrompt, BROWSER_LIMITS.textChars),
        };
        this.tabsChanged();
        // The browser answers the input that opened it only once it is answered: the dialog is the answer.
        for (const [id, request] of this.requests) {
          if (request.sessionId !== session || !request.method.startsWith('Input.')) continue;
          this.requests.delete(id);
          clearTimeout(request.timer);
          request.resolve({});
        }
        return;
      case 'Page.javascriptDialogClosed':
        if (!tab?.dialog) return;
        tab.dialog = null;
        this.tabsChanged();
        return;
      case 'Page.loadEventFired':
        if (tab) this.retitle(tab);
        return;
      case 'Page.fileChooserOpened':
        if (!tab || typeof params.backendNodeId !== 'number') return;
        tab.chooser = { multiple: params.mode === 'selectMultiple', backendNodeId: params.backendNodeId };
        this.tabsChanged();
        return;
      case 'Page.screencastFrame':
        if (tab && session) this.frame(tab, session, params);
        return;
      case 'Browser.downloadWillBegin':
        if (typeof params.guid === 'string') this.downloads.set(params.guid, String(params.suggestedFilename ?? ''));
        return;
      case 'Browser.downloadProgress': {
        if (typeof params.guid !== 'string') return;
        const guid = params.guid;
        const over = Number(params.receivedBytes) > BROWSER_LIMITS.downloadBytes || Number(params.totalBytes) > BROWSER_LIMITS.downloadBytes;
        if (params.state === 'inProgress') {
          if (over) void this.send('Browser.cancelDownload', { guid }).catch(() => {});
          return;
        }
        // In order, one at a time: each takes the first free name in the order downloads finished.
        if (params.state === 'completed' && !over) this.publishing = this.publishing.then(() => this.publish(guid)).catch(() => {});
        else if (params.state === 'completed' || params.state === 'canceled') {
          // Cancelled, or finished over the limit before the cancel arrived: nothing of it stays.
          this.downloads.delete(guid);
          void fs.rm(path.join(this.folders.staging, guid), { force: true }).catch(() => {});
        }
      }
    }
  }

  /** A tab's URL and title as the browser says them now. */
  private infoChanged(info: Params): void {
    const changed = typeof info.targetId === 'string' ? this.tabs.get(info.targetId) : undefined;
    if (!changed) return;
    changed.url = clip(info.url, BROWSER_LIMITS.urlChars);
    changed.title = clip(info.title, BROWSER_LIMITS.titleChars);
    this.tabsChanged();
  }

  /**
   * Chromium reports a target's title as it navigates, before the page has one (its host and port then),
   * and not when the page sets it: it is asked for once the page has loaded.
   */
  private retitle(tab: Tab): void {
    void this.send('Target.getTargetInfo', { targetId: tab.id }).then(({ targetInfo }) => { if (plain(targetInfo)) this.infoChanged(targetInfo); }).catch(() => {});
  }

  private frame(tab: Tab, session: string, params: Params): void {
    const channel = this.channel;
    const release = () => { void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }, session).catch(() => {}); };
    // A late frame of a view that changed: let it go.
    if (!channel?.view || channel.casting !== session || channel.view.tab !== tab.id || typeof params.data !== 'string') return release();
    const data = params.data;
    const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > REMOTE_LIMITS.browserFrameBytes) {
      release();
      this.emit({ channel: channel.id, type: 'oversized', tab: tab.id });
      return;
    }
    const metadata = plain(params.metadata) ? params.metadata : {};
    channel.seq += 1;
    channel.pending = { seq: channel.seq, frame: params.sessionId, session };
    this.emit({
      channel: channel.id, type: 'frame', seq: channel.seq, tab: tab.id, data,
      viewport: { width: Number(metadata.deviceWidth) || channel.view.width, height: Number(metadata.deviceHeight) || channel.view.height },
    });
  }

  /** A finished download leaves staging for the downloads folder, under a name nothing else has. */
  private async publish(guid: string): Promise<void> {
    const suggested = this.downloads.get(guid) ?? '';
    this.downloads.delete(guid);
    const source = path.join(this.folders.staging, guid);
    await fs.mkdir(this.folders.downloads, { recursive: true });
    for (let attempt = 0; attempt < 1000; attempt++) {
      const target = path.join(this.folders.downloads, downloadName(suggested, attempt));
      try {
        // link and COPYFILE_EXCL never replace an existing file; another file system needs the copy.
        await fs.link(source, target).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EXDEV') throw error;
          await fs.copyFile(source, target, constants.COPYFILE_EXCL);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      await fs.unlink(source);
      if (this.channel) this.emit({ channel: this.channel.id, type: 'download', name: path.basename(target), path: target });
      return;
    }
  }

  private ended(): void {
    this.done = true;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new SupervisorFailure('ended')); }
    this.requests.clear();
    if (this.channel) this.emit({ channel: this.channel.id, type: 'closed', reason: 'exited' });
    this.channel = null;
  }
}
