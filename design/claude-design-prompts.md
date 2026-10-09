# Prompts para Claude Design

Prompts para diseñar las pantallas que le faltan a Relay, en el mismo proyecto de Claude Design
donde vive `Relay Instrumento.dc.html`. Pega primero el **prompt base** (una sola vez por
conversación) y después el de la pantalla que quieras.

Cubren todas las funciones que entraron a la búsqueda. Cuáles llegan a v1 se decide después; diseñar
una pantalla aquí no la compromete.

Cada prompt dice qué datos existen de verdad. Es deliberado: el primer prototipo mostraba datos que
Hermes no entrega (motivo de una aprobación, archivos afectados) y hubo que esconderlos.

---

## Prompt base

```
Trabaja sobre el estilo "Instrumento (4b)" de Relay Instrumento.dc.html, sin cambiarlo: bloques
táctiles claros (#ECEAE5 sobre #D8D5CE), pantallas oscuras empotradas (#161615) con scanlines y
acentos neón, Hanken Grotesk para texto y Martian Mono para etiquetas y datos, y el indicador
ON / BUSY / ERR en cada agente. Naranja #F29A1A es acción y espera; verde #4CC774 es sano; rojo
#E5533D es fallo.

Relay es una app de teléfono para operar agentes de Hermes que ya existen y corren en máquinas del
usuario, alcanzadas por Tailscale. Vocabulario fijo: Agente (un perfil de Hermes), Servidor (la
máquina donde corre Hermes), Aprobación (la decisión de una persona sobre un comando retenido).

Reglas para todo lo que diseñes:
- Marco de teléfono de 390x844 igual al del archivo, con la misma barra de pestañas de cuatro
  bloques (AGENTES, APROB., SERVIDORES, AJUSTES) cuando la pantalla sea una pestaña.
- Textos en español, etiquetas mono en mayúsculas.
- Dibuja siempre los estados: cargando, vacío, error y sin conexión, además del estado normal.
- No inventes datos. Cada pantalla dice qué datos existen; si un dato no está en la lista, no lo
  muestres.
- Los nombres largos se recortan con puntos suspensivos; nada se parte en dos líneas por accidente.
- Añade las pantallas como lienzos nuevos numerados a partir de 07, en un archivo nuevo
  "Relay Instrumento 2.dc.html", sin tocar las seis existentes.
```

---

## 07 · Bandeja de aprobaciones (pestaña APROB.)

```
Diseña la pestaña APROB. La pestaña ya existe en la barra, pero nunca se dibujó su pantalla.

Contenido:
- Arriba, las aprobaciones pendientes. Cada una: Agente, Servidor, el comando en mono, cuenta
  regresiva de expiración (EXPIRA 4:32) y nivel de riesgo de 1 a 5 si se conoce. Tocarla abre la
  hoja de aprobación que ya existe (pantalla 04).
- Debajo, un historial de decisiones recientes. Hay tres orígenes y deben distinguirse de un
  vistazo: aprobada o rechazada por la persona, aprobada o negada por el guardián automático de
  Hermes (un modelo que decide solo los casos de bajo riesgo), y expirada sin respuesta.
- Un filtro por Agente y por origen.

Datos que existen por aprobación: agente, servidor, comando, descripción de la regla que lo marcó,
nivel de riesgo, hora de creación, hora de expiración, decisión y quién decidió.
No existen: motivo redactado por el agente, lista de archivos afectados, tamaño.

Estados: sin pendientes (que se sienta como "todo en orden", no como pantalla rota), solo
historial, y servidor sin respuesta.
```

## 08 · Lista de servidores

```
Diseña la pantalla a la que lleva "‹ Servidores" desde la pantalla 05. Es una lista de Servidores.

Por Servidor: nombre, dirección, estado (en línea con latencia en ms, sin respuesta con "último
contacto hace 9 h"), versión de Hermes, número de Agentes, si es el predeterminado, y si llegas
por Tailscale o por conexión directa.
Acciones: abrir el Servidor, agregar uno nuevo, marcar predeterminado, quitar (con confirmación).

Estados: un solo Servidor (que no se vea vacío), varios, y ninguno alcanzable.
```

## 09 · Conversaciones de un Agente

```
Diseña la pantalla de conversaciones de un Agente. Hoy el chat siempre continúa la última
conversación y no hay forma de empezar otra.

Contenido:
- Botón claro de "Conversación nueva".
- Lista de conversaciones, la más reciente arriba. Por conversación: título, primera línea del
  último mensaje, fecha, de dónde vino (la app, Discord, una tarea programada, la terminal) y
  cuántos mensajes tiene.
- Búsqueda por texto.
- Sobre una conversación: continuar, renombrar, bifurcar (crear una copia desde ese punto para
  probar otro camino) y borrar con confirmación.

Decide dónde vive: como pantalla entre la lista de Agentes y el chat, o como panel que se abre
desde el encabezado del chat. Dibuja las dos opciones lado a lado.

Estados: Agente sin conversaciones, búsqueda sin resultados, cargando.
```

