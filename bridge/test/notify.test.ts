import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Approval } from '../../protocol/protocol.ts';
import { createNotifier } from '../src/notify.ts';

const APPROVAL: Approval = {
  id: 'req_a',
  runId: 'run_1',
  agentId: 'coding',
  agentName: 'Coding',
  command: 'rm -rf build/ && curl -H "Authorization: Bearer hunter2hunter2hunter2" x',
  cwd: null,
  reason: null,
  affects: null,
  risk: { level: 3, label: 'RIESGO MEDIO', summary: 'recursive delete' },
  createdAt: 1,
  expiresAt: 2,
  choices: ['once', 'deny'],
};

function fakeFetch(status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response('', { status });
  };
  return { requests, fetchFn: fetchFn as typeof fetch };
}

test('posts one notification to the ntfy topic when an approval is created', async () => {
  const { requests, fetchFn } = fakeFetch();
  const notifier = createNotifier('https://ntfy.example/relay-topic', fetchFn);
  await notifier.approvalCreated(APPROVAL);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ntfy.example/relay-topic');
  assert.equal(requests[0].init.method, 'POST');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.match(headers.Title, /Coding/);
  assert.equal(headers.Priority, 'high');
  const body = String(requests[0].init.body);
  assert.match(body, /recursive delete/);
  assert.match(body, /RIESGO MEDIO/);
});

test('the notification never carries the command: a ntfy topic is not a private channel', async () => {
  const { requests, fetchFn } = fakeFetch();
  await createNotifier('https://ntfy.example/t', fetchFn).approvalCreated(APPROVAL);
  const sent = JSON.stringify([requests[0].init.headers, String(requests[0].init.body)]);
  assert.ok(!sent.includes('rm -rf'));
  assert.ok(!sent.includes('hunter2'));
});

test('header values are ASCII-safe even when the agent name is not', async () => {
  const { requests, fetchFn } = fakeFetch();
  await createNotifier('https://ntfy.example/t', fetchFn).approvalCreated({
    ...APPROVAL,
    agentName: 'Ñandú\r\nX-Injected: 1',
    risk: null,
  });
  const headers = requests[0].init.headers as Record<string, string>;
  for (const value of Object.values(headers)) assert.match(value, /^[\x20-\x7e]*$/);
});

test('rejects when ntfy answers with an error status, so the caller can log it', async () => {
  const { fetchFn } = fakeFetch(500);
  await assert.rejects(createNotifier('https://ntfy.example/t', fetchFn).approvalCreated(APPROVAL), /500/);
});

test('without RELAY_NTFY_URL nothing is sent', async () => {
  const { requests, fetchFn } = fakeFetch();
  await createNotifier(null, fetchFn).approvalCreated(APPROVAL);
  assert.equal(requests.length, 0);
});
