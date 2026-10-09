# node-pty con Node 26 en Linux (#76)

Validación aislada del candidato PTY para la terminal de V3. El laboratorio vive en
`labs/v3-pty/`, con manifiesto y lockfile propios; no añade dependencias a `bridge/` ni a
`mobile/` y no toca el Puente, Hermes, Tailscale ni ningún servicio. Fecha: 2026-10-05.

## Resultado por configuración

| Configuración | Resultado | Evidencia |
|---|---|---|
| Sin PTY: `child_process` con tuberías (control) | **FAIL** 8/8 + limpieza, como se esperaba | `npm run test:sin-pty` |
| node-pty 1.1.0 (`latest`), compilado en el equipo, Node 26.10.0 linux-x64 | **PASS** 8/8 | `npm test` |
| node-pty 1.2.0-beta.15 (`beta`), prebuild linux-x64, Node 26.10.0 | **PASS** 8/8 | `npm run test:beta` |
| node-pty 1.1.0 sin compilador C/C++ | **FAIL** en la instalación | ver «Toolchain» |
| node-pty 1.2.0-beta.15 sin compilador C/C++ | **PASS** en la instalación y el arranque de un proceso | ver «Toolchain» |
| El PTY sigue usable tras morir el proceso que lo abrió | **FAIL**: no sobrevive; motivo del supervisor separado | ver «Muerte del dueño» |
| linux-arm64, otras glibc, systemd | **NO PROBADO** | sin entorno en este laboratorio |

Cada versión candidata se ejecutó además tres veces seguidas: 8/8 en todas.

## Entorno exacto

| Componente | Versión |
|---|---|
| Node | v26.10.0 (mise, `~/.local/share/mise/installs/node/26.10.0`), ABI 147, N-API 10, V8 14.6.202.34 |
| npm / node-gyp | 11.19.1 / 12.4.0 (el que trae npm) |
| Sistema | Linux 7.2.5-3-omarchy x86_64, glibc 2.44, systemd 261, cgroup v2 |
| Toolchain | GCC/G++ 16.2.1, GNU Make 4.4.1, Python 3.14.7 |
| Programas de prueba | bash 5.3.15, tmux 3.7c |
| node-pty | 1.1.0 (`sha512-20JqtutY…`) y 1.2.0-beta.15 (`sha512-vORSzHXi…`) fijadas en `package-lock.json`; dependencia transitiva `node-addon-api` 7.1.1 |

## Instalación y toolchain

node-pty 1.1.0 publica prebuilds solo para darwin y win32. En Linux su script `install`
(`node scripts/prebuild.js || node-gyp rebuild`) compila `src/unix/pty.cc` en el equipo. La
1.2.0-beta.15 incluye `prebuilds/linux-x64` y `linux-arm64` y no compila. Ambas usan N-API, así que
no dependen del ABI concreto de Node.

```text
$ npm run setup      # = npm_config_nodedir=<prefijo del node en uso> npm ci --foreground-scripts
npm warn Unknown env config "nodedir". This will stop working in the next major version of npm. …
> node-pty@1.1.0 install
> Checking prebuilds...
> Rebuilding because directory …/node_modules/node-pty/prebuilds/linux-x64 does not exist
gyp info using node-gyp@12.4.0
gyp info using node@26.10.0 | linux | x64
gyp info find Python using Python version 3.14.7 found at "/usr/bin/python3"
  CXX(target) Release/obj.target/pty/src/unix/pty.o
  SOLINK_MODULE(target) Release/obj.target/pty.node
gyp info ok
> node-pty@1.2.0-beta.15 install
> Checking prebuilds...
added 3 packages in 4s
```

Binarios cargados, leídos de `/proc/self/maps`:

- 1.1.0: `node_modules/node-pty/build/Release/pty.node` (compilado aquí; exige `GLIBC_2.42`).
- 1.2.0-beta.15: `node_modules/node-pty-beta/prebuilds/linux-x64/pty.node` (exige `GLIBC_2.28`).

