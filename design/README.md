# Diseño de Relay

El diseño vive en Claude Design (proyecto `a6d09fdb-95ea-4aed-9606-c9cf8e340312`). Esta carpeta trae
una copia al repo para que quien construya vea cada pantalla sin entrar ahí.

Donde el diseño y la especificación ([`docs/relay-v1.md`](../docs/relay-v1.md)) no coincidan, manda
la especificación. Los lienzos rotulados "DESPUÉS DE V1" no se construyen.

## Qué hay

| Carpeta | Contenido |
|---|---|
| `source/` | Los archivos tal como salen de Claude Design, sin el script que el servicio inyecta al servirlos: `relay-instrumento.dc.html` (pantallas 01 a 06), `relay-instrumento-2.dc.html` (lienzos 07 a 23), y `support.js` e `image-slot.js`, que los dos necesitan para dibujarse. |
| `captures/instrumento/`, `captures/instrumento-2/` | Por cada lienzo, una imagen (`<lienzo>.png`) y su HTML ya dibujado (`<lienzo>.html`), con los estilos en línea: colores, tamaños y textos exactos. `index.json` lista todos. El punto medio de la etiqueta se escribe como guion: el lienzo 23·1 es `23-1.png`. |
| `source/relay-rediseno.dc.html`, `source/rediseno-handoff.md` | El lienzo «Relay - Rediseño» (3.1) y el resumen de su handoff, tal cual. |
| `captures/rediseno/` | Por cada pantalla del rediseño, `<ID>.png`, `<ID>.html` y `<ID>.txt`: sus valores en texto (una línea por elemento con texto o caja visible: fuente, color, posición `@x,y ancho×alto` relativa a la pantalla, fondo, radio, sombra, borde, animación), seguidos del pie del lienzo y de sus notas `CAMBIO` y `A VALIDAR`. Los colores van en hexadecimal, con la alfa como `#RRGGBB/0.5`. |
| `tools/capture.mjs` | Regenera las capturas con Chromium sin interfaz. No tiene dependencias. Con `--select tools/rediseno.js` elige las pantallas del rediseño, que no tiene `data-screen-label`, y escribe además los `.txt`. |
| `tools/shoot.mjs` | Fotografía la demo web de la app en teléfono y tablet, en claro y oscuro, para compararla con los lienzos. No tiene dependencias. |
| `reference/`, `app/` | Capturas del prototipo original y de la app construida sobre él. |
| `claude-design-prompts.md` | Los prompts con los que se pidieron las pantallas. |

Copia tomada el 2026-10-02, después de la tercera ronda de correcciones.

Desde Relay 3.1 la app sigue solo el rediseño: `captures/rediseno/` manda, y `K-1` es la fuente de los tokens de `mobile/src/theme/tokens.ts` (ver `docs/mobile-theme.md`). Los lienzos de Instrumento (`captures/instrumento/`, `captures/instrumento-2/`) quedan como historia; sus colores y componentes ya no existen en el código.

## Regenerar

```bash
node design/tools/capture.mjs design/source/relay-instrumento-2.dc.html design/captures/instrumento-2
node design/tools/capture.mjs design/source/relay-instrumento.dc.html design/captures/instrumento
node design/tools/capture.mjs --select design/tools/rediseno.js design/source/relay-rediseno.dc.html design/captures/rediseno
```

El tercer argumento, opcional, es una expresión regular sobre la etiqueta (`'^23·'` para una sección).
Hace falta red: las fuentes y la librería que dibuja las plantillas se cargan de internet.
En `captures/rediseno/` las animaciones se congelan en su inicio para que `.txt`, `.html` e `index.json`
salgan iguales en cada pasada; los `.png` pueden variar algún píxel en los brillos.

## Fotografiar la demo

Con la demo web en marcha (`cd mobile && npm run demo`, o una exportación servida):

```bash
node design/tools/shoot.mjs http://localhost:8081 /tmp/relay-demo
```

