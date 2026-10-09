// Reads one scalar out of a YAML document made of nested block mappings, which is all relayd
// needs from Hermes's config.yaml (model.default, gateway.multiplex_profiles, ...). It is not a
// YAML parser: lists, flow collections, anchors and multi-line scalars are not understood, and a
// path that lands on any of those returns null.
export function yamlGet(text: string, path: string[]): string | null {
  // stack[i] is the key open at depth i together with the indentation it was found at.
  const stack: { key: string; indent: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([^\s#:][^:]*?)\s*:(?:\s+(.*))?$/.exec(rawLine);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].replace(/^["']|["']$/g, '');
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key, indent });

    if (stack.length !== path.length) continue;
    if (!stack.every((entry, i) => entry.key === path[i])) continue;
    const value = scalar(match[3] ?? '');
    return value === '' ? null : value;
  }
  return null;
}

function scalar(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
    return value.slice(1, value.indexOf(quote, 1));
  }
  return value.replace(/\s+#.*$/, '').trim();
}
