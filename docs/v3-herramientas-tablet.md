# Herramientas del Servidor en teléfono y tablet (V3)

Implementa el [esquema aprobado](planning/relay-v3-workspace-outline.md) en la app (issue #95).
Conserva Instrumento con los primitives y tokens existentes; la disposición de la ventana sigue
[Tablet en Relay v2](tablet-v2.md).

## Accesos y retorno

> Reemplazado por la [ADR 0007](adr/0007-navegacion-del-rediseno.md) en 3.1: Herram. es una pestaña
> que lee el Servidor elegido, y el retorno nombra el origen real («‹ dev» desde la tecla `>_`),
> sin `from=conversation`. Sigue valiendo que `ServerToolsHost` mantiene montadas las herramientas
> de cada Servidor abierto.

- Fuera de una Conversación: ficha del Servidor → «Herramientas» (`/tools/[server]`).
- Desde una Conversación: la tecla `>_` del encabezado del chat abre las herramientas de ese
  Servidor con `from=conversation`. «‹ Conversación» vuelve atrás en la pila: la Conversación
  sigue montada debajo, con su borrador y su transcripción, sin recargarse ni recibir nada.
- `ServerToolsHost`, junto a la pila de rutas en el layout raíz, mantiene montadas las
  herramientas de cada Servidor abierto. La ruta solo indica cuál se muestra. Al volver a la
  Conversación o a otro Servidor, y al regresar, siguen las terminales, la carpeta, el borrador y
  la página. Cada Servidor tiene su propia instancia; un Servidor que deja de estar emparejado la
  pierde.

## Paneles y teclado

> El marco de ventana de esta sección (navegación lateral de 3.0) queda reemplazado por la
> [ADR 0007](adr/0007-navegacion-del-rediseno.md): riel de 72/240 y Herramientas en todo el ancho,
> sin lista. Las reglas de los dos paneles y del foco de teclado siguen.

- Ventana de menos de 1000 dp útiles (teléfono, tablet vertical, ventana dividida, letra grande):
  una herramienta en todo el contenido.
- Desde 1000 dp útiles (tablet horizontal): «Un panel» o «Dos paneles». Las herramientas ocupan
  todo el ancho junto a la navegación lateral, sin la lista de Servidores ni el ancho de lectura de
  820 dp, para que cada panel tenga unos 390 dp o más (la barra de teclas de la terminal cabe).
  Cada herramienta vive en un solo panel; elegir en un panel la herramienta del otro las
  intercambia. Si la ventana se estrecha, queda el panel enfocado y la otra herramienta espera
  montada.
- El panel enfocado lleva borde naranja y «RECIBE EL TECLADO». Tocar cualquier punto de un panel
  le da el foco. Al cambiar de panel, herramienta, ruta o Servidor, o al bloquear, se suelta el
  campo que tenía el teclado. La terminal fuera del foco no acepta teclas ni pegado, y la página
  web fuera del foco suelta su campo.
- «Terminal aquí» y «Navegador del Servidor» abren la herramienta junto al panel que la pidió
  cuando hay dos paneles.
- Bloquear oculta todos los paneles y suspende su control. Revocar el dispositivo los retira
  todos.

## Navegador del Servidor

Los controles de páginas de #94 (`BrowserTool`) ocupan el lugar `browser` del espacio de trabajo,
como cualquier otra herramienta: se montan en su primera visita, siguen montados al cambiar de
panel o de herramienta y solo reciben el teclado en el panel enfocado. Con un Puente sin
navegador, el panel explica por qué no está disponible.

## Demostración

En `npm run demo` se ven con los Servidores y las herramientas demo existentes. Abre un chat y
pulsa `>_`, o abre la ficha del Servidor. En una ventana de tablet (`DEMO_TABLET_WINDOWS`), usa
«Dos paneles». No hace falta un Servidor.
