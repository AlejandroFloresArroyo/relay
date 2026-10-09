# Relay 3.1: rediseño «Instrumento + maquinaria»

Contrato de producto acordado con Ale el 2026-10-06, en la sesión de preguntas sobre el handoff de
Claude Design «Relay - Rediseño». Donde este documento choque con un lienzo anterior, manda este
documento. Donde choque con el lienzo del rediseño, manda este documento. Lo que el rediseño
dibuja y este documento no menciona, se construye como está dibujado.

Navegación: [ADR 0007](adr/0007-navegacion-del-rediseno.md).

## Problem Statement

Relay creció en once rondas de diseño y tres versiones. Cada pantalla está bien por sí misma, pero
la app no se siente hecha por una sola mano. Hay tres estilos de encabezado y retornos que dicen
«‹ Volver», «‹ Servidor» o «Volver al Servidor». Hay unas treinta formas de escribir «No se pudo…»
y dos marcos de tablet distintos. La pestaña SERVIDORES abre un Tablero en vez de los Servidores.
El mismo Servidor caído se anuncia con un bloque grande en cuatro pantallas a la vez. Lo más usado
fuera de Agentes (Herramientas, Tablero, Trabajo y Tareas) queda a dos o tres toques, detrás de la
ficha de un Servidor.

Además, la app no transmite que hay máquinas vivas al otro lado: un Turno en curso, un Agente que
espera una Decisión o un Servidor que se llena se ven igual que uno en reposo.

## Solution

Aplicar el rediseño «Instrumento + maquinaria» a toda la app, en teléfono y tablet, en claro y
oscuro:

- Un sistema único de tokens, tipografía, componentes y estados.
- Una navegación nueva: ocho pestañas en teléfono, un riel lateral en tablet y un Servidor elegido
  para las secciones que muestran un solo Servidor.
- Una capa de «maquinaria y luz»: foquitos, barridos, agujas, cuentakilómetros, tornillos y
  reglas grabadas. Muestra con datos reales lo que está vivo.

La app no pierde ninguna función. Lo que el rediseño no dibuja se adapta al sistema nuevo.

## User Stories

### Navegación en teléfono

1. Como persona que opera Agentes, quiero una barra inferior con ocho pestañas (Agentes · Herram. · Tablero · Trabajo · Tareas · Aprob. · Servidores · Ajustes), para llegar a cualquier sección en un toque.
2. Como persona que opera Agentes, quiero que la barra se desplace en horizontal y recuerde su posición, para que quepan ocho pestañas sin encogerlas por debajo de lo tocable.
3. Como persona con Aprobaciones pendientes, quiero ver una insignia «N ›» en el borde derecho de la barra cuando la pestaña Aprob. no se ve, para no perder una Aprobación que espera.
4. Como persona con Aprobaciones pendientes, quiero que tocar la insignia desplace la barra hasta Aprob., para llegar sin buscar.
5. Como persona que usa una herramienta, quiero que la barra de pestañas se cambie por la barra de herramientas (Terminal · Archivos · Web · Navegador) mientras estoy dentro, para tener a mano lo que uso.
6. Como persona que navega por la app, quiero que cada retorno diga «‹ » seguido del nombre real del lugar padre, para saber siempre adónde vuelvo.
7. Como persona que llega desde otra Conversación o un acceso cruzado, quiero que el retorno nombre el origen real y no el padre teórico, para volver adonde estaba.
8. Como persona en Android, quiero que la tecla atrás haga lo mismo que el retorno visible, para no tener dos comportamientos distintos.
9. Como persona que abre Relay desde una notificación, desde compartir o desde el widget, quiero llegar a la pantalla correcta con un retorno coherente y con el Servidor de esa entrada ya elegido, para no quedar en una pantalla sin salida.
10. Como persona que mira la pestaña Servidores, quiero ver la lista de Servidores y no un Tablero, para encontrar las máquinas donde espero.

### Servidor elegido

