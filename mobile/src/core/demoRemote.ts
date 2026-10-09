import type { EntryOutcome } from './remoteAccess.ts';
import type { RemoteTool, RemoteToolState } from './remoteCapabilities.ts';

/** What the demo's system verification answers when entering the tools of a Servidor. */
export const DEMO_REMOTE_ENTRY_SCENARIOS: readonly { id: EntryOutcome; name: string }[] = [
  { id: 'verified', name: 'Huella o código correctos' },
  { id: 'unavailable', name: 'Sin huella ni código' },
  { id: 'cancelled', name: 'Verificación cancelada' },
];
let entry: EntryOutcome = 'verified';
export const demoRemoteEntry = (): EntryOutcome => entry;
export function setDemoRemoteEntry(next: EntryOutcome) { entry = next; }

/** Terminal, files, web and browser are built and shown with their demo data. */
export const DEMO_REMOTE_TOOLS: Partial<Record<RemoteTool, RemoteToolState>> = {
  terminal: { state: 'available', capability: { name: 'terminal', version: 1 } },
  files: { state: 'available', capability: { name: 'files', version: 1 } },
  webInRelay: { state: 'available', capability: { name: 'web', version: 1 } },
  webExternal: { state: 'available', capability: { name: 'web', version: 1 } },
  browserDedicated: { state: 'available', capability: { name: 'browser', version: 1 } },
  browserHabitual: { state: 'available', capability: { name: 'browser', version: 1 } },
};
