import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { realExec } from '../src/exec.ts';
import type { Exec } from '../src/exec.ts';
import { loadConfig } from '../src/config.ts';
import { runSetup, serviceUnit, supervisorUnit, unitEnvironment as systemdEnvironment } from '../src/setup.ts';
import { runCli } from '../src/cli.ts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'bridge'); const home = path.join(root, 'home'); const runtimeDirectory = path.join(root, 'runtime');
  await fs.mkdir(path.join(directory, 'src'), { recursive: true }); await fs.writeFile(path.join(directory, 'src/main.ts'), 'fixture');
  await fs.mkdir(home); await fs.mkdir(runtimeDirectory, { mode: 0o700 });
  const execPath = path.join(root, 'node'); await fs.writeFile(execPath, 'fixture', { mode: 0o700 });
  const calls: Array<{ file: string; args: string[] }> = []; const output: string[] = [];
  let active = false; let fail = ''; let ready = true; let paired = 0; let clock = 0;
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args }); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    if (args.includes(fail)) return { code: 1, stdout: '', stderr: 'synthetic-exec-secret' };
    if (file === 'tailscale') return { code: 0, stderr: '', stdout: args[0] === 'status'
      ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'arch.example.ts.net.' } }) : '100.64.0.1\nfd7a:115c:a1e0::1\n' };
    if (args.includes('is-active')) return { code: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
    if (file === 'loginctl') return { code: 0, stdout: 'no\n', stderr: '' };
    if (args.includes('list-units')) return { code: 0, stdout: 'relay-env-env_a.scope loaded active running\nrelay-env-env_b.scope loaded active running\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = { directory, home, runtimeDirectory, execPath, platform: 'linux', nodeVersion: '26.10.0', exec,
    stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) },
    ready: async (_remaining: number) => ready, pair: async () => { paired++; return 0; },
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, timeoutMs: 300 };
  return { deps, calls, output, directory, unit: path.join(home, '.config/systemd/user/relay-bridge.service'),
    setActive: (value: boolean) => { active = value; }, setFail: (value: string) => { fail = value; }, setReady: (value: boolean) => { ready = value; }, pairs: () => paired };
}

