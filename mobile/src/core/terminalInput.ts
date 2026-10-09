// What the terminal page (screens/terminal/TerminalSurface.tsx) does with keys, the IME, the
// clipboard and touches, kept apart from React and the WebView so node --test can drive it. The
// signatures name DOM types; xterm and the page's elements fit them, and tests pass small fakes.

export type BarKey = 'esc' | 'tab' | 'ctrl' | 'alt' | 'left' | 'up' | 'down' | 'right' | 'select' | 'copy' | 'paste';
export type Sticky = 'ctrl' | 'alt' | 'select';
export type Mods = Record<Sticky, boolean>;

const ARROWS: Partial<Record<BarKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** The part of xterm the key bar uses. */
export interface KeyTerminal {
  modes: { applicationCursorKeysMode: boolean };
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  /** xterm's paste turns \n into \r, honours bracketed paste and never adds Enter. */
  paste(text: string): void;
}

/** The page's native actions, read again on every use: the bridge replaces them when it re-sends props. */
export interface KeyActions {
  input: boolean;
  write(text: string): Promise<void>;
  copy(text: string): Promise<void>;
  paste(): Promise<string>;
}

/**
 * The key bar and the single way out for typed data. `emit` takes what xterm and the IME adapter
 * produce; `press` takes a tap on the bar; `changed` hears every change of the sticky keys.
 */
export function createKeyBar(term: KeyTerminal, actions: () => KeyActions, changed: (mods: Mods) => void) {
  // Sticky Ctrl/Alt from the key bar apply to the next key, whatever its source, and that key turns
  // them off: a single character gets Ctrl's control code and Alt's ESC prefix, an arrow xterm's
  // modifier parameter, anything else goes as it is. Selec. stays on until Copiar or a second tap.
  const sticky: Mods = { ctrl: false, alt: false, select: false };
  const emit = (data: string) => {
    if (!actions().input) return;
    if (sticky.ctrl || sticky.alt) {
      if ([...data].length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (sticky.ctrl && code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        if (sticky.alt) data = '\x1b' + data;
      }
      sticky.ctrl = sticky.alt = false;
      changed({ ...sticky });
    }
    void actions().write(data);
  };
  const press = (key: BarKey) => {
    if (key === 'ctrl' || key === 'alt' || key === 'select') {
      sticky[key] = !sticky[key];
      changed({ ...sticky });
    } else if (key === 'copy') {
      if (term.hasSelection()) void actions().copy(term.getSelection());
      term.clearSelection();
      sticky.select = false;
      changed({ ...sticky });
    } else if (key === 'paste') {
      if (actions().input) void actions().paste().then((text) => text && term.paste(text));
    } else if (key === 'esc') emit('\x1b');
    else if (key === 'tab') emit('\t');
    else {
      // Keyboard.ts in xterm: 1 + Alt 2 + Ctrl 4, the same in either cursor mode.
      const modifier = 1 + (sticky.alt ? 2 : 0) + (sticky.ctrl ? 4 : 0);
      emit(modifier > 1 ? `\x1b[1;${modifier}${ARROWS[key]}` : (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[key]);
    }
  };
  return { emit, press, selecting: () => sticky.select };
}

// Android IMEs (Gboard) report every key as keyCode 229 and edit the textarea through input events;
// xterm's heuristics for that duplicate and drop characters. Here the textarea is the source of truth:
// what changed since the last sync is sent as DELs plus new text, never mid-composition. The
// composition branch has no evidence with a real IME yet (#77, «Límites de la evidencia»).
export function attachIme(host: HTMLElement, textarea: HTMLTextAreaElement, emit: (data: string) => void) {
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
    if ((event as InputEvent).inputType?.startsWith('insertFrom')) reset();
    else if (!composing) sync();
  };
  // Keys xterm handled itself (Enter, Ctrl-C, Gboard's Backspace, hardware keys) leave the IME text
  // behind, and after Enter or Ctrl-C xterm has already emptied the textarea: start over. xterm stops
  // those keydowns at the textarea, so this listens to the key's release, in capture, which it lets by.
  const afterKey = (event: KeyboardEvent) => {
    if (event.target === textarea && event.keyCode !== 229) reset();
  };
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('compositionstart', onComposition, true);
  host.addEventListener('compositionupdate', onComposition, true);
  host.addEventListener('compositionend', onComposition, true);
  host.addEventListener('input', onInput, true);
  host.addEventListener('keyup', afterKey, true);
  return () => {
    host.removeEventListener('keydown', onKeyDown, true);
    host.removeEventListener('compositionstart', onComposition, true);
    host.removeEventListener('compositionupdate', onComposition, true);
    host.removeEventListener('compositionend', onComposition, true);
    host.removeEventListener('input', onInput, true);
    host.removeEventListener('keyup', afterKey, true);
  };
}

/** The part of xterm touch selection uses. */
export interface SelectTerminal {
  element: HTMLElement | undefined;
  cols: number;
  rows: number;
  buffer: { active: { viewportY: number } };
  select(column: number, row: number, length: number): void;
}

// xterm selects with a mouse only, and a WebView cancels a long-press drag. While Selec. is on,
// dragging selects across lines instead of scrolling; the selection survives the touch end.
export function attachTouchSelection(host: HTMLElement, term: SelectTerminal, active: () => boolean) {
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
    const [from, to] = end.row < anchor.row || (end.row === anchor.row && end.col < anchor.col) ? [end, anchor] : [anchor, end];
    term.select(from.col, from.row, (to.row - from.row) * term.cols + to.col - from.col + 1);
  };
  const onStart = (event: TouchEvent) => {
    if (!active()) return;
    // No scroll, no long-press, no focus change: this touch only selects.
    event.preventDefault();
    event.stopPropagation();
    anchor = cellAt(event.touches[0]!);
    selectTo(anchor);
  };
  const onMove = (event: TouchEvent) => {
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    selectTo(cellAt(event.touches[0]!));
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