Recorre las 24 rutas de la demo (las 23 pantallas y la muestra de maquinaria, `/machinery-preview`) en
teléfono (390×844 a escala 3) y tablet (1280×800 a escala 2) y deja
`claro/<tamaño>-<ruta>.png` y `oscuro/<tamaño>-<ruta>.png`: 48 capturas por tema. El tercer argumento,
opcional, `claro` u `oscuro`, fotografía solo ese tema. Antes de navegar escribe la preferencia de tema
en `localStorage` (`relay.theme.v1`). Espera a que el primer bundle cargue y a que cada página tenga
texto. Si la captura sale casi uniforme, recarga la ruta y repite hasta tres veces; si sigue en blanco,
se detiene con `página en blanco: <ruta>`. Los errores de la página y de la consola salen por la salida
de error. Usa `chromium` del `PATH`, o el de la variable `CHROMIUM`; si no arranca, lo dice y sale con error.

## Lienzos

### Rediseño 3.1 (`captures/rediseno/`)

Este lienzo reemplaza a los anteriores donde los contradiga, y dentro del lienzo manda lo que aparece
antes (R-1, luego S-15…). El `A VALIDAR` de `D-23` queda resuelto por la especificación
([`docs/relay-v3.1.md`](../docs/relay-v3.1.md)): ops vive en homelab, también en el widget.

| ID | Título | Archivos |
|---|---|---|
| F-1 | Agentes | `F-1.png`, `F-1.html`, `F-1.txt` |
| F-2 | Conversación · Turno en curso | `F-2.png`, `F-2.html`, `F-2.txt` |
| F-3 | Aprobación | `F-3.png`, `F-3.html`, `F-3.txt` |
| F-4 | Servidor · atlas | `F-4.png`, `F-4.html`, `F-4.txt` |
| F-5 | Herramientas · Terminal | `F-5.png`, `F-5.html`, `F-5.txt` |
| F-6 | Tareas · atlas | `F-6.png`, `F-6.html`, `F-6.txt` |
| T-1 | Tablet · Agentes + Conversación | `T-1.png`, `T-1.html`, `T-1.txt` |
| T-2 | Tablet · Servidor | `T-2.png`, `T-2.html`, `T-2.txt` |
| D-0-barra | Barra de pestañas: en reposo con 1 Aprobación fuera de la vista, y desplazada con Servidores activa | `D-0-barra.png`, `D-0-barra.html`, `D-0-barra.txt` |
| D-0-riel | Tablet: riel 72 y menú 240 | `D-0-riel.png`, `D-0-riel.html`, `D-0-riel.txt` |
| D-0-3 | Hoja TAILNET | `D-0-3.png`, `D-0-3.html`, `D-0-3.txt` |
| D-09 | Conversación · research | `D-09.png`, `D-09.html`, `D-09.txt` |
| D-10 | Ficha del Agente | `D-10.png`, `D-10.html`, `D-10.txt` |
| D-11_D-12 | Memoria y Personalidad · sin respuesta | `D-11_D-12.png`, `D-11_D-12.html`, `D-11_D-12.txt` |
| D-13_D-14 | Herramientas y skills del Agente | `D-13_D-14.png`, `D-13_D-14.html`, `D-13_D-14.txt` |
| D-22 | Compartir a un Agente · hoja | `D-22.png`, `D-22.html`, `D-22.txt` |
| D-21 | Herram. · pon tu huella | `D-21.png`, `D-21.html`, `D-21.txt` |
| D-03 | Tablero · atlas | `D-03.png`, `D-03.html`, `D-03.txt` |
| D-17 | Trabajo · atlas | `D-17.png`, `D-17.html`, `D-17.txt` |
| D-02 | Aprobaciones | `D-02.png`, `D-02.html`, `D-02.txt` |
| D-06 | Servidores · lista | `D-06.png`, `D-06.html`, `D-06.txt` |
| D-05 | Agregar Servidor · modo | `D-05.png`, `D-05.html`, `D-05.txt` |
| D-16 | Uso y costo | `D-16.png`, `D-16.html`, `D-16.txt` |
| D-18 | Presets de personalidad | `D-18.png`, `D-18.html`, `D-18.txt` |
| D-20 | Actualización APK | `D-20.png`, `D-20.html`, `D-20.txt` |
| D-04 | Ajustes | `D-04.png`, `D-04.html`, `D-04.txt` |
| D-19 | Avisos | `D-19.png`, `D-19.html`, `D-19.txt` |
| D-23 | Widget · pantalla de inicio | `D-23.png`, `D-23.html`, `D-23.txt` |
| D-TB-3 | Herramientas · dos paneles · foco en terminal (con las notas de `D-TB`) | `D-TB-3.png`, `D-TB-3.html`, `D-TB-3.txt` |
| S-15 | Maquinaria y luz (especificación y mapa por pantalla) | `S-15.png`, `S-15.html`, `S-15.txt` |
| D-ES | Lámina de estados | `D-ES.png`, `D-ES.html`, `D-ES.txt` |
| G-1 | Gestos y microinteracciones | `G-1.png`, `G-1.html`, `G-1.txt` |
| K-1 | Tokens | `K-1.png`, `K-1.html`, `K-1.txt` |

