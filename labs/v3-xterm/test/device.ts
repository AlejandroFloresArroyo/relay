// ADB and WebView DevTools access for the Android suite. Every command targets ANDROID_SERIAL;
// the suite refuses to run unless that device is in state `device`.
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = process.env.ADB ?? `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`}/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL;
export const PKG = 'dev.relay.lab.xterm';

export function adb(...args: string[]): string {
  if (!SERIAL) throw new Error('ANDROID_SERIAL is required');
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
}

export function assertDevice() {
  const state = adb('get-state').trim();
  if (state !== 'device') throw new Error(`${SERIAL} is ${state}, not device`);
}

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

// Polls until `probe` returns a truthy value; probe errors count as "not yet".
export async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeout = 10_000): Promise<Truthy<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    let value: T | undefined;
    try {
      value = await probe();
    } catch {
      value = undefined;
    }
    if (value) return value as Truthy<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(value)})`);
    await sleep(100);
  }
}

// Lines the lab app wrote with console.log('LAB ...'); logcat is cleared on every launch.
export function labLog(): string[] {
  return adb('logcat', '-d', '-v', 'raw', 'ReactNativeJS:V', '*:S')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('LAB '));
}

// Every byte the native side received from the terminal since launch, in order.
export function received(): string {
  return labLog()
    .filter((line) => line.startsWith('LAB in '))
    .map((line) => JSON.parse(line.slice('LAB in '.length)) as string)
    .join('');
}

export function lines(): string[] {
  return labLog()
    .filter((line) => line.startsWith('LAB line '))
    .map((line) => JSON.parse(line.slice('LAB line '.length)) as string);
}

export function lastSize() {
  const sizes = labLog().filter((line) => line.startsWith('LAB size '));
  const match = sizes.at(-1)?.match(/cols=(\d+) rows=(\d+)/);
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : null;
}

export function keyboardShown() {
  return /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'));
}

// Text typed on the emulator's `qwerty2` evdev keyboard, the path a physical keyboard takes.
// (`emu event send` reaches no input device on a headless emulator 37.2.)
export function hardText(text: string) {
  adb('emu', 'event', 'text', text);
}

// Named keys and chords as keyboard-source key events injected by the input manager, e.g.
// hardKeys('CTRL_LEFT', 'C'). Not the evdev path, but the same KeyEvents an app receives.
export function hardKeys(...combo: string[]) {
  const codes = combo.map((key) => `KEYCODE_${key}`);
  if (codes.length === 1) adb('shell', 'input', 'keyboard', 'keyevent', codes[0]);
  else adb('shell', 'input', 'keyboard', 'keycombination', ...codes);
}

export function tap(x: number, y: number) {
  adb('shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y)));
}

// Screen bounds of the WebView, from the accessibility tree.
export function webViewBounds() {
  const xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const match = xml.match(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!match) throw new Error('no WebView on screen');
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return { left, top, right, bottom };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Target = { type: string; webSocketDebuggerUrl: string };
type Evaluation = { result: { value: unknown }; exceptionDetails?: unknown };

export class Page {
  private ws: WebSocket;
  private port: string;
  private next = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, (params: unknown) => void>();

  private constructor(ws: WebSocket, port: string) {
    this.ws = ws;
    this.port = port;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id === undefined) return this.listeners.get(message.method ?? '')?.(message.params);
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
    });
  }

  static async connect(): Promise<Page> {
    const pid = await waitFor('app process', () => adb('shell', 'pidof', PKG).trim());
    const socket = `webview_devtools_remote_${pid}`;
    await waitFor('WebView DevTools socket', () => adb('shell', 'cat', '/proc/net/unix').includes(socket));
    const port = adb('forward', 'tcp:0', `localabstract:${socket}`).trim();
    const target = await waitFor('page target', async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[];
      return targets.find((target) => target.type === 'page');
    });
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const open = Promise.withResolvers<unknown>();
    ws.addEventListener('open', open.resolve, { once: true });
    ws.addEventListener('error', open.reject, { once: true });
    await open.promise;
    return new Page(ws, port);
  }

  // DevTools replies are trusted to match the method's documented shape.
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params }));
    const reply = Promise.withResolvers<unknown>();
    this.pending.set(id, reply);
    return reply.promise as Promise<T>;
  }

  on(method: string, listener: (params: unknown) => void) {
    this.listeners.set(method, listener);
  }

  async eval<T = unknown>(expression: string, userGesture = false): Promise<T> {
    const result = await this.send<Evaluation>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value as T;
  }

  // Visible rows of the active buffer, right-trimmed.
  screen(): Promise<string[]> {
    return this.eval(`(() => {
      const t = window.__lab.term, b = t.buffer.active, rows = [];
      for (let i = b.viewportY; i < b.viewportY + t.rows; i++) rows.push(b.getLine(i).translateToString(true));
      return rows;
    })()`);
  }

  async heapSnapshot(): Promise<string> {
    let snapshot = '';
    this.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
      if (params && typeof params === 'object' && 'chunk' in params) snapshot += String(params.chunk);
    });
    await this.send('HeapProfiler.collectGarbage');
    await this.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    return snapshot;
  }

  close() {
    this.ws.close();
    adb('forward', '--remove', `tcp:${this.port}`);
  }
}

export async function launch(config: string): Promise<Page> {
  assertDevice();
  adb('shell', 'am', 'force-stop', PKG);
  adb('logcat', '-c');
  adb('shell', `am start -W -a android.intent.action.VIEW -d 'v3xterm://lab?config=${config}' ${PKG}`);
  const page = await Page.connect();
  await waitFor('shell prompt', async () => (await page.screen().catch(() => [''])).join('\n').includes('$'), 20_000);
  return page;
}