Requisitos para compilar la 1.1.0: compilador C/C++ (`cc`/`c++`), `make`, `python3` y las
cabeceras de Node. El laboratorio no instala nada global:

- `npm run setup` apunta `nodedir` al prefijo del `node` en uso, que ya trae `include/node`. Así
  node-gyp no descarga cabeceras ni escribe en `~/.cache/node-gyp`: su fecha de modificación
  quedó en 2026-09-29 antes y después de las instalaciones. Sin `nodedir`, node-gyp las
  descargaría a ese directorio global [INFERENCIA: comportamiento documentado de node-gyp, no
  ejecutado aquí].
- npm 11.19.1 avisa de que la variable `nodedir` dejará de leerse en su próxima versión mayor.
  Con npm 12 hará falta otra vía (por ejemplo `node-gyp --nodedir` explícito en el instalador).
- npm 11.19.1 advierte de scripts de instalación no aprobados. El manifiesto los aprueba
  explícitamente en `allowScripts` solo para las dos versiones fijadas de node-pty.

Sin compilador (copia temporal del laboratorio, `CC=/nonexistent/cc CXX=/nonexistent/c++ npm ci`):

```text
> Rebuilding because directory …/node_modules/node-pty/prebuilds/linux-x64 does not exist
FileNotFoundError: [Errno 2] No such file or directory: '/nonexistent/cc'
gyp ERR! stack Error: `gyp` failed with exit code: 1
npm error path /tmp/v3pty-nocc-l67T/node_modules/node-pty
npm error command failed
```

La beta sola, con el mismo entorno sin compilador, se instala (`> Checking prebuilds...`,
`added 2 packages`) y ejecuta `/bin/echo hola` por PTY (`DATA "hola\r\n"`, `EXIT 0`).

## Pruebas

`labs/v3-pty/test/pty.test.ts` ejecuta el mismo conjunto contra el modo elegido en
`PTY_BACKEND`: `node-pty` (por defecto), `node-pty-beta` o `pipe`, el control sin PTY. El programa
de prueba `src/probe.ts` hace de aplicación dentro de la terminal; `src/owner.ts` hace de
proceso dueño del PTY. Todos los procesos reciben un entorno mínimo (`PATH`, `TERM`,
`LANG=C.UTF-8` y `HOME` en un directorio temporal); bash arranca con `--norc --noprofile`.

| Prueba | Qué demuestra |
|---|---|
| Shell interactivo | `bash -i` ejecuta lo tecleado con Enter (`\r`), `tty` devuelve `/dev/pts/N`, `[ -t 0 ] && [ -t 1 ]` es cierto y `exit 7` llega como código 7. |
| isatty y tamaño | El programa ve `stdin`/`stdout` como TTY y el tamaño inicial pedido (91×27). |
| Pantalla completa | Pantalla alternativa (`ESC[?1049h`/`l`), modo raw, redibujo por SIGWINCH al cambiar a 120×40 y 41×13, salida con `q`. |
| UTF-8 dividido en la entrada | `añ€😀` enviado en cuatro escrituras cortadas a mitad de carácter llega byte a byte (`61c3b1e282acf09f9880`) en al menos cuatro lecturas y se decodifica entero. |
| UTF-8 dividido en la salida | Con `encoding: null` algún chunk termina a mitad de carácter (`isUtf8` falso) y la concatenación es `ñ€😀\r\n`; con la decodificación de node-pty el texto llega sin `U+FFFD`. |
| Salida normal | 20 000 líneas completas y en orden, `exit 5` llega como 5 y `SIGTERM` como señal 15. |
| tmux dentro | tmux con socket propio (`TMUX_TMPDIR` temporal, `-f /dev/null`) dibuja la aplicación a 80×23 y la redimensiona a 100×29 cuando la PTY pasa a 100×30. |
| Muerte del dueño | Ver la sección siguiente. |

### Primero en rojo: sin PTY

