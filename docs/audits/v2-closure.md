# Cierre de Relay v2

Fecha: 2026-10-05. Rama `feat/complete-v2`, que contiene `dev` (merge `f6af05a`). Alcance:
[`docs/relay-v2.md`](../relay-v2.md). v2 entró en `dev` con `3498e99`; la publicación 2.0.0 se hizo
desde la rama `release/v2.0.0` sobre ese commit (ver «Publicación 2.0.0»).

Esta auditoría separa lo comprobado de lo pendiente. No había teléfono ni emulador conectados al
cerrarla: toda comprobación nativa sin evidencia previa citada queda **pendiente**.

## Estado del cierre

| Comprobación | Resultado observado |
|---|---|
| Gate (`scripts/gate.sh`) sobre `4d2e890` | Verde: Puente 871/871, tipos del Puente, app 382/382, componentes, tipos de la app, lint y exportación web. |
| Versión | `2.0.0`, `versionCode` 6. El último build instalado fue `1.2.0-preview.3` con `versionCode` 5. `mobile/plugins/appConfig.test.js` exige un número mayor que 5. |
| APK release | Sustituido por el APK final de «Publicación 2.0.0». El de este cierre fue `mobile/dist/apk/relay-2.0.0-4d2e890.apk`: 136324796 bytes, SHA-256 `284f1bdb77ed102ce65cfe7504cdbda09dd54387ca662cc3f87c28ac2561b897`. |
| Identidad del APK | Paquete `io.github.alejandrofloresarroyo.relay`, `versionName` 2.0.0, `versionCode` 6, SDK 36. |
| Firma | Certificado SHA-256 `2048c7ed50e4cfaa2e91a95225adbcf82c5f3c3fd76f12b1d81fa697a8e6dd96`, idéntico al del APK release 1.0.0 anterior. `apksigner verify` correcto. |
| Compilación nativa | `assembleRelease` compiló los módulos Android de Compartir, Widget, Avisos, APK, VPN y Tablero web. No se compilaron sus pruebas `androidTest`. |
| Teléfono | Sin dispositivo. Ninguna comprobación nativa se ejecutó en este cierre. |

Al cerrar esta auditoría ninguna entrega v2 tenía merge en `dev`. Todas entraron en
`feat/complete-v2` mediante cherry-pick desde sus ramas `feat/v2-*`, y la rama entró en `dev` con
`3498e99`. Los commits de instrumentación que se quedaron fuera están listados en cada entrega.

**Revisión independiente**: se buscó en `docs/handoffs/`, `docs/implementation/`, `docs/audits/`,
el resto de `docs/` y los mensajes completos de los 70 commits `dev..feat/complete-v2`. Solo la
instalación guiada y la instrumentación de VPN tienen una aprobación registrada. En Actividad,
Kanban, Compartir y APK constan revisiones SPEC con hallazgos y sus correcciones, pero no una
aprobación final. **El merge a `dev` necesita una revisión independiente aprobatoria de esta
rama** (`AGENTS.md`, «Working rules»).

## Publicación 2.0.0

Rama `release/v2.0.0`, igual a `dev` `3498e99` salvo este documento.

| Comprobación | Resultado observado |
|---|---|
| Gate (`scripts/gate.sh`, `JAVA_HOME` de temurin-17) | Verde: Puente 884/884, tipos del Puente, app 388/388, componentes, tipos de la app, lint y exportación web. Una primera pasada con carga media de 37 falló por tiempo (5 s) en una prueba de `Notifications.component.test.tsx`, que pasó sola (55/55) y en la pasada completa siguiente. |
| APK final | `mobile/dist/apk/relay-2.0.0-3498e99.apk` (ignorado por Git), compilado desde `3498e99`: 136325584 bytes, SHA-256 `5f25f70d4c6c876dbdbb4d1199756f90d93f914273f73fd0b67ca3f113cfe6bd`. |
| Compilación | `APP_VARIANT=release npx expo prebuild --clean --platform android --no-install` y `./gradlew :app:assembleRelease` con Java temurin-17: BUILD SUCCESSFUL en 5m 26s. Se revirtió el cambio de scripts que prebuild deja en `mobile/package.json`. |
| Identidad | `aapt2 dump badging`: `io.github.alejandrofloresarroyo.relay`, `versionCode` 6, `versionName` 2.0.0, `compileSdkVersion` y `targetSdkVersion` 36. |
| Firma | Llave existente (`~/.config/relay/signing.properties`). `apksigner verify --print-certs`: esquema v2 verificado, certificado `CN=Relay, O=Alejandro Flores Arroyo`, SHA-256 `2048c7ed50e4cfaa2e91a95225adbcf82c5f3c3fd76f12b1d81fa697a8e6dd96`, el mismo de siempre. |
| Puente desplegado | `relay-bridge.service` (systemd de usuario) corre `node /home/user/dev/relay-app-bridge-v2.0.0/bridge/update-entry.ts`, un worktree separado fijado en `3498e99`, mediante el drop-in `relay-bridge.service.d/90-relay-v2-update.conf`. Antes corría `fix/reliability-runtime` `7a7ff50`, cuyos cinco commits ya estaban en `dev` como parches equivalentes. |
| Estado del Puente | Sigue en `/home/user/dev/relay-app/bridge`, el directorio fijado por `bridge/update-entry.ts`, con su `.env`. Respaldo antes de reiniciar, con el servicio detenido: `~/.local/share/relay-backups/bridge-state-20261005T020629/` (0700; estado, unidad, drop-in anterior y `SHA256SUMS`). Tras arrancar, `sha256sum -c` da OK en los cinco archivos de estado. Hay 6 dispositivos, todos activos según `./relayd devices`, como en el respaldo, y 5 Conversaciones. El socket de administración conserva su nombre. |
| Respuesta del Puente | `GET /health`: `version` `0.2.0-preview.3`, `protocolVersion` 2, `minAppProtocolVersion` 2. `GET /v1/whoami` 200. `GET /v1/agents` sin llave: 401 `key_unknown`. |
| Lectura autenticada | No se hizo. El Puente solo guarda digests SHA-256 de las llaves de dispositivo, y la llave en claro solo está en el teléfono. Emparejar un dispositivo de prueba habría añadido uno al estado de producción. Queda para el paso 2 del guion. |
| Log del Puente | Desde el arranque solo hay líneas de método, ruta, estado y tiempo, más el aviso de `RELAY_KEY` obsoleto y la línea `listening`. Ni la llave de `.env` ni texto de tipo `Bearer`/`token`/`key=` aparecen. |
| Hermes | `hermes-gateway.service` y `hermes-dashboard.service` activos; `:8642/health` 200 y `:9119/` 302, igual que antes del despliegue. No se cambió su configuración: v2 no lo exige. |

