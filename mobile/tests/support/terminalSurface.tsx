import { useEffect, useLayoutEffect, useRef } from 'react';
import { View } from 'react-native';

import { createKeyBar, type BarKey, type Mods } from '@/core/terminalInput';
import { useKeyTaps, type KeyTap } from '@/screens/terminal/useKeyTaps';

// Stands in for the 'use dom' terminal (a WebView on Android). Like the page, it pulls output frames,
// writes them and pulls again, which acknowledges them; it holds only what the native side passes.
interface Props {
  input: boolean;
  pull: () => Promise<string[]>;
  write: (text: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<string>;
  /** The taps on the native key bar. */
  taps: readonly KeyTap[];
  /** The sticky keys changed. */
  onMods: (mods: Mods) => Promise<void>;
}
interface Mounted { props: Props; text: string; alive: boolean; /** How many times the native side rendered it. */ renders: number; /** What xterm hands to the page when a key is typed. */ type: (data: string) => void }
export const surfaces: Mounted[] = [];
/** Every prop the native side passed to any surface, by name: proves what crosses into the page. */
export const passedProps = new Set<string>();

export default function TerminalSurfaceDouble(props: Props) {
  const mounted = useRef<Mounted | null>(null);
  for (const name of Object.keys(props)) passedProps.add(name);
  const pressed = useRef<(key: BarKey) => void>(() => {});
  useLayoutEffect(() => { if (mounted.current) { mounted.current.props = props; mounted.current.renders++; } });
  // The page's own hook, so the taps are applied exactly as there.
  useKeyTaps(props.taps, (key) => pressed.current(key));
  useEffect(() => {
    // The page's key bar logic, with a terminal that has no selection and no application cursor mode.
    const term = { modes: { applicationCursorKeysMode: false }, hasSelection: () => false, getSelection: () => '', clearSelection: () => {}, paste: () => {} };
    const keys = createKeyBar(term, () => surface.props, (mods) => { void surface.props.onMods(mods); });
    const surface: Mounted = { props, text: '', alive: true, renders: 0, type: keys.emit };
    pressed.current = keys.press;
    mounted.current = surface;
    surfaces.push(surface);
    void surface.props.resize(80, 24);
    void (async () => {
      while (surface.alive) {
        const frames = await surface.props.pull();
        if (!frames.length) break;
        for (const frame of frames) surface.text += Buffer.from(frame, 'base64').toString();
      }
    })();
    return () => { surface.alive = false; };
    // The page keeps its terminal for the life of the WebView, whatever props the bridge re-sends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <View accessibilityLabel="Pantalla de la terminal" />;
}

/** The surface on screen now: the last one mounted and alive. */
export function surface(): Mounted {
  const alive = surfaces.filter((s) => s.alive);
  if (!alive.length) throw new Error('No terminal surface is mounted.');
  return alive.at(-1)!;
}
export function resetTerminalSurfaces() { surfaces.length = 0; passedProps.clear(); }
