// The habitual browser through the Puente's routes (#93), the same `browser` contract as the dedicated
// one (#92): the real Puente and its extension socket, with the extension's side as the transport
// double. The real extension runs in habitualBrowserReal.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserStreamEvent } from '../../protocol/remoteBrowser.ts';
import type { ExtensionLink } from '../src/remote/habitualBrowser.ts';
import { connectExtension, listedTab as listed, sharedTab, type FakeExtension } from '../support/fake_extension.ts';
import { habitualPuente, NOW, PHONE, TABLET } from '../support/habitual_lab.ts';

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(5);
  }
}

async function connected({ link }: { link: ExtensionLink }): Promise<FakeExtension> {
  const extension = await connectExtension(link.socketPath);
  await until(async () => (await link.availability()).state === 'available', 'extension connected');
  return extension;
}

const ofType = <T extends BrowserStreamEvent['type']>(events: unknown[], type: T) => (events as BrowserStreamEvent[]).filter((event) => event.type === type) as Extract<BrowserStreamEvent, { type: T }>[];
const frameRequests = (extension: FakeExtension) => extension.requests.filter(({ op, action }) => op === 'act' && typeof action === 'object' && action !== null && 'type' in action && action.type === 'frame');

/** The Puente only ever asks these; none of them closes a tab or reaches an unshared target. */
const OPS = ['tabs', 'open', 'act', 'release', 'downloads'];

test('a device connects to the habitual browser as shared work, and sees and controls only the shared tabs', async (t) => {
  const puente = await habitualPuente(t);
  assert.equal((await puente.connect(PHONE)).json.error.code, 'remote_unavailable', 'without the extension there is nothing to connect to');
  const status = await puente.call(PHONE, 'GET', '/v1/remote/status');
  assert.deepEqual(status.json.browser, { dedicated: { state: 'unavailable', reason: 'not_configured' }, habitual: { state: 'unavailable', reason: 'not_configured' } });

  const extension = await connected(puente);
  extension.tabs = [sharedTab(4), sharedTab(9, { createdByRelay: true })];
  const created = await puente.connect(PHONE);
  assert.deepEqual(created.json, { id: created.json.id, kind: 'browser_habitual', ownership: 'shared', createdAt: NOW, state: 'running', exitCode: null, endedAt: null });
  const id = created.json.id as string;
  assert.match(id, /^env_[A-Za-z0-9_-]{22}$/);
  assert.equal((await puente.connect(PHONE)).json.id, id, 'the same requestId answers the same connection');
  assert.equal((await puente.connect(PHONE, 'habitual-other')).json.error.code, 'remote_conflict', 'one live connection per device');
  assert.deepEqual((await puente.list(PHONE)).map((environment) => environment.id), [id]);
  assert.deepEqual(await puente.list(TABLET), []);

  assert.deepEqual((await puente.tabs(PHONE, id)).json, { tabs: [listed(4), listed(9, { createdByRelay: true })] });
  assert.deepEqual((await puente.act(PHONE, id, '4', { type: 'back' })).json, { moved: true });
  assert.deepEqual(extension.requests.at(-1), { id: extension.requests.at(-1)!.id, op: 'act', tabId: 4, action: { type: 'back' } });
  assert.equal((await puente.act(PHONE, id, '5', { type: 'reload' })).json.error.code, 'remote_not_found', 'a tab nobody shared');

  // Another device's connection, a made-up ID and the wrong capability get nothing.
  for (const response of [await puente.tabs(TABLET, id), await puente.act(TABLET, id, '4', { type: 'reload' }), await puente.tabs(PHONE, 'env_doesNotExistAAAAAAAAAA'), await puente.tabs(PHONE, '4')]) {
    assert.equal(response.json.error.code, 'remote_not_found');
  }
  assert.equal((await puente.call(PHONE, 'GET', `/v1/remote/browsers/${id}/tabs`, undefined, 'terminal/1')).json.error.code, 'remote_upgrade_required');
  assert.ok(extension.ops().every((op) => OPS.includes(op)), extension.ops().join());
  assert.ok(puente.logs.some((line) => line.startsWith('GET /v1/remote/browsers/:id/tabs 200')), puente.logs.join('\n'));
  assert.ok(puente.logs.some((line) => line.startsWith('POST /v1/remote/browsers/:id/tabs/:tab/action 200')));
  assert.ok(puente.logs.every((line) => !line.includes(id) && !line.includes('example.test')), puente.logs.join('\n'));
});