Vuelta atrás: detener el servicio, restaurar el drop-in desde `systemd/` del respaldo, copiar los
archivos de estado del respaldo a `/home/user/dev/relay-app/bridge`, `systemctl --user
daemon-reload` y arrancar.

Pendiente tras la publicación:

- **Validación en teléfono**: el guion completo de abajo, con el APK final.
- **N1 (Widget)**: decidido por Ale el 2026-10-05 (estado en vivo); implementado en
  `feat/v2-widget-live`, pendiente de revisión y de validar en teléfono; ver «Widget».
- **N11 (Presets)** y **N13 (Kotlin sin ejecutar)**: lo que queda tras `fix/v2-followups`; ver
  la lista de pendientes de «Revisión independiente `review-v2` y correcciones».
- **Bifurcaciones**: decisión de Ale; ver «Bifurcaciones».
- `RELAY_APP_UPDATE_ROOT` no está configurado en el Puente desplegado: las rutas de APK responden
  404 hasta que se configure para el paso 10 del guion.
- El Puente sigue con la versión `0.2.0-preview.3` en `bridge/package.json`: `/health` no
  distingue v2 de la versión anterior.

### Revisión independiente `review-v2` y correcciones

Veredicto: CAMBIOS REQUERIDOS (un bloqueante, B1). Corregido en `feat/complete-v2`, test primero
y con rojo observado antes de cada arreglo:

| Hallazgo | Corrección |
|---|---|
| B1, APK con estado 0755 → 503 | `6de5117`: hijo privado `<estado>/app-update` creado 0700; test HTTP con estado 0755. |
| N2, signo del desfase del Widget | `ff27160`: misma conversión que `approvalDeadline`; test con ambos signos. |
| N3, alcance de la huella en presets | `98e374c`: documentado; ver «Presets de personalidad». |
| N4, aplicar preset con fallo no definitivo | `1559c4c`: se muestra `personality_uncertain`; 400/401/403/404/409/426/429 conservan su causa. |
| N5, guardas sin test | `8249965`, `3ec2b45`, `c290974`, `46212c1`: cada guarda mutada da rojo. |
| N6, revocar durante la inscripción de Avisos | `d459f3b`: ya no deja `fatal` para todos. |
| N7, F3/F4 y paso 7.3 | `8113bff` (snapshot fuera del respaldo; descarte ante fallo de descifrado, Kotlin sin ejecutar), `5da3402` (retirar el aviso solo si falla `decide()`), guion 7.3 ajustado. |
| N8, Trabajo ante Puente antiguo | `d5bd5bb`: 404/405/501 → «Actualiza el Puente para usar Trabajo.» |
| N9, cabecera del Tablero web | `d23a434`: solo con capacidad `verified`. |
| N12, Kanban y APK | `3c25ee9`: solo se cachea el éxito del almacén de Trabajo; `res.destroy()` si falla una descarga con cabeceras enviadas; recuperación de `app-update-slot-*` en `bridge/README.md`. |
| N14, textos del wizard de Avisos | `2b87a20`. |
| N15, fixture de presets | `764999a`: en `os.tmpdir()`. |

Seguimiento en la rama `fix/v2-followups` (2026-10-05), test primero, rojo observado y un commit
por punto. Las guardas se rompieron a propósito una a una: cada mutación dio rojo y la
restauración, verde.