test('setup creates private nonsecret configuration and exact unit, enables then starts and pairs without state writes', async (t) => {
  const f = await fixture(t); assert.equal(await runSetup({}, f.deps), 0);
  assert.equal(await fs.readFile(path.join(f.directory, '.env'), 'utf8'), 'RELAY_HOST=100.64.0.1\nRELAY_PORT=8650\n');
  assert.equal((await fs.stat(path.join(f.directory, '.env'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(f.unit, 'utf8'), serviceUnit(f.directory, f.deps.execPath, '100.64.0.1', 8650));
  assert.equal(f.pairs(), 1); assert.ok(f.output.join('').includes('loginctl enable-linger'));
  assert.deepEqual(f.calls.filter(c => c.file === 'systemctl').map(c => c.args), [
    ['--user', 'show-environment'], ['--user', 'is-active', 'relay-bridge'], ['--user', 'daemon-reload'], ['--user', 'enable', 'relay-bridge'], ['--user', 'start', 'relay-bridge']]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.env', 'src']);
  assert.ok(f.calls.every(c => ['tailscale', 'systemctl', 'loginctl'].includes(c.file)));
  assert.ok(f.calls.every(c => !c.args.some(a => ['--now', 'sudo', 'serve', 'enable-linger', 'hermes'].includes(a))));
});

test('setup preserves an existing env byte for byte and is idempotent for an active service', async (t) => {
  const f = await fixture(t); const env = path.join(f.directory, '.env'); const original = 'synthetic-private-env\r\nRELAY_HOST=127.0.0.1\n';
  await fs.writeFile(env, original, { mode: 0o600 }); f.setActive(true);
  assert.equal(await runSetup({}, f.deps), 0); const before = await fs.stat(f.unit);
  assert.equal(await runSetup({}, f.deps), 0); assert.equal((await fs.stat(f.unit)).ino, before.ino);
  assert.equal(await fs.readFile(env, 'utf8'), original); assert.equal(f.pairs(), 2);
  assert.ok(!f.calls.some(c => c.args.includes('restart') || c.args.includes('start') || c.args.includes('--now')));
  assert.ok(!f.output.join('').includes(original));
});

test('setup refuses a different unit without replace-service; replacement never implies restart', async (t) => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.unit), { recursive: true }); await fs.writeFile(f.unit, 'custom-unit');
  f.setActive(true); assert.equal(await runSetup({}, f.deps), 1);
  assert.equal(await fs.readFile(f.unit, 'utf8'), 'custom-unit'); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
  assert.equal(await runSetup({ replaceService: true }, f.deps), 0);
  assert.equal(await fs.readFile(f.unit, 'utf8'), serviceUnit(f.directory, f.deps.execPath, '100.64.0.1', 8650));
  assert.ok(!f.calls.some(c => c.args.includes('restart') || c.args.includes('start')));
  assert.equal(await runSetup({ restart: true }, f.deps), 0);
  assert.equal(f.calls.filter(c => c.args.includes('restart')).length, 1);
});

test('setup prerequisite failures make no changes and never echo subprocess output', async (t) => {
  const f = await fixture(t);
  for (const override of [{ platform: 'darwin' }, { nodeVersion: '25.9.0' }, { runtimeDirectory: undefined }, { port: '70000' }, { directory: path.join(f.directory, 'missing') }]) {
    const { port, ...deps } = override; assert.equal(await runSetup({ port }, { ...f.deps, ...deps }), 1);
    await assert.rejects(fs.stat(f.unit)); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
  }
  for (const fail of ['show-environment', 'status', 'ip']) { f.setFail(fail); assert.equal(await runSetup({}, f.deps), 1); }
  assert.ok(!f.output.join('').includes('synthetic-exec-secret')); assert.equal(f.pairs(), 0);
});

test('setup reports completed steps on failure and waits boundedly without restarting an old active service', async (t) => {
  const f = await fixture(t); f.setActive(true); f.setReady(false);
  assert.equal(await runSetup({}, f.deps), 1); assert.equal(f.pairs(), 0); assert.ok(f.deps.now() >= 300);
  assert.ok(!f.calls.some(c => c.args.includes('restart')));
  assert.match(f.output.join(''), /instala primero la app/i); assert.match(f.output.join(''), /Pasos completados: 1, 2, 3, 4, 5/);
  f.setReady(true); f.setFail('enable'); assert.equal(await runSetup({}, f.deps), 1);
  assert.match(f.output.at(-1)!, /Pasos completados: 1, 2, 3, 4/);
  assert.ok(!f.output.join('').includes('synthetic-exec-secret'));
});

test('unit keeps raw WorkingDirectory, quotes argv, escapes percent and disables variable expansion without a shell', () => {
  const unit = serviceUnit('/opt/relay space/"quoted"/%i/\\folder/$HOME', '/opt/node space/"node"/%n/$BIN', '100.64.0.1', 8650);
  assert.ok(unit.includes('WorkingDirectory=/opt/relay space/"quoted"/%%i/\\folder/$HOME\n'));
  assert.ok(unit.includes('EnvironmentFile=/opt/relay space/"quoted"/%%i/\\\\folder/$HOME/.env\n'));
  assert.ok(unit.includes('ExecStart=:"/opt/node space/\\"node\\"/%%n/$BIN"'));
  assert.ok(unit.includes('"/opt/relay space/\\"quoted\\"/%%i/\\\\folder/$HOME/src/main.ts" serve'));
  assert.ok(unit.includes('UMask=0077')); assert.ok(unit.includes('StartLimitIntervalSec=0'));
  assert.ok(unit.includes('Restart=always\nRestartSec=5')); assert.ok(!unit.includes('RELAY_KEY'));
  assert.throws(() => serviceUnit('/opt/relay\nInjected=value', '/usr/bin/node', '100.64.0.1', 8650));
});

test('setup refuses symlinked configuration ancestors or files before changes', async (t) => {
  const f = await fixture(t); const other = path.join(f.deps.home, 'other'); await fs.mkdir(path.join(other, 'systemd/user'), { recursive: true });
  await fs.symlink(other, path.join(f.deps.home, '.config'));
  assert.equal(await runSetup({}, f.deps), 1); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
  await fs.unlink(path.join(f.deps.home, '.config'));
  await fs.symlink(f.deps.execPath, path.join(f.directory, '.env'));
  assert.equal(await runSetup({}, f.deps), 1); assert.equal(await fs.readFile(f.deps.execPath, 'utf8'), 'fixture');
});

test('setup hard socket deadline bounds a stalled readiness check and pair failure reports installed steps', async (t) => {
  const f = await fixture(t); f.setActive(true);
  const deps = { ...f.deps, now: Date.now, timeoutMs: 20, ready: async () => new Promise<boolean>(() => {}) };
  assert.equal(await runSetup({}, deps), 1); assert.equal(f.pairs(), 0);
  assert.match(f.output.at(-1)!, /Pasos completados: 1, 2, 3, 4, 5/);
  assert.equal(await runSetup({}, { ...f.deps, pair: async () => 1 }), 1);
  assert.match(f.output.at(-1)!, /Pasos completados: 1, 2, 3, 4, 5/);
});

test('setup accepts a root-owned executable Node and finishes through the interactive pair flow with the real QR', async (t) => {
  const f = await fixture(t); const stat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const result = await stat(...args); if (String(args[0]) === f.deps.execPath) Object.defineProperty(result, 'uid', { value: 0 }); return result;
  });
  const payload = { type: 'relay-pair' as const, version: 1 as const, url: 'http://arch.example.ts.net:8650', code: '0123456789' };
  const pair = () => runCli(['pair'], { stdout: { ...f.deps.stdout, isTTY: true, columns: 80 }, stderr: f.deps.stderr, serve: async () => { throw new Error('Must not initialize Hermes'); },
    request: async (request) => { assert.deepEqual(request, { command: 'pair' }); return { ok: true, result: { payload, expiresAt: 1_791_000_000_000 } }; } });
  assert.equal(await runSetup({}, { ...f.deps, pair }), 0);
  const output = f.output.join(''); assert.ok(output.includes(payload.url)); assert.ok(output.includes('01234-56789')); assert.ok(output.includes('Caduca:'));
  assert.ok(output.includes('\x1b[30;47m')); assert.ok(output.endsWith('Instalación del Puente completada.\n'));
});

