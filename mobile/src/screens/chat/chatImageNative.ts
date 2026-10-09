import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { IMAGE_TOO_LARGE, prepareChatImage, type LocalImageReceipt, type PreparedImage, type ImageSource } from '@/core/chatImages';
import { conversationRequestId } from '@/core/conversations';

export type ImageOrigin = 'camera' | 'gallery';
const directory = () => {
  if (!FileSystem.documentDirectory) throw new Error('No se puede guardar una copia de la imagen en este teléfono.');
  return `${FileSystem.documentDirectory}relay-images/`;
};
const receiptFile = (scope: string) => `${directory()}receipts-${encodeURIComponent(scope)}.json`;

export async function pickChatImage(origin: ImageOrigin): Promise<PreparedImage | null> {
  try { return await preparePickedImage(origin); }
  catch (error) {
    if (error instanceof Error && (error.message.startsWith('Relay necesita acceso ') || error.message === IMAGE_TOO_LARGE || error.message === 'Solo puedes adjuntar imágenes.' || error.message === 'No se puede guardar una copia de la imagen en este teléfono.')) throw error;
    throw new Error('Esta imagen no se puede preparar o guardar. Elige otra y revisa el espacio del teléfono.');
  }
}
async function preparePickedImage(origin: ImageOrigin): Promise<PreparedImage | null> {
  if (origin === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Relay necesita acceso a la cámara. Permítelo en los ajustes del teléfono o elige Galería.');
  } else if (Platform.OS === 'ios') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('Relay necesita acceso a tus imágenes. Permítelo en los ajustes del teléfono.');
  }
  const result = await (origin === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync)({ mediaTypes: ['images'], allowsMultipleSelection: false, allowsEditing: false, quality: 1 });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset || asset.type && asset.type !== 'image') throw new Error('Solo puedes adjuntar imágenes.');
  const attachmentId = `img-${conversationRequestId()}`;
  return prepareSharedChatImage(asset, attachmentId);
}

export async function prepareSharedChatImage(source: ImageSource, attachmentId = `img-${conversationRequestId()}`): Promise<PreparedImage> {
  return prepareChatImage(source, attachmentId, {
    async transform(uri, size, quality) {
      const context = ImageManipulator.manipulate(uri);
      try {
        context.resize(size);
        const rendered = await context.renderAsync();
        try { return await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true }); }
        finally { rendered.release(); }
      } finally { context.release(); }
    },
    async copy(uri, id) {
      const root = directory(); await FileSystem.makeDirectoryAsync(root, { intermediates: true });
      const target = `${root}${id}.jpg`;
      await FileSystem.copyAsync({ from: uri, to: target });
      return target;
    },
  });
}

export async function loadImageReceipts(scope: string): Promise<LocalImageReceipt[]> {
  const file = receiptFile(scope);
  if (!(await FileSystem.getInfoAsync(file)).exists) return [];
  const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(file));
  if (!Array.isArray(parsed)) throw new Error('Las miniaturas guardadas no se pudieron leer.');
  return parsed.filter((row): row is LocalImageReceipt => !!row && typeof row === 'object' && typeof row.uri === 'string' && row.uri === `${directory()}${row.attachmentId}.jpg`
    && typeof row.attachmentId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(row.attachmentId) && Array.isArray(row.messageIds) && row.messageIds.every((id: unknown) => typeof id === 'string')
    && typeof row.clientMessageId === 'string' && typeof row.runId === 'string' && Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height));
}
export async function saveImageReceipts(scope: string, rows: LocalImageReceipt[]): Promise<void> {
  await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
  await FileSystem.writeAsStringAsync(receiptFile(scope), JSON.stringify(rows));
}
export async function discardChatImage(image: PreparedImage): Promise<void> {
  if (image.uri.startsWith(directory())) await FileSystem.deleteAsync(image.uri, { idempotent: true });
}