| Hallazgo | Corrección |
|---|---|
| R1 (`review-v2-fixes`), descarte del snapshot de Avisos | `6d6520b`: `SnapshotDecryption.java` decide en JVM; solo `AEADBadTagException` borra el snapshot, cualquier otro error del Keystore lo conserva y deja Avisos no disponible en ese proceso. `mobile/plugins/nativeJvm.test.js` compila y ejecuta la prueba Java, como `shareNative.test.js`. Mutación a `BadPaddingException`: rojo. |
| N13, verificación del APK | `c46f0f4`: `ApkVerification.java` concentra metadatos, firmante único, paquete, `versionCode` estrictamente mayor, firma instalada, permiso de instalar, coincidencia del archivo y hash en streaming con longitud exacta, tope de 256 MiB y guarda antes de cada lectura. `RelayApkUpdateModule.kt` solo aporta los datos de Android. 22 mutaciones, 22 rojos. |
| N10, purga al bloquear | `f621347`: al bloquear, `DraftStore.purge()` descarta los borradores y su imagen preparada, el chat compartido abierto pierde texto y compositor, y se descartan las copias de `cacheDir/relay-share`. Bloqueo por inactividad: todas las pendientes. Bloqueo al volver: las pendientes al salir; lo compartido con Relay fuera queda tras el bloqueo. `docs/handoffs/share-mobile.md` actualizado. Seis mutaciones, seis rojos. B1 de la revisión (`c97931b`): un envío en vuelo retiene su borrador hasta la respuesta; aceptado guarda la imagen en el recibo local, rechazado con Relay aún bloqueado se purga. Seis mutaciones, seis rojos. |
| N11, paso 6.1 y operación | `50421cb`: «Guardar SOUL actual como preset» en Personalidad del Agente (sin diseño propio en `design/captures/`; usa la hoja y los controles de presets), prueba de componente y prueba de demo. En la demo web se guardó y apareció en «Aplicar preset SOUL», con un parche temporal (revertido) de react-native-web: `npm run demo` falla antes en `AppState.addEventListener('blur')`, un problema previo. Cinco mutaciones de guarda, cinco rojos. Guía de operación para catálogo lleno, 4096 recibos y crecimiento de `.previous` en `docs/personality-presets-contract.md`, «Operación: cuotas llenas y respaldos»; los límites no cambian y no se poda nada. |

Compilación del código nativo final de la rama (sin cambios nativos después de `c46f0f4`):
`APP_VARIANT=release npx expo prebuild --clean --platform android --no-install` y `./gradlew
:app:assembleRelease` (temurin-17, `ANDROID_HOME=~/Android/Sdk`): BUILD SUCCESSFUL, el Kotlin y
las dos clases Java nuevas compilan y van en el dex. El APK sigue
siendo `versionCode` 6 / 2.0.0, firmado con el certificado `2048c7ed…8e6dd96`; solo prueba la
compilación, no sustituye al APK publicado. Se revirtió `mobile/package.json` y se borraron
`mobile/modules/*/android/build/`. Gate completo verde.

Pendientes registrados, sin arreglar:

- **N1 (Widget)**: decidido por Ale el 2026-10-05 (estado en vivo); ver «Widget».
- **N11 (Presets, resto)**: los `.previous` y los recibos siguen creciendo sin poda, por diseño
  (`AGENTS.md` exige conservar la versión anterior); hay guía para archivarlos a mano. Sin
  cambiar: el replay de un apply completado devuelve el SOUL de entonces y `finish` usa
  `Date.now()` en lugar del reloj inyectado.
- **N13 (Kotlin sin ejecutar)**: la decisión de Avisos y la verificación del APK ya se ejecutan en
  JVM. El resto del Kotlin de Compartir, Avisos, Widget, VPN y APK (Keystore, PackageManager,
  PackageInstaller) solo está compilado; falta la actualización real 1.x → 2.0.0 del guion.
- **N7-F6**: posible `blur` del diálogo de huella que invalide la sesión de Aprobación; se observa
  en el paso 7.3.

## Entregas

### Instalación guiada

- **Commits**: `0f87376` «Add a Linux bridge setup wizard that preserves Hermes»; cherry-pick
  `b1814b9`, ya en `dev` a través de `365c6f1`. `9410b1a` añade el prompt de setup para agentes
  (solo en esta rama).
- **Pruebas**: `bridge/test/bridgeWizard.test.ts` (rutas, symlinks, inyección, argv, plan,
  rechazo sin TTY), `bridge/test/devPreparation.test.ts`, `bridge/test/setup.test.ts` (unidad
  y directivas inyectadas), `bridge/test/cli.test.ts`.
- **Revisión independiente**: hecha. `docs/v1-implementation.md:144`: SPEC y Standards sin
  hallazgos.
- **Pendiente nativo/real**: wizard interactivo real, `relayd setup` contra el Hermes de
  producción y emparejamiento QR real (`docs/v1-implementation.md:146`,
  `docs/bridge-install.md:79`).
- **Docs**: `docs/bridge-install.md`, `docs/dev-install-manifest.md`, `docs/setup-agent-prompt.md`.

### Actividad

