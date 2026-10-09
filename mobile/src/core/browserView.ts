// Where a browser frame sits on the phone and what a touch on it means (protocol/remoteBrowser.ts):
// the frame is drawn whole inside its box, and every touch is turned into CSS pixels of the viewport
// that frame reports, never of the box or of the size Relay asked for.
import { BROWSER_LIMITS, browserUrl } from '../../../protocol/remoteBrowser.ts';

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The frame of `viewport` CSS pixels drawn inside `box`, centred and scaled to fit (contain). */
export function frameRect(box: Size, viewport: Size): { left: number; top: number; width: number; height: number; scale: number } {
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
  const width = viewport.width * scale, height = viewport.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height, scale };
}

/** A point of the box in CSS pixels of the page; null on the bars around the frame or before both sizes are known. */
export function pagePoint(point: Point, box: Size, viewport: Size): Point | null {
  if (![box.width, box.height, viewport.width, viewport.height].every((side) => side > 0 && Number.isFinite(side))) return null;
  const rect = frameRect(box, viewport);
  const x = (point.x - rect.left) / rect.scale, y = (point.y - rect.top) / rect.scale;
  if (!(x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height)) return null;
  return { x, y };
}

/** A drag of the box as a page scroll: the content follows the finger, so the page scrolls the other way. */
export function scrollDelta(drag: { dx: number; dy: number }, box: Size, viewport: Size): { dx: number; dy: number } {
  const { scale } = frameRect(box, viewport);
  const [dx, dy] = [drag.dx, drag.dy].map((value) => clamp(-value / scale, -BROWSER_LIMITS.scroll, BROWSER_LIMITS.scroll) || 0);
  return { dx: dx!, dy: dy! };
}

/**
 * The view to ask for: the box in CSS pixels at the screen's density, at most 2 (a 3x frame of a phone
 * screen is often over browserFrameBytes). Each `oversized` step asks for less: density 1, then the
 * lowest quality.
 */
export function viewFor(box: Size, pixelRatio: number, step: 0 | 1 | 2): { width: number; height: number; scale: number; quality: number } {
  const [width, height] = [box.width, box.height].map((value) => clamp(Math.round(value), BROWSER_LIMITS.viewportMin, BROWSER_LIMITS.viewportMax));
  return {
    width: width!, height: height!,
    scale: step === 0 ? clamp(Math.round(pixelRatio), 1, 2) : 1,
    quality: step === 2 ? BROWSER_LIMITS.qualityMin : BROWSER_LIMITS.quality,
  };
}

/**
 * What the person typed in the address bar, as a URL the contract takes: https:// when it has no scheme
 * (http:// for this machine's own names), null for any scheme but http and https.
 */
export function addressUrl(input: string): string | null {
  const text = input.trim();
  // A scheme is letters and a colon not followed by a port: «localhost:3000» has none.
  const url = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`;
  return text && browserUrl(url) ? url : null;
}
