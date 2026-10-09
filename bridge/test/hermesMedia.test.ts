import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realExec } from '../src/exec.ts';
import { test, type TestContext } from 'node:test';
import { RealHermes } from '../src/hermes_real.ts';
import { HermesError } from '../src/hermes.ts';
import type { ExecOptions } from '../src/exec.ts';
import { createHermesHome } from '../support/hermes_home.ts';

test('the media adapter uses an isolated Python argument vector and explicit profile, only assistant transcript text, and typed output', async (t) => {
  const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  const calls: { program: string; args: string[]; options: ExecOptions }[] = [];
  const hermes = new RealHermes({ home: fixture.home, bin: '/fixture/hermes', mediaSource: '/fixture/source', mediaPython: '/fixture/python', exec: async (program, args, options) => {
    calls.push({ program, args, options });
    const request = JSON.parse(options.input!);
    if (request.operation === 'extract') return { code: 0, stdout: JSON.stringify([{ messageId: 'a1', path: '/fixture/report.md' }]), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ path: '/fixture/report.md', name: 'report.md', mimeType: 'text/markdown', size: 10, identity: { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' } }), stderr: '' };
  } });
  hermes.transcript = async () => ({ sessionId: 'history', items: [{ kind: 'user', id: 'u1', text: 'MEDIA:/private/user.txt', at: 0 }, { kind: 'assistant', id: 'a1', text: 'MEDIA:/fixture/report.md', at: 0 }] });
  assert.deepEqual(await hermes.media.announcements('coding', 'history'), [{ messageId: 'a1', path: '/fixture/report.md' }]);
  const validated = await hermes.media.validate('coding', '/fixture/report.md'); assert.equal(validated.name, 'report.md');
  assert.equal(calls[0].program, '/fixture/python'); assert.deepEqual(calls[0].args.slice(0, 2), ['-I', '-B']);
  assert.equal(calls[0].args.at(-1), fixture.home + '/profiles/coding');
  assert.deepEqual(JSON.parse(calls[0].options.input!), { operation: 'extract', messages: [{ id: 'a1', text: 'MEDIA:/fixture/report.md' }] });
  assert.equal(calls[0].options.env?.HERMES_HOME, fixture.home + '/profiles/coding');
});

test('missing or incompatible media adapter never returns raw process output or serves a fallback policy', async (t) => {
  const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  const hermes = new RealHermes({ home: fixture.home, bin: '/fixture/hermes', exec: async () => ({ code: 1, stdout: 'private-key', stderr: 'private-path' }) });
  await assert.rejects(hermes.media.validate('default', '/fixture/report.md'), (error: unknown) => error instanceof HermesError && error.code === 'chat_unavailable' && !/private-key|private-path/.test(error.message));
});

test('malformed adapter metadata and message IDs outside the assistant transcript fail closed', async (t) => {
  const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  const valid = { path: '/fixture/report.md', name: 'report.md', mimeType: 'text/markdown', size: 10, identity: { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' } };
  for (const payload of [{ ...valid, name: '../private-key' }, { ...valid, mimeType: 'text/plain\r\nX-Private: key' }, { ...valid, size: -1 }, { ...valid, identity: {} }, [{ messageId: 'user-message', path: '/private-key' }]]) {
    const hermes = new RealHermes({ home: fixture.home, bin: '/fixture/hermes', exec: async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' }) });
    hermes.transcript = async () => ({ sessionId: 'history', items: [{ kind: 'assistant', id: 'a1', text: 'MEDIA:/fixture/report.md', at: 0 }] });
    const operation = Array.isArray(payload) ? hermes.media.announcements('default', 'history') : hermes.media.validate('default', '/fixture/report.md');
    await assert.rejects(operation, (failure: unknown) => failure instanceof HermesError && failure.code === 'chat_unavailable' && !/private-key|X-Private/.test(failure.message));
  }
});

test('only previously extracted media survive policy filtering while exact assistant text and Conversation scope remain unchanged', async (t) => {
  const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  let output: unknown[] = [{ messageId: 'a1', path: '/fixture/script.py', displayText: 'Generated script.' }];
  let text = 'Generated script. MEDIA:/fixture/script.py'; let present = true;
  const hermes = new RealHermes({ home: fixture.home, bin: '/fixture/hermes', exec: async () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' }) });
  hermes.transcript = async () => ({ sessionId: 'history', items: present ? [{ kind: 'assistant', id: 'a1', text, at: 0 }] : [] });
  const first = await hermes.media.announcements('default', 'history'); assert.equal(first[0].path, '/fixture/script.py');
  output = []; assert.deepEqual(await hermes.media.announcements('default', 'history'), first);
  assert.deepEqual(await hermes.media.announcements('default', 'other-conversation'), []);
  assert.deepEqual(await hermes.media.announcements('coding', 'history'), []);
  text += ' Changed'; assert.deepEqual(await hermes.media.announcements('default', 'history'), []);
  output = [{ messageId: 'a1', path: '/fixture/script.py', displayText: 'Generated script.' }]; await hermes.media.announcements('default', 'history');
  output = []; present = false; assert.deepEqual(await hermes.media.announcements('default', 'history'), []);
  present = true; assert.deepEqual(await hermes.media.announcements('default', 'history'), []);
});

async function officialProbe(t: TestContext) {
  const fixture = createHermesHome(); t.after(() => fixture.cleanup());
  const home = path.join(fixture.home, 'official-media'); await fs.mkdir(home);
  const artifact = path.join(home, 'report.md'); await fs.writeFile(artifact, 'Actual artifact bytes');
  await fs.writeFile(path.join(home, 'config.yaml'), '{}');
  await fs.writeFile(path.join(home, 'SOUL.md'), 'Unchanged identity');
  const harness = path.join(fixture.home, 'probe.py');
  await fs.writeFile(harness, `import importlib.abc, importlib.util, json, os, pathlib, sys, types
adapter, source, home, mode = sys.argv[1:]
sys.argv = [adapter, source, home]; sys.prefix = '/fixture/venv'
os.environ.clear(); os.environ.update({'HOME': home + '/user', 'HERMES_HOME': home, 'HERMES_MANAGED_DIR': home + '/managed'})
class ForbiddenImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(('hermes_cli', 'gateway.config', 'gateway.session', 'tools.terminal', 'credential_pool')):
            raise RuntimeError('Initializing dependency was imported')
sys.meta_path.insert(0, ForbiddenImports())
yaml = types.ModuleType('yaml'); yaml.safe_load = json.loads; sys.modules['yaml'] = yaml
spec = importlib.util.spec_from_file_location('relay_media_fixture', adapter); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
manifest = json.loads(pathlib.Path(source, 'manifest.json').read_text())
module.EXPECTED = {name: record['fixtureSha256'] for name, record in manifest['files'].items()}
if mode == 'changed-source':
    read_bytes = pathlib.Path.read_bytes
    base_reads = 0
    def raced_read(path, *args, **kwargs):
        global base_reads
        content = read_bytes(path, *args, **kwargs)
        if path == pathlib.Path(source, 'gateway/platforms/base.py'):
            base_reads += 1
            # Integrity sees the original bytes; only a later source read swaps the policy.
            if base_reads > 1:
                original = b'    candidate = _normalize_media_tag_path(path)'
                assert original in content
                content = content.replace(original, b'    return path\\n' + original, 1)
        return content
    pathlib.Path.read_bytes = raced_read
if mode == 'incompatible':
    module.EXPECTED['gateway/platforms/base.py'] = '0' * 64
if mode in ('write', 'chmod', 'env-read'):
    original = module.load_media_functions
    def load(source, config):
        extract, validate = original(source, config)
        def guarded(text):
            try:
                if mode == 'write':
                    pathlib.Path(home, 'transitive-write').write_text('Forbidden mutation')
                elif mode == 'chmod':
                    os.chmod(home, 0o700)
                else:
                    pathlib.Path(home, '.env').read_text()
            except Exception:
                pass
            return extract(text)
        return guarded, validate
    module.load_media_functions = load
module.main()
`);
  const adapter = fileURLToPath(new URL('../src/hermes_media.py', import.meta.url));
  const source = fileURLToPath(new URL('./fixtures/hermes-media/', import.meta.url));
  return { home, artifact, invoke: async (input: unknown, mode = 'safe') => {
    // Backstop only: the probe must exit on its own; python startup has taken over 5 s on a loaded
    // machine, and production gives the adapter 10 s (hermesMedia.ts).
    const result = await realExec('python3', ['-I', '-B', harness, adapter, source, home, mode], { timeoutMs: 10_000, input: JSON.stringify(input) });
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); return JSON.parse(result.stdout);
  } };
}

test('pinned official media functions extract and validate a host artifact without importing the gateway stack', async (t) => {
  const { artifact, invoke } = await officialProbe(t);
  const extraction = await invoke({ operation: 'extract', messages: [{ id: 'a1', text: `Generated report. MEDIA:${artifact}` }] });
  assert.deepEqual(extraction, [{ messageId: 'a1', path: artifact, displayText: 'Generated report.' }]);
  const validated = await invoke({ operation: 'validate', path: artifact });
  assert.equal(validated.path, artifact); assert.equal(validated.name, 'report.md'); assert.equal(validated.size, 21);
});

test('official extraction preserves protected examples and accepts lowercase tags and existing unknown extensions', async (t) => {
  const { home, artifact, invoke } = await officialProbe(t);
  const script = path.join(home, 'generated.py'); await fs.writeFile(script, 'print(1)');
  const message = `Report. media:${artifact}\nScript. MEDIA:${script}\n\n\`\`\`text\nMEDIA:/fixture/example.md\n\`\`\`\n> MEDIA:/fixture/quoted.md\n{"result": "MEDIA:/fixture/json.md"}`;
  const extraction = await invoke({ operation: 'extract', messages: [{ id: 'a1', text: message }] });
  assert.deepEqual(extraction.map((entry: { path: string }) => entry.path), [artifact, script]);
  assert.ok(extraction[0].displayText.includes('MEDIA:/fixture/example.md'));
  assert.ok(extraction[0].displayText.includes('MEDIA:/fixture/quoted.md'));
  assert.ok(extraction[0].displayText.includes('MEDIA:/fixture/json.md'));
});

test('official strict policy blocks ordinary files, permits its allowlist and cache, and uses the managed profile policy', async (t) => {
  const { home, artifact, invoke } = await officialProbe(t);
  await fs.writeFile(path.join(home, 'config.yaml'), JSON.stringify({ gateway: { strict: true, trust_recent_files: false } }));
  assert.deepEqual(await invoke({ operation: 'validate', path: artifact }), { error: 'blocked' });
  const cache = path.join(home, 'cache', 'documents'); await fs.mkdir(cache, { recursive: true });
  const cached = path.join(cache, 'report.md'); await fs.writeFile(cached, 'Cache artifact');
  assert.equal((await invoke({ operation: 'validate', path: cached })).path, cached);
  await fs.writeFile(path.join(home, 'config.yaml'), JSON.stringify({ gateway: { strict: true, trust_recent_files: false, media_delivery_allow_dirs: [home] } }));
  assert.equal((await invoke({ operation: 'validate', path: artifact })).path, artifact);
  await fs.mkdir(path.join(home, 'managed'));
  await fs.writeFile(path.join(home, 'managed', 'config.yaml'), JSON.stringify({ gateway: { strict: true, trust_recent_files: false, media_delivery_allow_dirs: [] } }));
  assert.deepEqual(await invoke({ operation: 'validate', path: artifact }), { error: 'blocked' });
});

test('official default policy blocks credential stores and missing files without weakening Docker rejection', async (t) => {
  const { home, artifact, invoke } = await officialProbe(t);
  assert.deepEqual(await invoke({ operation: 'validate', path: path.join(home, 'config.yaml') }), { error: 'blocked' });
  assert.deepEqual(await invoke({ operation: 'validate', path: path.join(home, 'missing.md') }), { error: 'missing' });
  await fs.writeFile(path.join(home, 'config.yaml'), JSON.stringify({ terminal: { backend: 'docker' } }));
  assert.deepEqual(await invoke({ operation: 'validate', path: artifact }), { error: 'unavailable' });
});

test('forbidden transitive operations fail closed even when a dependency suppresses the exception, leaving the profile unchanged', async (t) => {
  const { home, artifact, invoke } = await officialProbe(t);
  const entries = await fs.readdir(home); const mode = (await fs.stat(home)).mode;
  for (const attempt of ['write', 'chmod', 'env-read', 'incompatible']) {
    assert.deepEqual(await invoke({ operation: 'extract', messages: [{ id: 'a1', text: `MEDIA:${artifact}` }] }, attempt), { error: 'unavailable' });
    assert.deepEqual(await fs.readdir(home), entries); assert.equal((await fs.stat(home)).mode, mode);
    assert.equal(await fs.readFile(path.join(home, 'SOUL.md'), 'utf8'), 'Unchanged identity');
  }
});

test('source content changing after integrity verification cannot replace the validated policy', async (t) => {
  const { home, invoke } = await officialProbe(t);
  assert.deepEqual(await invoke({ operation: 'validate', path: path.join(home, 'config.yaml') }, 'changed-source'), { error: 'blocked' });
});