11. Como persona con varios Servidores, quiero que Herram., Tablero, Trabajo y Tareas muestren un solo Servidor elegido, para no mezclar máquinas en una sección de trabajo.
12. Como persona con varios Servidores, quiero que Agentes, Aprob. y Servidores muestren todos los Servidores, para tener la visión completa donde la necesito.
13. Como persona que vuelve a abrir Relay, quiero que se recuerde el último Servidor elegido, para seguir donde lo dejé.
14. Como persona que abre Relay por primera vez, quiero que el Servidor elegido sea el predeterminado, para empezar sin elegir.
15. Como persona cuyo Servidor elegido deja de responder, quiero que siga elegido y que la sección lo diga con una fila compacta, para que la app nunca cambie de máquina por su cuenta.
16. Como persona que quita el Servidor elegido, quiero que el elegido pase al predeterminado, o a ninguno si no quedan, para no apuntar a algo que ya no existe.

### Tablet

17. Como persona en tablet horizontal, quiero un riel de 72 px con iconos siempre visible, para navegar sin perder espacio.
18. Como persona en tablet, quiero desplegar el riel a 240 px con ☰ o deslizando sobre él, con los nombres, «relay» y el selector de Servidor, para cambiar de sección o de Servidor con texto legible.
19. Como persona en tablet, quiero que el riel desplegado empuje la lista y el detalle en vez de taparlos, para no perder lo que estaba viendo.
20. Como persona en tablet, quiero que el selector de Servidor del riel muestre su propio barrido mientras ese Servidor trabaja, para ver la actividad sin entrar.
21. Como persona en tablet, quiero una lista a la izquierda y el detalle en el resto del ancho, para trabajar sin ir y volver.
22. Como persona en tablet, quiero redimensionar la lista arrastrando su borde entre 280 y 560 px, para adaptarla a lo que estoy leyendo.
23. Como persona en tablet, quiero que el detalle nunca baje de 390 px al redimensionar, para que la Conversación y la terminal sigan siendo usables.
24. Como persona en tablet, quiero que el ancho de la lista se recuerde por sección (Agentes, Servidores…), porque cada sección tiene contenidos de ancho distinto.
25. Como persona en tablet, quiero que un doble toque en el borde devuelva la lista al ancho por defecto, para salir de un ancho incómodo.
26. Como persona en tablet con una Conversación abierta, quiero ver la ACTIVIDAD del Turno como panel fijo a la derecha, para seguir el Turno sin desplazar el hilo.
27. Como persona en tablet con una Conversación abierta, quiero abrir Archivos del Servidor a su lado («adjuntar desde el Servidor»), para elegir un archivo sin salir de la Conversación.
28. Como persona en tablet, quiero arrastrar un archivo de ese panel a la Conversación para adjuntarlo, para darle al Agente un archivo que ya está en su máquina sin copiarlo.
29. Como persona en tablet con Herramientas en dos paneles, quiero que tocar un panel le dé el teclado y que se vea cuál lo tiene, para no escribir en el panel equivocado.
30. Como persona en tablet, quiero arrastrar las Tarjetas entre las cinco columnas de Trabajo, para reorganizar el trabajo con un gesto.

### Red

31. Como persona que opera por Tailscale, quiero una pastilla TAILNET que abra una hoja con el estado de la red y de cada Servidor (latencia o SIN RESPUESTA), para diagnosticar la conexión en un sitio.
32. Como persona con un Servidor que no responde, quiero «Reintentar» y «Abrir Tailscale» en esa hoja, para actuar sin buscar.
33. Como persona con un Servidor que no responde, quiero que el bloque grande de estado aparezca solo donde el Servidor es el protagonista (su ficha y la hoja TAILNET) y en el resto una fila compacta, para que un fallo no ocupe cuatro pantallas.

### Agentes y Conversación

