// Dedicated browsers through the real Puente, the real supervisor and its socket
// (protocol/remoteBrowser.ts). Only the browser behind its CDP pipe is the double
// (supervisor/support/fakeBrowser.ts): its pages, what they receive and its screencast.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BROWSER_LIMITS, type BrowserStreamEvent, type BrowserTab } from '../../protocol/remoteBrowser.ts';
import type { SupervisorOptions } from '../../supervisor/src/supervisor.ts';
import { lab, PHONE, TABLET, until, type Device } from '../support/remote_lab.ts';

let requests = 0;

async function browserLab(t: TestContext, options: Partial<SupervisorOptions> = {}) {
  const downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-downloads-'));
  t.after(() => fs.rm(downloads, { recursive: true, force: true }));
  const context = await lab(t, { browser: process.execPath, downloads, ...options });
  const puente = await context.puente();
  async function open(device: Device) {
    const created = await puente.call(device, 'POST', '/v1/remote/environments', { requestId: `browser-${++requests}`, kind: 'browser_dedicated' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const id = created.json.id as string;
    const tabs = (await puente.browser(device, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[];
    return { id, fake: context.host.browsers.get(context.unit(id))!, tab: tabs[0]!.id };
  }
  return { ...context, ...puente, startPuente: context.puente, open, downloads };
}

const ofType = <T extends BrowserStreamEvent['type']>(events: unknown[], type: T) =>
  events.filter((event): event is Extract<BrowserStreamEvent, { type: T }> => (event as BrowserStreamEvent).type === type);

test('a device opens its dedicated browser and uses its tabs; the log keeps no URL, text nor ID', async (t) => {
  const { open, browser, call, logs } = await browserLab(t);
  const { id, fake, tab } = await open(PHONE);
  const [listed] = (await call(PHONE, 'GET', '/v1/remote/environments')).json.environments as unknown[];
  assert.deepEqual(listed, { id, kind: 'browser_dedicated', ownership: 'own', createdAt: 1_700_000_000_000, state: 'running', exitCode: null, endedAt: null });
  const status = (await call(PHONE, 'GET', '/v1/remote/status', undefined, 'browser/1')).json;
  assert.deepEqual(status.browser, { dedicated: { state: 'available' }, habitual: { state: 'unavailable', reason: 'not_configured' } });

  const secretUrl = 'https://secret-site.example/path?token=abc';
  const opened = await browser(PHONE, 'POST', `${id}/tabs`, { url: secretUrl });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.url, secretUrl);
  const other = opened.json.id as string;
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'navigate', url: 'https://secret-site.example/two' })).json, {});
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'tap', x: 12, y: 34 })).json, {});
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'text', text: 'secret-text-5b1e' })).json, {});
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'back' })).json, { moved: true });
  assert.deepEqual(fake.pages.get(tab)!.inputs.find((input) => input.method === 'Input.insertText')?.params, { text: 'secret-text-5b1e' });
  assert.deepEqual((await browser(PHONE, 'DELETE', `${id}/tabs/${other}`)).json, { ok: true });
  await until(() => !fake.pages.has(other), 'tab closed');
  assert.deepEqual(((await browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[]).map((each) => each.id), [tab]);

  for (const secret of [id, tab, other, PHONE.key, 'secret-site', 'secret-text']) {
    assert.ok(logs.every((line) => !line.includes(secret)), `${secret} reached the log:\n${logs.join('\n')}`);
  }
  for (const label of ['GET /v1/remote/browsers/:id/tabs 200', 'POST /v1/remote/browsers/:id/tabs 200', 'POST /v1/remote/browsers/:id/tabs/:tab/action 200', 'DELETE /v1/remote/browsers/:id/tabs/:tab 200']) {
    assert.ok(logs.some((line) => line.startsWith(label)), `${label} missing:\n${logs.join('\n')}`);
  }
});

