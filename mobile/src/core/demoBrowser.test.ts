import assert from 'node:assert/strict';
import test from 'node:test';
import { validBrowserTab } from '../../../protocol/remoteBrowser.ts';
import { readBrowser } from './browsers.ts';
import { createBrowserSession } from './browserSession.ts';
import { createDemoBrowsers, DEMO_TROUBLE_MS } from './demoBrowser.ts';

const flush = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
const never = () => Promise.withResolvers<void>().promise;

test('the demo shows each state of the Navegador tool through the real session: page, prompt, file chooser, limitation, download, shared tabs, ended and lost', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, port } = createDemoBrowsers();
  const [dedicated] = await api.list();
  assert.deepEqual(readBrowser({ ...dedicated }), dedicated);
  const session = createBrowserSession(port(dedicated!.id), { wait: never, dedicated: true });
  await flush();
  const { tabs } = session.state();
  assert.ok(tabs!.every(validBrowserTab));
  assert.deepEqual(tabs!.map((tab) => [Boolean(tab.dialog), Boolean(tab.fileChooser), tab.limitation]), [[false, false, null], [true, false, null], [false, true, null], [false, false, 'internal_page']]);
  // A phone's box, not the capture's 390 × 700: the dedicated demo draws the page at the view, as the real one does.
  session.resize({ width: 392, height: 612 }, 1);
  session.select('shop');
  await flush();
  assert.equal(session.state().live, true);
  assert.deepEqual(session.state().frame!.viewport, { width: 392, height: 612 });
  assert.deepEqual(await session.act({ type: 'tap', x: 196, y: 406 }), {});
  await flush();
  assert.deepEqual(session.state().downloads, [{ name: 'factura-4127.pdf', path: '/home/user/Downloads/factura-4127.pdf' }]);

  const habitual = await api.create('demo-request', 'browser_habitual');
  assert.equal(habitual.ownership, 'shared');
  const shared = createBrowserSession(port(habitual.id), { wait: never, staleAfterMs: 5000 });
  await flush();
  shared.resize({ width: 390, height: 700 }, 1);
  shared.select('102');
  await flush();
  assert.equal(shared.state().live, true);
  t.mock.timers.tick(5000);
  assert.equal(shared.state().aged, true, 'the calendar\'s frames stop');
  assert.deepEqual(shared.state().tabs!.map((tab) => tab.limitation), [null, null, 'debugger_busy']);

  assert.equal((await api.terminate(dedicated!.id)).state, 'exited');
  await flush();
  assert.equal(session.state().link.state, 'exited');
  // With no running dedicated browser, the screen lists the ended one and the one the Servidor lost.
  assert.deepEqual((await api.list()).filter((browser) => browser.kind === 'browser_dedicated').map((browser) => browser.state), ['exited', 'lost']);
  session.close();
  shared.close();
});

test('the demo\'s habitual browser goes through every connection state: lost and reconnecting, open on another screen, no connection, then steady', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { api, port } = createDemoBrowsers();
  const habitual = await api.create('demo-request', 'browser_habitual');
  const session = createBrowserSession(port(habitual.id), { wait: async () => {}, staleAfterMs: 5000 });
  const states: string[] = [];
  session.subscribe(() => { const now = session.state().link.state; if (states.at(-1) !== now) states.push(now); });
  await flush();
  assert.equal(session.state().link.state, 'connected');

  t.mock.timers.tick(DEMO_TROUBLE_MS);
  await flush();
  assert.deepEqual(states, ['reconnecting', 'connected'], 'lost, a stream that does not answer, then back by itself');
  t.mock.timers.tick(DEMO_TROUBLE_MS);
  await flush();
  assert.equal(session.state().link.state, 'replaced');
  session.reconnect();
  await flush();
  assert.deepEqual(session.state().link, { state: 'failed', message: 'El Puente respondió algo inesperado.' });
  session.reconnect();
  await flush();
  t.mock.timers.tick(DEMO_TROUBLE_MS * 3);
  await flush();
  assert.equal(session.state().link.state, 'connected');
  assert.deepEqual(states, ['reconnecting', 'connected', 'replaced', 'connecting', 'failed', 'connecting', 'connected']);
  session.close();
});
