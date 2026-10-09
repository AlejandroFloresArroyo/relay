// Dedicated browsers in the supervisor (#92): the real supervisor and its CDP adapter, with only the
// browser behind its pipe faked (support/fakeBrowser.ts). The real browser is browserSystemd.test.ts.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BROWSER_LIMITS, type BrowserView } from '../../protocol/remoteBrowser.ts';
import { SUPERVISOR_LINE_BYTES, type ChannelEvent, type RegisterInput } from '../../protocol/supervisor.ts';
import { openSupervisor, SupervisorFailure, type Supervisor } from '../src/supervisor.ts';
import { FakeHost } from '../support/fakeHost.ts';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TIMING = { terminateGraceMs: 30, terminateGiveUpMs: 60, terminateRetryMs: 40, pollMs: 5, sweepMs: 10 };
let counter = 0;
const envId = () => `env_${String(++counter).padStart(22, 'B')}`;
const CHANNEL = 'c'.repeat(22);

async function setup(t: TestContext, browser: string | null = process.execPath) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-'));
  const directory = path.join(root, 'state');
  const downloads = path.join(root, 'Downloads');
  await fs.mkdir(directory, { mode: 0o700 });
  const host = new FakeHost();
  const events: ChannelEvent[] = [];
  const opened: Supervisor[] = [];
  const open = async () => {
    const supervisor = await openSupervisor({ directory, host, unitPrefix: 'relay-test', now: () => 5000, timing: TIMING, browser: browser ?? undefined, downloads });
    supervisor.onChannel((event) => events.push(event));
    opened.push(supervisor);
    return supervisor;
  };
  t.after(async () => {
    for (const supervisor of opened) await supervisor.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const supervisor = await open();
  async function create(deviceId = DEVICE) {
    const input: RegisterInput = { id: envId(), deviceId, kind: 'browser_dedicated', requestId: `request-${counter}-b`, createdAt: 1000 };
    const { environment } = await supervisor.register(input);
    const launched = await supervisor.launch(environment.id);
    const fake = host.browsers.get(`relay-test-${environment.id}`)!;
    return { id: launched.id, record: launched, fake, target: { environmentId: launched.id, deviceId } };
  }
  return { root, directory, downloads, host, events, open, supervisor, create };
}

const failure = async (run: () => unknown) => {
  try { await run(); } catch (error) { if (error instanceof SupervisorFailure) return error.code; throw error; }
  assert.fail('expected a SupervisorFailure');
};
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(2);
  }
}
const view = (tab: string, extra: Partial<BrowserView> = {}): BrowserView => ({ tab, width: 412, height: 800, scale: 2, quality: 60, ...extra });
const frames = (events: ChannelEvent[]) => events.filter((event) => event.type === 'frame');

test('a dedicated browser runs on its own profile and HOME, over the CDP pipe, never a port', async (t) => {
  const { directory, create } = await setup(t);
  const { fake, record } = await create();
  assert.equal(record.state, 'running');
  const profile = path.join(directory, 'browsers', DEVICE, 'profile');
  assert.deepEqual(fake.argv.filter((arg) => arg.startsWith('--user-data-dir') || arg.startsWith('--remote-debugging')), [`--user-data-dir=${profile}`, '--remote-debugging-pipe']);
  assert.ok(fake.argv.includes('--password-store=basic'), 'never the keyring of the account');
  const home = path.join(directory, 'browsers', DEVICE, 'home');
  assert.equal(fake.env.HOME, home);
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) assert.ok(fake.env[name]!.startsWith(`${home}/`), name);
  assert.equal((await fs.stat(profile)).mode & 0o777, 0o700);
  // Over the session bus Chrome would move itself to a scope of its own, out of its environment.
  assert.equal(fake.env.DBUS_SESSION_BUS_ADDRESS, 'disabled:');
  // Downloads go to staging under their GUID, never straight to a folder where they could replace a file.
  assert.equal(fake.downloadPath, path.join(directory, 'browsers', DEVICE, 'downloads'));
});

test('one browser per device profile; another device has its own; a new one reuses the device profile', async (t) => {
  const { supervisor, create, host } = await setup(t);
  const first = await create();
  assert.equal(await failure(() => create()), 'limit');
  const other = await create(OTHER);
  assert.notEqual(first.fake.argv.find((arg) => arg.startsWith('--user-data-dir')), other.fake.argv.find((arg) => arg.startsWith('--user-data-dir')));
  await supervisor.terminate(first.id);
  assert.ok(host.signals.includes(`relay-test-${first.id} PIPE`), 'the pipe closes first: the browser saves its profile');
  const again = await create();
  assert.equal(again.fake.argv.find((arg) => arg.startsWith('--user-data-dir')), first.fake.argv.find((arg) => arg.startsWith('--user-data-dir')));
});