test('only bounded actions reach the extension: raw CDP, other schemes, extra fields and what the mode lacks stop at the Puente', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const id = (await puente.connect(PHONE)).json.id as string;
  const before = extension.requests.length;
  for (const action of [
    { type: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } },
    { type: 'navigate', url: 'chrome://settings' }, { type: 'navigate', url: 'file:///etc/passwd' },
    { type: 'reload', method: 'Browser.close' }, { type: 'text', text: 'x'.repeat(1001) }, { type: 'key', key: 'F12' },
    // The extension's private frame request is not an action of the contract.
    { type: 'frame', maxWidth: 640 },
  ]) {
    assert.equal((await puente.act(PHONE, id, '4', action)).json.error.code, 'remote_invalid_request', JSON.stringify(action));
  }
  // A tab ID that is not an extension tab number in decimal is a tab that does not exist.
  for (const tab of ['-1', '04', '4.5', '9007199254740993', 'abc']) {
    assert.equal((await puente.act(PHONE, id, tab, { type: 'reload' })).json.error.code, 'remote_not_found', tab);
  }
  for (const url of ['chrome://version', 'javascript:alert(1)', 'view-source:https://example.test', 42]) {
    assert.equal((await puente.open(PHONE, id, url)).json.error.code, 'remote_invalid_request', String(url));
  }
  // What the habitual browser does not offer is explicit: no closing a tab, no blank tab.
  assert.equal((await puente.call(PHONE, 'DELETE', `/v1/remote/browsers/${id}/tabs/4`)).json.error.code, 'remote_unsupported');
  assert.equal((await puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/tabs`, {})).json.error.code, 'remote_unsupported');
  // A file the browser would read is an existing regular file the account can read, or nothing reaches it.
  for (const [paths, expected] of [[['etc/hostname'], 'remote_invalid_request'], [['/nonexistent/relay-file'], 'remote_not_found'], [['/etc'], 'remote_invalid_request'],
    [['/etc/hostname', '/nonexistent/relay-file'], 'remote_not_found']] as const) {
    assert.equal((await puente.act(PHONE, id, '4', { type: 'files', paths })).json.error.code, expected, paths.join());
  }
  assert.equal(extension.requests.length, before, 'nothing reached the extension');

  const opened = await puente.open(PHONE, id, 'https://example.test/new');
  assert.deepEqual(opened.json, listed(100 + 1, { url: 'https://example.test/new', createdByRelay: true }));
  assert.deepEqual(extension.requests.at(-1), { id: extension.requests.at(-1)!.id, op: 'open', url: 'https://example.test/new' });
});

test('a limitation of the tab is a visible state, never a silent failure', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const id = (await puente.connect(PHONE)).json.id as string;
  extension.reply = (request) => {
    if (request.op !== 'act') return extension.model(request);
    extension.tabs = [sharedTab(4, { url: 'chrome://version/', limitation: 'internal_page' })];
    return { ok: false, code: 'limited' };
  };
  const refused = await puente.act(PHONE, id, '4', { type: 'reload' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json.error, { code: 'remote_browser_limited', message: 'El navegador no deja controlar esta pestaña desde Relay.' });
  assert.equal((await puente.tabs(PHONE, id)).json.tabs[0].limitation, 'internal_page');

  extension.tabs = [sharedTab(4, { dialog: { type: 'prompt', message: '¿Nombre?', defaultPrompt: 'Ana' } })];
  assert.deepEqual((await puente.tabs(PHONE, id)).json.tabs[0].dialog, { type: 'prompt', message: '¿Nombre?', defaultPrompt: 'Ana' });

  // The extension gone: the tool says so at once, and the connection waits for it to come back.
  extension.socket.destroy();
  await until(async () => (await puente.link.availability()).state !== 'available', 'extension gone');
  assert.equal((await puente.tabs(PHONE, id)).json.error.code, 'remote_unavailable');
  assert.deepEqual((await puente.call(PHONE, 'GET', '/v1/remote/status')).json.browser.habitual, { state: 'unavailable', reason: 'not_configured' });
  const back = await connected(puente);
  back.tabs = [sharedTab(4)];
  assert.deepEqual((await puente.tabs(PHONE, id)).json.tabs, [listed(4)]);
});

test('frames come one at a time through the same stream as the dedicated browser, with the tab list when it changes', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4), sharedTab(9, { limitation: 'debugger_busy' })];
  const id = (await puente.connect(PHONE)).json.id as string;
  const stream = await puente.frames(PHONE, id);
  assert.equal(stream.status, 200);
  await until(() => ofType(stream.events, 'tabs').length === 1, 'open and tabs');
  assert.equal(stream.events[0]!.type, 'open');
  assert.deepEqual(ofType(stream.events, 'tabs')[0]!.tabs, [listed(4), listed(9, { limitation: 'debugger_busy' })]);
  const channel = stream.channel();
  const view = (body: Record<string, unknown>) => puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/view`, { channel, width: 412, height: 800, ...body });

  // The person's window keeps its size: width × scale only bounds the frame.
  assert.deepEqual((await view({ tab: '4', scale: 2 })).json, { ok: true });
  await until(() => ofType(stream.events, 'frame').length === 1, 'first frame');
  assert.deepEqual(ofType(stream.events, 'frame')[0], { type: 'frame', seq: 1, tab: '4', data: Buffer.from('jpeg').toString('base64'), viewport: { width: 320, height: 200 } });
  assert.deepEqual(frameRequests(extension).map((request) => request.action), [{ type: 'frame', maxWidth: 824, quality: 60 }]);
  await sleep(30);
  assert.equal(frameRequests(extension).length, 1, 'the next frame waits for the ack');
  await puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/ack`, { channel, seq: 7 });
  await sleep(30);
  assert.equal(frameRequests(extension).length, 1, 'an ack of another frame asks for nothing');

  extension.tabs = [sharedTab(4, { dialog: { type: 'confirm', message: '¿Seguro?', defaultPrompt: '' } })];
  assert.deepEqual((await puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/ack`, { channel, seq: 1 })).json, { ok: true });
  await until(() => ofType(stream.events, 'frame').length === 2, 'second frame');
  await until(() => ofType(stream.events, 'tabs').length === 2, 'the changed list');
  assert.equal(ofType(stream.events, 'tabs')[1]!.tabs[0]!.dialog?.message, '¿Seguro?');

  // A tab that is not listed, or that Relay cannot control, is refused like in the dedicated browser.
  extension.tabs = [sharedTab(4), sharedTab(9, { limitation: 'debugger_busy' })];
  assert.equal((await view({ tab: '9' })).json.error.code, 'remote_browser_limited');
  assert.equal((await view({ tab: '7' })).json.error.code, 'remote_not_found');
  assert.equal((await view({ tab: '4', scale: 4 })).json.error.code, 'remote_invalid_request');

  // A frame over the limit is dropped, and nothing more is asked until another view.
  extension.reply = (request) => request.op === 'act' ? { ok: false, code: 'frame_too_large' } : extension.model(request);
  const asked = frameRequests(extension).length;
  await view({ tab: '4' });
  await until(() => ofType(stream.events, 'oversized').length === 1, 'oversized');
  assert.deepEqual(ofType(stream.events, 'oversized')[0], { type: 'oversized', tab: '4' });
  await sleep(50);
  assert.equal(frameRequests(extension).length, asked + 1);

  // Another stream replaces this one; ending the connection ends that one.
  const second = await puente.frames(PHONE, id);
  await stream.ended;
  assert.deepEqual(stream.events.at(-1), { type: 'closed', reason: 'replaced' });
  await puente.terminate(PHONE, id);
  await second.ended;
  assert.deepEqual(second.events.at(-1), { type: 'closed', reason: 'exited' });
  assert.equal((await puente.frames(PHONE, id)).json?.error.code, 'remote_ended');
  assert.ok(puente.logs.some((line) => line.startsWith('GET /v1/remote/browsers/:id/frames 200')), puente.logs.join('\n'));
  assert.ok(puente.logs.every((line) => !line.includes(id) && !line.includes('example.test')), puente.logs.join('\n'));
});

