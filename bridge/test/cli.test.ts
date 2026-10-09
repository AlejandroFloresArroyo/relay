import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli.ts';
import { realExec } from '../src/exec.ts';
import { encodeQr } from '../src/qr.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const payload = { type: 'relay-pair' as const, version: 1 as const, url: 'http://arch.example.ts.net:8650', code: '0123456789' };

function fixture(tty = true, renderer: (text: string, columns: number) => string | null = () => 'fake-qr\n') {
  const output: string[] = []; const requests: unknown[] = []; let serves = 0;
  const deps = { stdout: { isTTY: tty, columns: 80, write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) },
    renderQr: renderer, serve: async () => { serves++; }, request: async (request: import('../src/control.ts').ControlRequest): Promise<import('../src/control.ts').ControlResponse> => {
      requests.push(request);
      if (request.command === 'pair') return { ok: true, result: { payload, expiresAt: 1_791_000_000_000 } };
      if (request.command === 'devices') return { ok: true, result: { devices: [{ id: ID, name: 'phone', pairedAt: 1_791_000_000_000, revokedAt: null }] } };
      return { ok: true, result: { device: { id: ID, name: 'phone', pairedAt: 1_791_000_000_000, revokedAt: 1_791_000_000_001 } } };
    } };
  return { deps, output, requests, serves: () => serves };
}

test('CLI default and serve dispatch only serve; help and administrative commands do not initialize it', async () => {
  const f = fixture();
  assert.equal(await runCli([], f.deps), 0); assert.equal(await runCli(['serve'], f.deps), 0);
  assert.equal(f.serves(), 2);
  for (const args of [['--help'], ['pair'], ['devices'], ['revoke', ID]]) assert.equal(await runCli(args, f.deps), 0);
  assert.equal(f.serves(), 2); assert.equal(f.requests.length, 3);
  assert.ok(f.output.join('').includes(ID)); assert.ok(!f.output.join('').includes('keyHash'));
});

test('CLI invalid argc, flags and UUID prefixes fail without administrative effects', async () => {
  const f = fixture();
  for (const args of [['unknown'], ['serve', 'extra'], ['pair', 'extra'], ['devices', 'extra'], ['revoke'], ['revoke', 'phone'], ['revoke', ID.slice(0, 8)], ['--help', 'extra'], ['revoke', ID, 'extra']]) assert.equal(await runCli(args, f.deps), 1);
  assert.equal(f.serves(), 0); assert.equal(f.requests.length, 0);
});

test('CLI prints exact QR JSON, grouped code, address and expiry only to an interactive terminal', async () => {
  const f = fixture(true, (text, columns) => { assert.equal(text, '{"type":"relay-pair","version":1,"url":"http://arch.example.ts.net:8650","code":"0123456789"}'); assert.equal(columns, 80); return 'fake-qr\n'; });
  assert.equal(await runCli(['pair'], f.deps), 0);
  assert.ok(f.output.join('').includes('01234-56789')); assert.ok(f.output.join('').includes(payload.url)); assert.ok(f.output.join('').includes('2026-10-03T04:00:00.000Z')); assert.ok(f.output.join('').includes('fake-qr'));
  const quiet = fixture(false, () => { throw new Error('Must not render'); });
  assert.equal(await runCli(['pair'], quiet.deps), 1); assert.equal(quiet.requests.length, 0);
  assert.ok(!quiet.output.join('').includes(payload.code)); assert.ok(!quiet.output.join('').includes(payload.url));
  const narrow = fixture(true, () => null); assert.equal(await runCli(['pair'], narrow.deps), 0); assert.ok(narrow.output.join('').includes('terminal'));
});

test('CLI socket failure and remote errors use static Spanish text without exception content', async () => {
  const f = fixture(); f.deps.request = async () => { throw new Error('private-exception-fixture'); };
  assert.equal(await runCli(['devices'], f.deps), 1); assert.ok(!f.output.join('').includes('private-exception-fixture'));
});

test('executable Node wrapper help requires no configuration, Hermes or service', async () => {
  // Backstop only: help must exit on its own (a started service never would); node startup has
  // taken over 3 s on a loaded machine. Stays under the 20 s test timeout so a hang is reported.
  const result = await realExec(new URL('../relayd', import.meta.url).pathname, ['--help'], { timeoutMs: 15_000 });
  assert.equal(result.code, 0); assert.ok(result.stdout.includes('relayd pair')); assert.equal(result.stderr, '');
});

