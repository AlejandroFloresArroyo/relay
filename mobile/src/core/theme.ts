export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_KEY = 'relay.theme.v1';
export const THEME_READ_ERROR = 'El tema guardado no se pudo leer.';
export const THEME_WRITE_ERROR = 'El tema elegido no se guardó; se conserva hasta cerrar Relay.';
export const THEME_OPTIONS = [
  { value: 'light', label: 'Claro', detail: 'Instrumento claro' },
  { value: 'dark', label: 'Oscuro', detail: 'Instrumento oscuro' },
  { value: 'system', label: 'Sistema', detail: 'Sigue el tema del teléfono' },
] as const;
export function parseThemePreference(raw: string | null): ThemePreference {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'light';
  } catch { return 'light'; }
}
export function resolveTheme(preference: ThemePreference, system: 'light' | 'dark' | null | undefined): 'light' | 'dark' {
  return preference === 'system' ? system === 'dark' ? 'dark' : 'light' : preference;
}
