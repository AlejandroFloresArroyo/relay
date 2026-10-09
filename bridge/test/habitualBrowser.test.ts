// The Puente's extension socket, the native messaging host and its registration (#93). The extension's
// side of the socket is the transport double in support/fake_extension.ts; the host runs for real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { validBrowserAction } from '../../protocol/remoteBrowser.ts';
import {
  BROWSER_DIRECTORY, EXTENSION_LINE_CHARS, EXTENSION_PROTOCOL, EXTENSION_SOCKET_FILE, extensionIdOf, HOST_WRAPPER_FILE, listenExtension, NATIVE_HOST_NAME, RELAY_EXTENSION_ID, registerNativeHost,
  type ExtensionLink,
} from '../src/remote/habitualBrowser.ts';
import { RemoteError } from '../src/remote/routes.ts';
import { connectExtension, listedTab, ORIGIN, sharedTab } from '../support/fake_extension.ts';

const HOST = new URL('../src/remote/browserHost.ts', import.meta.url).pathname;

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
}

async function temporary(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function link(t: TestContext, options: Partial<Parameters<typeof listenExtension>[0]> = {}): Promise<ExtensionLink & { root: string; logs: string[] }> {
  const root = await temporary(t);
  const logs: string[] = [];
  const opened = await listenExtension({ stateDirectory: root, log: (line) => logs.push(line), ...options });
  t.after(() => opened.close());
  return Object.assign(opened, { root, logs });
}

const code = (expected: string) => (error: unknown) => error instanceof RemoteError && error.code === expected;
const available = async (puente: ExtensionLink) => (await puente.availability()).state === 'available';

test('the extension socket is 0600 inside a private directory of the Puente state', async (t) => {
  const puente = await link(t);
  assert.equal(puente.socketPath, path.join(puente.root, BROWSER_DIRECTORY, EXTENSION_SOCKET_FILE));
  assert.equal((await fs.stat(puente.socketPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(puente.socketPath))).mode & 0o777, 0o700);
  await assert.rejects(listenExtension({ stateDirectory: puente.root }), /already listening/, 'a second Puente never takes the socket');

  const elsewhere = await temporary(t);
  await fs.mkdir(path.join(elsewhere, 'target'));
  await fs.symlink(path.join(elsewhere, 'target'), path.join(elsewhere, BROWSER_DIRECTORY));
  await assert.rejects(listenExtension({ stateDirectory: elsewhere }), /private directory/, 'a symbolic link is not the Puente directory');
  const shared = await temporary(t);
  await fs.mkdir(path.join(shared, BROWSER_DIRECTORY), { mode: 0o755 });
  await fs.chmod(path.join(shared, BROWSER_DIRECTORY), 0o755);
  await assert.rejects(listenExtension({ stateDirectory: shared }), /private directory/, 'nor is a directory others can enter');
});

test('only the installed extension is heard: another origin, another version, no hello or anything else first is refused', async (t) => {
  const puente = await link(t, { helloTimeoutMs: 100 });
  assert.deepEqual(await puente.availability(), { state: 'unavailable', reason: 'not_configured' });
  const hellos: (Record<string, unknown> | null)[] = [
    { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' },
    { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL, origin: `chrome-extension://${RELAY_EXTENSION_ID}` },
    { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL },
    { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL, origin: ORIGIN, key: 'extra' },
    { type: 'response', id: 1, ok: true, result: [] },
    null,
  ];
  for (const hello of hellos) {
    const extension = await connectExtension(puente.socketPath, hello);
    await until(() => extension.ended, `refused: ${JSON.stringify(hello)}`);
    assert.equal(await available(puente), false, JSON.stringify(hello));
    assert.deepEqual(extension.requests, []);
  }
  const older = await connectExtension(puente.socketPath, { type: 'hello', extensionProtocol: EXTENSION_PROTOCOL - 1, origin: ORIGIN });
  await until(() => older.ended, 'another version refused');
  assert.deepEqual(await puente.availability(), { state: 'unavailable', reason: 'helper_incompatible' });

  const extension = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'the Relay extension is connected');
  extension.tabs = [sharedTab(7)];
  assert.deepEqual(await puente.tabs(), [listedTab(7)]);
  assert.ok(puente.logs.every((line) => !line.includes(RELAY_EXTENSION_ID) && !line.includes('chrome-extension')), puente.logs.join('\n'));
});

test('a second connection is refused while the first lasts and accepted once it ended', async (t) => {
  const puente = await link(t);
  const first = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'first connected');
  const second = await connectExtension(puente.socketPath);
  await until(() => second.ended, 'second connection refused');
  first.tabs = [sharedTab(1)];
  assert.deepEqual(await puente.tabs(), [listedTab(1)], 'the first one still answers');
  assert.deepEqual(second.requests, []);
  assert.ok(puente.logs.includes('A second browser extension connection was refused.'));

  first.socket.destroy();
  await until(async () => !(await available(puente)), 'first gone');
  assert.deepEqual(await puente.availability(), { state: 'unavailable', reason: 'not_configured' });
  const third = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'a new connection after the first ended');
  third.tabs = [sharedTab(3)];
  assert.deepEqual(await puente.tabs(), [listedTab(3)]);
});