## 10 · Chat, segunda versión

```
Amplía la pantalla 03 (chat con un Agente). Conserva lo que ya tiene: burbuja del usuario, texto
del agente, panel ACTIVIDAD, bloque de terminal, bloque de diff y compositor.

Añade y dibuja cada estado:
1. Mientras el Agente trabaja: el botón naranja del compositor se vuelve DETENER. Junto a él, una
   forma de REDIRIGIR: escribir una instrucción que el Agente recibe sin detener lo que hace.
2. Adjuntar una imagen (cámara o galería). Solo imágenes: Hermes no acepta otros archivos. Muestra
   la miniatura en el compositor y en la burbuja enviada.
3. Dictado: mantener pulsado el micrófono, con nivel de voz en vivo y texto transcrito antes de
   enviar.
4. Archivos que el Agente produjo (un documento, una imagen): tarjeta con nombre, tipo y tamaño,
   que se puede abrir o compartir.
5. Markdown completo en el texto del Agente: títulos, listas, tablas, citas, enlaces y bloques de
   código con botón de copiar.
6. Un comando fallido muestra su bloque de terminal en rojo; los exitosos se quedan dentro de
   ACTIVIDAD. Un turno de más de seis pasos llega plegado.
7. Cuando el guardián automático aprobó un comando, márcalo en la fila de ACTIVIDAD
   (por ejemplo "AUTO") para que se distinga de uno aprobado por la persona.
8. Sin conexión con el Servidor a mitad de una respuesta: qué se ve y cómo se reintenta.
9. Chat no disponible (el Servidor tiene apagada la función): aviso y compositor desactivado.

Datos por paso de ACTIVIDAD: herramienta, argumento corto, duración, estado, y hasta 500
caracteres del resultado. No existe el resultado completo de comandos largos.
```

## 11 · Actividad (bitácora global)

```
Diseña una pantalla de Actividad: la línea de tiempo de todo lo que hicieron todos los Agentes,
sin entrar a cada chat.

Cada entrada: hora, Agente, Servidor, qué pasó y resultado. Tipos de entrada: mensaje recibido
(con su origen: app, Discord, tarea programada), comando ejecutado (con si falló), aprobación
pedida o resuelta, tarea programada terminada, error del Agente, Servidor que se cayó o volvió.

Agrupa por día. Filtros por Agente, por tipo y "solo fallos". Tocar una entrada lleva a la
conversación en ese punto.

Decide dónde vive: ¿quinta pestaña, sección dentro de AGENTES, o reemplazo de alguna pestaña?
Dibuja tu recomendación y una alternativa. La barra actual tiene cuatro bloques y no debería
quedar apretada.

Estados: día sin actividad, cargando más al hacer scroll, sin conexión.
```

## 12 · Tablero

```
Diseña el Tablero de un Servidor: un panel de tarjetas que los propios Agentes arman y mantienen.
El usuario le pide a un Agente en el chat "agrega al tablero el estado de mis backups" y la tarjeta
aparece; una tarea programada puede refrescarla sola.

Reglas del concepto:
- Un Tablero por Servidor. Cada tarjeta pertenece a un Agente y muestra cuál.
- Cada tarjeta dice cuándo se actualizó por última vez y se ve distinta si está vieja.
- El usuario puede reordenar, ocultar y quitar tarjetas, y pedir que una se refresque ahora.

Diseña una familia de tarjetas nativas en estilo Instrumento que un Agente pueda elegir:
1. Dato grande con etiqueta y tendencia (por ejemplo "82 % disco").
2. Medidor de segmentos, como el de riesgo de la pantalla 04.
3. Lista de estados con LED (como el Diagnóstico de la pantalla 05).
4. Serie temporal pequeña sobre pantalla oscura.
5. Registro de líneas (como los Logs).
6. Texto libre corto.
7. Botón de acción que manda un mensaje predefinido al Agente.
8. Un bloque web: una ventana con contenido que el Agente escribió libremente, para lo que las
   demás no cubren. Que se note que es contenido del Agente y no de la app.

Dibuja el Tablero con seis tarjetas mezcladas, el modo de edición, la tarjeta vieja, la tarjeta
con error, y el Tablero vacío con una sugerencia de qué pedirle a un Agente.
```

## 13 · Ficha del Agente

