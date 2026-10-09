import assert from 'node:assert/strict';
import { test } from 'node:test';

import { idleLockCountdown, lockAtLaunch, lockReduce, createLockGate, configureLockGate, lockGateEvent, lockGateView, lockGateReducer } from './lock.ts';

test('the app starts locked only when the lock is enabled at launch', () => {
  assert.deepEqual(lockAtLaunch(true), { locked: true, leftAt: null });
  assert.deepEqual(lockAtLaunch(false), { locked: false, leftAt: null });
});

test('a successful unlock opens the app', () => {
  const r = lockReduce(lockAtLaunch(true), { type: 'unlocked' });
  assert.deepEqual(r, { state: { locked: false, leftAt: null }, prompt: false });
});

test('coming back after the auto-lock window locks and prompts; sooner does not', () => {
  const open = { locked: false, leftAt: null };
  const away = lockReduce(open, { type: 'background', now: 1000 }).state;
  assert.equal(away.leftAt, 1000);

  const soon = lockReduce(away, { type: 'foreground', now: 1000 + 60_000 - 1, enabled: true, delayMs: 60_000 });
  assert.deepEqual(soon, { state: { locked: false, leftAt: null }, prompt: false });

  const late = lockReduce(away, { type: 'foreground', now: 1000 + 60_000, enabled: true, delayMs: 60_000 });
  assert.deepEqual(late, { state: { locked: true, leftAt: null }, prompt: true });
});

test('a long absence does not lock when the lock is disabled', () => {
  const away = lockReduce({ locked: false, leftAt: null }, { type: 'background', now: 0 }).state;
  const back = lockReduce(away, { type: 'foreground', now: 10 * 60_000, enabled: false, delayMs: 60_000 });
  assert.deepEqual(back, { state: { locked: false, leftAt: null }, prompt: false });
});

test('an app that is still locked stays locked across a short trip to the background', () => {
  // Cancelling the launch prompt, pressing Home and coming straight back must not open the app.
  const away = lockReduce(lockAtLaunch(true), { type: 'background', now: 0 }).state;
  const back = lockReduce(away, { type: 'foreground', now: 5_000, enabled: true, delayMs: 60_000 });
  assert.deepEqual(back, { state: { locked: true, leftAt: null }, prompt: false });
});

test('a foreground event without a prior background changes nothing', () => {
  for (const delayMs of [0, 60_000, 300_000, 900_000]) {
    const r = lockReduce(lockAtLaunch(false), { type: 'foreground', now: 1_000_000, enabled: true, delayMs });
    assert.deepEqual(r, { state: { locked: false, leftAt: null }, prompt: false });
  }
});

test('the idle notice counts down in the final eight seconds and activity resets it', () => {
  assert.equal(idleLockCountdown(1000, 52_999, 60_000, true), null);
  assert.equal(idleLockCountdown(1000, 53_000, 60_000, true), 8);
  assert.equal(idleLockCountdown(1000, 60_999, 60_000, true), 1);
  assert.equal(idleLockCountdown(1000, 61_000, 60_000, true), 0);
  assert.equal(idleLockCountdown(53_000, 53_001, 60_000, true), null);
  assert.equal(idleLockCountdown(1000, 61_000, 60_000, false), null);
  assert.equal(idleLockCountdown(1000, 61_000, 0, true), null);
});

test('an idle timeout locks without a biometric prompt; a disabled lock stays open', () => {
  assert.deepEqual(lockReduce(lockAtLaunch(false), { type: 'idle', enabled: true }), { state: { locked: true, leftAt: null }, prompt: false });
  assert.deepEqual(lockReduce(lockAtLaunch(false), { type: 'idle', enabled: false }), { state: { locked: false, leftAt: null }, prompt: false });
});

