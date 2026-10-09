import { notificationCacheScope as cacheScope } from '@/core/notificationCache';
import type { NotificationKind } from '../../../protocol/notifications';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
export interface NativeNotificationScope { serverId: string; url: string; key: string; deviceId: string; revoked?: boolean }
export interface NativeNotificationState { generation: number; state: string; endpoint: string | null; distributor: string | null }
export interface NotificationNative {
  cacheIdentity(key: string): string;
  request(raw:string,method:string,path:string,body:string|null):Promise<{status:number;body:string}>;
  invalidateRequests():void;
  permission(): boolean;
  requestPermission(): Promise<{granted:boolean}>;
  distributors(): {packageName:string;label:string}[];
  reconcile(raw: string): void;
  status(serverId: string): NativeNotificationState;
  begin(raw: string, distributor: string): NativeNotificationState;
  commit(serverId: string, generation: number, status: string): void;
  forget(serverId: string): void;
  forgetIfCurrent(raw:string,generation:number): boolean;
  clearNotice(serverId:string,noticeId:string):void;
  takeOpen(): {serverId:string;noticeId:string;kind:NotificationKind} | null;
}
export const notificationNative = Platform.OS === 'android' && process.env.EXPO_PUBLIC_RELAY_DEMO !== '1' ? requireOptionalNativeModule<NotificationNative>('RelayNotifications') : null;

/** An older/missing native module disables persistence rather than sharing a key-less identity. */
export function notificationCacheScope(server: {id:string;url:string;deviceId?:string;key:string}): string | null {
  try {
    if (!notificationNative?.cacheIdentity || !notificationNative.forgetIfCurrent || server.key.length < 1 || server.key.length > 4096) return null;
    return cacheScope(server, notificationNative.cacheIdentity(server.key));
  } catch { return null; }
}
