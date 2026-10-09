# Entrega: preparación Linux y wizard del Puente

## Alcance y rutas

Todos los cambios están en este worktree; no hay commits, cambios de rama ni dependencias nuevas.

| Ruta | Cambio |
|---|---|
| `scripts/prepare-dev.sh` | Comprobación completa de requisitos antes de `npm ci` secuencial; ayuda y `--check` sin instalación. |
| `scripts/bridge-wizard.sh` | Cinco etapas Linux, rutas públicas, perfiles informativos, confirmación humana y reutilización de `relayd setup`. Biblioteca del template sin modificar. |
| `bridge/src/main.ts` | Pasa las rutas públicas opcionales del entorno a setup. |
| `bridge/src/setup.ts` | Conserva esas rutas en la unidad systemd; configuración privada existente intacta y valores por defecto sin cambios. |
| `bridge/test/devPreparation.test.ts` | Comandos falsos: requisitos, orden, fallos y ausencia de instalación en check/ayuda. |
| `bridge/test/bridgeWizard.test.ts` | Fakes de límites: rutas, symlinks, inyección, argv, check/plan y rechazo sin terminal interactiva. |
| `bridge/test/setup.test.ts` | Persistencia de rutas públicas, repetición sin reinicio y rechazo de directivas inyectadas. |
| `docs/development.md` | Desarrollo, demo, gate, Android y firma personal; matriz de plataformas con límites de fuente local. |
| `docs/bridge-install.md` | Instalación y emparejamiento manuales; operaciones, conservación y límites del wizard. |
| `README.md` | Entradas a preparación e instalación. |
| `bridge/README.md` | Entrada al wizard y precedencia de configuración existente. |
| `mobile/README.md` | `npm ci` y enlace a preparación de desarrollo. |
| `docs/dev-install-manifest.md` | Este manifiesto de entrega y evidencia. |

## Verificación

44 pruebas pasan en los archivos estrechos `devPreparation.test.ts`, `bridgeWizard.test.ts`, `setup.test.ts` y `cli.test.ts`. Tipos completos del Puente pasan usando el compilador y los tipos ya instalados en otro checkout, solo en lectura; no se ejecutó `npm ci` real. `bash -n` pasa en ambos scripts. Shellcheck no está disponible y no se instaló. La comparación de biblioteca con `wizard/template.sh` confirma bytes idénticos antes de las etapas.

Evidencia persistente, ignorada por Git, en la raíz del worktree:

- `dev-install-red.log` / `dev-install-green.log`: prueba primero de preparación.
- `bridge-wizard-config-red.log` / `bridge-wizard-config-green.log`: prueba primero de persistencia de selección.
- `install-mutation-dev-failfast.log`, `install-mutation-wizard-path.log`, `install-mutation-wizard-argv.log`, `install-mutation-hermes-config.log`: guardas desactivadas, aserción RED explícita, restauración y GREEN.
- `dev-install-final-tests.log`, `dev-install-types.log`, `dev-install-check.log`, `dev-install-shellcheck.log`, `wizard-library-check.log`, `dev-install-diff-check.log`: comprobaciones finales.

## Límites y siguiente integración

No se ejecutó el wizard interactivo, instalación real, servicio, Hermes, Tailscale, gate ni APK. El `--check` real de preparación fue readonly; todo setup probado usa rutas y datos sintéticos. Root debe integrar y ejecutar su gate. La instalación real corresponde al humano en terminal, con confirmación final y permisos separados para sustituir/reiniciar el Puente.

Linux es la plataforma del Puente. macOS/Windows de app, WSL y VM no están validados; no se portó código core. Los requisitos se proporcionan de antemano. Los perfiles elegidos no filtran el descubrimiento. Una configuración privada existente puede prevalecer sobre las selecciones: la revisión queda al humano, porque esta entrega no lee secretos. Sustituir una unidad activa sin reinicio deja sus valores nuevos para el próximo arranque.

Para ejecutar: `./scripts/prepare-dev.sh` prepara el checkout; `./scripts/bridge-wizard.sh` guía la instalación del Puente. Consulta ambas guías antes de operar un Servidor real.
