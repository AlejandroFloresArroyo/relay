import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_LIMITS } from '../../../protocol/remoteBrowser.ts';
import { addressUrl, frameRect, pagePoint, scrollDelta, viewFor } from './browserView.ts';

test('a frame is drawn whole and centred: letterboxed on the long side, never cropped', () => {
  // A page as tall as the box is wide, in a portrait box: bars above and below.
  assert.deepEqual(frameRect({ width: 400, height: 600 }, { width: 800, height: 800 }), { left: 0, top: 100, width: 400, height: 400, scale: 0.5 });
  // A narrow page in a landscape box: bars left and right.
  assert.deepEqual(frameRect({ width: 900, height: 400 }, { width: 400, height: 800 }), { left: 350, top: 0, width: 200, height: 400, scale: 0.5 });
});

test('a touch maps to the CSS pixels of the frame it landed on, whatever the scale and orientation', () => {
  // Same size: identity.
  assert.deepEqual(pagePoint({ x: 120, y: 340 }, { width: 400, height: 700 }, { width: 400, height: 700 }), { x: 120, y: 340 });
  // A desktop-wide habitual window shown on a phone: drawn at 0.3125, 225 px below the top of the box.
  assert.deepEqual(pagePoint({ x: 200, y: 350 }, { width: 400, height: 700 }, { width: 1280, height: 800 }), { x: 640, y: 400 });
  // Rotated: the same page point from a landscape box.
  assert.deepEqual(pagePoint({ x: 350 + 100, y: 200 }, { width: 900, height: 400 }, { width: 400, height: 800 }), { x: 200, y: 400 });
});

test('a touch on the bars around the frame, or with no size yet, is no touch at all', () => {
  assert.equal(pagePoint({ x: 10, y: 50 }, { width: 400, height: 600 }, { width: 800, height: 800 }), null);
  assert.equal(pagePoint({ x: 10, y: 590 }, { width: 400, height: 600 }, { width: 800, height: 800 }), null);
  assert.equal(pagePoint({ x: 10, y: 10 }, { width: 0, height: 600 }, { width: 800, height: 800 }), null);
  assert.equal(pagePoint({ x: 10, y: 10 }, { width: 400, height: 600 }, { width: 0, height: 800 }), null);
  // The edges themselves are on the page.
  assert.deepEqual(pagePoint({ x: 400, y: 500 }, { width: 400, height: 600 }, { width: 800, height: 800 }), { x: 800, y: 800 });
});

test('dragging moves the content with the finger: the page scrolls the other way, in CSS pixels, within bounds', () => {
  assert.deepEqual(scrollDelta({ dx: 0, dy: -100 }, { width: 400, height: 600 }, { width: 800, height: 800 }), { dx: 0, dy: 200 });
  assert.deepEqual(scrollDelta({ dx: 50, dy: 0 }, { width: 400, height: 600 }, { width: 400, height: 600 }), { dx: -50, dy: 0 });
  assert.deepEqual(scrollDelta({ dx: 0, dy: -9000 }, { width: 100, height: 100 }, { width: 400, height: 400 }), { dx: 0, dy: BROWSER_LIMITS.scroll });
});

test('the view asked for is the box in CSS pixels at the screen density, within the contract; each oversized step asks for less', () => {
  assert.deepEqual(viewFor({ width: 392.4, height: 611.6 }, 2.75, 0), { width: 392, height: 612, scale: 2, quality: BROWSER_LIMITS.quality });
  assert.deepEqual(viewFor({ width: 392, height: 612 }, 2.75, 1), { width: 392, height: 612, scale: 1, quality: BROWSER_LIMITS.quality });
  assert.deepEqual(viewFor({ width: 392, height: 612 }, 2.75, 2), { width: 392, height: 612, scale: 1, quality: BROWSER_LIMITS.qualityMin });
  assert.deepEqual(viewFor({ width: 20, height: 9000 }, 1, 0), { width: BROWSER_LIMITS.viewportMin, height: BROWSER_LIMITS.viewportMax, scale: 1, quality: BROWSER_LIMITS.quality });
});

test('the address bar takes a web address as typed, and never another scheme', () => {
  assert.equal(addressUrl('  example.com/búsqueda?q=ñ '), 'https://example.com/búsqueda?q=ñ');
  assert.equal(addressUrl('http://example.com'), 'http://example.com');
  assert.equal(addressUrl('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(addressUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const refused of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,x', 'about:blank']) assert.equal(addressUrl(refused), null, refused);
});