for (const [label, delayMs] of [['AHORA', 0], ['1 MIN', 60_000], ['5 MIN', 300_000], ['15 MIN', 900_000]] as const) {
  test(`${label}: returning at the selected delay locks, including zero elapsed milliseconds`, () => {
    const away = lockReduce(lockAtLaunch(false), { type: 'background', now: 1000 }).state;
    if (delayMs > 0) {
      assert.deepEqual(lockReduce(away, { type: 'foreground', now: 1000 + delayMs - 1, enabled: true, delayMs }),
        { state: { locked: false, leftAt: null }, prompt: false });
    }
    assert.deepEqual(lockReduce(away, { type: 'foreground', now: 1000 + delayMs, enabled: true, delayMs }),
      { state: { locked: true, leftAt: null }, prompt: true });
    assert.deepEqual(lockReduce(away, { type: 'foreground', now: 1000 + delayMs, enabled: false, delayMs }),
      { state: { locked: false, leftAt: null }, prompt: false });
  });
}

for (const delayMs of [0, 60_000, 300_000, 900_000]) {
  test(`gate uses the current selected ${delayMs}ms delay on AppState return`, () => {
    let gate = createLockGate({ enabled: false, delayMs: 60_000 });
    gate = configureLockGate(gate, { enabled: true, delayMs });
    const away = lockGateEvent(gate, { type: 'background', now: 1000 }).state;
    if (delayMs > 0) assert.equal(lockGateEvent(away, { type: 'foreground', now: 1000 + delayMs - 1 }).prompt, false);
    const back = lockGateEvent(away, { type: 'foreground', now: 1000 + delayMs });
    assert.equal(back.prompt, true);
    assert.deepEqual(lockGateView(back.state, false), {
      showLock: true, contentProps: { style: { flex: 1, display: 'none' }, importantForAccessibility: 'no-hide-descendants' },
    });
  });
}

test('first server saved mid-session enables future locking without locking or prompting now', () => {
  const gate = configureLockGate(createLockGate({ enabled: false, delayMs: 60_000 }), { enabled: true, delayMs: 300_000 });
  assert.equal(gate.atLaunch, false);
  assert.equal(gate.lock.locked, false);
  assert.equal(lockGateEvent(gate, { type: 'foreground', now: 1000 }).prompt, false);
  assert.equal(lockGateView(gate, false).contentProps.style.display, 'flex');
  const coldStart = createLockGate({ enabled: true, delayMs: 300_000 });
  assert.equal(coldStart.atLaunch, true);
  assert.equal(lockGateView(coldStart, false).showLock, true);
  assert.equal(lockGateView(configureLockGate(coldStart, { enabled: false, delayMs: 300_000 }), false).showLock, false);
  assert.equal(lockGateView(gate, true).contentProps.style.display, 'none');
});

test('gate reducer owns launch prompt, selected delay and hidden content without resetting on configuration', () => {
  let gate = createLockGate({ enabled: false, delayMs: 60_000 }, 1000);
  gate = lockGateReducer(gate, { type: 'configured', enabled: true, delayMs: 300_000 });
  assert.equal(gate.prompt, false);
  assert.equal(lockGateView(gate, false).showLock, false);
  const cold = createLockGate({ enabled: true, delayMs: 60_000 }, 1000);
  assert.equal(cold.prompt, true);
  const prompted = lockGateReducer(cold, { type: 'prompted' });
  assert.equal(prompted.prompt, false);
  assert.equal(lockGateReducer(prompted, { type: 'configured', enabled: true, delayMs: 900_000 }).prompt, false);
  gate = lockGateReducer(gate, { type: 'background', now: 2000 });
  const soon = lockGateReducer(gate, { type: 'foreground', now: 301_999 });
  assert.equal(soon.prompt, false);
  assert.equal(lockGateView(soon, false).contentProps.style.display, 'flex');
  const late = lockGateReducer(gate, { type: 'foreground', now: 302_000 });
  assert.equal(late.prompt, true);
  assert.equal(late.lockedAt, 302_000);
  assert.equal(late.reason, 'AL SALIR DE LA APP');
  assert.equal(lockGateView(late, false).contentProps.style.display, 'none');
  const unlocked = lockGateReducer(late, { type: 'unlocked' });
  assert.equal(unlocked.prompt, false);
  assert.equal(lockGateView(unlocked, false).contentProps.style.display, 'flex');
});
