# Handoff: Relay — rediseño «Instrumento + maquinaria»

## Overview
Relay es una app Android (teléfono y tablet) para controlar Agentes de Hermes que corren en Servidores propios a través de una tailnet de Tailscale. Desde la app se puede:
- conversar con los Agentes;
- decidir sus Aprobaciones;
- ver el estado de los Servidores;
- abrir herramientas remotas (Terminal, Archivos, Web, Navegador);
- gestionar Tareas programadas, Trabajo (kanban) y el Tablero.

Este paquete contiene el rediseño completo: el sistema visual, las 23 pantallas de teléfono, la tablet, los estados, los gestos y la capa final de «maquinaria y luz».

## About the Design Files
Los archivos de este paquete son **referencias de diseño hechas en HTML**: prototipos que muestran el aspecto y el comportamiento buscados, **no código de producción para copiar**. La tarea es **recrear estos diseños en el entorno real de la app**, con sus patrones y librerías (por ejemplo, Jetpack Compose). Si todavía no hay entorno, hay que elegir el framework más adecuado e implementar ahí.

Cada `.dc.html` se abre directamente en un navegador, siempre que `support.js` esté en la misma carpeta. Son lienzos grandes: se recorren con desplazamiento y zoom.

## Fidelity
**Alta fidelidad (hifi).** Los colores, la tipografía, los espaciados, los radios, las sombras, los textos y las animaciones son los finales. Hay que recrearlos al píxel.

## Un solo archivo: `Relay - Rediseño.dc.html`
Todo el rediseño está en un único lienzo, en este orden (si algo se contradice, manda lo que aparece antes):
1. **R-1 · Pantallas principales**: teléfono F-1…F-6 (Agentes, Conversación, Aprobación, Servidor, Terminal, Tareas) y tablet T-1 (Agentes + Conversación) y T-2 (Servidor), ya con la capa final de maquinaria y luz.
2. **S-15 · Maquinaria y luz**: especificación exacta de cada pieza y mapa de qué lleva cada pantalla.
3. **D-0 · Navegación**: barra de 8 pestañas, riel de tablet y hoja TAILNET.
4. **D-AG, D-PE, D-SE**: el resto de pantallas de teléfono (ficha del Agente y subpantallas, Compartir, Herram., Tablero, Trabajo, Aprobaciones, Servidores, Agregar Servidor, Uso, Presets, APK, Ajustes, Avisos y Widget), con la maquinaria aplicada según el mapa de S-15. Debajo de cada pantalla, la lista de lo que cambia respecto de la app actual.
5. **D-ES · Estados** (carga, vacío y error) y **D-TB · Tablet en Herramientas**, con dos paneles.
6. **G-1 · Gestos** y **K-1 · Tokens**.

El tema oscuro usa las mismas pantallas con los tokens de K-1 (columna OSCURO).

## Screens / Views
Para cada pantalla, el layout exacto y los textos están en el archivo de referencia. Resumen:

- **Agentes** (raíz) — F-1. Encabezado A: título 28/700, pastilla TAILNET y tecla «+». Segmentado Agentes | Actividad. Aviso de Aprobación como bloque de mando. Grupos por Servidor: cabecera Mono 9,5 con regla grabada y latencia; un bloque con las filas de Agente (avatar 40, nombre 15/700, último mensaje 13, hora Mono 11, trío ON/BSY/ERR). Un Servidor sin respuesta se muestra como fila compacta.
- **Conversación** — F-2. Encabezado B («‹ Agentes», tecla >_), luego la identidad y el trío, y después el selector de Conversación y Personalidad. ACTIVIDAD como bloque de mando; terminal empotrada; compositor con «+», campo y micrófono naranja de 48.
- **Aprobación (hoja / pantalla)** — F-3. Comando en pantalla empotrada, riesgo 3/5, cuenta atrás, seguro y la tecla «Aprobar · mantén», con huella después.
- **Aprobaciones (lista)** — D-02. Tres selectores (AGENTE, DECIDE, CANAL), las pendientes y el historial.
- **Tablero** — D-03. **Trabajo** — D-17. **Tareas** — F-6 / D-15. **Herram.** — D-21 + F-5. **Servidores** — D-06. **Ficha del Servidor** — F-4 / D-07. **Uso** — D-16. **Presets** — D-18. **APK** — D-20. **Ajustes** — D-04. **Avisos** — D-19. **Agregar Servidor** — D-05. **Ficha del Agente y sus subpantallas** — D-10…D-14. **Compartir** — D-22. **Widget** — D-23. **Hoja TAILNET** — D-0·3.
- **Tablet 11″ horizontal** — T-1, T-2, D-TB·3. Riel de 72 px que se despliega a 240 px y empuja el contenido (no se superpone). Lista de 270–360 px y detalle con el resto del ancho. En Herramientas, dos paneles.