test('every answer is checked: anything but exactly the expected shape is refused, never passed on', async (t) => {
  const puente = await link(t);
  const extension = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'connected');
  for (const tabs of [
    [{ ...sharedTab(1), cookies: 'SID=secret' }],
    [{ ...sharedTab(1), limitation: 'everything' }],
    [{ ...sharedTab(1), dialog: { type: 'alert', message: 'x'.repeat(1001), defaultPrompt: '' } }],
    [{ ...sharedTab(1), dialog: { type: 'prompt', message: '', defaultPrompt: 'x'.repeat(1001) } }],
    [{ ...sharedTab(1), dialog: { type: 'prompt', message: '' } }],
    [{ ...sharedTab(1), title: 'x'.repeat(301) }],
    [{ ...sharedTab(1), fileChooser: { multiple: 'yes' } }],
    [{ ...sharedTab(1), fileChooser: { multiple: true, backendNodeId: 42 } }],
    [{ ...sharedTab(1), fileChooser: undefined }],
    [sharedTab(-1)],
    { 0: sharedTab(1) },
    Array.from({ length: 101 }, (_, index) => sharedTab(index)),
  ]) {
    extension.reply = (request) => ({ ok: true, result: request.op === 'tabs' ? tabs : {} });
    await assert.rejects(puente.tabs(), code('remote_unavailable'), JSON.stringify(tabs).slice(0, 80));
  }
  for (const result of [
    { data: 'x'.repeat(933_337), viewport: { width: 10, height: 10 } },
    { data: 'not base64!', viewport: { width: 10, height: 10 } },
    { data: 'AAAA', viewport: { width: 0, height: 10 } },
    { data: 'AAAA', viewport: { width: 10, height: 10 }, cookies: [] },
    { data: 'AAAA', viewport: { width: 10, height: 10, scale: 2 } },
    // An extension of the first channel version: the image's size, not the viewport.
    { data: 'AAAA', width: 10, height: 10 },
  ]) {
    extension.reply = () => ({ ok: true, result });
    await assert.rejects(puente.frame('1', 640, 60), code('remote_unavailable'));
  }
  extension.reply = () => ({ ok: true, result: { data: 'AAAA', viewport: { width: 10, height: 10 } } });
  assert.deepEqual(await puente.frame('1', 640, 60), { data: 'AAAA', viewport: { width: 10, height: 10 } });
  assert.deepEqual(extension.requests.at(-1), { id: extension.requests.at(-1)!.id, op: 'act', tabId: 1, action: { type: 'frame', maxWidth: 640, quality: 60 } });
  extension.reply = () => ({ ok: true, result: { moved: 'yes' } });
  await assert.rejects(puente.act('1', { type: 'back' }), code('remote_unavailable'));
  extension.reply = () => ({ ok: true, result: { evaluated: 2 } });
  await assert.rejects(puente.act('1', { type: 'reload' }), code('remote_unavailable'));
  extension.reply = () => ({ ok: true, result: [sharedTab(1, { fileChooser: { multiple: true } })] });
  assert.deepEqual((await puente.tabs())[0]!.fileChooser, { multiple: true });

  // A download is an absolute path and its own last component, nothing else and never more than the extension keeps.
  for (const downloads of [
    [{ name: 'a.pdf', path: 'Downloads/a.pdf' }], [{ name: 'b.pdf', path: '/home/p/Downloads/a.pdf' }], [{ name: '', path: '/' }],
    [{ name: 'a.pdf', path: '/home/p/a.pdf', url: 'https://bank.example/?token=1' }], [{ name: 'a\0', path: '/home/p/a\0' }],
    [{ name: 'x', path: `/${'x'.repeat(4096)}` }], [{ name: '\uD800', path: '/\uD800' }], { 0: { name: 'a', path: '/a' } },
    Array.from({ length: 21 }, (_, index) => ({ name: `${index}`, path: `/d/${index}` })),
  ]) {
    extension.reply = (request) => ({ ok: true, result: request.op === 'downloads' ? downloads : {} });
    await assert.rejects(puente.downloads(), code('remote_unavailable'), JSON.stringify(downloads).slice(0, 80));
  }
  extension.reply = () => ({ ok: true, result: [{ name: 'informe (1).pdf', path: '/home/p/Descargas/informe (1).pdf' }] });
  assert.deepEqual(await puente.downloads(), [{ name: 'informe (1).pdf', path: '/home/p/Descargas/informe (1).pdf' }]);
  assert.deepEqual(extension.requests.at(-1), { id: extension.requests.at(-1)!.id, op: 'downloads' });

  // Failures are fixed codes: the extension's own text never reaches anyone.
  for (const [failure, expected] of [['not_shared', 'remote_not_found'], ['limited', 'remote_browser_limited'], ['frame_too_large', 'remote_too_large'],
    ['invalid', 'remote_invalid_request'], ['no_chooser', 'remote_conflict'], ['Cannot access https://bank.example/?token=1', 'remote_unavailable']] as const) {
    extension.reply = () => ({ ok: false, code: failure });
    await assert.rejects(puente.act('1', { type: 'reload' }), (error) => code(expected)(error) && !String((error as Error).message).includes('bank'));
  }
  assert.ok(puente.logs.every((line) => !line.includes('secret') && !line.includes('bank')), puente.logs.join('\n'));
});