- **Commits**: `91e7131` (Puente: actividad auditada con cursores), `a4d313f` (pantalla y
  filtros), `30d8034` (acciones de Kanban), `ab48d43` (residual SPEC: denegación tardía),
  `30fa4e3` (productores de presets y Avisos), `ac50c13` (blur en Android).
- **Pruebas**: `bridge/test/activity.test.ts`, `bridge/test/activityHttp.test.ts`,
  `mobile/src/core/activity.test.ts`, `mobile/tests/components/Activity.component.test.tsx`,
  `ActivityResidual.component.test.tsx`, `ActivityFocus.component.test.tsx`.
- **Revisión independiente**: hubo revisión SPEC con hallazgos, corregidos
  (`docs/implementation/v2-actividad-mobile.md:79-90`). Sin evidencia de aprobación final.
- **Pendiente nativo**: lectura visual en el teléfono y foco/blur reales. El arnés simula el
  límite Android (`v2-actividad-mobile.md:126-128`).

### Avisos

- **Commits**: `f62500f` (UnifiedPush y Decisiones con alcance), `4618362`, `37626d2` (Decisión
  ligada al ACK de Hermes), `a51a7ef` (Avisos ntfy en Android con huella), `670f903`
  (productores de tareas y Servidor). Residuales: `ab7f3f4`, `1f87574`, `0ab1a1d`, `58ad7e7`.
  Fuera de la rama: `48b48ef`, `ac41387`, `659ed74` (fixtures nativas).
- **Pruebas**: `bridge/test/notificationsHttp.test.ts`,
  `bridge/test/notificationProducersHttp.test.ts`, `bridge/test/ntfyTransport.test.ts`,
  `mobile/src/core/notifications.test.ts`, `notificationCache.test.ts`,
  `notificationTransport.test.ts`, `mobile/plugins/withRelayNotifications.test.js`,
  `mobile/tests/components/Notifications.component.test.tsx`, `mobile/plugins/nativeJvm.test.js`
  (descarte del snapshot solo por etiqueta GCM, en JVM). Hay instrumentación
  (`NotificationResidualInstrumentation.kt`), sin resultado registrado.
- **Revisión independiente**: sin evidencia. `docs/notifications-v2.md:105` pide no activar el uso
  real sin revisión y pruebas.
- **Pendiente nativo**: entrega con la app cerrada; Aprobar abre Relay y pide huella; Rechazar
  sin abrir; bloqueo; expiración; revocación antes del socket; replay; DNS público y redirect
  rechazados; tablet (`docs/notifications-mobile-v2.md:101-105`). Requiere ntfy privado en la
  tailnet y su distribuidor en Android.

### Kanban

- **Commits**: `9db5ef1` (Trabajo durable en el Puente), `994f78a` (columnas, dependencias,
  comentarios), `85a3626`, `cdd0e33` (corrección SPEC P1), `97301d3` (columnas en rotación),
  `777ade5` (almacenamiento en un directorio privado).
- **Pruebas**: `bridge/test/kanban.test.ts`, `bridge/test/kanbanHttp.test.ts`,
  `mobile/src/core/kanban.test.ts`, `kanbanClient.test.ts`, `demoKanban.test.ts`,
  `mobile/tests/components/Work.component.test.tsx`.
- **Revisión independiente**: revisión SPEC P1 con hallazgo, corregido
  (`docs/handoffs/kanban-mobile.md:1-6`). Sin evidencia de aprobación final.
- **Pendiente nativo**: gesto físico de arrastre y fidelidad en Android
  (`docs/handoffs/kanban-mobile.md:153`).

### Bifurcaciones

Pendiente por decisión de Ale (`docs/relay-v2.md:65-70`). No hay botón, ruta ni DTO de fork en
`mobile/` ni en `protocol/`. Las coincidencias en `bridge/src` son la lista de denegación de
`os.fork` y «fork bomb» en `risk.ts`. Nada la presenta como terminada.

### Presets de personalidad

- **Commits**: `6f10edd` (presets versionados y recibos), `094d757` (catálogo y selección
  protegida), `3c1f336` (clientes revocados), `30fa4e3` (registro en Actividad).
- **Pruebas**: `bridge/test/personalityPresetsHttp.test.ts` (versiones, aplicar `SOUL.md` con
  respaldo y recibo), `mobile/src/core/personalityPresetsClient.test.ts`, `demoPresets.test.ts`,
  `mobile/tests/components/personalityPresets.component.test.tsx`,
  `presetCatalog.component.test.tsx`, `conversationPersonality.component.test.tsx`
  (`personalityPresets.component.test.tsx` cubre también «Guardar SOUL actual como preset»).
- **Revisión independiente**: sin evidencia.
- **Pendiente nativo**: huella y modal en el teléfono (`docs/personality-presets-ui.md:64`,
  `docs/personality-presets-research.md:68-69`). Aplicar contra un perfil real de Hermes tampoco
  se ha probado.
- **Alcance de la huella**: se comprueba solo en la app, no en el Puente. Protege contra quien use
  el teléfono desbloqueado, no contra un dispositivo comprometido con su llave
  (`docs/personality-presets-ui.md`, «Reemplazar SOUL»).

### Tablero web

