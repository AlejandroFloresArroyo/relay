<p align="center">
  <img src="docs/assets/readme/relay-banner.png" alt="Relay — Your agents. Your machines. Anywhere." width="1200">
</p>

# Relay

**Your Hermes agents, within reach.** Relay is an Android app for operating [Hermes](https://github.com/NousResearch/hermes-agent) agents on your own machines over your Tailscale tailnet. Talk to your agents, approve their commands with your fingerprint, and keep your Servers in view from your phone or tablet.

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#try-the-demo">Try the demo</a> ·
  <a href="#status">Status</a> ·
  <a href="https://discord.gg/vcWpmXuFG">Join Discord</a> ·
  <a href="https://buymeacoffee.com/relayapp">Support Relay</a> ·
  <a href="README.es.md">Español</a>
</p>

**Android phone and tablet · Linux Servers · Self-hosted · Expo / React Native · AGPL-3.0**

The app's interface is in Spanish. This README and the installation guides are in English; the specifications and design records under `docs/` are in Spanish. There is no published APK: you build the app yourself.

## What it does

| | |
|---|---|
| **Talk to your agents** | Conversations with search, Markdown, image and Server-file attachments, on-device dictation, and a model picker per Conversation. |
| **Follow and redirect** | Live Turn progress, tool activity, stop and steer controls, and reconnection that never resends your message by itself. |
| **Decide when it matters** | Pending Approvals with a countdown and risk summary. Approving takes a deliberate hold and your fingerprint; a Decision that expires sends nothing. |
| **Keep a Server in view** | Live gauges for CPU, memory and disk, gateway uptime, start/stop/restart, a general pause, logs, scheduled jobs, and usage and cost by agent or model. |
| **Work on the Server** | Fingerprint-gated tools per Server: full terminals (tmux works), a file browser and text editor, local web apps opened inside Relay, and control of a dedicated or your everyday Chrome. |
| **Shape an agent** | Memory and personality editing with the previous version kept, approval modes, blocking rules, tools and Skills. |
| **Board and Work** | A Board of native Cards that agents publish, and a Kanban of Work shared with them. |
| **Fits the device** | Phone tab bar, tablet side rail with list and Conversation side by side, dark theme, home-screen widget, notifications. |

## See Relay

<p align="center">
  <a href="docs/assets/readme/agents.png"><img src="docs/assets/readme/agents.png" width="200" alt="The Agents screen: two Servers, agent states and a pending Approval banner"></a>
  <a href="docs/assets/readme/chat.png"><img src="docs/assets/readme/chat.png" width="200" alt="A Conversation with an agent, its Turn activity, a failing test run and a diff"></a>
  <a href="docs/assets/readme/approvals.png"><img src="docs/assets/readme/approvals.png" width="200" alt="Pending Approvals with countdowns and risk levels"></a>
  <a href="docs/assets/readme/server.png"><img src="docs/assets/readme/server.png" width="200" alt="A Server with gateway uptime, CPU, memory and disk gauges, and the general pause"></a>
</p>

<p align="center">
  <a href="docs/assets/readme/tablet.png"><img src="docs/assets/readme/tablet.png" width="820" alt="Tablet layout: side rail, agent list and a Conversation with its Turn activity"></a>
</p>

Captures of the app's synthetic web demo in the dark theme, not mockups. Names, messages and metrics are illustrative, and the orange «Demostración … · Cambiar» links are demo controls. [Asset details](docs/assets/readme/README.md).

## Install

### 1. Prepare your Server and phone

You need an existing **Hermes installation on Linux**, **Node.js 26 or newer**, **Python 3 with PyYAML**, a **systemd user session**, and **Tailscale connected on both the Server and the Android device**. Enable MagicDNS and make sure your tailnet policy lets the phone reach the Puente's port, normally `8650`.

Hermes's API server must already be available for the agents you want to message. The installer connects an existing Hermes installation; it does not install or reconfigure Hermes.

### 2. Run the guided installer

On the Server, clone the repository and run the wizard in an interactive terminal:

```bash
git clone https://github.com/AlejandroFloresArroyo/relay.git
cd relay
./scripts/bridge-wizard.sh
```

The wizard checks prerequisites, lets you select your existing Hermes paths, previews the service setup, and asks before installing. The Puente has **no npm runtime dependencies**. Keep this checkout in place; the service runs from it. Existing Hermes profiles and configuration are preserved.

Read the [installation guide](docs/bridge-install.md) for details and pairing troubleshooting. The Server tools (terminal, files, web, browser) need a second service, the supervisor; see [`docs/v3-install.md`](docs/v3-install.md) (Spanish).

### 3. Build the Android app and pair

Build the APK with the [Android build guide](mobile/README.md#build-the-android-app) and install it. No Expo account or EAS is required.

Open Relay, add a Server, and scan the QR shown by the installer, or enter its address and one-time code by hand. Codes expire after **five minutes**; to get another:

```bash
cd bridge
./relayd pair
```

Use the full address printed by the Puente, such as `http://your-server.your-tailnet.ts.net:8650`. Android blocks plain HTTP to a raw IP or short hostname; Tailscale encrypts the connection between your devices.

## Try the demo

Explore the app with synthetic data, without Hermes, Tailscale or an Android build:

```bash
./scripts/prepare-dev.sh
cd mobile
npm run demo
```

Open the local URL Expo prints. Many screens have demo controls to switch between states such as loading, empty, error or disconnected. See the [development guide](docs/development.md) for requirements and platform limits.

## How it connects

```text
Android phone ── your Tailscale tailnet ── Puente on your Linux Server ── Hermes agents
```

Relay talks only to the **Puente** (Spanish for "bridge"), a small Node service that runs next to Hermes. Each phone pairs separately and gets its own device key; list or revoke devices from the Server with the [Puente CLI](bridge/README.md#paired-devices).

The app keeps its key in Android secure storage and asks for your fingerprint before protected actions. The Puente listens on the Server's Tailscale address and logs method, path and status, never bodies or credentials. A paired device can do powerful things, so control who is on your tailnet and revoke lost devices promptly. Revoking cuts that device's access and open streams; it does not cancel work Hermes already accepted. [Operational details and limits](bridge/README.md).

## Status

Relay is a one-person project built in the open with coding agents. Current version: **3.1.0**.

| Version | Scope |
|---|---|
| **1** | Conversations, agent controls, Approvals, native Board, scheduled jobs, pairing, Linux Puente. |
| **2** | Activity, notifications, Work (Kanban), personality presets, dark theme, tablet layouts, widget, in-app APK updates. |
| **3** | Server tools: terminals, files and editor, local web apps, dedicated and everyday browser control. |
| **3.1** | The «Instrumento» redesign: one design system, new navigation, live gauges and indicators. |

What has and has not been tested is written down, not implied:

- Server tools were accepted in a lab with the real Puente, supervisor, terminals and browsers against a simulated Hermes, and on an emulated tablet. Physical-device runs and real Tailscale Services/HTTPS are still pending. See the [compatibility matrix](docs/relay-v3-matriz.md) (Spanish).
- Only Linux x86_64 Servers are tested. arm64, other distributions, macOS and Windows are not.

## Support Relay

<p align="center">
  <a href="https://buymeacoffee.com/relayapp"><img src="docs/assets/readme/support-banner.png" alt="Built together. Help Relay go further — support Relay on Buy Me a Coffee." width="1200"></a>
</p>

Contributions help fund **macOS and Windows Server support** and **preconfigured cloud VPS instances ready to deploy with one tap**. These are goals, not services available today.

- [**Buy Me a Coffee**](https://buymeacoffee.com/relayapp)
- [**Discord**](https://discord.gg/vcWpmXuFG): feedback, setups and progress.
- [**Issues**](https://github.com/AlejandroFloresArroyo/relay/issues): what happened, your versions, and sanitized steps to reproduce. Never paste keys or pairing codes.

## For contributors

| Path | Purpose |
|---|---|
| [`mobile/`](mobile/README.md) | Expo 57 / React Native Android app, demo and APK builds. |
| [`bridge/`](bridge/README.md) | The Puente: setup, devices, configuration and API. |
| `supervisor/` | Keeps terminals and dedicated browsers alive apart from the Puente. |
| [`protocol/`](protocol/protocol.ts) | Wire types and constants shared by the app and the Puente. |
| [`docs/`](docs/) | Specifications (`relay-v1.md` to `relay-v3.1.md`), ADRs and research, in Spanish. |
| [`CONTEXT.md`](CONTEXT.md) | The project's vocabulary. |
| [`design/`](design/README.md) | Design canvases and the tools that capture them. |

Run `./scripts/gate.sh` before sending changes: Puente and supervisor tests and types, app logic and component tests, app types, lint and the web export. [`AGENTS.md`](AGENTS.md) holds the working rules the coding agents follow.

## License

[GNU Affero General Public License v3.0](LICENSE). If you modify Relay and let others use it over a network, you must offer them your source.
