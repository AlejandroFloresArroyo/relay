# Install the Puente alongside your existing Hermes

The easiest installation path is Relay's guided Linux wizard. It connects an **existing Hermes installation** to the Android app; it does not install or reconfigure Hermes.

[Project overview](../README.md) · [Puente reference](../bridge/README.md) · [Android build guide](../mobile/README.md#build-the-android-app) · [Discord](https://discord.gg/vcWpmXuFG)

## Before you begin

| Requirement | What to prepare |
|---|---|
| **Linux** | A user systemd session, an accessible `$XDG_RUNTIME_DIR`, and `/proc/self/fd`. |
| **Node.js 26+ and npm** | Node's built-in SQLite must support the limits used by the Puente. |
| **Python 3** | `fcntl` and PyYAML available in isolated mode (`python3 -I`). |
| **Hermes** | An existing installation, its physical root and CLI executable paths, and API-server access configured for the agents you want to message. |
| **Tailscale** | Connected on Server and phone, with a full MagicDNS `*.ts.net` name and tailnet access to the Puente's chosen port. |
| **Relay on Android** | A locally built APK; see the [app build instructions](../mobile/README.md#build-the-android-app). |

Clone a complete checkout and keep it where the service will run:

```bash
git clone https://github.com/AlejandroFloresArroyo/relay.git
cd relay
./scripts/bridge-wizard.sh
```

Run the wizard yourself in an **interactive terminal on the Server**. Do not redirect the installation output: its final step displays the one-time pairing QR/code. You can cancel with Ctrl-C and run it again. The wizard does not save answers or read secret files.

## Five guided steps

1. **Check prerequisites.** Reuses the read-only checkout checks, then checks that `systemctl`, `loginctl`, `tailscale`, the user runtime directory, and Puente checkout exist. Actual systemd and Tailscale readiness are verified by `relayd setup` when you install. Missing system tools must be prepared separately.
2. **Select existing Hermes.** Enter absolute physical paths for its root and installed CLI, the agent IDs you want on your checklist, and the Puente port (normally `8650`). Paths must exist and contain no symlinks, `.` / `..` components, control characters, or trailing spaces. Agent IDs are a checklist only: discovery still includes all Hermes profiles.
3. **Review the Puente checkout.** This is the code the service will execute. Node runs the TypeScript source directly, so installing the Puente does not require `npm ci`. Review any existing private configuration yourself; the wizard never opens it.
4. **Review service changes.** The wizard previews the exact command. Replacing a different unit and restarting an active Puente are separate choices, both off by default. It does not restart Hermes's gateway or change Tailscale, firewall, or linger settings.
5. **Install and pair.** After your final confirmation, the wizard calls `./relayd setup` in `bridge/` using an argument vector. It installs/enables the user service, starts it if inactive, and shows the pairing QR. Scan it in Relay or enter its address and code manually. Press Enter after pairing to finish the wizard.

## Pair your phone

Keep Tailscale connected on both devices. In Relay, add a Server and scan the displayed QR. Each phone receives its own key; the QR contains only the address and a one-time code.

The code expires after **five minutes**. If it expires, has already been used, or a response is lost, issue another in an interactive terminal:

```bash
cd bridge
./relayd pair
```

Use the full printed address, for example `http://your-server.your-tailnet.ts.net:8650`. Android blocks plain HTTP to raw IPs or short hostnames. The HTTP connection is encrypted by Tailscale between your devices; current installation does not require HTTPS or Tailscale Serve.

## Existing configuration and service behavior

An existing `bridge/.env` is preserved byte for byte without being opened by the installer. If missing, `setup` creates a minimal private file containing bind/port, with permissions `0600`. Selected Hermes root and CLI paths are public configuration in the generated user unit, not secrets.

**An existing private environment file overrides unit values**, including Hermes paths or port. Review any conflicting values yourself before continuing. The wizard cannot claim to check them because it does not read that file.

The unit is enabled and an inactive Puente starts. A different unit requires `--replace-service`; restarting an active Puente requires `--restart`. Replacing without restarting leaves the old process and its values running until the next start. In that case, the displayed QR belongs to the process still active.

The installer does not roll back an existing installation; it reports completed steps on failure. For boot without a logged-in session, an existing linger suggestion is left for you to decide. Keep the checkout in place after installation.

## Inspect without installing

From the repository root:

```bash
./scripts/bridge-wizard.sh --help
./scripts/bridge-wizard.sh --check
./scripts/bridge-wizard.sh --plan '<absolute-physical-Hermes-root>' '<absolute-physical-CLI-path>' 'default,dev' 8650
```

`--plan` validates public paths and prints an escaped command without executing it. If your CLI's location is a symlink, select the executable's physical path. These modes do not read private configuration, invoke Hermes, or request a key.

The wizard and boundaries have automated synthetic checks; this documentation update does not constitute a fresh installation against production Hermes. macOS, Windows, WSL, and VM installation are not advertised as validated. See the [platform matrix](development.md#platform-support).

## V3 remote tools

The terminal, files, local web apps, and habitual browser of V3 are optional and installed on top of a paired Puente. Read the [V3 install and operations guide](v3-install.md) (Spanish): tested matrix, supervisor build, update rules, browser extension, and the manual Tailscale Services runbook for web apps.

Two read-only commands help before changing anything, from `bridge/`:

```bash
./relayd doctor                                       # what this Server can run of V3; exits 1 if something is missing
./relayd setup --dry-run --supervisor --files --web   # prints the units and commands setup would apply, writes nothing
```

## Troubleshooting

| Symptom | Next step |
|---|---|
| Missing Node/Python/system tools | Install the prerequisite separately, then repeat `--check`. The wizard does not provision your operating system. |
| Missing systemd user session or runtime | Run from the intended user's supported Linux session. |
| Invalid MagicDNS name or no Tailscale address | Check your Tailscale connection and full device name before repeating setup. |
| QR too small or expired | Widen the terminal or enter the address/code manually; `./relayd pair` issues a replacement. |
| App rejects a Server address | Use the full `*.ts.net` name and printed port, with Tailscale active on the phone. |
| Existing active Puente lacks the private socket | Coordinate the app upgrade and an explicit Puente restart; setup does not force one. |
| Chat unavailable for one agent | Review that Hermes profile's existing API-server configuration. Relay does not configure it for you. |

For device revocation, service updates, runtime settings, and limitations, use the [Puente reference](../bridge/README.md).

[Join Discord](https://discord.gg/vcWpmXuFG) for feedback and discussion. [Buy Me a Coffee](https://buymeacoffee.com/relayapp) helps fund future macOS/Windows support and preconfigured cloud VPS instances ready to deploy with one tap.