- **Commits**: `94667f8` (contrato), `7388093` (tarjetas web y arnés de egress), `dba4e02`
  (snapshots y composición), `87d8d0e`, `396c8fa`, `4a5599e`; además `12a8fc0`, `d8d5e98`,
  `ee655b1`, `d4dd65b`, `4b0e2ae`. Fuera de la rama: `cced813`.
- **Pruebas**: `bridge/test/boardWeb.test.ts`, `bridge/test/boardWebHttp.test.ts`,
  `mobile/src/core/boardWebClient.test.ts`, `demoBoardWeb.test.ts`,
  `mobile/tests/components/BoardWeb.component.test.tsx`,
  `mobile/modules/relay-board-web/android/src/androidTest/fixtures/probeScheduling.test.cjs`.
  Instrumentación: `BoardWebIsolationInstrumentation.kt`, `BoardWebLifecycleInstrumentation.kt`.
- **Revisión independiente**: sin evidencia de aprobación
  (`docs/implementation/board-web-v2-native-proof.md:11,21`).
- **Nativo con evidencia, parcial o negativa**: matriz base `matrix_not_executed`
  (`board-web-v2-fixture-scheduling.md:5`); sonda aislada con `internetDenied=true` pero motor
  sin iniciar (`board-web-v2-native-proof.md:49`); runner de ciclo de vida sin instrumentación
  (`board-web-v2-lifecycle-bootstrap.md:13`).
- **Estado**: **desactivado hasta registrar proveedor con matriz de cero egress**. No se presenta
  como terminado.
- **Pendiente**: matriz completa con cero egress, WebRTC incluido, y registro del proveedor.
  `VerifiedBoardWebProviders.kt` tiene `records = emptyList()` (una prueba `node`,
  `mobile/plugins/boardWebProviders.test.js`, lo exige): el bloque web **no se activa en
  producción**. La app solo envía `X-Relay-Board-Web: 1` con capacidad `verified` (`d23a434`), así
  que sin proveedor recibe la Tarjeta proyectada a texto. Esta entrega no está terminada en el
  teléfono.

### Tema oscuro

- **Commits**: `ea500b9` (claro, oscuro y sistema, persistente), `afd1c36` (orden de
  persistencia), `76adb4b`, `4a9ab90`.
- **Pruebas**: `mobile/src/core/theme.test.ts`, `mobile/tests/components/theme.component.test.tsx`,
  `ThemeRoot.component.test.tsx` (sin remontar AppProvider, LockGate ni chat),
  `ThemeFeatures.component.test.tsx`.
- **Revisión independiente**: sin evidencia.
- **Pendiente nativo**: barra de estado, modo Sistema y persistencia tras reiniciar en el
  dispositivo (`docs/mobile-theme.md:37`).

### Tablet

- **Commits**: `f9f47d6` (navegación adaptativa y paneles), `4b69363`, `e61e55c` (áreas
  seguras), `97301d3`, `4a5bfce` (rutas de Avisos y APK), `4a9ab90`.
- **Pruebas**: `mobile/src/core/relayLayout.test.ts` (umbrales 760/1000 dp),
  `demoTablet.test.ts`, `mobile/plugins/tabletOrientation.test.js`,
  `mobile/tests/components/TabletShell.component.test.tsx`, `TabletRoot.component.test.tsx`
  (Aprobación global y huella tras bloqueo), `TabletRoutes.component.test.tsx`.
- **Revisión independiente**: sin evidencia.
- **Pendiente nativo**: ambas orientaciones, ventana dividida, teclado en pantalla y físico,
  foco/TalkBack y Back (`docs/tablet-v2.md:72-74`).

### Compartir hacia un Agente

- **Commits**: `28cf2df` (texto e imágenes como borrador explícito), `7301233` (residual SPEC:
  blur y revocación). Fuera de la rama: `debb568`, `60d62b6`, `a56956e`, `707949b`.
- **Pruebas**: `mobile/src/core/sharedDrafts.test.ts`, `mobile/plugins/shareNative.test.js`
  (compila y ejecuta `SharePolicyTest.java` en la JVM; autolinking y manifiesto),
  `mobile/tests/components/Share.component.test.tsx` (incluye la purga al bloquear).
- **Revisión independiente**: revisión SPEC con hallazgos, corregidos
  (`docs/handoffs/share-residual.md:17`). Sin evidencia de aprobación final.
- **Pendiente nativo**: arranque frío y caliente, permisos de URI/ClipData, rechazos (varios
  elementos, archivos), tamaños, rotación JPEG y tablet (`docs/handoffs/share-mobile.md:84-88`).
  El módulo ya compila en release; sigue sin ejecutarse.

### Widget

- **Commits**: `bd75c05` (widget con alcance y apertura protegida), `3562358`, `63d51c0`
  (corrige el NPE al construir `MainActivity`). Estado en vivo (rama `feat/v2-widget-live`):
  `ecddb22` (Puente: `GET /v1/widget` y señal silenciosa), `9b376ec` (lectura nativa por empuje,
  trabajo periódico y destino), `ae65a4f` (destino fuera de LockGate), más prueba y documentos.
