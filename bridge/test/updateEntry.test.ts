import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { serveExistingState, startExistingState } from '../update-entry.ts';

const env = { RELAY_HOST: '100.64.0.1', RELAY_PORT: '18650', HERMES_HOME: '/tmp/relay-update-fake-hermes', HERMES_BIN: 'fake-hermes' };
const exec = async (_command: string, args: string[]) => ({ code: 0, stdout: args[0] === 'status' ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'fake.tail.ts.net' } }) : '100.64.0.1\n', stderr: '' });

async function isolated(operation: () => Promise<void>) {
  const before = new Map(['SIGINT', 'SIGTERM'].map(name => [name, new Set(process.rawListeners(name))]));
  try { await operation(); }
  finally { for (const [name, listeners] of before) for (const listener of process.rawListeners(name)) if (!listeners.has(listener)) process.removeListener(name, listener); }
}

test('updated entry preserves existing state directory and configured listener through real serve wiring', async () => {
  await isolated(async () => {
    let captured: any;
    await serveExistingState('/tmp/relay-existing-state-fixture', { env, exec, start: async (options: any) => {
      captured = options;
      return { server: new EventEmitter(), close: async () => {} } as any;
    } });
    assert.equal(captured.directory, '/tmp/relay-existing-state-fixture');
    assert.equal(captured.host, '100.64.0.1');
    assert.equal(captured.port, 18650);
    assert.equal(typeof captured.createHttpApp, 'function');
  });
});

test('startup failure is content free and never falls back to another data directory', async () => {
  await isolated(async () => {
    let attempts = 0; const messages: string[] = [];
    const result = await startExistingState('/tmp/relay-existing-state-fixture', { env, exec, start: async (options: any) => {
      attempts++; assert.equal(options.directory, '/tmp/relay-existing-state-fixture');
      throw new Error('synthetic-private-error-marker');
    } }, message => messages.push(message));
    assert.equal(result, 1);
    assert.equal(attempts, 1);
    assert.deepEqual(messages, ['relayd: service could not start; check configuration and the systemd user session.']);
    assert.equal(messages.join('').includes('synthetic-private-error-marker'), false);
  });
});
