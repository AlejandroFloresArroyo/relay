const unavailable = async (_options?: unknown): Promise<unknown> => { throw new Error('Image fixture is not configured'); };
import { legacyFileSystem } from './files';
export const imageFiles = new Map<string, string>();
export function configureImageStorage() {
  legacyFileSystem.getInfoAsync.mockImplementation(async (uri: unknown) => ({ exists: imageFiles.has(String(uri)), uri, isDirectory: false, size: 10 }));
  legacyFileSystem.makeDirectoryAsync.mockResolvedValue(undefined);
  legacyFileSystem.readAsStringAsync.mockImplementation(async (uri: unknown) => {
    const value = imageFiles.get(String(uri)); if (value === undefined) throw new Error('Image file fixture does not exist'); return value;
  });
  legacyFileSystem.writeAsStringAsync.mockImplementation(async (uri: unknown, value: unknown) => { imageFiles.set(String(uri), String(value)); });
  legacyFileSystem.copyAsync.mockImplementation(async (options: unknown) => {
    const { from, to } = options as { from: string; to: string };
    if (!imageFiles.has(from)) throw new Error('Image source fixture does not exist'); imageFiles.set(to, imageFiles.get(from)!);
  });
  legacyFileSystem.deleteAsync.mockImplementation(async (uri: unknown) => { imageFiles.delete(String(uri)); });
}
export function imageResult(base64 = '/9j/', width = 1600, height = 1200) {
  imageFiles.set('file:///fixture/cache/reduced.jpg', base64);
  const saveAsync = jest.fn(async () => ({ uri: 'file:///fixture/cache/reduced.jpg', base64, width, height }));
  const rendered = { saveAsync, release: jest.fn() };
  const context = { resize: jest.fn(), renderAsync: jest.fn(async () => rendered), release: jest.fn() };
  imageManipulator.ImageManipulator.manipulate.mockReturnValue(context);
  return { context, rendered };
}
export const imagePicker = {
  launchCameraAsync: jest.fn(unavailable), launchImageLibraryAsync: jest.fn(unavailable),
  requestCameraPermissionsAsync: jest.fn(unavailable), requestMediaLibraryPermissionsAsync: jest.fn(unavailable),
  getCameraPermissionsAsync: jest.fn(unavailable), getMediaLibraryPermissionsAsync: jest.fn(unavailable),
};
export const imageManipulator = {
  manipulateAsync: jest.fn(async (..._args: unknown[]): Promise<unknown> => unavailable()),
  ImageManipulator: { manipulate: jest.fn((_source: unknown): unknown => { throw new Error('Image fixture is not configured'); }) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
};
export function resetImages() {
  imageFiles.clear();
  for (const mock of Object.values(imagePicker)) mock.mockReset().mockImplementation(unavailable);
  imageManipulator.manipulateAsync.mockReset().mockImplementation(async () => unavailable());
  imageManipulator.ImageManipulator.manipulate.mockReset().mockImplementation(() => { throw new Error('Image fixture is not configured'); });
}