test('uploads and downloads go through the files transfer: a file of the phone fills the chooser, and a download comes back to it', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-habitual-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const puente = await habitualPuente(t, { files: home });
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const phone = (await puente.connect(PHONE)).json.id as string;
  const tablet = (await puente.connect(TABLET)).json.id as string;

  // The phone's file reaches the Server first, then fills the chooser Relay's tap opened.
  const photo = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
  const uploaded = await puente.upload(PHONE, home, 'foto ñ.jpg', photo);
  assert.equal((await puente.act(PHONE, phone, '4', { type: 'files', paths: [uploaded] })).json.error.code, 'remote_conflict', 'no chooser to fill yet');
  extension.tabs[0]!.fileChooser = { multiple: false };
  assert.deepEqual((await puente.tabs(PHONE, phone)).json.tabs[0].fileChooser, { multiple: false });
  assert.deepEqual((await puente.act(PHONE, phone, '4', { type: 'files', paths: [uploaded] })).json, {});
  assert.deepEqual(extension.requests.at(-1), { id: extension.requests.at(-1)!.id, op: 'act', tabId: 4, action: { type: 'files', paths: [uploaded] } });
  assert.equal((await puente.tabs(PHONE, phone)).json.tabs[0].fileChooser, null);
  await fs.chmod(uploaded, 0o000);
  if (process.getuid?.() !== 0) assert.equal((await puente.act(PHONE, phone, '4', { type: 'files', paths: [uploaded] })).json.error.code, 'remote_permission_denied');

  // A download of a shared tab reaches every open stream once, and the files transfer brings it to the phone.
  const phoneStream = await puente.frames(PHONE, phone);
  const tabletStream = await puente.frames(TABLET, tablet);
  await until(() => phoneStream.channel() !== '' && tabletStream.channel() !== '', 'streams open');
  await puente.call(PHONE, 'POST', `/v1/remote/browsers/${phone}/view`, { channel: phoneStream.channel(), tab: '4', width: 412, height: 800 });
  const invoice = Buffer.from('factura sintética\n');
  await fs.mkdir(path.join(home, 'Descargas'));
  await fs.writeFile(path.join(home, 'Descargas', 'factura (1).pdf'), invoice);
  extension.downloads.push({ name: 'factura (1).pdf', path: path.join(home, 'Descargas', 'factura (1).pdf') });
  // The app acks each frame: the stream keeps asking, and with it the downloads.
  await until(async () => {
    const last = ofType(phoneStream.events, 'frame').at(-1);
    if (last) await puente.call(PHONE, 'POST', `/v1/remote/browsers/${phone}/ack`, { channel: phoneStream.channel(), seq: last.seq });
    return ofType(phoneStream.events, 'download').length > 0 && ofType(tabletStream.events, 'download').length > 0;
  }, 'download announced');
  for (const stream of [phoneStream, tabletStream]) {
    assert.deepEqual(ofType(stream.events, 'download'), [{ type: 'download', name: 'factura (1).pdf', path: path.join(home, 'Descargas', 'factura (1).pdf') }]);
  }
  assert.deepEqual(await puente.download(PHONE, ofType(phoneStream.events, 'download')[0]!.path), invoice);
  assert.ok(extension.ops().every((op) => OPS.includes(op)));
  assert.ok(puente.logs.every((line) => !line.includes('factura') && !line.includes('foto') && !line.includes(home)), puente.logs.join('\n'));
});

