# Relay

A phone app (Android) that operates Hermes agents running on the user's own machines, over their
Tailscale tailnet. The app only ever talks to a small service that runs next to Hermes, "el Puente".

Read before changing anything:

- `docs/relay-v1.md`: the specification. It decides scope. Where the design or `DECISIONS.md`
  disagree with it, the specification wins.
- `CONTEXT.md`: the project's vocabulary (Agente, Servidor, Puente, Conversación, Turno, Tablero,
  Tarjeta, Pausa general, Aprobación, Decisión, Guardián, Modo de aprobación). Use these words in UI
  text and docs, and their meaning in code names.

## Layout

| Path | What it is |
|---|---|
| `mobile/` | The app: Expo SDK 57, React Native, expo-router. Pure logic in `src/core/`, state in `src/state/`, screens in `src/screens/`, routes in `src/app/`, design primitives in `src/ui/`, tokens in `src/theme/tokens.ts`. |
| `bridge/` | El Puente (`relayd`): Node with no runtime dependencies, run with type stripping. |
| `protocol/protocol.ts` | The wire contract both sides share: types and side-effect-free constants only. No platform imports. |
| `design/` | The design, copied from Claude Design: one PNG and one HTML per canvas under `design/captures/`. See `design/README.md`. |
| `docs/` | The specification and research. |

## Decision records

ADRs live in `docs/adr/`.

## Working rules

- Integration branch: `dev`. Never commit on `main`. One worktree per task, next to the repo.
  Relay 3.1 work uses `redesign` instead: see "Relay 3.1 (rama `redesign`)".
- Builders commit on their task branch. Merging into `dev` needs an approving independent review,
  `dev` merged into the branch, and a green gate on that result; merges into `dev` go one at a time,
  in the order the orchestrator gives. Push `dev` after each merge. Never touch `main`. Merges into
  `redesign` follow "Relay 3.1 (rama `redesign`)" (batches of `clase:low`).
- Test first. Write the failing test, then make it pass. For anything in the list under "Fails
  silently", break the code on purpose and confirm the test fails.
- Surgical changes: only what the task asks. Note adjacent problems in your report; do not fix them.
- Code, identifiers, comments, commits and PRs in English. UI text and docs in Spanish.
- Add no dependency unless the task says so.

## Pruebas de componentes

- La lógica pura y los plugins conservan `npm test` con `node --test`. Los componentes Android
  usan `npm run test:components` (Jest y React Native Testing Library), exclusivamente en
  `mobile/tests/components/*.component.test.tsx`, fuera de las rutas y con tipos Jest aislados.
- Montar pantallas, AppProvider, hooks y decisiones core reales. Los dobles compartidos viven
  en `mobile/tests/support`: solo límites nativos, reloj, almacenamiento, transporte y navegación.
  Una petición no declarada falla aunque la app capture el rechazo. No acceder a servicios reales.
- React Compiler se aplica al código propio mediante el adaptador Babel de pruebas; Android,
  DEMO=0 y ausencia de compilación de dependencias se comprueban en el arnés.
- Probar contratos críticos mediante interacción y mutación temporal del cableado: registrar
  aserción fallida, restaurar y comprobar verde. Retirar pruebas estáticas solo con cobertura
  conductual equivalente. Ver `docs/adr/0003-pruebas-de-componentes.md`.

## Gate

`scripts/gate.sh` runs everything and prints one line per step. It needs
`npm ci` in `bridge/` and in `mobile/`, and `npm run setup` in `supervisor/` (it compiles
node-pty), once per worktree.

Medición del arnés en este equipo (2026-10-05), con los nueve pasos, componentes con cuatro procesos
de Jest y la carga de otras sesiones (media de carga 32–53): tres pasadas calientes de 24,45, 27,87 y
34,23 s (mediana 27,87 s), sin contar instalación; gate sin caché de Jest, 35,53 s. Con dos procesos
la mediana quedaba unos 3 s sobre el presupuesto. El camino crítico es ahora `mobile:components` junto
con `mobile:typecheck` (25–34 s). Presupuesto: mediana caliente <=30 s y gate frío <=45 s.

| Step | Command |
|---|---|
| Bridge tests | `cd bridge && npm test` |
| Bridge types | `cd bridge && npm run typecheck` |
| Supervisor tests | `cd supervisor && npm test` (the real systemd tests skip, with the reason, without a user manager) |
| Supervisor types | `cd supervisor && npm run typecheck` |
| App tests | `cd mobile && npm test` |
| App components | `cd mobile && npm run test:components` |
| App types | `cd mobile && npm run typecheck` |
| App lint | `cd mobile && npm run lint` |
| Web export | `cd mobile && npx expo export --platform web` |