test('service example equals setup output for its documented illustrative absolute paths', async () => {
  assert.equal(await fs.readFile(new URL('../relay-bridge.service.example', import.meta.url), 'utf8'), serviceUnit('/opt/relay/bridge', '/usr/bin/node', '100.64.0.10', 8650));
});

test('setup derives a local IPv6 bind and honors a configured port; invalid MagicDNS makes no changes', async (t) => {
  const f = await fixture(t); const base = f.deps.exec;
  const exec: Exec = async (file, args, options) => file === 'tailscale' && args[0] === 'ip'
    ? { code: 0, stdout: 'fd7a:115c:a1e0::1\n', stderr: '' } : base(file, args, options);
  assert.equal(await runSetup({ port: '9001' }, { ...f.deps, exec }), 0);
  assert.equal(await fs.readFile(path.join(f.directory, '.env'), 'utf8'), 'RELAY_HOST=fd7a:115c:a1e0::1\nRELAY_PORT=9001\n');
  const other = await fixture(t); const invalid: Exec = async (file, args, options) => file === 'tailscale' && args[0] === 'status'
    ? { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'synthetic-secret.evil' } }), stderr: '' } : other.deps.exec(file, args, options);
  assert.equal(await runSetup({}, { ...other.deps, exec: invalid }), 1);
  await assert.rejects(fs.stat(other.unit)); await assert.rejects(fs.stat(path.join(other.directory, '.env')));
  assert.ok(!other.output.join('').includes('synthetic-secret.evil'));
});

// Matches the libc glob() path selection used by systemd's EnvironmentFile loader.
const LIBC_GLOB = `
import ctypes, json, sys
class Glob(ctypes.Structure):
    _fields_ = [('count', ctypes.c_size_t), ('paths', ctypes.POINTER(ctypes.c_char_p)),
                ('offs', ctypes.c_size_t), ('flags', ctypes.c_int),
                ('closedir', ctypes.c_void_p), ('readdir', ctypes.c_void_p),
                ('opendir', ctypes.c_void_p), ('lstat', ctypes.c_void_p), ('stat', ctypes.c_void_p)]
lib = ctypes.CDLL(None)
lib.glob.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(Glob)]
lib.globfree.argtypes = [ctypes.POINTER(Glob)]
g = Glob()
code = lib.glob(sys.argv[1].encode(), 0, None, ctypes.byref(g))
print(json.dumps({'code': code, 'paths': [g.paths[i].decode() for i in range(g.count)]}))
lib.globfree(ctypes.byref(g))
`;

