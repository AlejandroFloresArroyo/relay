# Navegador del Servidor: CDP dedicado y extensión en el habitual (#78)

Validación aislada de las dos arquitecturas candidatas de `docs/relay-v3.md` §6: navegador
dedicado controlado por CDP con perfil propio, y pestañas elegidas del navegador habitual mediante
una extensión con `chrome.debugger` y un adaptador local por native messaging. Laboratorio en
`labs/v3-cdp/`, rama `validate/v3-cdp-extension`, 2026-10-05.

No se usó Hermes, el Puente, Tailscale ni el firewall. Ningún navegador abrió el perfil de Ale:
cada lanzamiento recibe un `HOME`, `XDG_CONFIG_HOME` y `XDG_CACHE_HOME` sintéticos bajo `/tmp` y,
salvo en la prueba del perfil predeterminado (que es el predeterminado de ese `HOME` sintético),
un `--user-data-dir` efímero. Las páginas son sintéticas y se sirven en `127.0.0.1` con puerto
efímero.

## Veredicto

| Configuración | Dedicado por CDP | Extensión en el habitual |
|---|---|---|
| Chrome for Testing 154.0.8037.92 (laboratorio) | **PASS** con transporte por puerto. **FAIL** con `--remote-debugging-pipe`: cerrar la tubería termina el navegador. **FAIL** de la guarda propia del navegador: acepta CDP sobre el perfil predeterminado. | **PASS** (13/13) |
| Chromium 152.0.7977.82 Arch Linux (sistema) | Igual que Chrome for Testing: PASS por puerto, FAIL por tubería y FAIL de la guarda del perfil predeterminado. | **FAIL intermitente** en la captura de una pestaña en segundo plano: falló 4 de 6 repeticiones (`05-…`), aunque pasó en la ejecución completa `11-chromium.txt`. El resto PASS. |
| Google Chrome 154.0.8037.57 (sistema) | PASS por puerto, FAIL por tubería. Rechaza CDP sobre el perfil predeterminado (PASS). | **FAIL** de instalación: ignora `--load-extension` (las 13 pruebas fallan). Cargada por `Extensions.loadUnpacked`, todo PASS (13/13). |

Recuentos de las ejecuciones completas en serie (36 pruebas: 10 del protocolo, 13 del dedicado y
13 de la extensión): CfT 34/36, Chromium 34/36, Chrome 22/36 y Chrome con `loadUnpacked` 35/36.
La salida completa está en `docs/research/v3-cdp-evidence/1*.txt`. Cada FAIL tiene su
alternativa en «Incompatibilidades y alternativas». Ninguno se convierte en PASS en este
documento: las pruebas siguen escritas con la expectativa del producto y fallan en el laboratorio.

## Versiones exactas

| Componente | Versión |
|---|---|
| Sistema | Linux 7.2.5-3-omarchy x86_64 |
| Node | v26.10.0 (pruebas `node --test` con type stripping) |
| Descarga de navegadores | `@puppeteer/browsers` 3.2.3, fijado en `labs/v3-cdp/package.json` y `package-lock.json` |
| Chrome for Testing | 154.0.8037.92, revisión 1689415 (canal Stable a 2026-10-03), fijado en `config.chrome`. CDP: `product=Chrome/154.0.8037.92 protocol=1.3 jsVersion=15.4.80.19` |
| Chromium | 152.0.7977.82 Arch Linux (`/usr/bin/chromium`). CDP: `product=Chrome/152.0.7977.82 protocol=1.3 jsVersion=15.2.124.21` |
| Google Chrome | 154.0.8037.57 (`/usr/bin/google-chrome-stable`). CDP: `product=Chrome/154.0.8037.57 protocol=1.3 jsVersion=15.4.80.11` |
| Protocolo DevTools | 1.3; `chrome.debugger.attach(…, '1.3')` |

Los navegadores del sistema no se pueden fijar desde el laboratorio. Su versión se lee con
`--version`, la prueba la compara con la que informa CDP y queda registrada en la salida.

## Laboratorio