34. Como persona que mira la lista de Agentes, quiero los Agentes agrupados por Servidor, con la cabecera del grupo, su regla grabada y su latencia, para ver de un vistazo dónde corre cada uno.
35. Como persona que mira la lista de Agentes, quiero que cada Agente lleve una tira de foquitos naranja si tiene un Turno en curso y roja si espera una Decisión, para ver la actividad sin abrir nada.
36. Como persona con una Aprobación pendiente, quiero verla arriba de Agentes como bloque de mando atornillado con su barrido rojo, para que lo urgente destaque.
37. Como persona que desliza un Agente hacia la derecha, quiero que se abra su Conversación, para entrar más rápido.
38. Como persona en una Conversación, quiero el encabezado «‹ Agentes», la tecla >_, la identidad del Agente, el trío ON/BSY/ERR y debajo el selector de Conversación y de Personalidad, para tener el contexto completo arriba.
39. Como persona en una Conversación, quiero que la ACTIVIDAD del Turno sea un panel de mando con aguja, tiempo, barrido y pasos, para seguir el Turno de un vistazo.
40. Como persona que sigue un Turno, quiero que la aguja marque los segundos del paso en curso en una escala fija de 0 a 60 s, en rojo a partir de 45 s y en 0 si no hay paso en curso, para ver si un paso se atasca.
41. Como persona que ve un paso de terminal en el hilo, quiero «FALLÓ» cuando el paso terminó en error, para saber que falló sin leer la salida.
42. Como persona en una Conversación, quiero la caja de voz mientras el Agente está escribiendo texto, para saber que la respuesta está llegando.
43. Como persona en una Conversación, quiero el compositor con «+», el campo y el micrófono naranja de 48, para escribir, adjuntar o dictar.
44. Como persona en una Conversación, quiero seguir pudiendo renombrar, borrar y buscar Conversaciones, corregir un Turno en curso y elegir el modelo de la Conversación, adaptado al sistema nuevo.
45. Como persona que mira Actividad, quiero el segmentado Agentes | Actividad en la pestaña Agentes, para cambiar de vista sin cambiar de pestaña.

### Aprobar

46. Como persona que decide una Aprobación, quiero ver el comando en una pantalla empotrada, el riesgo, la cuenta atrás, el seguro, «Rechazar» y «Aprobar · mantén», para decidir con todo delante.
47. Como persona que aprueba, quiero quitar el seguro, mantener «Aprobar» 1 s mientras se llena una tira de 6 LEDs y después poner la huella, para que aprobar nunca sea un toque accidental.
48. Como persona que aprueba, quiero que «Aprobar» envíe «una vez», para aprobar solo este comando.
49. Como persona que confía en el comando para toda la sesión, quiero una tecla secundaria «Para la sesión», con el mismo seguro, pulsación y huella, que aparezca solo si la Aprobación la ofrece.
50. Como persona que aprueba, quiero que el comando se ponga verde y un toast «Aprobado. <Agente> continúa.», para confirmar que se envió.
51. Como persona cuya Aprobación vence mientras mantengo «Aprobar» o pongo la huella, quiero que no se envíe nada, que la tira se vacíe, que aparezca VENCIDA y que el seguro vuelva a ponerse, para no aprobar algo que Hermes ya no espera.
52. Como persona que desliza una Aprobación hacia la derecha en la lista, quiero que se abra su hoja, nunca que se apruebe.
53. Como persona que mira Aprobaciones, quiero los selectores AGENTE, DECIDE y CANAL, las pendientes y el historial, con el sistema nuevo.

### Servidores y ficha del Servidor

54. Como persona que mira la ficha de un Servidor, quiero el gateway, el uptime en cuentakilómetros y tres agujas (CPU, MEM, DISCO) en una sola fila de instrumentos atornillada, para ver la salud de la máquina de un vistazo.
55. Como persona que mira las agujas, quiero que CPU y MEM midan la máquina entera (la memoria usada, sin contar la caché) y DISCO el disco donde vive Hermes, para vigilar lo que puede detenerla.
56. Como persona que mira las agujas, quiero que solo se muevan cuando cambia el dato (400 ms, ease-out), para que su movimiento signifique algo.
57. Como persona con un Puente que no tiene métricas, quiero «Actualiza el Puente para ver CPU, MEM y DISCO» en lugar de las agujas, para saber por qué no están.
58. Como persona que mira el uptime, quiero que cada cifra que cambia ruede hacia arriba, para notar que la máquina sigue viva.
59. Como persona que mira la ficha del Servidor, quiero Herramientas, Tareas programadas y Uso y costo como destinos con plaquita y un dato (PIDE HUELLA, 1 FALLÓ, ≈ $1.08 SEM.), separados del estado, para distinguir qué es estado y qué es destino.
60. Como persona que pausa un Servidor, quiero levantar la tapa (abre a partir del 55 %) y mantener el botón rojo 1 s, para que la Pausa general nunca sea un toque accidental.
61. Como persona con un Servidor en pausa, quiero la franja naranja «PAUSA GENERAL · <SERVIDOR>» con «Reanudar», para saber que está pausado y cómo salir.
62. Como persona que agrega un Servidor, quiero el flujo de emparejamiento con el sistema nuevo.
63. Como persona que revoca dispositivos, quiero seguir pudiendo hacerlo, adaptado al sistema nuevo.