test('B1 EnvironmentFile selects only the literal checkout using libc glob despite similar siblings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-unit-glob-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ['relay[1]', 'relay*', 'relay?', 'relay\\folder', 'relay space', 'relay%i'];
  for (const name of [...names, 'relay1', 'relayX', 'relayfolder', 'relayspace', 'relayi']) {
    await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, '.env'), 'synthetic marker');
  }
  for (const name of names) {
    const directory = path.join(root, name);
    const directive = serviceUnit(directory, '/usr/bin/node', '100.64.0.1', 8650).split('\n').find(line => line.startsWith('EnvironmentFile='))!;
    // config_parse_unit_env_file preserves the raw path and expands %% into literal %.
    const pattern = directive.slice('EnvironmentFile='.length).replace(/%(.)/g, (_match, specifier) => {
      assert.equal(specifier, '%', 'Only literal percent specifiers may reach the loader'); return '%';
    });
    const result = await realExec('python3', ['-c', LIBC_GLOB, pattern], { timeoutMs: 3000 });
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { code: 0, paths: [path.join(directory, '.env')] }, name);
  }
});

// Model systemd's documented merge order: Environment, then EnvironmentFile overrides.
function unitEnvironment(unit: string): NodeJS.ProcessEnv {
  return Object.fromEntries(unit.split('\n').filter(line => line.startsWith('Environment=')).map(line => {
    const assignment = line.slice('Environment='.length); const equals = assignment.indexOf('=');
    return [assignment.slice(0, equals), assignment.slice(equals + 1)];
  }));
}

for (const [name, original, fileEnvironment] of [
  ['key-only', 'RELAY_KEY=synthetic-legacy-placeholder\n', { RELAY_KEY: 'synthetic-legacy-placeholder' }],
  ['quoted', 'OTHER="first line\nRELAY_HOST=100.64.0.99\nlast line"\n', { OTHER: 'first line\nRELAY_HOST=100.64.0.99\nlast line' }],
  ['continued', 'OTHER=first\\\nRELAY_HOST=100.64.0.99\n', { OTHER: 'firstRELAY_HOST=100.64.0.99' }],
  ['explicit', 'RELAY_HOST=fd7a:115c:a1e0::1\nRELAY_PORT=9002\n', { RELAY_HOST: 'fd7a:115c:a1e0::1', RELAY_PORT: '9002' }],
] as const) {
  test(`B6 legacy ${name} env stays unread and unchanged; generated bind defaults allow migration`, async (t) => {
    const f = await fixture(t); f.setActive(true);
    const oldUnit = '[Service]\nEnvironment=RELAY_HOST=100.64.0.1 RELAY_PORT=8650\n';
    const env = path.join(f.directory, '.env');
    await fs.mkdir(path.dirname(f.unit), { recursive: true }); await fs.writeFile(f.unit, oldUnit);
    await fs.writeFile(env, original, { mode: 0o600 }); const before = await fs.stat(env);
    const open = fs.open; const readFile = fs.readFile; let envReads = 0;
    t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === env) envReads++;
      assert.notEqual(String(args[0]), env, 'Setup must never open an existing env'); return open(...args);
    });
    t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === env) envReads++;
      assert.notEqual(String(args[0]), env, 'Setup must never read an existing env'); return readFile(...args);
    });
    const result = await runSetup({ replaceService: true, restart: true }, f.deps);
    assert.equal(envReads, 0); assert.equal(result, 0);
    const unit = await readFile(f.unit, 'utf8');
    assert.ok(unit.includes('Environment=RELAY_HOST=100.64.0.1\n'));
    assert.ok(unit.includes('Environment=RELAY_PORT=8650\n'));
    assert.ok(unit.includes('EnvironmentFile=')); assert.ok(!unit.includes('RELAY_KEY'));
    const config = loadConfig({ ...unitEnvironment(unit), ...fileEnvironment });
    assert.equal(config.host, name === 'explicit' ? 'fd7a:115c:a1e0::1' : '100.64.0.1');
    assert.equal(config.port, name === 'explicit' ? 9002 : 8650);
    assert.equal(await readFile(env, 'utf8'), original);
    const after = await fs.stat(env); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(f.calls.filter(call => call.args.includes('restart')).length, 1); assert.equal(f.pairs(), 1);
    assert.ok(!f.output.join('').includes(original)); assert.ok(!f.output.join('').includes('synthetic-legacy-placeholder'));
  });
}

