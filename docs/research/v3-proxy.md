# V3: proxy HTTPS y aislamiento web con aplicaciones falsas

Validación del 2026-10-05 para [V3: validar proxy HTTPS y aislamiento web con aplicaciones falsas](https://github.com/AlejandroFloresArroyo/relay-app/issues/79), dentro de [Construir Relay V3](https://github.com/AlejandroFloresArroyo/relay-app/issues/74). Contrato: [`docs/relay-v3.md`](../relay-v3.md) §5. Antecedente documental: investigación de [#73](https://github.com/AlejandroFloresArroyo/relay-app/issues/73).

El laboratorio vive en [`labs/v3-proxy/`](../../labs/v3-proxy/), con manifiesto y versiones fijadas propios. No añade dependencias a `bridge/` ni a `mobile/` y el gate no lo ejecuta.

## Resultado por configuración

| Configuración | Resultado | Motivo |
|---|---|---|
| **Services HTTPS por aplicación → listener web del Puente por aplicación → aplicación** (simulado) | **PASS** | 19/19 pruebas HTTP y 25/25 comprobaciones en Chromium 152 y en Chrome 154. |
| Services HTTPS → servidor de desarrollo directo, sin Puente (simulado) | **FAIL** | Sirve la aplicación sin autorización, escapa al puerto original por redirección, deja pasar cookies `Domain` padre y nombres reservados, y acepta peticiones cruzadas B→A. 12 de 25 comprobaciones fallan. |
| Un nombre de máquina, un puerto HTTPS por aplicación → Puente (simulado) | **FAIL** | Las cookies no separan puertos: la cookie de Relay de B sustituye a la de A y la sesión propia de B pisa la de A. 5 de 25 fallan. |
| Tailscale Serve real, HTTP en el nombre de máquina, hacia una aplicación falsa | **PASS** como transporte · no es frontera | Conserva `Host`, transmite SSE sin búfer, WebSocket y subidas; corta hacia el navegador cuando cae el backend. No reescribe `Location` ni `Set-Cookie`. Sin HTTPS no hay cookies `__Host-`. |
| Tailscale Serve real HTTPS y Tailscale Services | **NO EJECUTABLE** | `Serve is not enabled on your tailnet`. Requiere aprobación en la consola: ver «Pendiente de validación administrativa». |
| WebView Android con `react-native-webview` 13.16.1 (visor de laboratorio) | **PASS** | 8/8 en emulador Android 16 con Android System WebView 133.0.6943.137: canje, navegación, recursos y CDN, SSE y WebSocket por `wss`, formulario, subida con el selector del sistema, descarga, ventanas nuevas y revocación con streams abiertos. |
| Navegador externo Android (Chrome 133.0.6943.137) | **FAIL** en descarga · resto PASS | 7/8. La descarga llega autorizada al Puente, pero la pila de descargas de Chrome no acepta el certificado sintético (`net_error -202`): la confianza de laboratorio solo existe en la sesión DevTools. Alternativa: repetir con el certificado real de Services; no instalar la CA de laboratorio en el sistema. |

## Versiones exactas

| Componente | Versión |
|---|---|
| Node | v26.10.0 |
| OpenSSL (certificados sintéticos) | 3.6.4 |
| playwright-core (solo laboratorio) | 1.63.0 |
| Chromium (Arch Linux) | 152.0.7977.82 |
| Google Chrome | 154.0.8037.57 |
| Tailscale | 1.102.3 |
| Expo / React Native / react-native-webview (visor de laboratorio) | 57.0.26 / 0.86.3 / 13.16.1 |
| Emulador Android | Android 16, `sdk_gphone64_x86_64`, imagen `system-images;android-36;google_apis_playstore;x86_64`, emulador 37.2.12.0 |
| Android System WebView / Chrome Android | 133.0.6943.137 / 133.0.6943.137 |

## Qué se montó

```text
Chromium (perfil desechable)            Relay nativo (simulado por la prueba)
  │ https://app-a.relay-lab.ts.net:P       │ llave del dispositivo (Bearer)
  ▼                                        ▼
Simulador de Serve/Services        API de control del Puente (HTTP loopback)
  TLS sintético, Host intacto,       listar solicitudes, conceder, revocar
  X-Forwarded-*, identidad tailnet
  │ http://127.0.0.1:<listener de app-a>
  ▼
Listener web del Puente para app-a  ── autoriza cada petición y upgrade
  │ http://127.0.0.1:<puerto de app-a>
  ▼
Aplicación falsa app-a (servidor de desarrollo simulado)
```

- `src/fakeApp.ts`: dos aplicaciones falsas, `app-a` y `app-b`, con rutas profundas, CSS/imagen/script, formulario, subida multipart, descarga, redirecciones (relativa, por `Host`, absoluta a `127.0.0.1`), inicio de sesión con `__Host-app_session` (el mismo nombre en las dos), SSE, WebSocket de desarrollo (HMR) que deriva su URL de `location`, y páginas hostiles: cookies `Domain` padre por `Set-Cookie` y por JavaScript, intento de escribir `__Host-RelayWeb`, peticiones cruzadas, y una página incompatible con URLs fijas a `127.0.0.1`.
- `src/serveSim.ts`: lo que hace Serve. Comprobado contra el código de Tailscale 1.102.3 (`ipn/ipnlocal/serve.go`, `addProxyForwardedHeaders` y `addTailscaleIdentityHeaders`) y contra Serve real (abajo): conserva `Host`, fija `X-Forwarded-Host` y `X-Forwarded-For`, añade `X-Forwarded-Proto: https` solo si la entrada fue TLS y añade `Tailscale-User-*` cuando el origen es un nodo de usuario.
- `src/webGate.ts`: el diseño propuesto para el Puente. Autoridad en memoria, un listener por aplicación y el API de control.
- `src/lab.ts`: las tres configuraciones. `src/scenario.ts`: el recorrido en navegador real. `src/matrix.ts`: lo ejecuta por configuración.
- Nombres: `app-a.relay-lab.ts.net` y `app-b.relay-lab.ts.net`, resueltos a loopback solo dentro del perfil de Chromium (`--host-resolver-rules`). Se eligió `ts.net` porque está en la Public Suffix List y el nombre de la tailnet no: reproduce que dos Services son hermanos bajo un padre registrable común.
- `viewer/`: visor Android de laboratorio, Expo 57.0.26 con `react-native-webview` 13.16.1. Abre un único destino (`relaylabweb://abrir?url=…`), sin puente nativo para la página. Las ventanas nuevas del mismo origen se cargan en el visor y las de otro origen salen con `Linking.openURL`. Confía en el certificado sintético solo mediante su `network_security_config` (generado al compilar, no versionado).
- `src/android.ts`: recorrido en el visor (DevTools de WebView) y en Chrome Android (DevTools de Chrome) contra el laboratorio. En Android los nombres son `*.relay-lab.localhost`, que Chromium resuelve a loopback por sí mismo, y `adb reverse` lleva los puertos al equipo. Chrome no confía en el certificado sintético (muestra `NET::ERR_CERT_AUTHORITY_INVALID` al abrir la web externa desde el visor); la prueba le pide ignorar errores de certificado solo durante su sesión DevTools y lo desactiva al terminar.
- Confianza global sin cambios: en el equipo, `~/.pki/nssdb/cert9.db` sigue con fecha 2026-08-14 y `trust list` no tiene entradas `relay-lab`; Chromium/Chrome usan un perfil temporal con `--ignore-certificate-errors-spki-list` para la clave del laboratorio. En Android no se instaló ninguna CA; el emulador (AVD `relay-v3-proxy-phone`, creado para esta prueba) se borró al terminar.

## Diseño probado del listener web

Por cada aplicación registrada, un listener HTTP en loopback al que apunta su Service. Ninguna ruta de control existe en él.

1. **Host y esquema.** Solo se sirve si `Host` es el nombre del Service y `X-Forwarded-Proto` es `https`. Si no, `421`. Es defensa contra un Service mal encaminado, no autenticación: cualquier proceso local que hable con el listener puede poner esas dos cabeceras (sonda de la revisión: `200`). Una petición cuyo destino no es una URL analizable (`//`, `/\`) recibe `400`, también en upgrades, y el listener sigue vivo.
2. **Sin sesión.** Una navegación (`Sec-Fetch-Mode: navigate`, o `Accept: text/html` sin Fetch Metadata) recibe la página de acceso del Puente: crea una solicitud pendiente con un secreto aleatorio de 32 bytes en `__Host-RelayPend` (`Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`, sin `Domain`) y muestra un código público de 8 caracteres. Se recarga sola cada 2 s, sin scripts, con `Cache-Control: no-store` y CSP `default-src 'none'`. Subrecursos y upgrades sin sesión reciben `401` y no crean solicitudes. Máximo 20 pendientes por aplicación; caducan a los 5 minutos.
3. **Concesión.** Relay lista las solicitudes de la aplicación por el API de control, con la llave del dispositivo, y concede la que tiene el código que la persona compara en pantalla. La hora empieza en la concesión, con el reloj del Servidor.
4. **Canje.** La siguiente recarga de ese navegador presenta el secreto pendiente; el Puente lo marca usado y emite un token nuevo de 32 bytes en `__Host-RelayWeb` (`Secure; HttpOnly; SameSite=Strict; Path=/`, `Max-Age` en segundos hasta el fin de la hora), borra la pendiente y redirige (`303`) a la ruta pedida; si la ruta no empieza por una sola `/` (`//host`, `/\host`) o es `/__relay/…`, a `/`. Secretos y tokens se guardan por su SHA-256.
5. **Con sesión.** Métodos con efectos y upgrades exigen `Origin` exactamente igual al propio. Las lecturas que no son navegación con `Sec-Fetch-Site` distinto de `same-origin` o `none` reciben `403`: entre Services hermanos `SameSite` no protege, porque son el mismo sitio.
6. **Hacia la aplicación.** Se quitan las cookies cuyo nombre empieza por `__Host-Relay` (sin distinguir mayúsculas) y las cabeceras `Tailscale-*`, en peticiones y en upgrades. `Host` se conserva y `X-Forwarded-Proto`/`X-Forwarded-Host` se fijan. `/__relay/…` nunca llega a la aplicación: solo existe `/__relay/acceso`; el resto es `404` del Puente.
7. **Desde la aplicación.** Cada `Set-Cookie` se parte por `;` como hace el navegador: se descarta si no tiene nombre (`=valor`, o sin `=`) o si el nombre recortado empieza por `__Host-Relay`, y se quita todo atributo cuyo nombre recortado sea `domain` en cualquier grafía (`Domain=`, `Domain =`, `Domain<TAB>=`, `DOMAIN = .padre`). `Location` se resuelve contra el origen público, como lo resolverá el navegador: si apunta al puerto loopback de la aplicación (absoluto, relativo a protocolo `//127.0.0.1:<puerto>/…`, o `http:/127.0.0.1:<puerto>/…`) se reescribe al origen público; si no es analizable se quita la cabecera (el estado se conserva) en vez de dejar caer el proceso. HTML, JavaScript, CSP y CORS no se tocan.
8. **Corte.** Cada respuesta en curso y cada WebSocket queda asociada a su sesión. Revocar desde Relay, revocar el dispositivo que concedió o vencer la hora (barrido cada segundo) destruye ambos extremos. Revocar una aplicación también **cancela las concesiones que el navegador aún no ha canjeado**, y el API de control responde `{ "revoked": <sesiones cortadas>, "cancelled": <concesiones canceladas> }`; una concesión de un dispositivo revocado tampoco se canjea. El registro guarda método, ruta sin consulta y estado.

## Evidencia

### Primero la prueba que falla

`test/gate.test.ts` se escribió antes del listener, contra un paso directo (lo que da apuntar Serve a la aplicación):

```text
$ node --test --test-reporter=spec test/gate.test.ts
  ✖ an unauthorized navigation gets the access page and nothing reaches the app
  ✖ unauthorized subresources and upgrades get 401 and create no pending request
  ✖ redemption is single use, fresh, bound to the browser holding the pending secret
  ✖ a grant from a device that does not hold the key is refused and the page keeps waiting
  ✖ the web session never reaches the control API nor is forwarded to the app
  ✖ a session is scoped to its app and to its Service name
  ✖ upstream cookies cannot use reserved names nor the parent Domain
  ✖ absolute redirects to the loopback upstream are rewritten to the public origin
  ✖ state-changing requests and upgrades need the exact own Origin
  ✖ the hour counts from the grant on the Server clock and is not renewed by use
  ✖ expiry cuts open SSE and WebSocket streams
  ✖ revoking from Relay cuts streams and refuses the session
  ✖ revoking the granting device revokes its web sessions and its key
  ✖ pending requests expire after five minutes and are capped per app
  ✖ a restarted Puente forgets in-memory authorizations
  ✖ the listener log has method, path and status only
  ✔ FAIL by design: the app is served without any authorization and leaks loopback redirects
ℹ tests 17
ℹ pass 1
ℹ fail 16
```

### Después, la que pasa

Tras las correcciones de la revisión (ver abajo):

```text
$ cd labs/v3-proxy && npm test
✔ servicios-puente: every check passes in a real browser
✔ serve-directo: the same checks catch the missing Puente
  ✔ an unauthorized navigation gets the access page and nothing reaches the app
  ✔ unauthorized subresources and upgrades get 401 and create no pending request
  ✔ redemption is single use, fresh, bound to the browser holding the pending secret
  ✔ a grant from a device that does not hold the key is refused and the page keeps waiting
  ✔ the web session never reaches the control API nor is forwarded to the app
  ✔ a session is scoped to its app and to its Service name
  ✔ upstream cookies cannot use reserved names, a blank name nor any Domain
  ✔ absolute redirects to the loopback upstream are rewritten to the public origin
  ✔ a malformed Location or request target is answered and the listener stays up
  ✔ the return path after redemption never leaves the app
  ✔ state-changing requests and upgrades need the exact own Origin
  ✔ the hour counts from the grant on the Server clock and is not renewed by use
  ✔ expiry cuts open SSE and WebSocket streams
  ✔ revoking from Relay cuts streams, refuses the session and cancels grants not yet redeemed
  ✔ revoking the granting device revokes its web sessions and its key
  ✔ pending requests expire after five minutes and are capped per app
  ✔ a restarted Puente forgets in-memory authorizations
  ✔ the listener log has method, path and status only
✔ Puente web listener behind Services (servicios-puente)
  ✔ FAIL by design: the app is served without any authorization and leaks loopback redirects
✔ Serve directly to the dev server (serve-directo)
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

### Correcciones tras la revisión independiente

La revisión de la rama encontró tres fallos en el listener. Cada uno tiene ahora una prueba que se escribió antes de la corrección y se vio fallar contra el código anterior:

```text
$ node --test --test-reporter=spec --test-timeout=30000 test/gate.test.ts   # código anterior, pruebas nuevas
  ✖ upstream cookies cannot use reserved names, a blank name nor any Domain
    actual: [ 'padre_http', 'padre_espacio', 'padre_tab', 'padre_mayus', '' ]   (y las tres grafías conservaban Domain)
  ✖ absolute redirects to the loopback upstream are rewritten to the public origin
    actual: '//127.0.0.1:37183/deep/redirigida?via=protocolo'
  ✖ a malformed Location or request target is answered and the listener stays up (30001ms)
  ✖ revoking from Relay cuts streams, refuses the session and cancels grants not yet redeemed
    actual: { revoked: 1 }   expected: { revoked: 1, cancelled: 1 }
ℹ Error: … generated asynchronous activity after the test ended. This activity created the error "TypeError: Invalid URL" … triggered an uncaughtException event.
ℹ tests 19  pass 15  fail 3  cancelled 1
```

1. **Una URL inválida tumbaba el proceso** (R1). `Location: http://` desde la aplicación, o un destino de petición `//` o `/\` desde el cliente, lanzaban `TypeError: Invalid URL` fuera de todo manejador: el proceso del listener caía, y dentro del Puente caería con él el API de control. Ahora todo se analiza con `URL.parse`, que devuelve `null`: `Location` inanalizable se quita y el destino inanalizable recibe `400` (peticiones y upgrades). De paso, `Location` se resuelve contra el origen público como hará el navegador, así que las formas relativa a protocolo (`//127.0.0.1:<puerto>/…`) y `http:/127.0.0.1:<puerto>/…`, que antes escapaban al loopback del teléfono, también se reescriben.
2. **Revocar no cancelaba una concesión aún no canjeada** (R2). Conceder un código y revocar la aplicación dejaba canjear al navegador que tenía el secreto durante los 5 minutos de la pendiente. Ahora `revokeApp` marca usadas las concesiones vivas de la aplicación y el API de control devuelve `{ revoked, cancelled }`. La guarda que impide canjear una concesión de un dispositivo revocado ya existía, pero ninguna prueba la cubría; ahora sí.
3. **`Domain` con espacios sobrevivía** (R3). El filtro `;\s*domain=` no veía `Domain =x`, `Domain<TAB>=x` ni `DOMAIN = .x`, y los navegadores los aplican como `Domain` (la revisión lo observó en Chromium 152 y Chrome 154; aquí, en Chromium 152 sin Puente: `A recibe padre_http=de-app-b, padre_espacio=de-app-b, padre_tab=de-app-b, padre_mayus=de-app-b`). Ahora `Set-Cookie` se parte por `;`, se recortan los nombres y se quita todo atributo `domain`; las cookies sin nombre se descartan. En Chromium 152, con el filtro anterior y la comprobación `padre-http` ampliada a las cuatro grafías, servicios-puente da `FAIL padre-http: A recibe padre_espacio=de-app-b, padre_tab=de-app-b, padre_mayus=de-app-b`; con el filtro nuevo, PASS en Chromium 152 y Chrome 154.

### Matriz en navegador real

`npm run matrix` (Chromium 152.0.7977.82); `CHROMIUM=/usr/bin/google-chrome-stable npm run matrix servicios-puente` dio las mismas 25 PASS con Chrome 154.0.8037.57. Repetido tras las correcciones de la revisión con el mismo resultado en las tres configuraciones.

| Comprobación | servicios-puente | serve-directo | puertos-mismo-host |
|---|---|---|---|
| `acceso` Sin autorización se muestra la página de acceso y nada llega a la aplicación | PASS | FAIL | PASS |
| `canje` Relay concede el código; el navegador canjea una vez y vuelve a la ruta profunda | PASS | FAIL | PASS |
| `recursos` Página, CSS, imagen y script propios por rutas relativas | PASS | PASS | PASS |
| `externos` Recurso externo permitido por la CSP de la aplicación (CSP intacta) | PASS | PASS | PASS |
| `sse` SSE: eventos en vivo a través de Serve y el Puente | PASS | PASS | PASS |
| `hmr` WebSocket de desarrollo (HMR) en ambos sentidos por wss del mismo origen | PASS | PASS | PASS |
| `formulario` Formulario POST urlencoded con texto no ASCII | PASS | PASS | PASS |
| `subida` Subida multipart de 3 MiB íntegra | PASS | PASS | PASS |
| `descarga` Descarga con Content-Disposition | PASS | PASS | PASS |
| `redirecciones` Redirecciones relativa, por Host y absoluta a loopback terminan en el origen público | PASS | FAIL | PASS |
| `login` Inicio de sesión propio de la aplicación con cookie __Host- | PASS | PASS | PASS |
| `ventanas` Ventanas nuevas: mismo destino autorizado y web externa | PASS | PASS | PASS |
| `sin-escape` Ninguna petición sale hacia el puerto original ni fuera de los orígenes del laboratorio | PASS | FAIL | PASS |
| `segunda-app` Segunda aplicación autorizada aparte en el mismo navegador | PASS | FAIL | PASS |
| `mismo-nombre` Dos aplicaciones con la misma cookie __Host-app_session no se pisan | PASS | PASS | FAIL |
| `padre-http` Set-Cookie con Domain padre desde B, en cualquier grafía (`Domain =`, tabulador, mayúsculas), queda limitada a B | PASS | FAIL | FAIL |
| `padre-js` LÍMITE documentado: cookie Domain padre creada por JavaScript de B llega a A | PASS | PASS | FAIL |
| `reservadas` B no puede crear ni sustituir __Host-RelayWeb (Set-Cookie, JS con Domain padre, JS host-only) | PASS | FAIL | PASS |
| `cruzadas` Peticiones cruzadas B→A (fetch con credenciales, POST, WebSocket) no llegan a A | PASS | FAIL | PASS |
| `control` El contenido web no alcanza el API de control del Puente | PASS | FAIL | PASS |
| `otro-navegador` El canje está ligado al navegador que pidió: otro perfil con el código público no entra | PASS | FAIL | PASS |
| `revocar` Revocar desde Relay corta SSE y WebSocket abiertos y vuelve a pedir acceso | PASS | FAIL | FAIL |
| `caducidad` Al cumplirse la hora (reloj del Servidor) se cortan los streams de B sin renovación | PASS | FAIL | PASS |
| `reinicio` Reiniciar el Puente exige autorizar de nuevo y conserva la sesión propia de la aplicación | PASS | PASS | FAIL |
| `incompatible` Aplicación con URLs fijas a 127.0.0.1: el escape se detecta y bloquea (no se reescribe HTML/JS) | PASS | PASS | PASS |

`padre-js` es un **límite**: PASS significa que el comportamiento observado coincide con el límite documentado (la cookie llega a la hermana). `incompatible` es la detección de una aplicación que no cumple el contrato: PASS significa que el escape se ve y se bloquea, no que la aplicación funcione. `control` en el navegador queda bloqueado antes de llegar (contenido mixto HTTPS→HTTP); la garantía real es que el API de control rechaza la cookie web y exige la llave, probado por HTTP en `test/gate.test.ts`.

Salida detallada de la configuración objetivo:

```text
PASS  acceso          Sin autorización se muestra la página de acceso y nada llega a la aplicación
      código=YWGH-23NS peticiones a la app=0
PASS  canje           Relay concede el código; el navegador canjea una vez y vuelve a la ruta profunda
      código YWGH-23NS concedido y canjeado; ruta=/deep/a/b/c?x=1; cookie dominio=app-a.relay-lab.ts.net httpOnly=true sameSite=Strict
PASS  recursos        Página, CSS, imagen y script propios por rutas relativas
      color=rgb(1, 2, 3) imagen=10px js=ok
PASS  externos        Recurso externo permitido por la CSP de la aplicación (CSP intacta)
      script externo=ok; CSP recibida=sí
PASS  sse             SSE: eventos en vivo a través de Serve y el Puente
      eventos=3
PASS  hmr             WebSocket de desarrollo (HMR) en ambos sentidos por wss del mismo origen
      respuesta=hmr:ack:ping
PASS  formulario      Formulario POST urlencoded con texto no ASCII
      nota=hola ñandú
PASS  subida          Subida multipart de 3 MiB íntegra
      archivo=datos.bin tamaño=3145728 sha256 coincide=true
PASS  descarga        Descarga con Content-Disposition
      archivo=informe-app-a.txt contenido="informe de app-a\n"
PASS  redirecciones   Redirecciones relativa, por Host y absoluta a loopback terminan en el origen público
      https://app-a.relay-lab.ts.net:36633/deep/redirigida?via=relativa | https://app-a.relay-lab.ts.net:36633/deep/redirigida?via=host | https://app-a.relay-lab.ts.net:36633/deep/redirigida?via=upstream
PASS  login           Inicio de sesión propio de la aplicación con cookie __Host-
      cuenta=dentro de app-a
PASS  ventanas        Ventanas nuevas: mismo destino autorizado y web externa
      A:ok | A:ok | https://cdn.relay-lab.test:43029/pagina:ok
PASS  sin-escape      Ninguna petición sale hacia el puerto original ni fuera de los orígenes del laboratorio
      ninguna
PASS  segunda-app     Segunda aplicación autorizada aparte en el mismo navegador
      código ENGF-RV7V concedido y canjeado
PASS  mismo-nombre    Dos aplicaciones con la misma cookie __Host-app_session no se pisan
      A ve app-a… B ve app-b…
PASS  padre-http      Set-Cookie con Domain padre desde B queda limitada a B (el Puente quita Domain)
      A recibe padre_http=(no)
PASS  padre-js        LÍMITE documentado: cookie Domain padre creada por JavaScript de B llega a A
      A recibe padre_js=de-app-b
PASS  reservadas      B no puede crear ni sustituir __Host-RelayWeb (Set-Cookie, JS con Domain padre, JS host-only)
      cookies Relay=__Host-RelayWeb@app-a.relay-lab.ts.net,__Host-RelayWeb@app-b.relay-lab.ts.net falsas=0 sesión A=200
PASS  cruzadas        Peticiones cruzadas B→A (fetch con credenciales, POST, WebSocket) no llegan a A
      página B: {"fetch":"bloqueado","post":"enviado","ws":"bloqueado"}; peticiones de B que llegaron a A=0
PASS  control         El contenido web no alcanza el API de control del Puente
      fetch desde A al control=bloqueado
PASS  otro-navegador  El canje está ligado al navegador que pidió: otro perfil con el código público no entra
      concedido VCG2-AM4H; el otro perfil con ese código obtuvo sesión=false
PASS  revocar         Revocar desde Relay corta SSE y WebSocket abiertos y vuelve a pedir acceso
      streams cortados; recarga muestra acceso
PASS  caducidad       Al cumplirse la hora (reloj del Servidor) se cortan los streams de B sin renovación
      streams cortados al vencer; recarga muestra acceso
PASS  reinicio        Reiniciar el Puente exige autorizar de nuevo y conserva la sesión propia de la aplicación
      tras reautorizar: dentro de app-a
PASS  incompatible    Aplicación con URLs fijas a 127.0.0.1: el escape se detecta y bloquea (no se reescribe HTML/JS)
      intentos bloqueados: http://127.0.0.1:38631/static/logo.svg, ws://127.0.0.1:38631/hmr
```

Fallos que explican las otras dos configuraciones:

```text
## serve-directo (/usr/bin/chromium, 152.0.7977.82)
FAIL  acceso          código=null peticiones a la app=1
FAIL  canje           sin página de acceso; sin cookie de sesión
FAIL  redirecciones   https://app-a.relay-lab.ts.net:46263/deep/redirigida?via=relativa | https://app-a.relay-lab.ts.net:46263/deep/redirigida?via=host | http://127.0.0.1:39535/deep/redirigida?via=upstream
FAIL  sin-escape      escapes: http://127.0.0.1:39535/deep/redirigida?via=upstream
FAIL  segunda-app     sin página de acceso
FAIL  padre-http      A recibe padre_http=de-app-b
FAIL  reservadas      cookies Relay=__Host-RelayWeb@app-b.relay-lab.ts.net,__Host-RelayPend@app-b.relay-lab.ts.net falsas=2 sesión A=200
FAIL  cruzadas        página B: {"fetch":"bloqueado","post":"enviado","ws":"abierto:hmr:hello:app-a"}; peticiones de B que llegaron a A=GET /whoami,POST /formulario,UPGRADE /hmr
FAIL  control         sin Puente: no existe autorización ni API de control
FAIL  otro-navegador  sin página de acceso
FAIL  revocar         sin Puente: no existe autorización ni API de control
FAIL  caducidad       sin Puente: no existe autorización ni API de control
## puertos-mismo-host (/usr/bin/chromium, 152.0.7977.82)
FAIL  mismo-nombre    https://servidor.relay-lab.ts.net:39751 vuelve a pedir acceso: su cookie de Relay fue sustituida
FAIL  padre-http      https://servidor.relay-lab.ts.net:39751 vuelve a pedir acceso: su cookie de Relay fue sustituida
FAIL  padre-js        https://servidor.relay-lab.ts.net:39751 vuelve a pedir acceso: su cookie de Relay fue sustituida
FAIL  revocar         page.waitForFunction: Timeout 5000ms exceeded.
FAIL  reinicio        tras reautorizar: fuera
```

En `puertos-mismo-host` la autorización de B sustituye la cookie `__Host-RelayWeb` de A (mismo host, otro puerto) y el inicio de sesión de B sustituye `__Host-app_session` de A: `reinicio` lo muestra al volver a A ya autorizada y encontrarse «fuera».

### Guardas de «Fails silently»: mutación temporal

Cada guarda del listener se rompió a propósito; la prueba correspondiente se volvió roja; se restauró el código y la suite volvió a pasar entera (17/17 en la primera entrega, 19/19 tras las correcciones de la revisión).

| Mutación | Prueba en rojo |
|---|---|
| El canje no marca la pendiente como usada | redemption is single use, fresh, bound to the browser holding the pending secret |
| La sesión no caduca | the hour counts from the grant on the Server clock and is not renewed by use |
| `Max-Age` en milisegundos en vez de segundos | redemption is single use, fresh, bound to the browser holding the pending secret |
| La cookie de Relay se reenvía a la aplicación | the web session never reaches the control API nor is forwarded to the app |
| La aplicación puede escribir `__Host-RelayWeb`/`__Host-RelayPend` | upstream cookies cannot use reserved names, a blank name nor any Domain |
| Se conserva `Domain` padre de la aplicación | upstream cookies cannot use reserved names, a blank name nor any Domain |
| No se exige `Origin` en métodos con efectos y upgrades | state-changing requests and upgrades need the exact own Origin |
| Revocar o vencer no corta streams | expiry cuts open SSE and WebSocket streams; revoking from Relay cuts streams and refuses the session; revoking the granting device revokes its web sessions and its key (y dos más por tiempo agotado) |
| La llave de un dispositivo revocado sigue valiendo | revoking the granting device revokes its web sessions and its key |
| El registro guarda la consulta | the listener log has method, path and status only |
| El canje acepta cualquier pendiente concedida, sin su secreto | redemption is single use, fresh, bound to the browser holding the pending secret |
| Las pendientes no caducan | pending requests expire after five minutes and are capped per app |
| No se comprueba `Host`/esquema del Service | a session is scoped to its app and to its Service name |
| No se reescribe `Location` a loopback | absolute redirects to the loopback upstream are rewritten to the public origin |
| Se aceptan lecturas `same-site` | state-changing requests and upgrades need the exact own Origin |

Tras la revisión independiente se añadieron estas, todas rojas con `node --test test/gate.test.ts` (19 pruebas) y verdes al restaurar. Sobre el código nuevo se repitieron además las de nombres reservados, `Domain` y reescritura de `Location` de la tabla anterior: rojas.

| Mutación | Prueba en rojo |
|---|---|
| `Location` con `new URL` (lanza) | a malformed Location or request target… (`uncaughtException: Invalid URL`) |
| `Location` inanalizable se deja pasar | a malformed Location or request target… |
| Destino de petición con `new URL` (lanza) | a malformed Location or request target… (`uncaughtException: Invalid URL`) |
| Destino de upgrade con `new URL` (lanza) | a malformed Location or request target…, y el proceso de prueba queda colgado (matado a los 60 s) |
| Revocar la aplicación no cancela concesiones sin canjear | revoking from Relay cuts streams, refuses the session and cancels grants not yet redeemed |
| Revocar la aplicación no cuenta las canceladas | revoking from Relay cuts streams, refuses the session and cancels grants not yet redeemed |
| Se canjea una concesión de un dispositivo revocado | revoking the granting device revokes its web sessions and its key |
| Solo se quita `Domain=` canónico (filtro anterior) | upstream cookies cannot use reserved names, a blank name nor any Domain |
| Nombre de atributo sin recortar | upstream cookies cannot use reserved names, a blank name nor any Domain |
| Se aceptan cookies sin nombre | upstream cookies cannot use reserved names, a blank name nor any Domain |
| Solo se reescribe `Location` absoluto `http(s)://` | absolute redirects to the loopback upstream are rewritten to the public origin |
| Upgrade sin comprobar `Host`/esquema | a session is scoped to its app and to its Service name |
| `next` acepta `//host` (redirección abierta) | the return path after redemption never leaves the app |
| Nombres reservados sensibles a mayúsculas | the web session never reaches the control API nor is forwarded to the app |
| `/__relay/…` distinto de acceso llega a la aplicación | a session is scoped to its app and to its Service name |
| Cookie de Relay hacia la aplicación en upgrades | the web session never reaches the control API nor is forwarded to the app |
| Cabeceras `Tailscale-*` hacia la aplicación en upgrades | the web session never reaches the control API nor is forwarded to the app |

La mutación de `Host` quedó **verde** en la primera versión de la prueba: la petición con otro `Host` entraba por el simulador de Serve, que la encaminaba al listener de B. Se reforzó la prueba para hablar con el listener de A directamente; con la guarda rota falla (`200 !== 421`) y restaurada pasa. Las navegaciones del recorrido en navegador se validan además en sentido inverso: la configuración sin Puente debe fallar `acceso`, `sin-escape`, `padre-http`, `reservadas` y `cruzadas` (`test/browser.test.ts`).

### Tailscale Serve real

Con el candado `tailscale`, `node src/realServe.ts` añadió `--http=18080` hacia una aplicación falsa en el nombre de máquina, ejecutó las comprobaciones y lo retiró. La configuración de Serve se comparó antes y después (`tailscale serve status --json`): idéntica; las entradas de producción (80 y 9119) no se tocaron.

```text
tailscale: 1.102.3
serve --http: añadido
GET /whoami: 200
Host recibido: arch.<tailnet>.ts.net:18080
  x-forwarded-host: arch.<tailnet>.ts.net:18080
  x-forwarded-proto: (ausente)
  x-forwarded-for: <IP tailnet del cliente>
  origin: http://arch.<tailnet>.ts.net:18080
  cookie: tema=claro
  cabeceras tailscale-*: ["tailscale-headers-info=presente","tailscale-user-login=presente","tailscale-user-name=presente","tailscale-user-profile-pic=presente"]
SSE primer evento (ms): 135
SSE eventos en ~1 s (servidor emite cada 100 ms): 12
SSE tras cortar el backend: error terminated (7 ms)
WebSocket estado: 101
WebSocket marcos: ["hmr:hello:app-real","hmr:ack:ping"]
WebSocket tras cortar el backend: cerrado en 2 ms
Subida 3 MiB sha256 coincide: true
Location de redirect absoluto a loopback: http://127.0.0.1:<puerto-app>/deep/redirigida?via=upstream
Set-Cookie reenviadas sin cambios: ["padre_http=de-app-real; Domain=<tailnet>.ts.net","__Host-RelayWeb=falsa-app-real; Path=/","__Host-RelayPend=falsa-app-real; Path=/"]
serve --https: Serve is not enabled on your tailnet. / To enable, visit: /  /          https://login.tailscale.com/f/serve?node=<id del nodo>
serve --service=svc:relay-lab-a: Serve is not enabled on your tailnet. / To enable, visit: /  /          https://login.tailscale.com/f/serve?node=<id del nodo>
configuración de Serve restaurada idéntica: true
```

### Android: visor WebView y Chrome

Con el candado `android`, en un emulador propio (`relay-v3-proxy-phone`), `node src/android.ts emulator-5570 all`:

```text
dispositivo emulator-5570: sdk_gphone64_x86_64 Android 16
WebView: com.google.android.webview, 133.0.6943.137
visor conectado por DevTools
PASS  webview canje        Página de acceso, concesión desde Relay y canje en este navegador
      código 438B-3JDC; ruta=/deep/a/b/c?x=1
PASS  webview recursos     Navegación, CSS, imagen, script propio y script externo permitido
      color=rgb(1, 2, 3) imagen=10px externo=ok
PASS  webview streams      SSE y WebSocket de desarrollo por wss
      sse=3 hmr=hmr:ack:ping
PASS  webview formulario   Formulario POST urlencoded
      nota=hola ñandú
PASS  webview subida       Subida multipart con el selector de archivos del sistema
      selector: com.android.intentresolver → com.google.android.documentsui → dev.relay.lab.webproxy; archivo=datos-lab.bin tamaño recibido=1048576
PASS  webview descarga     Descarga desde la página
      Puente: GET /descarga 200, GET /descarga 200; archivo en Download: informe-app-a.txt; handshakes ERR_CERT_AUTHORITY_INVALID: 0
PASS  webview ventanas     Ventanas nuevas: mismo origen se queda en el visor; web externa sale al navegador
      #blank→A/deep/nueva | #abrir→A/deep/popup | #externa→com.android.chrome
PASS  webview revocar      Revocar corta SSE y WebSocket abiertos
      streams cortados; recarga muestra acceso
Chrome: 133.0.6943.137
PASS  chrome canje        Página de acceso, concesión desde Relay y canje en este navegador
      código FZPR-H7X2; ruta=/deep/a/b/c?x=1
PASS  chrome recursos     Navegación, CSS, imagen, script propio y script externo permitido
      color=rgb(1, 2, 3) imagen=10px externo=ok
PASS  chrome streams      SSE y WebSocket de desarrollo por wss
      sse=7 hmr=hmr:ack:ping
PASS  chrome formulario   Formulario POST urlencoded
      nota=hola ñandú
PASS  chrome subida       Subida multipart con el selector de archivos del sistema
      selector: com.google.android.documentsui → com.android.chrome; archivo=datos-lab.bin tamaño recibido=1048576
FAIL  chrome descarga     Descarga desde la página
      Puente: GET /descarga 200; archivo en Download: no; handshakes ERR_CERT_AUTHORITY_INVALID: 2
PASS  chrome ventanas     Ventanas nuevas: pestañas del mismo origen autorizadas; web externa en otra pestaña
      #blank→A/deep/nueva:ok | #abrir→A/deep/popup:ok | #externa→CDN/pagina:ok
PASS  chrome revocar      Revocar corta SSE y WebSocket abiertos
      streams cortados; recarga muestra acceso

15/16 PASS
```

Observaciones de Android:

- **Descarga en WebView.** `react-native-webview` entrega la descarga a `DownloadManager` y le copia las cookies del host con `CookieManager.getCookie` (código de 13.16.1, `RNCWebViewManagerImpl.kt`), incluida la `HttpOnly` de Relay: por eso el Puente ve dos `GET /descarga` (WebView y servicio de descargas) y el segundo va autorizado. El servicio de descargas aceptó el certificado del laboratorio sin error TLS; atribuirlo a que aplica la configuración de red del paquete que pide la descarga es una inferencia no comprobada.
- **Descarga en Chrome.** La respuesta llegó (`GET /descarga 200`), pero la descarga quedó «failed» con 0 KB y el registro de Chrome muestra `ssl_client_socket_impl … net_error -202` (`ERR_CERT_AUTHORITY_INVALID`): la pila de descargas no hereda la excepción de certificados de DevTools. Es un límite del laboratorio, no del diseño; requiere el certificado real.
- **Ventanas nuevas en WebView.** Sin `onOpenWindow`, `react-native-webview` 13.16.1 crea un WebView nuevo que nunca se adjunta (código de `RNCWebChromeClient.onCreateWindow`); el visor necesita `setSupportMultipleWindows` y `onOpenWindow`. Con ellos, `target=_blank` y `window.open` del mismo origen quedan en el visor y la web externa abre Chrome.
- **Selector de archivos.** En WebView aparece el selector de Android (Cámara, Videocámara y «Photos & videos», que es DocumentsUI); un archivo fuera de la galería se elige en Descargas. Chrome pide antes permiso de cámara porque el `input` no tiene `accept`; denegarlo no impide elegir el archivo.
- **Expo DOM.** No se usó: sirve para componentes DOM propios empaquetados con la app. Una web arbitraria del Servidor necesita `react-native-webview` con `source.uri`, que es lo que se validó.
- **Teléfono físico.** No había teléfono conectado (`adb devices` sin dispositivos físicos); no se probó.
- **Arnés, tras la revisión.** `src/android.ts` salía con código 0 y `0/0 PASS` aunque una excepción cortara la ejecución; ahora imprime el error y sale con 1 si hay excepción o alguna comprobación falla (con la descarga de Chrome documentada arriba, la ejecución completa sale con 1). Espera 15 s, no 3, a que Chrome en frío abra DevTools. La aplicación falsa ya no cae cuando una subida se corta a mitad (`ECONNRESET` en `readBody`, comprobado con una sonda local). El recorrido Android no se repitió tras estos cambios.

## Contrato de compatibilidad de aplicación

Una aplicación funciona dentro y fuera de Relay si cumple esto. Lo que no lo cumple se adapta o se usa con el control del navegador del Servidor.

1. **URLs relativas o derivadas de `location`.** Recursos, formularios, `fetch`, SSE y WebSocket (`wss://` + `location.host`). El Puente solo corrige `Location` que, resuelto como lo hará el navegador (absoluto, relativo a protocolo o `http:/…`), apunte a su propio puerto loopback; no reescribe HTML ni JavaScript. Una URL fija a `127.0.0.1:<puerto>` o `localhost:<puerto>` no funciona en el teléfono y allí apunta al propio teléfono. Para un servidor de desarrollo: base pública relativa, y el cliente HMR sin host ni puerto fijos (por ejemplo, en Vite, `server.hmr.clientPort: 443`; no probado con Vite real en este laboratorio).
2. **Aceptar el `Host` público.** El Puente reenvía el nombre del Service tal cual, con `X-Forwarded-Proto: https` y `X-Forwarded-Host`. Los servidores que filtran `Host` deben permitirlo (en Vite, `server.allowedHosts`). Si la aplicación construye URLs absolutas, debe usar esas cabeceras.
3. **Servida en `/`.** Un Service por aplicación; sin prefijos de ruta.
4. **Cookies sensibles `__Host-`**, sin `Domain`. El Puente quita `Domain` en `Set-Cookie` en cualquier grafía y descarta cookies sin nombre, pero no ve `document.cookie`: una cookie con `Domain` del padre creada por JavaScript llega a las aplicaciones hermanas (comprobado: `padre_js` de B llega a A). No compartir cookies entre aplicaciones ni depender de ellas.
5. **Nombres reservados.** `__Host-RelayWeb`, `__Host-RelayPend` y cualquier cookie que empiece por `__Host-Relay`; el prefijo de ruta `/__relay/`. No se reenvían.
6. **Sin peticiones entre aplicaciones.** El Puente rechaza `fetch`, `POST` y WebSocket con `Origin` de otra aplicación, aunque CORS lo permita. No se retiran CSP ni CORS de la aplicación.
7. **Formularios y WebSocket con `Origin`.** Los navegadores lo envían; un cliente que no lo envíe en métodos con efectos recibe `403`.
8. **Ventanas nuevas.** Las del mismo origen se quedan en el destino autorizado. Las demás son navegación externa y no autorizan otro servicio local.
9. **Recursos externos normales** (CDN, fuentes) se cargan desde el navegador según la CSP de la aplicación.
10. **Estado ya descargado.** Revocar no borra caché, descargas ni service workers del navegador; no reutilizar un nombre de Service para otra aplicación sin tratarlo.

## Adaptador de publicación Services

Lo que el Puente necesitará para publicar una aplicación (tarea #89/#96), con lo que el laboratorio fijó:

- **Un Service por aplicación**, `svc:<app>`, HTTPS 443, destino `http://127.0.0.1:<listener del Puente para esa app>`. Nunca el puerto de la aplicación.
- **Origen público** `https://<app>.<tailnet>.ts.net`. El listener solo sirve `Host` igual a ese nombre y `X-Forwarded-Proto: https`; Serve añade esa cabecera solo con TLS (código y prueba real HTTP), así que una publicación HTTP no se sirve.
- **`Origin` esperado** igual al origen público, sin puerto (443).
- **Cabeceras de identidad.** Serve añade `Tailscale-User-Login`, `-Name`, `-Profile-Pic` y `Tailscale-Headers-Info` desde nodos de usuario (no desde nodos con tag). El Puente las retira antes de la aplicación.
- **Reinicio del Puente.** Las autorizaciones viven en memoria: tras reiniciar, cada navegador vuelve a la página de acceso. La sesión propia de la aplicación sigue (comprobado). Si el listener cambia de puerto al reiniciar, hay que reapuntar el Service; con puerto fijo por aplicación no.
- **Caducidad.** Una hora desde la concesión, reloj del Servidor, sin renovación por uso. El `Max-Age` de la cookie es ayuda; la autoridad es el Puente.
- **Revocación.** Corta streams abiertos de la sesión (SSE y WebSocket), rechaza los nuevos y cancela las concesiones aún no canjeadas de la aplicación. Revocar el dispositivo que concedió revoca sus sesiones web, sus concesiones sin canjear y su llave.
- **Sin listener, sin publicación.** El Service apunta solo al listener; si el Puente no corre, la aplicación no tiene otra ruta publicada. La respuesta exacta de Serve en ese caso no se observó.

### Forma propuesta de `ServicePublisher`

El adaptador que publica y retira Services, separado del listener para que el laboratorio y las pruebas usen el simulador y producción la CLI. Solo la primera causa de bloqueo (`serve_disabled`) se observó; el resto sale de la documentación de Tailscale y del orden de aprobación de abajo, y debe confirmarse con Services real antes de fijar los nombres.

```ts
type AppId = string; // [a-z0-9-], también es el nombre DNS del Service
type Publication =
  | { state: 'published'; service: `svc:${AppId}`; origin: string; listenerPort: number }
  | { state: 'unpublished' }
  | { state: 'blocked'; reason: PublishBlock };
type PublishBlock =
  | 'tailscale_unavailable' // la CLI no responde o no hay sesión
  | 'serve_disabled'        // «Serve is not enabled on your tailnet» (observado)
  | 'host_not_tagged'       // el anfitrión no tiene el tag que exige Services (no observado)
  | 'service_undefined'     // no existe `svc:<app>` en la política (no observado)
  | 'host_not_approved';    // anunciado pero sin aprobar en la consola (no observado)

interface ServicePublisher {
  /** Idempotente. Apunta `svc:<app>` HTTPS 443 a `http://127.0.0.1:<listenerPort>`; nunca al puerto de la aplicación. */
  publish(app: AppId, listenerPort: number): Promise<Publication>;
  /** Idempotente. Retira solo `svc:<app>`; ninguna otra entrada de Serve cambia. */
  unpublish(app: AppId): Promise<void>;
  /** Lo que Serve tiene ahora para `svc:<app>`, leído de `tailscale serve status --json`. */
  status(app: AppId): Promise<Publication>;
}
```

- **Implementación real (#96):** `tailscale serve --service=svc:<app> --https=443 http://127.0.0.1:<puerto>` y `tailscale serve clear svc:<app>`, por `exec.ts` (vector de argumentos, sin shell). Antes y después compara `tailscale serve status --json` y falla si cambió algo ajeno a `svc:<app>` (es lo que hizo `src/realServe.ts`). El origen sale del nombre MagicDNS de la tailnet, no de configuración manual.
- **Simulada (#89/#90 y pruebas):** `src/serveSim.ts` hace de Services; `publish` siempre `published`, con el origen del laboratorio.
- **Bloqueos.** Relay muestra el motivo y no ofrece la web de esa aplicación; el Puente nunca publica el puerto de la aplicación como alternativa. Los pasos de consola son de Ale (ver abajo).
- **Errores.** La salida de la CLI se clasifica en `PublishBlock` y no se reenvía tal cual: puede contener el id del nodo y el nombre de la tailnet.

## Requisitos para portar el listener al Puente (#89/#90)

Lo que estas correcciones dejan fijado y debe llegar con el código del Puente, con su prueba:

- **Ninguna entrada externa lanza.** Toda URL que venga de la aplicación (`Location`) o del cliente (destino de la petición, `next`) se analiza con `URL.parse` o dentro de `try`. El listener comparte proceso con el API de control: una excepción no capturada deja a Relay sin Puente. Prueba: aplicación con `Location: http://` y destinos `//` en petición y en upgrade; el listener responde y sigue sirviendo.
- **`Location` se resuelve contra el origen público** antes de decidir si apunta al loopback (absoluto, `//host:puerto`, `http:/host:puerto`); inanalizable, se quita.
- **`Set-Cookie` por atributos, no por expresión regular sobre la línea.** Partir por `;`, recortar nombre y nombres de atributo, quitar `domain` en cualquier grafía, descartar sin nombre y con prefijo reservado (sin distinguir mayúsculas). Prueba con `Domain =`, tabulador y `DOMAIN = .padre`.
- **Revocar cancela lo concedido y no canjeado.** El API de control devuelve `{ revoked, cancelled }`. Hoy `GET …/requests` solo lista las pendientes sin conceder: #89 debe decidir si Relay muestra también las concedidas a la espera del navegador (con su código y quién concedió) para cancelar una sola sin revocar la aplicación entera; con el diseño actual, la única cancelación es revocar.
- **Cortes por petición, no por socket.** `cut()` del laboratorio destruye `req.socket`; detrás de Serve con conexiones persistentes compartidas podría cortar peticiones de otra sesión. En el Puente, abortar la petición y la respuesta concretas (`res.destroy()`, `up.destroy()`), y el socket solo en upgrades.
- **Caducidad exacta.** El barrido cada segundo deja hasta 1 s de stream tras vencer; programar el corte en `expiresAt` o comprobarlo al escribir, con el reloj del Servidor en milisegundos y `Max-Age` en segundos.
- **Registro acotado.** El `log` del laboratorio crece sin tope; el Puente usa su registro normal (método, ruta sin consulta, estado) y nada más.
- **Tope de pendientes.** 20 por aplicación permiten a cualquiera con acceso al Service ocupar el acceso 5 minutos. Aceptable para V3 si Relay lo explica; si no, tope por identidad `Tailscale-User-Login` (que el Puente lee antes de retirarla) además del de aplicación.
- **`Host` y `X-Forwarded-Proto` no autentican.** El listener escucha en loopback y cualquier proceso local puede enviarlas; la autorización es solo la sesión. No se observó si Serve sobrescribe un `X-Forwarded-Proto` enviado por el cliente ni el `Host` exacto (sin puerto) con Services HTTPS: comprobarlo en la validación con consola.
- **Visor (#91).** `Linking.openURL` solo para `http:`/`https:` de otro origen (nada de `intent:` ni `tel:`); `new URL(next)` en `onOpenWindow` dentro de `try`; `webviewDebuggingEnabled` apagado en el APK de producción.

## Simulado frente a pendiente de validación administrativa

| Aspecto | Estado |
|---|---|
| Lógica del listener del Puente, handoff, cookies, `Origin`, cortes | Probado en laboratorio (Node y Chromium/Chrome reales). |
| Cabeceras y transporte de Serve (`Host`, `X-Forwarded-*`, identidad, SSE, WebSocket, subidas, cortes) | Probado con Serve real por HTTP y contrastado con el código de 1.102.3. |
| `X-Forwarded-Proto: https` con Serve HTTPS real | Por código fuente; no observado (HTTPS no habilitado). |
| Si Serve sobrescribe un `X-Forwarded-Proto` enviado por el cliente; `Host` exacto (sin puerto) con Services HTTPS | No observado. Pendiente de la consola. |
| Certificado y nombre por Service, aislamiento de origen real `*.tailnet.ts.net` | Simulado con nombres bajo `ts.net` mapeados a loopback. Pendiente. |
| Publicación con `tailscale serve --service`, aprobación del anfitrión, ACL | No ejecutado: requiere consola. Pendiente. |
| WebView Android y Chrome Android | Probado en emulador Android 16: WebView 8/8; Chrome 7/8. Pendiente: descarga en Chrome con certificado real y repetir en teléfono físico. |
| Service workers (registro, caché tras revocar, `fetch` desde el worker al listener) | No probado. El contrato (punto 10) solo dice que revocar no borra lo que el navegador ya guardó; un `fetch` del worker pasa por el listener y necesita sesión como cualquier otro. Pendiente para #90. |
| Visor con certificado real, `ServicePublisher` real | Pendiente de la consola; la forma está arriba y el simulador la cubre en pruebas. |

### Lo que debe aprobar Ale en la consola de la tailnet

Para observar el caso real hacen falta, en este orden:

1. Habilitar HTTPS (certificados) en la tailnet: DNS → HTTPS Certificates, o el enlace que imprime `tailscale serve --https` («Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=<id del nodo>»). Publica los nombres certificados en Certificate Transparency.
2. Definir un tag para el anfitrión de Services (por ejemplo `tag:relay-web`) en la política y asignarlo a `arch` (hoy el nodo no tiene tags; Services exige identidad por tag). Riesgo: etiquetar el nodo cambia su identidad de usuario a tag; antes hay que revisar que las reglas que hoy dan acceso a `arch` (Puente 8650, Hermes) sigan valiendo, y Serve deja de añadir cabeceras de identidad solo cuando el *cliente* tiene tag, no el anfitrión.
3. Crear el Service `svc:relay-lab-a` (puerto TCP 443) y, si se quiere B, `svc:relay-lab-b`, y conceder acceso al usuario de Ale en la política.
4. Aprobar a `arch` como anfitrión del Service tras anunciarlo.

Después, con el candado `tailscale`: `tailscale serve --service=svc:relay-lab-a --https=443 http://127.0.0.1:<listener>` y repetir el recorrido desde el teléfono; al terminar `tailscale serve clear svc:relay-lab-a` y comparar `tailscale serve status --json`.

## Incompatibilidades encontradas y alternativa

| Hallazgo | Alternativa concreta |
|---|---|
| Serve directo al servidor de desarrollo no autoriza nada y deja escapar redirecciones a loopback. | Serve/Services siempre hacia el listener del Puente de esa aplicación. |
| Un host con un puerto por aplicación comparte cookies: la cookie de Relay de una aplicación sustituye a la de otra, y las sesiones propias con el mismo nombre se pisan. | Un nombre de Service por aplicación. Si no se aprueba Services, no publicar más de una aplicación por host para navegador externo. |
| Cookie `Domain` padre creada por JavaScript llega a las hermanas. | Contrato de cookies `__Host-`; aplicaciones que no lo cumplan se usan con el navegador del Servidor. |
| URLs absolutas fijas a loopback en HTML/JS no se reescriben. | Adaptar la aplicación (punto 1 del contrato) o navegador del Servidor. |
| `react-native-webview` pierde las ventanas nuevas si no se define `onOpenWindow`. | En el visor de Relay (#91): `setSupportMultipleWindows` + `onOpenWindow`; mismo origen en el visor, otro origen con `Linking.openURL`. |
| Las descargas del WebView salen por `DownloadManager` con la cookie de sesión de Relay. | Aceptarlo dentro del dispositivo (vale lo que queda de la hora) o, en #91, descargar por el canal nativo de Relay. Decisión de #91. |
| Chrome Android no completa descargas en el laboratorio (certificado sintético fuera de DevTools). | Repetir con Services HTTPS real; no instalar la CA de laboratorio en el sistema. |

## Reproducir

```bash
cd labs/v3-proxy
npm ci
npm test                                  # contrato HTTP + Chromium (CHROMIUM=/ruta para otro)
npm run matrix                            # PASS/FAIL por configuración
node src/realServe.ts                     # con el candado tailscale; revierte al terminar
npm run lab                               # laboratorio manual con instrucciones para Chromium
(cd viewer && npm ci && JAVA_HOME=<JDK 17> bash build-android.sh)   # APK del visor, x86_64 (ARCHS=arm64-v8a para teléfono; no compilado en esta prueba)
node src/android.ts <serial> all          # con el candado android: visor WebView y Chrome
```
