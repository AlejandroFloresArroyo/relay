<p align="center">
  <a href="../README.md"><img src="../docs/assets/readme/relay-banner.png" alt="Relay — Your agents. Your machines. Anywhere." width="1200"></a>
</p>

# Relay · the Puente

The Puente (“Bridge”) is the small `relayd` service running next to Hermes on your Server. It is the only service the Android app talks to. **Node.js 26 runs TypeScript directly; there are no npm runtime dependencies.**

Installation targets **Linux**, a **systemd user session**, and an already-connected **Tailscale** tailnet. HTTP binds only to a local Tailscale IP and travels inside Tailscale's encrypted connection.

[Project overview](../README.md) · [Guided installation](../docs/bridge-install.md) · [Android app](../mobile/README.md) · [Discord](https://discord.gg/vcWpmXuFG)

## Guided installation

From the repository root, in an interactive Server terminal:

```bash
./scripts/bridge-wizard.sh
```

The wizard checks prerequisites, asks for your existing Hermes root and CLI paths, previews the setup command, and asks before proceeding. It neither installs nor reconfigures Hermes. Node, Python/PyYAML, systemd, and Tailscale must already be available.

For the full walkthrough, read the [installation guide](../docs/bridge-install.md). To prepare dependencies for development and tests instead, use the [development guide](../docs/development.md).

### Direct setup

If you already know the configuration you want, use the existing installer:

```bash
cd bridge
./relayd setup
```

It checks the user systemd session, local Tailscale IP, and full MagicDNS name; creates a private `bridge/.env` **only if missing**; generates `~/.config/systemd/user/relay-bridge.service`; enables the unit; starts an inactive Puente; waits for its private socket; then displays the pairing address, QR, and five-minute code.

The service runs from this checkout: keep its location stable. Setup uses the absolute checkout and Node paths. It runs with `UMask=0077`, `Restart=always`, and a five-second retry delay. If Tailscale is unavailable, startup fails without broadening the listening interface.

An existing `.env` is preserved byte for byte without being opened by the installer. Its assignments override the unit's public configuration, including `HERMES_HOME`, `HERMES_BIN`, bind, and port; review conflicts yourself before installing. Explicit Hermes paths selected in the wizard are stored in the unit as public configuration.

An identical unit is retained. Replacing a different one and restarting an active Puente require explicit flags:

```bash
./relayd setup --replace-service
./relayd setup --restart
./relayd setup --replace-service --restart
```

Replacing a unit does not restart its active process: the new values apply on its next start. Setup reports completed steps if it fails; it does not roll back an existing installation. Unit files are written atomically, so an interrupted run leaves the previous unit whole: rerun the same command. It does not install system packages, use sudo, change Hermes/Tailscale/firewall settings, or enable linger. If linger is off, it prints a suggestion for you to consider.

### V3 setup flags

```bash
./relayd setup --dry-run --supervisor --files --web --replace-service --restart
```

| Flag | Effect |
|---|---|
| `--supervisor` | Installs `relay-supervisor.service` (its own user unit, started before the Puente) and sets `RELAY_SUPERVISOR_DIR` in the Puente's unit. Requires node-pty compiled with `cd ../supervisor && npm run setup`. |
| `--files` | Sets `RELAY_REMOTE_FILES=1`. |
| `--web` | Sets `RELAY_REMOTE_WEB=1`. |
| `--browser-habitual` | Sets `RELAY_BROWSER_HABITUAL=1`; requires `--supervisor`. |
| `--restart-supervisor` | Restarts an active supervisor; requires `--supervisor`. Its live terminals become `lost`, and setup prints how many first. Never implied by `--restart`. |
| `--dry-run` | Runs every check and prints the files and `systemctl` commands it would apply; writes and changes nothing, and needs no interactive terminal. |

The Puente's unit is generated from the flags of each run: repeat every flag you use. Neither unit names the other, so restarting or updating the Puente never ends environments. The supervisor's unit loads no `EnvironmentFile` and keeps the default umask, because terminals inherit its environment. The [V3 guide](../docs/v3-install.md) (Spanish) covers updates, the browser extension, and web publication.

### Diagnosis and web publication

```bash
./relayd doctor
./relayd web
```

`doctor` checks, read-only, what this Server can run of V3: tested platform, systemd and cgroup v2 delegation, node-pty, the supervisor and the Puente units, `/proc`, Tailscale HTTPS and host tag, browsers and native host manifests. Each line is `ok`, `aviso`, or `falta` with the next step; it exits 1 if any is `falta`. It never opens `.env`, the supervisor key, or a browser profile, and never connects to a browser.

`web` lists each registered web app with its Tailscale Service, its Puente listener, and the exact `tailscale serve --service=… --https=443 http://127.0.0.1:<listener>` command to publish it by hand, plus stale Relay Services to clear. The Puente only reads Tailscale's state; publishing is a manual step (see «Publicar una web» in the V3 guide).

## Paired devices

From the same checkout and user session as the Puente:

```bash
./relayd pair
./relayd devices
./relayd revoke <device-id>
./relayd doctor
./relayd web
./relayd browser <google-chrome|chromium|chrome-for-testing>
./relayd --help
```

`pair` shows the full MagicDNS HTTP address with port, one-time code, expiration, and QR. Scan it in Relay or enter address and code manually. The code is valid for **five minutes**, usable **once**, and replaced by another `pair`. If the exchange response is lost, generate a new code. The QR never contains a permanent device key.

`pair` and `setup` require interactive stdout and refuse to issue codes into redirected output; `setup --dry-run` issues none and does not. Widen a narrow terminal or use manual entry if the QR cannot be read.

`devices` shows each full UUID, verified Tailscale name, date, and state. A device that reaches the Puente through the Servidor itself, such as an emulator running on it, arrives from the Servidor's own address, so it is listed as `teléfono` rather than under the Servidor's name. `revoke` requires the **full UUID**, not a prefix or device name. Revocation immediately rejects new requests and closes the device's streams without affecting other devices. In V1 it **does not cancel work Hermes already accepted**. Repeating revocation preserves its original date.

`serve` is the sole state writer. Administrative commands use the checkout-specific private socket at `$XDG_RUNTIME_DIR/relayd/<instance>.sock`, with directory permissions `0700` and socket permissions `0600`. There is no HTTP administration endpoint or `/tmp` runtime fallback.

### Upgrading from the old shared key

Install the pairing-capable app first, then deliberately replace/restart the Puente and pair each phone. The old `RELAY_KEY` no longer authenticates anything; there is no dual-authentication window or automatic import. Setup preserves existing private configuration, so remove obsolete entries manually after reviewing it. Coordinate the service change to avoid interrupting daily work.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_HOST` | Required | Verified local Tailscale IP. Loopback, wildcard, and LAN binds are rejected. |
| `RELAY_PORT` | `8650` | Listening port, 1–65535. |
| `RELAY_CORS_ORIGINS` | None | Comma-separated explicit origins; `*` is rejected. |
| `HERMES_HOME` | `~/.hermes` | Hermes installation root. |
| `HERMES_BIN` | `hermes` | Hermes CLI executable. |
| `RELAY_NTFY_URL` | None | Optional HTTP(S) ntfy URL for Approval notices; not a complete V1 closed-app notification integration. |
| `HERMES_MEDIA_SOURCE` | Hermes source under `HERMES_HOME` | Override for the verified media adapter's source checkout. |
| `HERMES_MEDIA_PYTHON` | Its `venv` / `.venv` interpreter | Override for the media adapter's installed Python environment. |
| `RELAY_APP_UPDATE_ROOT` | None | Optional canonical absolute directory (0700, owned by the Puente user) where Root publishes `relay.apk` and `release.json`. Unset: the APK endpoints answer 404. |
| `RELAY_SUPERVISOR_DIR` | None | Canonical absolute runtime directory of `relay-supervisor` (`supervisor/`), with its socket and key. Unset: the `environments`, `terminal` and `browser` capabilities are neither advertised nor served. Set: `browser` is advertised with the dedicated browser, whose availability is `RemoteStatus.browser.dedicated`. The supervisor runs in its own user unit; the Puente never starts or stops it. |
| `RELAY_REMOTE_FILES` | Unset | `1`: the `files` capability is advertised and served. Set by `setup --files`. |
| `RELAY_REMOTE_WEB` | Unset | `1`: the `web` capability is advertised and served: local apps discovered from `/proc/net/tcp`, one loopback listener per app, each published by hand as its own Tailscale Service (`relayd web`). Set by `setup --web`. |
| `RELAY_BROWSER_HABITUAL` | Unset | `1`, together with `RELAY_SUPERVISOR_DIR`: the Puente also serves the habitual browser through the same `browser` routes, and listens for the Relay browser extension on `browser/extension.sock` (0600, in its private `browser/` directory). Unset: nothing listens and `RemoteStatus.browser.habitual` is `not_configured`. Set by `setup --supervisor --browser-habitual`. |

The habitual browser (#93, ADR 0006 «Lo que fijó #93») needs two steps on the computer, once per browser. `./relayd browser google-chrome` (or `chromium`, `chrome-for-testing`) writes the native messaging host manifest under `$XDG_CONFIG_HOME/<browser>/NativeMessagingHosts/`, allowed only for the Relay extension, and prints its ID. Then load `bridge/extension/` with «Load unpacked» in that browser's `chrome://extensions` (developer mode) and check the ID. Finally enable it in the Puente with `./relayd setup --supervisor --browser-habitual --replace-service --restart`, plus the other flags you use; `RELAY_BROWSER_HABITUAL=1` in `.env` still works, but the flag keeps it in the unit where `doctor` sees it. Tested with Chrome for Testing and Google Chrome 154; the extension does not load in older versions. Only the tabs the person shares with the extension's toolbar button, and the ones Relay opens, can be controlled; disconnecting or revoking never closes a tab. The dedicated browser (#92) needs only the supervisor and Chromium or Google Chrome in the user manager's `PATH`; `relayd doctor` checks the program and the cgroup controllers its limits need.

The Puente and the extension check each other's channel version (`EXTENSION_PROTOCOL`, 3 since uploads and downloads went through the files transfer): after updating the Puente, reload the extension in `chrome://extensions`, or the habitual browser stays `helper_incompatible`. Version 3 also asks for the `downloads` permission. Uploading a phone's file to a page, or bringing a page's download to the phone, in either browser, needs the files tool too (`RELAY_REMOTE_FILES=1`).

For deliberate foreground execution with a privately configured environment, from `bridge/`:

```bash
node --env-file=.env src/main.ts
# Or ./relayd serve when variables are already exported.
```

The phone uses `http://<server>.<tailnet>.ts.net:8650`, not the numeric listening IP or short name. Pairing derives this name from Tailscale's `Self.DNSName` and fails if it is invalid. The Puente listens directly; no `tailscale serve` is required (only the optional V3 web apps use Tailscale Services). It ignores `X-Forwarded-For` and uses the socket peer for identification and attempt limits.

Hermes's API server must already be configured for chat. The existing integration expects `API_SERVER_ENABLED=true` for the gateway and an `API_SERVER_KEY` for each participating profile. Named profiles have distinct keys and are served under `/p/<profile>/` when Hermes multiplexes them. A missing profile key makes chat unavailable. Configure and restart Hermes yourself when needed; the Relay installer does not do it. Hermes API keys stay on the Server and are never sent to the phone.

## Authentication, state, and logs

`GET /health` and `GET /v1/whoami` are public. `POST /v1/pair` exchanges `{code}` without a Bearer key. Private routes require `Authorization: Bearer <deviceKey>`; protocol-aware routes also require `X-Relay-Protocol: 2`. The [shared protocol](../protocol/protocol.ts) defines compatibility and errors.

An expired, used, replaced, or unknown pairing code returns the same `pairing_invalid` error. Unknown keys return `key_unknown`; revoked devices return `device_revoked`. Five failed key/code attempts from an IP within one minute trigger a five-minute block with `429` and `Retry-After`. The block survives restart and does not extend merely because blocked traffic continues.

Private state (`devices.json`, `changes.jsonl`, and the Conversation registry) lives beside the entrypoint, outside version control. Device state stores SHA-256 digests, not plaintext keys or codes. Invalid permissions, ownership, symlinks, or corrupt state fail startup closed rather than silently creating an empty registry. Do not edit live state.

APK publication snapshots live in `app-update/`, a private child (`0700`) that the Puente creates under its state directory, as Work does with `kanban/`. The state directory itself may stay `0755`, but must be owned by the Puente user and not writable by group or others. A widened `app-update/` (any group/other bit) fails closed with `503 app_update_invalid`; restore it with `chmod 700`.

Recovering leftover APK reservations: a crash during a download can leave `app-update/app-update-slot-0` and `app-update-slot-1` behind. The Puente never inspects or removes existing slots, so with both present every APK request answers `429 app_update_busy`. Stop the Puente (`systemctl --user stop` on its unit), confirm no `relayd` process remains, remove only those two directories (`rm -r <state>/app-update/app-update-slot-0 <state>/app-update/app-update-slot-1`), then start it again. Never remove them while the Puente runs: a live download may own them.

Full personality preset quotas (16 MiB catalogue, 4096 apply receipts) are terminal and the Puente never prunes `*.previous` backups. The archive procedure is in [`docs/personality-presets-contract.md`](../docs/personality-presets-contract.md), «Operación: cuotas llenas y respaldos».

The change log records UTC time, device, and action without content. Its durable outbox recovers events without duplicate IDs. HTTP logs contain method, route template, and status; they omit bodies, headers, credentials, queries, arbitrary path values, filenames, and message content. Public errors are static. Pairing codes appear only in the interactive CLI output.

## Where data comes from

| Area | Source or operation |
|---|---|
| Server / agents | Host information, Hermes version, profile configuration, gateway state, and API health. |
| Conversation history and search | Short read-only SQLite snapshots of each profile's `state.db`. |
| Conversation changes and Turns | Hermes API server on loopback, normally port `8642`. |
| Gateway control / diagnosis | Fixed Hermes CLI argument vectors, never shell commands. Diagnosis runs `doctor` without `--fix`. |
| Scheduled jobs | Hermes job data and API, with history assembled by the Puente. |
| Logs | Redacted default-profile `logs/agent.log`. |
| Native Board Cards | Validated Server-side publication; [publication contract](../docs/board-publication.md). |
| Memory and personality | Profile files, with previous versions retained and changes recorded. |
| Agent file delivery | Hermes's verified media extractor and delivery policy. |

The Hermes browser dashboard is not used. The Puente combines the API, CLI, and profile files rather than depending on a browser login.

### Conversations

Under `/v1/agents/:id`:

| Method and path | Result |
|---|---|
| `GET /conversations` | Interactive Conversations, newest first; `background=true` selects background ones. `limit` / `offset` pagination. |
| `GET /conversations/search?q=...` | Literal title/message search with the same filter and pagination. |
| `GET /conversations/:conversationId` | Metadata, origin, and permission to send. |
| `POST /conversations` | Create with `{requestId}`; retrying the same device/agent request returns the same confirmed Conversation. |
| `PATCH /conversations/:conversationId` | Rename with `{title}`, unique and at most 100 characters. |
| `GET /conversations/:conversationId/deletion` | Current message count and confirmation revision. |
| `DELETE /conversations/:conversationId` | Delete with `{revision}`; changes require a new confirmation. |

SQLite reads support WAL without migrations or `immutable=1`. Hidden messages are excluded from display/search but included in physical deletion counts. Verified automatic continuations share a stable Conversation identity; forks and subagents are not inferred as continuations merely from a common parent.

Sending requires a durable Puente creation receipt. External Conversations and older ones without receipts remain read-only for sending, even if a client bypasses the UI. Rename and delete are still available. Ambiguous continuations do not gain write permission.

### Turns and recovery

`GET /v1/agents/:id/chat` checks that agent's chat availability. `POST /v1/runs/:id/steer` accepts exactly `{requestId, input}` for a known, connected, active Turn. Requests are serialized; retrying the same identity does not duplicate the Hermes submission. Acceptance means queued, not necessarily consumed. Unconsumed instructions are returned through `pendingSteer`.

`GET /v1/runs/:id` returns that Turn's messages, receipts, final event, and cursor. `POST /v1/runs/:id/reconnect` resumes it without creating a new Turn or resending its input. A cursor of `-1` omits `Last-Event-ID`.

Turn state and steer receipts are in memory. Finished Turns remain for ten minutes; a Puente restart loses them. Reconnection discards replayed sequences when available. Missing stream events are reported with `complete: false` and `run.resync_required`; authoritative final text can repair an answer but cannot invent lost tool activity. Revocation is rechecked after waits and before effects or responses.

### Approvals and models

The Puente follows the SSE streams of Turns it initiated, even without a connected phone, and retains pending `approval.request` events in memory. Decisions go to the owning profile. Expiration uses the profile timeout, normally 300 seconds; unanswered commands are denied. Risk labels come from a static pattern table, not an inferred explanation from Hermes. `cwd`, `reason`, and `affects` remain null when Hermes supplies none. Optional ntfy notices omit the command itself.

`GET /v1/agents/:id/models` returns configured model options without credential metadata. `PUT /v1/agents/:id/conversations/:conversationId/model` accepts `{model: {provider, model}}` or `{model: null}`. The selection is stored privately by Relay; it does not change the agent's default or Hermes files. Changing it during a Turn affects the next one. An unavailable selected model fails explicitly rather than silently substituting one.

Answer attribution uses only the runtime Hermes reports. The requested model or current agent configuration is not evidence of the model that answered; historical attribution can remain unknown.

### Home-screen widget

`GET /v1/widget` (device key, `X-Relay-Protocol: 2`) returns only `protocol/widget.ts` `WidgetProjection`: up to three Agents with allowed labels and enumerated state, the count of Approvals with a known future expiry, `observedAt` and `expiresAt` (30 minutes, or the first counted expiry). Never a command, message, model or Approval identity. Approval and busy changes, and a confirmed gateway change, publish `{schema: 1, kind: "widget", registrationId}` to each enabled ntfy registration, at most once per 10 seconds plus a trailing signal; no content, no retry.

### Agent-announced files

`GET /v1/agents/:id/conversations/:conversationId/files` lists files announced through `MEDIA` in that Conversation, with optional `messageId`, `limit` (1–100), and `offset`. IDs are opaque; Server paths are not exposed. Cleaned display text applies to the exact message identity.

`GET .../files/:fileId` requires a current device key and protocol version. Tickets expire in ten minutes and are scoped to the agent and Conversation. Expiration returns `file_ticket_expired`, distinct from absence. Reloading obtains new tickets; the app does not silently retry a download.

The Python adapter uses Hermes's own `extract_media` and `validate_media_delivery_path`, with pinned SHA-256 source checks against [the verified Hermes implementation](https://github.com/NousResearch/hermes-agent/blob/ea114c3e/gateway/platforms/base.py) and [media policy](https://github.com/NousResearch/hermes-agent/blob/ea114c3e/gateway/media_policy.py). An incompatible source or interpreter refuses delivery. Hermes upgrades require reviewing the implementation and updating its checks and tests.

Additional Puente checks reject traversal, symlink components, multiply linked files, private registry files, and files over **50 MB**. Descriptor-based checks and private staging prevent serving a concurrently replaced file; policy, announcement, and authorization are rechecked before delivery. Cancellation and failure clean up staging.

The isolated adapter projects only media-policy configuration through PyYAML, limited to 1 MiB per file, including managed overrides. It does not initialize Hermes terminal/configuration modules. An audit guard forbids writes, permission changes, processes, and network access. Invalid configuration and remote/container backends fail closed; local host files are supported.

Observed announcements are held in a bounded in-memory cache (128 messages / 2048 announcements). It can retain the missing-file state of a previously observed announcement; it cannot invent one that Hermes never extracted. Changed/deleted messages, eviction, and restart invalidate that state. Completed Android downloads remain privately cached for opening or sharing; partial ones are removed.

## Operational limits

- Live pending Approvals and busy Turn tracking cover work initiated through the Puente, not every Discord, CLI, or scheduled Turn.
- Restarting the Puente loses in-memory Turns and pending Approvals; Hermes work can continue, and an unanswered Approval expires.
- Hermes stream tool calls lack a stable call ID; the Puente matches completion to the oldest start of the same tool. Historical tool duration is unknown and previews are truncated.
- V1 log viewing is limited to the default profile. Redaction reduces credential exposure but is not a guarantee that logs contain no personal data.
- `doctor` can contact configured model providers and take time. The app does not run a repair command.
- Gateway uptime excludes suspended time; non-Linux process inspection is not full Server support.
- Events use authenticated `fetch` streaming; browser `EventSource` cannot supply the required authorization headers.

## Development checks

After [preparing the checkout](../docs/development.md):

```bash
npm test
npm run typecheck
```

From the root, run `./scripts/gate.sh` for all checks. Tests use fake Hermes, fake execution boundaries, temporary directories, and ephemeral ports. They do not operate production services, Tailscale, or a real phone; the gate does not build or install an APK.

## Community and support

[Join Discord](https://discord.gg/vcWpmXuFG) for discussion and feedback. [Support Relay on Buy Me a Coffee](https://buymeacoffee.com/relayapp) to help fund **macOS and Windows support** and **preconfigured cloud VPS instances ready to deploy with one tap**. These are future goals; the current Puente installer targets Linux.
