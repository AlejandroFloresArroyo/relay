#!/usr/bin/env bash
# Builds the lab viewer APK. The lab certificate is generated here (not committed) and trusted
# only by this app through its network security config: no device or browser trust changes.
#   bash build-android.sh            x86_64 (SDK emulator)
#   ARCHS=arm64-v8a bash build-android.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .lab-cert
if [ ! -f .lab-cert/cert.pem ]; then
  node --input-type=module -e "
    import { writeFileSync } from 'node:fs';
    import { makeCert } from '../src/certs.ts';
    const c = makeCert(['*.relay-lab.localhost', 'cdn.localhost']);
    writeFileSync('.lab-cert/cert.pem', c.cert);
    writeFileSync('.lab-cert/key.pem', c.key);
  "
fi
npx expo prebuild -p android --no-install --clean
res=android/app/src/main/res
mkdir -p "$res/raw" "$res/xml"
cp .lab-cert/cert.pem "$res/raw/lab_cert.pem"
cat > "$res/xml/network_security_config.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/lab_cert" />
    </trust-anchors>
  </base-config>
</network-security-config>
XML
manifest=android/app/src/main/AndroidManifest.xml
grep -q networkSecurityConfig "$manifest" ||
  sed -i 's|<application |<application android:networkSecurityConfig="@xml/network_security_config" |' "$manifest"
cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures="${ARCHS:-x86_64}" --console=plain -q
ls -l app/build/outputs/apk/release/app-release.apk
