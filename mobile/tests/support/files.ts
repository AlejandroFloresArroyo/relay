const unavailable = (..._args: unknown[]): unknown => { throw new Error('File fixture is not configured'); };
const unavailableAsync = async (...args: unknown[]): Promise<unknown> => unavailable(...args);
export const fileSystem = {
  File: Object.assign(jest.fn(unavailable), { pickFileAsync: jest.fn(unavailableAsync) }), Directory: jest.fn(unavailable),
  FileMode: { WriteOnly: 'w' },
  Paths: { document: { uri: 'file:///fixture/documents/' }, cache: { uri: 'file:///fixture/cache/' } },
};
export const legacyFileSystem = {
  documentDirectory: 'file:///fixture/documents/', cacheDirectory: 'file:///fixture/cache/',
  getInfoAsync: jest.fn(unavailableAsync), readAsStringAsync: jest.fn(unavailableAsync), writeAsStringAsync: jest.fn(unavailableAsync),
  makeDirectoryAsync: jest.fn(unavailableAsync), copyAsync: jest.fn(unavailableAsync), deleteAsync: jest.fn(unavailableAsync),
  getContentUriAsync: jest.fn(unavailableAsync), EncodingType: { Base64: 'base64', UTF8: 'utf8' },
};
export const sharing = { isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn(unavailableAsync) };
export const intentLauncher = { startActivityAsync: jest.fn(unavailableAsync), ActivityAction: { VIEW: 'android.intent.action.VIEW' } };
export function resetFiles() {
  localFiles.clear(); fileOperations.length = 0;
  fileSystem.File.mockReset().mockImplementation(unavailable); fileSystem.Directory.mockReset().mockImplementation(unavailable);
  fileSystem.File.pickFileAsync.mockReset().mockImplementation(unavailableAsync);
  for (const value of Object.values(legacyFileSystem)) if (typeof value === 'function') value.mockReset().mockImplementation(unavailableAsync);
  sharing.isAvailableAsync.mockReset().mockResolvedValue(false); sharing.shareAsync.mockReset().mockImplementation(unavailableAsync);
  intentLauncher.startActivityAsync.mockReset().mockImplementation(unavailableAsync);
  fileSystem.File.pickFileAsync.mockReset().mockImplementation(unavailableAsync);
}

export const localFiles = new Map<string, number[]>();
export const fileOperations: { kind: string; uri: string }[] = [];
export function configureLocalFiles() {
  const uriFor = (parts: unknown[]) => parts.map((part) => typeof part === 'string' ? part : (part as { uri: string }).uri).join('/').replace(/([^:])\/{2,}/g, '$1/');
  fileSystem.Directory.mockImplementation((...parts: unknown[]) => ({ uri: uriFor(parts), create: jest.fn() }));
  fileSystem.File.mockImplementation((...parts: unknown[]) => {
    const result = {
      uri: uriFor(parts),
      get exists() { return localFiles.has(result.uri); },
      get size() { return localFiles.get(result.uri)?.length ?? 0; },
      get contentUri() { return 'content://fixture/' + encodeURIComponent(result.uri); },
      create: () => { fileOperations.push({ kind: 'create', uri: result.uri }); localFiles.set(result.uri, []); },
      delete: () => { fileOperations.push({ kind: 'delete', uri: result.uri }); localFiles.delete(result.uri); },
      open: () => ({ writeBytes: (bytes: Uint8Array) => { fileOperations.push({ kind: 'write', uri: result.uri }); localFiles.get(result.uri)!.push(...bytes); }, close: jest.fn() }),
      async move(destination: { uri: string }) { fileOperations.push({ kind: 'move', uri: destination.uri }); localFiles.set(destination.uri, localFiles.get(result.uri)!); localFiles.delete(result.uri); result.uri = destination.uri; },
    };
    return result;
  });
  sharing.isAvailableAsync.mockResolvedValue(true); sharing.shareAsync.mockResolvedValue(undefined);
  intentLauncher.startActivityAsync.mockResolvedValue({ resultCode: -1 });
}

/** The next system picker answers this phone file, read through a handle at any offset. */
export function pickPhoneFile(name: string, bytes: Uint8Array) {
  const uri = `content://fixture/picked/${encodeURIComponent(name)}`;
  const file = {
    name, uri, size: bytes.length,
    open: () => {
      fileOperations.push({ kind: 'open', uri });
      const handle = {
        offset: 0 as number | null,
        readBytes: (length: number) => { const start = handle.offset ?? 0; const read = bytes.slice(start, start + length); handle.offset = start + read.length; return read; },
        close: () => { fileOperations.push({ kind: 'close', uri }); },
      };
      return handle;
    },
  };
  fileSystem.File.pickFileAsync.mockResolvedValueOnce({ canceled: false, result: file });
  return file;
}