- **Pruebas**: `bridge/test/widgetHttp.test.ts`, `mobile/src/core/widget.test.ts`,
  `mobile/plugins/nativeJvm.test.js` (`WidgetReadingTest.java`: desfase de reloj con ambos signos,
  caducidad, rechazo del dispositivo; `RefreshFlightTest.java`: una lectura en curso y como máximo
  una pendiente por ráfaga de señales), `mobile/plugins/withRelayWidget.test.js`,
  `mobile/tests/components/Widget.component.test.tsx`, `WidgetRoot.component.test.tsx`. Se eliminó
  `RelayWidgetLifecycleInstrumentation.kt`: probaba el retiro al salir de Relay, que ya no existe.
- **Revisión independiente**: aprobada con pendientes no bloqueantes (2026-10-05). Corregidos: la
  agrupación de señales en el teléfono y el plazo de la inscripción en el receptor (H1), la lectura
  con fecha futura y la alarma por tiempo transcurrido (H2), y notas sobre el teléfono bloqueado (H4)
  y el TTL duplicado (H5). Queda el cableado Kotlin, solo compilado, para el paso 9 (H3).
- **Decisión de Ale (2026-10-05)**: el widget muestra el estado en la pantalla de inicio en tiempo
  real, también con Relay en segundo plano o cerrado (`docs/relay-v2.md`, «Widget en vivo»). Cierra
  la opción (ii) de la revisión. Diseño en `docs/mobile-widget.md`.
- **Nativo con evidencia**: NativeQA reprodujo el NPE en el APK Demo. En emulador (Android 16,
  API 36, imagen `google_apis_playstore` x86_64, Pixel 7) con el APK release de `ae65a4f`: arranca
  sin `FATAL`; el widget se coloca desde el selector, se ve neutro («ABRE RELAY / SIN DATOS
  VISIBLES», «Sin datos del Servidor») en compacto y amplio; el trabajo periódico queda programado
  (`PERIODIC: interval=+15m`, red requerida); tocarlo abre `MainActivity` con el proceso vivo y con
  el proceso terminado. Tras `force-stop` Android enmascara el widget y el toque no abre nada hasta
  abrir Relay desde el lanzador (comportamiento del sistema). Esto confirma el GREEN de `63d51c0`
  en emulador, no en teléfono.
- **Pendiente en teléfono real**: lectura en vivo con un Puente que tenga `GET /v1/widget`
  (el emulador no tiene Tailscale): empuje con Relay cerrado, renovación periódica, «sin datos
  recientes» al caducar, retiro por revocación vista solo por el widget, Puente sin el endpoint,
  reemparejar, tema oscuro y redimensionado en el launcher del teléfono. Ver paso 9 del guion.

### APK desde el Servidor

- **Commits**: `efa8b2a` (publicación explícita desde snapshots privados), `8e9c108`, `0deaa96`
  (descarga verificada e instalación explícita), `5fa4cab` (residual SPEC: blur), `4a5bfce`.
  Fuera de la rama: `c32c47e`, `5ea8df7`, `4b760a1`, `e4bdd8a`.
- **Pruebas**: `bridge/test/appUpdate.test.ts` (límites, symlinks, reservas),
  `bridge/test/appUpdateHttp.test.ts`, `mobile/src/core/appUpdate.test.ts`,
  `appUpdateSession.test.ts`, `demoAppUpdate.test.ts`, `mobile/plugins/withAppUpdate.test.js`,
  `mobile/plugins/nativeJvm.test.js` (`ApkVerificationTest.java` en la JVM: metadatos, firmante,
  paquete, `versionCode`, archivo y hash en streaming),
  `mobile/tests/components/AppUpdate.component.test.tsx`.
- **Revisión independiente**: revisión SPEC con hallazgos, corregidos
  (`docs/implementation/v2-actualizacion-apk-mobile.md:111-124`). Sin evidencia de aprobación
  final.
- **Pendiente nativo**: SHA-256 real, PackageManager, consentimiento, reinicio en frío, salida
  durante la confirmación (`v2-actualizacion-apk-mobile.md:90-95`) y actualización real que
  conserve firma y datos. El APK 2.0.0 de este cierre sirve para esa prueba.

### Estado de VPN

- **Commits**: `dd84b7c` (metadatos de la red por defecto sin inferir proveedor), `bf43ba4`
  (instrumentación aislada), `c99be52` (validación causal registrada). Fuera de la rama:
  `c90a641`.
- **Pruebas**: `mobile/src/core/vpn.test.ts`, `mobile/plugins/withVpnStatus.test.js`,
  `mobile/tests/components/VpnStatus.component.test.tsx`, `RelayVpnLifecycleInstrumentation.kt`.
- **Revisión independiente**: hecha para la instrumentación nativa
  (`docs/implementation/v2-estado-vpn.md:185-187`).
- **Nativo con evidencia**: Samsung Galaxy S23, SDK 36. Control PASS y cinco mutaciones con RED
  exacto y GREEN (`v2-estado-vpn.md:143-165`).
- **Pendiente**: esa fixture usa un ConnectivityManager sintético. Falta Tailscale apagado y
  encendido de verdad, foco real y la ruta real al Puente (`v2-estado-vpn.md:190-198`).

