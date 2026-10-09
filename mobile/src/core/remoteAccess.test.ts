import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteAccess, runAdmitted, type AccessCondition } from './remoteAccess.ts';

const up: AccessCondition = { pairing: 'A1', connected: true, revoked: false };

function opened(server = 'A') {
  const access = createRemoteAccess();
  access.setServers({ [server]: up });
  access.setVisible(true);
  const entry = access.beginEntry(server)!;
  assert.equal(entry.finish('verified'), 'verified');
  return access;
}

function probe() {
  const closed: string[] = [];
  return { closed, close: (reason: string) => { closed.push(reason); } };
}

test('entry needs the system verification: unavailable or cancelled stays closed', () => {
  const access = createRemoteAccess();
  access.setServers({ A: up });
  access.setVisible(true);
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.beginEntry('A')!.finish('unavailable'), 'unavailable');
  assert.equal(access.beginEntry('A')!.finish('cancelled'), 'cancelled');
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.admit('A', probe().close), null);
  assert.equal(access.beginEntry('A')!.finish('verified'), 'verified');
  assert.equal(access.snapshot().views.A, 'open');
});

test('one verification per Servidor: it does not open another Servidor', () => {
  const access = opened('A');
  access.setServers({ A: up, B: { ...up, pairing: 'B1' } });
  assert.equal(access.snapshot().views.A, 'open');
  assert.equal(access.snapshot().views.B, 'closed');
  assert.equal(access.admit('B', probe().close), null);
  assert.notEqual(access.admit('A', probe().close), null);
});

test('a second entry while one is verifying is refused', () => {
  const access = createRemoteAccess();
  access.setServers({ A: up });
  const first = access.beginEntry('A')!;
  assert.equal(access.snapshot().views.A, 'verifying');
  assert.equal(access.beginEntry('A'), null);
  first.finish('cancelled');
  assert.notEqual(access.beginEntry('A'), null);
});

test('locking suspends control and voids the verification of every Servidor, without revoking', () => {
  const access = opened('A');
  const tool = probe();
  assert.notEqual(access.admit('A', tool.close), null);
  access.setLocked(true);
  assert.deepEqual(tool.closed, ['suspended']);
  assert.equal(access.snapshot().views.A, 'closed');
  access.setLocked(false);
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.admit('A', probe().close), null);
});

test('a lock in the middle of the entry discards its result, even after unlocking', () => {
  const access = createRemoteAccess();
  access.setServers({ A: up });
  access.setVisible(true);
  const entry = access.beginEntry('A')!;
  access.setLocked(true);
  access.setLocked(false);
  assert.equal(entry.finish('verified'), 'locked');
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.admit('A', probe().close), null);
});

test('no entry starts while Relay is locked', () => {
  const access = createRemoteAccess();
  access.setServers({ A: up });
  access.setLocked(true);
  assert.equal(access.beginEntry('A'), null);
});

test('hiding Relay or losing the connection suspends control but keeps the verification', () => {
  const access = opened('A');
  const hidden = probe();
  access.admit('A', hidden.close);
  access.setVisible(false);
  assert.deepEqual(hidden.closed, ['suspended']);
  assert.equal(access.admit('A', probe().close), null);
  access.setVisible(true);
  const offline = probe();
  assert.notEqual(access.admit('A', offline.close), null);
  access.setServers({ A: { ...up, connected: false } });
  assert.deepEqual(offline.closed, ['suspended']);
  assert.equal(access.snapshot().views.A, 'suspended');
  assert.equal(access.admit('A', probe().close), null);
  access.setServers({ A: up });
  assert.equal(access.snapshot().views.A, 'open');
  assert.notEqual(access.admit('A', probe().close), null);
});

test('a released access is not closed again', () => {
  const access = opened('A');
  const tool = probe();
  const release = access.admit('A', tool.close)!;
  release();
  access.setLocked(true);
  assert.deepEqual(tool.closed, []);
});

test('revocation cuts every access of that Servidor and allows no new work until all are cut', async () => {
  const access = opened('A');
  access.setServers({ A: up, B: { ...up, pairing: 'B1' } });
  access.beginEntry('B')!.finish('verified');
  const other = probe();
  access.admit('B', other.close);
  let finish!: () => void;
  const reasons: string[] = [];
  access.admit('A', (reason) => { reasons.push(reason); return new Promise<void>((resolve) => { finish = resolve; }); });
  access.setServers({ A: { ...up, revoked: true }, B: { ...up, pairing: 'B1' } });
  assert.deepEqual(reasons, ['revoked']);
  assert.deepEqual(other.closed, []);
  assert.equal(access.snapshot().views.A, 'revoked');
  // Paired again and answering, but the old access is still being cut.
  access.setServers({ A: { ...up, pairing: 'A2' }, B: { ...up, pairing: 'B1' } });
  assert.equal(access.snapshot().views.A, 'revoked');
  assert.equal(access.beginEntry('A'), null);
  finish();
  await access.settled();
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.admit('A', probe().close), null);
  assert.equal(access.beginEntry('A')!.finish('verified'), 'verified');
});

