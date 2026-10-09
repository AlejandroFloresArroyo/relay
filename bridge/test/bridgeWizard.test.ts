import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';

const source = path.resolve(import.meta.dirname, '../../scripts/bridge-wizard.sh');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay bridge wizard '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), trace = path.join(root, 'argv.bin'), runtime = path.join(root, 'runtime');
  for (const directory of ['bin', 'scripts', 'bridge/src', 'runtime']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const wizard = path.join(root, 'scripts/bridge-wizard.sh'); fs.copyFileSync(source, wizard);
  const executable = (file: string, body: string) => fs.writeFileSync(file, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  executable(path.join(root, 'scripts/prepare-dev.sh'), '[[ "$#" == 1 && "$1" == --check ]] || exit 91; printf "checked\\n"');
  // `relayd doctor` is read-only: it only records that it ran and answers as told.
  executable(path.join(root, 'bridge/relayd'), '[[ "${1:-}" != doctor ]] || { printf "doctor %s\\n" "$#" >> "$TRACE.doctor"; printf "falta  PTY (node-pty)\\n"; exit "${DOCTOR_EXIT:-0}"; }\nprintf "%s\\0" "$HERMES_HOME" "$HERMES_BIN" "$RELAY_PORT" "$@" > "$TRACE"');
  fs.writeFileSync(path.join(root, 'bridge/src/main.ts'), 'synthetic checkout');
  for (const program of ['tailscale', 'systemctl', 'loginctl', 'hermes', 'sudo', 'touch', 'grep', 'gh']) executable(path.join(bin, program), 'printf "unexpected operation\\n" >&2; exit 93');
  const home = path.join(root, 'Hermes $(touch injected) %h'), hermes = path.join(root, 'hermes cli; $(touch injected)');
  fs.mkdirSync(path.join(home, 'profiles/dev'), { recursive: true }); executable(hermes, 'exit 93');
  const env = { PATH: bin, TRACE: trace, XDG_RUNTIME_DIR: runtime };
  return { root, bin, trace, wizard, home, hermes, env,
    run: (args: string[], override: Record<string, string> = {}) => spawnSync('/bin/bash', [wizard, ...args], { env: { ...env, ...override }, cwd: root, encoding: 'utf8', timeout: 5000 }),
  };
}

test('wizard plan is read-only and shell-quoted public paths preserve exact env/argv when replayed against a fake Puente', t => {
  const f = fixture(t), result = f.run(['--plan', f.home, f.hermes, 'default,dev', '9001']);
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(f.trace), false);
  const replay = spawnSync('/bin/bash', ['-c', result.stdout], { env: f.env, cwd: f.root, encoding: 'utf8', timeout: 5000 });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(fs.readFileSync(f.trace, 'utf8').split('\0'), [f.home, f.hermes, '9001', 'setup', '']);
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
});

test('wizard check calls only the readonly prerequisite checker and doctor, and help works without tools', t => {
  const f = fixture(t); let result = f.run(['--check']);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /checked/); assert.equal(fs.existsSync(f.trace), false);
  assert.equal(fs.readFileSync(`${f.trace}.doctor`, 'utf8'), 'doctor 1\n'); assert.match(result.stdout, /falta {2}PTY/);
  // Missing V3 capabilities are reported, not fatal: the Puente installs without them.
  result = f.run(['--check'], { DOCTOR_EXIT: '1' }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /opcional/);
  result = f.run(['--help'], { PATH: '' }); assert.equal(result.status, 0); assert.match(result.stdout, /--plan/); assert.match(result.stdout, /--supervisor/);
});

test('wizard plan adds only known unique V3 flags, after the Hermes selection, and replays them exactly', t => {
  const f = fixture(t), result = f.run(['--plan', f.home, f.hermes, 'default', '8650', '--supervisor', '--files', '--web', '--browser-habitual']);
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(f.trace), false);
  const replay = spawnSync('/bin/bash', ['-c', result.stdout], { env: f.env, cwd: f.root, encoding: 'utf8', timeout: 5000 });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(fs.readFileSync(f.trace, 'utf8').split('\0'), [f.home, f.hermes, '8650', 'setup', '--supervisor', '--files', '--web', '--browser-habitual', '']);
  for (const extra of [['--now'], ['--files', '--files'], ['--browser-habitual'], ['--restart-supervisor'], ['$(touch injected)']]) {
    const refused = f.run(['--plan', f.home, f.hermes, 'default', '8650', ...extra]);
    assert.notEqual(refused.status, 0, extra.join(' ')); assert.match(refused.stderr, /Error|Uso/);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'injected')), false);
});

test('wizard rejects path escapes, control characters, absent profiles, symlinks and invalid ports before an action', t => {
  const f = fixture(t); fs.symlinkSync(f.home, path.join(f.root, 'alias'));
  for (const [home, bin, profiles, port] of [
    [path.join(f.root, 'alias'), f.hermes, 'default', '8650'],
    [`${f.home}/../other`, f.hermes, 'default', '8650'],
    ['relative', f.hermes, 'default', '8650'],
    [f.home, `${f.hermes}\n`, 'default', '8650'],
    [f.home, `${f.hermes} `, 'default', '8650'],
    [f.home, f.hermes, '../escape', '8650'],
    [f.home, f.hermes, 'missing', '8650'],
    [f.home, f.hermes, 'default', '0'],
    [f.home, f.hermes, 'default', '65536'],
    [f.home, f.hermes, 'default', '$(touch injected)'],
  ]) {
    const result = f.run(['--plan', home, bin, profiles, port]); assert.equal(result.status, 1); assert.match(result.stderr, /Error:/);
  }
  assert.equal(fs.existsSync(f.trace), false);
});

test('wizard refuses unattended execution, excess arguments and missing runtime before any service action', t => {
  const f = fixture(t); let result = f.run([]);
  assert.equal(result.status, 1); assert.match(result.stderr, /terminal interactiva/);
  result = f.run(['--check'], { XDG_RUNTIME_DIR: '' }); assert.equal(result.status, 1); assert.match(result.stderr, /XDG_RUNTIME_DIR/);
  result = f.run(['--help', 'extra']); assert.equal(result.status, 2);
  assert.equal(fs.existsSync(f.trace), false);
});
