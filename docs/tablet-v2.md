# Tablet en Relay v2

> Reemplazado en 3.1 por la [ADR 0007](adr/0007-navegacion-del-rediseno.md): un solo marco con riel
> de 72/240, lista redimensionable y detalle. Este documento queda como historia de 3.0.

La adaptación conserva Instrumento y las acciones de v1. Los lienzos de partida son
[22c·1, Agentes y chat](../design/captures/instrumento-2/22c-1.png) y
[22c·2, Servidores](../design/captures/instrumento-2/22c-2.png), con sus HTML en la misma carpeta.

## Disposición

La ventana decide la composición; no se identifica un modelo de dispositivo. El ancho útil
es el ancho nativo dividido por la escala de letra, con un mínimo de escala 1:

| Ancho útil | Disposición |
|---|---|
| Menos de 760 dp | Pantalla y navegación del teléfono. |
| Desde 760 dp | Navegación lateral de 120 dp; contenido centrado y acotado. |
| Desde 1000 dp | Lista de 340 dp junto al detalle de un Agente o Servidor; navegación bajo la lista. |

El contenido tiene un máximo de 820 dp y separación de 12 dp. En Agentes, Ajustes y
Aprobaciones generales se conserva una sola pantalla junto a la navegación lateral.
Chat y ficha reutilizan la lista real de Agentes. Tablero, administración, uso y tareas reutilizan
la lista real de Servidores. Emparejar permanece una pantalla independiente con sus acciones.
La navegación global conserva sus cuatro destinos; Servidores abre el Tablero existente.
Las rutas y los identificadores que reciben las pantallas no se transforman.

El Shell mantiene un solo árbol de rutas. Cambiar ancho, orientación o altura del teclado no
remonta su contenido ni sustituye su Conversación. Una ventana dividida estrecha recupera la
disposición del teléfono; una escala grande de letra reduce los paneles. La orientación del build
es `default`, sin un módulo nuevo ni bloqueo manual. Se usa
[useWindowDimensions de React Native](https://reactnative.dev/docs/usewindowdimensions) y la
[configuración de Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/config/app/).

## Entrada, accesibilidad y protección

Los nuevos destinos laterales conservan objetivos de 50 dp, nombre accesible, selección y aviso
accesible de Aprobaciones pendientes. La navegación lateral puede desplazarse en ventanas bajas.
No se requiere hover ni gesto exclusivo. Los controles nativos existentes siguen siendo el destino
del foco del teclado; no se añaden atajos que salten confirmación o huella. El editor y su envío
existentes conservan su comportamiento, incluidas sus guardas y el borrador.

LockGate envuelve ambos paneles y la navegación. Las hojas de Aprobación y bloqueo automático
permanecen globales; el fondo cubre la ventana completa y su lectura se limita a 620 dp cuando
hay espacio. Su contenido puede desplazarse dentro de la altura disponible, conservando las
acciones en horizontal y con texto grande. Las guardas de visibilidad, contexto y autenticación
posterior a await no cambian. La prueba del RootLayout monta la hoja real y comprueba que una
huella resuelta después de bloquear/desbloquear no transmite una Decisión.

Los insets se aplican una vez al Shell amplio. El estado sin conexión, la revocación y el scope de
las pantallas reutilizadas permanecen a cargo de AppProvider y de sus controles existentes.

## Demostración y diseño

`DEMO_TABLET_WINDOWS`, reexportado por `src/core/demo.ts`, documenta estas ventanas sintéticas:
390×844, 800×1200, 1200×800, 500×800 y 1200×800 con letra 1,6. En `npm run demo`, abrir una
ventana de esos tamaños y usar los Agentes/Servidores demo existentes; en la tablet horizontal,
abrir dev para tener lista y chat. Los estados de conexión y bloqueo demo actuales siguen disponibles.
No hace falta un Servidor ni datos adicionales.

Las composiciones complementarias están en `design/captures/tablet/` como HTML y PNG:
vertical con navegación lateral, horizontal con lista y chat, y Aprobación en ventana baja.
Son diseños Instrumento estáticos renderizados con Chromium y fuentes/imágenes locales;
no son capturas de una app Android ni evidencia de hardware. No se inicia un servicio para dibujarlos.

## Integración y validación pendiente

No se modifican Agents, Activity, Kanban ni Personality. Se comparten RootLayout, TabBar,
chrome, una reexportación de demo y el soporte nativo de pruebas: Root debe reconciliar esos
paths al integrar. Cuando se agreguen destinos globales de v2, su inventario debe actualizarse
tanto en el navegador de pestañas como en el Shell; esta rama no inventa rutas de otras entregas.

Las pruebas RNTL usan AppProvider, Shell, listas, chat, Tablero, hojas y LockGate reales;
solo simulan dimensiones, teclado, reloj, almacenamiento, transporte y navegación.
No prueban la geometría del renderer nativo. Quedan para Root/Ale la presentación y uso reales
en tablet: ambas orientaciones, ventana dividida, IME, teclado físico, foco/TalkBack y Back.
No se construyó APK, no se ejecutó el gate ni se accedió a Hermes o servicios reales.