test('the extension can only answer: a request of its own, or an answer nobody asked for, ends the connection', async (t) => {
  const puente = await link(t);
  for (const line of [{ id: 1, op: 'tabs' }, { type: 'response', id: 999, ok: true, result: [] }, { type: 'event', name: 'shared' }]) {
    const extension = await connectExtension(puente.socketPath);
    await until(() => available(puente), 'connected');
    extension.send(line);
    await until(() => extension.ended, `closed after ${JSON.stringify(line)}`);
    assert.equal(await available(puente), false, JSON.stringify(line));
  }
});

test('a line over the limit ends the connection by itself, with nothing pending and no timer to do it', async (t) => {
  const puente = await link(t, { requestTimeoutMs: 60_000 });
  const extension = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'connected');
  extension.socket.write('{"type":"response","id":1,"ok":true,"result":"' + 'x'.repeat(EXTENSION_LINE_CHARS));
  await until(() => extension.ended, 'closed after the long line');
  assert.equal(await available(puente), false);
});

test('a silent extension and a lost one fail what was pending without waiting', async (t) => {
  const puente = await link(t, { requestTimeoutMs: 200 });
  let extension = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'connected');
  extension.reply = () => null;
  await assert.rejects(puente.tabs(), code('remote_unavailable'));
  await until(() => extension.ended, 'closed after the timeout');

  extension = await connectExtension(puente.socketPath);
  await until(() => available(puente), 'connected once more');
  extension.reply = () => null;
  const started = Date.now();
  const lost = puente.tabs();
  extension.socket.destroy();
  await assert.rejects(lost, code('remote_unavailable'));
  assert.ok(Date.now() - started < 150, 'not after the timeout');
  await puente.release();
  await assert.rejects(puente.tabs(), code('remote_unavailable'));
});