Se escribieron las pruebas y el control `pipe` antes de instalar node-pty. Salida real de
`npm run test:sin-pty` (extracto):

```text
✖ [pipe] shell interactivo: comandos, tty y código de salida (5019.590345ms)
  Error: timed out after 5000 ms: /\/dev\/pts\/\d+/ in ""
✖ [pipe] isatty y tamaño inicial que ve el programa (53.736504ms)
  +   stdin: false,
  +   stdout: false
  -   cols: 91,
  -   rows: 27,
  -   stdin: true,
  -   stdout: true
✖ [pipe] pantalla completa: resize con SIGWINCH y entrada UTF-8 dividida (5019.268977ms)
  Error: timed out after 5000 ms: /\x1b\[\?1049h/ in ""
✖ [pipe] salida UTF-8 dividida entre chunks (455.190966ms)
  + 'ñ€😀\n'
  - 'ñ€😀\r\n'
✖ [pipe] salida normal: volumen completo, códigos y señales (41.237885ms)
  0 !== 20000
✖ [pipe] tmux dentro de la terminal sigue el tamaño (10041.902077ms)
  Error: timed out after 10000 ms: /SIZE 80x23/ in ""
✖ [pipe] muere el proceso dueño del PTY (hold) (1308.741999ms)
  AssertionError [ERR_ASSERTION]: the PTY child dies with its owner
✖ [pipe] muere el proceso dueño del PTY (hold-nohup) (1305.712367ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^sighup$/m.
✖ …/labs/v3-pty/test/pty.test.ts
  AssertionError [ERR_ASSERTION]: every process the lab started is gone
ℹ tests 9
ℹ pass 0
ℹ fail 9
```

El último fallo es la comprobación de limpieza: sin PTY, el shell, la aplicación de pantalla
completa y el programa que ignora SIGHUP siguieron vivos; el hook los mató con SIGKILL y
falló igualmente para que la fuga no pase inadvertida.

### Después en verde

```text
$ npm test
✔ [node-pty] shell interactivo: comandos, tty y código de salida (58.111046ms)
✔ [node-pty] isatty y tamaño inicial que ve el programa (104.53735ms)
✔ [node-pty] pantalla completa: resize con SIGWINCH y entrada UTF-8 dividida (655.894316ms)
✔ [node-pty] salida UTF-8 dividida entre chunks (945.653455ms)
✔ [node-pty] salida normal: volumen completo, códigos y señales (92.201487ms)
✔ [node-pty] tmux dentro de la terminal sigue el tamaño (161.865959ms)
✔ [node-pty] muere el proceso dueño del PTY (hold) (1360.812237ms)
✔ [node-pty] muere el proceso dueño del PTY (hold-nohup) (1358.069845ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0

$ npm run test:beta
✔ [node-pty-beta] … (las mismas 8)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

## Muerte del proceso dueño del PTY

`src/owner.ts` abre la PTY y ejecuta dentro el programa de prueba en modo `hold`, que anota cada
100 ms un tick, SIGHUP y los errores de su `stdin`/`stdout`. La prueba espera tres ticks, mata
al dueño con SIGKILL (como una caída o un reinicio brusco del Puente si él tuviera las
terminales), espera 1 s y observa:

```text
✔ [node-pty] muere el proceso dueño del PTY (hold)
ℹ child 273942 alive=false; notes after owner death:
start 273942