Run the narrowest test while you work (`node --test path/to/file.test.ts`) and the whole gate
before you report. Workers may build and install the Android APK when their task needs it.
For 3.1 tickets this differs (area gates only, full gate once before `redesign` enters `dev`,
`Killed` retry, APK only at three moments): see "Relay 3.1 (rama `redesign`)".

## The app

- Logic that can be pure goes in `mobile/src/core/` with a `node --test` test next to it. Imports
  there use the `.ts` extension.
- React Compiler is on. Never read `Date.now()` during render; use the `useNow` hook.
- Never call `fetch` as a method of an object (`opts.fetch(...)` throws in the browser); copy it to
  a local first.
- Build screens from the primitives in `mobile/src/ui/` and the tokens in
  `mobile/src/theme/tokens.ts`. Visual fidelity to the design is the priority: open the canvas the
  task cites (`design/captures/<file>/<canvas>.png` and `.html`) and match its layout, text, colors
  and sizes.
- Every new screen or state gets demo data in `mobile/src/core/demo.ts`, so it can be seen with
  `npm run demo` without a Server.
- The app says "huella", never "Face ID".

## El Puente

- No runtime dependencies. Commands run through `exec.ts`: an argument vector, never a shell.
- Its log records method, path and status. Never bodies, headers, keys or codes.
- Tests run against the fake Hermes behind the interface in `bridge/src/hermes.ts`.

## Sessions

Orchestrated through Herdr, at most six sessions besides the orchestrator. The table applies to
`dev`; 3.1 adds builder model rules and a queue limit in "Relay 3.1 (rama `redesign`)".

|Role|Model|
|---|---|
|Builder|Opus 5.5|
|Architect|Opus 5.5|
|Reviewer (never the builder of the change)|Sonnet 5.5|
|Escalation: same failure twice, review disagreement, a "Fails silently" mutation that stays green, or architect request|Fable|

## Relay 3.1 (rama `redesign`)

Reglas para construir 3.1 (especificación `docs/relay-v3.1.md`, navegación en
`docs/adr/0007-navegacion-del-rediseno.md`). Donde contradicen «Working rules», «Gate» o
«Sessions», mandan estas para 3.1; aquellas siguen valiendo para `dev`.

1. **Rama.** Cada ticket de 3.1 sale de `redesign` y se fusiona en `redesign`, con revisión
   independiente aprobada y `redesign` fusionada en la rama del ticket. `dev` se fusiona en
   `redesign` cada vez que avanza. Al terminar 3.1, `redesign` entra en `dev` de una vez.
2. **Modelo del builder.** Opus 5.5 construye la base (lienzo, demo web, tokens, `metrics`,
   maquinaria, componentes base y navegación) y todos los tickets `clase:high-risk` y
   `clase:architectural`. Sonnet 5.5 construye los `clase:low` una vez cerrada la base, es decir,
   después de fusionar el ticket de navegación. El revisor sigue siendo Sonnet 5.5 y nunca es el
   builder del cambio.
3. **Gate.** Lo corre el orquestador al fusionar en `redesign`, con la rama del ticket ya al día con
   `redesign`, y solo en las áreas que toca la fusión (`scripts/gate.sh mobile`, `bridge` o
   `supervisor`). Una fusión que solo toca docs o `design/` no lleva gate. El gate completo se corre
   una vez, antes de fusionar `redesign` en `dev`. El builder corre sus pruebas estrechas mientras
   trabaja y `scripts/gate.sh <área>` al terminar. El revisor no corre el gate.
4. **Tandas.** Los `clase:low` aprobados se fusionan en `redesign` en tandas de 2 o 3, con un solo
   gate para la tanda. Si sale rojo, se separan y se pasan de uno en uno hasta encontrar el que
   falla.
5. **Paso `Killed`.** Un paso del gate que termina en `Killed` se repite una vez. Si vuelve a
   fallar, es un fallo real.
6. **Cola.** Como máximo 4 builders y 2 revisores a la vez, dentro del límite de seis sesiones
   además del orquestador.
7. **APK.** Se construye e instala solo en tres momentos: al cerrar la base (ticket de navegación),
   al cerrar Aprobar y antes de fusionar `redesign` en `dev`.
8. **Proceso.** Sin `/code-review` ni `/pr` por ticket. `/retro` una vez, al cerrar 3.1.

## Fails silently

Treat a change that touches any of these as high risk, and attack them in review:

- Keys, pairing codes and device revocation: expiry, single use, comparison in constant time, what
  a revoked device still reaches.
- Approval decisions and their countdown: which choice is sent, what happens at expiry.
- What the Puente serves from disk: path validation, symbolic links, size limits.
- Redaction of logs, and anything that could put a secret in a log line or an error message.
- Protocol version checks between the app and the Puente.
- Time: milliseconds against seconds, clocks of two machines, time zones in schedules.
- Anything that writes to a Hermes profile (memory, `SOUL.md`, tools, modes, rules): the previous
  version must be kept and the change recorded.
