import { requireOptionalNativeModule } from 'expo';
import type { AppUpdateNative } from '@/core/appUpdateSession';
import { RelayError } from '@/core/client';
const unavailable = () => { throw new RelayError('app_update_invalid', 'Actualiza Relay: el módulo APK no está disponible en esta app.'); };
export const apkNative: AppUpdateNative = requireOptionalNativeModule<AppUpdateNative>('RelayApkUpdate') ?? {
  claim: unavailable, retire: () => {}, info: async () => ({ supported: false, canInstall: false, applicationId: '', versionCode: 0, versionName: '', signerSha256: '' }),
  open: unavailable, writeChunk: unavailable, verify: unavailable, install: unavailable, requestInstallPermission: unavailable,
};
