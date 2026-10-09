import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createHermesAgentTools } from '../src/hermesAgentTools.ts';
import { realExec } from '../src/exec.ts';
import { AuthorizationError } from '../src/auth.ts';

const catalog = { object: 'list', platform: 'api_server', data: [
  { name: 'terminal', label: 'Terminal', description: 'Run commands', enabled: true, configured: true, tools: ['terminal'] },
  { name: 'web', label: 'Web', description: 'Search', enabled: false, configured: true, tools: ['web_search'] },
  { name: 'browser', label: 'Browser', description: 'Browse', enabled: false, configured: false, tools: ['browser_navigate'] },
] };
async function fixture(t: TestContext, raw: string) {
  const directory = await fs.mkdtemp(path.resolve('tools-fixture-') + '.log-');
  // Fixture directory is removed even when an assertion fails.
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'profile'); const backupDirectory = path.join(directory, 'backups');
  await fs.mkdir(home); await fs.mkdir(backupDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(home, 'config.yaml'), raw);
  const calls: string[] = [];
  const tools = createHermesAgentTools({ profileHome: () => home, python: 'python3', exec: realExec, toolsets: async () => structuredClone(catalog) });
  return { tools, home, backupDirectory, calls, context: { backupDirectory, guard() {}, async beforeWrite() {
    assert.equal(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'), raw);
    const backups = await fs.readdir(backupDirectory); assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(backupDirectory, backups[0]), 'utf8'), raw);
    calls.push('audit');
  } } };
}

test('canonical catalog and api_server-only change preserve raw other channels and back up before audit/write', async (t) => {
  const raw = '# keep comment\nagent:\n  disabled_toolsets: [image]\nplatform_toolsets:\n  discord: [terminal, web]\n  cli: [hermes-cli]\n  api_server: [terminal, no_mcp]\nmodel: untouched\n';
  const f = await fixture(t, raw);
  const reading = await f.tools.tools('default');
  assert.equal(reading.platform, 'api_server');
  assert.equal(reading.appliesTo, 'next_turn');
  assert.deepEqual(reading.toolsets, catalog.data);
  const saved = await f.tools.setToolset('default', 'terminal', false, f.context);
  assert.equal(saved.appliesTo, 'next_turn');
  assert.equal(saved.platform, 'api_server');
  const changed = await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8');
  assert.match(changed, /discord: \[terminal, web\]/); assert.match(changed, /cli: \[hermes-cli\]/);
  assert.match(changed, /disabled_toolsets: \[image\]/); assert.match(changed, /# keep comment/);
  assert.match(changed, /api_server: \["no_mcp"\]/); assert.equal(f.calls.length, 1);
});

test('unconfigured, global restrictions, unknown names, custom composites and audit failures never write', async (t) => {
  for (const [raw, name, enabled] of [
    ['model: x\n', 'browser', true],
    ['agent:\n  disabled_toolsets: [web]\n', 'web', true],
    ['model: x\n', 'invented', false],
    ['platform_toolsets:\n  api_server: [custom-bundle]\n', 'terminal', false],
  ] as const) {
    const f = await fixture(t, raw);
    await assert.rejects(f.tools.setToolset('default', name, enabled, f.context));
    assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), raw);
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t, 'model: x\n');
  await assert.rejects(f.tools.setToolset('default', 'terminal', false, { ...f.context, beforeWrite: async () => { throw new Error('private fixture error'); } }), /No se pudieron/);
  assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), 'model: x\n');
  assert.equal((await fs.readdir(f.backupDirectory)).length, 1);
});

test('first edit expands the canonical enabled list and records known sets without changing global or other channels', async (t) => {
  const f = await fixture(t, 'platform_toolsets: {discord: [terminal], cli: [web]}\n');
  await f.tools.setToolset('default', 'web', true, f.context);
  const raw = await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8');
  assert.match(raw, /"api_server": \["terminal", "web"\]/);
  assert.match(raw, /known_builtin_toolsets/); assert.match(raw, /known_plugin_toolsets/);
  assert.doesNotMatch(raw, /disabled_toolsets/);
});

