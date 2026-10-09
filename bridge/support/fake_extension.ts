// The native host's side of the Puente's extension socket (bridge/src/remote/habitualBrowser.ts): what
// the Relay extension says through browserHost.ts, one JSON object per line. A transport double; the
// real extension and host run in habitualBrowserReal.test.ts.
import net from 'node:net';
import { once } from 'node:events';
import type { BrowserLimitation, BrowserDialogType, BrowserTab } from '../../protocol/remoteBrowser.ts';
import { EXTENSION_PROTOCOL, RELAY_EXTENSION_ID } from '../src/remote/habitualBrowser.ts';

export const ORIGIN = `chrome-extension://${RELAY_EXTENSION_ID}/`;
export type Request = Record<string, unknown> & { id: number; op: string };
type Reply = { ok: true; result: unknown } | { ok: false; code: string } | null;

/** A tab as the extension lists it (bridge/extension/background.js `describe`); the Puente makes it a BrowserTab. */
export interface ExtensionTab {
  tabId: number; title: string; url: string; createdByRelay: boolean; limitation: BrowserLimitation | null;
  dialog: { type: BrowserDialogType; message: string; defaultPrompt: string } | null;
  fileChooser: { multiple: boolean } | null;
}

export function sharedTab(tabId: number, extra: Partial<ExtensionTab> = {}): ExtensionTab {
  return { tabId, title: `Página ${tabId}`, url: `https://example.test/${tabId}`, createdByRelay: false, limitation: null, dialog: null, fileChooser: null, ...extra };
}

/** What the phone sees of a tab the extension lists like sharedTab: the contract names it by string. */
export function listedTab(tabId: number, extra: Partial<ExtensionTab> = {}): BrowserTab {
  const { title, url, createdByRelay, limitation, dialog, fileChooser } = sharedTab(tabId, extra);
  return { id: String(tabId), url, title, limitation, createdByRelay, dialog, fileChooser };
}

export class FakeExtension {
  readonly socket: net.Socket;
  readonly requests: Request[] = [];
  readonly closed: Promise<void>;
  /** The tabs the person shared, as the extension lists them. */
  tabs: ExtensionTab[] = [];
  /** Finished downloads of shared tabs, handed over once on the Puente's next `downloads`. */
  downloads: { name: string; path: string }[] = [];
  /** Answers a request; null leaves it unanswered. Defaults to the shared-tabs model above. */
  reply: (request: Request) => Reply = (request) => this.model(request);
  #ended = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('error', () => {});
    const closed = Promise.withResolvers<void>();
    socket.once('close', () => { this.#ended = true; closed.resolve(); });
    this.closed = closed.promise;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, index)) as Request;
        buffer = buffer.slice(index + 1);
        this.requests.push(request);
        const reply = this.reply(request);
        if (reply) this.send({ type: 'response', id: request.id, ...reply });
      }
    });
  }

  get ended(): boolean { return this.#ended; }
  ops(): string[] { return this.requests.map((request) => request.op); }
  send(message: unknown): void { if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(message)}\n`); }

  model(request: Request): Reply {
    if (request.op === 'tabs') return { ok: true, result: this.tabs };
    if (request.op === 'open') {
      const tab = sharedTab(100 + this.tabs.length, { url: String(request.url), createdByRelay: true });
      this.tabs.push(tab);
      return { ok: true, result: tab };
    }
    if (request.op === 'release') return { ok: true, result: {} };
    if (request.op === 'downloads') return { ok: true, result: this.downloads.splice(0) };
    if (request.op === 'act') {
      const tab = this.tabs.find((candidate) => candidate.tabId === request.tabId);
      if (!tab) return { ok: false, code: 'not_shared' };
      const action = request.action as { type: string };
      if (action.type === 'frame') return { ok: true, result: { data: Buffer.from('jpeg').toString('base64'), viewport: { width: 320, height: 200 } } };
      if (action.type === 'back' || action.type === 'forward') return { ok: true, result: { moved: true } };
      if (action.type === 'files') {
        if (!tab.fileChooser) return { ok: false, code: 'no_chooser' };
        tab.fileChooser = null;
      }
      return { ok: true, result: {} };
    }
    return { ok: false, code: 'invalid' };
  }
}

/** Connects like the host does and says hello, unless `hello` is null. */
export async function connectExtension(socketPath: string, hello: Record<string, unknown> | null = { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL, origin: ORIGIN }): Promise<FakeExtension> {
  const socket = net.createConnection(socketPath);
  const extension = new FakeExtension(socket);
  await once(socket, 'connect');
  if (hello) extension.send(hello);
  return extension;
}
