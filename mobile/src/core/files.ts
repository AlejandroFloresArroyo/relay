export function localFileName(name: string): string {
  const safe = name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').slice(0, 140).trim();
  return safe || 'Archivo';
}
export function fileSize(bytes: number | null): string {
  if (bytes === null) return 'TAMAÑO DESCONOCIDO';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function fileBadge(name: string): string { return (name.includes('.') ? name.split('.').at(-1) : 'FILE')!.slice(0, 5).toUpperCase(); }
