import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { parseThemePreference, resolveTheme, THEME_KEY, THEME_READ_ERROR, THEME_WRITE_ERROR, type ThemePreference } from '@/core/theme';
import { loadServers as readPreference, saveServers as writePreference } from '@/state/storage';
import { DARK_PALETTE, LIGHT_PALETTE, type Palette } from './tokens';

// Native writes may outlive a provider; ordering belongs to the single theme key.
let themeWrites: Promise<void> = Promise.resolve();

const PaletteContext = createContext<Palette>(LIGHT_PALETTE);
const PreferenceContext = createContext<{
  preference: ThemePreference; ready: boolean; error: string | null; setPreference: (value: ThemePreference) => void;
}>({ preference: 'light', ready: false, error: null, setPreference: () => {} });

/** Theme persistence has its own key and never changes application or authorization state. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setValue] = useState<ThemePreference>('light');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const started = generation.current;
    void themeWrites.catch(() => {}).then(() => readPreference(THEME_KEY)).then(raw => {
      if (alive.current && generation.current === started) setValue(parseThemePreference(raw));
    }).catch(() => {
      if (alive.current && generation.current === started) setError(THEME_READ_ERROR);
    }).finally(() => { if (alive.current) setReady(true); });
    return () => { alive.current = false; };
  }, []);
  function setPreference(value: ThemePreference) {
    const selected = ++generation.current;
    setValue(value);
    setError(null);
    themeWrites = themeWrites.catch(() => {}).then(() => writePreference(THEME_KEY, JSON.stringify(value))).catch(() => {
      if (alive.current && generation.current === selected) setError(THEME_WRITE_ERROR);
    });
  }
  const palette = resolveTheme(preference, system === 'dark' ? 'dark' : 'light') === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  return <PreferenceContext.Provider value={{ preference, ready, error, setPreference }}>
    <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider>
  </PreferenceContext.Provider>;
}

/** Stable immutable palette, with the existing light palette as a standalone fallback. */
export function usePalette() { return useContext(PaletteContext); }
export function useThemePreference() { return useContext(PreferenceContext); }
