import { AccessibilityInfo, Appearance, AppState, BackHandler, Dimensions, DeviceEventEmitter, Linking, type ColorSchemeName, type AppStateStatus } from 'react-native';
import { TABS, type NavRoute, type NavState } from '@/core/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

export const clockStart = Date.parse('2026-10-03T12:00:00Z');
const pending = new Set<() => void>();
export function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  // Cancellation can also retire a fixture that failed before any consumer awaited it.
  void promise.catch(() => {});
  const cancel = () => rejectPromise(new Error('Fixture cancelled'));
  pending.add(cancel);
  return {
    promise,
    resolve(value: T) { pending.delete(cancel); resolvePromise(value); },
    reject(error: unknown) { pending.delete(cancel); rejectPromise(error); },
  };
}
export async function cancelDeferred() {
  for (const cancel of pending) cancel();
  pending.clear();
}
export const stored = new Map<string, string>();
export const storageFailures = { read: new Set<string>(), write: new Set<string>() };
const storageDefaults = {
  async getItemAsync(key: string) {
    if (storageFailures.read.has(key)) throw new Error('Fixture storage read failure');
    return stored.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string) {
    if (storageFailures.write.has(key)) throw new Error('Fixture storage write failure');
    stored.set(key, value);
  },
  async deleteItemAsync(key: string) { stored.delete(key); },
};
export const secureStore = {
  getItemAsync: jest.fn(storageDefaults.getItemAsync),
  setItemAsync: jest.fn(storageDefaults.setItemAsync),
  deleteItemAsync: jest.fn(storageDefaults.deleteItemAsync),
};
export const biometrics = {
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn<Promise<{ success: boolean }>, [unknown]>(async () => ({ success: false })),
};
type CameraPermission = { granted: boolean; canAskAgain: boolean; status: string; expires: string };
export const camera: { permission: CameraPermission; request: jest.Mock<Promise<CameraPermission>, []> } = {
  permission: { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' },
  request: jest.fn(async () => camera.permission),
};
export function useCameraPermissions() { return [camera.permission, camera.request]; }
const appListeners = new Set<{ type: string; listener: (state: AppStateStatus) => void }>();
const linkListeners = new Set<(event: { url: string }) => void>();
export const router = {
  push: jest.fn(), replace: jest.fn(), navigate: jest.fn(), back: jest.fn(), dismissTo: jest.fn(), canGoBack: jest.fn(() => false),
};
/** `state` is the navigation container's root state: returns read it. */
export const navigation = { focused: true, pathname: '/agents', stackContent: null as ReactNode, params: {} as Record<string, string>, state: undefined as NavState | undefined };
// The route the Stack shows: the root layout's Shell and tools host read it, and change with it.
const routeListeners = new Set<() => void>();
const onRoute = (listener: () => void) => { routeListeners.add(listener); return () => { routeListeners.delete(listener); }; };
export function usePathname() { return useSyncExternalStore(onRoute, () => navigation.pathname); }
export function useGlobalSearchParams() { return useSyncExternalStore(onRoute, () => navigation.params); }
/** The container ref of `useNavigationContainerRef`: its state and its 'state' event follow `showRoute`. */
export const navigationContainer = {
  isReady: () => true,
  getRootState: () => navigation.state,
  addListener: (_event: 'state', listener: () => void) => onRoute(listener),
};
/** The Stack shows another route: what is on screen re-renders; the screens below stay mounted. */
export function showRoute(pathname: string, params: Record<string, string> = {}, state: NavState | undefined = navigation.state) {
  navigation.pathname = pathname; navigation.params = params; navigation.state = state;
  for (const listener of routeListeners) listener();
}
/** The container's state for a root stack of these entries, the last one on top, inside expo-router's `__root` slot as on a phone. */
export function stackOf(...routes: NavRoute[]): NavState { return { index: 0, routes: [{ name: '__root', state: { index: routes.length - 1, routes } }] }; }
/** The `(tabs)` entry with `focused` shown, after visiting the tabs in `history`. */
export function tabsRoute(focused: string, history: string[] = [focused]): NavRoute {
  return { name: '(tabs)', key: 'tabs', state: { index: TABS.findIndex(tab => tab.key === focused), routes: TABS.map(tab => ({ name: tab.key, key: `${tab.key}-key` })), history: history.map(key => ({ type: 'route', key: `${key}-key` })) } };
}
/** Android's back key: the newest listener that handles it wins; with none, the app would exit. */
export function pressBack() { DeviceEventEmitter.emit('hardwareBackPress'); }
export function useFocusEffect(callback: () => void | (() => void)) {
  useEffect(() => navigation.focused ? callback() : undefined, [callback, navigation.focused]);
}
export function emitAppState(state: AppStateStatus) {
  AppState.currentState = state;
  for (const entry of appListeners) if (entry.type === 'change') entry.listener(state);
}
export function emitAppBlur() { for (const entry of appListeners) if (entry.type === 'blur') entry.listener(AppState.currentState); }
export function emitAppFocus() { for (const entry of appListeners) if (entry.type === 'focus') entry.listener(AppState.currentState); }
export function emitLink(url: string) { for (const listener of linkListeners) listener({ url }); }
export function subscriptionCounts() { return { app: appListeners.size, links: linkListeners.size }; }
export function resizeWindow(width: number, height: number, fontScale = 1) {
  Dimensions.set({ window: { width, height, scale: 1, fontScale }, screen: { width, height, scale: 1, fontScale } });
}
export function emitKeyboard(visible: boolean) {
  // Android reports the keyboard's top in window coordinates: the window's bottom 300 dp.
  DeviceEventEmitter.emit(visible ? 'keyboardDidShow' : 'keyboardDidHide', { endCoordinates: { height: visible ? 300 : 0, screenY: Dimensions.get('window').height - (visible ? 300 : 0) }, duration: 0, easing: 'keyboard' });
}
let systemColor: ColorSchemeName = 'light';
const appearanceListeners = new Set<(event: { colorScheme: ColorSchemeName }) => void>();
export function emitColorScheme(colorScheme: ColorSchemeName) {
  systemColor = colorScheme;
  for (const listener of appearanceListeners) listener({ colorScheme });
}
export function appearanceSubscriptionCount() { return appearanceListeners.size; }
// The system's «reducir movimiento»: read once, then heard as it changes.
let reduceMotion = false;
const reduceMotionListeners = new Set<(enabled: boolean) => void>();
export function emitReduceMotion(enabled: boolean) {
  reduceMotion = enabled;
  for (const listener of reduceMotionListeners) listener(enabled);
}
export function reduceMotionListenerCount() { return reduceMotionListeners.size; }
export function resetNative() {
  resizeWindow(390, 844);
  systemColor = 'light';
  reduceMotion = false;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReset().mockImplementation(async () => reduceMotion);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReset().mockImplementation(((type: string, listener: (enabled: boolean) => void) => {
    if (type !== 'reduceMotionChanged') throw new Error(`Fixture has no AccessibilityInfo ${type}`);
    reduceMotionListeners.add(listener);
    return { remove: () => { reduceMotionListeners.delete(listener); } };
  }) as never);
  jest.spyOn(Appearance, 'getColorScheme').mockReset().mockImplementation(() => systemColor);
  jest.spyOn(Appearance, 'addChangeListener').mockReset().mockImplementation(listener => {
    appearanceListeners.add(listener);
    return { remove: () => { appearanceListeners.delete(listener); } };
  });
  StatusBar.mockClear();
  stored.clear(); storageFailures.read.clear(); storageFailures.write.clear();
  secureStore.getItemAsync.mockReset().mockImplementation(storageDefaults.getItemAsync);
  secureStore.setItemAsync.mockReset().mockImplementation(storageDefaults.setItemAsync);
  secureStore.deleteItemAsync.mockReset().mockImplementation(storageDefaults.deleteItemAsync);
  biometrics.hasHardwareAsync.mockReset().mockResolvedValue(true);
  biometrics.isEnrolledAsync.mockReset().mockResolvedValue(true);
  biometrics.authenticateAsync.mockReset().mockResolvedValue({ success: false });
  camera.permission = { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' };
  camera.request.mockReset().mockImplementation(async () => camera.permission);
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockReset().mockImplementation((type, listener) => {
    const entry = { type, listener };
    appListeners.add(entry);
    return { remove: () => { appListeners.delete(entry); } };
  });
  jest.spyOn(Linking, 'openURL').mockReset().mockRejectedValue(new Error('Fixture cannot open link'));
  jest.spyOn(Linking, 'canOpenURL').mockReset().mockResolvedValue(false);
  jest.spyOn(Linking, 'getInitialURL').mockReset().mockResolvedValue(null);
  jest.spyOn(Linking, 'addEventListener').mockReset().mockImplementation((_type, listener) => {
    linkListeners.add(listener);
    return { remove: () => { linkListeners.delete(listener); } } as ReturnType<typeof Linking.addEventListener>;
  });
  for (const mock of Object.values(router)) mock.mockReset();
  jest.spyOn(BackHandler, 'exitApp').mockReset().mockImplementation(() => {});
  router.canGoBack.mockReset().mockReturnValue(false);
  navigation.focused = true; navigation.pathname = '/agents'; navigation.stackContent = null; navigation.params = {}; navigation.state = undefined;
}

// Native/router boundaries used when the actual root layout is mounted.
export function NativeStack() { return navigation.stackContent; }
NativeStack.Screen = function NativeStackScreen(_props: { options?: object }) { return null; };
export const fonts = { useFonts: () => [true, null] };
export const splash = { preventAutoHideAsync: async () => {}, hideAsync: async () => {} };
export const StatusBar = jest.fn((_props: { style: string }) => null);
