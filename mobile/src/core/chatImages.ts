import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE, CHAT_REQUEST_MAX_BYTES, type ChatImage, type RunRequest } from '../../../protocol/protocol.ts';

export interface PreparedImage { uri: string; image: ChatImage }
export interface ImageSource { uri: string; width: number; height: number }
export interface ImagePreparationPorts {
  transform(uri: string, size: { width: number; height: number }, quality: number): Promise<ImageSource & { base64?: string }>;
  copy(uri: string, attachmentId: string): Promise<string>;
}
export const IMAGE_TOO_LARGE = 'La imagen sigue siendo demasiado grande. Elige otra imagen más pequeña.';
export function base64Bytes(value: string): number {
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}
export async function prepareChatImage(source: ImageSource, attachmentId: string, ports: ImagePreparationPorts): Promise<PreparedImage> {
  if (!source.uri || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1) throw new Error('Esta imagen no se puede leer. Elige otra.');
  for (const [edge, quality] of [[CHAT_IMAGE_MAX_EDGE, 0.82], [1280, 0.65], [960, 0.5], [640, 0.4]]) {
    const ratio = Math.min(1, edge / Math.max(source.width, source.height));
    const size = { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)) };
    const result = await ports.transform(source.uri, size, quality);
    if (!result.base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64)) throw new Error('Esta imagen no se puede preparar. Elige otra.');
    if (base64Bytes(result.base64) > CHAT_IMAGE_MAX_BYTES) continue;
    const uri = await ports.copy(result.uri, attachmentId);
    return { uri, image: { attachmentId, mimeType: 'image/jpeg', dataBase64: result.base64, width: result.width, height: result.height } };
  }
  throw new Error(IMAGE_TOO_LARGE);
}

export function imageRunRequest(request: RunRequest, prepared: PreparedImage | null, clientMessageId: string): RunRequest {
  if (!prepared) return request;
  const decorated = { ...request, clientMessageId, images: [prepared.image] };
  if (new TextEncoder().encode(JSON.stringify(decorated)).length > CHAT_REQUEST_MAX_BYTES) throw new Error('El mensaje y la imagen son demasiado grandes. Reduce el mensaje o elige otra imagen.');
  return decorated;
}

export interface LocalImageReceipt {
  attachmentId: string; uri: string; messageIds: string[]; clientMessageId: string; runId: string;
  width: number; height: number;
}
export function bindImageReceipt(rows: LocalImageReceipt[], clientMessageId: string, messageId: string): LocalImageReceipt[] {
  return rows.map((row) => row.clientMessageId === clientMessageId ? { ...row, messageIds: [...new Set([...row.messageIds, messageId])] } : row);
}