test('two simultaneous registrations of a device make one browser; the other is a limit', async (t) => {
  const { supervisor } = await setup(t);
  const register = (requestId: string, deviceId = DEVICE) => supervisor.register({ id: envId(), deviceId, kind: 'browser_dedicated', requestId, createdAt: 1000 })
    .catch((error: SupervisorFailure) => error.code);
  const race = await Promise.all([register('request-race-a'), register('request-race-b')]);
  assert.deepEqual(race.map((answer) => typeof answer === 'string' ? answer : answer.created).sort(), ['limit', true]);
  assert.equal(supervisor.list().length, 1);
  // The same request twice at once is one record, answered to both.
  const [one, two] = await Promise.all([register('request-race-c', OTHER), register('request-race-c', OTHER)]);
  assert.ok(typeof one === 'object' && typeof two === 'object');
  assert.equal(one.environment.id, two.environment.id);
  assert.deepEqual([one.created, two.created].sort(), [false, true]);
  assert.equal(supervisor.list().length, 2);
});

test('without a browser program there is no dedicated browser', async (t) => {
  const { supervisor } = await setup(t, null);
  assert.deepEqual(await supervisor.browserStatus(), { state: 'unavailable', reason: 'dependency_missing' });
  assert.equal(await failure(() => supervisor.register({ id: envId(), deviceId: DEVICE, kind: 'browser_dedicated', requestId: 'request-none-b', createdAt: 1 })), 'unavailable');
  const missing = await setup(t, '/nonexistent/chromium');
  assert.deepEqual(await missing.supervisor.browserStatus(), { state: 'unavailable', reason: 'dependency_missing' });
  assert.deepEqual(await (await setup(t)).supervisor.browserStatus(), { state: 'available' });
});

test('a browser is only reachable by its own device, and only through browser operations', async (t) => {
  const { supervisor, create } = await setup(t);
  const mine = await create();
  const foreign = { environmentId: mine.id, deviceId: OTHER };
  const tab = supervisor.tabs(mine.target)[0]!.id;
  assert.equal(await failure(() => supervisor.tabs(foreign)), 'not_found');
  assert.equal(await failure(() => supervisor.act(foreign, tab, { type: 'reload' })), 'not_found');
  assert.equal(await failure(() => supervisor.openTab(foreign, null)), 'not_found');
  assert.equal(await failure(() => supervisor.attach(foreign, CHANNEL, 0)), 'not_found');
  assert.equal(await failure(() => supervisor.input(mine.target, 1, Buffer.from('x'))), 'not_found');
  assert.equal(await failure(() => supervisor.act(mine.target, 'F'.repeat(32), { type: 'reload' })), 'not_found');
  assert.equal(mine.fake.calls.filter((call) => call.method === 'Page.reload').length, 0);
});

test('tabs open, navigate, move in history and close', async (t) => {
  const { supervisor, create } = await setup(t);
  const { target, fake } = await create();
  const [blank] = supervisor.tabs(target);
  assert.deepEqual(blank, { id: blank!.id, url: 'about:blank', title: '', limitation: null, createdByRelay: false, dialog: null, fileChooser: null });
  const opened = await supervisor.openTab(target, 'https://example.com/');
  assert.deepEqual([opened.url, opened.createdByRelay], ['https://example.com/', true]);
  assert.equal(supervisor.tabs(target).find((tab) => tab.id === blank!.id)!.createdByRelay, false, 'only what Relay opened');
  await supervisor.act(target, opened.id, { type: 'navigate', url: 'https://example.com/two' });
  await until(() => supervisor.tabs(target).find((tab) => tab.id === opened.id)?.url === 'https://example.com/two', 'url change');
  assert.deepEqual(await supervisor.act(target, opened.id, { type: 'back' }), { moved: true });
  assert.deepEqual(await supervisor.act(target, opened.id, { type: 'back' }), { moved: false });
  assert.deepEqual(await supervisor.act(target, opened.id, { type: 'forward' }), { moved: true });
  await supervisor.closeTab(target, opened.id);
  await until(() => supervisor.tabs(target).length === 1, 'tab closed');
  assert.equal(fake.pages.size, 1);
});