test('CLI setup accepts only explicit unique flags and refuses noninteractive output before effects, except a dry run', async () => {
  const f = fixture(); const options: unknown[] = [];
  const deps = { ...f.deps, setup: async (value: unknown) => { options.push(value); return 0; } };
  const none = { replaceService: false, restart: false, supervisor: false, restartSupervisor: false, remoteFiles: false, remoteWeb: false, browserHabitual: false, dryRun: false };
  for (const flags of [[], ['--replace-service'], ['--restart'], ['--restart', '--replace-service'], ['--supervisor', '--files', '--web', '--browser-habitual', '--restart-supervisor']]) assert.equal(await runCli(['setup', ...flags], deps), 0);
  assert.deepEqual(options, [none, { ...none, replaceService: true }, { ...none, restart: true }, { ...none, replaceService: true, restart: true },
    { ...none, supervisor: true, remoteFiles: true, remoteWeb: true, browserHabitual: true, restartSupervisor: true }]);
  for (const flags of [['--now'], ['--restart', '--restart'], ['--replace-service', '--replace-service'], ['extra'], ['--supervisor=1']]) assert.equal(await runCli(['setup', ...flags], deps), 1);
  deps.stdout.isTTY = false; assert.equal(await runCli(['setup', '--restart'], deps), 1);
  assert.equal(options.length, 5);
  assert.equal(await runCli(['setup', '--dry-run', '--supervisor'], deps), 0);
  assert.deepEqual(options.at(-1), { ...none, dryRun: true, supervisor: true });
  assert.equal(f.serves(), 0); assert.equal(f.requests.length, 0);
});

test('relayd doctor and relayd web print their read-only reports without a running Puente or a terminal', async () => {
  const f = fixture(false);
  const deps = { ...f.deps, webReport: async () => 'No hay aplicaciones registradas.\n' };
  assert.equal(await runCli(['doctor'], { ...deps, doctor: async () => ({ text: 'ok     Sistema\n', ok: true }) }), 0);
  assert.equal(await runCli(['doctor'], { ...deps, doctor: async () => ({ text: 'falta  PTY\n', ok: false }) }), 1);
  assert.equal(await runCli(['web'], deps), 0);
  const text = f.output.join('');
  for (const expected of ['ok     Sistema', 'falta  PTY', 'No hay aplicaciones registradas.', 'solo lectura']) assert.ok(text.includes(expected), expected);
  for (const args of [['doctor', 'extra'], ['web', 'extra']]) assert.equal(await runCli(args, { ...deps, doctor: async () => ({ text: '', ok: true }) }), 1);
  assert.equal(await runCli(['web'], { ...deps, webReport: async () => { throw new Error('EACCES /home/user/synthetic-web-secret'); } }), 1);
  assert.ok(!f.output.join('').includes('synthetic-web-secret'));
  assert.equal(f.requests.length, 0); assert.equal(f.serves(), 0);
});

test('interactive pair real QR reconstructs exactly the ordered A3 payload; nonTTY prints no secret or QR', async () => {
  const f = fixture(); const { renderQr: _fake, ...deps } = f.deps;
  assert.equal(await runCli(['pair'], deps), 0);
  const output = f.output.join('');
  assert.ok(output.includes(payload.url)); assert.ok(output.includes('01234-56789')); assert.ok(output.includes('2026-10-03T04:00:00.000Z'));
  const rows: boolean[][] = [];
  for (const line of output.split('\n').filter(line => line.startsWith('\x1b['))) {
    assert.ok(line.startsWith('\x1b[30;47m') && line.endsWith('\x1b[0m'));
    const cells = [...line.slice(8, -4)]; assert.ok(cells.every(cell => ' ▀▄█'.includes(cell)));
    rows.push(cells.map(cell => cell === '▀' || cell === '█'), cells.map(cell => cell === '▄' || cell === '█'));
  }
  const json = '{"type":"relay-pair","version":1,"url":"http://arch.example.ts.net:8650","code":"0123456789"}';
  assert.deepEqual(rows.slice(4, -5).map(row => row.slice(4, -4)), encodeQr(json));
  const quiet = fixture(false); const { renderQr: _quietFake, ...quietDeps } = quiet.deps;
  assert.equal(await runCli(['pair'], quietDeps), 1); assert.equal(quiet.requests.length, 0);
  for (const secret of [payload.code, '01234-56789', 'rly1_', '\x1b[', '█', '▀', '▄']) assert.ok(!quiet.output.join('').includes(secret));
});

test('relayd browser registers the native host for one known browser and says how to load the extension', async () => {
  const f = fixture();
  const registered: string[] = [];
  const deps = { ...f.deps, registerBrowser: async (browser: string) => {
    registered.push(browser);
    return { manifest: `/home/user/.config/${browser}/NativeMessagingHosts/com.relay.browser.json`, extensionDirectory: '/srv/relay/bridge/extension/', extensionId: 'ckfhmaagfbdbaandpfgjeeladhdofjph' };
  } };
  for (const args of [['browser'], ['browser', 'firefox'], ['browser', 'chromium', 'extra'], ['browser', '../chromium']]) assert.equal(await runCli(args, deps), 1, args.join(' '));
  assert.deepEqual(registered, []);
  assert.equal(await runCli(['browser', 'chromium'], deps), 0);
  assert.deepEqual(registered, ['chromium']);
  const text = f.output.join('');
  for (const expected of ['/home/user/.config/chromium/NativeMessagingHosts/com.relay.browser.json', '/srv/relay/bridge/extension/', 'ckfhmaagfbdbaandpfgjeeladhdofjph', 'relayd setup --supervisor --browser-habitual']) assert.ok(text.includes(expected), expected);
  assert.equal(f.requests.length, 0, 'registering needs no running Puente');
  assert.equal(await runCli(['browser', 'google-chrome'], { ...deps, registerBrowser: async () => { throw new Error('EACCES /home/user/secret'); } }), 1);
  assert.ok(!f.output.join('').includes('secret'));
});
