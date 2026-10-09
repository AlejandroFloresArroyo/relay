// Browsers on the Puente's side (protocol/remoteBrowser.ts), one contract for both modes. The
// supervisor holds each dedicated browser and its CDP pipe; habitualBrowser.ts holds each connection to
// the habitual one. This module relays one device's requests to its own browser of either kind, after
// checking that each is exactly a bounded action, and each frame stream to its HTTP response. URLs,
// text and frames are never logged. Closing a stream disconnects; it never terminates anything.
import { BROWSER_LIMITS, browserUrl, validBrowserAction, validBrowserView } from '../../../protocol/remoteBrowser.ts';
import type { BrowserActionResult, BrowserStreamEvent, BrowserTab, BrowserTabList } from '../../../protocol/remoteBrowser.ts';
import { TERMINAL_CHANNEL_PATTERN } from '../../../protocol/remoteTerminal.ts';
import { exactObject } from '../changeLog.ts';
import { remote } from './environments.ts';
import type { HabitualSessions } from './habitualBrowser.ts';
import type { BrowserController } from './ports.ts';
import { RemoteError, type RemoteStream } from './routes.ts';
import { channelStreams } from './terminals.ts';

/** The `browser` contract this build serves. */
export const BROWSER_CAPABILITY = { version: 1, minAppVersion: 1 } as const;

export interface Browsers {
  tabs(deviceId: string, environmentId: string): Promise<BrowserTabList>;
  open(deviceId: string, environmentId: string, body: unknown): Promise<BrowserTab>;
  close(deviceId: string, environmentId: string, tab: string): Promise<{ ok: true }>;
  act(deviceId: string, environmentId: string, tab: string, body: unknown): Promise<BrowserActionResult>;
  /** Attaches the browser's stream, then checks the device again before streaming. */
  frames(deviceId: string, environmentId: string, guard: () => void): Promise<RemoteStream<BrowserStreamEvent>>;
  view(deviceId: string, environmentId: string, body: unknown): Promise<{ ok: true }>;
  ack(deviceId: string, environmentId: string, body: unknown): Promise<{ ok: true }>;
}

const channel = (value: unknown): value is string => typeof value === 'string' && new RegExp(TERMINAL_CHANNEL_PATTERN).test(value);

export function createBrowsers(ports: { dedicated: BrowserController; habitual: HabitualSessions | null }): Browsers {
  const { dedicated, habitual } = ports;
  const streams = { dedicated: channelStreams(dedicated), habitual: habitual ? channelStreams(habitual) : null };
  /** A connection to the habitual browser is the Puente's own; any other ID goes to the supervisor, which answers for its own. */
  const port = (environmentId: string): BrowserController => habitual?.has(environmentId) ? habitual : dedicated;

  return {
    async tabs(deviceId, environmentId) { return { tabs: await remote(port(environmentId).tabs({ environmentId, deviceId })) }; },

    async open(deviceId, environmentId, body) {
      if (!exactObject(body, [], ['url']) || (body.url !== undefined && !browserUrl(body.url))) throw new RemoteError('remote_invalid_request');
      return remote(port(environmentId).openTab({ environmentId, deviceId }, body.url ?? null));
    },

    async close(deviceId, environmentId, tab) {
      await remote(port(environmentId).closeTab({ environmentId, deviceId }, tab));
      return { ok: true };
    },

    async act(deviceId, environmentId, tab, body) {
      // Exactly one known action: never a CDP method, another scheme or an unbounded field.
      const action = validBrowserAction(body);
      if (!action) throw new RemoteError('remote_invalid_request');
      return remote(port(environmentId).act({ environmentId, deviceId }, tab, action));
    },

    frames(deviceId, environmentId, guard) {
      const open = habitual?.has(environmentId) && streams.habitual ? streams.habitual : streams.dedicated;
      return open<BrowserStreamEvent>({ environmentId, deviceId }, 0, (event, id) => {
        switch (event.type) {
          case 'opened': return [{ type: 'open', channel: id }];
          case 'frame': return [{ type: 'frame', seq: event.seq, tab: event.tab, data: event.data, viewport: event.viewport }, event.seq];
          case 'oversized': return [{ type: 'oversized', tab: event.tab }];
          case 'tabs': return [{ type: 'tabs', tabs: event.tabs }];
          case 'download': return [{ type: 'download', name: event.name, path: event.path }];
          case 'closed': return [{ type: 'closed', reason: event.reason }];
          // A browser channel never carries terminal output.
          default: return null;
        }
      }, guard);
    },

    async view(deviceId, environmentId, body) {
      if (!exactObject(body, ['channel', 'tab', 'width', 'height'], ['scale', 'quality']) || !channel(body.channel)) throw new RemoteError('remote_invalid_request');
      const view = { tab: body.tab, width: body.width, height: body.height, scale: body.scale ?? 1, quality: body.quality ?? BROWSER_LIMITS.quality };
      if (!validBrowserView(view)) throw new RemoteError('remote_invalid_request');
      await remote(port(environmentId).view({ environmentId, deviceId }, body.channel, view));
      return { ok: true };
    },

    async ack(deviceId, environmentId, body) {
      if (!exactObject(body, ['channel', 'seq']) || !channel(body.channel) || !Number.isSafeInteger(body.seq) || (body.seq as number) < 0) {
        throw new RemoteError('remote_invalid_request');
      }
      await remote(port(environmentId).ack({ environmentId, deviceId }, body.channel, body.seq as number));
      return { ok: true };
    },
  };
}