### Pantallas originales (`captures/instrumento/`)

| Lienzo | Título | Archivos |
|---|---|---|
| 01 Conexión | 01 CONEXIÓN / ONBOARDING | `01_Conexi_n.png`, `01_Conexi_n.html` |
| 02 Agentes | 02 INICIO / MIS AGENTES | `02_Agentes.png`, `02_Agentes.html` |
| 03 Chat | 03 CHAT CON UN AGENTE | `03_Chat.png`, `03_Chat.html` |
| 04 Aprobación | 04 APROBACIÓN DE ACCIÓN | `04_Aprobaci_n.png`, `04_Aprobaci_n.html` |
| 05 Servidor | 05 ADMINISTRACIÓN DEL SERVIDOR | `05_Servidor.png`, `05_Servidor.html` |
| 06 Ajustes | 06 AJUSTES | `06_Ajustes.png`, `06_Ajustes.html` |

### Lienzos 07 a 23 (`captures/instrumento-2/`)

| Lienzo | Título | Archivos |
|---|---|---|
| 07a·1 | NORMAL | `07a-1.png`, `07a-1.html` |
| 07a·2 | ACCIONES | `07a-2.png`, `07a-2.html` |
| 07a·3 | RENOMBRAR | `07a-3.png`, `07a-3.html` |
| 07a·4 | BORRAR · CONFIRMACIÓN | `07a-4.png`, `07a-4.html` |
| 07b·1 | CHAT · PANEL CERRADO | `07b-1.png`, `07b-1.html` |
| 07b·2 | PANEL ABIERTO | `07b-2.png`, `07b-2.html` |
| 07b·3 | ACCIONES | `07b-3.png`, `07b-3.html` |
| 07b·4 | BORRAR · CONFIRMACIÓN | `07b-4.png`, `07b-4.html` |
| 07b·5 | CONVERSACIÓN DE OTRO CANAL · SOLO LECTURA | `07b-5.png`, `07b-5.html` |
| 07b·6 | DE FONDO · ENCENDIDO | `07b-6.png`, `07b-6.html` |
| 08b·1 | AGENTE SIN CONVERSACIONES | `08b-1.png`, `08b-1.html` |
| 08b·2 | BÚSQUEDA SIN RESULTADOS | `08b-2.png`, `08b-2.html` |
| 08b·3 | CARGANDO | `08b-3.png`, `08b-3.html` |
| 08b·4 | ERROR | `08b-4.png`, `08b-4.html` |
| 08b·5 | SIN RESPUESTA | `08b-5.png`, `08b-5.html` |
| 09·1 | TRABAJANDO · DETENER | `09-1.png`, `09-1.html` |
| 09·2 | TRABAJANDO · REDIRIGIR | `09-2.png`, `09-2.html` |
| 09·3 | ADJUNTAR · ORIGEN | `09-3.png`, `09-3.html` |
| 09·4 | ADJUNTAR · MINIATURA | `09-4.png`, `09-4.html` |
| 09·5 | DICTADO | `09-5.png`, `09-5.html` |
| 09·6 | MODELO DE ESTA CONVERSACIÓN | `09-6.png`, `09-6.html` |
| 09·7 | DICTADO · TERMINANDO | `09-7.png`, `09-7.html` |
| 09·8 | DICTADO · FALTA EL MODELO DE VOZ | `09-8.png`, `09-8.html` |
| 09·9 | DICTADO · SIN PERMISO | `09-9.png`, `09-9.html` |
| 10·1 | TURNO COMPLETO | `10-1.png`, `10-1.html` |
| 10·2 | TURNO LARGO · PLEGADO | `10-2.png`, `10-2.html` |
| 10·3 | MARKDOWN | `10-3.png`, `10-3.html` |
| 10·4 | ARCHIVOS PRODUCIDOS | `10-4.png`, `10-4.html` |
| 10·5 | ARCHIVOS · ESTADOS | `10-5.png`, `10-5.html` |
| 11·1 | CONEXIÓN PERDIDA A MITAD | `11-1.png`, `11-1.html` |
| 11·2 | CHAT NO DISPONIBLE | `11-2.png`, `11-2.html` |
| 11·3 | CARGANDO | `11-3.png`, `11-3.html` |
| 11·4 | CONVERSACIÓN VACÍA | `11-4.png`, `11-4.html` |
| 11·5 | ERROR AL CARGAR | `11-5.png`, `11-5.html` |
| 12·1 | TABLERO · NORMAL | `12-1.png`, `12-1.html` |
| 12·2 | MODO EDICIÓN | `12-2.png`, `12-2.html` |
| 12·3 | VIEJA · ERROR · REFRESCANDO | `12-3.png`, `12-3.html` |
| 12·4 | TABLERO VACÍO | `12-4.png`, `12-4.html` |
| 12·5 | CARGANDO | `12-5.png`, `12-5.html` |
| 12·6 | ERROR AL CARGAR | `12-6.png`, `12-6.html` |
| 12·7 | SIN RESPUESTA | `12-7.png`, `12-7.html` |
| 13·1 | FICHA · IDENTIDAD, MODELO Y MEMORIA | `13-1.png`, `13-1.html` |
| 13·10 | AGENTE NUEVO · VACÍO | `13-10.png`, `13-10.html` |
| 13·11 | FICHA · COMPORTAMIENTO | `13-11.png`, `13-11.html` |
| 13·12 | PERSONALIDAD | `13-12.png`, `13-12.html` |
| 13·13 | APROBACIONES | `13-13.png`, `13-13.html` |
| 13·14 | DESACTIVAR APROBACIONES | `13-14.png`, `13-14.html` |
| 13·15 | APROBACIONES · SIN REGLAS | `13-15.png`, `13-15.html` |
| 13·16 | BAJAR A SMART · CONFIRMACIÓN | `13-16.png`, `13-16.html` |
| 13·17 | QUITAR REGLA | `13-17.png`, `13-17.html` |
| 13·18 | ENCENDER HERRAMIENTA | `13-18.png`, `13-18.html` |
| 13·19 | AÑADIR REGLA | `13-19.png`, `13-19.html` |
| 13·2 | FICHA · HERRAMIENTAS Y SKILLS | `13-2.png`, `13-2.html` |
| 13·20 | ¿BORRAR NOTA? | `13-20.png`, `13-20.html` |
| 13·21 | MEMORIA · TODAS LAS NOTAS | `13-21.png`, `13-21.html` |
| 13·22 | EDITAR SOUL.md | `13-22.png`, `13-22.html` |
| 13·3 | FICHA · USO Y CONVERSACIONES | `13-3.png`, `13-3.html` |
| 13·5 | EDITAR NOTA DE MEMORIA | `13-5.png`, `13-5.html` |
| 13·6 | SERVIDOR SIN RESPUESTA · SOLO LECTURA | `13-6.png`, `13-6.html` |
| 13·7 | CARGANDO | `13-7.png`, `13-7.html` |
| 13·8 | ERROR | `13-8.png`, `13-8.html` |
| 13·9 | SIN RESPUESTA | `13-9.png`, `13-9.html` |
| 14·1 | PENDIENTES E HISTORIAL | `14-1.png`, `14-1.html` |
| 14·2 | FILTRO · DEV + GUARDIÁN | `14-2.png`, `14-2.html` |
| 14·3 | SIN PENDIENTES | `14-3.png`, `14-3.html` |
| 14·4 | SOLO HISTORIAL | `14-4.png`, `14-4.html` |
| 14·5 | SERVIDOR SIN RESPUESTA | `14-5.png`, `14-5.html` |
| 14·6 | CARGANDO | `14-6.png`, `14-6.html` |
| 14·7 | SIN RESPUESTA | `14-7.png`, `14-7.html` |
| 14·8 | ERROR | `14-8.png`, `14-8.html` |
| 15·1 | VARIOS SERVIDORES | `15-1.png`, `15-1.html` |
| 15·2 | ACCIONES | `15-2.png`, `15-2.html` |
| 15·3 | QUITAR · CONFIRMACIÓN | `15-3.png`, `15-3.html` |
| 15·4 | UN SOLO SERVIDOR | `15-4.png`, `15-4.html` |
| 15·5 | NINGUNO ALCANZABLE | `15-5.png`, `15-5.html` |
| 15·6 | CARGANDO | `15-6.png`, `15-6.html` |
| 15·7 | NINGUNO AGREGADO | `15-7.png`, `15-7.html` |
| 15·8 | SIN RESPUESTA | `15-8.png`, `15-8.html` |
| 16a·1 | ACTIVIDAD DENTRO DE AGENTES | `16a-1.png`, `16a-1.html` |
| 16a·2 | TOCAR UNA ENTRADA | `16a-2.png`, `16a-2.html` |
| 16a·3 | FILTROS · SOLO FALLOS | `16a-3.png`, `16a-3.html` |
| 16a·4 | DÍA SIN ACTIVIDAD | `16a-4.png`, `16a-4.html` |
| 16a·5 | CARGANDO MÁS | `16a-5.png`, `16a-5.html` |
| 16a·6 | SIN RESPUESTA | `16a-6.png`, `16a-6.html` |
| 16a·7 | CARGANDO | `16a-7.png`, `16a-7.html` |
| 16a·8 | SIN RESULTADOS · ERROR | `16a-8.png`, `16a-8.html` |
| 17·1 | RESUMEN | `17-1.png`, `17-1.html` |
| 17·2 | REPARTO Y LÍMITES | `17-2.png`, `17-2.html` |
| 17·3 | PROVEEDOR SIN COSTO · SOLO TOKENS | `17-3.png`, `17-3.html` |
| 17·4 | SIN DATOS TODAVÍA | `17-4.png`, `17-4.html` |
| 17·5 | CARGANDO | `17-5.png`, `17-5.html` |
| 17·6 | ERROR · UN SERVIDOR | `17-6.png`, `17-6.html` |
| 17·7 | SIN RESPUESTA | `17-7.png`, `17-7.html` |
| 18·1 | LISTA | `18-1.png`, `18-1.html` |
| 18·10 | ERROR | `18-10.png`, `18-10.html` |
| 18·11 | SIN RESPUESTA | `18-11.png`, `18-11.html` |
| 18·12 | DETALLE · EN PAUSA | `18-12.png`, `18-12.html` |
| 18·2 | LISTA DE VEINTE | `18-2.png`, `18-2.html` |
| 18·3 | DETALLE | `18-3.png`, `18-3.html` |
| 18·4 | DETALLE · ÚLTIMA FALLÓ | `18-4.png`, `18-4.html` |
| 18·5 | BORRAR · CONFIRMACIÓN | `18-5.png`, `18-5.html` |
| 18·6 | CREAR · ATAJO LABORABLES | `18-6.png`, `18-6.html` |
| 18·7 | EDITAR · EXPRESIÓN MANUAL | `18-7.png`, `18-7.html` |
| 18·8 | SIN TAREAS | `18-8.png`, `18-8.html` |
| 18·9 | CARGANDO | `18-9.png`, `18-9.html` |
| 19·1 | EN CURSO · UNA COLUMNA POR PANTALLA | `19-1.png`, `19-1.html` |
| 19·10 | ERROR | `19-10.png`, `19-10.html` |
| 19·2 | DETALLE DE TARJETA | `19-2.png`, `19-2.html` |
| 19·3 | MOVER · ARRASTRAR | `19-3.png`, `19-3.html` |
| 19·4 | BLOQUEADA | `19-4.png`, `19-4.html` |
| 19·5 | CREAR Y ASIGNAR | `19-5.png`, `19-5.html` |
| 19·6 | COLUMNA CON MUCHAS TARJETAS | `19-6.png`, `19-6.html` |
| 19·7 | TABLERO VACÍO | `19-7.png`, `19-7.html` |
| 19·8 | CARGANDO | `19-8.png`, `19-8.html` |
| 19·9 | SIN RESPUESTA | `19-9.png`, `19-9.html` |
| 20·1 | DÓNDE VIVE · TAPA CERRADA | `20-1.png`, `20-1.html` |
| 20·2 | TAPA LEVANTADA · ARMADO | `20-2.png`, `20-2.html` |
| 20·3 | MANTENER PULSADO · CONFIRMACIÓN | `20-3.png`, `20-3.html` |
| 20·4 | EN PAUSA · TODA LA APP | `20-4.png`, `20-4.html` |
| 20·5 | EN PAUSA · CHAT | `20-5.png`, `20-5.html` |
| 20·6 | REANUDAR CON HUELLA | `20-6.png`, `20-6.html` |
| 20·7 | GATEWAY · DETENER | `20-7.png`, `20-7.html` |
| 20·8 | GATEWAY · REINICIAR | `20-8.png`, `20-8.html` |
| 21·1 | NOTIFICACIONES · PLEGADAS | `21-1.png`, `21-1.html` |
| 21·2 | APROBACIÓN · EXPANDIDA | `21-2.png`, `21-2.html` |
| 21·3 | APROBAR · ABRE RELAY Y PIDE HUELLA | `21-3.png`, `21-3.html` |
| 21·4 | PANTALLA DE BLOQUEO | `21-4.png`, `21-4.html` |
| 21·5 | COMPARTIR · ENLACE | `21-5.png`, `21-5.html` |
| 21·6 | COMPARTIR · IMAGEN | `21-6.png`, `21-6.html` |
| 21·7 | COMPARTIR · ARCHIVO NO ADMITIDO | `21-7.png`, `21-7.html` |
| 21·8 | WIDGETS | `21-8.png`, `21-8.html` |
| 22a·1 | 02 AGENTES · OSCURO | `22a-1.png`, `22a-1.html` |
| 22a·2 | 03 CHAT · OSCURO | `22a-2.png`, `22a-2.html` |
| 22a·3 | 05 SERVIDOR · OSCURO | `22a-3.png`, `22a-3.html` |
| 22b·1 | BLOQUEADO | `22b-1.png`, `22b-1.html` |
| 22b·2 | AVISO DE BLOQUEO AUTOMÁTICO | `22b-2.png`, `22b-2.html` |
| 22b·3 | SELECTOR · BLOQUEO AUTOMÁTICO | `22b-3.png`, `22b-3.html` |
| 22c·1 | AGENTES Y CHAT | `22c-1.png`, `22c-1.html` |
| 22c·2 | SERVIDORES | `22c-2.png`, `22c-2.html` |
| 22e·1 | ARRANQUE · CLARO | `22e-1.png`, `22e-1.html` |
| 22e·2 | ARRANQUE · OSCURO · DESPUÉS DE V1 | `22e-2.png`, `22e-2.html` |
| 23·1 | AGREGAR SERVIDOR | `23-1.png`, `23-1.html` |
| 23·2 | ESCANEANDO | `23-2.png`, `23-2.html` |
| 23·3 | EMPAREJADO | `23-3.png`, `23-3.html` |
| 23·4 | ESCRIBIR A MANO | `23-4.png`, `23-4.html` |
| 23·5a | NO SE PUDO · CÓDIGO | `23-5a.png`, `23-5a.html` |
| 23·5b | NO SE PUDO · SIN RESPUESTA | `23-5b.png`, `23-5b.html` |
| 23·5c | NO SE PUDO · REVOCADO | `23-5c.png`, `23-5c.html` |
| 23·6 | ENCONTRADOS EN TU TAILNET | `23-6.png`, `23-6.html` |