test('a frame that fails is asked again later, so a cleared limitation shows without a new view', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const id = (await puente.connect(PHONE)).json.id as string;
  const stream = await puente.frames(PHONE, id);
  await until(() => stream.channel() !== '', 'open');
  let refusals = 1;
  extension.reply = (request) => {
    if (request.op === 'act' && refusals > 0) {
      refusals--;
      extension.tabs = [sharedTab(4, { limitation: 'debugger_busy' })];
      return { ok: false, code: 'limited' };
    }
    if (request.op === 'act') extension.tabs = [sharedTab(4)];
    return extension.model(request);
  };
  await puente.call(PHONE, 'POST', `/v1/remote/browsers/${id}/view`, { channel: stream.channel(), tab: '4', width: 412, height: 800 });
  await until(() => ofType(stream.events, 'tabs').some((event) => event.tabs[0]!.limitation === 'debugger_busy'), 'the limitation shown');
  await until(() => ofType(stream.events, 'frame').length === 1, 'the frame once it cleared', 4000);
  // The list follows the frame that showed the tab again.
  await until(() => ofType(stream.events, 'tabs').at(-1)!.tabs[0]!.limitation === null, 'the cleared limitation shown');
  assert.equal(frameRequests(extension).length, 2);
});

test('ending the connection disconnects: the extension lets go of every tab and none is closed', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const id = (await puente.connect(PHONE)).json.id as string;
  await puente.open(PHONE, id, 'https://example.test/relay');
  assert.equal((await puente.call(PHONE, 'POST', `/v1/remote/environments/${id}/terminate`, {}, 'environments/1')).json.error.code, 'remote_confirmation_required');
  assert.ok(!extension.ops().includes('release'));

  const ended = await puente.terminate(PHONE, id);
  assert.deepEqual(ended.json, { id, kind: 'browser_habitual', ownership: 'shared', createdAt: NOW, state: 'exited', exitCode: null, endedAt: NOW });
  assert.deepEqual(extension.ops(), ['open', 'release']);
  assert.deepEqual((await puente.terminate(PHONE, id)).json, ended.json, 'idempotent');
  assert.equal(extension.ops().filter((op) => op === 'release').length, 1);
  assert.equal((await puente.tabs(PHONE, id)).json.error.code, 'remote_ended');
  assert.equal((await puente.act(PHONE, id, '4', { type: 'reload' })).json.error.code, 'remote_ended');
  assert.equal((await puente.terminate(TABLET, id)).json.error.code, 'remote_not_found');

  assert.deepEqual((await puente.call(PHONE, 'DELETE', `/v1/remote/environments/${id}`, undefined, 'environments/1')).json, { ok: true });
  assert.deepEqual(await puente.list(PHONE), []);
  const again = await puente.connect(PHONE, 'habitual-again');
  assert.equal(again.json.state, 'running', 'connecting again after ending is a new connection');
  assert.deepEqual(await puente.changes(), [
    `remote.browser.connected device ${id}`, `remote.browser.disconnected device ${id}`, `remote.environment.discarded device ${id}`,
    `remote.browser.connected device ${again.json.id}`,
  ]);
  assert.ok(extension.ops().every((op) => OPS.includes(op)));
});