## Navegación
- **Teléfono:** barra inferior desplazable con 8 pestañas, en este orden: Agentes · Herram. · Tablero · Trabajo · Tareas · Aprob. · Servidores · Ajustes. Teclas de 66×56, icono de 16 y etiqueta Mono 9,5. Si hay Aprobaciones pendientes y la pestaña Aprob. no se ve, el borde derecho muestra la insignia «N ›»; al tocarla, la barra se desplaza hasta Aprob.
- **Tablet:** riel de iconos; ☰ lo expande a 240 px con nombres, «relay» y el selector de Servidor. También se expande o pliega deslizando sobre el riel.
- **Selector de Servidor:** Herram., Tablero, Trabajo y Tareas muestran el Servidor elegido. Agentes, Aprob. y Servidores muestran todos.
- **Pastilla TAILNET:** abre una hoja con el estado de la red, «Reintentar» y «Abrir Tailscale».
- **Retornos:** siempre «‹ » seguido del nombre del padre real.

## Interactions & Behavior
Ver la sección G-1 del archivo. Todas las acciones peligrosas piden confirmación, mantener pulsado o la huella; deslizar nunca aprueba ni borra.
- **Teclas:** al pulsar bajan 1 px y la sombra pasa a `inset 0 2px 3px rgba(0,0,0,.18)`.
- **Deslizar filas** (umbral 90 px, retorno con muelle `transform .32s cubic-bezier(.2,1.3,.4,1)`):
  - Agente: → abre el chat, ← silencia o activa sus avisos.
  - Tarea: → pausa o reanuda, ← «Ejecutar ahora» (pide confirmación).
  - Aprobación: → abre la hoja.
  - Tarjeta de Trabajo: → la pasa a la siguiente columna.