test('frames come one at a time for the tab in view, with tab state and downloads on the same stream', async (t) => {
  const { open, browser, frames, logs, downloads } = await browserLab(t);
  const { id, fake, tab } = await open(PHONE);
  const stream = await frames(PHONE, id);
  assert.equal(stream.status, 200);
  await until(() => ofType(stream.events, 'tabs').length > 0, 'open and tabs');
  assert.equal(stream.events[0]!.type, 'open');
  const channel = stream.channel();
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/view`, { channel, tab, width: 412, height: 800 })).json, { ok: true });
  assert.deepEqual(fake.pages.get(tab)!.metrics, { width: 412, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => ofType(stream.events, 'frame').length === 1, 'first frame');
  const [first] = ofType(stream.events, 'frame');
  assert.deepEqual({ ...first, data: Buffer.from(first!.data, 'base64').length }, { type: 'frame', seq: 1, tab, data: 6000, viewport: { width: 412, height: 800 } });
  fake.paint(fake.pages.get(tab)!);
  await sleep(30);
  assert.equal(ofType(stream.events, 'frame').length, 1, 'the next frame waits for the ack');
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/ack`, { channel, seq: 1 })).json, { ok: true });
  await until(() => ofType(stream.events, 'frame').length === 2, 'second frame');

  fake.dialog(fake.pages.get(tab)!, 'confirm', '¿Seguro?');
  await until(() => ofType(stream.events, 'tabs').some((event) => event.tabs[0]!.dialog?.message === '¿Seguro?'), 'dialog in tab state');
  assert.equal((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'tap', x: 1, y: 1 })).json.error.code, 'remote_conflict');
  assert.deepEqual((await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'dialog', accept: false })).json, {});

  fake.download('informe.pdf', 'contenido');
  await until(() => ofType(stream.events, 'download').length === 1, 'download event');
  assert.deepEqual(ofType(stream.events, 'download')[0], { type: 'download', name: 'informe.pdf', path: path.join(downloads, 'informe.pdf') });
  stream.close();
  await stream.ended;
  await until(() => logs.some((line) => line.startsWith('GET /v1/remote/browsers/:id/frames 200')), 'stream log line');
  assert.ok(logs.some((line) => line.startsWith('POST /v1/remote/browsers/:id/view 200')));
  assert.ok(logs.some((line) => line.startsWith('POST /v1/remote/browsers/:id/ack 200')));
  // Closing the stream disconnects; the browser and its page stay.
  await until(() => fake.pages.get(tab)!.screencast === null, 'capture stopped');
  assert.equal(fake.closed, false);
});

test('a file of the phone fills the page through the files transfer, and a download comes back to the phone by it', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-dedicated-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const context = await lab(t, { browser: process.execPath, downloads: path.join(home, 'Downloads') });
  const puente = await context.puente(undefined, { files: home });
  const created = await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: `browser-${++requests}`, kind: 'browser_dedicated' });
  const id = created.json.id as string;
  const fake = context.host.browsers.get(context.unit(id))!;
  const tab = ((await puente.browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[])[0]!.id;
  const stream = await puente.frames(PHONE, id);
  await until(() => stream.channel() !== '', 'open');

  // The phone's file reaches the Server first, then fills the chooser the page opened.
  const photo = Buffer.alloc(2 * 1024 * 1024 + 3, 9);
  const uploaded = await puente.upload(PHONE, home, 'foto.jpg', photo);
  fake.chooser(fake.pages.get(tab)!, false);
  await until(() => ofType(stream.events, 'tabs').some((event) => event.tabs[0]!.fileChooser !== null), 'chooser listed');
  assert.deepEqual((await puente.browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'files', paths: [uploaded] })).json, {});
  assert.deepEqual(fake.pages.get(tab)!.inputs.at(-1), { method: 'DOM.setFileInputFiles', params: { files: [uploaded], backendNodeId: 42 } });
  assert.deepEqual(await fs.readFile(uploaded), photo);

  // The download stays on the Server, and the path the stream names is one the files transfer brings to the phone.
  fake.download('informe.pdf', 'contenido del informe');
  await until(() => ofType(stream.events, 'download').length === 1, 'download event');
  const [download] = ofType(stream.events, 'download');
  assert.deepEqual(await puente.download(PHONE, download!.path), Buffer.from('contenido del informe'));
  assert.ok(puente.logs.every((line) => !line.includes('informe') && !line.includes('foto') && !line.includes(home)), puente.logs.join('\n'));
});