✔ [node-pty] muere el proceso dueño del PTY (hold-nohup)
ℹ child 274433 alive=true; notes after owner death:
start 274433
stdin-end
sighup
stdout-error EIO      (×10, uno por tick)
```

- Al cerrarse el último descriptor del maestro, el kernel cuelga la terminal y envía SIGHUP a la
  sesión. Un programa con la disposición por defecto muere: así terminan shells, editores y
  cualquier trabajo que no se haya preparado para ello.
- Un programa que ignora SIGHUP sigue vivo, pero su terminal ya no existe: `stdin` da fin de
  fichero y cada escritura en `stdout` falla con EIO. Nadie más tiene el maestro, así que no hay
  forma de volver a leerlo, escribirle ni redimensionarlo. Es un huérfano, no una terminal
  recuperable; la prueba lo mata al terminar.

Conclusión: el maestro de cada PTY tiene que vivir en un proceso cuyo ciclo de vida no sea el
del Puente. Si el Puente abre las PTY con node-pty dentro de su propio proceso, cada reinicio o
caída del Puente cierra los maestros y termina o deja inservibles todas las terminales, y la
especificación exige recuperarlas «incluso tras reiniciar el Puente» (`docs/relay-v3.md` §3).

Hace falta un supervisor separado: un proceso propio que abre las PTY con node-pty, guarda los
maestros y el historial acotado, y atiende al Puente por un canal local (por ejemplo un socket
Unix con permisos de la cuenta). El Puente se conecta, reenvía entrada/salida/tamaño y puede
reiniciarse sin cerrar maestros.

Lo que este laboratorio **no** prueba y no debe darse por hecho:

- Que un supervisor así sobreviva al reinicio del Puente bajo systemd. Con `KillMode=control-group`
  (valor por defecto) parar una unidad mata todos los procesos de su cgroup; un supervisor
  lanzado por el Puente dentro de su unidad moriría con él [INFERENCIA: documentación de systemd,
  no ejecutado aquí]. El supervisor necesita su propia unidad o cgroup y una prueba real.
- Salida ordenada del dueño (SIGTERM, `process.exit`): solo se probó SIGKILL.
- Reinicio del Servidor: termina todo; la especificación ya lo trata como terminal no recuperable.

Esa prueba corresponde a «V3: conservar y terminar entornos propios por dispositivo» (#81).

## Limpieza y aislamiento

- Todo lo creado vive en un `mkdtemp` (`/tmp/relay-pty-*`) que el hook final borra; tmux usa
  ese directorio como `TMUX_TMPDIR` y se cierra con `tmux kill-server` sobre ese socket.
- El hook final comprueba que ningún PID arrancado por la prueba sigue vivo (los zombis cuentan
  como terminados) y falla si alguno quedó. Tras las ejecuciones verdes no quedaron directorios
  `relay-pty-*` ni procesos `probe.ts`.
- No se llamó a Hermes, al Puente (8642, 9119, 8650), a Tailscale ni a ningún servicio; no se
  leyeron perfiles, `~/.hermes`, `.env` ni archivos rc del usuario.
- `node_modules/` del laboratorio queda ignorado por git; el gate no entra en `labs/`.

## Para la implementación

- Las dos versiones pasan. La 1.1.0 es la estable pero exige toolchain en el Servidor y genera
  un binario atado a su glibc (2.42 aquí). La 1.2.0-beta.15 evita compilar (prebuild con glibc
  ≥ 2.28) pero es beta. Elegir en «V3: añadir contratos y capacidades remotas compatibles» (#80);
  el instalador debe comprobar compilador, `make`, `python3` y cabeceras si se elige la 1.1.0 y
  explicar su ausencia sin instalarlos.
- Alternativa acotada si node-pty dejara de instalarse o cargar en un Servidor: un helper
  mínimo propio que solo haga `openpty`/`forkpty`, `setsid`, `TIOCSCTTY`, `TIOCSWINSZ` y pase el
  maestro por `SCM_RIGHTS` al supervisor. No probado: queda como plan B, no como certificación.
- En modo raw de Node la salida conserva `OPOST`: `\r\n` escrito por el programa llega como
  `\r\r\n`. Es la disciplina de línea, no node-pty; el emulador del teléfono debe tolerarlo.

## Reproducir

```bash
cd labs/v3-pty
npm run setup          # instala las versiones fijadas; compila node-pty 1.1.0
npm run test:sin-pty   # control sin PTY: debe fallar
npm test               # node-pty 1.1.0
npm run test:beta      # node-pty 1.2.0-beta.15
```
