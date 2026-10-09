import type { SharedPayload } from './sharedDrafts.ts';
export const SHARE_DEMOS = [
  { id: 'text', name: 'Texto / enlace' }, { id: 'image', name: 'Una imagen' },
  { id: 'rejected', name: 'No admitido' }, { id: 'empty', name: 'Sin contenido' },
  { id: 'preparing', name: 'Preparando…' }, { id: 'error', name: 'Error' },
  { id: 'offline', name: 'Sin conexión' }, { id: 'conflict', name: 'Otro borrador' }, { id: 'no-server', name: 'Sin destino' }, { id: 'new-intent', name: 'Contenido nuevo' }, { id: 'queue-full', name: 'Cola llena' }, { id: 'busy', name: 'Copia ocupada' },
];
export function demoSharePayload(id: string): SharedPayload | null {
  if (id === 'empty') return null;
  if (id === 'busy') return { kind: 'rejected', reason: 'busy' };
  if (id === 'queue-full') return { kind: 'rejected', reason: 'queue_full' };
  if (id === 'rejected') return { kind: 'rejected' };
  if (id === 'image' || id === 'preparing') return { kind: 'image', uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', width: 92, height: 58 };
  return { kind: 'text', text: 'https://vitest.dev/api/vi.html#vi-hoisted' };
}
