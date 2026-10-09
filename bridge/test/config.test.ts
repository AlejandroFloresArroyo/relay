import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, loadServeConfig } from '../src/config.ts';
import type { Exec } from '../src/exec.ts';
const HOST = '100.64.0.1';
const env = { RELAY_HOST: HOST };
const fake: Exec = async (_file, args) => ({ code: 0, stderr: '', stdout: args[0] === 'status'
  ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'arch.example.ts.net.' } }) : `${HOST}\nfd7a:115c:a1e0::1\n` });
test('configuration neither requires, validates nor retains RELAY_KEY', () => {
  const base = loadConfig(env);
  for (const key of ['', 'x', 'synthetic-legacy-key'.repeat(20)]) {
    assert.deepEqual(loadConfig({ ...env, RELAY_KEY: key }), base); assert.ok(!Object.hasOwn(base, 'key'));
  }
  assert.equal(base.port, 8650); assert.equal(base.host, HOST); assert.deepEqual(base.corsOrigins, []);
  assert.equal(base.hermesBin, 'hermes'); assert.equal(base.ntfyUrl, null);
});
test('configuration reads supported values and reports invalid configuration without echoing input', () => {
  const config = loadConfig({ ...env, RELAY_PORT: '9001', HERMES_HOME: '/srv/hermes', HERMES_BIN: '/opt/hermes',
    RELAY_CORS_ORIGINS: 'http://localhost:8081, https://app.example ,', RELAY_NTFY_URL: 'https://ntfy.example/topic' });
  assert.equal(config.port, 9001); assert.equal(config.hermesHome, '/srv/hermes'); assert.equal(config.hermesBin, '/opt/hermes');
  assert.deepEqual(config.corsOrigins, ['http://localhost:8081', 'https://app.example']); assert.equal(config.ntfyUrl, 'https://ntfy.example/topic');
  for (const value of ['abc', '0', '70000', '80.5', 'synthetic-private-port']) {
    assert.throws(() => loadConfig({ ...env, RELAY_PORT: value }), (error) => error instanceof ConfigError && !error.message.includes(value));
  }
  assert.throws(() => loadConfig({ ...env, RELAY_CORS_ORIGINS: '*' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, RELAY_NTFY_URL: 'file:///private-fixture' }), ConfigError);
});
test('environments are wired only from a canonical supervisor directory', () => {
  assert.equal(loadConfig(env).supervisorDirectory, undefined);
  assert.equal(loadConfig({ ...env, RELAY_SUPERVISOR_DIR: '/run/user/1000/relay-supervisor' }).supervisorDirectory, '/run/user/1000/relay-supervisor');
  for (const value of ['relative/dir', '/', '/run/user/../x', '/run/user/1000/relay-supervisor/', '/run/\nx']) {
    assert.throws(() => loadConfig({ ...env, RELAY_SUPERVISOR_DIR: value }), (error) => error instanceof ConfigError && !error.message.includes(value));
  }
});
test('files are wired only when RELAY_REMOTE_FILES is exactly 1', () => {
  assert.equal(loadConfig(env).remoteFiles, false);
  assert.equal(loadConfig({ ...env, RELAY_REMOTE_FILES: '' }).remoteFiles, false);
  assert.equal(loadConfig({ ...env, RELAY_REMOTE_FILES: '1' }).remoteFiles, true);
  for (const value of ['0', 'true', 'yes', '01', 'synthetic-private-flag']) {
    assert.throws(() => loadConfig({ ...env, RELAY_REMOTE_FILES: value }), (error) => error instanceof ConfigError && !error.message.includes(value));
  }
});
test('web is wired only when RELAY_REMOTE_WEB is exactly 1', () => {
  assert.equal(loadConfig(env).remoteWeb, false);
  assert.equal(loadConfig({ ...env, RELAY_REMOTE_WEB: '' }).remoteWeb, false);
  assert.equal(loadConfig({ ...env, RELAY_REMOTE_WEB: '1' }).remoteWeb, true);
  for (const value of ['0', 'true', 'yes', '01', 'synthetic-private-flag']) {
    assert.throws(() => loadConfig({ ...env, RELAY_REMOTE_WEB: value }), (error) => error instanceof ConfigError && !error.message.includes(value));
  }
});
test('the habitual browser is wired only when RELAY_BROWSER_HABITUAL is exactly 1', () => {
  assert.equal(loadConfig(env).browserHabitual, false);
  assert.equal(loadConfig({ ...env, RELAY_BROWSER_HABITUAL: '1' }).browserHabitual, true);
  for (const value of ['0', 'true', 'synthetic-private-flag']) {
    assert.throws(() => loadConfig({ ...env, RELAY_BROWSER_HABITUAL: value }), (error) => error instanceof ConfigError && !error.message.includes(value));
  }
});
test('production serve rejects absent, non-tailnet and non-local bind addresses without fallback', async () => {
  for (const host of [undefined, '', '127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '192.168.1.1', '100.64.0.2']) {
    await assert.rejects(loadServeConfig({ RELAY_HOST: host }, fake, () => {}), ConfigError);
  }
  assert.equal((await loadServeConfig(env, fake, () => {})).host, HOST);
  assert.equal((await loadServeConfig({ RELAY_HOST: 'FD7A:115C:A1E0:0:0:0:0:1' }, fake, () => {})).host, 'fd7a:115c:a1e0::1');
});
test('serve emits exactly one static legacy warning and fails safely if Tailscale is unavailable', async () => {
  const warnings: string[] = [];
  await loadServeConfig({ ...env, RELAY_KEY: 'synthetic-secret-legacy' }, fake, (line) => warnings.push(line));
  assert.deepEqual(warnings, ['warning: RELAY_KEY is obsolete and ignored; pair each device with relayd pair.']);
  warnings.length = 0; await loadServeConfig(env, fake, (line) => warnings.push(line)); assert.deepEqual(warnings, []);
  for (const exec of [async () => { throw new Error('synthetic-secret-exception'); }, async () => ({ code: 1, stdout: '', stderr: 'synthetic-secret-exception' }),
    async () => ({ code: 0, stdout: '{synthetic-secret-exception', stderr: '' })]) {
    await assert.rejects(loadServeConfig(env, exec, () => {}), (error) => error instanceof ConfigError && !error.message.includes('synthetic-secret-exception'));
  }
});

test('private notifications require one explicit Tailnet origin and never echo invalid values',()=>{
 assert.equal(loadConfig(env).ntfyOrigin,null);
 assert.equal(loadConfig({...env,RELAY_NTFY_ORIGIN:'http://ntfy.fixture.ts.net:8080'}).ntfyOrigin,'http://ntfy.fixture.ts.net:8080');
 for(const origin of ['https://ntfy.sh','http://127.0.0.1:1234','https://ntfy.fixture.ts.net/topic','https://user:synthetic-secret@ntfy.fixture.ts.net','http://ntfy.fixture.ts.net?up=1']){
   assert.throws(()=>loadConfig({...env,RELAY_NTFY_ORIGIN:origin}),error=>error instanceof ConfigError && !error.message.includes(origin));
 }
});
test('APK publication root is optional, explicit, canonical and never echoed in errors', () => {
  assert.equal(loadConfig(env).appUpdateRoot, undefined);
  assert.equal(loadConfig({ ...env, RELAY_APP_UPDATE_ROOT: '/srv/relay-publication' }).appUpdateRoot, '/srv/relay-publication');
  for (const value of ['relative-private-fixture', '/srv/../private-fixture', '/', '/srv/fixture/', '/srv/private\nfixture']) {
    assert.throws(() => loadConfig({ ...env, RELAY_APP_UPDATE_ROOT: value }), error => error instanceof ConfigError && !error.message.includes(value));
  }
});