/** Chrome's side of the host: 4-byte little-endian length, then JSON. */
function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

async function host(t: TestContext, origin = ORIGIN) {
  const root = await temporary(t);
  const socketPath = path.join(root, 'puente.sock');
  const lines: Record<string, unknown>[] = [];
  const connected = Promise.withResolvers<net.Socket>();
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) { lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
    });
    connected.resolve(socket);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const child = spawn(process.execPath, [HOST, socketPath, origin, '--parent-window=0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  t.after(() => { child.kill(); server.close(); });
  const fromHost: Record<string, unknown>[] = [];
  let pending = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      fromHost.push(JSON.parse(pending.subarray(4, 4 + pending.readUInt32LE(0)).toString('utf8')));
      pending = pending.subarray(4 + pending.readUInt32LE(0));
    }
  });
  return { child, exited, puente: await connected.promise, lines, fromHost };
}

test('the host gives the Puente the origin Chrome named, never one the extension wrote, and relays both ways', async (t) => {
  const { child, puente, lines, fromHost } = await host(t);
  child.stdin.write(frame({ type: 'hello', extensionProtocol: 1, origin: 'chrome-extension://forged/' }));
  child.stdin.write(frame({ type: 'response', id: 4, ok: true, result: [] }));
  await until(() => lines.length === 2, 'two lines');
  assert.deepEqual(lines, [{ type: 'hello', extensionProtocol: 1, origin: ORIGIN }, { type: 'response', id: 4, ok: true, result: [] }]);
  puente.write(`${JSON.stringify({ id: 5, op: 'tabs' })}\n`);
  await until(() => fromHost.length === 1, 'request reaches Chrome');
  assert.deepEqual(fromHost, [{ id: 5, op: 'tabs' }]);
});

test('the host refuses a request over the native messaging limit before Chrome sees it and keeps the channel', async (t) => {
  const { puente, lines, fromHost } = await host(t);
  puente.write(`${JSON.stringify({ id: 7, op: 'act', tabId: 1, action: { type: 'text', text: 'x'.repeat(1_100_000) } })}\n`);
  await until(() => lines.length === 1, 'refusal');
  assert.deepEqual(lines, [{ type: 'response', id: 7, ok: false, code: 'too_large' }]);
  puente.write(`${JSON.stringify({ id: 8, op: 'tabs' })}\n`);
  await until(() => fromHost.length === 1, 'next request');
  assert.deepEqual(fromHost, [{ id: 8, op: 'tabs' }]);
});

test('the host ends when Chrome closes the port or the Puente goes away', async (t) => {
  const closedByChrome = await host(t);
  closedByChrome.child.stdin.end();
  assert.deepEqual(await closedByChrome.exited, [0, null]);
  const closedByPuente = await host(t);
  closedByPuente.puente.destroy();
  assert.deepEqual(await closedByPuente.exited, [0, null]);
  const oversized = await host(t);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(2 * 1024 * 1024);
  oversized.child.stdin.write(header);
  assert.deepEqual(await oversized.exited, [1, null]);
});

