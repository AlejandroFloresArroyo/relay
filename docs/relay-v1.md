# Relay v1: especificación

Qué entra en Relay v1, qué queda para después y qué decisiones de arquitectura están cerradas. Es
el destino del mapa [Relay v1: de prototipo a app instalable][mapa].

Cómo leerlo:

- Cada decisión enlaza el ticket que la tomó. El detalle y la evidencia viven ahí; este documento
  no los repite.
- **Sin comprobar** marca lo que la especificación da por posible sin haberlo probado. La lista
  completa está en la [sección 7](#7-sin-comprobar).
- **Decidido al registrar** marca detalles que nadie decidió con Ale y que se fijaron al escribir.
  Están juntos en la [sección 8](#8-decidido-al-registrar). Lo que nadie ha decidido todavía está
  en la [sección 10](#10-sin-decidir).
- El vocabulario (Agente, Servidor, Puente, Conversación, Turno, Tablero, Tarjeta, Pausa general,
  Aprobación, Decisión, Guardián, Modo de aprobación) está en [`CONTEXT.md`](../CONTEXT.md).
- Algunos detalles de pantalla salen de los prompts de diseño
  ([`design/claude-design-prompts.md`](../design/claude-design-prompts.md)) y los de Hermes, del
  inventario (`docs/research/hermes-inventory.md`, en la rama `research/hermes-inventory`).

Estado al 2026-10-02: Hermes Agent 0.21.5, Expo SDK 57, Galaxy S23 con Android 16.

## 1. Alcance

**Relay v1 es la app de Android con la que Ale opera sus Agentes de Hermes por Tailscale, en lugar
de Discord y la terminal.** Ese es el criterio del corte: entra lo que se usa a diario
([Hacer el corte de Relay v1][t14]).

Fuera de alcance, por decisión de Ale:

- Relay Negocio (equipos, conocimiento, cuotas): es otro proyecto.
- iPhone y publicación en tiendas.
- Onboarding, cuentas y soporte para terceros. El emparejamiento y la instalación del Puente
  entran en v1 pensados para Ale y sus Servidores; facilitárselo a otros sigue fuera.
- Contestar desde Relay aprobaciones de Turnos que no inició (Discord, terminal).
- Reescribir la app en nativo, en otro framework, o en React Native sin Expo.

## 2. Arquitectura cerrada

### 2.1 La app

- Mismo código Expo / React Native del prototipo, compilado en la máquina de Ale con
  `expo prebuild` y Gradle. Sin cuenta de Expo ni EAS ([Decidir cómo se compila y se actualiza el
  APK][t10]).
- Identificador `io.github.alejandrofloresarroyo.relay`. Firma con llave propia, fuera del repo
  (`~/.config/relay/`). Perderla obliga a desinstalar.
- Las versiones nuevas se instalan por cable con `adb install -r`, que conserva los datos.
- El desarrollo se hace con una compilación propia, "Relay Dev", con su propio identificador e
  instalada junto a Relay. Expo Go se deja de usar: el dictado trae un módulo nativo que no
  incluye.
- Comprobado: el APK compila, se firma y se instala en el S23 ([Sacar un primer APK de
  Relay][t15]).

### 2.2 La conexión

- HTTP plano, permitido en la app solo para nombres `*.ts.net`. El cifrado es el de Tailscale. Ni
  HTTPS ni `tailscale serve` ([Decidir cómo se conecta el teléfono al Puente y cómo queda
  corriendo el Puente][t11]).
- Solo valen nombres de tailnet (`<máquina>.<tailnet>.ts.net`). La IP y el nombre corto quedan
  bloqueados por Android, y la app lo dice.
- v1 solo admite Servidores por Tailscale.
- Comprobado: el APK habla con el Puente por la tailnet y el chat real responde ([Conectar el APK
  por la tailnet y dejar el Puente permanente][t18]).

### 2.3 Tailscale

- Relay solo lo detecta: sabe que llega por la tailnet porque el Puente reconoce al dispositivo.
  No lo enciende, no lo configura y no crea ninguna VPN.
- La app de Tailscale para Android no expone a otras apps ni la lista de equipos ni su estado
  ([Investigar qué puede saber Relay de Tailscale en Android][t27]). Por eso el
  autodescubrimiento pasa por un Puente ya emparejado (2.5).

### 2.4 El Puente

- Un servicio pequeño (`bridge/`, Node sin dependencias) que corre junto a Hermes y es lo único con
  lo que habla la app.
- Escucha directo en la IP de Tailscale del Servidor. Es un servicio de usuario de systemd,
  habilitado al arranque y con reinicio automático. Corre del checkout de trabajo: tras cambiar su
  código hay que reiniciarlo a mano.
- Llega a Hermes por tres vías ([Inventario de lo que Hermes ya ofrece para las funciones
  candidatas][t5]): el API server (`127.0.0.1:8642`, una llave por Agente), la CLI `hermes`, y los
  archivos del perfil (`state.db`, `config.yaml`, memoria). El dashboard de Hermes no se usa.
- Ejecuta la CLI sin shell, con argumentos fijos. Su log guarda método, ruta y estado; nunca
  cuerpo ni cabeceras.
- Reiniciarlo vacía las Aprobaciones pendientes y los Turnos que tenía en memoria.
- Trae un aviso por ntfy que se queda en el código, apagado y sin interfaz en la app.
- Hermes es el sistema en producción de Ale: quien construya Relay no cambia su configuración de
  seguridad ni reinicia el gateway sin pedírselo.

### 2.5 Emparejamiento y llaves

Decidido en [Decidir qué puede hacer el Puente en el Servidor y qué pide huella][t22].

- **Punto de partida.** Quien presenta una llave válida puede chatear con un Agente que tenga el
  Modo de aprobación en `off` y terminal: equivale a ejecutar comandos en el Servidor. La huella la
  comprueba el teléfono, no el Puente.
- Basta una llave válida, desde cualquier dispositivo de la tailnet. No hay lista de dispositivos
  por nombre de Tailscale ni peticiones firmadas.
- **La llave es por dispositivo y nace de un emparejamiento.** Un comando en el Servidor muestra un
  código QR con la dirección del Puente y un código de un solo uso que caduca en minutos. El
  teléfono lo escanea y lo canjea por una llave propia. Como respaldo, dirección y código se pueden
  escribir a mano.
- El Puente lleva la lista de dispositivos emparejados y revoca uno sin afectar a los demás. No
  hay procedimiento de rotación aparte: un teléfono perdido, o usado en una red ajena con Tailscale
  apagado, se revoca y se empareja de nuevo. La llave compartida `RELAY_KEY` desaparece.
- Tras varios intentos fallidos seguidos desde una IP, el Puente la ignora unos minutos y lo
  anota. Vale para llaves y para códigos.
- **Instalación.** Un comando en el Servidor genera lo necesario, instala el servicio y muestra el
  QR.
- **Autodescubrimiento.** Un Puente ya emparejado busca otros Puentes en la tailnet y la app los
  ofrece. Cada uno pide su propio emparejamiento.

### 2.6 Qué registra el Puente

- Un registro propio de cambios: fecha, dispositivo, qué cambió, sin el contenido.
- La versión anterior de cada archivo que sobrescribe (memoria, `SOUL.md`).
- Verlo desde la app queda para después, con Actividad.

### 2.7 Versiones de la app y del Puente

Se actualizan por separado y pueden quedar en versiones distintas ([Decidir qué pasa cuando la app
y el Puente quedan en versiones distintas][t29]).

- App y Puente llevan versiones independientes; el número de compilación Android crece en cada
  actualización. Su numeración se delega al constructor (decidido con Ale, 2026-10-04).
- El Puente declara un número de versión de protocolo y la app lo compara al conectar.
- Si el Puente es más viejo de lo que la app necesita, la app dice "Actualiza el Puente"; si la app
  es más vieja, "Actualiza Relay".
- El aviso no bloquea: sigue funcionando lo que sí coincide.

## 3. Funciones de v1

### 3.1 Agentes

- La lista de Agentes de cada Servidor con su estado (ON, BUSY, ERR) y su último mensaje. Ya
  existe en el prototipo.
- Tocar un Agente abre su Conversación más reciente.

### 3.2 Conversaciones

Decidido en [Decidir cómo se manejan las conversaciones en el chat][t9].

- El título de la Conversación, en el encabezado del chat, abre un panel con la lista.
- Se ven todas las Conversaciones interactivas del Agente, vengan de donde vengan. Solo se escribe
  en las nacidas en Relay; las demás se abren en solo lectura, con un aviso de dónde nacieron.
- Las de fondo (tareas programadas, subagentes) quedan tras un filtro, apagado por defecto.
- Acciones: nueva, continuar o abrir, renombrar, y borrar con una confirmación que dice cuántos
  mensajes se pierden.
- Búsqueda en títulos y en el texto de los mensajes.
- Los mensajes que no salen del chat (botón de acción del Tablero, sugerencias) abren siempre una
  Conversación nueva.

Qué pide: Hermes ya lista, crea, renombra y borra (`/api/sessions`). El título es único y de 100
caracteres como máximo. La búsqueda de texto la hace el Puente sobre `state.db`.

### 3.3 Chat

- **Detener un Turno.** Ya funciona.
- **Redirigir sin detener.** Una instrucción que el Agente recibe sin parar lo que hace. Qué pide:
  `POST /v1/runs/{id}/steer` y el evento `run.steered` en el Puente. Solo vale con el Turno en
  marcha; lo que no se entregó vuelve y hay que reenviarlo.
- **Markdown completo** en el texto del Agente.
- **Modelo por Conversación.** El encabezado del chat muestra el modelo; tocarlo abre la hoja
  "MODELO DE ESTA CONVERSACIÓN" ([Conciliar el diseño con el corte de v1][t23]), con búsqueda por
  nombre o identificador y filtro por proveedor que se pueden combinar. El modelo por
  defecto del Agente se ve en su ficha, en solo lectura. Qué pide: Hermes acepta el modelo por
  Turno y por Conversación, y da el catálogo en `GET /api/model/options`.
- **Adjuntar imagen.** Solo imágenes. Comprobado: `POST /v1/runs` acepta una parte `image_url` con
  data URL y el Agente la ve ([Probar imágenes en el chat][t21]). Consecuencias:
  - Hermes no guarda la imagen en la Conversación, solo el texto. La miniatura de la burbuja sale
    de una copia en el teléfono.
  - La petición tiene un tope de 10 MB: las fotos se reducen antes de enviarlas.
  - El Puente hoy solo pasa texto; hay que ampliar la petición y el protocolo.
- **Archivos que produce el Agente**, de cualquier tipo, con abrir y compartir. El Puente solo
  sirve un archivo que un Agente anunció en un mensaje de esa Conversación y que pasa la
  validación por defecto de Hermes (`validate_media_delivery_path`). Tope de 50 MB. Estados:
  descargando, demasiado grande, ya no está en el Servidor.
- **Dictado**, solo en el dispositivo: el audio no sale del teléfono ([Probar el dictado en el
  S23][t25]).
  - Módulo `expo-speech-recognition`, exigiendo reconocimiento en el dispositivo. El idioma es
    `es-US`: es el único español instalado en el S23 y `es-MX` no existe.
  - Se mantiene pulsado el micrófono. No hay medidor de nivel: en ese modo no llega el dato. La
    señal de que escucha es el texto parcial.
  - Al soltar, Relay sigue escuchando cerca de un segundo antes de cerrar. Si aun así no llega el
    resultado final, usa el último parcial. Una frase con pausa llega en trozos que hay que unir.
  - Si falta el modelo de voz, el micrófono lo dice y no graba. Para cumplirlo hay que consultar
    los idiomas instalados antes de empezar: sin esa consulta el micrófono se abre unos 100 ms.
  - Sin permiso de micrófono, lo dice y ofrece abrir los ajustes.
- **Estados:** sin conexión a mitad de una respuesta, y chat no disponible en el Servidor.

### 3.4 Aprobaciones

Decidido en [Decidir qué papel juega Relay en las aprobaciones][t8] y comprobado en [Probar en
vivo el cambio de modo y la hoja de aprobación][t16].

- **El Guardián decide y Relay supervisa.** La hoja de aprobación aparece cuando un comando de un
  Turno de Relay queda retenido para una persona: con el Agente en `manual`, o en `smart` cuando el
  Guardián duda o niega.
- **La hoja** muestra comando, cuenta regresiva (5 minutos), riesgo y regla que lo marcó, y los
  botones Rechazar y Aprobar. Aprobar pide huella; rechazar no. Hermes nunca envía motivo ni
  archivos afectados. Hermes ofrece también aprobar "siempre"; la app no lo muestra.
- **El interruptor "Permitir comandos similares en este turno"**, apagado por defecto. Hermes
  recuerda ese permiso por Turno, no por Conversación. Ale quiere que valga para toda la
  Conversación: queda para después (sección 5).
- **APROB. es un registro de Decisiones:** arriba las Aprobaciones pendientes, debajo lo decidido,
  distinguiendo quién decidió (la persona, el Guardián, o expiró). Relay ve en vivo solo sus
  propios Turnos. De los demás canales solo tiene el historial de la base de Hermes: comandos
  ejecutados y lo que el Guardián aprobó. No ve sus Aprobaciones pendientes ni lo que el Guardián
  negó en ellos.
- **Modo de aprobación por Agente** (`manual`, `smart`, `off`), visible y cambiable. Un Agente en
  `off` se ve como tal. Subir la protección es libre; bajarla pide huella y una confirmación que
  dice qué implica. El cambio se aplica al siguiente Turno, sin reiniciar el gateway. Qué pide:
  `hermes -p <agente> config set approvals.mode <modo>`. Relay guarda el cambio pendiente y lo
  aplica antes del siguiente Turno que inicie. Hermes lee ese valor durante el trabajo: al
  aplicarlo, otros canales activos pueden notar el nuevo modo. La ficha muestra esta limitación
  (decidido con Ale, 2026-10-04).
- **Reglas de bloqueo** (comandos siempre negados): visibles y editables. Añadir es libre; quitar
  pide huella y confirmación. Siguen activas con el Modo de aprobación en `off`.
- **Política del Guardián:** solo lectura.
- Una Aprobación que expira sin respuesta se niega sola. Al expirar, la app tiene que decirlo con
  sus palabras: hoy solo muestra el paso en rojo.

### 3.5 Ficha del Agente

- **Identidad y avatar.** Los avatares se asignan solos; no hay pantalla para cambiarlos
  ([Conciliar el diseño con el corte de v1][t23]).
- **Modelo por defecto**, en solo lectura.
- **Memoria:** leer, editar y borrar nota por nota. Borrar pide confirmación. Hermes puede incorporar los cambios cuando reconstruye el contexto, incluso en una
  Conversación existente. La pantalla muestra esta limitación (decidido con Ale, 2026-10-04). Qué pide: el Puente lee y escribe `memories/MEMORY.md` y `USER.md` del
  perfil.
- **Personalidad:** leer y editar `SOUL.md`. Guardar pide huella. Hermes puede incorporar los
  cambios cuando reconstruye el contexto, incluso en una Conversación existente; Relay lo indica.
- **Herramientas**, editables solo para el chat de Relay: no cambia lo que el Agente usa en Discord
  o en la terminal. Encender pide huella; apagar es libre; una herramienta sin configurar no se
  puede encender. Qué pide: `hermes -p <agente> tools enable|disable <herramienta> --platform
  api_server`; el estado se lee de `GET /v1/toolsets`. El cambio puede aplicarse al siguiente Turno del chat de Relay, incluso dentro de una
  Conversación existente, sin reiniciar el gateway. Relay muestra esta limitación (decidido con
  Ale, 2026-10-04). El primer cambio escribe en la configuración del perfil la
  lista de herramientas de ese canal.
- **Skills:** solo lectura. `GET /v1/skills` devuelve error 500 en esta versión de Hermes; el
  listado tendría que salir de la CLI (`hermes skills list`).
- **Uso del Agente:** tokens y costo estimado de hoy y de los últimos siete días.
- **Estado sin respuesta:** todo en solo lectura, con lo último conocido.

### 3.6 Servidor

- **Lista de Servidores**, con agregar (emparejar), marcar predeterminado y quitar. Debajo, los
  Puentes encontrados en la tailnet y sin emparejar.
- **Tablero**, uno por Servidor, con siete tipos de Tarjeta nativa: dato grande, medidor de
  segmentos, lista de estados, serie temporal, registro de líneas, texto libre y botón de acción
  ([Prototipar el Tablero: tarjetas nativas contra bloque web][t13]). Cada Tarjeta muestra su
  Agente y cuándo se actualizó, y tiene estados: nueva, actualizando, vieja y fallida. Se pueden
  reordenar, ocultar y quitar. El Tablero vacío sugiere qué pedirle a un Agente. Por dónde publica el Agente
  sus Tarjetas queda para quien lo construya; en cualquier caso el Puente valida lo que sirve
  y no sigue enlaces simbólicos ([Investigar cómo un Agente puede publicar y mantener un
  Tablero][t7]).
- **Tareas programadas:** lista, detalle, historial, crear, editar, borrar, pausar, reanudar y
  ejecutar ahora. Crear, editar y ejecutar ahora piden huella. Modelo, directorio y script de una tarea se ven pero
  no se editan. Qué pide: Hermes ya lo ofrece en `/api/jobs`, salvo el historial, que arma el
  Puente.
- **Pausa general.** Mientras dura: el chat de Relay no acepta mensajes; los Turnos que Relay
  inició se detienen; los de otros canales terminan lo suyo y no empiezan otro; las tareas
  programadas esperan. Pausar es libre; reanudar pide huella. Qué pide: el Puente ejecuta
  `hermes pause` y `hermes resume`, y además bloquea lo suyo, porque la pausa de Hermes no corta lo
  que ya corre.
- **Gateway:** iniciar, detener y reiniciar. Detener y reiniciar piden confirmación.
- **Uso y costo:** hoy, semana y mes, por Agente y por modelo. Todo importe es una estimación. Qué
  pide: el Puente suma lo que Hermes guarda por Conversación.
- **Diagnóstico y logs.** Los logs se sirven con redacción por patrones. Comprobado que hoy no
  dejan pasar ninguna credencial conocida ([Contrastar los logs reales contra la redacción del
  Puente][t26]); sí pasan datos personales que no son credenciales, como el canal y los usuarios
  de Discord. Hay que ampliar los patrones antes de servir logs de otros Agentes: hoy solo se
  sirve el de `default`.

### 3.7 Ajustes y bloqueo

- Bloqueo con huella al abrir la app y al volver tras el tiempo de bloqueo automático, que se elige
  entre ahora, 1, 5 y 15 minutos.
- No hay sección de notificaciones ni selector de tema.
- La app dice "huella", no "Face ID".

### 3.8 Estado sin conexión

v1 no distingue "Tailscale apagado" de "Servidor caído". Muestra un solo estado, "SIN RESPUESTA",
con las dos pistas y los botones "Abrir Tailscale" y "Reintentar" ([Conciliar el diseño con el
corte de v1][t23]). Si Android no deja abrir la app de Tailscale desde Relay, el botón pasa a ser
"Volver a detectar".

Cuando la causa sí se conoce, la app la dice: dirección bloqueada por Android, llave rechazada,
dispositivo revocado.

## 4. Qué pide huella

Regla: pide huella lo que baja la protección o deja algo corriendo solo ([Decidir qué puede hacer
el Puente en el Servidor y qué pide huella][t22]).

| Con huella | Con confirmación, sin huella | Libre |
|---|---|---|
| Aprobar un comando | Borrar una nota de memoria | Pausar |
| Bajar el modo de aprobación (y confirmación) | Borrar una tarea programada | Editar una nota de memoria |
| Quitar una regla de bloqueo (y confirmación) | Borrar una Conversación | |
| Encender una herramienta | Detener o reiniciar el gateway | Descargar un archivo |
| Reanudar tras una Pausa general | Quitar un Servidor | Añadir una regla de bloqueo |
| Editar `SOUL.md` | | Subir el modo de aprobación |
| Crear o editar una tarea programada | | Apagar una herramienta |
| Ejecutar ahora una tarea programada | | |
| | | Rechazar un comando |

Cambiar el modelo de una Conversación es libre: tocar un modelo lo guarda sin «Aplicar» ni huella.
Durante un Turno en marcha pide solo confirmación y vale para el siguiente Turno; el actual
conserva su modelo. La respuesta muestra el modelo real que reporta Hermes, separado de la
selección de la Conversación.

Pausar una tarea programada es libre. Reanudarla e iniciar el gateway piden huella: vuelven a
permitir trabajo automático. Decidido con Ale al preparar la implementación completa de v1
(2026-10-04). «Ejecutar ahora» también pide huella siempre: Hermes reactiva la tarea al ejecutarla
y su API no permite impedir la reactivación ante una pausa concurrente. Decidido con Ale el
2026-10-04.

## 5. Después de v1

En este orden ([Hacer el corte de Relay v1][t14]):

1. Instalación fácil del Puente en otras computadoras mediante un wizard: comprobar requisitos,
   seleccionar el Hermes existente, preparar el Puente, guiar el servicio y el emparejamiento.
   Debe respetar los perfiles, la configuración y el funcionamiento del Hermes actual del usuario.
   Primera prioridad después de v1, confirmada por Ale el 2026-10-04. Linux primero; Windows
   se evalúa después de la documentación de v2 y de comprobar si v3 está lista para tomar.
   No se instala ni reconfigura Hermes como efecto del wizard.
2. Actividad (bitácora global), y con ella ver desde la app el registro de cambios del Puente.
3. Avisos con la app cerrada, con sus botones. Ale eligió ntfy privado dentro de Tailscale
   el 2026-10-04; el detalle vive en [Relay v2](relay-v2.md).
4. Kanban.
5. Bifurcar una Conversación.
6. Presets de personalidad.
7. Bloque web del Tablero.
8. Tema oscuro.
9. Tablet.
10. Compartir hacia un Agente.
11. Widget.
12. Descargar el APK desde el Servidor.
13. Distinguir "VPN apagada" de "Servidor caído". Hay una vía probable con un módulo nativo
    pequeño ([Investigar qué puede saber Relay de Tailscale en Android][t27]).

Sin lugar en el orden:

- Que "permitir comandos similares" valga para toda la Conversación. Pide que el Puente recuerde
  qué reglas aprobó la persona y conteste por ella, o un cambio en Hermes. Que el Puente conteste
  aprobaciones por su cuenta es una decisión de seguridad aparte.
- Continuar desde Relay Conversaciones nacidas en otro canal.
- Cambiar el modelo por defecto de un Agente.
- Encontrar Servidores sin haber emparejado ninguno.
- Eventos en vivo de los Turnos de otros canales.

## 6. Diseño

- El estilo "Instrumento" manda; prioridad a la fidelidad visual.
- La referencia de las pantallas nuevas es el diseño de Ale, `Relay Instrumento 2.dc.html`, en el
  proyecto de Claude Design. No se prototipa en código.
- El diseño tiene pendiente una segunda ronda de correcciones, de 31 puntos, guardada en
  [Conciliar el diseño con el corte de v1][t23]. A esa ronda hay que sumarle el texto del
  interruptor de la hoja de aprobación ("en este turno", apagado por defecto).
- Donde el diseño y este documento no coincidan, manda este documento.

## 7. Sin comprobar

Esta lista conserva las comprobaciones reales pendientes del inventario original. La
implementación y las pruebas con límites sintéticos se registran en
[Implementación de Relay v1](v1-implementation.md); no sustituyen la validación de Hermes real
a cargo de Ale. Cada punto mantiene su ticket de origen.

Chat:

- Que esperar cerca de un segundo tras soltar el micrófono evite perder la última palabra
  ([Probar el dictado en el S23][t25]).
- Que el audio del dictado no salga del teléfono: nadie capturó tráfico.
- Cómo es la descarga de un modelo de voz que falta.
- Si el Agente sigue viendo una imagen en Turnos posteriores, y qué pasa con un modelo que no
  acepta imágenes ([Probar imágenes en el chat][t21]).
- Casi nada de lo que escribe en Hermes se ha ejecutado: sale de leer su código ([Inventario de
  lo que Hermes ya ofrece para las funciones candidatas][t5]). Sin ejecutar: redirigir un Turno,
  renombrar una Conversación, elegir el modelo por Turno o por Conversación, encender una
  herramienta, y crear, editar, borrar, pausar, reanudar y ejecutar tareas programadas. Sí se
  ejecutaron: crear y borrar una Conversación, un Turno con imagen, responder una Aprobación,
  cambiar el Modo de aprobación y apagar una herramienta.
- Que el Puente pueda detectar y servir los archivos que anuncia un Agente, y buscar texto en la
  base de Hermes: son inferencias del inventario.

Aprobaciones y ficha:

- Que la hoja aparezca cuando el Guardián duda o niega, con el Agente en `smart`. Solo se vio con
  el Agente en `manual`; lo otro sale de leer el código ([Decidir qué papel juega Relay en las
  aprobaciones][t8]).
- Si "permitir comandos similares en este turno" vale para un segundo comando dentro del mismo
  Turno, que es el único efecto que puede tener en v1.
- Qué pasa al aprobar con un teléfono sin huella registrada.
- Si el modo `manual` alcanza a los Turnos del Agente en Discord ([Probar en vivo el cambio de modo
  y la hoja de aprobación][t16]).
- Cómo se leen y se escriben las reglas de bloqueo desde el Puente, y cuándo se aplica un cambio.
- Que el Puente pueda leer y escribir la memoria y `SOUL.md`, y cuándo se aplica un cambio en
  `SOUL.md`.
- Que la lista de skills se pueda sacar de la CLI.
- Si una Conversación que ya existe pierde una herramienta al apagarla: solo hay un indicio de que
  no.

Servidor:

- Que el historial de una tarea programada se pueda reconstruir desde lo que guarda Hermes.
- `hermes pause` y `hermes resume` nunca se ejecutaron. Que la pausa de Hermes no bloquee los
  Turnos del API server sale de leer el código.
- La publicación real de Tarjetas por un Agente. El contrato implementado está documentado
  en [Publicar Tarjetas del Tablero](board-publication.md).

Conexión:

- El escaneo real de emparejamiento con `expo-camera` y su permiso; el módulo ya está integrado.
- Qué ve un Puente al buscar otros en la tailnet.
- Que Android deje abrir la app de Tailscale desde Relay.
- El arranque del Puente tras reiniciar la máquina.

App:

- El bloqueo automático tras un tiempo en segundo plano, en el teléfono.
- La conexión de Relay Dev a Metro en el teléfono. La variante propia ya compiló y se instaló
  con datos demo; esa evidencia no demuestra conectividad con Metro ni Hermes real.

## 8. Decidido al registrar

Detalles que no se decidieron con Ale y se fijaron al escribir los tickets. Se cambian sin más si
no convencen.

- Los dispositivos emparejados se revocan desde el Servidor, con un comando. La app no revoca
  otros dispositivos.
- La lista de dispositivos vive junto al `.env`, en `bridge/`, fuera del repo.
- El comando de emparejamiento se llama `relayd pair` y el código caduca a los 5 minutos.
- Donde el diseño y este documento no coincidan, manda este documento. Lo mismo con
  `DECISIONS.md`, que describe el prototipo.

## 9. Estado de implementación y validación

La implementación vigente se registra en [Implementación de Relay v1](v1-implementation.md).
El emparejamiento sustituye la entrada de llave compartida, Aprobaciones usa «en este turno»
apagado por defecto y la app dice «huella». Las comprobaciones nativas pendientes de #19 y del
APK completo siguen en aquel registro; implementar un caso no equivale a validarlo en producción.

## 10. Decisiones resueltas durante la construcción

- App 1.1.0 con código Android 2; Puente 0.1.0. Las versiones del programa son independientes
  del protocolo 2 y de la compatibilidad declarada por `/health`.
- Tarjetas publicadas mediante JSON validado en `relay-board` de cada Agente; contrato completo
  en [Publicar Tarjetas del Tablero](board-publication.md).
- Modo de aprobación visible en la ficha y en la hoja de Aprobación; las Decisiones separan a la
  persona, el Guardián y la expiración.
- La compatibilidad se declara en `/health`; las rutas de chat usan `X-Relay-Protocol`. Los
  contratos aditivos no obligan a subir el número global. Un DTO inválido no habilita escritura.
- Pausar una tarea es libre; reanudarla, ejecutarla ahora e iniciar el gateway piden huella.
  El resto de la clasificación está en la sección 4.

## Índice de decisiones

| Ticket | Qué fijó |
|---|---|
| [Decidir qué papel juega Relay en las aprobaciones][t8] | El Guardián decide, Relay supervisa; registro de decisiones; modo y reglas por Agente |
| [Decidir cómo se manejan las conversaciones en el chat][t9] | Panel de Conversaciones; solo se escribe en las nacidas en Relay |
| [Decidir cómo se compila y se actualiza el APK][t10] | Compilación local, llave propia, `adb install -r`, Relay Dev |
| [Decidir cómo se conecta el teléfono al Puente y cómo queda corriendo el Puente][t11] | HTTP solo para `ts.net`; el Puente como servicio de usuario |
| [Decidir el canal de avisos: ntfy o push nativo][t12] | v1 sin avisos con la app cerrada |
| [Prototipar el Tablero: tarjetas nativas contra bloque web][t13] | Siete Tarjetas nativas; bloque web después |
| [Hacer el corte de Relay v1][t14] | Qué entra, qué queda para después y en qué orden |
| [Decidir qué puede hacer el Puente en el Servidor y qué pide huella][t22] | Emparejamiento, llaves por dispositivo, huella, registro |
| [Conciliar el diseño con el corte de v1][t23] | Un solo estado sin conexión, modelo en el encabezado, dictado sin medidor |
| [Decidir qué pasa cuando la app y el Puente quedan en versiones distintas][t29] | Versión de protocolo y avisos de actualización |

Investigaciones y pruebas que las sostienen:

- [Investigar cómo compilar el APK de Relay][t2]
- [Investigar cómo llega el teléfono al Puente en una app instalada][t3]
- [Investigar qué deja ver Hermes de los runs que no inició el Puente][t4]
- [Inventario de lo que Hermes ya ofrece para las funciones candidatas][t5]
- [Investigar push y la integración con Android][t6]
- [Investigar cómo un Agente puede publicar y mantener un Tablero][t7]
- [Sacar un primer APK de Relay][t15]
- [Probar en vivo el cambio de modo y la hoja de aprobación][t16]
- [Conectar el APK por la tailnet y dejar el Puente permanente][t18]
- [Investigar el dictado en el dispositivo][t20]
- [Probar imágenes en el chat][t21]
- [Probar el dictado en el S23][t25]
- [Contrastar los logs reales contra la redacción del Puente][t26]
- [Investigar qué puede saber Relay de Tailscale en Android][t27]

[mapa]: https://github.com/AlejandroFloresArroyo/relay-app/issues/1
[t2]: https://github.com/AlejandroFloresArroyo/relay-app/issues/2
[t3]: https://github.com/AlejandroFloresArroyo/relay-app/issues/3
[t4]: https://github.com/AlejandroFloresArroyo/relay-app/issues/4
[t5]: https://github.com/AlejandroFloresArroyo/relay-app/issues/5
[t6]: https://github.com/AlejandroFloresArroyo/relay-app/issues/6
[t7]: https://github.com/AlejandroFloresArroyo/relay-app/issues/7
[t8]: https://github.com/AlejandroFloresArroyo/relay-app/issues/8
[t9]: https://github.com/AlejandroFloresArroyo/relay-app/issues/9
[t10]: https://github.com/AlejandroFloresArroyo/relay-app/issues/10
[t11]: https://github.com/AlejandroFloresArroyo/relay-app/issues/11
[t12]: https://github.com/AlejandroFloresArroyo/relay-app/issues/12
[t13]: https://github.com/AlejandroFloresArroyo/relay-app/issues/13
[t14]: https://github.com/AlejandroFloresArroyo/relay-app/issues/14
[t15]: https://github.com/AlejandroFloresArroyo/relay-app/issues/15
[t16]: https://github.com/AlejandroFloresArroyo/relay-app/issues/16
[t18]: https://github.com/AlejandroFloresArroyo/relay-app/issues/18
[t19]: https://github.com/AlejandroFloresArroyo/relay-app/issues/19
[t20]: https://github.com/AlejandroFloresArroyo/relay-app/issues/20
[t21]: https://github.com/AlejandroFloresArroyo/relay-app/issues/21
[t22]: https://github.com/AlejandroFloresArroyo/relay-app/issues/22
[t23]: https://github.com/AlejandroFloresArroyo/relay-app/issues/23
[t25]: https://github.com/AlejandroFloresArroyo/relay-app/issues/25
[t26]: https://github.com/AlejandroFloresArroyo/relay-app/issues/26
[t27]: https://github.com/AlejandroFloresArroyo/relay-app/issues/27
[t29]: https://github.com/AlejandroFloresArroyo/relay-app/issues/29