### Herramientas

64. Como persona que entra a Herram., quiero que la entrada siga pidiendo huella o código del teléfono una vez hasta que Relay se bloquee, como en V3.
65. Como persona en la Terminal, quiero que Ctrl y Alt queden pegadas (fondo naranja, glow y la etiqueta PEGADA) hasta la siguiente tecla, para escribir combinaciones con una mano.
66. Como persona en la Terminal, quiero que un barrido recorra la cabecera mientras el programa escribe, para saber que hay salida en curso.
67. Como persona en tablet, quiero las Herramientas en dos paneles con el sistema nuevo (D-TB).

### Tareas, Tablero y Trabajo

68. Como persona que mira Tareas, quiero que la Tarea en ejecución suba a un bloque de mando con su barrido y que cada Tarea muestre su próxima hora en una ventanilla, para ver qué corre y qué viene.
69. Como persona que desliza una Tarea hacia la derecha, quiero pausarla o reanudarla, para gestionarla sin abrirla.
70. Como persona que desliza una Tarea hacia la izquierda, quiero «Ejecutar ahora» con confirmación, para lanzarla sin abrirla y sin lanzarla por accidente.
71. Como persona que abre una Tarea, quiero seguir viendo su detalle y su historial de ejecuciones, adaptados al sistema nuevo.
72. Como persona que desliza una Tarjeta de Trabajo hacia la derecha, quiero pasarla a la siguiente columna, saltando BLOQUEADO: POR HACER → EN CURSO → REVISIÓN → HECHO. Bloquear sigue siendo una acción explícita con su selector.
73. Como persona que abre una Tarjeta, quiero seguir viendo su detalle con comentarios y bloqueos, adaptado al sistema nuevo.
74. Como persona que mira el Tablero, quiero el Tablero del Servidor elegido con el sistema nuevo.
75. Como persona en cualquier lista que se puede recargar, quiero arrastrar hacia abajo (más de 60 px) para recargar, con «SUELTA PARA RECARGAR» y el LED parpadeando mientras carga.

### Ficha del Agente, Ajustes y resto

76. Como persona que mira la ficha de un Agente, quiero la ficha y sus subpantallas (memoria, SOUL, herramientas, skills, aprobaciones, logs) con el sistema nuevo.
77. Como persona que mira el Modo de aprobación de un Agente, quiero ver manual, smart u off, los tres que existen.
78. Como persona que usa Uso, Presets, Actualización APK, Ajustes, Avisos, Compartir y Widget, quiero esas pantallas con el sistema nuevo.

### Sistema, estados y movimiento

79. Como persona que usa la app, quiero una sola anatomía para cargando, vacío, error, sin respuesta, sin control, no disponible y sin acceso, con la misma forma de escribir cada mensaje, para reconocer el estado sin leerlo dos veces.
80. Como persona que cierra una hoja, quiero poder arrastrar el asa más de 110 px hacia abajo, para cerrarla con un gesto.
81. Como persona que pulsa una tecla, quiero que baje 1 px y cambie su sombra, para sentir que la pulsé.
82. Como persona que hace una acción breve, quiero un toast de 44 px que entra en 220 ms y desaparece a los 2 s, para confirmarla sin interrumpir.
83. Como persona que deja la app visible, quiero que la maquinaria anime siempre que está en pantalla, porque la sensación de máquina viva es parte del producto.
84. Como persona con la app en segundo plano o la pantalla apagada, quiero que la animación se pare, para no gastar batería en algo que nadie ve.
85. Como persona con «reducir movimiento» activado, quiero que el barrido y la caja de voz queden en su posición central, que los foquitos queden encendidos sin animar y que las agujas queden fijas.
86. Como persona que usa el tema oscuro, quiero todas las pantallas del rediseño en oscuro con los tokens de K-1.
87. Como persona con letra grande del sistema, quiero que nada se corte ni se parta por accidente hasta el 130 %, y que ningún texto baje de 9,5 px.

### Operación

88. Como persona que instala un Puente nuevo, quiero que anuncie las métricas como una capacidad más, sin cambiar la versión del protocolo, para que la app y los Puentes viejos sigan entendiéndose.
89. Como persona que revisa los registros del Puente, quiero que las métricas no dejen rutas, valores ni errores con datos de la máquina en el log, solo método, ruta y estado.
90. Como persona que prueba sin Servidor, quiero ver cada pantalla, estado y animación nuevos en la demo, para revisarlos sin una máquina real.

