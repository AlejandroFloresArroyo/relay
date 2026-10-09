import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Exec, ExecResult } from '../src/exec.ts';
import { formatChecks, runDoctor } from '../src/doctor.ts';
import { RELAY_EXTENSION_ID } from '../src/remote/habitualBrowser.ts';
import { serviceUnit } from '../src/setup.ts';

const SECRET = 'synthetic-doctor-secret';
const UID = process.getuid!();
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const missing = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

/** A healthy Server under a temporary root: /sys, /proc, the home, the checkout and the tools all answer. */
async function machine(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), configHome = path.join(home, '.config'), runtimeDirectory = path.join(root, 'run/user/1000');
  const repo = path.join(root, 'relay'), directory = path.join(repo, 'bridge'), supervisor = path.join(repo, 'supervisor');
  const prefix = path.join(root, 'node'), execPath = path.join(prefix, 'bin/node');
  const slice = path.join(root, `sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/app.slice`);
  await fs.mkdir(slice, { recursive: true });
  await fs.writeFile(path.join(root, 'sys/fs/cgroup/cgroup.controllers'), 'cpu memory pids\n');
  await fs.writeFile(path.join(slice, 'cgroup.kill'), '', { mode: 0o200 });
  await fs.writeFile(path.join(slice, 'cgroup.controllers'), 'cpu memory pids\n');
  // The user manager's PATH, where the supervisor finds the dedicated browser: chromium in the second folder.
  const bins = [path.join(root, 'usr/local/bin'), path.join(root, 'usr/bin')];
  for (const bin of bins) await fs.mkdir(bin, { recursive: true });
  const dedicated = path.join(bins[1]!, 'chromium');
  await fs.writeFile(dedicated, '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(bins[0]!, 'google-chrome'), 'not executable\n', { mode: 0o644 });
  await fs.mkdir(path.join(root, 'proc/self/fd'), { recursive: true }); await fs.mkdir(path.join(root, 'proc/net'), { recursive: true });
  await fs.writeFile(path.join(root, 'proc/net/tcp'), '  sl  local_address\n');
  await fs.mkdir(path.join(prefix, 'include/node'), { recursive: true }); await fs.writeFile(path.join(prefix, 'include/node/node.h'), '');
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true }); await fs.writeFile(execPath, '', { mode: 0o700 });
  await fs.mkdir(path.join(directory, 'src'), { recursive: true }); await fs.writeFile(path.join(directory, 'src/main.ts'), '');
  await fs.writeFile(path.join(directory, '.env'), `SECRET=${SECRET}\n`, { mode: 0o600 });
  await fs.mkdir(path.join(supervisor, 'src'), { recursive: true }); await fs.writeFile(path.join(supervisor, 'src/main.ts'), '');
  await fs.mkdir(path.join(supervisor, 'node_modules/node-pty/build/Release'), { recursive: true });
  await fs.writeFile(path.join(supervisor, 'node_modules/node-pty/package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
  await fs.writeFile(path.join(supervisor, 'node_modules/node-pty/build/Release/pty.node'), '');
  const supervisorRuntime = path.join(runtimeDirectory, 'relay-supervisor');
  await fs.mkdir(supervisorRuntime, { recursive: true, mode: 0o700 }); await fs.chmod(supervisorRuntime, 0o700);
  await fs.writeFile(path.join(supervisorRuntime, 'supervisor.key'), SECRET, { mode: 0o600 });
  await fs.writeFile(path.join(supervisorRuntime, 'supervisor.sock'), '');
  const units = path.join(configHome, 'systemd/user'); await fs.mkdir(units, { recursive: true });
  await fs.writeFile(path.join(units, 'relay-supervisor.service'), '[Service]\n');
  await fs.writeFile(path.join(units, 'relay-bridge.service'), serviceUnit(directory, execPath, '100.64.0.1', 8650,
    { supervisorDirectory: supervisorRuntime, remoteFiles: true, remoteWeb: true, browserHabitual: true }));
  const hosts = path.join(configHome, 'google-chrome/NativeMessagingHosts'); await fs.mkdir(hosts, { recursive: true });
  const wrapper = path.join(directory, 'browser/relay-browser-host');
  await fs.mkdir(path.dirname(wrapper), { mode: 0o700 }); await fs.writeFile(wrapper, '#!/bin/sh\n', { mode: 0o700 });
  const manifest = path.join(hosts, 'com.relay.browser.json');
  await fs.writeFile(manifest, JSON.stringify({ name: 'com.relay.browser', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${RELAY_EXTENSION_ID}/`] }), { mode: 0o600 });

  const answers = new Map<string, ExecResult | (() => never)>([
    ['systemctl --user show-environment', ok(`SECRET=${SECRET}\nPATH=relative/bin:${bins.join(':')}\n`)],
    ['systemctl --user is-active relay-supervisor', ok('active\n')],
    ['systemctl --user is-active relay-bridge', ok('active\n')],
    ['systemd-run --version', ok('systemd 261 (261.1-1-arch)\n+PAM\n')],
    [`loginctl show-user ${UID} --property=Linger --value`, ok('yes\n')],
    [`${execPath} -e require(process.argv[1]) ${path.join(supervisor, 'node_modules/node-pty')}`, ok()],
    ['c++ --version', ok('c++ 16.2.1\n')], ['make --version', ok('GNU Make 4.4.1\n')], ['python3 --version', ok('Python 3.14.7\n')],
    ['tailscale status --json', ok(JSON.stringify({ BackendState: 'Running', CertDomains: ['arch.secret-tailnet.ts.net'], MagicDNSSuffix: 'secret-tailnet.ts.net', Self: { ID: SECRET, DNSName: 'arch.secret-tailnet.ts.net.', Tags: ['tag:relay-web'] } }))],
    ['google-chrome-stable --version', ok('Google Chrome 154.0.8037.57 \n')],
    ['chromium --version', ok('Chromium 152.0.7977.82 Arch Linux\n')],
    [`${dedicated} --version`, ok('Chromium 152.0.7977.82 Arch Linux\n')],
  ]);
  const calls: string[] = [];
  const exec: Exec = async (file, args, options) => {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10_000);
    const line = [file, ...args].join(' '); calls.push(line);
    const answer = answers.get(line);
    if (answer === undefined) throw missing();
    if (typeof answer === 'function') return answer();
    return answer;
  };
  const deps = { platform: 'linux', arch: 'x64', nodeVersion: '26.10.0', execPath, uid: UID, home, configHome, runtimeDirectory, directory, root, exec };
  const run = async (override: Partial<typeof deps> = {}) => {
    const checks = await runDoctor({ ...deps, ...override });
    return { checks, text: formatChecks(checks), find: (area: RegExp) => checks.filter((check) => area.test(check.area)) };
  };
  return { root, deps, answers, calls, run, home, directory, supervisor, supervisorRuntime, slice, manifest, units, execPath, bins, dedicated };
}

const READ_ONLY = /^(systemctl --user (show-environment|is-active relay-(supervisor|bridge))|systemd-run --version|loginctl show-user \d+ --property=Linger --value|\S+ -e require\(process\.argv\[1\]\) \S+|(c\+\+|make|python3) --version|tailscale status --json|(\S+\/)?(google-chrome-stable|google-chrome|chromium|chromium-browser) --version)$/;

test('a ready Server passes every V3 check with tested versions, read-only commands and no secret in the report', async (t) => {
  const m = await machine(t);
  // Never a secret nor a profile, not even by name: every way doctor reaches the disk is watched.
  for (const method of ['open', 'readFile', 'readdir', 'opendir', 'stat', 'lstat', 'access'] as const) {
    const original = fs[method];
    t.mock.method(fs, method, (...args: [string]) => {
      assert.ok(!/\.env$|supervisor\.key$|\/Default\b|Local State/.test(String(args[0])), `doctor must not ${method} ${args[0]}`);
      return (original as (...a: unknown[]) => unknown)(...args);
    });
  }
  const { checks, text } = await m.run();
  const failing = checks.filter((check) => check.state === 'falta');
  assert.deepEqual(failing.map((check) => check.area), [], text);
  // Chromium 152 is below the extension's minimum: a warning for the habitual browser, not a failure.
  assert.equal(checks.find((check) => check.area === 'Navegador chromium')?.state, 'aviso');
  assert.match(text, /Node\s+26\.10\.0/); assert.match(text, /node-pty 1\.1\.0/); assert.match(text, /154\.0\.8037\.57.*probad/);
  assert.match(text, /chromium 152.*154/i);
  // The dedicated browser the supervisor would launch, found as it finds it, and the limits its scope needs.
  assert.deepEqual(checks.filter((check) => check.area.startsWith('Navegador dedicado')).map(({ area, state }) => [area, state]), [['Navegador dedicado', 'ok'], ['Navegador dedicado: topes', 'ok']]);
  assert.match(checks.find((check) => check.area === 'Navegador dedicado')!.detail, new RegExp(`Chromium 152\\.0\\.7977\\.82 \\(probado\\).*${m.dedicated}`));
  assert.match(text, /chrome:\/\/extensions/);
  assert.ok(m.calls.every((call) => READ_ONLY.test(call)), m.calls.join('\n'));
  assert.ok(!text.includes(SECRET)); assert.ok(!text.includes('secret-tailnet'));
});

test('absent requirements each name what is missing and the command or step that fixes it', async (t) => {
  const m = await machine(t);
  for (const key of ['systemctl --user show-environment', 'systemd-run --version', 'make --version', 'python3 --version', 'google-chrome-stable --version', 'chromium --version', 'tailscale status --json']) m.answers.delete(key);
  m.answers.delete([...m.answers.keys()].find((key) => key.includes('require('))!);
  await fs.rm(path.join(m.root, 'sys/fs/cgroup/cgroup.controllers'));
  await fs.rm(path.join(m.supervisor, 'node_modules'), { recursive: true });
  await fs.rm(path.join(path.dirname(path.dirname(m.execPath)), 'include'), { recursive: true });
  const { checks, text, find } = await m.run();
  assert.ok(checks.some((check) => check.state === 'falta'));
  assert.match(find(/systemd/)[0]!.action!, /sesión/);
  assert.match(find(/cgroup v2/)[0]!.state, /falta/);
  const pty = find(/PTY/)[0]!; assert.equal(pty.state, 'falta');
  assert.match(pty.detail, /make/); assert.match(pty.detail, /python3/); assert.match(pty.detail, /cabeceras/); assert.doesNotMatch(pty.detail, /c\+\+/);
  assert.match(pty.action!, /npm run setup/);
  assert.match(find(/Tailscale/)[0]!.action!, /tailscale/i);
  assert.match(find(/^Navegador$/)[0]!.action!, /Chrome/);
  assert.ok(!text.includes(SECRET));
});

test('denied permissions on the delegated cgroup, the supervisor directory and the host manifest are reported, not thrown', async (t) => {
  const m = await machine(t);
  await fs.chmod(path.join(m.slice, 'cgroup.kill'), 0o400);
  await fs.chmod(m.supervisorRuntime, 0o755);
  await fs.chmod(m.manifest, 0o000);
  const { find, text } = await m.run();
  const supervision = find(/supervisión/)[0]!; assert.equal(supervision.state, 'falta'); assert.match(supervision.detail, /cgroup\.kill/);
  const supervisor = find(/^Supervisor$/)[0]!; assert.equal(supervisor.state, 'falta'); assert.match(supervisor.detail, /permisos/);
  const host = find(/Adaptador google-chrome/)[0]!; assert.equal(host.state, 'falta'); assert.match(host.action!, /relayd browser google-chrome/);
  assert.ok(!text.includes(SECRET));
});

test('malformed configuration is named with its fix: invalid unit values, foreign supervisor directory and a bad host manifest', async (t) => {
  const m = await machine(t);
  const unit = path.join(m.units, 'relay-bridge.service');
  await fs.writeFile(unit, (await fs.readFile(unit, 'utf8')).replace('RELAY_REMOTE_FILES=1', 'RELAY_REMOTE_FILES=yes'));
  await fs.writeFile(m.manifest, '{ not json');
  let { find } = await m.run();
  assert.equal(find(/^Puente$/)[0]!.state, 'falta'); assert.match(find(/^Puente$/)[0]!.detail, /RELAY_REMOTE_FILES/);
  assert.equal(find(/Adaptador google-chrome/)[0]!.state, 'falta');
  await fs.writeFile(unit, serviceUnit(m.directory, m.execPath, '100.64.0.1', 8650, { supervisorDirectory: path.join(m.root, 'elsewhere') }));
  await fs.writeFile(m.manifest, JSON.stringify({ name: 'com.relay.browser', path: '/tmp/other', type: 'stdio', allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] }));
  ({ find } = await m.run());
  assert.match(find(/^Puente$/)[0]!.detail, /otro directorio/);
  assert.match(find(/Adaptador google-chrome/)[0]!.detail, /otra extensión|no corresponde/);
  // A manifest of Relay's extension whose adapter was deleted.
  await fs.writeFile(m.manifest, JSON.stringify({ name: 'com.relay.browser', path: path.join(m.directory, 'browser/missing-host'), type: 'stdio', allowed_origins: [`chrome-extension://${RELAY_EXTENSION_ID}/`] }));
  ({ find } = await m.run());
  const host = find(/Adaptador google-chrome/)[0]!;
  assert.equal(host.state, 'falta'); assert.match(host.detail, /no existe/); assert.equal(host.action, 'relayd browser google-chrome');
});

test('versions and architectures outside the tested matrix are warnings, below the minimum are failures', async (t) => {
  const m = await machine(t);
  let { find } = await m.run({ nodeVersion: '27.1.0', arch: 'arm64' });
  assert.equal(find(/^Node$/)[0]!.state, 'aviso'); assert.equal(find(/^Sistema$/)[0]!.state, 'aviso');
  ({ find } = await m.run({ nodeVersion: '25.9.0', platform: 'darwin' }));
  assert.equal(find(/^Node$/)[0]!.state, 'falta'); assert.equal(find(/^Sistema$/)[0]!.state, 'falta');
  m.answers.set('google-chrome-stable --version', ok('Google Chrome 155.0.1.2\n'));
  await fs.writeFile(path.join(m.supervisor, 'node_modules/node-pty/package.json'), JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }));
  ({ find } = await m.run());
  assert.equal(find(/Navegador google-chrome/)[0]!.state, 'aviso');
  assert.equal(find(/PTY/)[0]!.state, 'falta'); assert.match(find(/PTY/)[0]!.detail, /1\.2\.0-beta\.15/);
});

test('an HTTPS-less, untagged tailnet leaves web publication as explicit console steps; linger off is a warning', async (t) => {
  const m = await machine(t);
  m.answers.set('tailscale status --json', ok(JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 'x.ts.net', Self: { DNSName: 'arch.x.ts.net.' } })));
  m.answers.set(`loginctl show-user ${UID} --property=Linger --value`, ok('no\n'));
  const { find } = await m.run();
  const web = find(/Tailscale/)[0]!; assert.equal(web.state, 'falta');
  assert.match(web.detail, /HTTPS/); assert.match(web.detail, /tag/); assert.match(web.action!, /v3-install\.md/);
  assert.equal(find(/Linger/)[0]!.state, 'aviso'); assert.match(find(/Linger/)[0]!.action!, /loginctl enable-linger/);
});

