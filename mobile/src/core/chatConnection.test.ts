import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelayError } from './client.ts';
import { clearChatTransportError, planChatTranscript, recordChatTransportError, type ChatConnectionState } from './chatConnection.ts';

test('chat reloads a failed generic transcript on shared recovery with unchanged client and pending count', () => {
  const client = {};
  const initial = { client, agentId: 'dev', pendingCount: 0, retry: 0, reachable: null };
  let state: ChatConnectionState = { previous: null, error: null };
  const first = planChatTranscript(state, initial, false);
  assert.equal(first.load, true);
  state = recordChatTransportError(first.state, new RelayError('timeout', 'synthetic'));
  const offline = planChatTranscript(state, { ...initial, reachable: false }, false);
  assert.equal(offline.load, false);
  const recovered = planChatTranscript(offline.state, { ...initial, reachable: true }, false);
  assert.equal(recovered.load, true);
  const loaded = clearChatTransportError(recovered.state);
  assert.equal(loaded.error, null);
  assert.equal(planChatTranscript(loaded, { ...initial, reachable: true }, false).load, false);
});

test('chat keeps auth and rate-limit failures suspended across recovery and inbox changes', () => {
  for (const code of ['unauthorized', 'key_unknown', 'device_revoked', 'pairing_required', 'rate_limited'] as const) {
    const context = { client: {}, agentId: 'dev', pendingCount: 0, retry: 0, reachable: false };
    const failed = recordChatTransportError({ previous: context, error: null }, new RelayError(code, 'synthetic'));
    const recovered = planChatTranscript(failed, { ...context, reachable: true }, false);
    assert.equal(recovered.load, false, code);
    const inboxChanged = planChatTranscript(recovered.state, { ...context, reachable: true, pendingCount: 1 }, false);
    assert.equal(inboxChanged.load, false, code);
    assert.equal(planChatTranscript(inboxChanged.state, { ...context, reachable: true, retry: 1 }, false).load, true, code);
    assert.equal(planChatTranscript(inboxChanged.state, { ...context, client: {}, reachable: true }, false).load, true, code);
  }
});

test('chat does not reload over a running Turno or reload a successful transcript on recovery', () => {
  const context = { client: {}, agentId: 'dev', pendingCount: 0, retry: 0, reachable: false };
  const state = recordChatTransportError({ previous: context, error: null }, new RelayError('timeout', 'synthetic'));
  assert.equal(planChatTranscript(state, { ...context, reachable: true }, true).load, false);
  assert.equal(planChatTranscript(clearChatTransportError(state), { ...context, reachable: true }, false).load, false);
  assert.equal(planChatTranscript(clearChatTransportError(state), { ...context, pendingCount: 1 }, false).load, true);
});