## Implementation Decisions

### Rango y entrega

- Versión 3.1.0. Este documento es la especificación; la navegación se fija en la ADR 0007.
- El lienzo «Relay - Rediseño» se copia al repositorio junto a los anteriores, con una imagen por sección. Reemplaza a los lienzos anteriores en lo que los contradiga.
- Rama de integración `redesign`, creada desde `dev`. Los tickets salen de `redesign` y se fusionan en ella con las mismas reglas que `dev`: revisión independiente aprobada, `redesign` fusionada en la rama del ticket, gate verde y fusiones de una en una. `dev` se fusiona en `redesign` cada vez que avanza. Al terminar, `redesign` entra en `dev` de una vez.
- Primer ticket, antes de cualquier pantalla: arreglar la demo web, que se cae al arrancar porque varios módulos se suscriben a los eventos `blur` y `focus` de `AppState`, que react-native-web no admite. Se arregla en un solo punto que usen todos, no en cada módulo.
- Ejecución orquestada con herdr: la base en serie y después los grupos de pantallas en paralelo.

### Tokens y sistema

- Los tokens se actualizan a los valores de K-1, en claro y oscuro. Cambian, entre otros, el texto terciario, el texto naranja, verde y rojo sobre claro, la tinta, el campo y la línea del oscuro, y se añade el panel de lista de tablet. Los nombres existentes se conservan donde el significado no cambia.
- Se añaden las escalas de tipografía (Hanken: 28/700, 20/800, 16/700, 15/600, 13/400; Martian Mono: 9,5/600 de etiqueta, 11 de datos, 20/600 de lecturas, 28–34 de número grande), espaciado, radios y alturas tocables (48, y 44 en las teclas de la terminal). Ningún texto baja de 9,5.
- Componentes compartidos nuevos o rehechos:
  - encabezado de pantalla (A raíz; B detalle con retorno nombrado; variante herramienta);
  - tecla con su pulsación;
  - hoja con cierre por arrastre;
  - toast;
  - estado de pantalla (bloque grande) y estado en línea (fila compacta);
  - arrastrar para recargar;
  - fila deslizable;
  - barra de pestañas desplazable con insignia;
  - riel de tablet;
  - borde redimensionable.
- Textos de estado unificados: error genérico «No se pudo <verbo>. Reintenta.»; «Reintentar» como única etiqueta de reintento; cargando con «…»; «SIN RESPUESTA · <qué hacer>». Retornos «‹ <padre>». Botones en oración salvo las etiquetas mono.

### Maquinaria y luz

- Primitivas compartidas, con los valores exactos de S-15:
  - foquitos analógicos (13 lentes, ciclo de 3,2 s, retraso desde el centro);
  - barrido (1,6 s naranja para Turno en curso, 1 s rojo para espera de Decisión; uno principal por pantalla, siempre dentro de una pantalla empotrada);
  - caja de voz;
  - aguja (arco de 100°, 9 marcas; oscilación de ±2° solo donde el valor es vivo);
  - tornillos;
  - regla grabada (como máximo una por pantalla);
  - cuentakilómetros (cifras que ruedan en 280 ms);
  - tira de 6 LEDs de la tecla que se mantiene;
  - pantalla empotrada con scanlines y borde luminoso.
- Animación y gestos con reanimated y gesture-handler, que ya están instalados y hasta ahora no se usaban. Las animaciones corren en el hilo nativo, con un reloj compartido para las piezas repetidas, de modo que muchas filas no multipliquen el trabajo.
- Política de movimiento: todo anima mientras la pantalla está visible. Se para con la app en segundo plano o la pantalla apagada. Con «reducir movimiento», cada pieza queda en su posición de reposo descrita en S-15.
- Qué enciende cada pieza (los estados reales que la mueven):
  - foquitos y barrido: Agente con Turno en curso (naranja) o esperando una Decisión (rojo);
  - caja de voz: llega texto del Agente dentro de la Conversación (no en la lista);
  - aguja de ACTIVIDAD: segundos del paso en curso;
  - agujas del Servidor: métricas;
  - cuentakilómetros: uptime.

### Navegación (ADR 0007)