test('only bounded actions reach the browser: raw CDP, other schemes and malformed views are refused', async (t) => {
  const { open, browser, call, frames } = await browserLab(t);
  const { id, fake, tab } = await open(PHONE);
  const stream = await frames(PHONE, id);
  await until(() => stream.channel() !== '', 'open');
  const before = fake.calls.length;
  for (const [route, body] of [
    [`${id}/tabs/${tab}/action`, { type: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }],
    [`${id}/tabs/${tab}/action`, { type: 'reload', method: 'Network.getCookies' }],
    [`${id}/tabs/${tab}/action`, { type: 'navigate', url: 'file:///etc/passwd' }],
    [`${id}/tabs/${tab}/action`, { type: 'navigate', url: 'javascript:alert(1)' }],
    [`${id}/tabs/${tab}/action`, { type: 'text', text: 'x'.repeat(1001) }],
    [`${id}/tabs/${tab}/action`, { type: 'files', paths: ['relative.txt'] }],
    [`${id}/tabs`, { url: 'chrome://settings' }],
    [`${id}/view`, { channel: stream.channel(), tab, width: 10, height: 800 }],
    [`${id}/view`, { channel: stream.channel(), tab, width: 412, height: 800, scale: 4 }],
    [`${id}/ack`, { channel: stream.channel(), seq: -1 }],
  ] as const) {
    const response = await browser(PHONE, 'POST', route, body);
    assert.deepEqual([response.status, response.json.error.code], [400, 'remote_invalid_request'], JSON.stringify(body));
  }
  assert.equal(fake.calls.length, before, 'nothing reached the browser');
  // Another capability's header, a query string, an unknown subroute.
  assert.equal((await call(PHONE, 'GET', `/v1/remote/browsers/${id}/tabs`, undefined, 'terminal/1')).status, 426);
  assert.equal((await browser(PHONE, 'GET', `${id}/tabs?url=x`)).json.error.code, 'remote_invalid_request');
  assert.equal((await browser(PHONE, 'POST', `${id}/cdp`, {})).status, 404);
});

test('another device cannot see nor control a browser it does not own', async (t) => {
  const { open, browser, frames, create } = await browserLab(t);
  const { id, fake, tab } = await open(PHONE);
  const mine = await frames(PHONE, id);
  await until(() => mine.channel() !== '', 'owner stream');
  const before = fake.calls.length;
  const foreign = await frames(TABLET, id);
  assert.deepEqual([foreign.status, foreign.json?.error.code], [404, 'remote_not_found']);
  for (const [method, route, body] of [
    ['GET', `${id}/tabs`, undefined], ['POST', `${id}/tabs`, {}], ['DELETE', `${id}/tabs/${tab}`, undefined],
    ['POST', `${id}/tabs/${tab}/action`, { type: 'reload' }], ['POST', `${id}/view`, { channel: mine.channel(), tab, width: 412, height: 800 }],
    ['POST', `${id}/ack`, { channel: mine.channel(), seq: 0 }],
  ] as const) {
    const response = await browser(TABLET, method, route, body);
    assert.deepEqual([response.status, response.json.error.code], [404, 'remote_not_found'], `${method} ${route}`);
  }
  assert.equal(fake.calls.length, before);
  assert.ok(!mine.events.some((event) => event.type === 'closed'), 'the owner stream was not replaced');
  // A terminal is not a browser, even for its owner.
  const terminal = await create(PHONE, 'terminal-request-1');
  assert.equal((await browser(PHONE, 'GET', `${terminal.json.id}/tabs`)).json.error.code, 'remote_not_found');
});