```
labs/v3-cdp/
  package.json, package-lock.json   manifiesto propio; versión de Chrome for Testing fijada
  extension/actions.js              protocolo acotado: validación y traducción a CDP (compartido)
  extension/manifest.json, background.js   extensión MV3 de laboratorio (ID fijo por "key")
  host/relay-lab-host.ts            adaptador de native messaging: extensión <-> socket Unix del Puente
  lib/browser.ts                    lanzador con HOME/perfil efímeros y cliente CDP (tubería o WebSocket)
  lib/usual.ts                      navegador habitual de prueba: extensión, adaptador y Puente falso
  lib/fixtures.ts                   páginas sintéticas en 127.0.0.1 con puerto efímero
  test/actions.test.ts              protocolo acotado (sin navegador)
  test/dedicated.test.ts            navegador dedicado por CDP
  test/extension.test.ts            extensión, native messaging y adaptador
```

El laboratorio no añade dependencias a `bridge/` ni a `mobile/`, y `scripts/gate.sh` no lo
ejecuta. `.browsers/` (394 MB) y `node_modules/` quedan ignorados.

- **Dedicado:** el lanzador abre el navegador con `--headless`, `--user-data-dir` efímero y
  `--remote-debugging-pipe` o `--remote-debugging-port=0`. Las acciones pasan por
  `extension/actions.js` igual que en la extensión.
- **Habitual:** el navegador se abre en modo con interfaz (`--ozone-platform=headless
  --window-size=1280,800`): ventanas, barra de depuración y DevTools reales, sin superficie
  visible. El manifiesto del host va en `<perfil>/NativeMessagingHosts/com.relay.lab.json`. El
  host lanzado por Chrome conecta con un socket Unix del Puente falso; el Puente solo alcanza el
  navegador a través de ese adaptador.
- **Oráculo:** la prueba abre además una tubería CDP propia hacia el habitual para hacer de
  persona en la computadora (abrir, escribir, navegar o cerrar pestañas, abrir DevTools) y para
  leer el estado. La producción no tiene esa tubería. La elección de la pestaña llama a la misma
  función que el botón de la barra de herramientas (`relayShareTab`). No se pulsó el botón real.

### Comandos

```bash
cd labs/v3-cdp
npm ci && npm run browsers                         # descarga Chrome for Testing 154.0.8037.92 en .browsers/
RELAY_LAB_BROWSER=cft npm test                     # 10-cft.txt
RELAY_LAB_BROWSER=chromium npm test                # 11-chromium.txt
RELAY_LAB_BROWSER=chrome npm test                  # 12-chrome.txt (extensión por --load-extension)
RELAY_LAB_BROWSER=chrome RELAY_LAB_EXT_LOAD=cdp npm test   # 13-…: extensión por Extensions.loadUnpacked
```

Las cuatro configuraciones se ejecutaron en serie. Con las cuatro en paralelo aparecieron fallos
de carga que no se reproducen en serie (`20-…` y `21-…`, ver «Límites de la evidencia»).

### Primero la prueba que falla

1. Se escribieron las tres suites antes de cualquier implementación. Salida:
   `00-red-sin-implementacion.txt` (las tres fallan con `ERR_MODULE_NOT_FOUND`).
2. Guardas rotas a propósito, rojo registrado, restauradas y en verde de nuevo:
   - Protocolo que acepta cualquier tipo de acción (`default: return a`): falla `refuses raw CDP
     and unknown action types` (`01-mutacion-protocolo.txt`).
   - Extensión sin comprobar que la pestaña está compartida: falla `only tabs the user shared…`
     con `Missing expected rejection`.
   - Adaptador sin límite de 1 MB: falla `the adapter refuses raw CDP and oversized requests…`.
     Chrome no responde y corta el host; la extensión vuelve a conectar.
   - Extensión que no suelta el depurador al perder el adaptador: falla `losing the adapter…`.

   Las tres últimas están en `02-mutaciones-extension.txt`.

## Criterio 1: perfil dedicado, captura, entrada, pestañas, navegación y reconexión

