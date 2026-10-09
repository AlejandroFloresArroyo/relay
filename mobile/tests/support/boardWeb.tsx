import type { BoardWebCapability } from '@/native/boardWeb';
import { useEffect } from 'react';
import { View } from 'react-native';
export const boardWebNative = {
  capability: jest.fn<BoardWebCapability, []>(() => ({ state: 'verified' as const, cause: 'native_matrix_verified' })),
  beginGeneration: jest.fn(() => 'generation-fixture'),
  createSnapshot: jest.fn<Promise<string>, [string, string, string]>(async () => 'snapshot-fixture'),
  putAsset: jest.fn<Promise<void>, [string, string, string, string]>(async () => {}),
  sealSnapshot: jest.fn<Promise<string>, [string, string]>(async (_generation, id) => id),
  retireGeneration: jest.fn((_generation: string) => {}),
};
export const nativeFailures: (() => void)[] = [];
export function NativeBoardWebView({ snapshotId, onFailure }: { snapshotId: string; onFailure?: () => void }) { useEffect(() => { if (onFailure) nativeFailures.push(onFailure); }, [onFailure]); return <View testID="board-web-native" accessibilityLabel={`Web snapshot ${snapshotId}`} />; }
export function resetBoardWeb() {
  nativeFailures.length = 0;
  boardWebNative.capability.mockReset().mockReturnValue({ state: 'verified', cause: 'native_matrix_verified' });
  let generations = 0; boardWebNative.beginGeneration.mockReset().mockImplementation(() => `generation-${++generations}`);
  boardWebNative.createSnapshot.mockReset().mockResolvedValue('snapshot-fixture'); boardWebNative.putAsset.mockReset().mockResolvedValue(undefined);
  boardWebNative.sealSnapshot.mockReset().mockImplementation(async (_generation, id) => id); boardWebNative.retireGeneration.mockReset();
}