- Teléfono: ocho pestañas en el orden fijado. Herram., Tablero, Trabajo y Tareas son pestañas, ya no rutas sueltas por Servidor.
- El Servidor elegido es estado de la app y se guarda entre sesiones:
  - por defecto, el predeterminado;
  - si deja de responder, sigue elegido;
  - si se quita, pasa al predeterminado o a ninguno;
  - las entradas externas (notificación, compartir, widget) lo fijan al Servidor de la entrada.
- Tablet: un solo marco para toda la app, con riel de 72/240 y lista más detalle. Sustituye los dos marcos actuales.
- Anchos de la lista: límites 280–560, el detalle con al menos 390, recordados por sección y con un valor por defecto por sección.
- Los retornos los calcula la navegación a partir del origen real. Una pantalla nunca escribe «Volver» a secas.

### Datos nuevos del Puente: capacidad `metrics`

- Capacidad aditiva `metrics`, anunciada en el mapa de capacidades de `/health` como las de V3, sin cambiar `PROTOCOL_VERSION`.
- Un endpoint autenticado devuelve, en una lectura, CPU total en %, memoria usada sin caché en % y disco usado en % del sistema de archivos que contiene el directorio de Hermes, más el instante de la medición según el reloj del Servidor.
- Las métricas se leen con lo que trae Node y el sistema, sin dependencias, detrás de una interfaz de lector de sistema que las pruebas sustituyen.
- La app solo consulta mientras la ficha del Servidor está visible, cada 5 s.
  - Si el Puente no anuncia `metrics`: «Actualiza el Puente para ver CPU, MEM y DISCO».
  - Si la lectura falla: se conserva la última, marcada como vieja.
- El log del Puente solo registra método, ruta y estado. Los errores no incluyen rutas del sistema de archivos.

### Adjuntar un archivo del Servidor

- En tablet, la Conversación puede abrir el panel Archivos a su lado. Arrastrar un archivo a la Conversación adjunta su ruta en el Servidor como referencia; no se copia contenido. Hermes corre en esa misma máquina y lo lee allí.
- El ticket empieza investigando cómo recibe Hermes esa referencia y si la respeta. Si la investigación muestra que no es viable, el ticket se detiene y se vuelve a decidir con Ale; no se sustituye en silencio por una copia.

### Aprobar

- «Aprobar» envía «una vez». «Para la sesión» es una tecla secundaria, solo si la Aprobación la ofrece. Rechazar envía el rechazo.
- Secuencia obligatoria: seguro, pulsación de 1 s con la tira de LEDs y huella. Si se suelta antes, no pasa nada.
- Si vence en cualquier punto de la secuencia, no se envía nada, se muestra VENCIDA y el seguro vuelve a ponerse. La comprobación de vencimiento se hace en el momento de enviar, no al empezar el gesto.
- La hoja se cierra sin decidir con la tecla atrás de Android, tocando fuera o arrastrando el asa más de 110 px. Cuando ya está decidida, vencida o falló el envío, muestra además «Cerrar». Mientras pide la huella o la decisión va de camino al Puente no se cierra, para no perder su resultado.
- Deslizar nunca aprueba ni borra.

### Gestos

- Agente →: abre la Conversación. No hay gesto hacia ←.
- Tarea →: pausa o reanuda. Tarea ←: «Ejecutar ahora», con confirmación.
- Aprobación →: abre la hoja.
- Tarjeta →: columna siguiente, saltando BLOQUEADO. En HECHO no hace nada.
- Umbral de 90 px y retorno con muelle. Cierre de hoja a 110 px. Recargar a 60 px.
- Tablet: arrastrar Tarjetas entre las cinco columnas. Si el destino es BLOQUEADO, se abre el selector de bloqueo y, si se cancela, la Tarjeta no se mueve.

### Funciones sin lienzo

- Se conservan todas: renombrar, borrar y buscar Conversaciones; corregir un Turno; modelo por Conversación; logs del Agente; detalle de Tarea con ejecuciones; detalle de Tarjeta con comentarios y bloqueos; pantalla de Aviso; revocar dispositivos.
- Los builders las adaptan con los componentes y la maquinaria del sistema nuevo, siguiendo el mapa de S-15 sobre qué lleva cada tipo de pantalla. El revisor aprueba la adaptación.

### Demo

- Cada pantalla, estado y pieza animada nueva tiene datos de demo: Servidor con y sin `metrics`, Turno en curso, espera de Decisión, Agente escribiendo, Tarea en ejecución, pausa y redimensionado en tablet.
- La demo pone a ops en homelab en todas las pantallas, también en el widget.