test('B6 unit binds to the derived local IPv6 and configured port', async (t) => {
  const f = await fixture(t); const base = f.deps.exec;
  const exec: Exec = async (file, args, options) => file === 'tailscale' && args[0] === 'ip'
    ? { code: 0, stdout: 'fd7a:115c:a1e0::1\n', stderr: '' } : base(file, args, options);
  assert.equal(await runSetup({ port: '9001' }, { ...f.deps, exec }), 0);
  const unit = await fs.readFile(f.unit, 'utf8');
  assert.ok(unit.includes('Environment=RELAY_HOST=fd7a:115c:a1e0::1\n'));
  assert.ok(unit.includes('Environment=RELAY_PORT=9001\n'));
});

for (const [action, completed] of [
  ['enable', 'recargar las unidades'], ['start', 'recargar las unidades; habilitar el servicio'],
  ['restart', 'recargar las unidades; habilitar el servicio'],
] as const) {
  test(`B4 setup reports successful actions before ${action} fails`, async (t) => {
    const f = await fixture(t); f.setFail(action); f.setActive(action === 'restart');
    assert.equal(await runSetup({ restart: true }, f.deps), 1);
    const output = f.output.at(-1)!;
    assert.match(output, /Pasos completados: 1, 2, 3, 4\./);
    assert.ok(output.includes(`Acciones completadas del paso 5: ${completed}.`));
    assert.ok(output.includes(`Acción fallida: ${action === 'enable' ? 'habilitar' : action === 'start' ? 'iniciar' : 'reiniciar'} el servicio.`));
    assert.ok(!output.includes('synthetic-exec-secret')); assert.equal(f.pairs(), 0);
  });
}

test('setup persists explicitly selected public Hermes paths in the unit without rewriting an existing env or invoking Hermes', async t => {
  const f = await fixture(t), original = 'synthetic-private-settings\n';
  await fs.writeFile(path.join(f.directory, '.env'), original, { mode: 0o600 });
  const hermesHome = path.join(f.deps.home, 'existing Hermes %h'), hermesBin = path.join(f.deps.home, 'bin/hermes cli');
  assert.equal(await runSetup({ hermesHome, hermesBin }, f.deps), 0);
  const unit = await fs.readFile(f.unit, 'utf8');
  assert.ok(unit.includes(`Environment="HERMES_HOME=${hermesHome.replace(/%/g, '%%')}"\n`));
  assert.ok(unit.includes(`Environment="HERMES_BIN=${hermesBin}"\n`));
  assert.equal(await fs.readFile(path.join(f.directory, '.env'), 'utf8'), original);
  assert.ok(f.calls.every(call => call.file !== hermesBin && call.file !== 'hermes'));
  const before = await fs.stat(f.unit); f.setActive(true);
  assert.equal(await runSetup({ hermesHome, hermesBin }, f.deps), 0);
  assert.equal((await fs.stat(f.unit)).ino, before.ino);
  assert.ok(!f.calls.some(call => call.args.includes('restart')));
});

test('selected Hermes paths reject directive injection before configuration writes', async t => {
  for (const options of [{ hermesHome: '/synthetic\nEnvironment=INJECTED=yes' }, { hermesBin: 'relative-hermes' }]) {
    const f = await fixture(t); assert.equal(await runSetup(options, f.deps), 1);
    await assert.rejects(fs.stat(f.unit)); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
    assert.ok(!f.output.join('').includes('INJECTED'));
  }
});

