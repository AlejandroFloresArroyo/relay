# Instalar y operar Relay V3 en el Servidor

Guía para preparar un Servidor con las herramientas remotas de V3: Terminal remota, archivos, aplicaciones web y Navegador del Servidor (dedicado y habitual). Parte de un Puente ya instalado y emparejado ([instalación del Puente](bridge-install.md)); V3 no cambia el transporte de v1, que sigue siendo HTTP por la tailnet al puerto del Puente (normalmente 8650).

Todo lo que toca la consola de Tailscale, el navegador de la computadora o termina terminales es un paso de la persona. `relayd doctor`, `relayd web` y `relayd setup --dry-run` solo leen.

## Matriz probada

V3 se probó en laboratorio en esta combinación (#76, #78, #81, #92, #93). La matriz de la aceptación, con lo probado en cada escenario, lo no probado y la guía de actualización, está en [docs/relay-v3-matriz.md](relay-v3-matriz.md) (#97). Lo que no aparece aquí no está probado, aunque una dependencia diga que lo admite: `relayd doctor` lo marca como `aviso` y hay que registrar el resultado antes de darlo por compatible.

| Componente | Probado |
|---|---|
| Sistema | Linux x86_64 (Arch), glibc 2.44, systemd 261, cgroup v2 |
| Node | 26.10.0. Node 27 o posterior: no certificado |
| PTY | node-pty 1.1.0 compilado en el Servidor con GCC, `make`, `python3` y las cabeceras del Node en uso |
| Navegador dedicado | Chromium 152.0.7977.82 y Google Chrome 154.0.8037.57, en su scope con `MemoryMax=4G` y `TasksMax=2048` |
| Navegador habitual | Google Chrome 154.0.8037.57 y Chrome for Testing 154.0.8037.92. La extensión exige Chrome 154 (`minimum_chrome_version`); Chromium 152 no la carga |
| Tailscale | CLI 1.102.3: `tailscale serve --service=svc:… --https=443 <destino>` y `tailscale serve clear svc:…` existen con esa forma (comprobado con su ayuda, sin ejecutarlas). `relayd doctor` no comprueba la versión. Services en una tailnet real: sin validar (ver «Validación real pendiente») |

Sin probar (lista completa en la [matriz](relay-v3-matriz.md#no-probado)): arm64, otras distribuciones y otras glibc, teléfono físico, las herramientas del Servidor en la tablet física y Tailscale Services reales.

### Componentes nuevos

- **Supervisor** (`supervisor/`). Guarda los Entornos propios, sus terminales y sus navegadores dedicados, separado del Puente, en su propia unidad de usuario `relay-supervisor.service`. Su socket y su llave viven en `$XDG_RUNTIME_DIR/relay-supervisor` (0700) y su registro en `$XDG_STATE_HOME/relay-supervisor`. Cada entorno corre en su scope `relay-env-<id>.scope` bajo `app.slice` del gestor de usuario, fuera de la unidad del Puente.
- **Extensión de Relay** (`bridge/extension/`) y su adaptador de native messaging `com.relay.browser`, para el Navegador del Servidor habitual.
- **Listeners web.** Uno por aplicación registrada, en `127.0.0.1`, dentro del proceso del Puente. Cada uno se publica con su propio Tailscale Service.

## Requisitos

- Lo que ya pide el Puente: Linux, sesión systemd de usuario con `XDG_RUNTIME_DIR`, Node 26, Tailscale conectado.
- Para la terminal: cgroup v2 con el subárbol delegado del gestor de usuario (`app.slice` con `cgroup.kill`, Linux 5.14 o posterior), `systemd-run`, y para compilar node-pty un compilador C/C++, `make`, `python3` y las cabeceras de Node (`include/node`). Relay no instala paquetes del sistema.
- Para archivos y web: `/proc` accesible para el usuario del Puente (`/proc/self/fd`, `/proc/net/tcp`).
- Para publicar una web: certificados HTTPS y Services en la tailnet (ver «Publicar una web»).
- Para el navegador dedicado: Chromium o Google Chrome en el `PATH` del gestor de usuario (el supervisor usa el primero de `chromium`, `google-chrome-stable`, `google-chrome` y `chromium-browser`), y los controladores `memory` y `pids` delegados en `app.slice`, que aplican sus topes de memoria y tareas.
- Para el navegador habitual: Google Chrome 154 o Chrome for Testing 154.
- Para subir archivos del teléfono a una página o traer al teléfono lo que una página descarga, en cualquiera de los dos navegadores: la herramienta de archivos (`--files`).
- Opcional: linger (`loginctl enable-linger`) si el supervisor y sus terminales deben seguir vivos sin sesión abierta. Es decisión tuya; Relay no lo activa.

## Diagnóstico: `relayd doctor`

Desde `bridge/`:

```bash
./relayd doctor
```

Solo lee: consulta versiones y estados, nunca abre el `.env` del Puente, la llave del supervisor ni un perfil del navegador, y nunca conecta a un navegador. Cada línea tiene un estado:

- `ok`: listo.
- `aviso`: funciona o es opcional, pero fuera de lo probado o incompleto.
- `falta`: impide la herramienta. Debajo, tras `→`, va el paso que lo resuelve.

Sale con código 1 si alguna línea es `falta`.

| Área | Qué comprueba | Acción típica |
|---|---|---|
| Sistema | Linux y arquitectura probada | Otra arquitectura: `aviso`, registrar el resultado |
| Node | Versión mayor 26 | Instalar Node 26; posterior: recompilar node-pty y probar |
| systemd de usuario | Gestor de usuario y `systemd-run` | Ejecutar desde la sesión del usuario |
| cgroup v2 | Jerarquía unificada | Arrancar con cgroup v2 |
| Permisos de supervisión | `app.slice` delegado con `cgroup.kill` escribible | Revisar la delegación de `user@.service` (Relay no la cambia) |
| Linger | Gestor activo sin sesión | `aviso` si no: decide tú `loginctl enable-linger` |
| PTY (node-pty) | node-pty 1.1.0 compilado y cargable con este Node; si no, qué herramientas faltan | `cd supervisor && npm run setup` |
| Supervisor | Unidad instalada, directorio privado 0700 del usuario, servicio activo y socket | `relayd setup --supervisor` (antes con `--dry-run`) |
| Puente | Herramientas V3 que activa su unidad y que `RELAY_SUPERVISOR_DIR` apunta al supervisor | `relayd setup … --replace-service --restart` |
| Archivos | `/proc/self/fd` | Montar `/proc` sin `hidepid` para el usuario del Puente |
| Web: descubrimiento | `/proc/net/tcp` legible | Igual |
| Web: Tailscale HTTPS/Services | Tailscale conectado, certificados HTTPS en la tailnet y tag en el anfitrión | Pasos de consola de «Publicar una web» |
| Navegador dedicado | El programa que lanzaría el supervisor, buscado como él en el `PATH` del gestor de usuario, y su versión | Instalar Chromium o Google Chrome; otra versión: `aviso`, probar antes |
| Navegador dedicado: topes | `memory` y `pids` delegados en `app.slice`, para `MemoryMax` y `TasksMax` del navegador | Revisar la delegación de `user@.service` (Relay no la cambia) |
| Navegador / Adaptador | Versión de cada navegador (`--version`) y manifiesto del adaptador | `relayd browser <navegador>` |
| Puente: drop-ins / Supervisor: drop-ins | Archivos `*.conf` en `~/.config/systemd/user/relay-bridge.service.d/` o `relay-supervisor.service.d/`, solo por nombre: `aviso`, porque systemd los aplica encima de la unidad | Revisarlos antes de `relayd setup` |

La línea «Puente» lee solo la unidad: un `.env` privado puede cambiar esos valores y doctor no lo abre. Tampoco lee los drop-ins: si los hay, los nombra en su propia línea, porque un drop-in puede sustituir `ExecStart` o `Environment` y entonces el Puente que arranca no es el de la unidad.

## Compilar el supervisor

Una vez por Servidor, y otra vez si cambia la versión de Node o el lockfile de `supervisor/`:

```bash
cd supervisor && npm run setup
```

Compila node-pty 1.1.0 con las cabeceras del Node en uso (`npm ci`). Si falla, `relayd doctor` dice qué herramienta falta. `relayd setup --supervisor` se niega a instalar sin ese binario.

## Instalar con `relayd setup`

Opciones de V3, que se combinan con `--replace-service` y `--restart` de siempre:

| Opción | Efecto |
|---|---|
| `--supervisor` | Instala `relay-supervisor.service` y apunta el Puente a él (`RELAY_SUPERVISOR_DIR`): terminal y entornos |
| `--files` | `RELAY_REMOTE_FILES=1` en la unidad del Puente; también anuncia `chat_files` (adjuntar un archivo del Servidor por referencia en la Conversación) |
| `--web` | `RELAY_REMOTE_WEB=1` en la unidad del Puente |
| `--browser-habitual` | `RELAY_BROWSER_HABITUAL=1`; exige `--supervisor` |
| `--restart-supervisor` | Reinicia un supervisor activo; exige `--supervisor`. Sus terminales quedan `lost` |
| `--dry-run` | Comprueba todo e imprime archivos y órdenes; no escribe ni cambia nada |

La unidad del Puente se genera entera con las opciones de cada ejecución: repite siempre todas las que usas. Una herramienta que omitas desaparece de la unidad; al sustituir una unidad, `setup` (también con `--dry-run`) avisa con `Aviso: relay-bridge.service ya no tendría …` y los nombres de las variables que se pierden.

Antes de instalar, simula:

```bash
cd bridge
./relayd setup --dry-run --supervisor --files --web --replace-service --restart
```

Ejemplo recortado, con rutas y direcciones sustituidas:

```text
Simulación (--dry-run): no se escribe ningún archivo ni se cambia ningún servicio.
/ruta/al/checkout/bridge/.env: existente; se conserva sin abrirlo.
<home>/.config/systemd/user/relay-supervisor.service: se crearía.
  | [Service]
  | WorkingDirectory=/ruta/al/checkout/supervisor
  | ExecStart=:"/ruta/a/node" "/ruta/al/checkout/supervisor/src/main.ts" --runtime "/run/user/<uid>/relay-supervisor"
  | Restart=on-failure
  | …
<home>/.config/systemd/user/relay-bridge.service: se sustituiría.
  | [Service]
  | Environment=RELAY_HOST=<IP de la tailnet>
  | Environment=RELAY_PORT=8650
  | Environment="RELAY_SUPERVISOR_DIR=/run/user/<uid>/relay-supervisor"
  | Environment=RELAY_REMOTE_FILES=1
  | Environment=RELAY_REMOTE_WEB=1
  | EnvironmentFile=/ruta/al/checkout/bridge/.env
  | ExecStart=:"/ruta/a/node" "/ruta/al/checkout/bridge/src/main.ts" serve
  | UMask=0077
  | Restart=always
  | …
Órdenes:
  systemctl --user daemon-reload
  systemctl --user enable relay-supervisor
  systemctl --user start relay-supervisor
  systemctl --user enable relay-bridge
  systemctl --user restart relay-bridge
Después mostraría el emparejamiento (relayd pair). Nada se ha cambiado.
```

Después, en una terminal interactiva, la misma orden sin `--dry-run`. El supervisor se escribe, habilita e inicia antes que el Puente que se conecta a él.

Forma de las unidades:

- Ninguna nombra a la otra: no hay `Requires`, `After` ni `PartOf` entre ellas.
- La del supervisor no carga `EnvironmentFile` y conserva la umask por defecto, porque las terminales heredan su entorno: la configuración privada del Puente y su `UMask=0077` no llegan a las shells.
- Las dos fijan la ruta absoluta de Node: si cambias de Node, vuelve a ejecutar `setup`.
- El `.env` privado del Puente prevalece sobre los valores de su unidad. `setup` y `doctor` nunca lo leen: revisa tú si contradice las opciones elegidas.
- Los drop-ins (`relay-bridge.service.d/*.conf`, `relay-supervisor.service.d/*.conf` en `~/.config/systemd/user/`) se aplican encima de la unidad que escribe `setup` y pueden sustituir su `ExecStart` o su `Environment`. `setup` y `doctor` los nombran con un aviso, sin leerlos ni cambiarlos: revísalos y retira los que ya no correspondan antes de `--replace-service --restart`. Por ejemplo, un drop-in de actualización de v2 con `ExecStart=` vacío y otro `ExecStart=` haría arrancar ese otro Puente aunque la unidad apunte a este checkout.
- Las terminales heredan el entorno del gestor de usuario de systemd (`systemctl --user show-environment`), no el de una sesión de inicio: la shell se abre interactiva y sin `-l`, así que lo que solo pone `~/.profile` o `~/.bash_profile` (por ejemplo, entradas del `PATH`) no está. Ponlo en el archivo que la shell lee en modo interactivo (`~/.bashrc`) o en `~/.config/environment.d/`.

## Actualizar

### El Puente

```bash
git pull
cd bridge
./relayd setup --supervisor --files --web --replace-service --restart   # las opciones que ya usas
# o, si la unidad no cambia:
systemctl --user restart relay-bridge
```

Desde 3.1 el Puente anuncia dos capacidades más sin opciones nuevas: `metrics` (CPU, memoria y disco de Hermes) aparece sola si el sistema deja leer esas cifras, y `chat_files` acompaña a `files`, así que la da `--files`.

Actualizar o reiniciar el Puente **nunca termina entornos**: viven en sus scopes `relay-env-*.scope` bajo `app.slice`, propiedad del supervisor, y ninguna unidad referencia a la otra. Al reiniciar se pierde lo que el Puente guarda en memoria: Autorizaciones web (cada navegador vuelve a pedir acceso) y conexiones del navegador habitual. Las terminales siguen.

### El supervisor

Reiniciar el supervisor cierra sus PTYs: las terminales vivas quedan `lost` en Relay. Por eso:

- `setup --supervisor` sin `--restart-supervisor` nunca reinicia un supervisor activo. Si su unidad cambió, lo dice: la nueva se aplica en su próximo arranque.
- `--restart-supervisor` avisa antes cuántos entornos vivos quedarán perdidos. Úsalo solo cuando aceptes cerrar esas terminales.

Igual que la unidad, el código nuevo del supervisor tras `git pull` no corre hasta su próximo arranque.

### Actualización interrumpida

Las unidades se escriben de forma atómica (temporal y renombrado): un corte deja la anterior entera. Si `setup` falla, imprime los pasos completados y la acción fallida; corrige la causa y vuelve a ejecutar la misma orden.

## Navegador del Servidor habitual

Requiere pasos en la computadora, una vez por navegador:

1. Registra el adaptador:

   ```bash
   cd bridge
   ./relayd browser google-chrome      # o chrome-for-testing
   ```

   Escribe el manifiesto `com.relay.browser.json` del navegador, permitido solo para la extensión de Relay, e imprime su ID.
2. En ese navegador, abre `chrome://extensions`, activa «Modo de desarrollador», pulsa «Cargar descomprimida» y elige `bridge/extension/` del checkout.
3. Comprueba que el ID de la extensión es el que imprimió el paso 1.
4. Activa la herramienta en el Puente, con las demás opciones que ya usas:

   ```bash
   ./relayd setup --supervisor --browser-habitual --replace-service --restart
   ```

Un `RELAY_BROWSER_HABITUAL=1` en el `.env` sigue funcionando, pero la opción de `setup` deja la configuración en la unidad, donde `doctor` la ve.

Solo se controlan las pestañas que compartes con el botón de la extensión y las que abre Relay. `relayd doctor` comprueba versión y manifiesto; cargar la extensión no lo puede comprobar, porque nunca abre perfiles ni conecta al navegador.

Archivos: Relay rellena solo el selector de archivos que abre su propio toque; el que abres tú en la computadora sigue siendo tuyo. Una descarga de una pestaña compartida queda donde la guarda el navegador, y Relay la ofrece al teléfono con la herramienta de archivos. Las descargas de las demás pestañas no se informan.

Tras actualizar el Puente, recarga la extensión en `chrome://extensions`: el Puente y la extensión comprueban la versión de su canal, y con otra el navegador habitual queda `helper_incompatible`. La versión 3 pide además el permiso `downloads`.

## Publicar una web

Cada aplicación del Servidor se abre en el teléfono por HTTPS con su propio Tailscale Service, siempre hacia el listener del Puente para esa aplicación. **La publicación es manual**: el Puente nunca cambia la configuración de Tailscale; solo lee `tailscale status --json` y `tailscale serve status --json` para saber si cada Service apunta a su listener.

Activa la herramienta con `relayd setup … --web` (o `RELAY_REMOTE_WEB=1`).

### Pasos en la consola de Tailscale, una vez

Los hace la persona administradora de la tailnet, en este orden:

1. **Habilitar certificados HTTPS** (DNS → HTTPS Certificates). Los nombres certificados, del Service y de la tailnet, quedan públicos en Certificate Transparency: por eso Relay usa nombres neutros.
2. **Etiquetar el anfitrión.** Define un tag en la política (por ejemplo `tag:relay-web`) y asígnalo al Servidor: Services exige un anfitrión con tag. **Riesgo:** el tag cambia la identidad del Servidor de tu usuario al tag. Antes revisa las reglas de acceso que hoy te dejan llegar al Puente (8650) y a Hermes y adáptalas al tag. Después comprueba que la app sigue conectando al Puente por HTTP de tailnet: el transporte de v1 debe seguir funcionando.
3. **Definir un Service por aplicación**, con el nombre que da Relay (`svc:relay-<16 hex>`, puerto TCP 443). Relay genera ese nombre neutro al registrar la aplicación y nunca lo reutiliza; no lo cambies por uno descriptivo.
4. **Conceder acceso** a ese Service a tu usuario en la política.
5. **Aprobar el Servidor como anfitrión** del Service, tras anunciarlo con la orden de abajo. La aprobación no se ve desde el Servidor.

Después, `relayd doctor` debe dar `ok` en «Web: Tailscale HTTPS/Services».

### Por cada aplicación

1. Regístrala en Relay (ver «Registro de aplicaciones»).
2. En el Servidor:

   ```bash
   cd bridge
   ./relayd web
   ```

   Lista cada aplicación con su Service, su listener y la orden de publicación:

   ```text
   <nombre>: svc:relay-<16 hex>, escucha 127.0.0.1:<puerto>
     sin publicar: <motivo>
     publicar: tailscale serve --service=svc:relay-<16 hex> --https=443 http://127.0.0.1:<puerto>
   ```

3. Ejecuta exactamente esa orden. El destino es **siempre el listener del Puente** para esa aplicación, **nunca el puerto de la aplicación ni del servidor de desarrollo**: publicar la aplicación directamente salta la Autorización web. Relay solo la cuenta como publicada si el Service es exactamente lo que crea esa orden: HTTPS 443 con `/` hacia el listener, sin otras rutas, puertos, nombres ni modo túnel. Si el Service reenvía algo más (por ejemplo `/dev` o el puerto 8443 hacia la aplicación), `relayd web` la da sin publicar y añade antes de la orden de publicación una línea `retirar antes: tailscale serve clear svc:relay-<16 hex>`: volver a publicar solo sustituye `/`, así que hay que retirar el Service primero.
4. Aprueba el Servidor para ese Service en la consola si aún no lo está (paso 5 de arriba).
5. `relayd web` muestra `publicada en https://…` cuando Serve apunta al listener.

Si tras reiniciar el Puente el listener tuvo que tomar otro puerto, `relayd web` vuelve a mostrar la aplicación sin publicar con la orden nueva: ejecútala.

### Retirar

Olvidar una aplicación en Relay no toca Tailscale. `relayd web` lista los Services `relay-…` que ya no usa ninguna aplicación:

```text
Services obsoletos (ninguna aplicación registrada los usa); retíralos:
  tailscale serve clear svc:relay-<16 hex>
```

Ejecuta esa orden: un Service olvidado seguiría reenviando a un puerto local cerrado o reutilizado. Si la aplicación se vuelve a registrar, recibe otro nombre. La lista de obsoletos solo aparece cuando Tailscale ya sirve Services en el Servidor.

### Validación real pendiente

En la tailnet donde se desarrolló V3, HTTPS y Services no están habilitados: el listener y la Autorización web se probaron con un publicador simulado y listeners reales en loopback, y el publicador manual con salidas de la CLI construidas según el código de Tailscale, no observadas. Antes de declarar compatible un despliegue hay que observar y registrar, con un Service real (en `docs/research/v3-proxy.md`, tabla «Simulado frente a pendiente de validación administrativa», y en la ADR 0006, sin nombres de la tailnet ni códigos):

- [ ] `X-Forwarded-Proto: https` y el `Host` exacto (nombre del Service, sin puerto) que entrega Serve HTTPS, y si Serve sobrescribe un `X-Forwarded-Proto` enviado por el cliente.
- [ ] Un certificado por Service, válido en el teléfono.
- [ ] Aislamiento de origen real entre dos aplicaciones bajo `*.ts.net`.
- [ ] En Chrome Android contra el Service: página de acceso, concesión desde Relay, canje, corte al revocar y al vencer la hora, y una descarga.
- [ ] Aprobación del anfitrión en la consola y lo que muestra `relayd web` antes y después.
- [ ] Que el transporte de v1 al Puente sigue funcionando con el Servidor etiquetado.
- [ ] `tailscale serve clear` retira solo su Service (comparar `tailscale serve status --json` antes y después).
- [ ] Forma real de `tailscale serve status --json` para un Service publicado con la orden de `relayd web`: Relay exige que sea exactamente `TCP {443: {HTTPS: true}}` y `Web {<nombre>:443: {Handlers: {/: {Proxy: http://127.0.0.1:<puerto>}}}}`; si Tailscale añade otros campos, `relayd web` nunca la daría por publicada.
- [ ] `tailscale serve drain svc:…`: tras el drain la configuración sigue igual y `relayd web` sigue diciendo «publicada», aunque el anfitrión ya no acepte conexiones nuevas. Observar qué muestra `tailscale serve status --json` y qué ve el teléfono.

### Cookies y origen

- Cada aplicación tiene su propio origen `https://relay-<16 hex>.<tailnet>.ts.net`, servido en `/`.
- El listener solo sirve si `Host` es el nombre de su Service y `X-Forwarded-Proto` es `https`: una publicación HTTP no se sirve.
- La cookie de Relay es `__Host-RelayWeb` (y `__Host-RelayPend` durante el acceso). No se reenvían a la aplicación, que no puede escribir ningún nombre `__Host-Relay*` ni usar `/__relay/`.
- El Puente quita `Domain` de cada `Set-Cookie` de la aplicación, pero no ve `document.cookie`: una cookie del dominio padre creada por JavaScript llega a las aplicaciones hermanas. Usa cookies `__Host-` sin `Domain` para lo sensible y no compartas cookies entre aplicaciones.
- Se rechazan peticiones con efectos y WebSocket con `Origin` de otra aplicación; formularios y WebSocket deben enviar `Origin` (los navegadores lo hacen).

### Servidores de desarrollo y HMR

- URLs relativas o derivadas de `location`: recursos, `fetch`, SSE y WebSocket (`wss://` + `location.host`). Una URL fija a `127.0.0.1:<puerto>` o `localhost` apunta al teléfono.
- Base pública relativa y servida en `/`, sin prefijos de ruta.
- Aceptar el `Host` público (en Vite, `server.allowedHosts`). El cliente HMR sin host ni puerto fijos (en Vite, `server.hmr.clientPort: 443`; no probado con Vite real).
- Reiniciar el servidor de desarrollo termina las Autorizaciones web de esa aplicación: pide una nueva.

### Registro de aplicaciones

Se registra desde Relay, eligiendo entre los candidatos: sockets en escucha de tu cuenta, leídos de `/proc/net/tcp`, en loopback o en todas las direcciones. Relay nunca conecta a un puerto para descubrirlo. Nunca se ofrecen 8642 (API de Hermes), 9119 (panel de Hermes) ni 8650 y el puerto del Puente. Como máximo 32 aplicaciones.

### Revocación, caducidad y caché

- Una Autorización web externa dura una hora desde la concesión, sin renovación por uso.
- Vive en memoria del Puente: tras reiniciarlo hay que autorizar de nuevo. Las terminales no se ven afectadas.
- Revocar el dispositivo, cancelar la autorización u olvidar la aplicación cortan las conexiones abiertas.
- Revocar o vencer no borra lo que el navegador ya guardó: caché, descargas ni service workers.

## Despliegue de producción (2026-10-05)

Registro del Servidor de Ale. Los resultados en la tablet física están en la [matriz](relay-v3-matriz.md#despliegue-de-producción-y-tablet-física).

- **Código**: worktree separado `~/dev/relay-app-bridge-v3.0.0`, fijado en `27b5bc8` (`release/v3.0.0`), con `npm ci` en `bridge/` y `supervisor/` y `npm run setup` en `supervisor/` (node-pty 1.1.0).
- **Orden**: `./relayd setup --supervisor --files --replace-service --restart`, antes con `--dry-run`. Sin `--web`: la tailnet no tiene HTTPS ni Services. Sin `--browser-habitual`: falta cargar la extensión.
- **Estado**: el Puente guarda su estado en el `bridge/` del checkout que ejecuta. Con el servicio detenido se copiaron `.env`, `agent-modes.json`, `changes.jsonl`, `conversations.json`, `decisions.json`, `devices.json` y `kanban/` de `/home/user/dev/relay-app/bridge` (el directorio de v2) al `bridge/` del worktree, comprobados con `sha256sum -c`. El directorio de v2 quedó como estaba al detener el servicio.
- **Drop-in**: `relay-bridge.service.d/90-relay-v2-update.conf` se retiró al respaldo antes de `setup`; si no, systemd seguiría arrancando el Puente v2.
- **Respaldo**: `~/.local/share/relay-backups/bridge-v3-deploy-20261005T212153/` (0700): `state/`, `systemd/` (unidad y drop-in de v2), `90-relay-v2-update.conf.retirado` y `SHA256SUMS`.
- **Resultado**: `/health` anuncia `environments`, `terminal`, `files` y `browser`. `relayd doctor` da `ok` salvo `falta Web: Tailscale HTTPS/Services` y los `aviso` del navegador habitual.
- **Emparejar**: `relayd pair` desde `~/dev/relay-app-bridge-v3.0.0/bridge`. Desde otro checkout responde «El Puente no está disponible», porque el socket de administración depende del directorio de estado.

### Navegador habitual: pasos de Ale

En la computadora, con Google Chrome 154:

1. `cd ~/dev/relay-app-bridge-v3.0.0/bridge && ./relayd browser google-chrome`. Anota el ID que imprime.
2. En Chrome, `chrome://extensions` → «Modo de desarrollador» → «Cargar descomprimida» → `~/dev/relay-app-bridge-v3.0.0/bridge/extension/`.
3. Comprueba que el ID de la extensión es el del paso 1.
4. `./relayd setup --supervisor --files --browser-habitual --replace-service --restart`, antes con `--dry-run`. El supervisor no se reinicia y sus terminales siguen.
5. `./relayd doctor`: «Adaptador google-chrome» en `ok`.

### Vuelta atrás a v2

Con `B=~/.local/share/relay-backups/bridge-v3-deploy-20261005T212153`:

1. `systemctl --user stop relay-bridge relay-supervisor` y `systemctl --user disable relay-supervisor`. Las terminales de Relay terminan.
2. `cp $B/systemd/relay-bridge.service ~/.config/systemd/user/`, `mkdir -p ~/.config/systemd/user/relay-bridge.service.d` y `cp $B/90-relay-v2-update.conf.retirado ~/.config/systemd/user/relay-bridge.service.d/90-relay-v2-update.conf`.
3. El Puente v2 usa `/home/user/dev/relay-app/bridge`, con el estado de antes del despliegue. Para conservar los dispositivos emparejados con V3, copia solo `devices.json` del worktree V3 a ese directorio. No copies `changes.jsonl`: v2 no lee las acciones `remote.*`.
4. `systemctl --user daemon-reload && systemctl --user start relay-bridge`. `/health` debe responder sin `capabilities`.

## Despliegue de producción 3.1 (2026-10-06)

Registro del Servidor de Ale, sustituyendo el Puente 3.0.0 del apartado anterior.

- **Código**: worktree separado `~/dev/relay-app-bridge-v3.1.0`, fijado en `9398a17` (rama `redesign`), con `npm ci` en `bridge/` y `supervisor/` y `npm run setup` en `supervisor/`. El worktree `~/dev/relay-app-bridge-v3.0.0` queda intacto para volver atrás. Tras el recorrido del APK se movió a `1196120` (`git checkout --detach` y `systemctl --user restart relay-bridge`, sin dependencias nuevas): modo de aprobación según el valor por defecto de Hermes, títulos sin la nota de archivo y nombre de dispositivo distinto del Servidor. El supervisor no cambió.
- **Orden**: `./relayd setup --supervisor --files --replace-service --restart`, antes con `--dry-run`. Las mismas opciones que 3.0.0: `metrics` no necesita ninguna y `chat_files` sale de `--files`. Sin `--web` ni `--restart-supervisor`. `setup` exige una terminal interactiva.
- **Supervisor**: no se reinició (mismo PID antes y después); sus terminales siguieron vivas. Su unidad ya apunta al worktree 3.1, y el código nuevo del supervisor corre desde su próximo arranque.
- **Estado**: con solo el Puente detenido se copiaron `.env`, `agent-modes.json`, `changes.jsonl`, `conversations.json`, `decisions.json`, `devices.json` y `kanban/` del `bridge/` de 3.0.0 al de 3.1, comprobados con `sha256sum -c`. Era todo el estado presente; los demás archivos que el código lee (`notifications.json`, `server-control.json`, `web-apps.json`) no existían.
- **Respaldo**: `~/.local/share/relay-backups/bridge-v3.1-deploy-20261006T162406Z/` (0700): `state/`, `systemd/` (unidades `relay-bridge` y `relay-supervisor` de 3.0.0, sin drop-ins) y `SHA256SUMS` (`cd` al respaldo y `sha256sum -c SHA256SUMS`). `~/.hermes` no se tocó.
- **Parada**: el Puente 3.0.0 no terminó con SIGTERM y systemd lo mató a los 90 s (`stop-sigterm timed out`). No afectó al estado, pero cuenta con esa espera al detenerlo.
- **Resultado**: `/health` anuncia `environments`, `terminal`, `files`, `browser`, `metrics` y `chat_files`. `GET /v1/metrics` sin clave responde 401 (la ruta existe y exige dispositivo); `test/metrics.test.ts` pasa. `relayd doctor` igual que con 3.0.0: `falta Web: Tailscale HTTPS/Services` y los `aviso` del navegador habitual. `relayd devices` lista los 7 dispositivos activos traídos en `devices.json`.
- **Emparejar**: `relayd pair` desde `~/dev/relay-app-bridge-v3.1.0/bridge`.

### Vuelta atrás a 3.0.0

Con `B=~/.local/share/relay-backups/bridge-v3.1-deploy-20261006T162406Z`:

1. `systemctl --user stop relay-bridge`. El supervisor sigue.
2. `cp $B/systemd/relay-bridge.service $B/systemd/relay-supervisor.service ~/.config/systemd/user/`.
3. Para conservar lo cambiado desde el despliegue, copia el estado de `~/dev/relay-app-bridge-v3.1.0/bridge` a `~/dev/relay-app-bridge-v3.0.0/bridge`; si no, el de 3.0.0 es el de antes del despliegue (igual que `$B/state`).
4. `systemctl --user daemon-reload && systemctl --user start relay-bridge`. `/health` debe responder sin `metrics` ni `chat_files`.

## Problemas frecuentes

| Síntoma | Qué hacer |
|---|---|
| `doctor`: PTY `falta` | Instala las herramientas que nombra y ejecuta `cd supervisor && npm run setup` |
| `setup --supervisor` pide node-pty compilado | Igual; `relayd doctor` dice qué falta |
| `La unidad existente … es diferente` | Revisa con `--dry-run` y añade `--replace-service` |
| `--browser-habitual necesita --supervisor` | Añade `--supervisor` |
| `doctor`: Supervisor «instalado pero detenido» | `systemctl --user start relay-supervisor` |
| `doctor`: Supervisor «activo pero sin socket» | `journalctl --user -u relay-supervisor` |
| `doctor`: Puente «RELAY_SUPERVISOR_DIR apunta a otro directorio» | `relayd setup --supervisor --replace-service --restart` con tus demás opciones |
| Una herramienta desapareció tras actualizar | La unidad se regeneró sin su opción: repite `setup` con todas |
| Terminales `lost` | El supervisor se reinició (o el Servidor): no se recuperan. Si aún tienen procesos, termínalas en Relay; si no, quítalas |
| `doctor`: «certificados HTTPS no habilitados» o «el anfitrión no tiene tag» | Pasos 1 y 2 de «Publicar una web» |
| `relayd pair`: «El Puente no está disponible» con el servicio activo | Ejecútalo desde el `bridge/` del checkout que corre el servicio (`WorkingDirectory` de la unidad) |
| `relayd web`: «sin publicar» tras publicar | La orden apuntó a otro puerto o el listener cambió de puerto: ejecuta la orden que muestra ahora. Si muestra `retirar antes`, el Service reenvía algo más: ejecuta primero esa orden y después la de publicar |
| `doctor` o `setup`: aviso de drop-ins en `relay-bridge.service.d` | Un `*.conf` cambia la unidad (por ejemplo, el `ExecStart` de una actualización de v2). Revísalo y retíralo si ya no corresponde antes de `setup --replace-service --restart`, que recarga las unidades |
| Una orden falta en la terminal pero existe en tu shell de inicio de sesión | Las terminales usan el entorno del gestor de usuario: ponla en `~/.bashrc` o en `~/.config/environment.d/` |
| El teléfono no abre el Service | Revisa acceso en la política y aprobación del anfitrión |
| La aplicación responde pero el HMR o los recursos fallan | URLs fijas a loopback o `Host` rechazado: «Servidores de desarrollo y HMR» |
| Tras reiniciar el Puente, el navegador pide acceso de nuevo | Esperado: las Autorizaciones web viven en memoria |
| `doctor`: Chromium «la extensión de Relay exige 154» | Usa Google Chrome |
| `doctor`: «Navegador dedicado: topes» falta | La delegación de `user@.service` no da `memory` o `pids` a `app.slice`; Relay no la cambia |
| Navegador habitual `helper_incompatible` tras actualizar | Recarga la extensión en `chrome://extensions` |
| `doctor`: Adaptador «no registrado» o «otra extensión» | `relayd browser <navegador>` |
