# Validación de xterm en Expo 57 y Android (#77)

Laboratorio aislado en `labs/v3-xterm/`, con manifiesto y versiones propias. No añade dependencias
a `bridge/` ni a `mobile/`. Datos sintéticos: una shell falsa sustituye al PTY y una llave de
dispositivo ficticia (`src/fixture.ts`) sustituye a la real. No se llamó a Hermes ni al Puente.

No había teléfono conectado. Todo lo de abajo se observó en el emulador del SDK de Android. Lo
que exige hardware real queda en «Pendiente en teléfono real».

## Resultado

Dos configuraciones del mismo APK, elegidas al abrirlo (`v3xterm://lab?config=…`):

- `baseline`: xterm tal cual, dentro de un componente DOM de Expo (`'use dom'`), con el control de
  flujo del laboratorio.
- `relay`: las adaptaciones para Android que este laboratorio propone (ver «Qué cambia `relay`»).

| Criterio | `baseline` | `relay` | Entorno |
|---|---|---|---|
| La llave no llega a la página por props, HTML ni heap, y la página no alcanza módulos nativos | PASS | PASS | teléfono y tablet |
| La página no lee el almacenamiento privado de la app (canario en `files/`) | ABIERTO: lo lee | ABIERTO: lo lee | teléfono |
| Gboard en español: letras, ñ, borrar, Enter, sin duplicados (3 intentos) | FAIL intermitente: 5 de 9 aquí, 9 de 12 en la revisión | PASS | teléfono |
| Gboard en español: `á` por pulsación larga y Retroceso sobre ella (3 intentos) | FAIL intermitente: DEL de más tras Enter en 4 de 6 | PASS (6 de 6) | teléfono |
| Composición de IME (`compositionstart/end`) con un IME real | NO COMPROBADA | NO COMPROBADA | ver límites |
| Teclado físico emulado: texto, Retroceso, Enter, Esc, Tab, flechas, Ctrl, Alt | FAIL | PASS | teléfono `hw.keyboard=yes` |
| Ctrl+V envía `^V`; Ctrl+Mayús+V pega varias líneas sin añadir Enter, con y sin bracketed paste | PASS | PASS | teléfono y tablet |
| Barra de teclas para el teclado virtual (Esc, Tab, Ctrl, Alt, flechas) sin cerrar el teclado | FAIL | PASS | teléfono y tablet |
| Pegar por toque (botón «Pegar») con el teclado abierto | FAIL | PASS | teléfono y tablet |
| Selección táctil de varias líneas y copia al portapapeles de Android | FAIL | PASS | teléfono y tablet |
| El teclado virtual reduce filas y el PTY recibe el tamaño nuevo | FAIL | PASS | teléfono y tablet |
| Rotación y pantalla completa: el terminal llena la ventana en ambas orientaciones | PASS | PASS | teléfono y tablet |
| Pantalla alternativa: un programa a pantalla completa dibuja todas las filas y la shell vuelve | PASS | PASS | teléfono y tablet |
| Salida sostenida: 100 000 líneas íntegras, cola nativa y scrollback acotados | PASS | PASS | teléfono y tablet |
| Ctrl-C bajo un flujo infinito: eco en pantalla en menos de 1 s | PASS | INESTABLE: 1 FAIL de 10 | teléfono y tablet |

Ctrl-C, medido dentro de la página, en `relay`: 264, 276, 552, 397, 307, 376, 407, 307 y 292 ms;
una ejecución, con carga del anfitrión de 63, dio 1284 ms. En `baseline`: 295, 305, 462, 485,
349, 599, 247 y 360 ms. Las dos configuraciones comparten ese camino (salida, cola y `onData`);
la intercalación de tres pares no mostró diferencia sistemática. Queda como inestable en
emulador bajo carga, no como superado.

## Versiones exactas