- **Arrastrar para recargar:** a partir de 60 px, «SUELTA PARA RECARGAR»; mientras carga, el LED parpadea.
- **Hojas:** se cierran arrastrando el asa más de 110 px. El fondo oscurece hasta `rgba(20,20,19,.55)`. Transición `transform .3s cubic-bezier(.2,1,.3,1)`.
- **Aprobar:**
  1. Quitar el seguro.
  2. Mantener «Aprobar» 1 s: se llena la tira de 6 LEDs.
  3. Poner la huella.

  Al aprobar, el comando pasa a verde (#6FD08C) y aparece el toast «Aprobado. dev continúa.».
- **Pausa general:**
  1. Arrastrar la tapa hacia arriba (abre a partir del 55 %).
  2. Mantener el botón rojo 1 s.

  Aparece la franja naranja «PAUSA GENERAL · ATLAS» con «Reanudar».
- **Terminal:** Ctrl y Alt quedan pegadas (fondo naranja con glow y etiqueta PEGADA) hasta la siguiente tecla.
- **Tablet:**
  - arrastrar el borde lista/detalle cambia el ancho de la lista (280–560 px);
  - un archivo arrastrado de la lista al chat queda adjunto;
  - las Tarjetas se arrastran entre las 5 columnas;
  - al tocar un panel, ese panel recibe el teclado.
- **Toasts:** 44 px de alto, #1A1A19, entran en 220 ms con `cubic-bezier(.2,.9,.3,1.2)` y desaparecen a los 2 s.

## Maquinaria y luz (S-15) — lo más importante
El brillo analógico y la sensación de que la app está viva son requisitos de producto, no adornos. Valores exactos:
- **Foquitos analógicos**: tiras de estado secundarias.
  - 13 lentes de 6 px repartidas en la tira.
  - Lente: degradado radial (naranja `#7A4A10 → #3A2206`; rojo `#7A2418 → #3A0E08`) con borde `inset 0 0 0 1px rgba(0,0,0,.45), inset 0 1px 1px rgba(255,255,255,.12)`.
  - Filamento: 2×2 px centrado (`#FFF0D6` / `#FFE2DA`), con opacidad entre .35 y 1.
  - Halo: 12 px, degradado radial de `rgba(242,154,26,.75)` o `rgba(255,106,85,.75)` a transparente; escala de .4 a 1.
  - Ciclo de 3,2 s con `cubic-bezier(.4,0,.2,1)`. Fotogramas: 0 % apagado, 45 % máximo, 70 % al 55 %, 100 % apagado.
  - Retraso: `0,14 s × |i − 6|`, para que la luz nazca en el foco central y se extienda a los lados.
- **Barrido** (estilo KITT):
  - Pista de 6 px, radio 3.
  - Cabezal del 22–26 % del ancho, con degradado transparente → color → transparente y glow de 8–10 px.
  - Ida y vuelta (`left 0% → 80% → 0%`), ease-in-out: 1,6 s en naranja (Turno en curso), 1 s en rojo (espera una Decisión).
  - Uno principal por pantalla, siempre dentro de una pantalla empotrada.
- **Caja de voz:**
  - Ventana de 30×20.
  - Tres columnas de 5 px, cada una con tres celdas de 3 px.
  - Escala vertical entre .15 y 1; duraciones 0,7 / 0,55 / 0,8 s y retrasos 0 / 0,18 / 0,09 s.
- **Aguja:**
  - Arco de 100° con 9 marcas; las dos últimas en #E5533D.
  - Aguja de 2 px #F29A1A con glow de 6 px.
  - Marca el valor real y oscila ±2° en 6 s.
  - Las agujas de datos fijos (CPU, MEM, DISCO) solo se mueven cuando cambia el dato: 400 ms ease-out.
- **Tornillos (bloque de mando):** 6 px, #D6D3CC, `inset 0 1px 1px rgba(0,0,0,.28)`, a 7 px de cada esquina. Solo en bloques que mandan o vigilan algo vivo.
- **Regla grabada:** marcas de 1 px de ancho cada 3 px. Alturas: 7 px cada 6 marcas, 4 px en las pares y 2 px en el resto. Color #B9B6AF sobre claro, #3A3936 dentro de una pantalla. Máximo una por pantalla.
- **Cuentakilómetros:** celdas de 16×24, radio 3, #2A2927, Mono 13/600. Cada cifra que cambia rueda hacia arriba en 280 ms.
- **Seguro y tecla con LEDs:** ver «Aprobar», arriba.
- **Pantallas empotradas:** fondo #161615, sombra `inset 0 2px 6px rgba(0,0,0,.5)`, scanlines `repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 1px, transparent 1px 3px)`. Borde luminoso de acento: `0 0 0 1px rgba(242,154,26,.22), 0 0 16px rgba(242,154,26,.14)`.
- **Glow de LED:** `0 0 8px <color>, 0 0 2px <color>`. Glow de texto: `0 0 7px` con el color al .7–.75.
- **Accesibilidad:** si el sistema tiene activado «reducir movimiento», el barrido y la caja de voz se paran en su posición central, los foquitos quedan encendidos sin animar y la aguja queda fija.

## State Management
- **Por Servidor:** online / sin respuesta / sin acceso / no disponible, latencia, versión de Hermes, gateway (activo / detenido / pausa), uptime, CPU, MEM y DISCO.
- **Por Agente:** estado ON / BSY / ERR; si espera una Decisión o tiene un Turno en curso (esto decide el color de los foquitos y del barrido); si está escribiendo (caja de voz); si sus avisos están silenciados.
- **Aprobaciones:** lista de pendientes con su vencimiento (cuenta atrás) e historial.
- **Tareas:** activa / pausada / en ejecución / con fallo, y la próxima ejecución.
- **Trabajo:** columna de cada Tarjeta (POR HACER, EN CURSO, REVISIÓN, BLOQUEADO, HECHO).
- **UI:** pestaña activa, posición de la barra, Servidor elegido, riel de tablet expandido, ancho de la lista, panel con foco, teclas pegadas.
- **Estados de carga, vacío y error:** ver la lámina D-ES y S-11. El bloque grande de estado solo aparece donde el Servidor es el protagonista (su ficha y la hoja TAILNET); en el resto, fila compacta.

## Design Tokens
**Tema claro**
- Fondo #D8D5CE · bloque #ECEAE5 · campo #DCD9D2 · panel de lista (tablet) #CBC7BF.
- Tinta #1A1A19 · secundaria #4A4843 · terciaria #5E5B55 · línea #D6D3CC · LED apagado #B9B6AF.

**Tema oscuro**
- Fondo #141413 · bloque #1F1E1C · tecla #2A2927 · campo #0F0F0E · pantalla #070707.
- Tinta #E8E6E1 · secundaria #C9C6BE · terciaria #8D8A82 · línea #2C2C2A · LED apagado #3A3936.

**Acentos**
- Naranja #F29A1A; texto naranja sobre claro #7A4A00.
- Verde LED #4CC774; texto sobre claro #1E6638; dentro de pantalla #6FD08C.
- Rojo LED #E5533D; texto sobre claro #9A2E20; dentro de pantalla #FF6A55.
- Pantalla empotrada #161615; texto #C9C6BE / #ECEAE5; etiquetas #8D8A82.

**Tipografía**
- Hanken Grotesk: título 28/700 (−0,025em) · subtítulo 20/800 · bloque 16/700 · cuerpo 15/600 · secundario 13/400.
- Martian Mono: etiqueta 9,5/600 con +0,06–0,08em y mayúsculas · datos 11 · lecturas 20/600 · número grande 28–34.
- Nunca por debajo de 9,5 px.

**Radios**
- Bloque 20 · tecla grande 16 · tecla 14 · campo y pantalla 12–16 · chip 6–8 · pastilla 999 · teléfono 44 · tablet 30.

**Tamaños**
- Altura mínima tocable 48 (44 en las teclas de la terminal).
- Filas de lista de 56–80. Margen lateral de 12; margen de los títulos de 16.

**Sombras**
- Bloque: `inset 0 1px 0 #fff, 0 1px 2px rgba(0,0,0,.12)`.
- Tecla: `inset 0 1px 0 #fff, 0 2px 3px rgba(0,0,0,.15)`.
- Campo: `inset 0 2px 3px rgba(0,0,0,.12)`.
- Primario: `inset 0 1px 0 rgba(255,255,255,.4), 0 2px 4px rgba(0,0,0,.25)` + glow naranja.

## Assets
- No hay imágenes. Los iconos son trazos SVG de 24×24 (stroke 2) incluidos en los archivos.
- Avatares: placeholder de puntos sobre #161615; sustituir por los avatares reales.
- Fuentes: Hanken Grotesk y Martian Mono, de Google Fonts.

## Files
- `Relay - Rediseño.dc.html`: todo el rediseño en un único lienzo (R-1, S-15, D-0, pantallas, estados, tablet, gestos y tokens).
- `support.js`: necesario para abrir el `.dc.html` en el navegador.

## Pendiente de confirmar
- En el widget, ops aparece en atlas, mientras que en Agentes y en Compartir está en homelab.
- Los porcentajes de CPU y MEM y los tokens por segundo son de ejemplo.
- La lista completa de modos de aprobación: solo se conoce SMART.
