// Design tokens of Relay 3.1, lifted from the K-1 canvas. Values are the canvas's own; do not
// round or "normalize" them.
// - `usePalette().K`: colors and shadows, same keys in light and dark (the `Palette` type enforces it).
// - `ledGlow(c)` / `textGlow(c)` / `TEXT_GLOW`: theme-independent effects.
// - `TYPE`: text roles as `{ s, w, ls? }` props, spread into the `T`/`M` primitives:
//   `<T {...TYPE.title}>`, `<M {...TYPE.label}>` (uppercase the label text yourself).
// - `RADIUS`: radii; `FRAME`: the web demo's device frame.

// Neon intensity "sutil" (k = 1) from the prototype's renderVals().
const glow = (c: string) => `0px 0px 8px ${c}, 0px 0px 2px ${c}`;

// K-1 (Relay 3.1). Names say what the value is for, not what it looks like.
const LIGHT_K = {
  background: '#D8D5CE',
  block: '#ECEAE5',
  key: '#ECEAE5',
  field: '#DCD9D2',
  /** Recessed list pane on tablet. */
  listPane: '#CBC7BF',
  ink: '#1A1A19',
  inkSecondary: '#4A4843',
  inkTertiary: '#5E5B55',
  line: '#D6D3CC',
  ledOff: '#B9B6AF',

  accent: '#F29A1A',
  /** Orange text on light surfaces. */
  accentText: '#7A4A00',
  ok: '#4CC774',
  okText: '#1E6638',
  okTextOnScreen: '#6FD08C',
  danger: '#E5533D',
  dangerText: '#9A2E20',
  dangerTextOnScreen: '#FF6A55',
  /** Recessed display (pantalla empotrada): K-1 «Pantalla», #161615 light, #070707 dark. */
  screen: '#161615',
  onScreen: '#C9C6BE',
  onScreenBright: '#ECEAE5',
  onScreenLabel: '#8D8A82',
  sweepTrackAccent: '#2A1E10',
  sweepTrackDanger: '#2A0E0A',
  sheetBackdrop: 'rgba(20,20,19,0.55)',
  toast: '#1A1A19',
  /** Text or icon on the orange key, both themes. */
  onAccent: '#1A1A19',
  /** Text on the inverted `ink` surface (plates, badges). */
  onInk: '#ECEAE5',
  /** Text on the red key. */
  onDanger: '#ECEAE5',
  /** Rule inside a recessed screen. */
  screenLine: '#2A2926',
  spinnerTrack: '#3A3936',
  avatarInk: '#1A1A19',
  diffAdded: 'rgba(46,138,78,0.12)',
  diffRemoved: 'rgba(200,64,46,0.1)',
  /** A failed item's block (a refused upload, a lost Turno). */
  dangerSurface: '#E4CDC4',

  shadowBlock: 'inset 0px 1px 0px #fff, 0px 1px 2px rgba(0,0,0,0.12)',
  shadowKey: 'inset 0px 1px 0px #fff, 0px 2px 3px rgba(0,0,0,0.15)',
  shadowKeyPressed: 'inset 0px 2px 3px rgba(0,0,0,0.18)',
  shadowField: 'inset 0px 2px 3px rgba(0,0,0,0.12)',
  shadowListPane: 'inset 0px 2px 5px rgba(0,0,0,0.14)',
  shadowPrimary: `inset 0px 1px 0px rgba(255,255,255,0.4), 0px 2px 4px rgba(0,0,0,0.25), ${glow('#F29A1A')}`,
  shadowScreen: 'inset 0px 2px 6px rgba(0,0,0,0.5)',
  shadowAccentRim: '0px 0px 0px 1px rgba(242,154,26,0.22), 0px 0px 16px rgba(242,154,26,0.14)',
  shadowSheet: 'inset 0px 1px 0px #fff, 0px -10px 30px rgba(0,0,0,0.25)',
} as const;