test('one dedicated browser per device: the same requestId answers it, another is a limit', async (t) => {
  const { open, call, list } = await browserLab(t);
  const { id } = await open(PHONE);
  const again = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: `browser-${requests}`, kind: 'browser_dedicated' });
  assert.deepEqual([again.status, again.json.id], [200, id]);
  const second = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'browser-second', kind: 'browser_dedicated' });
  assert.deepEqual([second.status, second.json.error.code], [429, 'remote_limit_reached']);
  await open(TABLET);
  const habitual = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'browser-habitual', kind: 'browser_habitual' });
  assert.deepEqual([habitual.status, habitual.json.error.code], [503, 'remote_unavailable']);
  assert.equal((await list(PHONE)).length, 1);
});

test('revoking a device with an active capture ends its stream and its browser, and nothing of another device', async (t) => {
  const { open, browser, frames, revoke, host, unit } = await browserLab(t);
  const phone = await open(PHONE);
  const tablet = await open(TABLET);
  const stream = await frames(PHONE, phone.id);
  await until(() => stream.channel() !== '', 'open');
  await browser(PHONE, 'POST', `${phone.id}/view`, { channel: stream.channel(), tab: phone.tab, width: 412, height: 800 });
  await until(() => ofType(stream.events, 'frame').length === 1, 'capturing');
  await revoke(PHONE);
  await stream.ended;
  await until(() => phone.fake.closed, 'the browser of the revoked device ended');
  assert.ok(host.signals.includes(`${unit(phone.id)} PIPE`));
  await until(() => host.units.get(unit(phone.id)) === undefined, 'its cgroup empty');
  assert.equal((await browser(PHONE, 'GET', `${phone.id}/tabs`)).status, 403);
  assert.equal(tablet.fake.closed, false);
  assert.equal((await browser(TABLET, 'GET', `${tablet.id}/tabs`)).status, 200);
});

test('a page cannot cut the channel every device shares: its tab list stays bounded and other streams go on', async (t) => {
  const { open, browser, frames, create, output, host, unit } = await browserLab(t);
  const phone = await open(PHONE);
  const pages = await frames(PHONE, phone.id);
  const terminal = (await create(TABLET, 'terminal-other-device')).json.id as string;
  const other = await output(TABLET, terminal);
  await until(() => pages.channel() !== '' && other.channel() !== '', 'both streams open');
  // history.pushState with a 1.2 MB URL, a 1.2 MB title, and window.open past the cap.
  phone.fake.update(phone.fake.pages.get(phone.tab)!, `https://example.com/${'u'.repeat(1_200_000)}`, 't'.repeat(1_200_000));
  for (let index = 1; index <= BROWSER_LIMITS.dedicatedTabs; index++) phone.fake.page(`https://example.com/${index}`);
  await until(() => phone.fake.pages.size === BROWSER_LIMITS.dedicatedTabs, 'the tab over the cap closed');
  const listed = await browser(PHONE, 'GET', `${phone.id}/tabs`);
  assert.equal(listed.status, 200, JSON.stringify(listed.json)?.slice(0, 200));
  const tabs = listed.json.tabs as BrowserTab[];
  assert.equal(tabs.length, BROWSER_LIMITS.dedicatedTabs);
  assert.deepEqual([tabs[0]!.url.length, tabs[0]!.title.length], [BROWSER_LIMITS.urlChars, BROWSER_LIMITS.titleChars]);
  assert.equal((await browser(PHONE, 'POST', `${phone.id}/tabs`, {})).json.error.code, 'remote_limit_reached');
  host.ptys.get(unit(terminal))!.output(Buffer.from('still here'));
  await until(() => other.bytes().toString() === 'still here', 'the other device keeps its terminal stream');
  assert.ok(!pages.events.some((event) => event.type === 'closed'), 'the browser stream stays open');
});

