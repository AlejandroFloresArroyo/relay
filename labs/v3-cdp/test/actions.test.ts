// The bounded action protocol is the only thing the phone may ask of a Server browser.
// These tests pin what it accepts, what it refuses and which CDP calls each action becomes.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, validateAction, perform } from '../extension/actions.js';

// Params are whatever plain JSON object perform built; the tests read their fields directly.
type Params = Record<string, any>;

function recorder(replies: Record<string, unknown> = {}) {
  const calls: [string, Params][] = [];
  const send = async (method: string, params: Params) => {
    calls.push([method, params]);
    return replies[method] ?? {};
  };
  return { calls, send };
}

test('refuses raw CDP and unknown action types', () => {
  for (const bad of [
    { type: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' } },
    { method: 'Page.navigate', params: { url: 'https://x' } },
    { type: 'evaluate', expression: 'document.cookie' },
    { type: 'Browser.close' },
    null,
    'navigate',
  ]) {
    assert.throws(() => validateAction(bad), /invalid action/, JSON.stringify(bad));
  }
});

test('navigate only accepts http(s) URLs within the length limit', () => {
  assert.deepEqual(validateAction({ type: 'navigate', url: 'http://127.0.0.1:3000/a' }), {
    type: 'navigate',
    url: 'http://127.0.0.1:3000/a',
  });
  for (const url of [
    'chrome://settings',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'devtools://devtools/bundled/inspector.html',
    'chrome-extension://abc/page.html',
    'view-source:https://example.com',
    `https://example.com/${'a'.repeat(LIMITS.urlChars)}`,
    'not a url',
  ]) {
    assert.throws(() => validateAction({ type: 'navigate', url }), /invalid action/, url);
  }
});

test('text is bounded and keys come from an allowlist', () => {
  assert.equal(validateAction({ type: 'text', text: 'hola ñ' }).text, 'hola ñ');
  assert.throws(() => validateAction({ type: 'text', text: 'a'.repeat(LIMITS.textChars + 1) }), /invalid action/);
  assert.throws(() => validateAction({ type: 'text', text: '' }), /invalid action/);
  assert.equal(validateAction({ type: 'key', key: 'Enter' }).key, 'Enter');
  for (const key of ['F12', 'Control+Shift+I', 'Meta', 'a']) {
    assert.throws(() => validateAction({ type: 'key', key }), /invalid action/, key);
  }
});

test('coordinates must be finite and inside the bound', () => {
  assert.deepEqual(validateAction({ type: 'tap', x: 10, y: 20.5 }), { type: 'tap', x: 10, y: 20.5 });
  for (const [x, y] of [[-1, 0], [0, LIMITS.coord + 1], [Number.NaN, 0], ['1', 2]]) {
    assert.throws(() => validateAction({ type: 'tap', x, y }), /invalid action/, `${x},${y}`);
  }
});

test('frame parameters are clamped to the frame limits', () => {
  assert.deepEqual(validateAction({ type: 'frame' }), {
    type: 'frame',
    maxWidth: LIMITS.frameMaxWidth,
    quality: LIMITS.frameQuality,
  });
  assert.throws(() => validateAction({ type: 'frame', maxWidth: LIMITS.frameMaxWidth + 1 }), /invalid action/);
  assert.throws(() => validateAction({ type: 'frame', quality: 100 }), /invalid action/);
});

test('tap becomes a left mouse press and release at the point', async () => {
  const { calls, send } = recorder();
  await perform({ type: 'tap', x: 5, y: 6 }, send);
  assert.deepEqual(calls.map(([m, p]) => [m, p.type]), [
    ['Input.dispatchMouseEvent', 'mouseMoved'],
    ['Input.dispatchMouseEvent', 'mousePressed'],
    ['Input.dispatchMouseEvent', 'mouseReleased'],
  ]);
  assert.equal(calls[1][1].x, 5);
});

test('back moves exactly one history entry and does nothing at the start', async () => {
  const history = { currentIndex: 1, entries: [{ id: 7 }, { id: 9 }] };
  const a = recorder({ 'Page.getNavigationHistory': history });
  await perform({ type: 'back' }, a.send);
  assert.deepEqual(a.calls.at(-1), ['Page.navigateToHistoryEntry', { entryId: 7 }]);

  const b = recorder({ 'Page.getNavigationHistory': { currentIndex: 0, entries: [{ id: 7 }] } });
  assert.deepEqual(await perform({ type: 'back' }, b.send), { moved: false });
  assert.equal(b.calls.length, 1);
});

test('frame is a downscaled JPEG and fails rather than exceed the byte limit', async () => {
  const metrics = { cssVisualViewport: { clientWidth: 3200, clientHeight: 2000, pageX: 0, pageY: 0 } };
  const small = recorder({ 'Page.getLayoutMetrics': metrics, 'Page.captureScreenshot': { data: 'AAAA' } });
  const frame = await perform(validateAction({ type: 'frame', maxWidth: 800 }), small.send);
  const [, params] = small.calls.find(([m]) => m === 'Page.captureScreenshot')!;
  assert.equal(params.format, 'jpeg');
  assert.equal(params.clip.scale, 0.25);
  assert.deepEqual(frame, { data: 'AAAA', width: 800, height: 500, bytes: 3 });

  const huge = 'A'.repeat(Math.ceil((LIMITS.frameMaxBytes + 1) / 3) * 4);
  const big = recorder({ 'Page.getLayoutMetrics': metrics, 'Page.captureScreenshot': { data: huge } });
  await assert.rejects(perform(validateAction({ type: 'frame' }), big.send), /frame too large/);
});

// Layout metrics that report a 0x0 viewport for the first `zeroReads` reads, then a sized one.
function viewportAfter(zeroReads: number) {
  const calls: string[] = [];
  const send = async (method: string) => {
    calls.push(method);
    if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
    const sized = calls.filter((m) => m === 'Page.getLayoutMetrics').length > zeroReads;
    return { cssVisualViewport: { clientWidth: sized ? 800 : 0, clientHeight: sized ? 600 : 0, pageX: 0, pageY: 0 } };
  };
  return { calls, send };
}

// Runs `promise` to completion while advancing the mocked setTimeout clock.
async function drive<T>(t: TestContext, promise: Promise<T>) {
  let settled = false;
  promise.then(() => (settled = true), () => (settled = true));
  while (!settled) {
    await new Promise(setImmediate);
    t.mock.timers.tick(100);
  }
  return promise;
}

test('frame retries a viewport that is briefly 0x0 after attaching', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = viewportAfter(3);
  assert.equal((await drive(t, perform({ type: 'frame' }, r.send))).width, 800);
  assert.equal(r.calls.filter((m) => m === 'Page.getLayoutMetrics').length, 4);
});

test('frame gives up on a viewport that stays 0x0, with a retryable error and no capture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = viewportAfter(Infinity);
  await assert.rejects(drive(t, perform({ type: 'frame' }, r.send)), /frame unavailable/);
  assert.ok(!r.calls.includes('Page.captureScreenshot'));
});
