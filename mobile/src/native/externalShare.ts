import { requireOptionalNativeModule } from 'expo';
import { validateSharedPayload } from '@/core/sharedDrafts';
interface NativeReceiver {
  pending(): Promise<string[]>;
  read(token: string): Promise<unknown>;
  discard(token: string): Promise<void>;
  addListener(event: 'pending', listener: () => void): { remove(): void };
}
const receiver = requireOptionalNativeModule<NativeReceiver>('RelayShareReceiver');
export const shareReceiver = {
  async pending() { return (await receiver?.pending() ?? []).filter((token) => /^[a-f0-9-]{36}$/.test(token)).slice(0, 4); },
  async read(token: string) { return validateSharedPayload(await receiver?.read(token)); },
  async discard(token: string) { await receiver?.discard(token); },
  subscribe(listener: () => void) { return receiver?.addListener('pending', listener) ?? { remove() {} }; },
};
