'use dom';

// The terminal itself: xterm inside Expo's DOM WebView (docs/research/v3-xterm.md, configuration
// `relay`). This page only ever receives terminal bytes, sizes and clipboard text through the native
// actions below; the device key, the Servidor's address and every request stay on the native side.
import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { DOMProps } from 'expo/dom';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { attachIme, attachTouchSelection, createKeyBar, type BarKey, type Mods } from '@/core/terminalInput';

import { useKeyTaps, type KeyTap } from './useKeyTaps';

export interface TerminalColors { background: string; foreground: string; cursor: string; selection: string }

type Props = {
  dom?: DOMProps;
  colors: TerminalColors;
  /** False once the terminal ended or lost its connection: keys and paste do nothing. */
  input: boolean;
  /** Base64 output frames; resolves with [] only when the terminal closed. */
  pull: () => Promise<string[]>;
  write: (text: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<string>;
  /** The taps on the native key bar, newest last: each one is pressed once (`useKeyTaps`). */
  taps: readonly KeyTap[];
  /** The sticky Ctrl, Alt and Selec. changed, for the native key bar to show them. */
  onMods: (mods: Mods) => Promise<void>;
};

export default function TerminalSurface(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Native action proxies change identity when the bridge re-sends props. The terminal and its output
  // loop must outlive that: a second loop would write into a disposed terminal (#77, point 8).
  const actions = useRef(props);
  useLayoutEffect(() => { actions.current = props; });
  const press = useRef<(key: BarKey) => void>(() => {});
  const terminal = useRef<XTerm | null>(null);

  useEffect(() => {
    const element = host.current!;
    const { colors } = actions.current;
    const term = new XTerm({
      scrollback: 5000, fontSize: 13, fontFamily: 'monospace', cursorBlink: true,
      theme: { background: colors.background, foreground: colors.foreground, cursor: colors.cursor, selectionBackground: colors.selection },
    });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();

    const keys = createKeyBar(term, () => actions.current, (mods) => void actions.current.onMods(mods));
    term.onData(keys.emit);
    term.onResize(({ cols, rows }) => void actions.current.resize(cols, rows));
    void actions.current.resize(term.cols, term.rows);

    let alive = true;
    void (async () => {
      while (alive) {
        const frames = await actions.current.pull();
        if (!frames.length) break;
        for (const frame of frames) {
          if (!alive) return;
          const binary = atob(frame);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          // xterm keeps a UTF-8 character split across two frames until the rest arrives.
          await new Promise<void>((done) => term.write(bytes, done));
        }
      }
    })();

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    const cleanups = [() => observer.disconnect(), attachIme(element, term.textarea!, keys.emit), attachTouchSelection(element, term, keys.selecting)];
    press.current = keys.press;

    return () => {
      alive = false;
      for (const cleanup of cleanups) cleanup();
      terminal.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !props.input;
  }, [props.input]);

  // The key bar is native (K-1 keys with their LEDs); its taps arrive as a list.
  useKeyTaps(props.taps, (key) => press.current(key));

  const { colors } = props;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: colors.background }}>
      {/* The side margin keeps column 0 out of the system's back-gesture strip (#77). */}
      <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '6px 14px 0' }} />
    </div>
  );
}
