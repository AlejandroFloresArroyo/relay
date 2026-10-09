# README artwork and screenshots

Presentation assets shared by the project, app, and Puente READMEs. All captions and banner copy are in English. The current app UI remains in Spanish.

## Screenshots

| File | View | Source (`shoot.mjs` capture) |
|---|---|---|
| `agents.png` | Agents, Server states and the pending Approval banner | `phone-01-agentes` |
| `chat.png` | Conversation with Turn activity, terminal output and a diff | `phone-08-chat-dev` |
| `approvals.png` | Pending Approvals with countdowns | `phone-02-aprobaciones` |
| `server.png` | Server gauges, uptime and the general pause | `phone-07-servidor` |
| `tablet.png` | Tablet rail, agent list and Conversation | `tablet-08-chat-dev` |

Captured on 2026-10-09 from the **3.1.0 synthetic web demo** (`npm run demo`) in the dark theme with [`design/tools/shoot.mjs`](../../../design/tools/shoot.mjs): phone at 390 × 844 × 3, tablet at 1280 × 800 × 2. Phone captures were resized to 585 px wide and the tablet capture to 1280 px, with metadata stripped; nothing else was retouched. Demo names, content and metrics are illustrative, and the demo controls stay visible. Captures do not certify native fingerprint, dictation, camera, or real Hermes behavior.

To regenerate, start the demo and run `node design/tools/shoot.mjs http://localhost:8081 <out-dir> oscuro`, then resize the files above.

## Brand art

| File | Purpose |
|---|---|
| `relay-banner.png` | Masthead: an engraved, half-pixelated messenger hands an amber light to the RELAY title. |
| `support-banner.png` | Support banner: antique instruments joined by cables, each with one amber lamp. |
| `mobile/assets/avatars/*.png` | The eight Agent avatars (Hermes bust, caduceus, raven, torch, astrolabe, winged sandal, lighthouse, owl). `mobile/src/core/agentAvatars.ts` assigns them. |
| `mobile/assets/images/icon.png`, `android-icon-foreground.png`, `splash-icon.png`, `favicon.png` | The three-lamp capsule, engraved. The adaptive background and monochrome layers are unchanged. |

Generated with ChatGPT Images on 2026-10-09 in one conversation that shared a single style brief, written after the [Nous Research brand guide](https://raw.githubusercontent.com/NousResearch/kanban-video-pipeline/main/taste/brand-guide.md) without copying any of its marks: black over more than 80 % of the frame, Relay's amber `#F29A1A` as the one hero accent with dark amber `#C47A1A` and bone `#E8E6E1`, dithered, banded or cross-hatched tones instead of smooth gradients, and classical messenger imagery printed as if by an old computer. No logo or wordmark of another project appears.

Post-processing only: avatars resized from 1254 to 256 px; the capsule cut from its transparent canvas (alpha under 5 % cleared) and placed at the sizes of the previous icons; the two banners split from one 2172 × 724 image and cropped to 1085 × 392. Metadata stripped. The banners' English wording is part of the artwork; keep both banners together.

The support banner links to [Buy Me a Coffee](https://buymeacoffee.com/relayapp). The READMEs state that contributions help fund future macOS/Windows support and preconfigured cloud VPS instances ready to deploy with one tap. Those goals must not be presented as shipped capabilities.
