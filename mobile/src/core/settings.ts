export const AUTO_LOCK_OPTIONS = [
  { ms: 0, label: 'AHORA', detail: 'Al salir de la app' },
  { ms: 60_000, label: '1 MIN', detail: 'Recomendado' },
  { ms: 300_000, label: '5 MIN', detail: '' },
  { ms: 900_000, label: '15 MIN', detail: '' },
] as const;

export interface Settings {
  faceid: boolean;
  faceApprove: boolean;
  autoLockMs: (typeof AUTO_LOCK_OPTIONS)[number]['ms'];
}

export const DEFAULT_SETTINGS: Settings = { faceid: true, faceApprove: true, autoLockMs: 60_000 };

/** Only current preferences cross the storage boundary, including when reading older versions. */
export function loadSettings(raw: string | null): Settings {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
    const stored = value as Partial<Settings>;
    return {
      faceid: typeof stored.faceid === 'boolean' ? stored.faceid : DEFAULT_SETTINGS.faceid,
      faceApprove: typeof stored.faceApprove === 'boolean' ? stored.faceApprove : DEFAULT_SETTINGS.faceApprove,
      autoLockMs: AUTO_LOCK_OPTIONS.some(({ ms }) => ms === stored.autoLockMs) ? stored.autoLockMs! : DEFAULT_SETTINGS.autoLockMs,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const SETTINGS_KEY = 'relay.settings.v1';

/** Storage adapters only access preferences; Servidor loading/migration stays independent. */
export async function readSettings(read: (key: string) => Promise<string | null>): Promise<Settings> {
  return loadSettings(await read(SETTINGS_KEY));
}

export function settingChange<K extends keyof Settings>(previous: Settings, key: K, value: Settings[K]) {
  const settings = loadSettings(JSON.stringify({ ...previous, [key]: value }));
  return { settings, write: { key: SETTINGS_KEY, value: JSON.stringify(settings) } };
}

export function updateSettings<K extends keyof Settings>(previous: Settings, key: K, value: Settings[K], write?: (key: string, value: string) => void | Promise<void>): Settings {
  const change = settingChange(previous, key, value);
  if (write) void write(change.write.key, change.write.value);
  return change.settings;
}

/** Keep the existing Servidor format; a failure on either side never discards the other. */
export function loadStoredState<Server>(rawServers: string | null, rawSettings: string | null): { servers: Server[]; settings: Settings } {
  let servers: Server[] = [];
  try {
    if (rawServers) {
      const value: unknown = JSON.parse(rawServers);
      if (Array.isArray(value)) servers = value as Server[];
    }
  } catch {
    // Unreadable Servidores start empty, independently of preferences.
  }
  return { servers, settings: loadSettings(rawSettings) };
}
