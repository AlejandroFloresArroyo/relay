// Demo web apps (npm run demo): one per state the Web tool shows, behind the same WebApi. Nothing
// leaves the app; the viewer shows a stand-in page instead of a WebView.
import type { RemoteWebAccessRequest, RemoteWebApp, RemoteWebAuthorization, RemoteWebCandidate } from '../../../protocol/remoteWeb.ts';
import { WEB_ENTRY_PATH, WEB_LIMITS } from '../../../protocol/remoteWeb.ts';
import { RemoteFailure } from './remoteClient.ts';
import type { RemoteErrorCode } from '../../../protocol/protocol.ts';
import type { WebApi } from './remoteWeb.ts';

export const DEMO_WEB_ORIGIN = 'https://relay-0d3m0a11ce5d3m0a.atlas.ts.net';
const HOME = '/home/user/proyectos';
const id = (name: string) => `app_demo${name.padEnd(22, '0')}`;

/** What opening each demo app answers: running, nothing listening, another program, not published. */
type Demo = RemoteWebApp & { opens: RemoteErrorCode | null };

export function createDemoWeb(now = () => Date.now()): WebApi {
  const start = now();
  const apps: Demo[] = [
    { id: id('tienda'), name: 'Tienda', address: '127.0.0.1', port: 3000, origin: DEMO_WEB_ORIGIN, createdAt: start - 86_400_000, opens: null },
    { id: id('panel'), name: 'Panel de pruebas', address: '127.0.0.1', port: 8080, origin: 'https://relay-0d3m0b0b0b0b0b0b.atlas.ts.net', createdAt: start - 3_600_000, opens: 'remote_ended' },
    { id: id('notas'), name: 'Notas', address: '::1', port: 4000, origin: 'https://relay-0d3m0c0c0c0c0c0c.atlas.ts.net', createdAt: start - 7_200_000, opens: 'remote_conflict' },
    { id: id('docs'), name: 'Documentación', address: '127.0.0.1', port: 4321, origin: null, createdAt: start - 600_000, opens: 'remote_unavailable' },
  ];
  const candidates: RemoteWebCandidate[] = [
    { address: '127.0.0.1', port: 3000, process: { name: 'node', directory: `${HOME}/tienda` } },
    { address: '127.0.0.1', port: 5173, process: { name: 'node', directory: `${HOME}/blog` } },
    { address: '::1', port: 8000, process: { name: 'python3', directory: `${HOME}/fotos` } },
  ];
  // The shop has one browser waiting for its code and one this device authorized fifty minutes ago.
  const requests: RemoteWebAccessRequest[] = [{ id: `acc_demo${'k7qm'.padEnd(22, '0')}`, code: 'K7QM-3XPD', createdAt: start - 30_000, expiresAt: start - 30_000 + WEB_LIMITS.pendingMs }];
  const authorizations: RemoteWebAuthorization[] = [
    { id: `acc_demo${'h4tr'.padEnd(22, '0')}`, code: 'H4TR-9WNB', grantedAt: start - 3_000_000, expiresAt: start - 3_000_000 + WEB_LIMITS.grantMs, redeemed: true },
  ];
  const find = (appId: string) => {
    const found = apps.find((each) => each.id === appId);
    if (!found) throw new RemoteFailure('remote', { code: 'remote_not_found' });
    return found;
  };
  const strip = ({ opens: _o, ...app }: Demo): RemoteWebApp => app;

  return {
    candidates: async () => candidates,
    apps: async () => apps.map(strip),
    async register(_requestId, name, chosen) {
      const created: Demo = { id: id(`nueva${apps.length}`), name, address: chosen.address, port: chosen.port,
        origin: `https://relay-0d3m0${String(apps.length).padStart(11, '0')}.atlas.ts.net`, createdAt: now(), opens: null };
      apps.push(created);
      return strip(created);
    },
    async forget(appId) { apps.splice(apps.indexOf(find(appId)), 1); },
    async open(chosen) {
      const found = find(chosen.id);
      if (found.opens) throw new RemoteFailure('remote', { code: found.opens });
      return { origin: found.origin!, uri: `${found.origin}${WEB_ENTRY_PATH}`, body: `ticket=${'D'.repeat(43)}` };
    },
    async close() {},
    async access(appId) {
      const own = find(appId).id === apps[0]!.id;
      const at = now();
      return { serverNow: at, requests: own ? requests.filter((r) => r.expiresAt > at) : [], authorizations: own ? authorizations.filter((a) => a.expiresAt > at) : [] };
    },
    async grant(_appId, pending) {
      const index = requests.findIndex((r) => r.id === pending.id && r.code === pending.code);
      if (index < 0) throw new RemoteFailure('remote', { code: 'remote_not_found' });
      requests.splice(index, 1);
      const granted = { id: pending.id, code: pending.code, grantedAt: now(), expiresAt: now() + WEB_LIMITS.grantMs, redeemed: false };
      authorizations.push(granted);
      return granted;
    },
    async cancel(_appId, accessId) {
      const index = authorizations.findIndex((a) => a.id === accessId);
      if (index < 0) throw new RemoteFailure('remote', { code: 'remote_not_found' });
      authorizations.splice(index, 1);
    },
  };
}