test('revoking a device cuts its connection at once: its stream ends, the extension lets go, the tabs stay, its requests fail', async (t) => {
  const puente = await habitualPuente(t);
  const extension = await connected(puente);
  extension.tabs = [sharedTab(4)];
  const phone = (await puente.connect(PHONE)).json.id as string;
  const tablet = (await puente.connect(TABLET)).json.id as string;
  const stream = await puente.frames(PHONE, phone);
  await until(() => stream.channel() !== '', 'stream open');
  // A request of the phone still waiting on the extension when the revocation lands.
  extension.reply = (request) => request.op === 'act' ? null : extension.model(request);
  const inFlight = puente.act(PHONE, phone, '4', { type: 'reload' });
  await until(() => extension.requests.some((request) => request.op === 'act'), 'action reached the extension');

  await puente.revoke(PHONE);
  const answered = await inFlight;
  assert.deepEqual([answered.status, answered.json.error.code], [403, 'device_revoked']);
  await stream.ended;
  await until(() => extension.ops().includes('release'), 'released');
  assert.equal((await puente.tabs(PHONE, phone)).json.error.code, 'device_revoked');
  assert.equal((await puente.connect(PHONE, 'habitual-after')).json.error.code, 'device_revoked');
  assert.ok(extension.ops().every((op) => OPS.includes(op)), 'nothing but a release');
  await until(async () => (await puente.changes()).length === 3, 'disconnection recorded');
  assert.deepEqual(await puente.changes(), [`remote.browser.connected device ${phone}`, `remote.browser.connected device ${tablet}`, `remote.browser.disconnected server ${phone}`]);

  // The tablet keeps its own connection; the extension attaches again on its next action.
  extension.reply = (request) => extension.model(request);
  assert.equal((await puente.act(TABLET, tablet, '4', { type: 'reload' })).status, 200);
});

test('a connection the device was creating when it was revoked never stays', async (t) => {
  const puente = await habitualPuente(t);
  await connected(puente);
  const availability = puente.link.availability.bind(puente.link);
  // The revocation lands while the Puente checks the extension, before the connection is recorded.
  puente.link.availability = async () => { const result = await availability(); await puente.revoke(PHONE); return result; };
  assert.equal((await puente.connect(PHONE)).json.error.code, 'device_revoked');
  puente.link.availability = availability;
  // Changes are appended in order: once the tablet's is written, a connection of the phone would be too.
  const tablet = (await puente.connect(TABLET)).json.id as string;
  assert.deepEqual(await puente.changes(), [`remote.browser.connected device ${tablet}`]);
});
