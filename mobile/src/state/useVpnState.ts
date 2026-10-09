import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { UNKNOWN_VPN, validVpnReading } from '@/core/vpn';
import type { VpnReading } from '@/native/vpnContract';
import { vpnNative } from '@/native/vpnStatus';
import { addWindowFocusListener } from './windowFocus';
let nextGeneration = 0;
export function useVpnState(scope: object, enabled: boolean): VpnReading {
  const [value, setValue] = useState<{ scope: object; reading: VpnReading }>(() => ({ scope, reading: UNKNOWN_VPN }));
  useEffect(() => {
    let retire = () => {};
    const clear = () => { retire(); setValue({ scope, reading: { ...UNKNOWN_VPN, reason: 'inactive' } }); };
    const begin = () => {
      retire();
      if (!enabled || AppState.currentState !== 'active') { clear(); return; }
      nextGeneration = nextGeneration % 2147483647 + 1;
      const generation = nextGeneration; let alive = true; let sequence = -1;
      setValue({ scope, reading: { ...UNKNOWN_VPN, generation, reason: 'transition' } });
      const accept = (raw: unknown) => {
        if (!alive) return;
        const reading = validVpnReading(raw, generation);
        if (!reading || reading.sequence <= sequence) return;
        sequence = reading.sequence; setValue({ scope, reading });
      };
      let subscription: { remove(): void } | undefined;
      retire = () => {
        if (!alive) return;
        alive = false; subscription?.remove();
        void Promise.resolve().then(() => vpnNative.stop(generation)).catch(() => {});
      };
      try {
        subscription = vpnNative.addListener('onNetworkChanged', accept);
        void Promise.resolve().then(() => vpnNative.observe(generation)).then(accept, () => {
          if (alive && sequence < 0) setValue({ scope, reading: { ...UNKNOWN_VPN, generation } });
        });
      } catch {
        retire(); setValue({ scope, reading: { ...UNKNOWN_VPN, generation } });
      }
    };
    const change = AppState.addEventListener('change', state => { if (state === 'active') begin(); else clear(); });
    const blur = addWindowFocusListener('blur', clear);
    const focus = addWindowFocusListener('focus', begin);
    begin();
    return () => { retire(); change.remove(); blur.remove(); focus.remove(); };
  }, [scope, enabled]);
  return value.scope === scope && enabled ? value.reading : UNKNOWN_VPN;
}