test('without a fixture root the checks read the real /proc of this Linux machine', async (t) => {
  const m = await machine(t);
  const { find } = await m.run({ root: undefined });
  assert.equal(find(/^Archivos$/)[0]!.state, 'ok');
});

test('the dedicated browser: none in the supervisor\'s PATH, a version outside the matrix, or a user manager that does not delegate its limits', async (t) => {
  const m = await machine(t);
  m.answers.set(`${m.dedicated} --version`, ok('Chromium 155.0.1.2\n'));
  let { find } = await m.run();
  assert.equal(find(/^Navegador dedicado$/)[0]!.state, 'aviso'); assert.match(find(/^Navegador dedicado$/)[0]!.detail, /155\.0\.1\.2.*no certificada/);
  // The supervisor's order, whatever folder each is in: chromium first, then google-chrome-stable, never one that does not run.
  const stable = path.join(m.bins[0]!, 'google-chrome-stable');
  await fs.writeFile(stable, '#!/bin/sh\n', { mode: 0o755 });
  m.answers.set(`${stable} --version`, ok('Google Chrome 154.0.8037.57 \n'));
  ({ find } = await m.run());
  assert.match(find(/^Navegador dedicado$/)[0]!.detail, /Chromium 155/);
  await fs.rm(m.dedicated);
  ({ find } = await m.run());
  assert.equal(find(/^Navegador dedicado$/)[0]!.state, 'ok'); assert.match(find(/^Navegador dedicado$/)[0]!.detail, /Google Chrome 154\.0\.8037\.57.*google-chrome-stable/);
  await fs.rm(stable);
  ({ find } = await m.run());
  const none = find(/^Navegador dedicado$/)[0]!;
  assert.equal(none.state, 'aviso'); assert.match(none.detail, /PATH del supervisor/); assert.match(none.action!, /chromium, google-chrome-stable, google-chrome, chromium-browser/);
  await fs.writeFile(path.join(m.slice, 'cgroup.controllers'), 'cpu pids\n');
  ({ find } = await m.run());
  const limits = find(/^Navegador dedicado: topes$/)[0]!;
  assert.equal(limits.state, 'falta'); assert.match(limits.detail, /memory/); assert.doesNotMatch(limits.detail, /pids/); assert.match(limits.action!, /user@\.service/);
});