test('frames go one at a time: the next waits for the ack, and a view sets the tab size', async (t) => {
  const { supervisor, create, events } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  supervisor.attach(target, CHANNEL, 0);
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ['opened', 'tabs']);
  await supervisor.view(target, CHANNEL, view(tab));
  const page = fake.pages.get(tab)!;
  assert.deepEqual(page.metrics, { width: 412, height: 800, deviceScaleFactor: 2, mobile: false });
  assert.equal(page.screencast!.maxWidth, 824);
  await until(() => frames(events).length === 1, 'first frame');
  assert.deepEqual({ ...frames(events)[0], data: undefined }, { channel: CHANNEL, type: 'frame', seq: 1, tab, data: undefined, viewport: { width: 412, height: 800 } });
  fake.paint(page);
  fake.paint(page);
  await sleep(20);
  assert.equal(frames(events).length, 1, 'nothing piles up without an ack');
  assert.equal(await failure(() => supervisor.ack(target, CHANNEL, 2)), 'invalid');
  supervisor.ack(target, CHANNEL, 1);
  await until(() => frames(events).length === 2, 'second frame');
  assert.equal(frames(events)[1]!.type === 'frame' && frames(events)[1]!.seq, 2);
});

test('a frame over the limit is never sent; the browser is released for the next', async (t) => {
  const { supervisor, create, events } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  fake.frameBytes = 700_001;
  supervisor.attach(target, CHANNEL, 0);
  await supervisor.view(target, CHANNEL, view(tab));
  await until(() => events.some((event) => event.type === 'oversized'), 'oversized');
  assert.equal(frames(events).length, 0);
  await until(() => !fake.pages.get(tab)!.awaitingAck, 'released');
  fake.frameBytes = 700_000;
  fake.paint(fake.pages.get(tab)!);
  await until(() => frames(events).length === 1, 'a frame at the limit');
});

test('a new stream replaces the previous one; detaching stops the capture', async (t) => {
  const { supervisor, create, events } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  supervisor.attach(target, CHANNEL, 0);
  await supervisor.view(target, CHANNEL, view(tab));
  const next = 'd'.repeat(22);
  supervisor.attach(target, next, 0);
  assert.ok(events.some((event) => event.channel === CHANNEL && event.type === 'closed' && event.reason === 'replaced'));
  await until(() => fake.pages.get(tab)!.screencast === null, 'capture stopped');
  assert.equal(await failure(() => supervisor.ack(target, CHANNEL, 0)), 'not_found');
  await supervisor.view(target, next, view(tab));
  supervisor.detachAll();
  await until(() => fake.pages.get(tab)!.screencast === null, 'capture stopped on detach');
});

test('taps, scrolls, text and keys reach the tab at the CSS coordinates given', async (t) => {
  const { supervisor, create } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  await supervisor.act(target, tab, { type: 'tap', x: 10.5, y: 20 });
  await supervisor.act(target, tab, { type: 'scroll', x: 1, y: 2, dx: 0, dy: 300 });
  await supervisor.act(target, tab, { type: 'text', text: 'ñ✓' });
  await supervisor.act(target, tab, { type: 'key', key: 'Enter' });
  const inputs = fake.pages.get(tab)!.inputs;
  assert.deepEqual(inputs.slice(0, 3).map(({ params }) => [params.type, params.x, params.y]), [['mouseMoved', 10.5, 20], ['mousePressed', 10.5, 20], ['mouseReleased', 10.5, 20]]);
  assert.deepEqual(inputs[3]!.params, { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 300 });
  assert.deepEqual(inputs[4], { method: 'Input.insertText', params: { text: 'ñ✓' } });
  assert.deepEqual(inputs.slice(5).map(({ params }) => [params.type, params.windowsVirtualKeyCode]), [['keyDown', 13], ['keyUp', 13]]);
});

test('a JavaScript dialog blocks other actions until Relay answers it', async (t) => {
  const { supervisor, create, events } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  supervisor.attach(target, CHANNEL, 0);
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'dialog', accept: true })), 'conflict');
  fake.dialog(fake.pages.get(tab)!, 'prompt', '¿Nombre?');
  await until(() => supervisor.tabs(target)[0]!.dialog !== null, 'dialog seen');
  assert.deepEqual(supervisor.tabs(target)[0]!.dialog, { type: 'prompt', message: '¿Nombre?', defaultPrompt: '' });
  assert.ok(events.some((event) => event.type === 'tabs' && event.tabs[0]!.dialog !== null));
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'tap', x: 1, y: 1 })), 'conflict');
  await supervisor.act(target, tab, { type: 'dialog', accept: true, text: 'sí' });
  assert.deepEqual(fake.pages.get(tab)!.inputs.at(-1), { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'sí' } });
  assert.equal(supervisor.tabs(target)[0]!.dialog, null);
});

