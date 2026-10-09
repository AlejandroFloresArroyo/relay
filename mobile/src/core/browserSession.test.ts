import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserTab } from '../../../protocol/remoteBrowser.ts';
import { BROWSER_LIMITS } from '../../../protocol/remoteBrowser.ts';
import type { BrowserPort } from './browsers.ts';
import { createBrowserSession } from './browserSession.ts';
import { RemoteFailure } from './remoteClient.ts';

const CHANNEL_A = 'A'.repeat(22);
const CHANNEL_B = 'B'.repeat(22);
const JPEG = Buffer.from('jpeg').toString('base64');
const flush = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
const tab = (id: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id, url: `https://example.com/${id}`, title: `Página ${id}`, limitation: null, createdByRelay: false, dialog: null, fileChooser: null, ...extra,
});
const frame = (seq: number, id = 'T1', viewport = { width: 400, height: 700 }) => ({ type: 'frame', seq, tab: id, data: JPEG, viewport });
const BOX = { width: 400, height: 700 };

/** A port whose streams and answers the test drives by hand; unanswered calls stay pending. */
function fakePort(auto: Record<string, unknown> = { view: { ok: true }, ack: { ok: true }, act: {} }) {
  const calls: unknown[][] = [];
  const streams: { send: (event: unknown) => void; end: (error?: unknown) => void; signal: AbortSignal }[] = [];
  const answers: { call: unknown[]; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const waits: { ms: number; resolve: () => void }[] = [];
  const answer = (...call: unknown[]) => {
    calls.push(call);
    if (Object.hasOwn(auto, call[0] as string)) return Promise.resolve(auto[call[0] as string]);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    answers.push({ call, resolve, reject });
    return promise;
  };
  const port: BrowserPort = {
    frames(onData, signal) {
      calls.push(['frames']);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => resolve(), { once: true });
      const send = (event: unknown) => { try { onData(JSON.stringify(event)); } catch (error) { reject(error); } };
      streams.push({ signal, send, end: (error) => (error ? reject(error) : resolve()) });
      return promise;
    },
    view: (channel, view) => answer('view', channel, view),
    ack: (channel, seq) => answer('ack', channel, seq),
    tabs: () => answer('tabs'),
    open: (url) => answer('open', url),
    close: (id) => answer('close', id),
    act: (id, action) => answer('act', id, action),
  };
  const wait = (ms: number, signal: AbortSignal) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    waits.push({ ms, resolve });
    signal.addEventListener('abort', () => resolve(), { once: true });
    return promise;
  };
  const settle = async (kind: string, value: unknown, failed = false) => {
    const index = answers.findIndex((a) => a.call[0] === kind);
    assert.ok(index >= 0, `no ${kind} waiting`);
    const [pending] = answers.splice(index, 1);
    if (failed) pending!.reject(value); else pending!.resolve(value);
    await flush();
  };
  return { port, calls, streams, wait, waits, settle, of: (kind: string) => calls.filter((c) => c[0] === kind) };
}

/** Connected, with T1 and T2 listed, T1 chosen, the box known and its first frame on screen. */
async function viewing(options: { staleAfterMs?: number; dedicated?: boolean } = {}) {
  const p = fakePort();
  const session = createBrowserSession(p.port, { wait: p.wait, ...options });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] });
  session.resize(BOX, 2);
  session.select('T1');
  await flush();
  p.streams[0]!.send(frame(1));
  await flush();
  return { p, session };
}

test('nothing is viewed until a tab is chosen; its frames are acked at once and only then may the page be touched', async () => {
  const p = fakePort();
  const session = createBrowserSession(p.port, { wait: p.wait });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] });
  session.resize(BOX, 2.75);
  await flush();
  assert.equal(session.state().link.state, 'connected');
  assert.deepEqual(session.state().tabs!.map((t) => t.id), ['T1', 'T2']);
  assert.deepEqual(p.of('view'), [], 'no tab chosen: no view');
  assert.equal(await session.act({ type: 'tap', x: 1, y: 1 }), null);

  session.select('T1');
  await flush();
  assert.deepEqual(p.of('view'), [['view', CHANNEL_A, { tab: 'T1', width: 400, height: 700, scale: 2, quality: BROWSER_LIMITS.quality }]]);
  assert.equal(session.state().live, false, 'no frame yet');
  assert.equal(await session.act({ type: 'tap', x: 1, y: 1 }), null);
  assert.deepEqual(p.of('act'), []);

  p.streams[0]!.send(frame(1));
  await flush();
  assert.deepEqual(p.of('ack'), [['ack', CHANNEL_A, 1]]);
  assert.equal(session.state().live, true);
  assert.deepEqual(session.state().frame, { seq: 1, tab: 'T1', data: JPEG, viewport: { width: 400, height: 700 } });
  assert.deepEqual(await session.act({ type: 'tap', x: 10, y: 20 }), {});
  assert.deepEqual(p.of('act'), [['act', 'T1', { type: 'tap', x: 10, y: 20 }]]);
  session.close();
});

