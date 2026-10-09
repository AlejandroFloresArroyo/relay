import type { Approval } from '../../protocol/protocol.ts';

type Level = 1 | 2 | 3 | 4 | 5;

const LABELS: Record<Level, string> = {
  1: 'RIESGO MÍNIMO',
  2: 'RIESGO BAJO',
  3: 'RIESGO MEDIO',
  4: 'RIESGO ALTO',
  5: 'RIESGO CRÍTICO',
};

// Hermes sends no risk level with an approval, only `pattern_key`: the name of the rule in
// tools/approval_detection.py (DANGEROUS_PATTERNS) that flagged the command. This table ranks
// those names. It is static and deliberately small: first match wins, and a pattern that matches
// nothing gets no risk at all (the app then shows the command without a badge) instead of a guess.
//
//   5 CRÍTICO  irreversible damage to the machine: wipes the root path, a disk, or every process
//   4 ALTO     runs code fetched from elsewhere, drops data, or rewrites system/credential files
//   3 MEDIO    destructive but scoped: deletes a tree, kills or stops something, rewrites project env
const TABLE: [RegExp, Level][] = [
  [/delete in root path|format filesystem|format drive|wipe disk|wipe free space|disk partitioning/, 5],
  [/disk copy|write to block device|fork bomb|kill all processes/, 5],
  [/delete volume shadow copies|delete backups|modify boot configuration/, 5],

  [/pipe remote content|execute remote|pipe .*(decoded|transformed).* to shell|encoded command/, 4],
  [/sql (drop|truncate|delete)/, 4],
  [/overwrite system (config|file)|cloud metadata endpoint|access to (ssh keys|hermes secrets)/, 4],
  [/chown to root|world\/other-writable|grant everyone access|reset acls|registry (value )?delete/, 4],

  [/recursive delete|destructive delete|xargs with rm|find -exec/, 3],
  [/force kill processes|kill processes by regex|stop\/restart system service|stop\/delete service|force stop service/, 3],
  [/overwrite project env\/config/, 3],
];

export function riskFor(patternKey: string | null, description: string | null): Approval['risk'] {
  const key = (patternKey ?? '').trim().toLowerCase();
  if (!key) return null;
  for (const [pattern, level] of TABLE) {
    if (pattern.test(key)) {
      return { level, label: LABELS[level], summary: description?.trim() || (patternKey ?? '').trim() };
    }
  }
  return null;
}