test('config symlinks, ancestor symlinks, duplicate YAML keys and aliases fail closed without exposing raw content', async (t) => {
  const f = await fixture(t, 'model: x\n');
  const file = path.join(f.home, 'config.yaml');
  await fs.rename(file, path.join(f.home, 'original'));
  await fs.symlink('original', file);
  await assert.rejects(f.tools.setToolset('default', 'terminal', false, f.context), /No se pudieron/);
  await fs.unlink(file);
  for (const raw of ['private: &secret [sensitive]\nagent: *secret\n', 'model: sensitive\nmodel: secret\n', 'model: ' + 'a'.repeat(1_048_576)]) {
    await fs.writeFile(file, raw);
    await assert.rejects(f.tools.setToolset('default', 'terminal', false, f.context), /No se pudieron/);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  assert.equal((await fs.readdir(f.backupDirectory)).length, 0);
  await fs.rename(f.home, f.home + '-real'); await fs.symlink(f.home + '-real', f.home);
  await assert.rejects(f.tools.skills('default'), /No se pudieron/);
});

test('skills metadata is bounded, read only, never follows links, and does not invent runtime availability', async (t) => {
  const f = await fixture(t, 'skills:\n  disabled: [review-pr]\n');
  const root = path.join(f.home, 'skills'); await fs.mkdir(path.join(root, 'development', 'review-pr'), { recursive: true });
  await fs.writeFile(path.join(root, 'development', 'review-pr', 'SKILL.md'), '---\nname: review-pr\ndescription: |\n  Reviews changes\n  With context\n---\nPrivate instructions never delivered\n');
  await fs.mkdir(path.join(root, 'other'));
  await fs.writeFile(path.join(root, 'other', 'SKILL.md'), '---\nname: other\ndescription: Installed\n---\n');
  await fs.mkdir(path.join(root, 'too-large'));
  await fs.writeFile(path.join(root, 'too-large', 'SKILL.md'), 'a'.repeat(65_537));
  await fs.symlink(path.join(root, 'other'), path.join(root, 'symlink'));
  const before = await fs.readdir(f.home);
  const result = await f.tools.skills('default');
  assert.deepEqual(result.skills, [
    { name: 'other', description: 'Installed', category: null, availability: 'unknown' },
    { name: 'review-pr', description: 'Reviews changes\nWith context\n', category: 'development', availability: 'disabled' },
  ]);
  assert.equal(result.limited, true); assert.equal(result.scope, 'profile_installed');
  assert.doesNotMatch(JSON.stringify(result), /Private instructions/);
  assert.deepEqual(await fs.readdir(f.home), before); assert.equal((await fs.readdir(f.backupDirectory)).length, 0);
});

test('missing skills directory remains missing', async (t) => {
  const f = await fixture(t, 'model: x\n');
  assert.deepEqual((await f.tools.skills('default')).skills, []);
  assert.deepEqual(await fs.readdir(f.home), ['config.yaml']);
});

test('an unrelated canonical global restriction is preserved when enabling', async (t) => {
  const raw = 'agent:\n  disabled_toolsets: [terminal]\n';
  const f = await fixture(t, raw);
  await f.tools.setToolset('default', 'web', true, f.context);
  assert.match(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), /disabled_toolsets: \[terminal\]/);
});

test('block YAML lists, null sections, known other channels and nondefault context engine survive the write', async (t) => {
  const raw = 'platform_toolsets:\n  api_server:\n    - terminal\n  discord: [web]\nknown_builtin_toolsets:\n  cli: [file]\nknown_plugin_toolsets: null\ncontext:\n  engine: custom\n';
  const f = await fixture(t, raw);
  await f.tools.setToolset('default', 'terminal', false, f.context);
  const changed = await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8');
  assert.match(changed, /api_server:\s*\["context_engine"\]/);
  assert.match(changed, /discord: \[web\]/); assert.match(changed, /cli: \[file\]/);
});

test('guard invalidation after audit never writes the profile', async (t) => {
  const raw = 'model: x\n'; const f = await fixture(t, raw);
  let revoked = false;
  await assert.rejects(f.tools.setToolset('default', 'terminal', false, { ...f.context,
    guard() { if (revoked) throw new Error('revoked'); },
    async beforeWrite() { await f.context.beforeWrite(); revoked = true; },
  }));
  assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), raw);
});

test('Hermes scalar disabled names are respected without rewriting their raw form', async (t) => {
  const raw = 'agent:\n  disabled_toolsets: web\nskills:\n  disabled: review-pr\n';
  const f = await fixture(t, raw);
  await assert.rejects(f.tools.setToolset('default', 'web', true, f.context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool_global_restriction');
  await fs.mkdir(path.join(f.home, 'skills', 'review-pr'), { recursive: true });
  await fs.writeFile(path.join(f.home, 'skills', 'review-pr', 'SKILL.md'), '---\nname: review-pr\ndescription: Review\n---\n');
  assert.equal((await f.tools.skills('default')).skills[0].availability, 'disabled');
  assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), raw);
});


test('revocation during the final config read prevents replacement and removes the staged file', async (t) => {
  const raw = 'model: fixture\n';
  const f = await fixture(t, raw);
  let revoked = false, intercepted = false;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const pendingRead = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (!intercepted && String(args[0]).endsWith('/config.yaml')
      && (await fs.readdir(f.home)).some((name) => name.startsWith('.relay-tools-'))) {
      intercepted = true;
      // Keep real descriptor traversal and reading; delay only the filesystem boundary.
      entered(); await pendingRead;
    }
    return handle;
  });
  const result = f.tools.setToolset('default', 'terminal', false, {
    ...f.context,
    guard() { if (revoked) throw new AuthorizationError('device_revoked'); },
  }).then(() => null, (error: unknown) => error);
  await reading;
  revoked = true; release();
  const error = await result;
  assert.equal(await fs.readFile(path.join(f.home, 'config.yaml'), 'utf8'), raw,
    'A revoked device must not replace the profile after the final config read');
  assert.ok(error instanceof AuthorizationError);
  assert.equal(error.code, 'device_revoked');
  assert.deepEqual(await fs.readdir(f.home), ['config.yaml']);
  assert.deepEqual(f.calls, ['audit']);
  const backups = await fs.readdir(f.backupDirectory);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.backupDirectory, backups[0]), 'utf8'), raw);
});