test('a new size or another tab makes the frame stale until the frame of the new view arrives; another tab\'s frame is acked, never shown', async () => {
  const { p, session } = await viewing();
  // Rotated: a landscape box.
  session.resize({ width: 700, height: 400 }, 2);
  await flush();
  assert.deepEqual(p.of('view').at(-1), ['view', CHANNEL_A, { tab: 'T1', width: 700, height: 400, scale: 2, quality: BROWSER_LIMITS.quality }]);
  assert.equal(session.state().live, false);
  assert.equal(await session.act({ type: 'scroll', x: 1, y: 1, dx: 0, dy: 50 }), null);
  assert.equal(await session.act({ type: 'text', text: 'hola' }), null);
  p.streams[0]!.send(frame(2, 'T1', { width: 700, height: 400 }));
  await flush();
  assert.equal(session.state().live, true);

  session.select('T2');
  await flush();
  assert.equal(session.state().live, false);
  assert.equal(session.state().frame, null, 'another tab: the image of the previous one is not shown as this one');
  p.streams[0]!.send(frame(3, 'T1'));
  await flush();
  assert.equal(session.state().frame, null, 'a late frame of the previous tab is not shown');
  assert.equal(session.state().live, false);
  assert.deepEqual(p.of('ack').at(-1), ['ack', CHANNEL_A, 3], 'but it is acked, so the stream goes on');
  p.streams[0]!.send(frame(4, 'T2'));
  await flush();
  assert.equal(session.state().live, true);
  assert.equal(p.of('act').length, 0);
  session.close();
});

test('in the dedicated browser a frame counts only at the size of the view asked for: one drawn before a turn is never live', async () => {
  const { p, session } = await viewing({ dedicated: true });
  assert.equal(session.state().live, true);
  session.resize({ width: 700, height: 400 }, 2);
  await flush();
  // Drawn at the earlier size, it arrives after the new view was asked for; a tap on it would land elsewhere.
  p.streams[0]!.send(frame(2, 'T1', { width: 400, height: 700 }));
  await flush();
  assert.deepEqual(p.of('ack').at(-1), ['ack', CHANNEL_A, 2], 'acked, so the next frame can come');
  assert.equal(session.state().live, false);
  assert.equal(await session.act({ type: 'tap', x: 10, y: 20 }), null);
  assert.equal(await session.act({ type: 'key', key: 'Enter' }), null);
  assert.deepEqual(p.of('act'), []);
  p.streams[0]!.send(frame(3, 'T1', { width: 700, height: 400 }));
  await flush();
  assert.equal(session.state().live, true);
  assert.deepEqual(session.state().frame!.viewport, { width: 700, height: 400 });
  session.close();

  // The habitual browser keeps the size of the person's window: its frame's viewport is the page's, whatever the view.
  const { p: q, session: shared } = await viewing({ staleAfterMs: 60_000 });
  shared.resize({ width: 700, height: 400 }, 2);
  await flush();
  q.streams[0]!.send(frame(2, 'T1', { width: 1280, height: 800 }));
  await flush();
  assert.equal(shared.state().live, true);
  shared.close();
});

test('a lost stream suspends control and keeps the last frame only as stale; the next channel views again from scratch', async () => {
  const { p, session } = await viewing();
  p.streams[0]!.end(new RemoteFailure('no_response'));
  await flush();
  assert.equal(session.state().link.state, 'reconnecting');
  assert.equal(session.state().live, false);
  assert.ok(session.state().frame, 'the last frame stays, to be shown as stale');
  for (const action of [{ type: 'tap', x: 1, y: 1 }, { type: 'reload' }, { type: 'key', key: 'Enter' }] as const) assert.equal(await session.act(action), null);
  // Checked before awaiting: what is sent would wait forever for an answer.
  const opened = session.open('https://example.com');
  await flush();
  assert.deepEqual(p.of('open'), [], 'no stream: nothing opened');
  assert.equal(await opened, false);
  assert.deepEqual(p.of('act'), []);

  p.waits[0]!.resolve();
  await flush();
  assert.equal(p.streams.length, 2);
  p.streams[1]!.send({ type: 'open', channel: CHANNEL_B });
  await flush();
  assert.deepEqual(p.of('view').at(-1)![1], CHANNEL_B, 'the view is asked again on the new channel');
  assert.equal(session.state().live, false, 'connected again, but the frame is from before');
  p.streams[1]!.send(frame(1));
  await flush();
  assert.deepEqual(p.of('ack').at(-1), ['ack', CHANNEL_B, 1]);
  assert.equal(session.state().live, true);
  session.close();
});