test('drop-ins over either unit are warnings that name their files, never their content', async (t) => {
  const m = await machine(t);
  const bridge = path.join(m.units, 'relay-bridge.service.d'), supervisor = path.join(m.units, 'relay-supervisor.service.d');
  await fs.mkdir(bridge); await fs.mkdir(supervisor);
  await fs.writeFile(path.join(bridge, '90-relay-v2-update.conf'), `[Service]\nExecStart=\nExecStart=:/usr/bin/node /elsewhere/update-entry.ts ${SECRET}\n`);
  await fs.writeFile(path.join(bridge, 'notes.txt'), SECRET);
  await fs.writeFile(path.join(supervisor, 'override.conf'), `[Service]\nEnvironment=TOKEN=${SECRET}\n`);
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', (...args: [string]) => {
    assert.ok(!String(args[0]).includes('.service.d'), `doctor must not read ${args[0]}`);
    return (readFile as (...a: unknown[]) => unknown)(...args);
  });
  const { find, text } = await m.run();
  const overBridge = find(/^Puente: drop-ins$/)[0]!;
  assert.equal(overBridge.state, 'aviso'); assert.match(overBridge.detail, /90-relay-v2-update\.conf/); assert.match(overBridge.detail, /ExecStart/);
  assert.doesNotMatch(overBridge.detail, /notes\.txt/); assert.match(overBridge.action!, /relayd setup/);
  const overSupervisor = find(/^Supervisor: drop-ins$/)[0]!;
  assert.equal(overSupervisor.state, 'aviso'); assert.match(overSupervisor.detail, /override\.conf/);
  assert.ok(!text.includes(SECRET)); assert.ok(!text.includes('/elsewhere'));
  // Without drop-ins, no such line.
  await fs.rm(bridge, { recursive: true }); await fs.rm(supervisor, { recursive: true });
  assert.deepEqual((await m.run()).find(/drop-ins/), []);
});