## Testing Decisions

- Una buena prueba comprueba lo que la persona ve y hace (textos visibles, toques, gestos y lo que se envía al Puente), no la estructura de componentes ni los estilos. Una prueba de pantalla busca el estado por su texto o su rol y falla si el estado desaparece.
- **Componentes (la principal):**
  - Monta las pantallas reales, AppProvider, los hooks y las decisiones de core reales. Hay dobles solo en los límites, según la ADR 0003.
  - Cubre:
    - las ocho pestañas e insignia;
    - el Servidor elegido y sus reglas;
    - los retornos y la tecla atrás;
    - las entradas externas;
    - la hoja TAILNET;
    - Aprobar completo;
    - los gestos de fila y recargar;
    - riel, redimensionado y arrastre de archivo en tablet;
    - foco de panel;
    - «reducir movimiento» y la parada en segundo plano;
    - estados unificados.
  - Precedente: las pruebas de componentes de V3 sobre Herramientas en dos paneles y foco de teclado.
- **Doble nuevo en el soporte de pruebas:** reanimated y gesture-handler, tratados como límite nativo, que permiten simular arrastre, pulsación larga y el paso del tiempo de animación con el reloj ya simulado. Ninguna prueba depende de tiempos reales.
- **Lógica pura (`node --test`):**
  - límites de ancho y memoria por sección;
  - columna siguiente;
  - escala de la aguja;
  - qué estado enciende foquitos o barrido;
  - validación de la respuesta y del anuncio de `metrics`;
  - política del Servidor elegido.
  - Precedente: la lógica de capacidades remotas y de la disposición de tablet.
- **Puente:**
  - el endpoint de `metrics` y su anuncio en `/health`, con el lector de sistema falso;
  - una lectura que falla da un error sin rutas;
  - el log no registra valores.
  - Precedente: las pruebas del Puente contra el Hermes falso.
- **Mutación obligatoria** (romper a propósito, confirmar el rojo, restaurar) en:
  - la opción enviada al aprobar (una vez frente a sesión);
  - el vencimiento comprobado al enviar;
  - el seguro y la pulsación;
  - la pulsación de la Pausa general;
  - «Ejecutar ahora» con confirmación;
  - deslizar nunca aprueba;
  - las unidades de tiempo del uptime y de la aguja (segundos frente a milisegundos);
  - `metrics` sin secretos ni rutas en el log ni en los errores.
- **Fidelidad visual:** capturas de la demo en teléfono y tablet, en claro y oscuro, con el script de capturas. El revisor las compara con el lienzo en cada ticket de pantalla. No es una prueba automática.
- El gate completo pasa en cada fusión a `redesign`. El APK se prueba en el teléfono y en la tablet en los tickets de gestos, animación y tablet.

## Out of Scope

- Silenciar los avisos de un Agente, y el gesto de deslizar hacia ← sobre un Agente.
- Métricas de Hermes o por proceso, o de otros discos. Las métricas son de la máquina entera y del disco de Hermes.
- Medidas que Hermes no entrega: carga del Turno, tokens por segundo y código de salida de un paso.
- La caja de voz en la lista de Agentes.
- Copiar el contenido de un archivo del Servidor al adjuntarlo.
- Cambiar la versión del protocolo.
- Interruptor en Ajustes para apagar la animación.
- iPhone y iPad nativos, y otros tamaños de tablet aparte del dibujado y los que ya contempla la disposición actual.
- Funciones nuevas que el rediseño no dibuja.

## Further Notes

- El README del handoff propone Jetpack Compose. No aplica: la app es Expo/React Native y el rediseño se construye con sus primitivas y tokens.
- Pendientes que deja el propio handoff y quedan resueltos aquí:
  - ops vive en homelab;
  - CPU y MEM son datos reales de `metrics`;
  - los Modos de aprobación son manual, smart y off; si la configuración del Agente no fija uno, se muestra el que Hermes trae por defecto, leído de Hermes, o desconocido y de solo lectura si no se puede leer.
- Los tokens por segundo del handoff no tienen dato y no se muestran.
- El barrido del selector de Servidor del riel usa el mismo criterio que el de los Agentes: naranja si alguno de sus Agentes tiene un Turno en curso, rojo si alguno espera una Decisión.