test('registering a browser lets only the Relay extension start a host that reaches this Puente', async (t) => {
  const puente = await link(t);
  const config = await temporary(t);
  await assert.rejects(registerNativeHost({ stateDirectory: puente.root, configHome: config, browser: 'firefox', nodePath: process.execPath }), /Unknown browser/);
  const registered = await registerNativeHost({ stateDirectory: puente.root, configHome: config, browser: 'google-chrome', nodePath: process.execPath });
  assert.equal(registered.manifest, path.join(config, 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`));
  const wrapper = path.join(puente.root, BROWSER_DIRECTORY, HOST_WRAPPER_FILE);
  assert.deepEqual(JSON.parse(await fs.readFile(registered.manifest, 'utf8')), {
    name: NATIVE_HOST_NAME, description: 'Relay: adaptador local entre la extensión y el Puente', path: wrapper, type: 'stdio', allowed_origins: [ORIGIN],
  });
  assert.equal((await fs.stat(wrapper)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(registered.manifest)).mode & 0o777, 0o600);
  assert.deepEqual(await puente.availability(), { state: 'unavailable', reason: 'helper_stopped' });

  // What Chrome does: run the wrapper with the caller's origin, then talk over stdio.
  const child = spawn(wrapper, [ORIGIN, '--parent-window=0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  child.stdin.write(frame({ type: 'hello', extensionProtocol: EXTENSION_PROTOCOL }));
  await until(() => available(puente), 'the host reached the Puente');
  const again = await registerNativeHost({ stateDirectory: puente.root, configHome: config, browser: 'chromium', nodePath: process.execPath });
  assert.equal(again.manifest, path.join(config, 'chromium', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`));
});

test("the extension's ID follows Chrome's rule for a manifest key", () => {
  // The lab extension of #78, whose ID Chrome reported (docs/research/v3-cdp.md).
  const lab = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzR2sMCfB6NG1b4rFs6QaOfjnqVA7x0ywixMZPp3UFi1FGUs5tz4Buy2fYMHbu8lyocIVYFS66ihBJMv090TcoooO9BdwoOUr+X5wa9PIa3N0kdc574a++AdrQJIjGNQv316T9Dw1jUAKQGkzi7NHrcmUBxeOlDT/T0IcuqsUm01jQgxfI2Ib4fkODsuyiYiBc8/mWDSTM1zwx6pbDutj7vYQ/nV61xbdBXUV+kkouwH6BNixb6u6A0/cXt01MPR19M8p2G0FDi3iTYP5UiEeba4eXXHOPNPol7iW2nld8iIR5VfCtGvtDiItw+y9zaT5QgqZThiLjHkiWlOsYTgwuwIDAQAB';
  assert.equal(extensionIdOf(lab), 'opcncffglnlpmffjmnjekehnidddcfbk');
  assert.match(RELAY_EXTENSION_ID, /^[a-p]{32}$/);
});