## Guion de validación en el teléfono

Para cuando haya un teléfono conectado. Toma el candado `android` antes de empezar y suéltalo al
terminar. Anota cada resultado observado junto a su paso. Lo que no se observe sigue pendiente.

### 0. Preparación

1. `adb devices`: el teléfono debe aparecer en estado `device`. Si aparece `offline` o
   `unauthorized`, para. Guarda el serial en `S` y dirige cada comando a él con `adb -s "$S"`.
2. `adb -s "$S" shell dumpsys package io.github.alejandrofloresarroyo.relay | grep -E 'versionCode|versionName'`:
   anota la versión instalada. Debe ser menor que 6.
3. Antes de actualizar, anota en Relay los Servidores emparejados, el tema elegido y si la huella
   está activa.
4. Comprueba el APK: `sha256sum mobile/dist/apk/relay-2.0.0-3498e99.apk` debe dar
   `5f25f70d…3cfe6bd`, y `apksigner verify --print-certs` el certificado `2048c7ed…8e6dd96`.

### 1. Actualización conservando datos

1. `adb -s "$S" install -r mobile/dist/apk/relay-2.0.0-3498e99.apk` debe responder `Success`.
   Un error de firma es un fallo: no desinstales.
2. Abre Relay. Deben seguir los mismos Servidores, sin volver a emparejar, el mismo tema y la
   misma huella. `dumpsys` debe mostrar `versionCode=6` y `versionName=2.0.0`.

### 2. Instalación guiada y emparejamiento

1. En el Servidor, en una terminal interactiva: `cd /home/user/dev/relay-app/bridge && ./relayd
   pair`. Es el directorio de estado del servicio, y su socket de administración depende de él.
   Requiere el candado `puente`.
2. En Relay, añade el Servidor escaneando el QR. Tras emparejar, ese código no debe funcionar una
   segunda vez. Pasados cinco minutos, un código nuevo sin usar debe estar caducado.

### 3. Actividad

1. Abre Actividad. Debe mostrar la bitácora global, y al desplazarte cargar más entradas.
2. Filtra por tipo. Cambia de Servidor: no deben quedar entradas del Servidor anterior.
3. Envía la app a segundo plano mientras carga y vuelve: no debe mostrar datos tras bloquear.

### 4. Tema oscuro

1. En Ajustes, elige Claro, después Oscuro y después Sistema. Cada cambio debe aplicarse sin
   perder la Conversación abierta ni el borrador. Revisa el contraste de la barra de estado.
2. Con Sistema elegido, cambia el tema de Android: Relay debe seguirlo.
3. Fuerza el cierre con `adb -s "$S" shell am force-stop io.github.alejandrofloresarroyo.relay`
   y vuelve a abrir: la elección debe conservarse.

### 5. Kanban (Trabajo)

1. Crea un elemento, muévelo de columna arrastrando con el dedo y añade un comentario.
2. Gira el teléfono con un borrador abierto: el borrador debe conservarse y las columnas deben
   caber en la pantalla.
3. Comprueba que el cambio aparece en Actividad.

### 6. Presets de personalidad

1. En Personalidad de un Agente, pulsa «Guardar SOUL actual como preset», ponle nombre y
   guárdalo. Debe aparecer en «Aplicar preset SOUL» con el mismo texto, sin pedir huella.
2. Aplica otro preset: Relay debe pedir la huella antes de aplicarlo.
3. En el Servidor, debe existir un respaldo del `SOUL.md` anterior y un registro del cambio en
   Actividad. Requiere el candado `hermes`; respalda `~/.hermes` antes, como pide `AGENTS.md`.

### 7. Avisos

Requiere ntfy privado en la tailnet y su distribuidor en Android. Sigue los seis pasos de
`bash scripts/notifications-wizard.sh` (`docs/notifications-v2.md:84-105`).

1. Concede el permiso de notificaciones desde Relay y regístrate en el Puente.
2. Cierra Relay y provoca una Aprobación en un Agente. Debe llegar el aviso con sus botones.
3. Pulsa Aprobar: debe abrir Relay en la pantalla del aviso, que pide una segunda pulsación
   «Aprobar con huella» (`docs/notifications-mobile-v2.md`); no es un fallo. Tras la huella debe
   enviarse la Decisión. Sin huella no debe enviarse nada. Observa si el diálogo de huella provoca
   un `blur` que deje la pantalla sin enviar tras la huella (síntoma: «no pasa nada tras la
   huella», N7-F6 de la revisión); anótalo si ocurre.
4. Repite con Rechazar: debe resolverse sin abrir Relay y el Agente debe recibir el rechazo.
5. Deja expirar una Aprobación: el aviso no debe aceptar la acción. Revoca el dispositivo desde el
   Servidor: no deben llegar más avisos ni aceptarse acciones.

### 8. Compartir hacia un Agente

1. Desde el navegador, comparte un enlace hacia Relay: debe pedir el destino (Servidor, Agente y
   Conversación) y dejar un borrador sin enviarlo.
