# Tema de Relay (K-1)

Relay ofrece Claro, Oscuro y Sistema en Ajustes → Apariencia. La instalación sin preferencia usa Claro, aunque el teléfono esté en oscuro. Sistema sigue los cambios de Appearance durante la sesión; una lectura nativa desconocida usa Claro. Oscuro sigue la columna OSCURO de K-1: fondo `#141413`, bloques `#1F1E1C`, teclas `#2A2927`, campos `#0F0F0E` y pantallas empotradas `#070707`. La referencia visual es `design/captures/rediseno/K-1.{png,html,txt}`.

La preferencia se guarda como literal JSON `"light"`, `"dark"` o `"system"` en `relay.theme.v1`, con el almacenamiento existente del teléfono. No modifica los ajustes de seguridad ni perfiles del Servidor. Una lectura inválida conserva Claro. Las escrituras se serializan por la clave de tema, incluso entre montajes del proveedor. Una lectura nueva espera las escrituras anteriores; una lectura inicial tardía no reemplaza una elección nueva. Si guardar falla, la selección sigue activa en memoria y Ajustes avisa que no sobrevivirá al cierre. El mensaje no expone la excepción del almacenamiento.

## Convención para integrar pantallas

`mobile/src/theme/tokens.ts` define `LIGHT_PALETTE` y `DARK_PALETTE` inmutables. No exporta una paleta global seleccionada. Cada pantalla, primitivo o hook que dibuja colores obtiene su paleta dentro de React:

```tsx
import { View } from 'react-native';
import { usePalette } from '@/theme/ThemeProvider';

export function ExampleScreen() {
  const { K } = usePalette();
  return <View style={{ backgroundColor: K.background, boxShadow: K.shadowBlock }} />;
}
```

Las familias tipográficas y tamaños independientes del tema siguen importándose de `tokens.ts`. Los helpers puros reciben los colores como parámetros; no llaman hooks. Los valores por defecto de props que dependen del tema se resuelven dentro del componente, después del hook. No calcular estilos con una paleta seleccionada en el ámbito del módulo, usar `Proxy`, modificar objetos globales ni almacenar el color durante un render anterior. React Compiler conserva los estilos según las dependencias de la paleta; no requiere una caché de estilos manual.

`K.onDanger` es texto sobre la tecla roja, con contraste ajustado en oscuro. `K.onAccent` es texto o icono sobre naranja, igual en los dos temas; `K.onInk` es texto sobre la superficie invertida `K.ink`. `K.onScreen`, `K.onScreenBright` y `K.onScreenLabel` son para pantallas empotradas, y `K.screenLine` es su regla. Las superficies de diff (`K.diffAdded`, `K.diffRemoved`) y de fallo (`K.dangerSurface`) tienen sus pares de contraste; los velos usan `K.sheetBackdrop` y las hojas `K.shadowSheet`. Los textos principales, secundarios, invertidos, de acento y de pantalla tienen prueba de contraste (`core/theme.test.ts`); en oscuro también se verifican los metadatos y diagnósticos sobre fondo, bloque y campo.

El proveedor permanece por encima de `ThemedApp` en la raíz. Sus hijos se dibujan desde el primer render, incluso mientras carga la preferencia. No usar `key={mode}`, ramas de componentes por tema ni envolver solo algunas rutas. `AppProvider`, navegación, chat y `LockGate` conservan sus identidades. Las hojas globales siguen dentro de `LockGate`; los contextos de visibilidad, scope y las comprobaciones posteriores a huella no cambian. Un cambio de tema no autoriza ninguna petición.