test('a dialog takes only its answer; a limitation takes nothing, is never viewed, and is viewed again once it clears', async () => {
  const { p, session } = await viewing();
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1', { dialog: { type: 'prompt', message: '¿Nombre?', defaultPrompt: 'Ana' } }), tab('T2')] });
  await flush();
  assert.equal(session.state().live, false);
  assert.equal(await session.act({ type: 'tap', x: 1, y: 1 }), null);
  assert.equal(await session.act({ type: 'reload' }), null);
  assert.deepEqual(await session.act({ type: 'dialog', accept: true, text: 'Ana María' }), {});
  assert.deepEqual(p.of('act'), [['act', 'T1', { type: 'dialog', accept: true, text: 'Ana María' }]]);

  const views = p.of('view').length;
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2', { limitation: 'debugger_busy' })] });
  session.select('T2');
  await flush();
  assert.equal(p.of('view').length, views, 'a limited tab is not viewed');
  assert.equal(await session.act({ type: 'reload' }), null);
  assert.equal(session.state().notice, 'Las DevTools u otra herramienta de depuración ocupan esta pestaña. Ciérralas en la computadora.');
  assert.equal(await session.act({ type: 'dialog', accept: false }), null, 'no dialog open: nothing to answer');
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] });
  await flush();
  assert.deepEqual(p.of('view').at(-1)![2], { tab: 'T2', width: 400, height: 700, scale: 2, quality: BROWSER_LIMITS.quality });
  assert.equal(p.of('act').length, 1);
  session.close();
});

test('a refused action refreshes the tabs and says why; a tab that disappears is no longer chosen', async () => {
  const p = fakePort({ view: { ok: true }, ack: { ok: true } });
  const session = createBrowserSession(p.port, { wait: p.wait });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] });
  session.resize(BOX, 1);
  session.select('T1');
  await flush();
  p.streams[0]!.send(frame(1));
  await flush();
  const tapped = session.act({ type: 'tap', x: 5, y: 5 });
  await p.settle('act', new RemoteFailure('remote', { code: 'remote_browser_limited' }), true);
  assert.equal(await tapped, null);
  await p.settle('tabs', { tabs: [tab('T1', { limitation: 'canceled_by_user' }), tab('T2')] });
  assert.equal(session.state().notice, 'Se canceló el control de Relay en la computadora. Vuelve a compartir la pestaña allí para seguir.');
  assert.equal(session.state().live, false);

  const backed = session.act({ type: 'back' });
  await flush();
  assert.equal(p.of('act').length, 1, 'still limited: nothing sent');
  assert.equal(await backed, null);
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T2')] });
  await flush();
  assert.equal(session.state().tab, null);
  assert.equal(session.state().frame, null);
  session.close();
});

test('back and forward at the end of the history say so; an action the mode lacks is sent to the computer', async () => {
  const q = fakePort({ view: { ok: true }, ack: { ok: true } });
  const other = createBrowserSession(q.port, { wait: q.wait });
  q.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  q.streams[0]!.send({ type: 'tabs', tabs: [tab('T1')] });
  other.resize(BOX, 1);
  other.select('T1');
  await flush();
  const back = other.act({ type: 'back' });
  await q.settle('act', { moved: false });
  assert.deepEqual(await back, { moved: false });
  assert.equal(other.state().notice, 'No hay más páginas en el historial de esta pestaña.');
  const navigated = other.act({ type: 'navigate', url: 'https://example.com/b' });
  await q.settle('act', new RemoteFailure('remote', { code: 'remote_unsupported' }), true);
  assert.equal(await navigated, null);
  assert.equal(other.state().notice, 'Relay no puede hacer esto en este navegador o en esta página. Hazlo en la computadora.');
  other.close();
});

test('a frame over the limit asks for density 1, then the lowest quality, then says the page does not fit', async () => {
  const { p, session } = await viewing();
  p.streams[0]!.send({ type: 'oversized', tab: 'T1' });
  await flush();
  assert.deepEqual(p.of('view').at(-1)![2], { tab: 'T1', width: 400, height: 700, scale: 1, quality: BROWSER_LIMITS.quality });
  assert.equal(session.state().live, false);
  p.streams[0]!.send({ type: 'oversized', tab: 'T1' });
  await flush();
  assert.deepEqual(p.of('view').at(-1)![2], { tab: 'T1', width: 400, height: 700, scale: 1, quality: BROWSER_LIMITS.qualityMin });
  const views = p.of('view').length;
  p.streams[0]!.send({ type: 'oversized', tab: 'T1' });
  await flush();
  assert.equal(p.of('view').length, views);
  assert.equal(session.state().notice, 'Esta página no cabe en una captura para el teléfono. Mírala en la computadora.');
  session.close();
});

