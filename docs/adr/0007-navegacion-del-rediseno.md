# Navegación del rediseño 3.1
Fecha: 2026-10-06

Hasta 3.0, la app tenía cuatro pestañas (Agentes, Aprob., Servidores, Ajustes). Herramientas,
Tareas, Uso y Actualización APK colgaban de la ficha de un Servidor. La pestaña Servidores abría el
Tablero, y la lista de Servidores era otra ruta. En tablet convivían dos marcos: un riel de 120 px
con pestañas verticales, y una columna de 340 px fija con las pestañas debajo. Lo más usado quedaba a
dos o tres toques y cada ruta decidía su Servidor por parámetro.

## Decisión

**Teléfono.** Una barra inferior desplazable con ocho pestañas, en este orden: Agentes · Herram. ·
Tablero · Trabajo · Tareas · Aprob. · Servidores · Ajustes. Teclas de 66×56. La barra recuerda su
posición. Si hay Aprobaciones pendientes y Aprob. no se ve, el borde derecho muestra «N ›», y
tocarlo desplaza la barra hasta Aprob. Dentro de una herramienta, la barra se cambia por la de
herramientas.

**Servidor elegido.**
- Herram., Tablero, Trabajo y Tareas muestran un solo Servidor: el elegido. Agentes, Aprob. y
  Servidores muestran todos.
- El elegido se guarda en el teléfono. La primera vez es el predeterminado.
- La app no lo cambia por su cuenta: si deja de responder, sigue elegido y la sección lo dice con
  una fila compacta.
- Si se quita ese Servidor, pasa al predeterminado, o a ninguno si no queda ninguno.
- Una entrada externa (notificación, compartir, widget) fija el elegido al Servidor de la entrada.

**Tablet.**
- Un solo marco: riel de 72 px con iconos, que ☰ o un deslizamiento despliega a 240 px con los
  nombres, «relay» y el selector de Servidor. Desplegado, empuja el contenido; no lo tapa.
- A la derecha, lista y detalle. La lista se redimensiona arrastrando su borde entre 280 y 560 px,
  y el detalle nunca baja de 390 px.
- El ancho se recuerda por sección, y un doble toque en el borde vuelve al ancho por defecto de esa
  sección.
- Herramientas conserva sus dos paneles y su foco de teclado.

**Retornos.** El retorno visible y la tecla atrás de Android hacen lo mismo. El texto es «‹ »
seguido del nombre del lugar del que se viene de verdad: el padre en la jerarquía, o el origen de un
acceso cruzado (por ejemplo, de una Conversación a Herramientas). Ninguna pantalla escribe «Volver»
a secas.

**Red.** La pastilla TAILNET abre una hoja con el estado de la tailnet y de cada Servidor, con
«Reintentar» y «Abrir Tailscale». El bloque grande de estado de un Servidor solo aparece en su ficha
y en esa hoja. En el resto de pantallas, un Servidor sin respuesta es una fila compacta.

## Consecuencias

- Herram., Tablero, Trabajo y Tareas dejan de ser rutas por Servidor sueltas y pasan a ser
  pestañas que leen el Servidor elegido. Las rutas con Servidor siguen sirviendo como entrada
  externa: fijan el elegido y muestran la pestaña.
- La entrada a Herram. sigue pidiendo huella o código una vez hasta que Relay se bloquea
  (especificación V3, §2).
- El marco de tablet de 3.0 y su documento quedan reemplazados por este.
- La ficha del Servidor conserva su estado (gateway, uptime, métricas y Pausa general) y enlaza a
  Herramientas, Tareas y Uso como destinos. Los destinos llevan al Servidor de esa ficha y lo dejan
  como elegido.

## Implementación (#107)

- **Retornos.** Se calculan del estado de navegación del propio router, sin parámetros `from` ni
  otra pila: el origen es la entrada de debajo en la pila (su nombre: la pestaña, el Agente, el
  Servidor), y en Herram. la pestaña anterior del historial de pestañas. Una entrada externa
  (`entry=1`) o una pantalla sin nada debajo vuelve a su padre en la jerarquía, sin dejar ninguna
  pantalla sin salida. La tecla atrás de Android ejecuta la misma acción que el retorno visible.
- **Cambio de pestaña desde fuera de la barra** (riel, widget, notificación): `dismissTo`, que
  vuelve a las pestañas en vez de apilar otras encima.
- **Barra de teléfono.** Icono de 16 px en cada tecla (lo fija `D-0`; el riel plegado lo necesita),
  no la raya de 14×3 de `F-1`. La barra recuerda su posición mientras Relay está abierto.
- **Tablet.** Ancho por defecto de la lista: 294 en Agentes y 320 en Servidores. Solo esas dos
  secciones llevan lista, como en 3.0. Un deslizamiento de 40 px o más sobre el riel lo despliega o
  lo pliega. El ancho guardado no se reescribe al desplegar el riel: la lista se estrecha mientras
  tanto y recupera su ancho al plegarlo.
- **Selector de Servidor.** Un Servidor sin respuesta se puede elegir: queda elegido, su fila
  tiembla 0,4 s y un toast dice «<Servidor> sin respuesta». En el riel, el selector lleva el
  barrido de ese Servidor.
- **Servidor elegido.** Sustituye al `selectedServer` de 3.0, que nunca se guardó: no hay valor que
  migrar. La primera vez es el predeterminado, como mostraba 3.0. El widget sigue al elegido, así
  que una entrada del widget ya llega con su Servidor elegido.
- **Hoja TAILNET.** Además de «CONECTADA», la pantalla dice «SIN VPN» («La red actual de Relay no
  usa VPN. Comprueba Tailscale.») o «SIN COMPROBAR» («Relay no pudo comprobar su VPN.»).
