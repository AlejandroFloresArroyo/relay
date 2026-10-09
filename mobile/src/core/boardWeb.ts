/** Encode bounded native payloads without Buffer, filesystem paths or browser-only globals. */
export function boardWebBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    parts.push(alphabet[a >>> 2] + alphabet[(a & 3) << 4 | b >>> 4] + (i + 1 < bytes.length ? alphabet[(b & 15) << 2 | c >>> 6] : '=') + (i + 2 < bytes.length ? alphabet[c & 63] : '='));
  }
  return parts.join('');
}
