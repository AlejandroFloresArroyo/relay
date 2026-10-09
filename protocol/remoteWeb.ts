// `web` remote tool (ADR 0006, docs/research/v3-proxy.md). Contract between the app and the Puente
// for local web apps: discovery, the registry of chosen apps, the in-Relay entry and the external
// one-hour authorization. Every route takes `X-Relay-Capability: web/<v>`.

/** A local service the Puente can serve: listening on loopback (or every address) by the account. */
export interface RemoteWebCandidate {
  /** Loopback literal the Puente would connect to: 127.0.0.0/8 or ::1, never a name. */
  address: string;
  port: number;
  /** What the account's own process reports; enough to choose, never its command line. */
  process: { name: string; directory: string };
}
/** GET /v1/remote/web/candidates. Discovery never connects to a port; it reads the socket table. */
export interface RemoteWebCandidateList { candidates: RemoteWebCandidate[] }

/** POST /v1/remote/web/apps: only a current candidate is accepted, never a URL nor a name. */
export interface RemoteWebRegisterRequest { requestId: string; name: string; address: string; port: number }

export interface RemoteWebApp {
  id: string;
  name: string;
  address: string;
  port: number;
  /** Public HTTPS origin of its own Service, never reused for another app; null while unpublished. */
  origin: string | null;
  createdAt: number;
}
/** GET /v1/remote/web/apps. DELETE /v1/remote/web/apps/:id forgets one and cuts its sessions. */
export interface RemoteWebAppList { apps: RemoteWebApp[] }

/** POST /v1/remote/web/apps/:id/open: the path the viewer starts at, inside the app, in printable ASCII (encodeURI). */
export interface RemoteWebOpenRequest { path: string }
/**
 * Single use, for the native viewer only: it loads `origin + entryPath` with a form POST
 * `ticket=<ticket>` and the listener answers a session cookie and a 303 to the path. Opening again
 * replaces that device's previous session for the app. POST …/:id/close ends it (Relay locked); it
 * never touches external authorizations.
 */
export interface RemoteWebOpen { origin: string; entryPath: string; ticket: string; expiresAt: number }
export interface RemoteWebClose { closed: number }

/**
 * External authorization (the phone's or tablet's own browser). A browser without a session that
 * navigates to the app gets the Puente's access page: a pending request bound to that browser by a
 * secret in `__Host-RelayPend`, shown by its public `code`. Relay grants the request whose code the
 * person compares; the next reload of that browser redeems it once for a new `__Host-RelayWeb`.
 * Knowing the code or the ID grants nothing to another browser. The hour counts from the grant on
 * the Server's monotonic clock and is never renewed by use; locking Relay keeps it. Cancelling,
 * revoking the device, forgetting the app, the app refusing a connection, or a Puente restart end
 * it, open SSE and WebSocket included. Times here are wall-clock ms for display only.
 */
export interface RemoteWebAccessRequest { id: string; code: string; createdAt: number; expiresAt: number }
/** Granted by this device: `redeemed` once a browser holds the session; until then it awaits the browser. */
export interface RemoteWebAuthorization { id: string; code: string; grantedAt: number; expiresAt: number; redeemed: boolean }
/**
 * GET /v1/remote/web/apps/:id/authorizations: the app's pending requests (any device may grant them)
 * and the authorizations this device granted. `serverNow` gives the offset to show the times.
 */
export interface RemoteWebAccessList { serverNow: number; requests: RemoteWebAccessRequest[]; authorizations: RemoteWebAuthorization[] }
/** POST /v1/remote/web/apps/:id/authorizations: `request` is the pending ID and `code` the one compared. */
export interface RemoteWebGrantRequest { request: string; code: string }
/** POST /v1/remote/web/apps/:id/authorizations/:accessId/cancel: only the granting device's own. */
export interface RemoteWebCancel { ok: true }

export const WEB_ENTRY_PATH = '/__relay/entrar';
/** Reserved in every app: never forwarded upstream. Apps must not use it. */
export const WEB_RESERVED_PATH_PREFIX = '/__relay/';
/** Host-only, Secure, HttpOnly, SameSite=Strict. Any cookie starting with `__Host-Relay` is reserved. */
export const WEB_SESSION_COOKIE = '__Host-RelayWeb';
/** The pending request's secret, same attributes, Max-Age of the pending lifetime. */
export const WEB_PENDING_COOKIE = '__Host-RelayPend';
/** Public code of a pending request: `XXXX-XXXX` from an alphabet without look-alikes. */
export const WEB_ACCESS_CODE_PATTERN = '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$';

export const WEB_LIMITS = {
  apps: 32, nameChars: 60, pathChars: 2048, ticketMs: 60_000, entryBodyBytes: 1024,
  /** External authorization: one hour from the grant, pending requests five minutes, twenty per app. */
  grantMs: 3_600_000, pendingMs: 300_000, pendingPerApp: 20,
} as const;
