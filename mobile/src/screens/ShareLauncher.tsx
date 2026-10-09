import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { router, usePathname } from 'expo-router';
import { shareReceiver } from '@/native/externalShare';
import { useChatVisible } from '@/state/chatVisibility';
import { addWindowFocusListener } from '@/state/windowFocus';
// Routing carries no payload. A generic deep link cannot manufacture a native capability.
export function ShareLauncher() {
  const visible = useChatVisible(); const pathname = usePathname();
  const announced = useRef('');
  const windowScope = useRef({ focused: true, revision: 0 });
  useEffect(() => {
    let alive = true; const window = windowScope.current;
    const check = async () => {
      if (!visible || !window.focused || AppState.currentState !== 'active') return;
      const revision = window.revision;
      try {
        const pending = await shareReceiver.pending();
        if (!alive || !visible || !window.focused || revision !== window.revision || AppState.currentState !== 'active') return;
        if (!pending.length) announced.current = '';
        else if (!pathname.startsWith('/share') && announced.current !== pending.join(',')) {
          announced.current = pending.join(','); router.push('/share');
        }
      } catch { /* An unavailable receiver grants no route content. */ }
    };
    void check(); const sub = shareReceiver.subscribe(() => { void check(); });
    const app = AppState.addEventListener('change', () => { void check(); });
    const blur = addWindowFocusListener('blur', () => { window.focused = false; window.revision++; });
    const focus = addWindowFocusListener('focus', () => { window.focused = true; void check(); });
    return () => { alive = false; window.revision++; sub.remove(); app.remove(); blur.remove(); focus.remove(); };
  }, [visible, pathname]);
  return null;
}
