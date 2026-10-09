import { CHAT_FILE_MAX_COUNT, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_COUNT, CHAT_IMAGE_MAX_EDGE, CHAT_REQUEST_MAX_BYTES, type ChatFileReference, type ChatImage } from '../../protocol/protocol.ts';
import { PERSONALITY_OVERLAY_MAX_BYTES } from '../../protocol/personalityPresets.ts';
import { exactObject } from './changeLog.ts';
import type { PreparedRunRequest } from './chatPorts.ts';
import { HermesError } from './hermes.ts';

/** Validates before any Conversation or Turn write; messages never quote payloads. */
export function parseChatImages(value: unknown): ChatImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > CHAT_IMAGE_MAX_COUNT) throw new HermesError('invalid_image', 'Adjunta una sola imagen.');
  return value.map((image: unknown) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) throw new HermesError('invalid_image', 'La imagen no es válida.');
    const row = image as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['attachmentId', 'mimeType', 'dataBase64', 'width', 'height'].includes(key))
      || typeof row.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(row.attachmentId)
      || !['image/jpeg', 'image/png', 'image/webp'].includes(String(row.mimeType))
      || !Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height) || Number(row.width) < 1 || Number(row.height) < 1 || Number(row.width) > CHAT_IMAGE_MAX_EDGE || Number(row.height) > CHAT_IMAGE_MAX_EDGE
      || typeof row.dataBase64 !== 'string') throw new HermesError('invalid_image', 'La imagen no es válida.');
    const encoded = row.dataBase64;
    if (encoded.length > Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4) throw new HermesError('image_too_large', 'La imagen es demasiado grande.');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) throw new HermesError('invalid_image', 'La imagen no es válida.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > CHAT_IMAGE_MAX_BYTES) throw new HermesError('image_too_large', 'La imagen es demasiado grande.');
    if (bytes.toString('base64') !== encoded) throw new HermesError('invalid_image', 'La imagen no es válida.');
    const valid = row.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : row.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new HermesError('invalid_image', 'El contenido no coincide con el tipo de imagen.');
    return { attachmentId: row.attachmentId, mimeType: row.mimeType, dataBase64: encoded, width: row.width, height: row.height } as ChatImage;
  });
}

/** #114: the `chat_files` contract this build serves; advertised only when Archivos is wired. */
export const CHAT_FILES_CAPABILITY = { version: 1, minAppVersion: 1 } as const;

/** Only the shape: 1..CHAT_FILE_MAX_COUNT `{ path }` objects. The file service checks each path. */
export function parseChatFiles(value: unknown): ChatFileReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > CHAT_FILE_MAX_COUNT) throw new HermesError('invalid_request', 'Adjunta de 1 a 5 archivos.');
  return value.map((file: unknown) => {
    if (!exactObject(file, ['path']) || typeof file.path !== 'string') throw new HermesError('invalid_request', 'El archivo adjunto no es válido.');
    return { path: file.path };
  });
}

export function hermesRunBody(request: PreparedRunRequest): Record<string, unknown> {
  const images = parseChatImages(request.images);
  const body: Record<string, unknown> = { input: images ? [
    ...(request.input ? [{ type: 'text', text: request.input }] : []),
    ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` } })),
  ] : request.input };
  if (request.instructions !== undefined) {
    if (typeof request.instructions !== 'string' || Buffer.byteLength(request.instructions) > PERSONALITY_OVERLAY_MAX_BYTES || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(request.instructions)) throw new HermesError('invalid_request', 'La personalidad de la Conversación no es válida.');
    body.instructions = request.instructions;
  }
  if (request.sessionId) body.session_id = request.sessionId;
  if (request.model) { body.model = request.model.model; body.provider = request.model.provider; }
  if (Buffer.byteLength(JSON.stringify(body)) > CHAT_REQUEST_MAX_BYTES) throw new HermesError('image_too_large', 'El mensaje y la imagen son demasiado grandes.');
  return body;
}