test('a file chooser is filled only with regular files of the Server', async (t) => {
  const { supervisor, create, root } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  const file = path.join(root, 'upload.txt');
  await fs.writeFile(file, 'x');
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'files', paths: [file] })), 'conflict');
  fake.chooser(fake.pages.get(tab)!, false);
  await until(() => supervisor.tabs(target)[0]!.fileChooser !== null, 'chooser seen');
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'files', paths: [path.join(root, 'missing')] })), 'not_found');
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'files', paths: [root] })), 'invalid');
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'files', paths: [file, file] })), 'invalid');
  await supervisor.act(target, tab, { type: 'files', paths: [file] });
  assert.deepEqual(fake.pages.get(tab)!.inputs.at(-1), { method: 'DOM.setFileInputFiles', params: { files: [file], backendNodeId: 42 } });
  assert.equal(supervisor.tabs(target)[0]!.fileChooser, null);
});

test('a finished download stays on the Server without replacing any file', async (t) => {
  const { supervisor, create, events, downloads } = await setup(t);
  const { target, fake } = await create();
  supervisor.attach(target, CHANNEL, 0);
  await fs.mkdir(downloads, { recursive: true });
  await fs.writeFile(path.join(downloads, 'informe.pdf'), 'previous');
  fake.download('informe.pdf', 'first');
  fake.download('../informe.pdf', 'second');
  fake.download('cancelled.bin', '', 'canceled');
  await until(() => events.filter((event) => event.type === 'download').length === 2, 'two downloads');
  const published = events.filter((event) => event.type === 'download').map((event) => event.type === 'download' && [event.name, event.path]);
  assert.deepEqual(published, [['informe (1).pdf', path.join(downloads, 'informe (1).pdf')], ['informe (2).pdf', path.join(downloads, 'informe (2).pdf')]]);
  assert.equal(await fs.readFile(path.join(downloads, 'informe.pdf'), 'utf8'), 'previous');
  assert.equal(await fs.readFile(path.join(downloads, 'informe (1).pdf'), 'utf8'), 'first');
  assert.deepEqual(await fs.readdir(fake.downloadPath!), [], 'nothing left in staging');
});

test('a download over the size limit is cancelled and leaves nothing; a new browser starts with its staging empty', async (t) => {
  const { supervisor, create, events, directory } = await setup(t);
  const staging = path.join(directory, 'browsers', DEVICE, 'downloads');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'guid-left-by-a-crash'), 'partial');
  const { target, fake } = await create();
  assert.deepEqual(await fs.readdir(staging), [], 'what an earlier browser left is gone');
  supervisor.attach(target, CHANNEL, 0);
  const small = fake.download('small.bin', 'x', 'inProgress', 1000);
  const big = fake.download('big.iso', 'x', 'inProgress', BROWSER_LIMITS.downloadBytes + 1);
  await until(() => fake.cancelled.length > 0 && !existsSync(path.join(staging, big)), 'the big one cancelled and removed');
  assert.deepEqual([...new Set(fake.cancelled)], [big]);
  // One that finishes over the limit before the cancel arrives is not published either.
  const late = fake.download('late.iso', 'x', 'completed', BROWSER_LIMITS.downloadBytes + 1);
  await until(() => !existsSync(path.join(staging, late)), 'the late one removed');
  assert.deepEqual(await fs.readdir(staging), [small]);
  assert.equal(events.some((event) => event.type === 'download'), false);
});

test('a method the browser does not know is an explicit unsupported, never a silent success', async (t) => {
  const { supervisor, create } = await setup(t);
  const { target, fake } = await create();
  const tab = supervisor.tabs(target)[0]!.id;
  fake.unknown.add('Page.startScreencast');
  fake.unknown.add('Input.insertText');
  supervisor.attach(target, CHANNEL, 0);
  assert.equal(await failure(() => supervisor.view(target, CHANNEL, view(tab))), 'unsupported');
  assert.equal(await failure(() => supervisor.act(target, tab, { type: 'text', text: 'hola' })), 'unsupported');
  // The browser keeps working for what it knows.
  await supervisor.act(target, tab, { type: 'key', key: 'Tab' });
});

test('internal pages take no input and no view; navigating away from them is allowed', async (t) => {
  const { supervisor, create } = await setup(t);
  const { target, fake } = await create();
  const page = fake.page('chrome://settings/');
  await until(() => supervisor.tabs(target).some((tab) => tab.id === page.id), 'internal tab listed');
  assert.equal(supervisor.tabs(target).find((tab) => tab.id === page.id)!.limitation, 'internal_page');
  supervisor.attach(target, CHANNEL, 0);
  assert.equal(await failure(() => supervisor.view(target, CHANNEL, view(page.id))), 'limited');
  assert.equal(await failure(() => supervisor.act(target, page.id, { type: 'tap', x: 1, y: 1 })), 'limited');
  await supervisor.act(target, page.id, { type: 'navigate', url: 'https://example.com/' });
});