Suite `test/dedicated.test.ts`, en las tres configuraciones:

| Prueba | CfT 154 | Chromium 152 | Chrome 154 |
|---|---|---|---|
| El perfil predeterminado rechaza CDP | FAIL | FAIL | PASS |
| Perfil dedicado: versión exacta por `Browser.getVersion` | PASS | PASS | PASS |
| Cuadro JPEG, toque, texto (con «ñ» y «✓»), Retroceso, Intro, toque táctil crudo, desplazamiento | PASS | PASS | PASS |
| Pestañas: crear, listar, activar, cerrar (`Target.*`) | PASS | PASS | PASS |
| Navegar, atrás, adelante, recargar | PASS | PASS | PASS |
| Reconexión por puerto: cerrar el cliente y reconectar encuentra las mismas pestañas | PASS | PASS | PASS |
| Cerrar la tubería CDP conserva navegador y pestañas | FAIL | FAIL | FAIL |
| El perfil dedicado conserva `localStorage` y cookie tras reiniciar el navegador | PASS | PASS | PASS |
| Diálogos JavaScript, selector de archivos, descargas, `<select>` por teclas y screencast con confirmación (criterios 4 y 5) | PASS | PASS | PASS |

Observado:

- **Perfil predeterminado.** Con un `HOME` sintético, sin `--user-data-dir` y en modo con
  interfaz, Google Chrome escribe `DevTools remote debugging requires a non-default data
  directory. Specify this using --user-data-dir.` y no abre el puerto. Chrome for Testing y
  Chromium abren el puerto (`DevTools listening on ws://127.0.0.1:…`) sobre
  `~/.config/google-chrome-for-testing` o `~/.config/chromium`. Con `--headless`, CfT y Chrome no
  usan el perfil predeterminado: crean `…-headless`. Por eso la prueba usa el modo con interfaz. Es el
  cambio de Chrome 136 ([anuncio](https://developer.chrome.com/blog/remote-debugging-port)), que
  solo protege las compilaciones con marca.
- **Tubería.** Al cerrar `--remote-debugging-pipe` desde el lado del Puente, el navegador termina
  con código 0 en las tres configuraciones (`exitCode after pipe close: 0`). Un reinicio del
  Puente perdería así el navegador dedicado y sus pestañas.
- **Puerto.** Con `--remote-debugging-port=0` el navegador sobrevive al cierre del cliente y la
  reconexión por la misma URL `ws://` encuentra la pestaña creada antes.
- Cuadro de 765×437 px a calidad 60 de la página de formulario: 6 174 bytes (CfT).

## Criterio 2: permisos, native messaging, adaptador y métodos disponibles en la extensión

Extensión MV3 con permisos `debugger`, `nativeMessaging`, `tabs` y `downloads`.

- **Native messaging.** Chrome busca el manifiesto del host de usuario en
  `<user-data-dir>/NativeMessagingHosts/`, como dice la
  [documentación](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  («subdirectory of the user profile directory»). Funcionó en CfT, en Chromium y en Chrome con la
  extensión cargada por `loadUnpacked`. Chrome pasa al host el origen del llamante
  (`chrome-extension://opcncffglnlpmffjmnjekehnidddcfbk/`) y el adaptador se lo entrega al Puente
  para comprobarlo.
- **Límite de 1 MB del host al navegador.** Medido con el adaptador sin su guarda: un mensaje de
  ~1 048 000 bytes llega a la extensión; uno de ~1 049 000 no tiene respuesta, Chrome corta el
  host y la extensión vuelve a conectar. El adaptador rechaza antes las peticiones de más de
  1 MiB (`request too large`) sin perder el canal. En sentido contrario el límite documentado es
  64 MiB; por ahí viajan los cuadros.
- **El puerto nativo mantiene vivo el service worker.** Tras 40 s sin actividad ni depurador
  sobre el worker, la misma conexión del host sigue respondiendo (prueba `…past the 30 s idle
  limit`, PASS en CfT, Chromium y Chrome por `loadUnpacked`).

Catálogo `chrome.debugger` sobre una pestaña http (CfT 154). Las líneas son idénticas en
Chromium 152 y en Chrome 154 cargada por `loadUnpacked` (mismo `md5sum`; ver `1*.txt`):

| Método | Resultado |
|---|---|
| `Page.captureScreenshot`, `Page.startScreencast`, `Page.stopScreencast` | ok |
| `Page.getNavigationHistory`, `Page.reload` | ok |
| `Page.handleJavaScriptDialog` (sin diálogo abierto) | `No dialog is showing`: el método existe |
| `Page.setInterceptFileChooserDialog` | ok |
| `Page.setDownloadBehavior` | `Cannot not access browser-level commands` |
| `Input.dispatchMouseEvent`, `Input.dispatchTouchEvent`, `Input.dispatchKeyEvent`, `Input.insertText` | ok |
| `DOM.getDocument` | ok |
| `DOM.setFileInputFiles` | disponible: con un nodo real rellena el `<input type=file>` (prueba de archivos) |
| `Runtime.evaluate`, `Emulation.setDeviceMetricsOverride`, `Fetch.enable`, `Network.getCookies`, `Storage.getCookies` | ok |
| `Target.getTargets` | `Not allowed` |
| `Target.createTarget` | ok: la extensión puede abrir pestañas por CDP |
| `Browser.getVersion`, `Browser.setDownloadBehavior`, `SystemInfo.getInfo` | `'…' wasn't found` |

El dominio Browser no existe para la extensión. La versión y las descargas se resuelven con APIs
de extensión: `navigator.userAgent` solo da la versión principal (`Chrome/154.0.0.0`) y las
descargas usan `chrome.downloads`. La extensión sí alcanza `Runtime.evaluate` y las cookies de la
pestaña. Por eso el canal nativo acepta únicamente el protocolo acotado.

Acciones por la extensión (toque, texto, Intro, navegar, atrás, recargar; diálogo `confirm`
aceptado; selector de archivos interceptado y rellenado con un archivo del Servidor; descarga
completada en `~/Downloads` del `HOME` sintético y notificada al Puente): PASS en CfT, Chromium y
Chrome por `loadUnpacked`.

## Criterio 3: selección explícita, control compartido, DevTools y desconexión

| Prueba | CfT 154 | Chromium 152 | Chrome 154 (`loadUnpacked`) |
|---|---|---|---|
| Solo las pestañas compartidas aparecen y se controlan; las demás dan `tab not shared` | PASS | PASS | PASS |
| Una pestaña compartida en segundo plano se captura sin activarla | PASS (6/6 repeticiones) | **FAIL intermitente** (4 de 6 repeticiones) | PASS (6/6) |
| Control compartido: «relay », «local» y « relay» quedan intercalados en el mismo campo | PASS | PASS | PASS |
| DevTools ya abierto en la pestaña: el control sigue o la desconexión se notifica | PASS (sigue) | PASS (sigue) | PASS (sigue) |
| DevTools abierto sobre una pestaña adjunta: igual | PASS (sigue) | PASS (sigue) | PASS (sigue) |
| Navegar a `chrome://version` desconecta y se notifica | PASS | PASS | PASS |
| Cerrar la pestaña desconecta con `target_closed` y se notifica | PASS | PASS | PASS |
| Perder el adaptador suelta el depurador; navegador y pestaña creada por Relay siguen; la extensión reconecta y conserva la selección | PASS | PASS | PASS |

- **DevTools no corta `chrome.debugger` en 152 ni en 154.** Se probó en los dos órdenes: con
  `--auto-open-devtools-for-tabs`, y abriendo DevTools después con `Target.openDevTools`. En
  ambos casos la acción siguiente responde `ok` y no llega ningún `onDetach`. Las teclas F12 y
  Ctrl+Shift+I enviadas por `Input.dispatchKeyEvent` no abren DevTools
  (`04-devtools-con-teclas-sinteticas.txt`). Las desconexiones que sí ocurren llegan al Puente
  con su motivo: `target_closed` al cerrar la pestaña y al pasar a `chrome://version`.
- **Alto de la pestaña al adjuntar.** En Chromium y Chrome, la pestaña pasa de 713 a 657 px de
  alto (−56 px) tras el primer adjunto (`06-alto-de-pestana-al-adjuntar.txt`). [INFERENCIA] Es la
  barra «depurando este navegador»; en CfT ya mide 657 antes de adjuntar, que es lo esperable si
  ahí ocupa ese sitio la barra propia de Chrome for Testing. La barra avisa a la persona en la
  computadora. Producción no debe usar `--silent-debugger-extension-api`. Cancelarla daría el
  motivo `canceled_by_user`; no se pulsó, porque no hay pantalla real.
- **Pestañas en segundo plano, Chromium 152.** Con interfaz sobre `--ozone-platform=headless`, una
  pestaña que nunca estuvo al frente informa a veces `innerWidth=0` y `visibilityState=visible`. En
  ese caso el cuadro da `frame unavailable` hasta activarla (4 de 6 repeticiones,
  `05-segundo-plano-repeticiones.txt`). En una sonda, una segunda pestaña en segundo plano dejó
  `Page.captureScreenshot` sin respuesta 15 s (`03-pestanas-en-segundo-plano.txt`). En CfT y
  Chrome 154 la pestaña está `hidden` con su tamaño real y se captura siempre.

## Criterio 4: lo que no se soporta o no se promete

| Caso | Dedicado | Extensión | Tratamiento en Relay |
|---|---|---|---|
| Páginas internas (`chrome://`, `devtools://`, `chrome-extension://`, `view-source:`, `file:`, `data:`, `javascript:`) | CDP podría, el protocolo no navega fuera de http(s) | `Cannot access a chrome:// URL`; al llegar a una, desconexión `target_closed` | Señalar «página no controlable desde Relay» |
| Diálogos JavaScript `alert`/`confirm`/`prompt` | Soportado: evento `Page.javascriptDialogOpening` y acción `dialog` | Soportado igual | Controles de Relay |
| `<select>` nativo | No se comprobó que el desplegable aparezca en el cuadro: el cuadro cambia al tocar, pero también cambia el foco. Con el control enfocado, ↓ e Intro eligen la opción (PASS) | Igual (mismas teclas) | Teclas, o lista propia en una tarea posterior |
| Selector de archivos | Interceptado (`Page.fileChooserOpened`) y rellenado con rutas del Servidor (PASS) | Igual, PASS | Explorador del Servidor; los archivos del teléfono se suben primero |
| Descargas | `Browser.setDownloadBehavior` a una carpeta conocida y eventos de progreso (PASS) | Sin dominio Browser: van a la carpeta del perfil y se ven con `chrome.downloads` | Quedan en el Servidor y se ofrecen al teléfono |
| Diálogos del navegador: permisos, autenticación HTTP básica, impresión, selector de color o fecha, confirmación de cierre de pestaña | No probados; no forman parte de la página capturada | No probados | Señalar para resolver en la computadora |
| Audio y vídeo continuo | `Page.startScreencast` da cuadros con confirmación; no hay audio | Igual | No se promete |
| Escritorio completo, ventanas ajenas al navegador | Fuera de alcance | Fuera de alcance | No se ofrece |
| Chrome Web Store y páginas protegidas por política | No probado (sin red) | Chrome no deja depurarlas, según la documentación de `chrome.debugger` | Señalar |

## Criterio 5: protocolo acotado, límites y versiones certificables

El teléfono nunca envía métodos ni parámetros CDP. El Puente (modo dedicado) y la extensión
(modo habitual) validan con la misma función `validateAction` de `extension/actions.js` y la
traducen a CDP con `perform`. Cualquier otra forma falla con `invalid action`.

| Acción | Campos y límites | CDP que genera |
|---|---|---|
| `navigate` | `url` http/https, ≤ 2 048 caracteres | `Page.navigate` |
| `back`, `forward` | Una entrada; `{ moved: false }` en el extremo | `Page.getNavigationHistory` y `Page.navigateToHistoryEntry` |
| `reload` | — | `Page.reload` |
| `tap` | `x`, `y` en px CSS, finitos, 0–20 000 | `Input.dispatchMouseEvent` (mover, pulsar, soltar) |
| `scroll` | `x`, `y` y `dx`, `dy` en ±10 000 | `Input.dispatchMouseEvent` `mouseWheel` |
| `text` | 1–1 000 caracteres | `Input.insertText` |
| `key` | Lista cerrada: Enter, Backspace, Tab, Escape, Delete, Home, End, PageUp, PageDown y flechas | `Input.dispatchKeyEvent` |
| `frame` | `maxWidth` 64–1 600 (1 600 por defecto), `quality` 20–85 (60) | `Page.getLayoutMetrics` y `Page.captureScreenshot` JPEG del área visible, reducido |
| `dialog` | `accept` booleano; `text` opcional ≤ 1 000 | `Page.handleJavaScriptDialog` |
| `files` | `backendNodeId` del evento del selector; 1–10 rutas absolutas ≤ 4 096 sin NUL | `DOM.setFileInputFiles` |

Eventos hacia el teléfono: `dialog` (tipo y texto), `fileChooser`, `download` (completada),
`detached` (motivo), `shared` y `unshared`. Fuera del protocolo, por el canal nativo: `listTabs`
(solo compartidas), `openTab` (http/https; queda compartida y marcada `createdByRelay`) y
`release`.

Límites de tamaño y flujo:

- **Cuadro:** como máximo 700 000 bytes JPEG decodificados. Si se pasa, falla con `frame too
  large` y no se envía. Un visor de 0×0 justo después de adjuntar se reintenta 10 veces cada
  100 ms; después da `frame unavailable`, que el teléfono trata como reintentable.
- **Flujo:** un cuadro pedido por pestaña cada vez; el teléfono pide el siguiente al recibir el
  anterior. Con `Page.startScreencast` sin confirmar, el navegador envía 3 cuadros y se detiene.
  Con confirmación, 90 cuadros en 1,5 s (~60 por segundo, media 3,8 KB en la página animada). Si
  se usa, el ritmo se fija retrasando `screencastFrameAck`.
- **Native messaging:** peticiones del Puente ≤ 1 MiB, rechazadas en el adaptador. Respuestas
  ≤ 64 MiB (documentado); un cuadro ≤ 700 000 bytes cabe holgado.
- **Tiempos:** una captura puede quedarse sin respuesta (Chromium 152, segundo plano). El Puente
  necesita plazo por petición; el laboratorio usa 15 s.

Versiones certificables por esta evidencia, solo en Linux x86_64 y sin pantalla real:

| Navegador | Dedicado (CDP por puerto, perfil propio) | Habitual (extensión) |
|---|---|---|
| Chrome for Testing 154.0.8037.92 | Sí | Sí, con la extensión cargada sin empaquetar |
| Google Chrome 154.0.8037.57 | Sí | Comportamiento sí; instalación pendiente (ver alternativa C) |
| Chromium 152.0.7977.82 Arch | Sí | No: captura en segundo plano intermitente |

## Incompatibilidades y alternativas

**A. `--remote-debugging-pipe` ata la vida del navegador dedicado al Puente.** Cerrar la tubería
termina el navegador (FAIL en las tres). Contradice «conserva perfil/pestañas al desconectar» y
«se recupera lo que siga vivo». Alternativa probada: `--remote-debugging-port=0` con
`--user-data-dir` propio y reconexión por la URL `ws://` (PASS en las tres). Riesgo de esa
alternativa: el puerto de `127.0.0.1` lo alcanza cualquier proceso local de cualquier usuario y
da control total del perfil dedicado, sesiones incluidas. Propuesta para #92: un proceso
supervisor pequeño y estable, separado del Puente (por ejemplo una unidad systemd de usuario), que
lance el navegador con la tubería y la exponga al Puente por un socket Unix con permisos 0600.
Si el Puente se reinicia, la tubería sigue abierta. Esto no se probó aquí; #92 debe probarlo.
Mientras tanto, el puerto solo es aceptable en un Servidor de un solo usuario.

**B. Chrome for Testing y Chromium no protegen el perfil predeterminado.** Aceptan CDP sobre el
perfil habitual si se lanzan sin `--user-data-dir`. El Puente debe pasar siempre su propio
`--user-data-dir`, dentro de su directorio de estado, y rechazar cualquier otro. No basta con
confiar en el navegador.

**C. Google Chrome 154 ignora `--load-extension`** (FAIL en `12-chrome.txt`: no llega el
saludo del host en 15 s). Es la retirada de Chrome 137
([anuncio](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)).
`Extensions.loadUnpacked` sí funciona (`13-…`, 35/36 y el único FAIL es la tubería), pero exige
lanzar el navegador con tubería CDP y `--enable-unsafe-extension-debugging`, justo lo que el
habitual no debe tener. Alternativas reales de instalación en el Chrome habitual: publicar la
extensión en Chrome Web Store (puede ser no listada) o «Cargar descomprimida» con el modo de
desarrollador. Ninguna se probó. Es un paso operativo para #93/#96. También hay que escribir el
manifiesto del host en `~/.config/google-chrome/NativeMessagingHosts/` del perfil real; tampoco
se hizo.

**D. Chromium 152 no siempre captura pestañas en segundo plano** (con `--ozone-platform=headless`;
4 de 6). No se sabe si con pantalla real pasa lo mismo. Alternativas: exigir Chrome/Chromium
≥ 154, que pasó 6 de 6 en CfT y Chrome, o activar la pestaña antes de capturar. Activarla le
cambia la pestaña a la persona en la computadora, así que la segunda opción necesita aviso y no
se recomienda. Chromium 154 no se probó: Arch ofrece 152.

## Riesgos para las tareas siguientes

- La extensión puede ejecutar `Runtime.evaluate`, leer cookies y crear pestañas en el navegador
  habitual. El único límite es que el canal nativo acepte solo el protocolo acotado y que la
  extensión no tenga otra entrada (`externally_connectable`, mensajes de páginas).
- `prepare` activa `Page.setInterceptFileChooserDialog` al adjuntar. [INFERENCIA, no probado]
  Mientras Relay está adjunto, el selector de archivos de esa pestaña también queda interceptado
  para la persona en la computadora. Propuesta: activar la interceptación solo alrededor de un
  toque de Relay. Comprobar en #93.
- `chrome.downloads` no da la pestaña de origen. La extensión de laboratorio solo informa
  descargas cuyo `referrer` coincide con la URL de una pestaña compartida. Es una heurística: una
  descarga sin referrer no se informa.
- La selección de pestañas vive en memoria del service worker. Producción debe guardarla en
  `chrome.storage.session` y reintentar la conexión con `chrome.alarms`. Este laboratorio usa un
  temporizador de 500 ms.

## Límites de la evidencia

- Sin pantalla real. El habitual usó `--ozone-platform=headless`. No se vieron la barra de
  depuración, el botón de la barra de herramientas ni `canceled_by_user`. La pulsación física
  del usuario tampoco existe: la persona en la computadora es el oráculo CDP. Queda pendiente una
  comprobación manual con pantalla para #93.
- Con las cuatro configuraciones en paralelo, y con una revisión anterior de la suite, hubo
  fallos de carga que no aparecen en serie: cuadros de 0 px de ancho en Chromium y una conexión
  CDP cerrada en el screencast de CfT (`20-…`, `21-…`). Una ejecución completa de Chrome terminó
  `extension.test.ts` a los 1,45 s sin mensaje (`22-…`). No se encontró la causa; al repetirla
  dio el resultado esperado (`12-chrome.txt`).
- Google Chrome contactó con servicios de Google pese a `--disable-background-networking`
  (`registration_request … DEPRECATED_ENDPOINT` en la salida). El laboratorio no es hermético con
  la compilación con marca.
- Solo Linux x86_64. macOS y Windows quedan fuera de V3.
