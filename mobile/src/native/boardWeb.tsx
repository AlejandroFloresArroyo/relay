import { Platform, type ViewProps } from 'react-native';
import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { ComponentType } from 'react';
export type BoardWebCapability = { state: 'verified' | 'unverified' | 'unsupported'; cause: string; provider?: Record<string, string | number> };
interface BoardWebNative {
  capability(): BoardWebCapability;
  beginGeneration(): string;
  createSnapshot(generation: string, revision: string, canonical: string): Promise<string>;
  putAsset(generation: string, snapshot: string, name: string, encoded: string): Promise<void>;
  sealSnapshot(generation: string, snapshot: string): Promise<string>;
  retireGeneration(generation: string): void;
}
export type BoardWebViewProps = ViewProps & { snapshotId: string; onFailure?: () => void };
let native: BoardWebNative | null = null;
let NativeView: ComponentType<BoardWebViewProps> | null = null;
if (Platform.OS === 'android') {
  try {
    native = requireOptionalNativeModule<BoardWebNative>('RelayBoardWeb');
    if (native) NativeView = requireNativeViewManager('RelayBoardWeb');
  } catch { native = null; NativeView = null; }
}
const missing = () => { throw new Error('board_web_native_missing'); };
export const boardWebNative: BoardWebNative = native && NativeView ? native : {
  capability: () => ({ state: 'unsupported', cause: 'native_missing' }), beginGeneration: missing,
  createSnapshot: async () => missing(), putAsset: async () => missing(), sealSnapshot: async () => missing(), retireGeneration: () => {},
};
export function NativeBoardWebView(props: BoardWebViewProps) { return NativeView ? <NativeView {...props} /> : null; }