2. Comparte un texto y una imagen JPEG o PNG desde la galería, con Relay cerrado y con Relay
   abierto. La imagen debe verse con la orientación correcta.
3. Comparte varias imágenes a la vez o un PDF: Relay debe rechazarlo con un mensaje.
4. Deja un borrador compartido preparado y otro contenido pendiente, y deja que Relay se bloquee
   (por inactividad o al volver tras el plazo). Tras desbloquear, el borrador debe decir que ya no
   está disponible y el contenido pendiente antes del bloqueo no debe aparecer. Lo compartido con
   Relay fuera debe seguir disponible. Con el dispositivo revocado tampoco debe quedar el borrador.

### 9. Widget

Requiere el Puente con `GET /v1/widget` (rama `feat/v2-widget-live` o posterior) y, para el empuje,
los Avisos inscritos (paso 7). Anota la hora del teléfono en cada observación.

1. Coloca el widget de Relay en la pantalla de inicio y abre Relay una vez con el Servidor
   seleccionado. Sal de Relay: el widget debe mostrar «APROBACIONES», el contador, hasta tres
   Agentes con su LED y «LECTURA dd/MM HH:mm». No debe aparecer ningún comando, mensaje ni modelo.
2. Redimensiónalo a pequeño y a ancho; en ancho cada Agente muestra su Servidor y su estado
   (TRABAJANDO, EN LÍNEA, ERROR, INACTIVO).
3. Con Relay cerrado (deslízalo fuera de recientes) y el teléfono bloqueado, provoca una
   Aprobación en un Agente. Al desbloquear, el contador debe haber subido sin abrir Relay, en
   segundos si llegó el aviso silencioso. Decide o deja vencer la Aprobación: el contador debe bajar.
4. Desactiva los Avisos en Relay y repite: el widget debe renovarse como máximo en unos 15 minutos
   (más si Android está en Doze). Corta la red del teléfono o detén el Puente más de 30 minutos:
   debe decir «SIN DATOS RECIENTES», «—» y «ÚLTIMO DATO» con su hora, nunca el contador anterior.
5. Tema oscuro en Relay: el widget cambia de tema sin abrir datos nuevos.
6. Tócalo: debe abrir Relay en la pantalla de lectura, pidiendo la huella si toca. Ningún toque
   aprueba ni rechaza.
7. Revoca el dispositivo desde el Servidor (`relayd devices`, `relayd revoke <id>`) con Relay cerrado: en la siguiente
   renovación el widget debe quedar en «ABRE RELAY / SIN DATOS VISIBLES». Repite reemparejando y
   quitando el Servidor en Relay: el dato anterior debe desaparecer al momento.
8. Con un Puente sin `GET /v1/widget` (por ejemplo el desplegado `3498e99`), el widget debe quedarse
   en el acceso neutro y abrir Relay.

### 10. APK desde el Servidor

Requiere un APK con `versionCode` mayor que 6, firmado con la misma llave, y el candado `puente`.

1. Publica `relay.apk` y su `release.json` en `RELAY_APP_UPDATE_ROOT` (directorio 0700, archivos
   0600; campos en `docs/implementation/v2-apk-desde-servidor.md:32-38`). El Puente guarda sus
   copias en `<estado>/app-update`, que crea 0700 aunque el estado sea 0755 (`6de5117`).
2. En Relay, busca actualización. Debe descargarse, verificar el SHA-256 y pedir tu
   confirmación antes de instalar, además del permiso de orígenes desconocidos si falta.
3. Tras instalar, los datos deben seguir intactos. Repite con un `sha256` alterado en
   `release.json`: Relay debe negarse a instalar.
4. Durante la confirmación, sal de Relay y vuelve: no debe instalar sin un nuevo gesto.

### 11. Estado de VPN

1. Con Tailscale apagado en el teléfono, abre un Servidor. Debe mostrar «SIN VPN PARA RELAY».
2. Con Tailscale encendido y el Puente detenido (candado `puente`), debe mostrar «SERVIDOR SIN
   RESPUESTA». Vuelve a arrancar el Puente y pulsa Reintentar: debe recuperarse.

### 12. Tablet o pantalla amplia

Si no hay tablet, usa
`adb -s "$S" shell wm size 1600x2560 && adb -s "$S" shell wm density 320` y restáuralo después
con `wm size reset` y `wm density reset`.

1. Comprueba en vertical y en horizontal que la navegación lateral y los paneles conservan la
   selección al girar.
2. Comprueba la ventana dividida, el teclado en pantalla sin tapar el composer, Back y TalkBack.
3. Las Aprobaciones deben mostrarse con su hoja global y la huella también en tablet.

### 13. Tablero web

No se puede activar: `VerifiedBoardWebProviders` está vacío. Solo puede ejecutarse el runner de
QA descrito en `docs/implementation/board-web-v2-lifecycle-bootstrap.md:17-31` sobre un APK de
prueba (`-PboardQaLifecycle=true`) y registrar la matriz completa con cero egress.

### Cierre

Restaura la densidad y el tamaño de pantalla si los cambiaste, y suelta el candado `android`.
Registra los resultados en este documento o en su informe.
