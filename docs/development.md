# Prepare a Relay development checkout

Relay currently targets **Android phones and Linux Servers**. This guide prepares the source and tests. For a Puente service alongside your existing Hermes, use the [installation wizard](bridge-install.md); app signing and device pairing are separate steps.

[Project overview](../README.md) · [Android build guide](../mobile/README.md#build-the-android-app) · [Puente reference](../bridge/README.md)

## One command on Linux

From a complete checkout:

```bash
./scripts/prepare-dev.sh
```

The script checks **all prerequisites before either package installation**, then runs `npm ci` in `bridge/` and `mobile/`, in that order, using their lockfiles. It stops at the first failure. If mobile installation fails, bridge may already be prepared; there is no rollback. Correct the problem and repeat the command.

Provide Bash, Linux with `/proc/self/fd`, Node.js 26+ with built-in SQLite and its limits, npm, and Python 3 with `fcntl` and PyYAML available under isolated `-I` mode. The checkout must include both packages' manifest and lockfile. PyYAML is already used by the Puente's Hermes adapters; the script does not install Python or Python packages.

```bash
./scripts/prepare-dev.sh --check
./scripts/prepare-dev.sh --help
```

These modes do not install packages or create files. Checkout preparation does not require Java, Android SDK, Hermes, Tailscale, or a systemd session. It does not install system software, use sudo, read secrets, create a service, or run the gate. `npm ci` downloads development dependencies and replaces each package's `node_modules`.

## Demo and validation

```bash
(cd mobile && npm run demo)
./scripts/gate.sh
```

The web demo uses synthetic data without a Server. The gate checks Puente tests/types, app logic, Android components with fake native boundaries, app types/lint, and web export. It neither builds/installs an APK nor pairs devices or operates production Hermes/Tailscale.

For narrower checks, use `./scripts/gate.sh bridge` or `./scripts/gate.sh mobile`. There is no separate runner to learn.

To compare the demo with the design, photograph every route on phone and tablet, light and dark, with `node design/tools/shoot.mjs http://localhost:<port> <out-dir>` (see `design/README.md`). App logic tests include `mobile/src/core/stateCopy.test.ts`, which holds every UI text to the 3.1 state copy (`docs/mobile-theme.md`) and the 9.5 px type floor.

## Android tooling

Prepare Java and the SDK separately. The [app README](../mobile/README.md#build-the-android-app) records JDK 17, Android SDK 36, Build-Tools 36.0.0, and NDK 27.1.12297006 from the project's build environment. The generated Android project determines any additional packages required by the current version.

```bash
export JAVA_HOME='<absolute-path-to-your-JDK-17>'
export ANDROID_HOME='<absolute-path-to-your-Android-SDK>'
export EXPO_NO_TELEMETRY=1
"$JAVA_HOME/bin/java" -version
cd mobile
APP_VARIANT=development npx expo prebuild --clean --platform android --no-install
(cd android && ./gradlew :app:assembleDebug)
APP_VARIANT=development npx expo start --dev-client --localhost
```

`prebuild --clean` regenerates `android/` and may change `package.json` scripts: inspect the diff before retaining changes. Native dependencies and Gradle/SDK tooling may require downloads and licenses. These commands do not prepare the entire Android environment. USB installation and port forwarding are documented in the app README.

Relay Dev has a separate package and debug signature, so it can coexist with Relay. Expo Go lacks required native modules. For a native demo, set `EXPO_PUBLIC_RELAY_DEMO=1` when starting Metro; hardware capabilities and real dictation still need separate device checks.

## Signing and real connections

Release builds use the existing signing plugin. `RELAY_SIGNING_PROPERTIES` points to your own private file **outside Git**, containing `storeFile`, `keyAlias`, `storePassword`, and `keyPassword`. These are not needed for Relay Dev or the web demo. Missing fields fail a release build. Keep passwords and keystores out of Git and shared command output.

Preserving app data on update requires the same package and signing key. Your new signing key cannot replace another person's signed build.

For a real Server connection, deliberately install the Puente and pair with its QR/code. Tailscale must already be configured on phone and Server; Relay does not create a VPN or turn Tailscale on. Checkout preparation stores no device keys and does not configure Hermes.

## Platform support

| Platform | App development / demo | Full Puente installation |
|---|---|---|
| **Linux** | One-command checkout preparation. Android build workflow documented. | Current target: `/proc`, Python `fcntl`, systemd user session, and connected Tailscale required. |
| **macOS** | Mobile-only exploration may be possible with manually prepared tools; not validated by this workflow. Linux preparation script refuses to run. | Not currently supported in full. Unix `fcntl` alone does not replace Linux `/proc` and systemd requirements. |
| **Windows** | Mobile-only tooling not validated here. `npm run demo` uses POSIX environment assignment. | Not currently supported in full. Linux filesystem/process and systemd requirements remain. |
| **WSL / VM** | Not validated. | Not validated; not equivalent to Windows support. |

For mobile-only exploration on another platform, install `mobile/` dependencies manually with `npm ci`. In PowerShell, the demo equivalent is:

```powershell
$env:EXPO_PUBLIC_RELAY_DEMO = '1'
npx expo start --web
```

Run it from `mobile/`. This is an unvalidated Windows recipe, not a Puente setup. The full gate includes Linux-specific Puente checks. iPhone and app-store publication remain outside the current release scope.

These limits follow the existing source: [`setup.ts`](../bridge/src/setup.ts) requires Linux; [`hermes_store.ts`](../bridge/src/hermes_store.ts), [`agentFiles.ts`](../bridge/src/agentFiles.ts), [`board.ts`](../bridge/src/board.ts), [`hermesAgentTools.ts`](../bridge/src/hermesAgentTools.ts), and [`logTail.ts`](../bridge/src/logTail.ts) use `/proc/self/fd`; [`agent_memory.py`](../bridge/src/agent_memory.py) uses `fcntl`/`flock`. This documentation does not port them to another platform.

## Help build what comes next

[Join Discord](https://discord.gg/vcWpmXuFG) to discuss development and share feedback. [Support Relay](https://buymeacoffee.com/relayapp) to help fund macOS/Windows Server support and preconfigured cloud VPS instances ready to deploy with one tap. These are future goals, not current platform claims.