test('what a page says about itself is bounded and tabs are capped: the tab list always fits a channel line', async (t) => {
  const { supervisor, create, events } = await setup(t);
  const { target, fake } = await create();
  supervisor.attach(target, CHANNEL, 0);
  const [blank] = fake.pages.values();
  fake.update(blank!, `https://example.com/${'u'.repeat(1_200_000)}`, 't'.repeat(1_200_000));
  fake.dialog(blank!, 'alert', 'm'.repeat(1_200_000));
  await until(() => supervisor.tabs(target)[0]!.dialog !== null, 'dialog seen');
  const [tab] = supervisor.tabs(target);
  assert.equal(tab!.url, `https://example.com/${'u'.repeat(BROWSER_LIMITS.urlChars - 'https://example.com/'.length)}`);
  assert.equal(tab!.title.length, BROWSER_LIMITS.titleChars);
  assert.equal(tab!.dialog!.message.length, BROWSER_LIMITS.textChars);
  // window.open beyond the cap is closed; opening one more from the phone is a limit.
  for (let index = 1; index <= BROWSER_LIMITS.dedicatedTabs; index++) fake.page(`https://example.com/${index}`);
  await until(() => fake.pages.size === BROWSER_LIMITS.dedicatedTabs, 'the tab over the cap closed');
  assert.equal(supervisor.tabs(target).length, BROWSER_LIMITS.dedicatedTabs);
  assert.equal(await failure(() => supervisor.openTab(target, 'https://example.com/')), 'limit');
  assert.equal(fake.pages.size, BROWSER_LIMITS.dedicatedTabs);
  const longest = Math.max(...events.filter((event) => event.type === 'tabs').map((event) => JSON.stringify(event).length));
  assert.ok(longest < SUPERVISOR_LINE_BYTES / 4, `tabs event of ${longest} characters`);
});

test('terminating closes the pipe and the stream, keeps the profile and relaunches nothing', async (t) => {
  const { supervisor, create, events, host, directory } = await setup(t);
  const { id, target } = await create();
  supervisor.attach(target, CHANNEL, 0);
  const ended = await supervisor.terminate(id);
  assert.equal(ended.state, 'exited');
  assert.equal(ended.exitCode, 0);
  assert.ok(events.some((event) => event.type === 'closed' && event.reason === 'exited'));
  assert.equal(await failure(() => supervisor.tabs(target)), 'ended');
  await fs.access(path.join(directory, 'browsers', DEVICE, 'profile'));
  assert.equal(host.launched.length, 1);
});

test('terminating gives the browser its grace on the closed pipe before any signal, then kills what is left', async (t) => {
  const { supervisor, create, host } = await setup(t);
  // Its network process writes the cookies while the browser shuts down: a SIGTERM to every process
  // at the same time as the pipe closes would end that one first, and the device's logins with it.
  const first = await create();
  assert.equal((await supervisor.terminate(first.id)).state, 'exited');
  assert.deepEqual(host.signals, [`relay-test-${first.id} PIPE`]);
  // A browser that does not end on its pipe is killed after the grace.
  host.main = { ignoresHangUp: true };
  const stuck = await create(OTHER);
  assert.equal((await supervisor.terminate(stuck.id)).state, 'exited');
  assert.deepEqual(host.signals.slice(1), [`relay-test-${stuck.id} PIPE`, `relay-test-${stuck.id} KILL`]);
});

test('a browser that dies on its own ends its environment and is never replaced', async (t) => {
  const { supervisor, create, events, host, open } = await setup(t);
  const { id, target, fake } = await create();
  supervisor.attach(target, CHANNEL, 0);
  fake.exit(null);
  await until(() => supervisor.list().find((record) => record.id === id)?.state === 'exited', 'exited');
  assert.ok(events.some((event) => event.type === 'closed' && event.reason === 'exited'));
  assert.equal(await failure(() => supervisor.act(target, 'X', { type: 'reload' })), 'ended');
  // A supervisor restart does not bring it back either. The first one stops first: its record is on disk.
  await supervisor.close();
  const restarted = await open();
  assert.equal(restarted.list().find((record) => record.id === id)?.state, 'exited');
  assert.equal(host.launched.length, 1);
});