test('the browser outlives a Puente restart and is recovered by ID, never replaced', async (t) => {
  const { open, browser, frames, close, startPuente, host } = await browserLab(t);
  const { id, fake } = await open(PHONE);
  const kept = (await browser(PHONE, 'POST', `${id}/tabs`, { url: 'https://example.com/kept' })).json.id as string;
  const stream = await frames(PHONE, id);
  await until(() => stream.channel() !== '', 'open');
  close();
  await stream.ended;
  // A new Puente process with its own connection to the same supervisor.
  const next = await startPuente();
  assert.deepEqual((await next.list(PHONE)).map((each) => [each.id, each.state]), [[id, 'running']]);
  const tabs = (await next.browser(PHONE, 'GET', `${id}/tabs`)).json.tabs as BrowserTab[];
  assert.ok(tabs.some((each) => each.id === kept && each.url === 'https://example.com/kept'));
  const again = await next.frames(PHONE, id);
  await until(() => again.channel() !== '', 'reopened');
  assert.equal(fake.closed, false);
  assert.equal(host.launched.length, 1);
});

test('a supervisor that goes away ends the stream; when it is back the browser is not relaunched', async (t) => {
  const { open, browser, frames, stopSupervisor, startSupervisor, host, list } = await browserLab(t);
  const { id } = await open(PHONE);
  const stream = await frames(PHONE, id);
  await until(() => stream.channel() !== '', 'open');
  await stopSupervisor();
  await stream.ended;
  assert.deepEqual([(await browser(PHONE, 'GET', `${id}/tabs`)).status, (await browser(PHONE, 'GET', `${id}/tabs`)).json.error.code], [503, 'remote_unavailable']);
  await startSupervisor();
  await until(async () => (await list(PHONE).catch(() => []))[0]?.state === 'lost', 'lost');
  assert.equal((await browser(PHONE, 'GET', `${id}/tabs`)).json.error.code, 'remote_ended');
  assert.equal(host.launched.length, 1);
});

test('a method the browser lacks is an explicit remote_unsupported', async (t) => {
  const { open, browser } = await browserLab(t);
  const { id, fake, tab } = await open(PHONE);
  fake.unknown.add('Input.insertText');
  const response = await browser(PHONE, 'POST', `${id}/tabs/${tab}/action`, { type: 'text', text: 'hola' });
  assert.deepEqual([response.status, response.json.error.code], [422, 'remote_unsupported']);
});

test('an internal page is a limitation of the tab, the same as in the habitual browser', async (t) => {
  const { open, browser } = await browserLab(t);
  const { id, fake } = await open(PHONE);
  const page = fake.page('chrome://settings/');
  await until(async () => (await browser(PHONE, 'GET', `${id}/tabs`)).json.tabs.some((tab: BrowserTab) => tab.id === page.id), 'internal tab listed');
  const listed = (await browser(PHONE, 'GET', `${id}/tabs`)).json.tabs.find((tab: BrowserTab) => tab.id === page.id);
  assert.deepEqual([listed.limitation, listed.createdByRelay], ['internal_page', false]);
  const response = await browser(PHONE, 'POST', `${id}/tabs/${page.id}/action`, { type: 'tap', x: 1, y: 1 });
  assert.deepEqual([response.status, response.json.error.code], [409, 'remote_browser_limited']);
});

test('without a browser program the dedicated browser is unavailable and none is created', async (t) => {
  const { call, host } = await browserLab(t, { browser: undefined });
  assert.deepEqual((await call(PHONE, 'GET', '/v1/remote/status', undefined, 'browser/1')).json.browser.dedicated, { state: 'unavailable', reason: 'dependency_missing' });
  const created = await call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'browser-none', kind: 'browser_dedicated' });
  assert.deepEqual([created.status, created.json.error.code], [503, 'remote_unavailable']);
  assert.equal(host.launched.length, 0);
});
