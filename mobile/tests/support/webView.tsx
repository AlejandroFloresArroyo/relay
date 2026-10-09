import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { View } from 'react-native';

// Stands in for react-native-webview, a native boundary: it keeps the props the screen passed, so a
// test can read the source and the policy and fire the native events, and the imperative methods.
type Props = Record<string, unknown> & { source?: unknown };
interface Mounted { props: Props; goBack: jest.Mock; reload: jest.Mock; injectJavaScript: jest.Mock; alive: boolean }
export const webViews: Mounted[] = [];

export function WebView({ ref, ...props }: Props & { ref?: Ref<unknown> }) {
  const [methods] = useState(() => ({ goBack: jest.fn(), reload: jest.fn(), injectJavaScript: jest.fn() }));
  const mounted = useRef<Mounted | null>(null);
  useLayoutEffect(() => { if (mounted.current) mounted.current.props = props; });
  useLayoutEffect(() => {
    const created: Mounted = { props, ...methods, alive: true };
    webViews.push(created);
    mounted.current = created;
    return () => { created.alive = false; };
    // Mounted once; the effect above keeps its props current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useImperativeHandle(ref, () => methods, [methods]);
  return <View accessibilityLabel="Página de la aplicación" />;
}
export default WebView;

/** The WebView on screen now: the last one mounted and alive. */
export function webView(): Mounted {
  const alive = webViews.filter((each) => each.alive);
  if (!alive.length) throw new Error('No WebView is mounted.');
  return alive.at(-1)!;
}
export const liveWebViews = () => webViews.filter((each) => each.alive).length;
/** A native event as react-native-webview delivers it to the handler. */
export const nativeEvent = <T extends object>(detail: T) => ({ nativeEvent: detail });
export function resetWebViews() { webViews.length = 0; }