test('the Puente and the extension accept exactly the same actions, and never a raw CDP command', async () => {
  // The extension is plain JavaScript that Chrome loads as is, outside the type-checked tree: a static
  // import would need declarations for it. Its own module, the one Chrome runs, is what is checked here.
  const extension: { validateAction(value: unknown): unknown } = await import(new URL('../extension/actions.js', import.meta.url).href);
  const cases: unknown[] = [
    null, [], 'navigate', {}, { type: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } },
    { type: 'evaluate', expression: '1' }, { type: 'Network.getCookies' }, { type: 'files', backendNodeId: 1, paths: ['/etc/passwd'] },
    { type: 'navigate', url: 'https://example.test/a?b=c' }, { type: 'navigate', url: 'http://127.0.0.1:3000/' },
    { type: 'navigate', url: 'chrome://settings' }, { type: 'navigate', url: 'javascript:alert(1)' }, { type: 'navigate', url: 'file:///etc/passwd' },
    { type: 'navigate', url: 'data:text/html,x' }, { type: 'navigate', url: `https://example.test/${'a'.repeat(2048)}` }, { type: 'navigate', url: 'https://x.test', method: 'Page.navigate' },
    { type: 'back' }, { type: 'forward' }, { type: 'reload' }, { type: 'reload', ignoreCache: true },
    { type: 'tap', x: 0, y: 20000 }, { type: 'tap', x: -1, y: 0 }, { type: 'tap', x: 1, y: Number.NaN }, { type: 'tap', x: '1', y: 1 }, { type: 'tap', x: 1.5, y: 2.25 },
    { type: 'scroll', x: 1, y: 1, dx: -10000, dy: 10000 }, { type: 'scroll', x: 1, y: 1, dx: 10001, dy: 0 },
    { type: 'text', text: 'ñ ✓' }, { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(1001) }, { type: 'text', text: 'a\uD800' },
    { type: 'key', key: 'Enter' }, { type: 'key', key: 'F12' }, { type: 'key', key: 'constructor' }, { type: 'key', key: 'toString' },
    { type: 'dialog', accept: true }, { type: 'dialog', accept: false, text: 'hola' }, { type: 'dialog', accept: 'yes' }, { type: 'dialog', accept: true, text: '' },
    { type: 'dialog', accept: true, text: '\uDC00' },
    { type: 'files', paths: ['/tmp/a'] }, { type: 'files', paths: ['/srv/ñ b.pdf', '/tmp/c'] }, { type: 'files', paths: [] }, { type: 'files', paths: ['tmp/a'] },
    { type: 'files', paths: ['/tmp/a\0b'] }, { type: 'files', paths: ['/\uD800'] }, { type: 'files', paths: [`/${'ñ'.repeat(2048)}`] }, { type: 'files', paths: [`/${'ñ'.repeat(2047)}x`] },
    { type: 'files', paths: Array.from({ length: 11 }, (_, index) => `/tmp/${index}`) }, { type: 'files', paths: '/tmp/a' }, { type: 'files', paths: [1] },
  ];
  for (const value of cases) assert.deepEqual(extension.validateAction(value), validBrowserAction(value), JSON.stringify(value)?.slice(0, 80));
  for (const raw of cases.slice(0, 8)) assert.equal(validBrowserAction(raw), null);
  // Where they differ, on purpose: a frame is the Puente's own request to the extension, never the phone's.
  const frame = { type: 'frame', maxWidth: 640, quality: 20 };
  assert.deepEqual([extension.validateAction(frame), validBrowserAction(frame)], [frame, null]);
  for (const invalid of [{ type: 'frame', maxWidth: 63 }, { type: 'frame', quality: 86 }, { type: 'frame', maxWidth: 640.5 }]) assert.equal(extension.validateAction(invalid), null);
});

test("chrome.debugger's refusals become the tab's visible limitation; anything else stays a plain failure", async () => {
  // Plain JavaScript loaded by Chrome as is (see the test above).
  const extension: { limitationOf(message: string): string | null } = await import(new URL('../extension/actions.js', import.meta.url).href);
  const cases: [string, string | null][] = [
    ['Another debugger is already attached to the tab with id: 12.', 'debugger_busy'],
    ['Cannot access a chrome:// URL', 'internal_page'],
    ['Cannot access a chrome-extension:// URL of different extension', 'internal_page'],
    ["'Browser.getVersion' wasn't found", 'method_unavailable'],
    ['Cannot attach to this target.', 'restricted'],
    ['Cannot access contents of url "https://chromewebstore.google.com/". Extension manifest must request permission to access this host.', 'restricted'],
    ['No tab with given id 12.', null],
    ['Detached while handling command.', null],
  ];
  for (const [message, limitation] of cases) assert.equal(extension.limitationOf(message), limitation, message);
});

test('the extension opens only http(s) pages, whatever reaches it past the Puente', async () => {
  // The real background.js against a chrome.* double: the native boundary, nothing else. Imported
  // dynamically because it connects on load, so the double has to exist first.
  const listener = () => ({ addListener() {} });
  const posted: Record<string, unknown>[] = [];
  const created: string[] = [];
  let onMessage: ((message: unknown) => Promise<void>) | undefined;
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    action: { onClicked: listener(), setBadgeText: async () => {}, setTitle: async () => {} },
    tabs: {
      onRemoved: listener(), onUpdated: listener(),
      create: async ({ url }: { url: string }) => { created.push(url); return { id: 100 + created.length, title: '', url: '', pendingUrl: url }; },
    },
    debugger: { onDetach: listener(), onEvent: listener() },
    downloads: { onChanged: listener() },
    alarms: { create() {}, onAlarm: listener() },
    runtime: {
      connectNative: () => ({
        onMessage: { addListener: (handler: typeof onMessage) => { onMessage = handler; } },
        onDisconnect: listener(),
        postMessage: (message: Record<string, unknown>) => posted.push(message),
      }),
    },
  };
  Object.assign(globalThis, { chrome });
  await import(new URL('../extension/background.js', import.meta.url).href);
  assert.ok(onMessage, 'connected to the host');
  let id = 0;
  for (const url of ['chrome://version', 'chrome-extension://abc/page.html', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', `https://example.test/${'a'.repeat(2048)}`]) {
    await onMessage({ id: ++id, op: 'open', url });
    assert.deepEqual(posted.at(-1), { type: 'response', id, ok: false, code: 'invalid' }, url);
  }
  assert.deepEqual(created, []);
  await onMessage({ id: ++id, op: 'open', url: 'https://example.test/a' });
  assert.equal(posted.at(-1)?.ok, true);
  assert.deepEqual(created, ['https://example.test/a']);
});