test('a close that throws or rejects still counts as cut', async () => {
  const access = opened('A');
  access.admit('A', () => { throw new Error('socket already gone'); });
  access.admit('A', () => Promise.reject(new Error('abort failed')));
  access.setServers({ A: { ...up, revoked: true } });
  access.setServers({ A: { ...up, pairing: 'A2' } });
  await access.settled();
  assert.equal(access.snapshot().views.A, 'closed');
});

test('a new pairing or a removed Servidor is treated as a revocation of the old one', () => {
  const access = opened('A');
  const tool = probe();
  access.admit('A', tool.close);
  access.setServers({ A: { ...up, pairing: 'A2' } });
  assert.deepEqual(tool.closed, ['revoked']);
  const again = opened('A');
  const removed = probe();
  again.admit('A', removed.close);
  again.setServers({});
  assert.deepEqual(removed.closed, ['revoked']);
  assert.equal(again.snapshot().views.A, undefined);
});

test('a revocation in the middle of the entry discards its result', async () => {
  const access = createRemoteAccess();
  access.setServers({ A: up });
  const entry = access.beginEntry('A')!;
  access.setServers({ A: { ...up, revoked: true } });
  access.setServers({ A: up });
  assert.equal(entry.finish('verified'), 'refused');
  await access.settled();
  assert.equal(access.snapshot().views.A, 'closed');
});

test('an entry started before a new pairing stays refused after the cut has settled', async () => {
  const access = createRemoteAccess();
  access.setVisible(true);
  access.setServers({ A: up });
  const entry = access.beginEntry('A')!;
  access.setServers({ A: { ...up, pairing: 'A2' } });
  await access.settled();
  assert.equal(entry.finish('verified'), 'refused');
  assert.equal(access.snapshot().views.A, 'closed');
  assert.equal(access.admit('A', probe().close), null);
});

test('subscribers hear every change and the snapshot is a new object each time', () => {
  const access = createRemoteAccess();
  let heard = 0;
  const stop = access.subscribe(() => { heard++; });
  const before = access.snapshot();
  access.setServers({ A: up });
  assert.notEqual(access.snapshot(), before);
  assert.ok(heard > 0);
  stop();
});

test('admitted work runs only while control is allowed; once its access closes it sends nothing more and its result is dropped', async () => {
  const access = opened();
  const sent: string[] = [];
  const base = () => ({ request: async (_method: string, path: string) => { sent.push(path); return path; } });
  const admit = (close: (reason: 'suspended' | 'revoked') => unknown) => access.admit('A', close);

  assert.deepEqual(await runAdmitted(admit, base, async (client) => client().request('POST', '/one')), { state: 'done', value: '/one' });
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  let aborted = false;
  const late = runAdmitted(admit, base, async (client, signal) => {
    await client().request('POST', '/two');
    signal.addEventListener('abort', () => { aborted = true; });
    await gate;
    return client().request('POST', '/after-the-lock');
  });
  await Promise.resolve();
  access.setLocked(true);
  open();
  assert.deepEqual(await late, { state: 'suspended' });
  assert.equal(aborted, true);
  assert.deepEqual(sent, ['/one', '/two']);

  // Locked: nothing runs at all.
  let ran = false;
  assert.deepEqual(await runAdmitted(admit, base, async () => { ran = true; }), { state: 'refused' });
  assert.equal(ran, false);
});

test('admitted work that a revocation cuts reports the revocation, never its late answer or its error', async () => {
  const access = opened();
  const admit = (close: (reason: 'suspended' | 'revoked') => unknown) => access.admit('A', close);
  for (const outcome of ['answer', 'error'] as const) {
    const { promise: gate, resolve: finish } = Promise.withResolvers<void>();
    const cut = runAdmitted(admit, () => ({}), async () => { await gate; if (outcome === 'error') throw new Error('late'); return 'stale listing'; });
    access.setServers({ A: { ...up, pairing: outcome } });
    finish();
    assert.deepEqual(await cut, { state: 'revoked' }, outcome);
    await access.settled();
    assert.equal(access.beginEntry('A')!.finish('verified'), 'verified');
  }
});