/** A compiled supervisor checkout next to the fixture's Puente, as npm run setup leaves it. */
async function withSupervisor(f: { directory: string; unit: string; deps: { runtimeDirectory: string } }) {
  const checkout = path.join(path.dirname(f.directory), 'supervisor');
  await fs.mkdir(path.join(checkout, 'src'), { recursive: true }); await fs.writeFile(path.join(checkout, 'src/main.ts'), 'fixture');
  await fs.mkdir(path.join(checkout, 'node_modules/node-pty/build/Release'), { recursive: true });
  await fs.writeFile(path.join(checkout, 'node_modules/node-pty/package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  await fs.writeFile(path.join(checkout, 'node_modules/node-pty/build/Release/pty.node'), 'fixture');
  const runtime = path.join(await fs.realpath(f.deps.runtimeDirectory), 'relay-supervisor');
  return { checkout, runtime, unit: path.join(path.dirname(f.unit), 'relay-supervisor.service') };
}
const systemctl = (f: { calls: Array<{ file: string; args: string[] }> }) => f.calls.filter(c => c.file === 'systemctl').map(c => c.args.slice(1).join(' '));

test('V3 setup installs the supervisor in its own unit before the Puente, which points at it and enables the chosen tools', async (t) => {
  const f = await fixture(t); const s = await withSupervisor(f);
  const options = { supervisor: true, remoteFiles: true, remoteWeb: true, browserHabitual: true };
  assert.equal(await runSetup(options, f.deps), 0, f.output.join(''));
  assert.equal(await fs.readFile(s.unit, 'utf8'), supervisorUnit(s.checkout, f.deps.execPath, s.runtime));
  const unit = await fs.readFile(f.unit, 'utf8');
  assert.equal(unit, serviceUnit(f.directory, f.deps.execPath, '100.64.0.1', 8650, { ...options, supervisorDirectory: s.runtime }));
  const config = loadConfig(systemdEnvironment(unit));
  assert.deepEqual([config.supervisorDirectory, config.remoteFiles, config.remoteWeb, config.browserHabitual], [s.runtime, true, true, true]);
  assert.deepEqual(systemctl(f), ['show-environment', 'is-active relay-bridge', 'is-active relay-supervisor', 'daemon-reload',
    'enable relay-supervisor', 'start relay-supervisor', 'enable relay-bridge', 'start relay-bridge']);
  assert.equal((await fs.stat(s.unit)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(f.unit))).sort(), ['relay-bridge.service', 'relay-supervisor.service']);
});

test('updating the Puente restarts only the Puente: no unit ties them, and the supervisor and its terminals are never touched', async (t) => {
  const f = await fixture(t); const s = await withSupervisor(f);
  assert.equal(await runSetup({ supervisor: true }, f.deps), 0);
  f.setActive(true); f.calls.length = 0;
  // A new checkout of the Puente with web on: replaced unit, explicit restart.
  assert.equal(await runSetup({ supervisor: true, remoteWeb: true, replaceService: true, restart: true }, f.deps), 0, f.output.join(''));
  const touched = systemctl(f).filter(call => /relay-supervisor/.test(call));
  assert.deepEqual(touched, ['is-active relay-supervisor', 'enable relay-supervisor']);
  assert.ok(systemctl(f).includes('restart relay-bridge'));
  const bridge = await fs.readFile(f.unit, 'utf8'), supervisor = await fs.readFile(s.unit, 'utf8');
  for (const directive of ['Requires=', 'BindsTo=', 'PartOf=', 'Wants=', 'After=', 'Before=']) {
    assert.ok(!bridge.includes(directive) && !supervisor.includes(directive), `${directive} would couple their lifecycles`);
  }
  assert.ok(!bridge.includes('relay-supervisor.service'));
  // Terminals inherit the supervisor's environment: none of the Puente's private settings or umask.
  assert.ok(!supervisor.includes('EnvironmentFile') && !supervisor.includes('UMask') && !supervisor.includes('RELAY_'));
});

test('restarting the supervisor is a separate explicit flag that first warns how many live environments become lost', async (t) => {
  const f = await fixture(t); await withSupervisor(f); f.setActive(true);
  assert.equal(await runSetup({ supervisor: true }, f.deps), 0);
  assert.ok(!systemctl(f).some(call => call.startsWith('restart')));
  assert.match(f.output.join(''), /próximo arranque/);
  f.calls.length = 0; f.output.length = 0;
  assert.equal(await runSetup({ supervisor: true, restartSupervisor: true }, f.deps), 0);
  const order = systemctl(f);
  assert.ok(order.indexOf('list-units --plain --no-legend --state=active relay-env-*.scope') < order.indexOf('restart relay-supervisor'));
  assert.ok(!order.includes('restart relay-bridge'));
  assert.match(f.output.join(''), /2 entorno\(s\) vivo\(s\) quedarán perdidos \(lost\)/);
});

test('V3 flags that need the supervisor, or a supervisor without compiled node-pty, fail before any change', async (t) => {
  for (const options of [{ browserHabitual: true }, { restartSupervisor: true }, { supervisor: true }]) {
    const f = await fixture(t);
    // The checkout is there, node-pty was never compiled.
    if (options.supervisor) { const s = await withSupervisor(f); await fs.rm(path.join(s.checkout, 'node_modules'), { recursive: true }); }
    assert.equal(await runSetup(options, f.deps), 1);
    await assert.rejects(fs.stat(f.unit)); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
    assert.ok(!f.calls.some(c => c.file === 'systemctl'));
    assert.match(f.output.join(''), options.supervisor ? /npm run setup en supervisor/ : /--supervisor/);
  }
});

test('dry run checks like the real run, prints the exact units and commands, and writes or changes nothing', async (t) => {
  const f = await fixture(t); const s = await withSupervisor(f);
  const options = { supervisor: true, remoteFiles: true, dryRun: true };
  assert.equal(await runSetup(options, f.deps), 0, f.output.join(''));
  await assert.rejects(fs.stat(f.unit)); await assert.rejects(fs.stat(s.unit)); await assert.rejects(fs.stat(path.join(f.directory, '.env')));
  await assert.rejects(fs.stat(path.dirname(f.unit)));
  assert.deepEqual(systemctl(f), ['show-environment', 'is-active relay-bridge', 'is-active relay-supervisor']);
  assert.equal(f.pairs(), 0);
  const output = f.output.join('');
  for (const line of supervisorUnit(s.checkout, f.deps.execPath, s.runtime).split('\n').filter(Boolean)) assert.ok(output.includes(`  | ${line}\n`), line);
  assert.ok(output.includes('  | Environment=RELAY_REMOTE_FILES=1\n'));
  assert.match(output, /systemctl --user enable relay-supervisor\n {2}systemctl --user start relay-supervisor\n {2}systemctl --user enable relay-bridge\n {2}systemctl --user start relay-bridge\n/);
  // A different installed unit fails the dry run exactly where the real run would.
  await fs.mkdir(path.dirname(f.unit), { recursive: true }); await fs.writeFile(f.unit, 'custom-unit');
  assert.equal(await runSetup(options, f.deps), 1); assert.match(f.output.at(-1)!, /--replace-service/);
  assert.equal(await fs.readFile(f.unit, 'utf8'), 'custom-unit');
});

test('drop-ins over a unit are named in the dry run and the real run, never read nor changed', async (t) => {
  const f = await fixture(t); await withSupervisor(f);
  const dropIns = path.join(path.dirname(f.unit), 'relay-bridge.service.d');
  await fs.mkdir(dropIns, { recursive: true });
  const content = '[Service]\nExecStart=\nExecStart=:/usr/bin/node /elsewhere/update-entry.ts synthetic-dropin-secret\n';
  await fs.writeFile(path.join(dropIns, '90-relay-v2-update.conf'), content);
  await fs.writeFile(path.join(dropIns, 'README'), 'synthetic-dropin-secret');
  for (const dryRun of [true, false]) {
    f.output.length = 0;
    assert.equal(await runSetup({ supervisor: true, dryRun }, f.deps), 0, f.output.join(''));
    const output = f.output.join('');
    assert.match(output, /relay-bridge\.service\.d: 90-relay-v2-update\.conf .*ExecStart/);
    assert.doesNotMatch(output, /README|synthetic-dropin-secret|elsewhere|relay-supervisor\.service\.d/);
  }
  assert.deepEqual((await fs.readdir(dropIns)).sort(), ['90-relay-v2-update.conf', 'README']);
  assert.equal(await fs.readFile(path.join(dropIns, '90-relay-v2-update.conf'), 'utf8'), content);
});

test('replacing a unit names the settings the new one drops, without their values', async (t) => {
  const f = await fixture(t); await withSupervisor(f);
  assert.equal(await runSetup({ supervisor: true, remoteFiles: true, remoteWeb: true, browserHabitual: true }, f.deps), 0);
  for (const dryRun of [true, false]) {
    f.output.length = 0;
    assert.equal(await runSetup({ supervisor: true, remoteFiles: true, replaceService: true, dryRun }, f.deps), 0, f.output.join(''));
    const dropped = /Aviso: relay-bridge\.service ya no tendría ([^;\n]+);/.exec(f.output.join(''));
    assert.equal(dropped?.[1], 'RELAY_REMOTE_WEB, RELAY_BROWSER_HABITUAL', f.output.join(''));
  }
  f.output.length = 0;
  assert.equal(await runSetup({ supervisor: true, remoteFiles: true, dryRun: true }, f.deps), 0);
  assert.doesNotMatch(f.output.join(''), /ya no tendría/);
});

test('an update interrupted while writing the Puente unit keeps the old unit whole; repeating it finishes without touching the supervisor', async (t) => {
  const f = await fixture(t); const s = await withSupervisor(f);
  await fs.mkdir(path.dirname(f.unit), { recursive: true }); await fs.writeFile(f.unit, 'old-unit');
  const rename = fs.rename; let interrupt = true;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (interrupt && String(args[1]) === f.unit) throw Object.assign(new Error('synthetic-exec-secret'), { code: 'EIO' });
    return rename(...args);
  });
  assert.equal(await runSetup({ supervisor: true, replaceService: true }, f.deps), 1);
  assert.match(f.output.at(-1)!, /Pasos completados: 1, 2, 3\./); assert.ok(!f.output.join('').includes('synthetic-exec-secret'));
  assert.equal(await fs.readFile(f.unit, 'utf8'), 'old-unit');
  assert.equal(await fs.readFile(s.unit, 'utf8'), supervisorUnit(s.checkout, f.deps.execPath, s.runtime));
  assert.ok(!systemctl(f).some(call => /daemon-reload|enable|start/.test(call)));
  interrupt = false; f.setActive(true); f.calls.length = 0;
  assert.equal(await runSetup({ supervisor: true, replaceService: true, restart: true }, f.deps), 0);
  assert.ok(!systemctl(f).some(call => /(start|stop|restart) relay-supervisor/.test(call)));
  assert.deepEqual((await fs.readdir(path.dirname(f.unit))).sort(), ['relay-bridge.service', 'relay-supervisor.service']);
});