| Pieza | Versión |
|---|---|
| Expo | 57.0.26 (`@expo/dom-webview` 57.0.1, `@expo/metro-runtime` 57.0.16) |
| React Native / React | 0.86.3 / 19.2.3 (`react-dom` 19.2.3, `react-native-web` 0.21.3) |
| xterm | `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 |
| Portapapeles nativo | `expo-clipboard` 57.0.2 |
| Archivos (solo el canario) | `expo-file-system` 57.0.7, ya presente como dependencia de `expo`; fijado en el laboratorio para importarlo |
| Android | 16 (API 36), imagen `google_apis_playstore` x86_64 r07, build `BE2A.250530.026.D1` |
| WebView del sistema | `com.google.android.webview` 133.0.6943.137 (Chrome/133) |
| IME | Gboard 15.1.08.726012951-preload-x86_64, idioma del sistema `es-ES`, disposición «ES • EN» |
| Emulador | 37.2.12.0 (build 16428233), KVM, `-gpu swiftshader_indirect`, sin ventana |
| Teléfono emulado | AVD `pixel_7`, 1080×2400, 420 dpi |
| Tablet emulada | AVD `pixel_tablet`, 2560×1600, 320 dpi |
| Herramientas | Node 26.10.0, JDK Temurin 17.0.20, Gradle 9.3.1, APK release solo `x86_64` |

Todas las dependencias del laboratorio están fijadas sin rango en `labs/v3-xterm/package.json`
con su `package-lock.json`.

## El laboratorio

- `App.tsx` (nativo): guarda la llave y la usa en `toPuente()`, un sustituto de la petición
  autenticada al Puente. Expone al componente DOM solo acciones nativas: `sendInput`, `resize`,
  `pullOutput`, `copy` y `paste`. Registra en logcat (`LAB …`) los bytes recibidos para que la
  suite compruebe qué cruzó el límite. Esto es solo del laboratorio: Relay no debe registrar
  entrada ni salida de terminal. Al arrancar escribe un canario en texto plano,
  `files/relay-lab-canary.txt` (`Paths.document`), en lugar de un secreto guardado fuera de
  `SecureStore`.
- `src/Terminal.tsx` (`'use dom'`): xterm, ajuste de tamaño y, en `relay`, las adaptaciones.
- `src/shell.ts`: shell falsa con eco, disciplina de línea, `flood N`, `size`, `alt`/`noalt` y
  `bpon`/`bpoff`; `OutputQueue`, la cola acotada.
- `test/android.test.ts` y `test/device.ts`: la suite. Maneja la app por ADB (toques, gestos,
  rotación, teclas) y lee la WebView por el protocolo DevTools. Sale si el dispositivo indicado
  en `ANDROID_SERIAL` no está en estado `device`.

### Control de flujo

El componente DOM pide el siguiente bloque (`pullOutput`) solo cuando xterm terminó de procesar
el anterior (`term.write(chunk, callback)`). La salida espera en la cola nativa, que detiene al
productor a 256 KiB y entrega bloques de 32 KiB: el máximo observado fue 262 216 caracteres,
dentro del límite de 256 KiB + un bloque. El scrollback está fijado en 5000 líneas y la suite
comprueba `buffer.length ≤ filas + 5000`. La integridad se prueba con FNV-1a: el hash de todo lo
encolado en nativo coincide con el de todo lo escrito en xterm (7 300 064 caracteres).

Rendimiento observado del flujo de 100 000 líneas: de 11,3 s a 51,5 s según la carga del
anfitrión (otras sesiones compilaban a la vez; carga media de 15 a 63 en 32 núcleos). Con
SwiftShader y sin GPU no es una medida de un teléfono.

Antes se probaron colas menores, con la medición externa de Ctrl-C (ADB y logcat):
64 KiB/16 KiB dio 42,0 s para el flujo y 1057 ms para Ctrl-C; 32 KiB/8 KiB, 65,9 s y 1296 ms;
256 KiB/32 KiB, 49–52 s y 1665 ms en el mismo periodo. Medido dentro de la página, 256 KiB dio
264 y 276 ms: la mayor parte de aquel segundo era el propio ADB. Se conservó 256 KiB y la prueba
mide ahora dentro de la página.

## Qué cambia `relay`

1. **Entrada del IME propia.** Gboard marca cada tecla con `keyCode 229` y escribe en el
   `textarea` con eventos `input` (`insertText`). xterm 6.0.0 trata ese caso comparando el
   `textarea` en un `setTimeout(0)` y además duplica o pierde caracteres. `relay` intercepta en
   captura `keydown` 229, `input` y `composition*` del `textarea` antes que xterm, y envía la
   diferencia del `textarea` desde la última sincronización (DEL por lo borrado, más el texto
   nuevo). Nunca envía a mitad de una composición. Las teclas que xterm sí resuelve (Enter, teclas
   físicas) vacían el `textarea`. El pegado (`insertFrom*`) no se reenvía: xterm ya lo envió desde
   el evento `paste`.
2. **`autocomplete="off"`** en el `textarea`: sin tira de sugerencias ni autocorrección que
   reescriba palabras ya enviadas. Por sí sola no corrige los duplicados (ver evidencia).
3. **`KeyboardAvoidingView`** (`behavior="padding"`) alrededor de la WebView. En Android 16 la
   app se dibuja de borde a borde y la ventana no se reduce con el teclado: sin esto, ni
   `innerHeight` ni `visualViewport.height` cambian y las filas inferiores quedan bajo el teclado.
4. **Ajuste con `ResizeObserver`** sobre el contenedor, en lugar de `window.resize`.
5. **Barra de teclas**: Esc, Tab, Ctrl y Alt fijos (se aplican al siguiente carácter, venga del
   teclado virtual o del físico), flechas (respetan el modo de cursor de aplicación), «Selec.»,
   «Copiar» y «Pegar». `mousedown` con `preventDefault` conserva el foco y el teclado abierto.
6. **Selección táctil con modo «Selec.»**: mientras está activo, arrastrar selecciona por celdas,
   también entre líneas, sin desplazar la vista. «Copiar» usa `expo-clipboard` desde nativo y
   desactiva el modo. «Pegar» lee el portapapeles nativo y llama a `term.paste()`, que convierte
   `\n` en `\r`, respeta bracketed paste y no añade Enter.
7. **Ctrl+V** sigue enviando `^V` (lo hace xterm por sí mismo) y **Ctrl+Mayús+V** pega, como en
   los terminales de escritorio de Linux.
8. **El terminal sobrevive a los cambios de props.** Observado: con el efecto de xterm ligado a
   las acciones nativas, `LAB size` aparecía dos veces y la pantalla quedaba vacía aunque la
   cola nativa ya había entregado el prompt. Con las acciones en una referencia y el efecto sin
   dependencias, aparece una vez y con prompt. Inferencia: Expo reenvía los props, las acciones
   cambian de identidad y el prompt se escribía en un terminal ya desechado. Afecta también a
   `baseline`.

## Evidencia

### Tras la revisión: canario en `files/` y acentos

APK release `x86_64` con el canario (SHA-256
`be5ce68892d619da9f32f0642ed62c3b886cbb5fdc9119cdebbde2b18c95129b`), teléfono emulado, carga del
anfitrión de 3 a 5. Suite completa, `relay`, `LAB_GBOARD=1`:

```text
✔ boundary: the WebView never holds the device key nor reaches native modules (1323.022432ms)
files/ canary from the page: read: relay-lab-file-canary-8d41b6e2c07a9f35
✔ boundary: the page can read a plain file in the app's private files/ (open vector) (925.323886ms)
﹣ hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt (0.324229ms) # LAB_HW_KEYBOARD=1 not set
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 1) (4705.107784ms)
Gboard accent: line ["está"], bytes "está\x7fá\r"
✔ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 1) (6236.184887ms)
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 2) (3798.594839ms)
Gboard accent: line ["está"], bytes "está\x7fá\r"
✔ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 2) (11339.049395ms)
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 3) (4411.676196ms)
Gboard accent: line ["está"], bytes "está\x7fá\r"
✔ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 3) (6470.239416ms)
✔ soft keyboard: rows shrink to the visible area and the PTY follows (4107.192059ms)
✔ rotation and full screen: the terminal fills the window in both orientations (5226.609377ms)
✔ alternate screen: a full-screen program draws every row and the shell comes back (1320.319669ms)
flood: 7300064 chars in 11.4 s, native queue max 262216
✔ sustained output: 100 000 lines arrive intact with bounded queues and scrollback (12173.900639ms)
Ctrl-C: echo on screen 251 ms after the key
✔ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (6371.485603ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (5275.22944ms)
✔ touch: Pegar pastes the Android clipboard with the soft keyboard open (10929.799177ms)
✔ touch: Selec. drags a selection across lines and Copiar puts it on the clipboard (12762.973421ms)
✔ accessory keys for the soft keyboard: Esc, Tab, arrows, Ctrl and Alt keep the keyboard open (19967.988159ms)
ℹ pass 17
ℹ fail 0
ℹ skipped 1
```

Las mismas pruebas en `baseline`. Las demás fallaron y pasaron igual que en la primera entrega.
El emulador se cerró solo (código 1, sin causa en su registro) durante `Selec.`, así que
`Selec.` y la barra de teclas se repitieron tras reiniciarlo. Fallan porque falta la barra:
`[data-key="select"] is not on the page` y `[data-key="esc"] is not on the page`.

```text
files/ canary from the page: read: relay-lab-file-canary-8d41b6e2c07a9f35
✔ boundary: the page can read a plain file in the app's private files/ (open vector) (806.447999ms)
Gboard line: ["canion año"]
✖ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 1) (4549.875439ms)
Gboard accent: line ["está"], bytes "está\x7fá\r"
✔ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 1) (6227.087378ms)
Gboard line: ["cancion añ"]
✖ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 2) (4367.076742ms)
Gboard accent: line ["está"], bytes "está\x7fá\r\x7f"
✖ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 2) (6163.670098ms)
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 3) (4439.423492ms)
Gboard accent: line ["está"], bytes "está\x7fá\r\x7f"
✖ Gboard Spanish: long-press á and Backspace over it arrive once (attempt 3) (6138.286132ms)
```

En una ejecución anterior, solo de los acentos, `baseline` dio dos fallos y un acierto (otra vez
con un DEL tras Enter) y `relay`, tres aciertos. `á` llega en un solo `insertText`, también en
`baseline`. Lo que falla en `baseline` es un DEL de más después de Enter, que en una shell real
borraría un carácter de la línea siguiente. La línea queda bien (`está`), así que la prueba
compara los bytes exactos.

La página lee también fuera del canario. Sonda única desde la página con el mismo APK
(`XMLHttpRequest` síncrono y `fetch`):

```text
file:///data/data/dev.relay.lab.xterm/files/ | xhr: READ 326 chars | fetch: blocked TypeError
file:///data/data/dev.relay.lab.xterm/files/relay-lab-canary.txt | xhr: READ 38 chars | fetch: blocked TypeError
file:///data/data/dev.relay.lab.xterm/shared_prefs/ | xhr: READ 401 chars | fetch: blocked TypeError
file:///sdcard/ | xhr: READ 1297 chars | fetch: blocked TypeError
file:///data/data/com.android.chrome/ | xhr: blocked NetworkError | fetch: blocked TypeError
file:///system/build.prop | xhr: blocked NetworkError | fetch: blocked TypeError
```

### Ejecuciones de la primera entrega

APK release `x86_64` sin el canario (SHA-256
`2215733425fbb428a34335147c8f56ead93a6db7d855710c92cd683071f88a27`, reconstruido idéntico tras
las mutaciones). Las pruebas del canario y de `á` todavía no existían.

Teléfono sin teclado físico (`LAB_GBOARD=1`), `baseline`:

```text
✔ boundary: the WebView never holds the device key nor reaches native modules (1896.006344ms)
﹣ hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt (0.328497ms) # LAB_HW_KEYBOARD=1 not set
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 1) (14747.263809ms)
Gboard line: ["caiño"]
✖ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 2) (11976.504337ms)
Gboard line: ["cncion o"]
✖ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 3) (8107.472705ms)
✖ soft keyboard: rows shrink to the visible area and the PTY follows (19778.30513ms)
✔ rotation and full screen: the terminal fills the window in both orientations (7638.868458ms)
✔ alternate screen: a full-screen program draws every row and the shell comes back (2126.529989ms)
flood: 7300064 chars in 26.5 s, native queue max 262216
✔ sustained output: 100 000 lines arrive intact with bounded queues and scrollback (28243.240207ms)
Ctrl-C: echo on screen 462 ms after the key
✔ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (9038.675003ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (7512.84067ms)
✖ touch: Pegar pastes the Android clipboard with the soft keyboard open (7375.653416ms)
✖ touch: Selec. drags a selection across lines and Copiar puts it on the clipboard (4815.759018ms)
✖ accessory keys for the soft keyboard: Esc, Tab, arrows, Ctrl and Alt keep the keyboard open (5104.203784ms)
ℹ pass 7
ℹ fail 6
ℹ skipped 1
```

Teléfono sin teclado físico (`LAB_GBOARD=1`), `relay`:

```text
✔ boundary: the WebView never holds the device key nor reaches native modules (2407.899694ms)
﹣ hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt (0.775487ms) # LAB_HW_KEYBOARD=1 not set
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 1) (7211.957262ms)
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 2) (25807.710418ms)
Gboard line: ["cancion año"]
✔ Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt 3) (13771.409046ms)
✔ soft keyboard: rows shrink to the visible area and the PTY follows (11726.578711ms)
✔ rotation and full screen: the terminal fills the window in both orientations (11156.560816ms)
✔ alternate screen: a full-screen program draws every row and the shell comes back (3964.833156ms)
flood: 7300064 chars in 44.7 s, native queue max 262216
✔ sustained output: 100 000 lines arrive intact with bounded queues and scrollback (47632.653032ms)
Ctrl-C: echo on screen 1284 ms after the key
✖ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (22948.413247ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (11929.414492ms)
✔ touch: Pegar pastes the Android clipboard with the soft keyboard open (14502.090147ms)
✔ touch: Selec. drags a selection across lines and Copiar puts it on the clipboard (22544.634593ms)
✔ accessory keys for the soft keyboard: Esc, Tab, arrows, Ctrl and Alt keep the keyboard open (25261.587908ms)
ℹ pass 12
ℹ fail 1
ℹ skipped 1
```

La carga del anfitrión al empezar esa ejecución era 63,18. Repetición intercalada del Ctrl-C
justo después (configuración, carga, eco):

```text
baseline 62.59 echo on screen 599 ms
relay 55.64 echo on screen 307 ms
baseline 48.97 echo on screen 247 ms
relay 45.53 echo on screen 376 ms
baseline 45.24 echo on screen 360 ms
relay 40.49 echo on screen 407 ms
```

Tablet sin teclado físico (sin mapa de Gboard: esas pruebas se omiten), `relay`:

```text
✔ boundary: the WebView never holds the device key nor reaches native modules (1614.145108ms)
✔ soft keyboard: rows shrink to the visible area and the PTY follows (4555.715572ms)
✔ rotation and full screen: the terminal fills the window in both orientations (5662.972375ms)
✔ alternate screen: a full-screen program draws every row and the shell comes back (1529.758266ms)
flood: 7300064 chars in 11.4 s, native queue max 262216
✔ sustained output: 100 000 lines arrive intact with bounded queues and scrollback (12718.632286ms)
Ctrl-C: echo on screen 307 ms after the key
✔ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (6827.749674ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (5769.23585ms)
✔ touch: Pegar pastes the Android clipboard with the soft keyboard open (6652.686867ms)
✔ touch: Selec. drags a selection across lines and Copiar puts it on the clipboard (13375.842729ms)
✔ accessory keys for the soft keyboard: Esc, Tab, arrows, Ctrl and Alt keep the keyboard open (22418.23895ms)
ℹ pass 10
ℹ fail 0
ℹ skipped 4
```

En la tablet, `baseline` falló las mismas cuatro pruebas táctiles y de teclado (`soft keyboard`,
`Pegar`, `Selec.`, `accessory keys`) y pasó las otras seis.

Teléfono con teclado físico emulado (`hw.keyboard=yes`, `LAB_HW_KEYBOARD=1`):

```text
== LAB_CONFIG=baseline
✔ boundary: the WebView never holds the device key nor reaches native modules (5105.270733ms)
✖ hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt (17712.539922ms)
Ctrl-C: echo on screen 349 ms after the key
✔ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (7995.432505ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (5668.719019ms)
    actual: 'lsxsxx\x7F\r\x7F\x1B\t\x1B[A\x1B[B\x1B[C\x1B[D\x03\x1Bx',
    expected: 'lsx\x7F\r\x1B\t\x1B[A\x1B[B\x1B[C\x1B[D\x03\x1Bx',
== LAB_CONFIG=relay
✔ boundary: the WebView never holds the device key nor reaches native modules (7216.808266ms)
✔ hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt (5863.376149ms)
Ctrl-C: echo on screen 292 ms after the key
✔ Ctrl-C under an endless flood: its echo is on screen within 1 s of the key (11817.546558ms)
✔ hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter (5356.735801ms)
```

Inferencia: con teclado físico Gboard sigue activo (muestra su burbuja «ES») y recibe también
las teclas de texto; sería la causa de que `baseline` duplique también con teclado físico.

### Trazas que explican los fallos de `baseline`

Gboard, primer intento con la disposición inglesa, escribiendo `cancion ano⌫⌫ño⏎`:

```text
LAB in "can"
LAB in "an"
LAB in "n"
LAB in "c"
LAB in "io"
...
LAB line "cananncioon añoo"
```

Eventos del `textarea` al escribir `canc` con Gboard (y `autocomplete="off"` puesto a mano):
solo `keydown 229`, `beforeinput` e `input` con `insertText`, sin eventos de composición. Aun así
xterm envió `"can"`, `"an"` y `"n"`. Con `autocomplete="off"` y el xterm original, tres
repeticiones dieron `cancin año`, `canannciion ño` y `canciion añ`: el atributo no basta.

Con el teclado abierto en `baseline`: `{"ih":863,"vv":863.2380981445312,"rows":53}` con y sin
teclado (`mInputShown=true` y `false`).

### Mutaciones de «Fails silently»

Las tres primeras mutaciones se aplicaron, se registró el rojo, se restauró el código y se
comprobó el verde. El APK restaurado tiene el mismo SHA-256 que antes de las mutaciones.

1. `dom={{ …, unstable_useExpoModulesBridge: true }}` en `App.tsx`: la página pudo evaluar
   código en el runtime nativo.

   ```text
   ✖ boundary: the WebView never holds the device key nor reaches native modules (2289.180098ms)
     + '{"isPromise":false,"value":2}'
     - '{"isPromise":false,"value":null}'
   ```

2. La llave como prop del componente DOM (`deviceKey={LAB_DEVICE_KEY}`): la detectó
   `ReactNativeWebView.injectedObjectJson()` (`android.test.ts:130`).
3. Con la mutación 2 y sin las dos comprobaciones previas, la detectó por sí sola la búsqueda en
   la instantánea del heap:
   `AssertionError [ERR_ASSERTION]: device key found in the WebView heap`.

Restaurado: `✔ boundary: the WebView never holds the device key nor reaches native modules`.

4. Prueba del canario en `files/` (tras la revisión). Mutación en
   `node_modules/@expo/dom-webview/…/DomWebView.kt:199-200`: `allowFileAccess = false` y
   `allowFileAccessFromFileURLs = false`. Primer intento: la prueba siguió en verde porque el
   build usa el AAR precompilado (`[📦] expo-dom-webview` en `prebuild`) y no el código fuente.
   Con `"expo": { "autolinking": { "android": { "buildFromSource": ["expo-dom-webview"] } } }`
   en `package.json` el módulo se compiló desde fuente y la prueba falló:

   ```text
   files/ canary from the page: blocked: NetworkError
   ✖ boundary: the page can read a plain file in the app's private files/ (open vector) (1012.810269ms)
     - 'read: relay-lab-file-canary-8d41b6e2c07a9f35'
       actual: 'blocked: NetworkError',
   ```

   Con esa mutación, el resto de la suite `relay` (`LAB_GBOARD=1`) pasó: 16 pasan, 1 falla (el
   canario), 1 omitida. La página carga desde `file:///android_asset` sin acceso a archivos.
   Control: código fuente restaurado y todavía compilado desde fuente, el canario se lee
   (`✔`). Restaurado del todo, sin `buildFromSource`: el APK reconstruido tiene el mismo
   contenido que el de la ejecución con el canario (`diff -r` de los dos APK descomprimidos,
   vacío); el SHA-256 del archivo cambia.

### Prueba unitaria de la cola y la shell

`cd labs/v3-xterm && npm test`: 4 pruebas, 4 pasan (cola acotada a la marca más una línea,
Ctrl-C con la cola llena, Retroceso por punto de código, `size`).

## Consecuencias para Relay

- El límite DOM/nativo protege la llave solo si se respetan tres reglas:
  1. **Nunca** activar `unstable_useExpoModulesBridge`. El `@JavascriptInterface`
     `ExpoDomWebViewBridge` está siempre instalado en la página y solo lo protege esa opción.
  2. La llave nunca viaja como prop: los props se serializan en `injectedObjectJson()`, legible
     por cualquier script de la página.
  3. **Ningún secreto fuera de `SecureStore`.** `@expo/dom-webview` 57.0.1 fuerza
     `allowFileAccess` y `allowFileAccessFromFileURLs` (`DomWebView.kt:199-200`; ningún prop lo
     cambia) y sirve la página desde `file://`. Un script de la página lee con `XMLHttpRequest`
     el directorio privado de la app y `/sdcard` (`fetch` falla; `XMLHttpRequest` no). La llave y
     cualquier secreto van solo a `SecureStore`, nunca a archivos, AsyncStorage ni SQLite de la
     app. Lo que la app deja en `files/` o `cache/` también queda al alcance de la página.
     Inferencia, no comprobada: `SecureStore` guarda en `shared_prefs/` un valor cifrado con una
     llave del Keystore, así que la página leería solo el texto cifrado.

  La autenticación con el Puente vive en nativo; la página recibe bytes de terminal. Un script
  en la página solo existiría por un fallo del contenido (xterm no ejecuta la salida), pero #84
  diseña contra este límite y debe asumir su alcance real. Dos alternativas que #84 debe evaluar:
  - Cerrar el acceso en el propio módulo: con los dos ajustes en `false` la página sigue
    cargando desde `file:///android_asset` y toda la suite `relay` pasa (mutación 4). Cuidado:
    Expo usa por defecto el AAR precompilado de `@expo/dom-webview`. Un parche del código fuente
    no tiene efecto sin `expo.autolinking.android.buildFromSource: ["expo-dom-webview"]`
    (observado: el primer intento de la mutación compiló el AAR y la página siguió leyendo).
  - Una WebView propia (`react-native-webview`) con `allowFileAccess=false` y el HTML local por
    `loadDataWithBaseURL` o como asset.
- Relay no activa la depuración de la WebView ni registra entrada o salida del terminal. El
  laboratorio hace las dos cosas: `webviewDebuggingEnabled: true` en `App.tsx`, para que la suite
  lea la página por DevTools (con ella, cualquiera con ADB lee la página y su heap), y el registro
  `LAB …` en logcat de cada byte de entrada.
- xterm 6.0.0 sin adaptar no sirve con Gboard en la WebView de Android: hace falta el adaptador
  de entrada de `relay` o uno equivalente.
- La ventana no se reduce con el teclado en Android 16: la pantalla de terminal necesita
  `KeyboardAvoidingView` o un manejo explícito de insets.
- Un arrastre que empieza en el borde izquierdo lo toma el gesto «atrás» del sistema
  (`touchcancel` tras dos `touchmove`, desde `x = 4` px CSS). La columna 0 queda en esa zona sin
  margen lateral; #84 debe dejar margen o excluir esa franja del gesto.
- Pulsación larga más arrastre, lejos del borde, sí llega completa a la página (`touchstart`,
  `contextmenu` a los 500 ms, movimientos y `touchend`, sin `touchcancel`). No se construyó ni
  validó una selección por pulsación larga; el laboratorio usa el modo «Selec.».
- Con 256 KiB de cola nativa y bloques de 32 KiB, el eco de Ctrl-C bajo flujo infinito tardó
  0,25–0,6 s en emulador sin carga extrema. Los límites definitivos deben medirse en teléfono real.

## Límites de la evidencia

- **Composición de IME.** Gboard 15.1 en esta WebView nunca emitió `compositionstart`: ni con
  sugerencias activas (quitando `autocomplete`, `autocorrect` y `spellcheck`) ni con escritura
  deslizada. La palabra deslizada llega como un solo `insertText` (`"Hola"`). El camino de
  composición del adaptador no tiene evidencia con un IME real. `Input.imeSetComposition` de
  DevTools no sirve para probarlo en Android: la WebView cierra la composición cada dos
  actualizaciones, con Gboard y con el IME de voz, en ambas configuraciones (`cacanciocanció…`).
  Se retiró esa prueba.
- **Teclado físico.** El texto entró por el dispositivo evdev `qwerty2` del emulador
  (`adb emu event text`). Las teclas con nombre y los acordes se inyectaron como eventos de
  teclado del `InputManager` (`input keyboard keyevent/keycombination`), no por evdev:
  `adb emu event send` no llega a ningún dispositivo en el emulador 37.2 sin ventana. El mapa es
  `qwerty2` (EE. UU.): no hay distribución española, ni teclas muertas para acentos, ni tecla ñ.
- **Gboard.** Las posiciones de las teclas se midieron en una captura del perfil 1080×2400. En
  tablet no hay mapa, así que esas pruebas se omiten (`LAB_GBOARD`). De los acentos solo se probó
  `á` por pulsación larga (Gboard la resalta por defecto en el menú de `a`). No se probaron las
  otras vocales, `ü`, otras posiciones del menú ni la tecla de acento de otros teclados.
- **UTF-8 por el camino completo: NO COMPROBADO.** El flujo sostenido es ASCII y la cola nativa
  corta por unidades UTF-16 (`shell.ts:50`), así que la integridad FNV no ejercita un par
  sustituto ni una secuencia combinada partida entre dos bloques. La revisión observó, escribiendo
  directamente con `term.write` y no por la cola nativa, que xterm 6.0.0 une `'\ud83d'` +
  `'\ude00x'` (`😀x`) y `'e'` + `'\u0301n'` (`én`). El corte de bytes UTF-8 corresponde a #76 y #83.
- **Rendimiento.** SwiftShader sin GPU y un anfitrión cargado por otras sesiones. Las cifras de
  tiempo no son de un teléfono.
- **Arquitectura.** Solo se compiló `x86_64`. Para un teléfono hace falta
  `-PreactNativeArchitectures=arm64-v8a`.

## Estado de `mobile/` frente al acceso a archivos

Actualización de #84: el terminal es ya un componente DOM de `mobile/` y el acceso a archivos de
su WebView está cerrado (plugin `withDomWebViewFileAccess`, ADR 0006 «Lo que fijó #84»). En el
emulador, la página no lee `files/`, `shared_prefs/` ni `/sdcard`; sin el parche, sí. Lo que sigue
describe `mobile/` antes de #84.

Revisado en `mobile/` (sin `node_modules`) en esta rama:

- **Componentes DOM y WebView: ninguno.** No hay `'use dom'`, ni importaciones de
  `@expo/dom-webview` o de `react-native-webview`. `@expo/dom-webview` está instalado en
  `mobile/node_modules` como dependencia de `expo`, sin uso. La regla 3 todavía no tiene una
  página que la ponga a prueba; se aplicará cuando #84 añada el terminal.
- **Secretos: solo en `SecureStore`.** `src/state/storage.ts` (`load`, `save`, `loadServers`,
  `saveServers`) usa `expo-secure-store` en Android para todo lo que persiste, incluidos los
  Servidores con su llave de dispositivo. `localStorage` solo en web. No hay AsyncStorage, SQLite
  ni MMKV entre las dependencias.
- **Datos en claro en el almacenamiento privado: sí, sin secretos.** `src/screens/chat/chatImageNative.ts`
  copia las imágenes adjuntas y escribe sus recibos (`receipts-*.json`: identificadores de
  adjunto, mensaje y ejecución) en `documentDirectory/relay-images/`, es decir, en `files/`.
  `src/screens/chat/AssistantFiles.tsx` descarga los archivos de una Conversación en
  `Paths.cache/relay-files/…`. Ninguno guarda llaves ni códigos, pero es contenido de las
  Conversaciones: con una página DOM de Expo dentro de la app sería legible desde ella. Queda
  como problema adyacente para #84; no se cambia aquí.

## Pendiente en teléfono real

- IME español real: Gboard y, si es posible, Samsung Keyboard y SwiftKey; dictado por voz y
  cualquier IME que componga, para el camino `composition*` del adaptador.
- Teclado físico español por USB o Bluetooth: ñ, teclas muertas (´ ¨), AltGr, Esc, Ctrl/Alt
  con letras, y si la burbuja de Gboard interfiere.
- Tiempos de Ctrl-C y del flujo de 100 000 líneas con GPU real.
- Tablet física con teclado y orientación natural horizontal.
- Selección por pulsación larga, si #84 la prefiere al modo «Selec.».

## Cómo repetirlo

```sh
cd labs/v3-xterm
npm ci
npm test
export JAVA_HOME=<JDK 17> ANDROID_HOME=<SDK>
npm run build:android    # expo prebuild + assembleRelease, solo x86_64
adb -s <serie> install -r android/app/build/outputs/apk/release/app-release.apk
ANDROID_SERIAL=<serie> LAB_CONFIG=baseline LAB_GBOARD=1 npm run test:android
ANDROID_SERIAL=<serie> LAB_CONFIG=relay LAB_GBOARD=1 npm run test:android
# AVD con hw.keyboard=yes en config.ini:
ANDROID_SERIAL=<serie> LAB_CONFIG=relay LAB_HW_KEYBOARD=1 npm run test:android -- --test-name-pattern="hardware|Ctrl-C"
```

Preparación del emulador usada aquí: imagen
`system-images;android-36;google_apis_playstore;x86_64`, idioma del sistema Español (España)
como primero (Ajustes → Sistema → Idiomas), y para las pruebas de teclado físico
`settings put secure show_ime_with_hard_keyboard 1`. El `android/` generado por `prebuild` queda
ignorado. La suite comprueba antes de actuar que `ANDROID_SERIAL` está en estado `device`.