test('the habitual browser\'s frames keep coming while it is shared: one that stops coming is stale', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p, session } = await viewing({ staleAfterMs: 5000 });
  t.mock.timers.tick(4999);
  assert.equal(session.state().live, true);
  t.mock.timers.tick(1);
  assert.equal(session.state().live, false);
  assert.equal(session.state().aged, true);
  assert.equal(await session.act({ type: 'tap', x: 1, y: 1 }), null);
  p.streams[0]!.send(frame(2));
  await flush();
  assert.equal(session.state().live, true);
  assert.equal(session.state().aged, false);
  session.close();
});

test('downloads stay listed until dismissed; text over the limit goes in order, never splitting a character', async () => {
  const { p, session } = await viewing();
  p.streams[0]!.send({ type: 'download', name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' });
  p.streams[0]!.send({ type: 'download', name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' });
  await flush();
  assert.deepEqual(session.state().downloads, [{ name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' }]);
  session.dismissDownload('/home/ana/Downloads/factura.pdf');
  assert.deepEqual(session.state().downloads, []);

  const text = 'a'.repeat(BROWSER_LIMITS.textChars - 1) + '😀' + 'ñ';
  assert.deepEqual(await session.act({ type: 'text', text }), {});
  const sent = p.of('act').map(([, , action]) => action);
  assert.deepEqual(sent, [{ type: 'text', text: 'a'.repeat(BROWSER_LIMITS.textChars - 1) }, { type: 'text', text: '😀ñ' }]);
  session.close();
});

test('a browser that ended is final; closing sends nothing more; a malformed event stops instead of guessing', async () => {
  const p = fakePort();
  const ended = createBrowserSession(p.port, { wait: p.wait });
  p.streams[0]!.end(new RemoteFailure('remote', { code: 'remote_ended' }));
  await flush();
  assert.equal(ended.state().link.state, 'ended');
  assert.equal(p.streams.length, 1);

  const { p: q, session } = await viewing();
  const before = q.calls.length;
  session.close();
  assert.ok(q.streams[0]!.signal.aborted);
  session.select('T2');
  session.resize({ width: 300, height: 300 }, 1);
  assert.equal(await session.act({ type: 'reload' }), null);
  await flush();
  assert.deepEqual(q.calls.slice(before), []);
  assert.equal(session.state().link.state, 'closed');
  assert.equal(session.state().live, false);

  const r = fakePort();
  const bad = createBrowserSession(r.port, { wait: r.wait });
  r.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  r.streams[0]!.send({ type: 'tabs', tabs: [{ ...tab('T1'), id: '../x' }] });
  await flush();
  assert.equal(bad.state().link.state, 'failed');
  assert.equal(r.streams.length, 1);
});

test('a session opened again after a suspension views the tab chosen before, if it is still listed', async () => {
  const p = fakePort();
  const session = createBrowserSession(p.port, { wait: p.wait, tab: 'T2' });
  p.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  p.streams[0]!.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] });
  session.resize(BOX, 1);
  await flush();
  assert.deepEqual(p.of('view'), [['view', CHANNEL_A, { tab: 'T2', width: 400, height: 700, scale: 1, quality: BROWSER_LIMITS.quality }]]);
  assert.equal(session.state().live, false, 'never the frame from before: it waits for its own');
  session.close();

  const q = fakePort();
  const gone = createBrowserSession(q.port, { wait: q.wait, tab: 'T9' });
  q.streams[0]!.send({ type: 'open', channel: CHANNEL_A });
  q.streams[0]!.send({ type: 'tabs', tabs: [tab('T1')] });
  gone.resize(BOX, 1);
  await flush();
  assert.equal(gone.state().tab, null);
  assert.deepEqual(q.of('view'), []);
  gone.close();
});

test('a box with no size, as when the tool is hidden, never asks the browser for a tiny view', async () => {
  const { p, session } = await viewing();
  const views = p.of('view').length;
  session.resize({ width: 0, height: 0 }, 2);
  session.resize({ width: 400, height: 0 }, 2);
  await flush();
  assert.equal(p.of('view').length, views);
  assert.equal(session.state().live, true);
  session.close();
});