const DARK_K: { readonly [K in keyof typeof LIGHT_K]: string } = {
  ...LIGHT_K,
  background: '#141413',
  block: '#1F1E1C',
  key: '#2A2927',
  field: '#0F0F0E',
  // K-1 has no dark list pane; it is recessed like the light one, so it uses the dark field.
  listPane: '#0F0F0E',
  ink: '#E8E6E1',
  inkSecondary: '#C9C6BE',
  inkTertiary: '#8D8A82',
  line: '#2C2C2A',
  ledOff: '#3A3936',
  screen: '#070707',
  // Dark surfaces read like a screen, so colored text uses K-1's on-screen values.
  accentText: '#F29A1A',
  okText: '#6FD08C',
  dangerText: '#FF6A55',
  onInk: '#1A1A19',
  onDanger: '#1A1A19',
  diffAdded: '#172D1F',
  diffRemoved: '#321B18',
  dangerSurface: '#321B18',
  // Dark shadows: a dark top highlight instead of #fff, stronger alpha.
  shadowBlock: 'inset 0px 1px 0px #363530, 0px 1px 2px rgba(0,0,0,0.5)',
  shadowKey: 'inset 0px 1px 0px #3A3936, 0px 2px 3px rgba(0,0,0,0.5)',
  shadowKeyPressed: 'inset 0px 2px 3px rgba(0,0,0,0.5)',
  shadowField: 'inset 0px 2px 3px rgba(0,0,0,0.5)',
  shadowListPane: 'inset 0px 2px 5px rgba(0,0,0,0.5)',
  shadowSheet: 'inset 0px 1px 0px #3A3936, 0px -10px 30px rgba(0,0,0,0.6)',
};

/** LED glow: `0 0 8px <c>, 0 0 2px <c>`. */
export const ledGlow = glow;
/** Text glow (7px) with the color at 0.7–0.75 alpha, e.g. `textGlow('rgba(242,154,26,0.75)')`. */
export const textGlow = (c: string) => `0px 0px 7px ${c}`;
/** The text glows of K-1, the same in both themes. */
export const TEXT_GLOW = { accent: textGlow('rgba(242,154,26,0.75)'), ok: textGlow('rgba(111,208,140,0.7)'), danger: textGlow('rgba(255,106,85,0.7)') } as const;

export type Palette = {
  readonly mode: 'light' | 'dark';
  readonly K: { readonly [K in keyof typeof LIGHT_K]: string };
};

// Immutable definitions; the selected palette belongs to React's theme context.
export const LIGHT_PALETTE: Palette = { mode: 'light', K: LIGHT_K };
export const DARK_PALETTE: Palette = { mode: 'dark', K: DARK_K };

export const F = {
  sans: {
    '400': 'HankenGrotesk_400Regular',
    '500': 'HankenGrotesk_500Medium',
    '600': 'HankenGrotesk_600SemiBold',
    '700': 'HankenGrotesk_700Bold',
    '800': 'HankenGrotesk_800ExtraBold',
  },
  mono: {
    '400': 'MartianMono_400Regular',
    '500': 'MartianMono_500Medium',
    '600': 'MartianMono_600SemiBold',
  },
} as const;

export type SansWeight = keyof typeof F.sans;
export type MonoWeight = keyof typeof F.mono;

// K-1 text roles. `ls` is in em, as the `T`/`M` primitives take it. No text goes below 9.5.
export const TYPE = {
  title: { s: 28, w: '700', ls: -0.025 },
  subtitle: { s: 20, w: '800' },
  block: { s: 16, w: '700' },
  body: { s: 15, w: '600' },
  secondary: { s: 13, w: '400' },
  /** Mono, uppercase; +0.06–0.08em (0.57–0.76px on the canvases). */
  label: { s: 9.5, w: '600', ls: 0.07 },
  data: { s: 11, w: '400' },
  reading: { s: 20, w: '600' },
} as const satisfies Record<string, { s: number; w: SansWeight | MonoWeight; ls?: number }>;

export const RADIUS = {
  block: 20,
  keyLarge: 16,
  key: 14,
  /** Fields and recessed displays: 12–16. */
  field: 12,
  screen: 12,
  listPane: 24,
  /** 6–8. */
  chip: 6,
} as const;

// The prototype draws each phone as a 390x844 bezel with 10px padding: the screen itself is 370x824.
/** The web demo's device frame: sizes, the desk around it and the bezel, the same in both themes. */
export const FRAME = { width: 390, height: 844, bezel: 10, radius: 54, innerRadius: 44, statusBar: 50, canvas: '#1C1C1B', bezelColor: '#050505' } as const;
