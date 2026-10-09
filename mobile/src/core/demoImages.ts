import { RelayError, type RelayClient } from './client.ts';
import { IMAGE_TOO_LARGE, type LocalImageReceipt, type PreparedImage } from './chatImages.ts';
import { conversationRequestId } from './conversations.ts';

export const DEMO_IMAGE_SCENARIOS = [
  { id: 'ready', name: 'Imagen preparada' }, { id: 'preparing', name: 'Preparando imagen…' },
  { id: 'permission', name: 'Permiso denegado' }, { id: 'cancelled', name: 'Selección cancelada' },
  { id: 'too-large', name: 'Imagen demasiado grande' }, { id: 'send-error', name: 'Envío rechazado' },
  { id: 'missing', name: 'Miniatura no disponible' },
] as const;
export type DemoImageScenario = (typeof DEMO_IMAGE_SCENARIOS)[number]['id'];
const scenarios = new Map<string, DemoImageScenario>();
const receipts = new Map<string, LocalImageReceipt[]>();
export const demoImageScenario = (serverId: string): DemoImageScenario => scenarios.get(serverId) ?? 'ready';
export function setDemoImageScenario(serverId: string, scenario: DemoImageScenario) { scenarios.set(serverId, scenario); }
export function resetDemoImages() { scenarios.clear(); receipts.clear(); }
export function demoImageReceipts(scope: string) { return receipts.get(scope) ?? []; }
export function saveDemoImageReceipts(scope: string, rows: LocalImageReceipt[]) { receipts.set(scope, rows); }
export async function demoPickImage(serverId: string): Promise<PreparedImage | null> {
  const scenario = demoImageScenario(serverId);
  if (scenario === 'permission') throw new Error('Relay necesita acceso a la cámara. Permítelo en los ajustes del teléfono o elige Galería.');
  if (scenario === 'cancelled') return null;
  if (scenario === 'too-large') throw new Error(IMAGE_TOO_LARGE);
  if (scenario === 'preparing') await new Promise<void>((resolve) => setTimeout(resolve, 1800));
  // Reuses the existing demo avatar; no user photo is bundled.
  const base64 = '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';
  return { uri: `data:image/png;base64,${base64}`, image: { attachmentId: `img-${conversationRequestId()}`, mimeType: 'image/png', dataBase64: base64, width: 92, height: 58 } };
}
export function createDemoImages(serverId: string, _now: () => number, startRun?: RelayClient['startRun']): Partial<RelayClient> {
  return startRun ? { async startRun(agentId, request) {
    if (request.images && demoImageScenario(serverId) === 'send-error') throw new RelayError('invalid_image', 'Esta imagen no se pudo enviar. Elige otra imagen.', 400);
    return startRun(agentId, request);
  } } : {};
}