```
Diseña la ficha de un Agente, a la que se llega desde su fila o desde el encabezado del chat.

Secciones:
- Identidad: nombre, avatar (imagen con la trama de puntos del estilo), Servidor, estado
  ON / BUSY / ERR.
- Modelo: modelo y proveedor actuales, con selector para cambiarlo.
- Memoria: lo que el Agente recuerda del usuario, como lista de notas que se pueden leer, editar
  y borrar una por una.
- Herramientas: grupos de herramientas (terminal, archivos, web, navegador) con interruptor, y si
  cada una está configurada.
- Skills: lista con nombre, descripción y categoría, con interruptor.
- Uso: tokens y costo de hoy y de los últimos siete días.
- Conversaciones recientes, con acceso a la lista completa.

Estados: Agente en un Servidor sin respuesta (todo en solo lectura, con lo último conocido).
```

## 14 · Uso y costo

```
Diseña una pantalla de uso y costo.

Contenido: costo estimado de hoy, de la semana y del mes; reparto por Agente y por modelo; tokens
de entrada, de salida y leídos de caché; una serie diaria de los últimos 30 días sobre pantalla
oscura; y los límites de la cuenta del proveedor cuando existan (ventana, porcentaje usado, cuándo
se reinicia).

Deja claro que el costo es una estimación. Estados: proveedor que no informa costo (solo tokens),
sin datos todavía.
```

## 15 · Tareas programadas

```
Amplía la sección "Tareas programadas" de la pantalla 05 a pantallas propias.

Lista: nombre, Agente, horario en lenguaje humano además de la expresión ("de lunes a viernes a
las 9:00" y "0 9 * * 1-5"; algunas son de intervalo, "cada 5 min"), próxima ejecución, y si está
activa o pausada.

Detalle: lo que la tarea le pide al Agente, a dónde entrega el resultado, e historial de
ejecuciones con hora, duración y si falló. Acciones: ejecutar ahora, pausar o reanudar, editar,
borrar con confirmación.

Crear y editar: nombre, Agente, instrucción, horario (con atajos: cada hora, diario, días
laborables, semanal, y expresión manual) y destino del resultado.

Estados: sin tareas, tarea que falló la última vez, lista de veinte tareas.
```

## 16 · Trabajo entre Agentes (kanban)

```
Diseña un tablero kanban para repartir trabajo entre Agentes, adaptado a un teléfono.

Columnas: por hacer, en curso, bloqueada, hecha. Por tarjeta: título, Agente asignado, comentarios
y enlaces a otras tarjetas. Acciones: crear, asignar a un Agente, mover de columna, comentar.

En 370 px de ancho no caben cuatro columnas: propón cómo se navega (una columna por pantalla con
deslizamiento, o lista agrupada) y dibuja tu recomendación.

Estados: tablero vacío, columna con muchas tarjetas.
```

## 17 · Control de emergencia

```
Diseña dos cosas pequeñas de control.

1. Botón de pánico: pausa de golpe todo lo que hacen todos los Agentes de un Servidor (turnos
   nuevos, tareas programadas, trabajo repartido). Debe ser alcanzable rápido pero imposible de
   pulsar sin querer. Dibuja dónde vive, la confirmación, el estado "EN PAUSA" visible en toda la
   app mientras dure, y cómo se reanuda.

2. Confirmación para "Detener" y "Reiniciar" el gateway en la pantalla 05. Hoy se ejecutan de un
   toque. Detenerlo apaga también el chat y las aprobaciones; la confirmación debe decirlo.
```

## 18 · Fuera de la app: notificaciones, compartir y widget

```
Diseña lo que Relay muestra fuera de la app, en Android.

1. Notificación de aprobación pendiente: Agente, comando, y botones Aprobar y Rechazar en la
   propia notificación. Aprobar pide huella. Versión plegada y expandida.
2. Notificaciones de tarea terminada, de Agente con error y de Servidor sin respuesta.
3. Hoja de compartir: desde otra app se comparte un texto, un enlace o una imagen hacia Relay.
   Diseña el selector de Agente y un campo para añadir una instrucción.
4. Widget de pantalla de inicio en dos tamaños: estado de los Agentes con sus LED y número de
   aprobaciones pendientes.

Usa el lenguaje visual de Instrumento hasta donde el sistema lo permite; en la notificación manda
el sistema operativo, así que cuida sobre todo el texto.
```

## 19 · Transversales

```
Completa lo que falta en todas las pantallas.

1. Tema oscuro. Instrumento es claro con pantallas oscuras empotradas; define la paleta inversa
   para que las pantallas empotradas sigan distinguiéndose del fondo. Aplícala a las pantallas 02,
   03 y 05.
2. Pantalla de bloqueo con huella o rostro, y el aviso de bloqueo automático.
3. Selector de "Bloqueo automático" (ahora, 1 min, 5 min, 15 min).
4. Tablet de 11 pulgadas en horizontal: dos paneles, lista a la izquierda y detalle a la derecha,
   para Agentes con chat y para Servidores.
5. Avatares de Agente: seis propuestas en el estilo de grabado con trama de puntos, para que no
   todos sean un cuadro negro.
6. Icono de la app y pantalla de arranque a partir de la píldora de tres puntos del logotipo.
```
