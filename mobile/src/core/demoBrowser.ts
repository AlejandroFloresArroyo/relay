// Demo browsers (npm run demo): a dedicated browser with one tab per state the Navegador tool shows
// (page, JavaScript prompt, file chooser, internal page, a download), one the Servidor lost (seen once
// the running one ends), and a habitual one to connect to, whose shared tabs show control in common, a
// limitation and frames that stop, and whose computer comes and goes: each of its first streams shows
// one connection state. Same session core; no page leaves the app. Phone files need Relay on Android.
import type { BrowserAction, BrowserTab } from '../../../protocol/remoteBrowser.ts';
import type { BrowserEnvironment, BrowserKind, BrowserPort, BrowsersApi } from './browsers.ts';
import { DEMO_MAIL_FRAME, DEMO_SHOP_FRAME } from './demoBrowserFrames.ts';
import { RemoteFailure } from './remoteClient.ts';

const id = (name: string) => `env_demo${name.padEnd(22, '0')}`;
const tab = (tabId: string, url: string, title: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id: tabId, url, title, limitation: null, createdByRelay: false, dialog: null, fileChooser: null, ...extra,
});
const SHOP_SIZE = DEMO_SHOP_FRAME.viewport;
/** How long a habitual demo stream lasts before its trouble. */
export const DEMO_TROUBLE_MS = 20_000;
/**
 * The habitual demo's streams, in order; every later one stays. Lost after a while (Relay reconnects by
 * itself), no answer (it keeps trying), opened on another screen of the device and an answer Relay cannot
 * read (both wait for «Conectar aquí»).
 */
const HABITUAL_STREAMS = ['drops', 'refused', 'replaced', 'broken'] as const;

interface Demo extends BrowserEnvironment {
  tabs: BrowserTab[];
  emit: ((event: object) => void) | null;
  /** Ends the open stream, as the Puente does after `closed`. */
  end: () => void;
  view: string | null;
  /** The size of the last view: the dedicated browser draws its tab at it. */
  size: { width: number; height: number };
  seq: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Streams opened so far, for the habitual demo's script. */
  streams: number;
}

function seedTabs(kind: BrowserKind): BrowserTab[] {
  if (kind === 'browser_dedicated') {
    return [
      tab('shop', 'https://tienda-atlas.example/pedidos', 'Pedidos · Tienda Atlas'),
      tab('form', 'https://tienda-atlas.example/clientes/nuevo', 'Nuevo cliente', { dialog: { type: 'prompt', message: '¿Nombre del cliente?', defaultPrompt: 'Ana López' } }),
      tab('import', 'https://tienda-atlas.example/importar', 'Importar pedidos', { fileChooser: { multiple: false } }),
      tab('settings', 'chrome://settings/', 'Configuración', { limitation: 'internal_page' }),
    ];
  }
  return [
    tab('101', 'https://correo.example/recibidos', 'Recibidos (14) · Correo'),
    tab('102', 'https://calendario.example/semana', 'Calendario'),
    tab('103', 'https://panel.example/servicios', 'Panel de servicios', { limitation: 'debugger_busy' }),
  ];
}

const demo = (environment: BrowserEnvironment): Demo => ({
  ...environment, tabs: seedTabs(environment.kind), emit: null, end: () => {}, view: null, size: SHOP_SIZE, seq: 0, timer: undefined, streams: 0,
});

