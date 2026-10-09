import { requireOptionalNativeModule } from 'expo';
import type { VpnNativePort } from './vpnContract';
import { UNKNOWN_VPN } from '@/core/vpn';
const module = requireOptionalNativeModule<VpnNativePort>('RelayVpnStatus');
export const vpnNative: VpnNativePort = module ?? {
  observe: async generation => ({ ...UNKNOWN_VPN, generation }),
  snapshot: async generation => ({ ...UNKNOWN_VPN, generation }),
  stop: async () => {},
  addListener: () => ({ remove() {} }),
};