test("the extension intercepts only the chooser of Relay's own tap, fills only that one, and hands over only shared tabs' downloads", async () => {
  // The real background.js against a chrome.* double, as above; a fresh module instance for this double.
  const listener = () => ({ addListener() {} });
  const posted: Record<string, unknown>[] = [];
  const commands: [string, unknown][] = [];
  let onMessage: ((message: unknown) => Promise<void>) | undefined;
  let onEvent: ((source: { tabId: number }, method: string, params: Record<string, unknown>) => void) | undefined;
  let onDownload: ((delta: unknown) => Promise<void>) | undefined;
  const items = new Map<number, { filename: string; referrer: string }>();
  /** The chooser the page opens when Relay presses, intercepted or not; null for none. */
  let pageOpensChooser: 'selectSingle' | 'selectMultiple' | null = 'selectMultiple';
  const chrome = {
    storage: { session: { get: async () => ({ shared: { 7: { createdByRelay: false, limitation: null } } }), set: async () => {} } },
    action: { onClicked: listener(), setBadgeText: async () => {}, setTitle: async () => {} },
    tabs: {
      onRemoved: listener(), onUpdated: listener(),
      get: async (tabId: number) => tabId === 7 ? { id: 7, title: 'Formulario', url: 'https://example.test/form' } : { id: tabId, url: 'https://other.test/' },
    },
    debugger: {
      onDetach: listener(), onEvent: { addListener: (handler: typeof onEvent) => { onEvent = handler; } },
      attach: async () => {},
      sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
        commands.push([method, params]);
        const intercepting = commands.findLast(([name]) => name === 'Page.setInterceptFileChooserDialog')?.[1] as { enabled: boolean } | undefined;
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && pageOpensChooser && intercepting?.enabled) {
          onEvent!({ tabId: 7 }, 'Page.fileChooserOpened', { frameId: 'f', mode: pageOpensChooser, backendNodeId: 42 });
        }
        return {};
      },
    },
    downloads: {
      onChanged: { addListener: (handler: typeof onDownload) => { onDownload = handler; } },
      search: async ({ id }: { id: number }) => items.has(id) ? [items.get(id)] : [],
    },
    alarms: { create() {}, onAlarm: listener() },
    runtime: {
      connectNative: () => ({
        onMessage: { addListener: (handler: typeof onMessage) => { onMessage = handler; } },
        onDisconnect: listener(),
        postMessage: (message: Record<string, unknown>) => posted.push(message),
      }),
    },
  };
  Object.assign(globalThis, { chrome });
  await import(new URL('../extension/background.js?files', import.meta.url).href);
  let id = 0;
  const ask = async (message: Record<string, unknown>) => { await onMessage!({ id: ++id, ...message }); return posted.at(-1)!; };
  const chooser = async () => ((await ask({ op: 'tabs' })).result as { fileChooser: unknown }[])[0]!.fileChooser;

  assert.deepEqual(await ask({ op: 'act', tabId: 7, action: { type: 'files', paths: ['/srv/a.pdf'] } }), { type: 'response', id, ok: false, code: 'no_chooser' });
  // Interception is on only while Relay's tap runs, so the chooser it opens is Relay's.
  assert.equal((await ask({ op: 'act', tabId: 7, action: { type: 'tap', x: 10, y: 20 } })).ok, true);
  const tap = commands.map(([method, params]) => method === 'Input.dispatchMouseEvent' ? `${method} ${(params as { type: string }).type}` : `${method} ${JSON.stringify(params)}`);
  assert.deepEqual(tap.slice(-5), [
    'Page.setInterceptFileChooserDialog {"enabled":true}', 'Input.dispatchMouseEvent mouseMoved', 'Input.dispatchMouseEvent mousePressed',
    'Input.dispatchMouseEvent mouseReleased', 'Page.setInterceptFileChooserDialog {"enabled":false}',
  ]);
  assert.deepEqual(await chooser(), { multiple: true });
  // Other actions never intercept: a chooser the person opens meanwhile stays theirs.
  await ask({ op: 'act', tabId: 7, action: { type: 'key', key: 'Enter' } });
  assert.ok(!commands.slice(-2).some(([method]) => method === 'Page.setInterceptFileChooserDialog'));

  assert.equal((await ask({ op: 'act', tabId: 7, action: { type: 'files', paths: ['/srv/a.pdf', '/srv/b.pdf'] } })).ok, true);
  assert.deepEqual(commands.at(-1), ['DOM.setFileInputFiles', { files: ['/srv/a.pdf', '/srv/b.pdf'], backendNodeId: 42 }]);
  assert.equal(await chooser(), null, 'filled once');
  assert.equal((await ask({ op: 'act', tabId: 7, action: { type: 'files', paths: ['/srv/a.pdf'] } })).code, 'no_chooser');
  // A single chooser takes one file; a tap that opens no chooser leaves none.
  pageOpensChooser = 'selectSingle';
  await ask({ op: 'act', tabId: 7, action: { type: 'tap', x: 1, y: 1 } });
  assert.deepEqual(await chooser(), { multiple: false });
  assert.equal((await ask({ op: 'act', tabId: 7, action: { type: 'files', paths: ['/srv/a.pdf', '/srv/b.pdf'] } })).code, 'invalid');
  assert.deepEqual(await chooser(), { multiple: false }, 'still there to fill with one file');
  await ask({ op: 'act', tabId: 7, action: { type: 'files', paths: ['/srv/a.pdf'] } });
  pageOpensChooser = null;
  await ask({ op: 'act', tabId: 7, action: { type: 'tap', x: 1, y: 1 } });
  assert.equal(await chooser(), null);

  // Downloads: only those whose referrer is a shared tab's page, finished, with an absolute path; once.
  items.set(1, { filename: '/home/p/Descargas/informe.pdf', referrer: 'https://example.test/form' });
  items.set(2, { filename: '/home/p/Descargas/banco.pdf', referrer: 'https://other.test/' });
  items.set(3, { filename: '/home/p/Descargas/sin-referrer.pdf', referrer: '' });
  items.set(4, { filename: 'relativa.pdf', referrer: 'https://example.test/form' });
  for (const item of [1, 2, 3, 4]) await onDownload!({ id: item, state: { current: 'complete' } });
  await onDownload!({ id: 1, state: { current: 'in_progress' } });
  assert.deepEqual((await ask({ op: 'downloads' })).result, [{ name: 'informe.pdf', path: '/home/p/Descargas/informe.pdf' }]);
  assert.deepEqual((await ask({ op: 'downloads' })).result, []);
  for (let item = 10; item < 35; item++) {
    items.set(item, { filename: `/home/p/Descargas/${item}.bin`, referrer: 'https://example.test/form' });
    await onDownload!({ id: item, state: { current: 'complete' } });
  }
  const kept = (await ask({ op: 'downloads' })).result as { name: string }[];
  assert.deepEqual(kept.map((download) => download.name), Array.from({ length: 20 }, (_, index) => `${index + 15}.bin`), 'the newest, bounded');
  assert.equal((await ask({ op: 'downloads', extra: 1 })).code, 'invalid');
});