export function createDemoBrowsers(): { api: BrowsersApi; port: (environmentId: string) => BrowserPort } {
  const browsers: Demo[] = [
    demo({ id: id('dedicated'), kind: 'browser_dedicated', ownership: 'own', state: 'running', createdAt: 1, terminationError: null }),
    demo({ id: id('lost'), kind: 'browser_dedicated', ownership: 'own', state: 'lost', createdAt: 0, terminationError: null }),
  ];
  const find = (environmentId: string) => {
    const found = browsers.find((each) => each.id === environmentId);
    if (!found) throw new RemoteFailure('remote', { code: 'remote_not_found' });
    return found;
  };
  const strip = ({ tabs: _t, emit: _e, end: _end, view: _v, size: _size, seq: _s, timer: _timer, streams: _streams, ...browser }: Demo): BrowserEnvironment => browser;

  /** The frame of the tab in view: the habitual browser sends one after another, the dedicated one on change. */
  const send = (browser: Demo) => {
    clearTimeout(browser.timer);
    const shown = browser.tabs.find((each) => each.id === browser.view);
    if (!shown || !browser.emit) return;
    // The shop's capture stretched to the view, as the dedicated browser would draw the page at that size.
    const { data, viewport } = browser.kind === 'browser_habitual' ? DEMO_MAIL_FRAME : { data: DEMO_SHOP_FRAME.data, viewport: browser.size };
    browser.seq += 1;
    browser.emit({ type: 'frame', seq: browser.seq, tab: shown.id, data, viewport });
  };
  const tabsChanged = (browser: Demo) => browser.emit?.({ type: 'tabs', tabs: browser.tabs });

  const api: BrowsersApi = {
    list: async () => browsers.map(strip),
    async create(_requestId, kind) {
      const live = browsers.find((each) => each.kind === kind && each.state === 'running');
      if (live) return strip(live);
      const created = demo({
        id: id(`${kind === 'browser_habitual' ? 'habitual' : 'dedicated'}${browsers.length}`), kind, ownership: kind === 'browser_habitual' ? 'shared' : 'own',
        state: 'running', createdAt: browsers.length + 1, terminationError: null,
      });
      browsers.push(created);
      return strip(created);
    },
    async terminate(environmentId) {
      const browser = find(environmentId);
      browser.state = 'exited';
      clearTimeout(browser.timer);
      browser.emit?.({ type: 'closed', reason: 'exited' });
      browser.end();
      return strip(browser);
    },
    async discard(environmentId) { browsers.splice(browsers.indexOf(find(environmentId)), 1); },
  };

  const port = (environmentId: string): BrowserPort => ({
    frames(onData, signal) {
      const browser = find(environmentId);
      if (browser.state !== 'running') return Promise.reject(new RemoteFailure('remote', { code: 'remote_ended' }));
      const step = browser.kind === 'browser_habitual' ? HABITUAL_STREAMS[browser.streams++] : undefined;
      if (step === 'refused') return Promise.reject(new RemoteFailure('no_response'));
      if (step === 'broken') return Promise.reject(new RemoteFailure('unexpected'));
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const trouble = step === 'drops' || step === 'replaced' ? setTimeout(() => {
        if (step === 'drops') reject(new RemoteFailure('no_response'));
        else browser.emit?.({ type: 'closed', reason: 'replaced' });
        browser.end();
      }, DEMO_TROUBLE_MS) : undefined;
      browser.emit = (event) => onData(JSON.stringify(event));
      browser.end = () => { browser.emit = null; clearTimeout(browser.timer); clearTimeout(trouble); resolve(); };
      signal.addEventListener('abort', () => browser.end(), { once: true });
      browser.seq = 0;
      browser.emit({ type: 'open', channel: 'demo'.padEnd(22, '0') });
      tabsChanged(browser);
      return promise;
    },
    async view(_channel, view) {
      const browser = find(environmentId);
      browser.view = view.tab;
      browser.size = { width: view.width, height: view.height };
      queueMicrotask(() => send(browser));
      return { ok: true };
    },
    async ack() {
      const browser = find(environmentId);
      // The calendar's frames stop: its last frame grows stale.
      if (browser.kind === 'browser_habitual' && browser.view !== '102') browser.timer = setTimeout(() => send(browser), 1000);
      return { ok: true };
    },
    tabs: async () => ({ tabs: find(environmentId).tabs }),
    async open(url) {
      const browser = find(environmentId);
      const opened = tab(`n${browser.tabs.length}`, url ?? '', url ? new URL(url).host : '', { createdByRelay: true });
      browser.tabs = [...browser.tabs, opened];
      tabsChanged(browser);
      return opened;
    },
    async close(tabId) {
      const browser = find(environmentId);
      if (browser.kind === 'browser_habitual') throw new RemoteFailure('remote', { code: 'remote_unsupported' });
      browser.tabs = browser.tabs.filter((each) => each.id !== tabId);
      tabsChanged(browser);
      return { ok: true };
    },
    async act(tabId, action: BrowserAction) {
      const browser = find(environmentId);
      const index = browser.tabs.findIndex((each) => each.id === tabId);
      if (index < 0) throw new RemoteFailure('remote', { code: 'remote_not_found' });
      const current = browser.tabs[index]!;
      if (action.type === 'back' || action.type === 'forward') return { moved: false };
      if (action.type === 'files' && browser.kind === 'browser_habitual') throw new RemoteFailure('remote', { code: 'remote_unsupported' });
      const next = action.type === 'navigate' ? { ...current, url: action.url, title: new URL(action.url).host }
        : action.type === 'dialog' ? { ...current, dialog: null }
          : action.type === 'files' ? { ...current, fileChooser: null } : current;
      if (next !== current) {
        browser.tabs = browser.tabs.with(index, next);
        tabsChanged(browser);
      }
      // «Descargar factura» on the shop page: a download that stays on the Servidor. The button is at 440–488 of the capture's 700.
      const y = action.type === 'tap' ? action.y * DEMO_SHOP_FRAME.viewport.height / browser.size.height : 0;
      if (action.type === 'tap' && tabId === 'shop' && y > 440 && y < 488) {
        browser.emit?.({ type: 'download', name: 'factura-4127.pdf', path: '/home/user/Downloads/factura-4127.pdf' });
      }
      if (browser.kind === 'browser_dedicated') send(browser);
      return {};
    },
  });
  return { api, port };
}
