export const clipboard = {
  setStringAsync: jest.fn(async (_text: string) => true),
  getStringAsync: jest.fn(async () => ''),
};
export function resetClipboard() {
  clipboard.setStringAsync.mockReset().mockResolvedValue(true);
  clipboard.getStringAsync.mockReset().mockResolvedValue('');
}
