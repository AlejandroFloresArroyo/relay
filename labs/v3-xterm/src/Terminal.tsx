'use dom';

import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { DOMProps } from 'expo/dom';
import { useEffect, useRef, useState } from 'react';

import { fnv1a } from './shell';

type Props = {
  dom?: DOMProps;
  // `baseline`: xterm as shipped. `relay`: the Android adaptations this lab validates.
  config: 'baseline' | 'relay';
  sendInput: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  pullOutput: () => Promise<string>;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<string>;
};

type Key = 'esc' | 'tab' | 'ctrl' | 'alt' | 'left' | 'up' | 'down' | 'right' | 'select' | 'copy' | 'paste';
type Sticky = 'ctrl' | 'alt' | 'select';
const KEYS: [Key, string][] = [
  ['esc', 'Esc'],
  ['tab', 'Tab'],
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['left', '←'],
  ['up', '↑'],
  ['down', '↓'],
  ['right', '→'],
  ['select', 'Selec.'],
  ['copy', 'Copiar'],
  ['paste', 'Pegar'],
];
const ARROWS: Partial<Record<Key, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export default function Terminal(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  // Native action proxies change identity when the bridge re-sends props. The terminal and its
  // output loop must outlive that: a second loop would pull output into a disposed terminal.
  const actions = useRef(props);
  actions.current = props;
  const relay = props.config === 'relay';
  const [mods, setMods] = useState<Record<Sticky, boolean>>({ ctrl: false, alt: false, select: false });
  const press = useRef<(key: Key) => void>(() => {});

  useEffect(() => {
    const { sendInput, resize, pullOutput } = {
      sendInput: (data: string) => actions.current.sendInput(data),
      resize: (cols: number, rows: number) => actions.current.resize(cols, rows),
      pullOutput: () => actions.current.pullOutput(),
    };
    const element = host.current!;
    const term = new XTerm({ scrollback: 5000, fontSize: 14, fontFamily: 'monospace' });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    // Read by the Android suite over the WebView DevTools protocol.
    const stats = { received: 0, hash: 0x811c9dc5 };
    Object.assign(window, { __lab: { term, stats } });

    // Sticky Ctrl/Alt from the accessory bar apply to the next single character, whatever its
    // source (soft keyboard, hardware keyboard). Selec. stays on until Copiar or a second tap.
    const sticky: Record<Sticky, boolean> = { ctrl: false, alt: false, select: false };
    const emit = (data: string) => {
      if ((sticky.ctrl || sticky.alt) && [...data].length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (sticky.ctrl && code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        if (sticky.alt) data = '\x1b' + data;
        sticky.ctrl = sticky.alt = false;
        setMods({ ...sticky });
      }
      void sendInput(data);
    };
    term.onData(emit);
    term.onResize(({ cols, rows }) => void resize(cols, rows));
    void resize(term.cols, term.rows);

    let alive = true;
    void (async () => {
      while (alive) {
        const chunk = await pullOutput();
        if (!chunk) continue;
        stats.received += chunk.length;
        stats.hash = fnv1a(stats.hash, chunk);
        await new Promise<void>((done) => term.write(chunk, done));
      }
    })();

    const cleanups: (() => void)[] = [];
    if (!relay) {
      const refit = () => fit.fit();
      window.addEventListener('resize', refit);
      cleanups.push(() => window.removeEventListener('resize', refit));
    } else {
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(element);
      cleanups.push(() => observer.disconnect());
      cleanups.push(attachIme(element, term.textarea!, emit));
      cleanups.push(attachTouchSelection(element, term, () => sticky.select));
      press.current = (key) => {
        if (key === 'ctrl' || key === 'alt' || key === 'select') {
          sticky[key] = !sticky[key];
          setMods({ ...sticky });
        } else if (key === 'copy') {
          if (term.hasSelection()) void actions.current.copy(term.getSelection());
          term.clearSelection();
          sticky.select = false;
          setMods({ ...sticky });
        } else if (key === 'paste') {
          void actions.current.paste().then((text) => text && term.paste(text));
        } else if (key === 'esc') emit('\x1b');
        else if (key === 'tab') emit('\t');
        else emit((term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[key]);
      };
    }

    return () => {
      alive = false;
      for (const cleanup of cleanups) cleanup();
      term.dispose();
    };
  }, [relay]);

  const terminal = <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />;
  if (!relay) return <div style={{ position: 'fixed', inset: 0, display: 'flex', background: '#000' }}>{terminal}</div>;
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#000' }}>
      {terminal}
      <div style={{ display: 'flex', height: 44, flexShrink: 0, background: '#1c1c1e' }}>
        {KEYS.map(([key, label]) => (
          <button
            key={key}
            data-key={key}
            // Keeps focus (and the soft keyboard) on the terminal.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => press.current(key)}
            style={{
              flex: 1,
              minWidth: 0,
              padding: 0,
              border: 0,
              borderRight: '1px solid #000',
              color: '#fff',
              fontSize: 13,
              background: (key === 'ctrl' || key === 'alt' || key === 'select') && mods[key] ? '#0a84ff' : '#2c2c2e',
            }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Android IMEs (Gboard) report every key as keyCode 229 and edit the textarea through input
// events; xterm's heuristics for that (a diff of the textarea after setTimeout 0) duplicate and
// drop characters. Here the textarea is the source of truth: what changed since the last sync
// is sent as DELs plus new text, never mid-composition. The composition branch is not proven
// with a real IME: Gboard on the emulator never composes in this WebView.
function attachIme(host: HTMLElement, textarea: HTMLTextAreaElement, emit: (data: string) => void) {
  // No suggestion strip (more rows) and no autocorrect rewriting words already sent.
  textarea.setAttribute('autocomplete', 'off');
  let sent = '';
  let composing = false;
  const sync = () => {
    const now = [...textarea.value];
    const before = [...sent];
    let same = 0;
    while (same < now.length && same < before.length && now[same] === before[same]) same++;
    const data = '\x7f'.repeat(before.length - same) + now.slice(same).join('');
    sent = textarea.value;
    if (data) emit(data);
  };
  const reset = () => {
    textarea.value = '';
    sent = '';
  };
  // Capture on the host runs before xterm's listeners on the textarea and keeps them out.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target === textarea && event.keyCode === 229) event.stopPropagation();
  };
  const onComposition = (event: CompositionEvent) => {
    if (event.target !== textarea) return;
    event.stopPropagation();
    composing = event.type !== 'compositionend';
    if (!composing) sync();
  };
  const onInput = (event: Event) => {
    if (event.target !== textarea) return;
    event.stopPropagation();
    // xterm already sent the paste from the paste event; the textarea copy is a leftover.
    if (event instanceof InputEvent && event.inputType.startsWith('insertFrom')) reset();
    else if (!composing) sync();
  };
  // Keys xterm handled itself (Enter, hardware keys) leave the IME text behind: start over.
  const afterKeyDown = (event: KeyboardEvent) => {
    if (event.target === textarea && event.keyCode !== 229 && event.defaultPrevented) reset();
  };
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('compositionstart', onComposition, true);
  host.addEventListener('compositionupdate', onComposition, true);
  host.addEventListener('compositionend', onComposition, true);
  host.addEventListener('input', onInput, true);
  host.addEventListener('keydown', afterKeyDown);
  return () => {
    host.removeEventListener('keydown', onKeyDown, true);
    host.removeEventListener('compositionstart', onComposition, true);
    host.removeEventListener('compositionupdate', onComposition, true);
    host.removeEventListener('compositionend', onComposition, true);
    host.removeEventListener('input', onInput, true);
    host.removeEventListener('keydown', afterKeyDown);
  };
}

// xterm selects with a mouse only, and a WebView cancels a long-press drag (touchcancel ~0.8 s
// after touchstart, even with contextmenu and selectstart prevented). While Selec. is on,
// dragging selects across lines instead of scrolling; the selection survives the touch end.
function attachTouchSelection(host: HTMLElement, term: XTerm, active: () => boolean) {
  let anchor: { col: number; row: number } | null = null;
  const cellAt = (touch: Touch) => {
    const screen = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
    const col = Math.floor(((touch.clientX - screen.left) / screen.width) * term.cols);
    const row = Math.floor(((touch.clientY - screen.top) / screen.height) * term.rows);
    return {
      col: Math.max(0, Math.min(term.cols - 1, col)),
      row: term.buffer.active.viewportY + Math.max(0, Math.min(term.rows - 1, row)),
    };
  };
  const selectTo = (end: { col: number; row: number }) => {
    if (!anchor) return;
    const [from, to] =
      end.row < anchor.row || (end.row === anchor.row && end.col < anchor.col) ? [end, anchor] : [anchor, end];
    term.select(from.col, from.row, (to.row - from.row) * term.cols + to.col - from.col + 1);
  };
  const onStart = (event: TouchEvent) => {
    if (!active()) return;
    // No scroll, no long-press, no focus change: this touch only selects.
    event.preventDefault();
    event.stopPropagation();
    anchor = cellAt(event.touches[0]);
    selectTo(anchor);
  };
  const onMove = (event: TouchEvent) => {
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    selectTo(cellAt(event.touches[0]));
  };
  const onEnd = (event: TouchEvent) => {
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    anchor = null;
  };
  host.addEventListener('touchstart', onStart, { passive: false, capture: true });
  host.addEventListener('touchmove', onMove, { passive: false, capture: true });
  host.addEventListener('touchend', onEnd, { passive: false, capture: true });
  return () => {
    host.removeEventListener('touchstart', onStart, true);
    host.removeEventListener('touchmove', onMove, true);
    host.removeEventListener('touchend', onEnd, true);
  };
}