test('generated units pass systemd-analyze verify', { skip: (await realExec('systemd-analyze', ['--version'], { timeoutMs: 3000 }).catch(() => null))?.code === 0 ? false : 'systemd-analyze is not available' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-unit-verify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['bridge/src', 'supervisor/src']) { await fs.mkdir(path.join(root, name), { recursive: true }); await fs.writeFile(path.join(root, name, 'main.ts'), ''); }
  await fs.writeFile(path.join(root, 'relay-bridge.service'), serviceUnit(path.join(root, 'bridge'), process.execPath, '100.64.0.1', 8650, { supervisorDirectory: path.join(root, 'run'), remoteFiles: true, remoteWeb: true, browserHabitual: true }));
  await fs.writeFile(path.join(root, 'relay-supervisor.service'), supervisorUnit(path.join(root, 'supervisor'), process.execPath, path.join(root, 'run')));
  const result = await realExec('systemd-analyze', ['--user', 'verify', path.join(root, 'relay-bridge.service'), path.join(root, 'relay-supervisor.service')], { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr.trim(), '');
});

test('a unit systemd does not know yet (systemd 261: exit 4, inactive) counts as inactive and is started', async (t) => {
  const f = await fixture(t); await withSupervisor(f); const base = f.deps.exec;
  const exec: Exec = async (file, args, options) => args[1] === 'is-active' ? { code: 4, stdout: 'inactive\n', stderr: '' } : base(file, args, options);
  assert.equal(await runSetup({ supervisor: true }, { ...f.deps, exec }), 0, f.output.join(''));
  assert.ok(systemctl(f).includes('start relay-supervisor') && systemctl(f).includes('start relay-bridge'));
  const other = await fixture(t);
  const odd: Exec = async (file, args, options) => args[1] === 'is-active' ? { code: 4, stdout: 'activating\n', stderr: '' } : other.deps.exec(file, args, options);
  assert.equal(await runSetup({}, { ...other.deps, exec: odd }), 1); await assert.rejects(fs.stat(other.unit));
});
