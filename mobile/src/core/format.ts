// Pure formatters for the labels the design shows. No React / React Native imports here so
// they run under `node --test`.

const pad2 = (n: number) => String(n).padStart(2, '0');
const DAYS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];

const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const dayDiff = (a: number, b: number) => Math.round((dayStart(a) - dayStart(b)) / 86_400_000);

/** "ahora" / "14:02" / "ayer" / "28/09" — the timestamp on an agent row. */
export function relTime(at: number, now: number): string {
  if (now - at < 60_000) return 'ahora';
  const days = dayDiff(now, at);
  const d = new Date(at);
  if (days === 0) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (days === 1) return 'ayer';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

/** "hace 9 h" — time since a server last answered. */
export function ago(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
  return `hace ${Math.floor(min / 1440)} d`;
}

/** "6D 04:12" once past a day, "04:12" before, "00:00" when unknown. */
export function uptime(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const days = Math.floor(m / 1440);
  const hhmm = `${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`;
  return days > 0 ? `${days}D ${hhmm}` : hhmm;
}

/** "4:32" — time left on an approval. Clamps at 0:00. */
export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** "MAÑ 09:00" / "LUN 10:00" / "PAUSADA" — next run of a scheduled job. */
export function nextRun(at: number | null, enabled: boolean, now: number): string {
  if (!enabled || at == null) return 'PAUSADA';
  const d = new Date(at);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = dayDiff(at, now);
  if (days <= 0) return `HOY ${hhmm}`;
  if (days === 1) return `MAÑ ${hhmm}`;
  if (days < 7) return `${DAYS[d.getDay()]} ${hhmm}`;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hhmm}`;
}

/** "••••••••••••••3f9a" — how a stored key is shown. */
export function maskKey(key: string): string {
  if (!key) return '';
  return '•'.repeat(14) + key.slice(-4);
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'LEER',
  search_files: 'LEER',
  terminal: 'EJEC',
  process: 'EJEC',
  execute_code: 'EJEC',
  web_search: 'WEB',
  web_extract: 'WEB',
  browser_navigate: 'WEB',
  patch: 'EDIT',
  write_file: 'EDIT',
};

/** LEER / EJEC / WEB / EDIT, or the first 4 letters of an unknown tool. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase();
}

/** Strips scheme and trailing slash: "https://atlas.ts.net/" -> "atlas.ts.net". */
export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/** One-line preview of an assistant message: no markdown markers, no line breaks. */
export function plainPreview(text: string): string {
  return text
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

/** Latency label: "42 MS". */
export function ms(n: number): string {
  return `${Math.round(n)} MS`;
}

/**
 * True when a scrolled list sits at its end, give or take `slack` points. The chat follows new
 * content only while this holds, so reading older messages is not interrupted by a streaming reply.
 */
export function nearEnd(m: { offset: number; viewport: number; content: number }, slack = 80): boolean {
  return m.content - m.viewport - m.offset <= slack;
}
