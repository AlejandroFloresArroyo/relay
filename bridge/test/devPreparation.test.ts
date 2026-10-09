import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';

const source = path.resolve(import.meta.dirname, '../../scripts/prepare-dev.sh');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay dev preparation '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), trace = path.join(root, 'commands.log');
  for (const directory of ['bin', 'scripts', 'bridge', 'mobile', 'elsewhere']) fs.mkdirSync(path.join(root, directory));
  for (const directory of ['bridge', 'mobile']) for (const file of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(root, directory, file), '{}\n');
  const script = path.join(root, 'scripts/prepare-dev.sh');
  if (fs.existsSync(source)) fs.copyFileSync(source, script);
  const command = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  command('uname', 'printf "linux-check\\n" >> "$TRACE"; printf "%s\\n" "${FAKE_OS:-Linux}"');
  command('node', 'if [[ "$1" == --version ]]; then printf "node-version\\n" >> "$TRACE"; printf "%s\\n" "${FAKE_NODE:-v26.10.0}"; else [[ "$1" == -e ]] || exit 94; printf "sqlite-check\\n" >> "$TRACE"; exit "${FAIL_SQLITE:-0}"; fi');
  command('python3', '[[ "$1" == -I && "$2" == -B && "$3" == -c ]] || exit 94; printf "python-check\\n" >> "$TRACE"; exit "${FAIL_PYTHON:-0}"');
  command('npm', '[[ "$#" == 1 && "$1" == ci ]] || exit 91; case "$PWD" in "$FIXTURE_ROOT/bridge") printf "ci:bridge\\n" >> "$TRACE"; exit "${FAIL_BRIDGE:-0}";; "$FIXTURE_ROOT/mobile") printf "ci:mobile\\n" >> "$TRACE"; exit "${FAIL_MOBILE:-0}";; *) exit 92;; esac');
  for (const name of ['sudo', 'hermes', 'tailscale', 'systemctl', 'java', 'npx']) command(name, `printf 'forbidden:${name}\\n' >> "$TRACE"; exit 93`);
  return { root, bin, trace, script,
    run: (args: string[] = [], env: Record<string, string> = {}) => spawnSync('/bin/bash', [script, ...args], {
      cwd: path.join(root, 'elsewhere'), encoding: 'utf8', env: { PATH: bin, TRACE: trace, FIXTURE_ROOT: root, ...env }, timeout: 5000,
    }),
    calls: () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : [],
  };
}

test('checkout preparation verifies prerequisites before bridge/mobile ci and resolves its checkout from another cwd', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['linux-check', 'node-version', 'sqlite-check', 'python-check', 'ci:bridge', 'ci:mobile']);
});

test('--check checks prerequisites without npm or checkout artifacts; help needs no tools', t => {
  const f = fixture(t), before = fs.readdirSync(f.root).sort();
  let result = f.run(['--check']); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['linux-check', 'node-version', 'sqlite-check', 'python-check']);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name !== 'commands.log').sort(), before);
  fs.unlinkSync(f.trace);
  result = f.run(['--help'], { PATH: '' }); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--check/); assert.deepEqual(f.calls(), []);
});

for (const [env, expected, calls] of [
  [{ FAKE_OS: 'Darwin' }, /requiere Linux/, ['linux-check']],
  [{ FAKE_NODE: 'v25.9.0' }, /Node 26/, ['linux-check', 'node-version']],
  [{ FAKE_NODE: 'unexpected output' }, /Node 26/, ['linux-check', 'node-version']],
  [{ FAIL_SQLITE: '1' }, /soporte SQLite/, ['linux-check', 'node-version', 'sqlite-check']],
  [{ FAIL_PYTHON: '1' }, /Python 3.*PyYAML/, ['linux-check', 'node-version', 'sqlite-check', 'python-check']],
] as const) {
  test(`prerequisite failure ${Object.keys(env)[0]} stops before either installation`, t => {
    const f = fixture(t), result = f.run([], env);
    assert.equal(result.status, 1); assert.match(result.stderr, expected); assert.deepEqual(f.calls(), calls);
  });
}

test('missing commands and lockfiles fail clearly before npm; an empty lockfile is not sufficient', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.bin, 'npm'));
  let result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /Falta npm/); assert.deepEqual(f.calls(), []);
  fs.writeFileSync(path.join(f.bin, 'npm'), '#!/bin/bash\nexit 93\n', { mode: 0o755 });
  fs.unlinkSync(path.join(f.root, 'mobile/package-lock.json'));
  result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /mobile\/package-lock.json/);
  assert.ok(f.calls().every(call => !call.startsWith('ci:')));
  fs.writeFileSync(path.join(f.root, 'mobile/package-lock.json'), '');
  result = f.run(['--check']); assert.equal(result.status, 1); assert.match(result.stderr, /mobile\/package-lock.json/);
});

for (const packageName of ['bridge', 'mobile'] as const) {
  test(`npm ci failure in ${packageName} is reported and stops subsequent work`, t => {
    const f = fixture(t), result = f.run([], { [`FAIL_${packageName.toUpperCase()}`]: '7' });
    assert.equal(result.status, 1); assert.match(result.stderr, new RegExp(`Falló npm ci en ${packageName}`));
    assert.doesNotMatch(result.stdout, /Checkout preparado/);
    assert.deepEqual(f.calls(), ['linux-check', 'node-version', 'sqlite-check', 'python-check', 'ci:bridge', ...(packageName === 'mobile' ? ['ci:mobile'] : [])]);
  });
}

test('unknown or excess options return usage failure before checking or installing anything', t => {
  const f = fixture(t);
  for (const args of [['--install'], ['--check', '--help']]) {
    const result = f.run(args); assert.equal(result.status, 2); assert.match(result.stderr, /Uso:/);
  }
  assert.deepEqual(f.calls(), []);
});