La paleta de Instrumento (`C`, `S`, `TG`) y sus componentes (`Panel`, `Block`, `Key`, `PrimaryKey`, `Chip`, `Toggle`, `Led`, `Caption`, `ConnectionStatus` viejo, `ServerRows`) se borraron al cerrar 3.1 (#115). Un color fijo, igual en los dos temas, se declara como constante con un comentario que lo dice.

## Sistema, demo y verificación

La app usa `useColorScheme` real, con suscripción nativa, y `userInterfaceStyle: automatic`. `expo-system-ui` ya formaba parte de las dependencias de la base. La preferencia explícita selecciona la paleta de Relay; no modifica el tema global del teléfono. La barra de estado usa iconos claros en oscuro y oscuros en claro. Los permisos y diálogos del sistema operativo siguen su configuración nativa.

Referencias oficiales: [Appearance de React Native](https://reactnative.dev/docs/appearance), [useColorScheme](https://reactnative.dev/docs/usecolorscheme), [temas en Expo](https://docs.expo.dev/develop/user-interface/color-themes/), [configuración Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/config/app/), [StatusBar SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/status-bar/), [React Compiler](https://react.dev/learn/react-compiler/introduction).

`DEMO_THEME_SCENARIOS` en `core/demo.ts` publica las tres opciones compartidas. En DEMO, Ajustes permite recorrer Claro, Oscuro y Sistema por los mismos gestos y proveedor de producción. Sistema se ve con el esquema real del dispositivo o navegador; no se simula un estado del sistema en producción. Los canvases nuevos `design/captures/theme-v2/{light,dark,system}.{html,png}` muestran los tres estados de selección; Sistema ilustra un dispositivo oscuro. Son diseños locales renderizados, no capturas de la app Android. Los avisos de error de almacenamiento se recorren en la sección Demostración de Ajustes mediante `DEMO_THEME_NOTICES`, sin provocar un fallo real. Sus diseños son `read-error` y `write-error`, también con HTML/PNG. Las pruebas provocan los fallos en el límite nativo sintético.

Las pruebas montan AppProvider y la raíz/LockGate reales; conservan un Turno SSE, borrador, Servidor seleccionado y Aprobación mientras cambia el tema. Cubren hoja global abierta, tablet, Herramientas con Modal y huella tardía, Actividad sin recarga, persistencia tras otro montaje, carreras de carga/escritura y cambios nativos. Solo se doblan límites compartidos de almacenamiento, Appearance, navegación y transporte. No hay validación física de tablet/Android ni gate/APK en esta entrega; Root realiza la integración y validación final.

## Tokens K-1 de Relay 3.1

Colores y sombras están en `usePalette().K`, con las mismas claves en claro y oscuro (el tipo `Palette` lo exige). Las escalas no dependen del tema y se importan de `tokens.ts`: `TYPE` (roles de texto como props `{ s, w, ls }` para `T` y `M`, por ejemplo `<T {...TYPE.title}>`), `RADIUS`, `ledGlow`, `textGlow`, `TEXT_GLOW` y `FRAME` (el marco de la demo web). El subtítulo usa Hanken Grotesk 800, que se carga con las demás fuentes. Ningún texto baja de 9,5 px (`TYPE.label`).

K-1 no define el panel de lista de tablet en oscuro. Es un hundido, como en claro, así que `K.listPane` oscuro usa el campo oscuro `#0F0F0E`.

`K.screen` es la pantalla empotrada de K-1 («Pantalla»): `#161615` en claro y `#070707` en oscuro, con una sola clave.

Decisiones para oscuro:

- Los textos de color sobre bloque o fondo usan los valores de K-1 para dentro de pantalla, porque las superficies oscuras se leen como una pantalla: `accentText` `#F29A1A`, `okText` `#6FD08C` y `dangerText` `#FF6A55`.
- Las sombras `shadowBlock`, `shadowKey`, `shadowKeyPressed`, `shadowField` y `shadowListPane` tienen valores oscuros propios: brillo superior oscuro (`#363530` o `#3A3936`) en lugar de `#fff` y alfa 0,5. `shadowPrimary`, `shadowScreen` y `shadowAccentRim` son iguales en los dos temas.

## Maquinaria y luz de Relay 3.1

Las piezas de S-15 están en `mobile/src/ui/machinery.tsx` y se animan en el hilo nativo con reanimated. La muestra, solo en la demo, está en `/machinery-preview` (Ajustes → Demostración → «Ver maquinaria y luz»).

- `Lights tone="orange" | "red"`: foquitos, 13 lentes con la luz naciendo en el centro (3,2 s).
- `Sweep tone`: barrido de 1,6 s naranja o 1 s rojo. Uno principal por pantalla, dentro de un `RecessedScreen`.
- `VoiceBox onScreen?`: caja de voz; se lee como «Escribiendo». Su ventana es `K.screen` sobre bloque o fondo (F-1) y `#0C0C0B` dentro de una pantalla empotrada (`onScreen`, S-15).
- `Needle reading={GaugeReading} live? data?`: aguja de 112×80 sobre el arco de 100°. Va al valor nuevo en 400 ms ease-out; con `live` oscila ±2° cada 6 s. Naranja y roja en su zona roja; con `data` (CPU, MEM y DISCO de la ficha, F-4) es clara y se vuelve naranja en la zona alta.
- `Screws`: cuatro tornillos para un bloque de mando de radio 20; el bloque los posiciona. `#D6D3CC` en claro; en oscuro, `#3A3936`, el LED apagado oscuro de K-1.
- `EngravedRule onScreen?`: regla grabada, `K.ledOff` sobre bloque y `#3A3936` dentro de una pantalla. Una por pantalla.
- `Odometer value="6D04:12"`: cada cifra en su celda rueda hacia arriba en 280 ms; el resto va sin celda.
- `HoldKey accessibilityLabel onComplete stepped?`: tecla que se mantiene con su tira de 6 LEDs. Mantener 1 s llama a `onComplete` una sola vez; soltar antes vacía la tira en 150 ms y no llama. `stepped` rellena en pasos de 50 ms / 5 % (Pausa general).
- `RecessedScreen rim? radius?`: pantalla empotrada con scanlines y, con `rim`, borde luminoso.

La escala de la aguja y qué enciende cada pieza son lógica pura en `mobile/src/core/machinery.ts`: `gaugeReading(value, { max, redFrom })`, `activityGauge(stepSeconds | null)` (0–60 s, roja desde 45 s, en 0 sin paso), `agentLight({ turnRunning, awaitingDecision })` y `serverLight(agents)`, que devuelven `'off' | 'orange' | 'red'`; la roja gana.

### Política de movimiento

`useMotion()` (`mobile/src/state/motion.ts`) dice si una pieza continua puede moverse: su ruta está delante, la app es visible (la visibilidad de `LockGate`, que ya sigue a `AppState`), la ventana tiene el foco (`addWindowFocusListener`) y «reducir movimiento» está apagado (`AccessibilityInfo`, leído y escuchado). Todas las piezas comparten una sola suscripción, abierta solo mientras alguna escucha. Si no puede moverse, cada pieza queda en reposo: barrido centrado, caja de voz a media altura, foquitos encendidos y agujas fijas en su valor. `StillMotion` fuerza ese reposo a sus hijos; lo usa la muestra.

Las piezas repetidas comparten un reloj por periodo: muchas filas de foquitos mueven una sola animación, y el retraso de cada lente se aplica sobre ese reloj.

React Compiler 1.0 traduce mal `x.n++ === 0` (lo trata como `++x.n`). En código compilado, los contadores se actualizan en una sentencia aparte.

### Pruebas

reanimated y gesture-handler son límites nativos. En Jest corren sus propios dobles: reanimated, su implementación JS sobre el reloj simulado (`tests/support/resolver.cjs` salta los archivos `.native` de worklets), y gesture-handler, su `jestSetup`. `tests/support/motion.ts` lee el estilo animado actual (`animatedStyle`, `animatedViews`); `tests/support/gestures.ts` arrastra por pasos (`drag`), arrastra sin soltar para mirar la pantalla a mitad del gesto (`hold`, que devuelve `move()` para seguir y `release()` para soltar) y mantiene pulsado (`longPress`) un gesto marcado con `.withTestId`. Un estilo animado se lee después de avanzar un cuadro (`jest.advanceTimersByTime(16)`). `emitReduceMotion` en `tests/support/native.ts` cambia «reducir movimiento». La app monta `GestureHandlerRootView` una vez, en la raíz.

## Componentes base de Relay 3.1

Están en `mobile/src/ui/`. La muestra está en la misma ruta de demo, `/machinery-preview`, debajo de la maquinaria; `/machinery-preview?sheet=1` abre con la hoja TAILNET arriba. Todos los toques son botones con zona tocable de al menos 48, y las filas se parten por palabras en vez de cortar texto cuando la letra del sistema crece.

- `@/ui/headers`
  - `RootHeader title right?`: encabezado A. A la derecha van `TailnetPill led open? onPress` (con `open`, el anillo naranja mientras su hoja está arriba), `ServerSwitch name led onPress` (selector de Servidor) e `IconKey`.
  - `DetailHeader back onBack right? identity? title? subtitle?`: encabezado B. `back` es el nombre del padre, que da la navegación; el retorno se ve «‹ <padre>» y se anuncia «Volver a <padre>». `identity` es `{ name, line, state: 'on' | 'busy' | 'err' | 'off', avatar? }`.
  - `ToolHeader back onBack server led?`: el retorno y el chip «SERVIDOR · <NOMBRE>».
- `@/ui/kit`
  - `Keycap label onPress variant? disabled? accessibilityLabel? style?`: tecla. Variantes `normal`, `primary`, `dark` (invertida), `danger`, `link` (como «Reintentar») y `screen` (dentro de una pantalla empotrada). Baja 1 px y cambia a la sombra pulsada en 80 ms.
  - `IconKey glyph accessibilityLabel onPress round?`: `+`, `⋯`, `>_`. Redonda de 48, o de 40×40 con margen tocable hasta 48.
  - `BackLink to onPress`, `Lamp tone size? onScreen?` (LED), `LedTrio state` (ON/BSY/ERR), `Plate label` (plaquita: `#1A1A19` en claro y `K.key` en oscuro, para que se lea sobre el bloque).
  - `ListBlock` con `ListRow plate? title meta? description? value? valueTone? chevron? onPress? disabled?` (fila de bloque, regla de 1 px entre filas) y `SectionHeader title action?`.
  - `Segmented options value onChange`.
- `@/ui/states`: una sola anatomía, título mono, frase y una acción. `StateSpec` impone los textos: `{ kind: 'loading', what }` da «CARGANDO <WHAT>…»; `{ kind: 'error', verb, onRetry }` da «ERROR», «No se pudo <verb>. Reintenta.» y «Reintentar»; `{ kind: 'unreachable', todo?, phrase, onRetry }` da «SIN RESPUESTA · <todo>» (por omisión «REVISA TAILNET»); `{ kind: 'unavailable', title?, phrase }` da «NO DISPONIBLE · ACTUALIZA EL PUENTE», salvo que la causa no sea el Puente y `title` la diga («MÓDULO APK NO DISPONIBLE»). También hay `empty` (título propio), un `error` con nombre propio («CÓDIGO CADUCADO»), `noControl` y `noAccess`. Todo reintento se pasa como `onRetry`, así que su tecla siempre dice «Reintentar»; las demás acciones solo pueden decir lo que nombra la lámina D-ES: «Escanear código», «Agregar Servidor», «Emparejar de nuevo» y «Volver a entrar con huella».
  - `SubjectStateBlock spec`: el bloque grande, solo para un estado del sujeto de la pantalla (un Tablero sin Tarjetas, la ficha de un Servidor). Regla de alcance: un Servidor SIN RESPUESTA es el sujeto solo en su ficha y en la hoja TAILNET; en el resto, su estado es una `StateRow`.
  - `StateRow name kind label? onRetry? action? rows?`: la fila compacta, para el resto. Sola dice «<SERVIDOR> · <ESTADO>» (D-02), o la causa diagnosticada con `label`; con `rows` encabeza el grupo del Servidor y atenúa sus filas (F-1). `action` y `onRetry` pueden ir juntas («Emparejar de nuevo» y «Reintentar»).
- `@/ui/ConnectionStatus` y `@/ui/ServerConnectionStatus`: el estado de conexión de un Servidor con esas dos piezas. Por omisión es la `StateRow` con la causa; con `subject` (solo la ficha del Servidor) es el `SubjectStateBlock` con la causa, su explicación, «Reintentar» y, si la causa es Tailscale, «Abrir Tailscale» debajo.
- Textos: `mobile/src/core/stateCopy.test.ts` recorre cada texto de `mobile/src`, `protocol/` y `bridge/src` (salvo `cli.ts` y `setup.ts`, salida para quien opera el Puente) y falla si un «No se pudo…» o «No se pudieron…» no sigue «No se pudo <verbo>. Reintenta.», si un reintento no se llama «Reintentar» («vuelve a intentar», «inténtalo de nuevo»), si hay un «Volver» a secas o si una carga («Cargando», «Comprobando», «Descargando»…, lista en el propio test) no acaba en «…». Los gerundios de estado (TRABAJANDO, Escribiendo, DICTANDO) no son cargas. Cuando reintentar no es el consejo correcto (un resultado sin confirmar, una imagen que hay que cambiar), la frase se escribe sin «No se pudo»: «La Decisión quedó sin confirmar.».
- `@/ui/sheet`
  - `Sheet visible onClose title subtitle? aside? action?`: hoja con asa, velo de .55 que se aclara al bajar y `.3s cubic-bezier(.2,1,.3,1)`. Arrastrar el asa más de 110 px, tocar el velo o el atrás de Android llaman a `onClose`, que debe poner `visible` en falso; la hoja sale desde donde está. Es un `Modal` nativo, una ventana propia que `LockGate` no oculta: mientras Relay está bloqueado o no se ve (`useChatVisible()`), la hoja no está; el padre conserva `visible` y vuelve al desbloquear.
  - `Toast message onHide bottom?`: entra en `.22s cubic-bezier(.2,.9,.3,1.2)` y a los 2 s llama a `onHide`. Se monta con `key` para repetir el mismo texto.
- `@/ui/gestures`
  - `PullToRefresh onRefresh style? contentContainerStyle?`: es el `ScrollView` de la pantalla. Resistencia ×0,5 hasta 96 px; desde 60 px de recorrido, ya con la resistencia, dice «SUELTA PARA RECARGAR». Al soltar llama a `onRefresh` y el LED naranja parpadea (ciclo de 1 s) hasta que su promesa termina; `onRefresh` muestra sus propios errores y no rechaza.
  - `SwipeRow swipeRight? swipeLeft? testID?`: cada lado es `{ label, onAction }`. Desde 90 px llama a la acción y vuelve con muelle `.32s cubic-bezier(.2,1.3,.4,1)`; un lado sin acción no se mueve. La fila nunca actúa por sí misma. Con varias filas, cada una lleva su `testID`.
