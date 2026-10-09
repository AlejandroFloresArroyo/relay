# Relay V3: herramientas remotas del Servidor

Contrato de producto acordado con Ale el 2026-10-04. Define una versión futura; no modifica el alcance de [Relay v1](relay-v1.md), no implementa funciones ni autoriza cambios operativos en la máquina o la tailnet.

El registro canónico de las decisiones es [Relay V3: terminal, archivos y web remotos](https://github.com/AlejandroFloresArroyo/relay-app/issues/61) y sus tickets. Este documento reúne el contrato acordado para su posterior planificación; los fundamentos y respuestas de la entrevista permanecen en los tickets enlazados.

## 1. Alcance y ubicación

V3 incorpora terminal completa, explorador de archivos, webs de localhost dentro y fuera de Relay, y control de páginas del navegador del Servidor. La app se adapta a teléfono y tablet Android. Las herramientas pertenecen al Servidor y funcionan fuera de una Conversación, con accesos desde ella y retorno a su contexto. Terminal y navegador remoto no son Turnos de Hermes.

En teléfono hay una herramienta a pantalla completa. En tablet pueden elegirse dos herramientas en paneles simultáneos o usar un panel. Cambiar conserva terminales, carpeta, borrador y página; el foco de teclado debe ser explícito. Desde una carpeta se puede abrir una terminal nueva allí. Véase el [esquema aprobado de organización](planning/relay-v3-workspace-outline.md) y [Definir el flujo entre terminal, archivos y web en teléfono y tablet](https://github.com/AlejandroFloresArroyo/relay-app/issues/70).

## 2. Acceso y pertenencia

Se reutiliza el emparejamiento del dispositivo; las operaciones tienen los permisos del usuario del Puente, sin elevación implícita. Entrar a las herramientas requiere huella o autenticación del sistema mediante código del teléfono. No hay entrada sin verificación. Esa verificación es local al teléfono y no se presenta como prueba criptográfica ante el Servidor. Alternar herramientas no exige repetirla hasta que Relay se bloquee.

| Evento | Entorno propio: terminales y navegador dedicado | Trabajo compartido: tmux/herdr previos y navegador habitual |
|---|---|---|
| Volver atrás o cambiar herramienta | Conservar | Conservar |
| Bloquear Relay o perder conexión | Ocultar vistas y suspender control; conservar trabajo | Ocultar vistas y suspender control; conservar trabajo |
| Volver/reconectar | Recuperar lo que siga vivo; no abrir sustitutos por sorpresa | Recuperar acceso cuando sea posible |
| Terminar entorno, con confirmación | Terminar ese entorno y su trabajo propio | Desconectar; conservar el trabajo compartido |
| Revocar dispositivo | Cortar accesos y terminar sus entornos propios | Cortar sus accesos; conservar el trabajo compartido |

La clasificación se registra al crear o conectar trabajo. Incluso las pestañas nuevas que Relay abre en el navegador habitual son compartidas y se conservan al revocar. No se promete deshacer efectos ya realizados ni terminar trabajos que hayan salido a servicios o entornos ajenos al seguimiento. Una conexión a un tmux/herdr compartido no convierte sus procesos en propios.

Pausa general no impide usar las herramientas humanas. Los registros del Puente no incluyen comandos, entrada/salida de terminal, contenido de archivos/páginas, cabeceras, cookies, llaves ni códigos. Se conserva el contrato de método, ruta y estado, evitando secretos en rutas y errores. El registro de cambios identifica actor, fecha y operación sin copiar contenidos.

Una Autorización web externa es independiente del bloqueo de Relay, dura una hora desde su concesión, se limita a una aplicación, es cancelable desde Relay y caduca al revocar el dispositivo. No se renueva silenciosamente. Caducidad y revocación cortan conexiones abiertas además de rechazar accesos nuevos; no borran contenido ya descargado.

Detalle: [Decidir acceso, huella y revocación de terminal, archivos y web](https://github.com/AlejandroFloresArroyo/relay-app/issues/62).

## 3. Terminal remota

Al abrir cada terminal se eligen shell y carpeta del Servidor. Se ejecuta bajo la cuenta del Puente y se verifica que ambos destinos estén disponibles. Relay admite varias terminales independientes con pestañas. herdr y tmux se ejecutan normalmente dentro de ellas; Relay no gestiona sus sesiones ni adopta automáticamente la terminal del escritorio.

La terminal es interactiva, con PTY, entrada/salida continua y ajuste de filas/columnas al tamaño y teclado. Incluye Esc, Ctrl, Alt, Tab, flechas, selección, copia/pegado y teclado físico. Se pega directamente, incluso varias líneas, sin confirmación adicional ni enviar Enter por el mero acto de pegar.

Al reconectar o reabrir Relay se recuperan las terminales y pestañas que sigan vivas, incluso tras reiniciar el Puente. Reiniciar el Servidor o terminar un proceso no crea una terminal sustituta: se muestra el estado terminado/no recuperable. Conservar el PTY requiere separar su supervisor del ciclo de vida del servicio Puente; guardar una pestaña no equivale a conservar el proceso.

xterm.js y node-pty son las candidatas aceptadas. Hay que validar Node 26, arquitectura del Servidor, Expo 57/WebView Android, teclado español/IME, copia, resize y reconexión antes de certificar la combinación. El historial, mensajes y colas deben tener límites finitos y control de flujo, definidos mediante pruebas; un límite no puede terminar trabajo silenciosamente ni prometer una transcripción ilimitada.

Detalle: [Decidir el contrato de la terminal nueva y su desconexión](https://github.com/AlejandroFloresArroyo/relay-app/issues/64).

## 4. Explorador y editor

Se recorren todos los archivos accesibles al usuario del Puente. El punto de entrada es su carpeta personal y hay un interruptor para ocultos. Se permiten enlaces simbólicos mostrando su destino real y respetando permisos.

Operaciones: explorar, transferir entre teléfono y Servidor, crear archivo/carpeta, mover, renombrar, borrar y editar texto. Borrar o sobrescribir requiere confirmación. Al borrar una carpeta se explicita que se borra su contenido. Borrar un enlace borra solo el enlace; operar después de entrar por él actúa sobre el destino. No hay papelera ni recuperación general como requisito.

El editor admite texto de hasta 5 MiB en UTF-8, UTF-16 LE/BE, ISO-8859-1 y Windows-1252. Conserva codificación, BOM y saltos de línea originales. Ante identificación ambigua permite elegir con vista previa; las heurísticas no se presentan como certeza. Un carácter no representable bloquea el guardado con pérdida y ofrece cambiar a UTF-8 con confirmación. No se convierte automáticamente; el límite se comprueba sobre entrada y salida codificadas. Binarios y archivos normales mayores pueden transferirse; archivos especiales se identifican y no se tratan como archivos regulares.

Si el archivo cambia en el Servidor durante una edición, se conserva el borrador y se muestra el conflicto, con recarga o sobrescritura confirmada. Se verifica otra vez al guardar: detectar cambios solo al abrir el editor no basta. Las escrituras de perfiles de Hermes conservan obligatoriamente la versión anterior y registran el cambio, aunque no haya recuperación general para otros archivos.

La búsqueda admite nombres en la carpeta o subcarpetas y, como acción aparte, contenido de texto. Tiene progreso y cancelación, sin índice permanente de toda la máquina. Las transferencias tienen progreso, cancelación y reintento tras interrupción; no se fija un máximo general ni se exige reanudación parcial. No se publica un archivo incompleto como si hubiese finalizado. Permisos, espacio disponible y recursos pueden impedir una operación y deben dar un error visible.

La implementación usará operaciones estructuradas de archivos o comandos con vector de argumentos según sus garantías; no interpolará rutas o contenidos en un shell. Este explorador es distinto de los archivos anunciados por un Agente en una Conversación.

Detalle: [Decidir límites y comportamiento del explorador de archivos](https://github.com/AlejandroFloresArroyo/relay-app/issues/65).

## 5. Webs de localhost

Se descubren servicios locales automáticamente y la persona elige la aplicación. Descubrir no abre ni autoriza por sí solo; el registro de destino vincula una aplicación concreta a su servicio local y no convierte al Puente en un proxy de URLs arbitrarias. Los servicios de control del Puente/Hermes no se ofrecen como aplicaciones web. La planificación no consulta servicios reales.

Las webs objetivo son aplicaciones creadas por el usuario. V3 incluye navegación en Relay y apertura en el navegador del teléfono/tablet. Soporta rutas, volver/recargar, formularios, sesión de la propia aplicación, subidas/descargas y conexiones de desarrollo cuando la aplicación cumple el contrato del proxy. Las ventanas nuevas permanecen bajo el destino autorizado o se tratan como navegación externa; no conceden otro servicio local. Si el servicio se detiene, se informa y ofrece reintento sin abrir otro puerto por sorpresa.

Se acepta ajustar aplicaciones incompatibles y ofrecer control del navegador del Servidor como alternativa. No se promete compatibilidad universal ni se retiran globalmente CSP/CORS para hacer funcionar una web. Sus recursos externos normales pueden cargarse desde el navegador. El control de las herramientas sigue exclusivamente a través del Puente; enlaces a otras webs se abren en el navegador del teléfono sin autorizar automáticamente otros servicios locales.

La arquitectura futura aceptada es HTTPS con un nombre de Tailscale Services por aplicación, Serve hacia un listener web del Puente asociado a esa aplicación, y de allí al localhost registrado. Nunca Serve directamente al servidor de desarrollo. Requiere administración y aprobación de la tailnet; no se configura en este esfuerzo y no cambia el transporte de v1.

La autorización externa usa un acceso temporal independiente, nunca la llave permanente en la página o URL. Se reserva una cookie HTTPS host-only de autorización que no se reenvía al destino ni se acepta en el API de control. El canje inicial será de uso único, vinculado inequívocamente al navegador que Relay autoriza. El contenido no recibe un puente nativo con autoridad sobre terminal o archivos. Reiniciar un Puente que mantenga autorizaciones en memoria puede exigir autorizar de nuevo; esto no termina las terminales.

Los nombres separados aíslan orígenes, pero no garantizan todas las cookies de aplicaciones desconocidas: nombres hermanos pueden compartir cookies del dominio padre. Las aplicaciones compatibles deben adaptar URL y cookies sensibles al host, sin compartir cookies entre aplicaciones. El handoff, cookies, solicitudes cruzadas, SSE/WebSocket, service workers, vencimiento y revocación necesitan pruebas aisladas. La hora se verifica en el Servidor, no con el reloj del teléfono.

Detalle: [Decidir destinos, navegación y apertura externa de localhost](https://github.com/AlejandroFloresArroyo/relay-app/issues/67). Requisitos técnicos documentados en [Investigar aislamiento de la autorización web externa](https://github.com/AlejandroFloresArroyo/relay-app/issues/73).

## 6. Navegador del Servidor

V3 incluye un navegador dedicado y control del habitual, con base Chrome/Chromium y versiones probadas explícitamente. Se muestran páginas y controles de Relay para pestañas, dirección, volver/recargar e interacción por tacto/teclado. No se captura toda la interfaz nativa ni se incluye escritorio remoto completo.

El dedicado tiene perfil e inicios de sesión propios, conserva perfil/pestañas al desconectar y termina su proceso al revocar. No copia sesiones del habitual. Se recupera lo que siga vivo sin sustituirlo silenciosamente. CDP con perfil independiente es la arquitectura candidata.

En el habitual se eligen expresamente las pestañas controlables y se comparte interacción con quien esté en la computadora. Todas sus pestañas, incluidas las creadas desde Relay, se conservan al terminar/revocar. Una extensión y adaptador local al Puente son la arquitectura candidata; instalarla, conceder permisos y validar métodos/versiones forma parte de los requisitos futuros. Abrir DevTools o una restricción del navegador puede desconectar el control y debe notificarse.

Las subidas eligen archivos del Servidor mediante el explorador; los del teléfono se transfieren primero. Las descargas quedan en el Servidor y se ofrece traerlas al teléfono. Selectores y diálogos compatibles usan controles de Relay; un diálogo nativo no compatible se señala para resolverlo en la computadora. No se promete vídeo continuo con audio ni acceso a todas las páginas internas del navegador.

Detalle: [Decidir qué navegador del Servidor se puede controlar](https://github.com/AlejandroFloresArroyo/relay-app/issues/69).

## 7. Compatibilidad y aceptación

Servidores Linux con systemd y cgroup v2 como base inicial. macOS/Windows quedan para después. Se permiten componentes mantenidos adicionales; la instalación verifica Node, PTY, navegador/extensión y requisitos de HTTPS/Services y explica capacidades ausentes sin modificar producción implícitamente.

La app mantiene las funciones existentes con un Puente que no ofrezca V3; muestra la herramienta no disponible y el requisito de actualización, sin enviar operaciones desconocidas ni fingir éxito. Se respetan las comprobaciones de versión del protocolo; no se eluden para aparentar compatibilidad. Las versiones y arquitecturas certificadas se publican después de pruebas, no por inferencia del soporte de una dependencia.

Criterios observables de aceptación:

1. Elegir shell/carpeta, trabajar con herdr/tmux o un programa de pantalla completa, varias pestañas y teclado virtual/físico; recuperar terminales vivas tras reconexión y reinicio del Puente.
2. Bloquear y desconectar sin Ctrl-C ni pérdida del trabajo; revocar cortando todos los canales y terminando entornos propios, conservando compartidos, incluidas pestañas nuevas del navegador habitual.
3. Crear/mover/transferir/borrar y editar texto; demostrar confirmaciones, enlace frente a destino, conflicto concurrente y conservación obligatoria de versiones de perfiles de Hermes. Transferencias incompletas nunca aparecen como terminadas.
4. Abrir una web falsa dentro y fuera de Relay, navegar/formularios/subidas/descargas y su canal de desarrollo compatible; demostrar autorización de una hora sin renovación, sin acceso al control ni a otra aplicación, con corte de streams activos al expirar/revocar.
5. Controlar páginas de Chrome/Chromium dedicado y habitual, sin copiar sesiones; demostrar convivencia local, desconexión visible y diálogos incompatibles identificados.
6. Alternar herramientas y Conversación; trabajar con dos paneles y foco de teclado inequívoco en tablet Android. Probar un Puente sin V3 y entradas/salidas sin secretos en logs.

No se fija fecha ni se altera el orden de los pendientes vigentes. El contrato permite planificar V3 después de las versiones previas. Quedan fuera integración específica con herdr/tmux, recuperación general de archivos, proxy universal, control completo del escritorio, iPhone/iPad nativos, control de navegadores del Servidor Firefox/Safari y soporte de Servidor macOS/Windows. La implementación requerirá sus propias tareas y pruebas; cerrar el mapa no equivale a entregar funciones construidas.

Cierre y criterios: [Cerrar el alcance y los criterios de la versión de trabajo remoto](https://github.com/AlejandroFloresArroyo/relay-app/issues/71).
