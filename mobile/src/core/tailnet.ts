/** The tailnet's name from the first Servidor host under `<tailnet>.ts.net`, uppercased; null when none is. */
export function tailnetName(urls: readonly string[]): string | null {
  for (const url of urls) {
    let host: string;
    try { host = new URL(url).hostname; } catch { continue; }
    const match = /\.([a-z0-9-]+)\.ts\.net$/i.exec(host);
    if (match) return match[1].toUpperCase();
  }
  return null;
}
