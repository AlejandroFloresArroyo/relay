# Relay V3: aceptación y matriz de compatibilidad

Resultado de [V3: verificar aceptación y publicar matriz de compatibilidad](https://github.com/AlejandroFloresArroyo/relay-app/issues/97), 2026-10-05, sobre `dev` con #75–#96 integrados. Los criterios son los seis escenarios de [docs/relay-v3.md §7](relay-v3.md#7-compatibilidad-y-aceptación). Esta matriz lista solo lo que se ejecutó. Lo que no aparece, o aparece como **no probado**, no está certificado, aunque una dependencia diga que lo admite.

**V3 no se declara lista.** Faltan pruebas de las herramientas del Servidor en un teléfono y una tablet físicos, y Tailscale Services y HTTPS reales (requieren a Ale en la consola de la tailnet). El Puente V3 y el supervisor están desplegados en producción desde el 2026-10-05, y la app 3.0.0 está instalada en la tablet física (ver «Despliegue de producción y tablet física»). La aceptación encontró tres defectos, ya corregidos (ver «Defectos encontrados»).

## Cómo se probó

### Suite de aceptación del Puente

`bridge/test/acceptance/*.test.ts`, en el gate (`cd bridge && npm test`). Cada escenario arranca un laboratorio desechable (`bridge/support/acceptance_lab.ts`):

- **Supervisor real como proceso propio**: `node supervisor/src/main.ts`, como lo arranca `relay-supervisor.service`. Usa el gestor systemd de usuario, un scope `relay-acc-<aleatorio>-<id>.scope` por entorno en `app.slice`, cgroup v2, node-pty 1.1.0 y bash y tmux reales. La limpieza para todas las unidades y falla si queda alguna.
- **Puente real**: `createApp`, cableado como `bridge/src/main.ts` con `RELAY_SUPERVISOR_DIR`, `RELAY_REMOTE_FILES=1` y `RELAY_REMOTE_WEB=1`. Se puede parar y arrancar otra vez mientras el supervisor sigue vivo. El descubrimiento web lee la tabla de sockets real (`/proc/net/tcp`).
- **Directorios efímeros**: carpeta personal de archivos con un `.hermes` de prueba (perfiles `default` y `coding`), estado de Relay y estado y socket del supervisor. Las terminales corren con esa carpeta como `HOME` y su propio `TMUX_TMPDIR`.
- **Dobles**: Hermes (`FakeHermes`), el publicador de Tailscale Services (simulado; las cabeceras `Host` y `X-Forwarded-Proto` se ponen a mano, como las enviaría Serve) y la dirección del par (100.64.0.1). Nada usa el Hermes real (8642, 9119), el Puente real (8650), `~/.hermes`, `~/.config/relay` ni perfiles de navegador de la persona.
- **Navegadores reales**: el dedicado, con cada binario instalado (Chromium y Google Chrome). El habitual, con `RELAY_LAB_BROWSER=cft|chrome`: sin esa variable se salta con su motivo, porque necesita Chrome for Testing en `labs/v3-cdp/.browsers` (`cd labs/v3-cdp && npm run browsers`) o cargar la extensión en Chrome.
- **Registros**: cada escenario termina con `assertLogsClean`. Toda línea del Puente debe ser `MÉTODO ruta-etiqueta estado Nms` o `web app_<id> MÉTODO estado`, sin IDs de entidad en la ruta y sin ninguno de los secretos usados: llaves, códigos, cookies, texto escrito, rutas, contenidos y URL. La salida del supervisor se comprueba igual.

|Archivo|Escenario|Duración observada|
|---|---|---|
|`terminal.test.ts`|1|1,3 s|
|`lockRevoke.test.ts`|2|8–17 s|
|`files.test.ts`|3|1,2–2,5 s|
|`web.test.ts`|4|4–6 s|
|`browsers.test.ts`|5 y la parte del habitual del 2|3 s (dedicado); 12 s con CfT; 28 s con Chrome|

### Compatibilidad con un Puente sin V3

`mobile/src/core/bridgeCompat.test.ts`, en `cd mobile && npm test`. Usa el núcleo real de la app de esta compilación: comprobación de protocolo, estado de las herramientas, cliente remoto y cliente de v1 y v2. Lo enfrenta a:

- El Puente de la versión v2 que corre en producción: `relay-app-bridge-v2.0.0`, commit `3498e99`, `relayd 0.2.0-preview.3`. Se extrae con `git archive` y su `/health` observado en producción no lleva `capabilities`.
- Este Puente sin ninguna herramienta V3 configurada, que es como queda producción por defecto.
- La vuelta atrás de un Puente V3 a v2 en la misma dirección.

### App en Android

- Componentes (Jest + RNTL, `npm run test:components`) con `LockGate`, `AppProvider` y el núcleo reales: las suites de #82, #84, #88, #91, #94 y #95, más la prueba de #97 del Servidor desemparejado (`Workspace.component.test.tsx`).
- Emulador tablet con el **APK release** (`APP_VARIANT=release`, sin demo) emparejado con un Puente de laboratorio en la IP de la tailnet. Ese Puente usa el mismo laboratorio: supervisor real, Chromium real y una web falsa. Capturas `t01`–`t29` en el informe `v3-97-evidence`.

## Escenarios de §7

|#|Criterio|Evidencia|Resultado|
|---|---|---|---|
|1|Shell y carpeta, tmux o pantalla completa, varias pestañas, teclado; recuperar terminales vivas tras reconexión y reinicio del Puente|`terminal.test.ts`: `/v1/remote/shells`, carpeta inexistente rechazada, bash y sh en sus carpetas, `stty size` tras resize, Ctrl-C, flecha arriba, Tab, pegado multilínea, tmux con pantalla alternativa, reconexión con `Last-Event-ID` sin hueco, reinicio del Puente con el trabajo de tmux escribiendo, continuidad de `seq`, programa terminado con su código y sin sustituto, terminar vacía el scope. Emulador: terminal real, Gboard, tmux (`t09`, `t10`)|Cumple en laboratorio. Teclado físico real y teléfono físico: **no probado**|
|2|Bloquear y desconectar sin Ctrl-C ni pérdida; revocar cortando todo, terminando lo propio y conservando lo compartido|`lockRevoke.test.ts`: trampa de INT, HUP y TERM sin marcas al bloquear y al perder el Puente; latido continuo; hueco visible al desbordar el anillo; revocación con el Puente caído reconciliada al arrancar; revocación con terminal, navegador dedicado, subida a medias y SSE web abiertos (todo cortado, 403 `device_revoked`, scopes vacíos, temporal borrado); tmux compartido conservado; la tablet intacta. `browsers.test.ts` (habitual): todas las pestañas, también la que abrió Relay, siguen tras revocar. Emulador: «SIN ACCESO» y scopes terminados (`t29`)|Cumple en laboratorio|
|3|Crear, mover, transferir, borrar y editar; confirmaciones, enlace frente a destino, conflicto concurrente, versiones de perfiles de Hermes; transferencias incompletas nunca terminadas|`files.test.ts`: 428 sin confirmación, enlaces con su destino real (borrar quita solo el enlace, escribir llega al destino), UTF-8, UTF-16 LE/BE con BOM, ISO-8859-1 y Windows-1252 con CRLF, carácter no representable, límite de 5 MiB, conflicto 409 conservando el cambio externo, `SOUL.md` con versión anterior guardada, `..` rechazado, perfiles protegidos, subida multitrozo idéntica, cancelada, incompleta e interrumpida por reinicio nunca publicada, búsqueda con cancelación|Cumple en laboratorio, con fixtures|
|4|Web falsa dentro y fuera de Relay; navegación, formularios, subidas, descargas y canal de desarrollo; una hora sin renovación, sin acceso al control ni a otra aplicación, con corte de streams|`web.test.ts`: descubrimiento real sin 8642, 9119, 8650 ni el propio Puente (Hermes escucha de verdad en este equipo), ticket de un solo uso, `Host` ajeno 421, `Origin` ajeno 403, cookies de Relay nunca reenviadas, subida de 1 MiB y descarga con SHA-256, SSE y WebSocket, canje de un solo uso, hora exacta que no se renueva con el uso ni crece con el reloj de pared atrasado 24 h, corte de SSE y WS al vencer, al cancelar y al revocar, reinicio del Puente que pierde las autorizaciones|Cumple en laboratorio con Services **simulado**. Emulador: «En Relay» no carga porque el origen del Service no existe sin Services reales («LA PÁGINA NO CARGÓ», `t16`): pendiente de Ale|
|5|Chrome/Chromium dedicado y habitual, sin copiar sesiones; convivencia local, desconexión visible y diálogos incompatibles identificados|`browsers.test.ts`: dedicado con Chromium 152 y Chrome 154 (cuadros JPEG, toque, texto, teclas, desplazamiento, atrás, recargar, `confirm`, `alert` y `prompt` con controles de Relay, URL no http(s) rechazadas, selector y descarga por la transferencia de archivos, desconectar conserva, terminar vacía el scope, la cookie del perfil de la persona nunca llega). Habitual con CfT 154 y Chrome 154: solo la pestaña compartida, convivencia con la persona escribiendo en otra pestaña, pestaña nueva de Relay en segundo plano, `chrome://` como limitación visible, DevTools no quita el control (contrato de #93). Emulador: el dedicado en un panel (`t19`)|Cumple en laboratorio, con los defectos D1 y D2. Diálogos nativos del habitual (autenticación HTTP, permisos, imprimir): **no probado**|
|6|Alternar herramientas y Conversación; dos paneles y foco de teclado inequívoco en tablet; Puente sin V3; registros sin secretos|Emulador tablet 2560×1600 con APK release: `>_` desde la Conversación, entrada con el código del teléfono, terminal real y navegador dedicado en dos paneles con «RECIBE EL TECLADO», vuelta a la Conversación con el borrador intacto y regreso sin repetir la verificación ni perder terminal ni página (`t05`–`t22`). Componentes de #95 y la prueba del Servidor desemparejado. `bridgeCompat.test.ts`. `assertLogsClean` en los cinco escenarios del Puente|Cumple, con el defecto D3. Teclado físico real, teléfono y tablet físicos: **no probado**|

## Matriz probada

|Componente|Probado (versión exacta)|Dónde|
|---|---|---|
|Sistema del Servidor|Arch Linux (Omarchy 4.0.4), Linux 7.2.5, x86_64, glibc 2.44|Toda la suite|
|systemd y cgroups|systemd 261 con gestor de usuario, cgroup v2 (`cgroup2fs`), `app.slice` delegado con `cgroup.kill`, `memory` y `pids`|Toda la suite; `relayd doctor`|
|Node (Puente y supervisor)|26.10.0|Toda la suite|
|PTY|node-pty 1.1.0, compilado en el Servidor (GCC 16.2.1, make 4.4.1, Python 3.14.7)|Escenarios 1 y 2|
|Shells y multiplexor|bash 5.3.15, sh (enlace a bash), tmux 3.7c|Escenarios 1 y 2|
|Navegador dedicado|Chromium 152.0.7977.82 y Google Chrome 154.0.8037.57|Escenario 5|
|Navegador habitual|Chrome for Testing 154.0.8037.92 y Google Chrome 154.0.8037.57, con la extensión de Relay (canal versión 3)|Escenarios 5 y 2|
|Tailscale|CLI 1.102.3. Services y HTTPS: **simulados**, no habilitados en la tailnet|Escenario 4|
|Puente anterior|relayd 0.2.0-preview.3 (`3498e99`, el v2 de producción)|Compatibilidad|
|App|Expo SDK 57.0.26, React Native 0.86.3, React 19.2.3, react-native-webview 13.16.1, @xterm/xterm 6.0.0; APK release `io.github.alejandrofloresarroyo.relay` versionCode 6 en el emulador y 3.0.0 (versionCode 7) en la tablet física, minSdk 24, targetSdk 36|Emulador; tablet física|
|Android|16 (API 36), imagen `google_apis_playstore` x86_64 r07, emulador 37.2.12|Emulador tablet|
|WebView del sistema|`com.google.android.webview` 133.0.6943.137|Emulador tablet|
|Teclado|Gboard en el emulador (texto ASCII por `adb input`)|Emulador tablet|

### No probado

- **Arquitecturas y sistemas**: linux-arm64, otras distribuciones y otras glibc, otros systemd, Node 27 o posterior, node-pty 1.2.0-beta.15 en el producto (solo en el laboratorio de #76), macOS y Windows (fuera de alcance).
- **herdr dentro de la terminal**: instalado (0.8.2), pero la suite no lo usa. tmux cubre el criterio «herdr/tmux».
- **Navegadores**: Chromium 152 como habitual (la extensión exige 154), otras versiones de Chrome y Chromium, Firefox y Safari (fuera de alcance). Diálogos nativos del habitual. Limitaciones `canceled_by_user`, `debugger_busy` y `restricted`.
- **Android**: teléfono físico, y en la tablet física las herramientas del Servidor (terminal, archivos, navegador dedicado y dos paneles de herramientas), que piden la huella o el patrón del dispositivo (ver «Despliegue de producción y tablet física»). Teclado físico real, Gboard con acentos y ñ en el APK (`adb input` no los envía; #77 los probó en su laboratorio), TalkBack, ventana dividida real, otras versiones de Android y de WebView. El emulador teléfono no se arrancó en #97: la ventana de teléfono la observó la revisión de #95 con la demo.
- **Tailscale Services y HTTPS reales**: toda la lista «Validación real pendiente» de [docs/v3-install.md](v3-install.md#validación-real-pendiente).
- **Producción**: el navegador habitual no está activado (falta cargar la extensión en Chrome, paso de Ale) y la web externa no está publicada (`relayd doctor`: `falta Web: Tailscale HTTPS/Services`).

### Capacidades de Relay 3.1

Se anuncian en `capabilities` de `/health` como las de V3, sin cambiar `PROTOCOL_VERSION` (2) ni `MIN_APP_PROTOCOL_VERSION` (2). Tipos en `protocol/protocol.ts`.

|Capacidad|`version`|`minAppVersion`|Petición|Se anuncia si|Probado|
|---|---|---|---|---|---|
|`metrics` (#104)|1|1|`GET /v1/metrics`, con la llave y `X-Relay-Protocol` como las demás lecturas `/v1`. Devuelve `cpuPercent`, `memoryPercent` (sin la caché), `diskPercent` (disco del directorio de Hermes, como `df`), de 0 a 100, y `measuredAt` en ms del reloj del Servidor. Una lectura fallida responde 503 `metrics_unavailable` con texto fijo|El lector de sistema funciona en la plataforma: Linux con `/proc/meminfo` y `os.cpus()`|`bridge/test/metrics.test.ts` con el lector falso; `mobile/src/core/serverMetrics.test.ts` con el núcleo de la app frente a un Puente con y sin el anuncio. Un Puente sin `metrics` (anterior o sin lector) no se consulta y la app lo distingue de una lectura fallida|

Mutación de «Registros sin secretos» sobre `metrics`: el error de la lectura fallida con el texto del error del lector (lleva la ruta del directorio de Hermes) pone en rojo `a failed read answers a generic error…` (`deepStrictEqual` del cuerpo 503: `message` con `statfs '/srv/synthetic-owner/.hermes-fixture'`); una línea de registro con el valor de CPU (`metrics cpu 75`) la pone en rojo en la comparación de las líneas del registro. Restaurado, en verde.

## Guardas de «Fails silently»

Cada guarda se rompió a propósito sobre la suite de aceptación. Se registró el rojo, se restauró con `git checkout` y se comprobó el verde con el árbol limpio. Los registros están en `v3-97-evidence/mutation-*.log`.

|Guarda|Mutación|Prueba en rojo|
|---|---|---|
|Registros sin secretos|La línea de registro con `req.url` en lugar de la etiqueta|`terminal.test.ts`|
|Bloqueo sin Ctrl-C|El supervisor escribe `\x03` cuando se va el Puente|`lockRevoke.test.ts`|
|Revocación|La reconciliación no termina los entornos de un dueño revocado|`lockRevoke.test.ts`|
|Revocación|La revocación no corta las sesiones web|`web.test.ts`|
|Revocación|La revocación cierra las pestañas que abrió Relay en el habitual|`browsers.test.ts` (CfT)|
|Pertenencia|El habitual informado como `own`|`browsers.test.ts` (CfT)|
|Pérdida visible|El supervisor no envía `gap`|`lockRevoke.test.ts`|
|Disco: temporales|Una subida cancelada o revocada deja su temporal|`lockRevoke.test.ts`|
|Disco: confirmación|Borrar sin `confirm`|`files.test.ts`|
|Disco: conflicto|Sin las dos comprobaciones de versión del guardado. Quitar solo una sigue en verde, porque la otra lo detecta; la ventana entre ambas es de `remoteFileSaves.test.ts`|`files.test.ts`|
|Disco: incompletos|Publicar una subida con bytes de menos|`files.test.ts`|
|Disco: rutas|Aceptar `..` como nombre|`files.test.ts`|
|Disco: enlaces|No resolver la ruta real|`files.test.ts`|
|Perfiles de Hermes|No guardar la versión anterior|`files.test.ts`|
|Perfiles de Hermes|Permitir mover el directorio de un perfil|`files.test.ts`|
|Códigos de un solo uso|El ticket de entrada reutilizable|`web.test.ts`|
|Tiempo|La hora medida con el reloj de pared|`web.test.ts`|
|Tiempo|Una autorización de dos horas|`web.test.ts`|
|Corte de streams|Las sesiones vencidas no cortan SSE ni WS|`web.test.ts`|
|Servicios de control|8642 y 9119 fuera de la lista de excluidos|`web.test.ts`|
|Cookies|Reenviar las cookies de Relay a la aplicación|`web.test.ts`|
|Perfil propio del dedicado|El dedicado usa el perfil de la persona|`browsers.test.ts`|
|URL del navegador|Abrir cualquier URL de texto|`browsers.test.ts`|
|Versión y capacidades|La app toma por V3 un Puente que no anuncia nada|`bridgeCompat.test.ts`|
|Versión y capacidades|El cliente remoto sigue enviando tras «el Puente cambió»|`bridgeCompat.test.ts`|
|Selección de Servidor|El host conserva las herramientas de un Servidor desemparejado|`Workspace.component.test.tsx`|

La primera versión de `web.test.ts` leía la lista de puertos y la hora del propio producto, así que romperlas no la ponía en rojo. Ahora las escribe literalmente.

## Defectos encontrados

No se corrigieron en #97. D1, D2 y D3 se corrigieron después en `fix/v3-acceptance-defects`, cada uno con su prueba primero y su mutación (abajo, «Corregido»).

- **D1. Un toque que abre un diálogo de JavaScript responde 503 si el diálogo no se contesta en 15 s.** `Input.dispatchMouseEvent` (soltar) no vuelve hasta que el diálogo se cierra, y el plazo de la petición CDP (`supervisor/src/browser.ts`, `CDP_TIMEOUT_MS`) y el del enlace de la extensión (`habitualBrowser.ts`) lo convierten en `remote_unavailable`. Se observó con Chromium 152 y con CfT 154. La app muestra «no disponible» para un toque que sí ocurrió. Arreglo sugerido: resolver el toque al llegar `Page.javascriptDialogOpening`.
  **Corregido.** El supervisor responde la entrada `Input.*` pendiente de esa pestaña al llegar `Page.javascriptDialogOpening`. La extensión hace lo mismo, y además no espera a `Page.setInterceptFileChooserDialog` (apagar) mientras el diálogo está abierto, porque Chrome tampoco lo responde. `browsers.test.ts` exige que el toque responda `{}` en menos de 10 s, con `onclick` y con `onmousedown`, en el dedicado y en el habitual.
- **D2. El título de una pestaña dedicada se queda en `host:puerto`.** El supervisor solo lo actualiza con `Target.targetInfoChanged`, que Chromium 152 y Chrome 154 sin interfaz no envían al leer `<title>`. Es menor: afecta a la etiqueta de la pestaña.
  **Corregido.** El supervisor pide `Target.getTargetInfo` con cada `Page.loadEventFired` y al terminar de adjuntarse a la pestaña: una página que cargó antes de `Page.enable` no envía el evento. `browsers.test.ts` espera «Principal» y, en el flujo, «Dos» tras navegar.
- **D3. En Android, el campo «Escribir en la página» del Navegador no conserva el teclado del sistema.** Se observó en el emulador tablet con el APK release, en uno y en dos paneles: al tocarlo, Gboard se prepara y la propia app pide ocultarlo (`ImeTracker: onRequestHide … HIDE_SOFT_INPUT_FROM_VIEW`). Pasa justo después de abrir el teclado, y la barra de dirección sí lo conserva. El texto inyectado por `adb` llega con letras perdidas. [INFERENCIA] Abrir el teclado encoge la caja de la página, `onLayout` pide otra vista, el cuadro deja de ser `live`, el campo pasa a `editable={false}` y React Native lo desenfoca. Las pruebas de componentes de #94 no modelan el teclado que redimensiona. Bloquea escribir en páginas con el teclado virtual.
  **Corregido.** La inferencia se confirmó: en el emulador teléfono con el APK release demo sin el arreglo se repite el `HIDE_SOFT_INPUT_FROM_VIEW` y el campo pierde el foco. El campo queda editable mientras el panel está visible, también con el cuadro desfasado. La sesión sigue sin enviar nada hasta que el cuadro vuelve a ser `live`; lo escrito espera en el campo. Con el arreglo, Gboard queda abierto, el texto llega entero y la tecla de enviar de Gboard manda «cliente-7ña» sin cerrar el teclado. Prueba de componentes: «the page field keeps the keyboard when it shrinks the page».
- **Documentación.** La ADR 0006 («integración de #92 y #93») dice que revocar cierra el flujo con `closed: exited`. En el habitual, el corte de la revocación llega antes y el flujo termina sin ese evento. El comportamiento cumple «Revocación»; la frase vale solo para terminar.

## Guía de actualización

De un Servidor con el Puente v2 a V3. La referencia es [docs/v3-install.md](v3-install.md); aquí van el orden y las comprobaciones de esta matriz.

1. **Comprobar la base**: `cd bridge && ./relayd doctor`. Hace falta la combinación de la tabla de arriba. Cada `aviso` de versión fuera de la matriz se registra antes de darla por buena.
2. **Revisar los drop-ins**. El de actualización de v2 (`relay-bridge.service.d/90-relay-v2-update.conf`) sustituye `ExecStart` y haría arrancar el Puente v2 aunque la unidad apunte al checkout nuevo. Retíralo a mano antes del paso 5.
3. **Actualizar el checkout** a la versión V3 y, en `bridge/` y `mobile/`, las dependencias de desarrollo si se compila allí.
4. **Compilar el supervisor**: `cd supervisor && npm run setup` (node-pty 1.1.0 con las cabeceras del Node en uso).
5. **Simular y después instalar**: `./relayd setup --dry-run --supervisor --files --web --replace-service --restart`, y lo mismo sin `--dry-run`, con las opciones que se quieran (`--browser-habitual` exige `--supervisor`). El supervisor se instala y arranca antes que el Puente; ninguna unidad nombra a la otra.
6. **Navegador habitual, opcional**: `./relayd browser google-chrome`, cargar `bridge/extension/` en Chrome 154 y comprobar el ID.
7. **Web externa, opcional**: los pasos de consola de «Publicar una web». Siguen sin validar en una tailnet real.
8. **Actualizar la app** en el teléfono. Un Puente sin V3 sigue sirviendo v1 y v2 y la app muestra «Actualiza el Puente» por herramienta, sin enviar nada remoto (`bridgeCompat.test.ts`).
9. **Volver atrás**: un Puente v2 no lee un `changes.jsonl` con acciones `remote.*`. Hay que apartar ese archivo antes (ADR 0006, #81). La app deja de usar las herramientas tras la primera respuesta «el Puente cambió».

Actualizar o reiniciar el Puente nunca termina terminales. Reiniciar el supervisor las deja `lost`. Las autorizaciones web viven en memoria y se pierden al reiniciar el Puente.

## Despliegue de producción y tablet física

2026-10-05, rama `release/v3.0.0`. El registro del Servidor (checkout, opciones, estado, respaldo y vuelta atrás) está en [docs/v3-install.md](v3-install.md#despliegue-de-producción-2026-10-05).

|Comprobación|Resultado observado|
|---|---|
|Puente|`relay-bridge.service` corre `bridge/src/main.ts serve` del checkout fijado `27b5bc8`, con `RELAY_SUPERVISOR_DIR` y `RELAY_REMOTE_FILES=1`. `GET /health`: `protocolVersion` 2 y `capabilities` `environments`, `terminal`, `files` y `browser`, todas `version` 1. Sin `web`: la tailnet no tiene HTTPS ni Services|
|Supervisor|`relay-supervisor.service` activo, separado del Puente|
|`relayd doctor`|`ok` en todo salvo `falta Web: Tailscale HTTPS/Services` y dos `aviso` del navegador habitual (adaptador de Chrome sin registrar; Chromium 152 no carga la extensión)|
|Estado|Seis dispositivos activos y los archivos de estado iguales al respaldo (`SHA256SUMS`). `devices.json` difiere solo por el código pendiente que muestra `setup` y un intento fallido de la sonda propia sin llave; la lista de dispositivos es idéntica|
|Hermes|`hermes-gateway` y `hermes-dashboard` activos; `:8642/health` 200 y `:9119/` 302, como antes|
|Registro|Solo método, ruta con etiqueta, estado y tiempo, el aviso de `RELAY_KEY` obsoleto y las líneas de arranque|
|APK|`relay-3.0.0-f32bb0c.apk`, 137671190 bytes, SHA-256 `d99491d6b7d3638b5fb7970391359a64eb24037500a581968f08c87a8efd01b5`; versionCode 7, versionName 3.0.0, SDK 36; certificado `2048c7ed…8e6dd96`, el de siempre|
|Tablet|Samsung SM-X520, Android 16, horizontal 2304×1440. Relay 3.0.0 se instala junto a Relay Dev sin tocarlo|
|Emparejamiento|«Escribir a mano» con la dirección y el código de `relayd pair` (por `adb input`): «EMPAREJADO», 3 Agentes. El Puente tiene ahora siete dispositivos|
|Agentes y Conversación|Lista con los tres Agentes reales y Conversación de `default` en dos paneles (lista y Conversación)|
|Herramientas del Servidor|**No probado**: `>_` pide la huella o el patrón del dispositivo, que solo tiene Ale. Terminal, Archivos, navegador dedicado y dos paneles de herramientas quedan pendientes|
|Widget|Colocado desde el selector de widgets del lanzador: «APROBACIONES 0», hora de lectura y los tres Agentes en verde|

Observado en la tablet, sin corregir:

- En el riel de navegación, con la lista de Agentes y la Conversación abiertas, «SERVIDORES» se parte en dos líneas («SERVIDORE / S»).
- En el widget, el nombre `personal` se parte («persona / l»).
- La vista previa del widget en el selector del lanzador es un recuadro blanco con el icono.

## Pendientes que no cierra #97

- **Hardware**: teléfono físico con teclado virtual español y teclado físico; en la tablet física, las herramientas del Servidor (pide la huella de Ale).
- **Tailscale Services y HTTPS**: Ale tiene que aprobarlos en la consola de la tailnet. Los pasos exactos y la lista de observaciones están en [docs/v3-install.md](v3-install.md#pasos-en-la-consola-de-tailscale-una-vez).
- **Navegador habitual en producción**: cargar la extensión en Chrome (pasos de Ale en [docs/v3-install.md](v3-install.md#despliegue-de-producción-2026-10-05)).
- **Defectos D1, D2 y D3**: corregidos en `fix/v3-acceptance-defects`.
