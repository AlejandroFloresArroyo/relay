# Prompt para instalar Relay y el Puente

Copia el bloque completo en una sesión con el agente que te ayudará en tu Servidor. El agente
primero prepara un plan; la instalación y el emparejamiento requieren tu participación.
Este documento no ejecuta el setup ni sustituye el wizard existente.

```text
Ayúdame a instalar Relay en Android y el Puente junto a mi Hermes existente. Habla en español.
Respeta mis Agentes, perfiles, configuración, Conversaciones, servicios y datos actuales.
Usa el wizard de este repositorio; no escribas otro instalador ni modifiques README.

1. Fija el contexto y la autorización.

Pregunta en qué máquina está Hermes, su sistema operativo y si ya hay un Puente instalado.
Identifica el checkout de Relay y lee sus instrucciones activas, docs/bridge-install.md,
docs/development.md, bridge/README.md y, si quiero herramientas V3, docs/v3-install.md;
consulta scripts/bridge-wizard.sh, scripts/prepare-dev.sh, bridge/src/setup.ts,
bridge/src/doctor.ts y bridge/src/cli.ts antes de proponer comandos.
Estas fuentes deciden opciones y comportamiento; si difieren de este prompt, explica la
situación y detente antes de un cambio. Este prompt no anula prohibiciones de la sesión o del
repositorio. Si impiden operar producción, entrega el plan y los comandos para que yo los
ejecute personalmente; no intentes sortearlas mediante otra herramienta o sesión.

Pide consentimiento para las comprobaciones locales de solo lectura y delimita sus rutas.
Preparar el plan no autoriza descargas, instalación de paquetes, escritura de archivos,
cambios de servicio, acceso a perfiles o instalación en el teléfono. No ejecutes comandos
privilegiados, modificaciones de Hermes, firewall, tailscale serve ni cambios de red o linger
como parte de este flujo. Si falta un requisito, presenta su preparación como decisión
separada, con origen, comando, efectos y consentimiento explícito.

2. Detecta la plataforma y comprueba requisitos.

Con el consentimiento anterior, identifica el sistema con uname -s si está disponible.
En Windows nativo usa la información del sistema aportada por mí o una consulta local de
solo lectura. La ruta soportada de este wizard y del Puente completo es Linux: requiere Bash,
Linux con /proc/self/fd, Node >=26 con node:sqlite y límites, npm, Python 3 con fcntl/PyYAML
accesibles con -I, una sesión systemd de usuario, XDG_RUNTIME_DIR existente y Tailscale ya
conectado. El checkout debe contener bridge/ y mobile/ con sus package.json y lockfiles.

Desde la raíz de un checkout confiable, ./scripts/bridge-wizard.sh --help explica sus opciones;
./scripts/bridge-wizard.sh --check reutiliza prepare-dev.sh --check y comprueba requisitos
sin instalar ni crear archivos. Su éxito solo prueba requisitos locales: la sesión systemd,
la IP local y el nombre Tailscale se verifican realmente durante relayd setup. No vuelques
variables de entorno, systemctl show-environment, tailscale status --json ni logs completos
al chat. setup procesa esas consultas internamente sin imprimir su contenido.

Windows nativo y macOS no tienen soporte completo del Puente; WSL y VM no se han comprobado
para este flujo. No presentes WSL como soporte Windows ni adaptes el servicio improvisando. Si mi Servidor no cumple Linux y sus requisitos,
explica el límite y termina con un plan pendiente; elegir otra máquina requiere mi decisión.

3. Localiza Hermes usando información pública que yo autorice.

Pídeme la raíz de Hermes, la ruta del CLI ya instalado y los IDs de Agente que quiero revisar.
No asumas que ~/.hermes es la raíz correcta ni que default es el único Agente. Si no conozco
el ejecutable, con mi consentimiento puedes usar command -v hermes para localizarlo, sin
invocarlo; si el resultado no es una ruta, pídeme la ruta del archivo ejecutable real.
Para resolver symlinks, propón readlink -f -- con el argumento correctamente citado o pídeme
la ruta física. Verifica únicamente existencia, tipo y ejecutabilidad mediante metadatos
de las rutas aprobadas. No busques recursivamente en mi home ni abras .env, credenciales,
config.yaml, bases, historiales o contenido de perfiles para descubrirlo. No ejecutes Hermes,
ni siquiera --version, doctor, setup, gateway, pause o resume, para esta localización.

El wizard exige rutas físicas absolutas existentes, sin symlinks en sus componentes,
componentes . o .., barras duplicadas/finales, caracteres de control ni espacios finales.
La raíz es la instalación completa, no profiles/<id>. El CLI es un archivo ejecutable.
Los IDs se separan por comas, sin espacios; admite hasta 128, cada uno empieza por letra o
número y continúa con letras, números, punto, guion o guion bajo. Verifica solo los directorios
de los IDs aportados, sin leer su contenido. La lista es de comprobación: el Puente descubre
todos los perfiles de esa raíz; no crea, selecciona una allowlist ni filtra Agentes por ella.

4. Elige un checkout estable y una instalación sin sobrescrituras.

Usa un checkout confiable cuya ruta física y propietario podamos comprobar. Pídeme el origen
y la revisión de Relay; no inventes una URL de descarga. Si hace falta clonarlo, presenta el
comando exacto y la ruta absoluta y espera autorización. Comprueba que el destino no existe,
incluidos enlaces rotos, y que sus ancestros son adecuados; ante conflicto elige otra ruta,
nunca limpies ni sobrescribas el directorio. No uses un checkout temporal que pueda borrarse:
la unidad ejecutará ese bridge/ y el Node seleccionado por el entorno de instalación.

Si ya hay un Puente, identifica conmigo su checkout antes de elegir otra ruta. Su estado y
socket están ligados al checkout; otro directorio no conserva automáticamente dispositivos,
recibos ni auditoría. No copies estado privado ni arranques una segunda instancia para eludir
una unidad existente, un puerto ocupado o un error. No borres, repares ni reinicialices datos.

No hace falta npm ci para ejecutar el Puente: Node ejecuta TypeScript y no hay dependencias
npm de ejecución. prepare-dev.sh sin opciones sí reemplaza node_modules de bridge y mobile;
solo se utiliza para desarrollo/compilación, con permiso separado. No instales Hermes.

Acordemos el puerto: el habitual es 8650 y el wizard acepta 1..65535. No liberes un puerto
parando procesos ajenos. Si existe configuración privada, debo revisarla yo localmente,
sin enviártela. Las variables del .env existente prevalecen sobre las de la unidad, incluso
HERMES_HOME, HERMES_BIN y RELAY_PORT. No anuncies que verificaste sus valores ni que la ruta
seleccionada será efectiva si no pude confirmar que no hay contradicciones.

5. Prepara un plan concreto antes de cualquier instalación.

Desde la raíz del checkout, ofrece este ejemplo de inspección, reemplazando TODOS los
marcadores y los IDs de ejemplo por los valores que acordamos antes de ejecutarlo:

./scripts/bridge-wizard.sh --plan '<raíz-física-de-Hermes>' '<CLI-física-absoluta>' 'default,dev' 8650

--plan valida rutas, IDs y puerto y muestra un comando escapado; no comprueba todos los
requisitos, instala ni ejecuta Hermes. Mantén cada valor como un argumento literal, citado:
nunca evalúes una cadena aportada por mí ni la salida del plan como código.

Presenta raíz, CLI, Agentes a revisar, checkout, Node y puerto; señala lo comprobado y lo
pendiente. Explica los efectos de setup: conserva un bridge/.env existente byte por byte;
si falta crea el mínimo RELAY_HOST/RELAY_PORT con permisos 0600; crea la unidad de usuario
~/.config/systemd/user/relay-bridge.service, recarga unidades, la habilita e inicia el Puente
inactivo. El Puente arranca con su funcionamiento normal y su estado privado; autorizarlo
no equivale a autorizar escrituras en Hermes o Turnos de prueba.

La unidad distinta solo se sustituye con --replace-service; el Puente activo solo se reinicia
con --restart. Son consentimientos separados, rechazados por defecto, además de la aprobación
final del comando exacto. Reemplazar sin reiniciar deja los valores nuevos para el siguiente
arranque; el QR corresponde al proceso que sigue activo. No hay rollback de una instalación
existente: un fallo puede dejar etapas completadas y se deben informar antes de otro intento.
Si es una actualización, instala primero la app compatible y acuerda la interrupción antes
de sustituir/reiniciar el Puente. No prometas una actualización sin interrupciones.

6. Acompaña el wizard existente en una terminal privada.

Solo después del plan y mi autorización, pídeme ejecutar personalmente:

./scripts/bridge-wizard.sh

La terminal del Servidor debe ser interactiva. No redirijas salida a logs, tee, tickets,
capturas o al chat: setup/pair muestran un código y QR de un solo uso. Si tus herramientas
capturan la salida, déjame este paso por completo; no lo ejecutes mediante ellas. Nunca
respondas «y», pulses Enter ni actives --replace-service/--restart en mi nombre.
El wizard no guarda respuestas: al repetirlo pide las rutas otra vez. Ctrl-C permite cancelarlo,
pero no garantiza deshacer los efectos de setup que ya ocurrieron.

Si falla, registra solo el diagnóstico seguro y los pasos completados que yo te comunique.
Detente ante corrupción, ownership/permisos, symlinks, unidad distinta o socket no disponible;
no fuerces reinicios, reparaciones o flags. El aviso de linger es una sugerencia para una
decisión independiente, no una orden que debas ejecutar. Nunca reinicies el gateway de Hermes.

7. Guíame con el APK y el emparejamiento.

Pídeme obtener el APK de una fuente confiable y la versión compatible con este Puente.
Verifica integridad contra el SHA-256 publicado por esa fuente y firma/identificador cuando
haya herramientas disponibles; un hash calculado localmente sin referencia no prueba origen.
No inventes URL, certificado ni canal de distribución. Una actualización que conserve datos
requiere el mismo identificador y firma: ante incompatibilidad no desinstales la app para
sortearla. Instalar el APK y conceder permisos corresponde a mi confirmación en Android.

Si debo compilar en lugar de recibir un APK, consulta docs/development.md y mobile/README.md;
propón un trabajo separado con permisos para descargas, SDK/licencias y generación de Android.
No hagas prebuild --clean por sorpresa, uses la firma privada de otra persona ni me pidas
keystores o contraseñas. El setup del Puente no compila ni instala el APK.

El Servidor y el teléfono deben estar conectados a mi tailnet; Relay no crea ni enciende la VPN.
En Relay guíame a escanear el QR o introducir manualmente dirección y código. Usa la dirección
MagicDNS completa que muestra pair, http://<servidor>.<tailnet>.ts.net:<puerto>, no la IP,
el nombre corto ni localhost: el APK permite HTTP de tailnet por nombre *.ts.net, bajo el
cifrado de Tailscale. No amplíes esa política ni expongas el Puente a Internet.

El código dura cinco minutos según el Servidor y sirve una sola vez. Otro pair invalida el
anterior; si caduca o el canje queda incierto, yo genero otro desde el mismo bridge/ y sesión
de usuario con ./relayd pair en la terminal privada. No copies el código, QR ni llave permanente
al chat o a logs; no intentes leerlos del estado ni reproducir un canje con curl o Bearer.
El wizard espera Enter después de que yo empareje y compruebe el Servidor.

8. Valida y entrega un resultado honesto.

Con mi permiso para consultar el Puente recién instalado, puedes comprobar únicamente su
GET /health público en la dirección acordada, sin autenticación y con timeout; ese resultado
no prueba acceso a Hermes ni emparejamiento. Verifica compatibilidad mediante la app y el
contrato de la revisión, sin desactivar controles de protocolo ni fijar una versión a ojo.
Pídeme comprobar en Relay el Servidor y los Agentes esperados. Esas lecturas normales del
Puente pueden consultar Hermes: requieren mi consentimiento; no implican permiso para enviar
Turnos, editar documentos, cambiar modos, controlar gateway o activar/desactivar herramientas.
Para comprobar el dispositivo localmente existe ./relayd devices; muestra identificadores,
nombres y fechas, no llaves. Usa solo el mismo checkout y sesión, con consentimiento, y no
pegues el inventario completo si basta confirmar el resultado. No edites archivos de estado.

Distingue requisitos presentes, plan preparado, servicio habilitado/iniciado, health recibido,
compatibilidad y emparejamiento confirmado por mí. Si un paso no se hizo o una plataforma no
se comprobó, déjalo pendiente. Resume rutas públicas elegidas, revisión de Relay, cambios
realmente consentidos/completados y próximos pasos; omite secretos y contenido de Hermes.
La tarea termina al verificar el Servidor emparejado y los Agentes esperados, o al entregar
un bloqueo preciso sin tocar lo que no autoricé. Si además quiero herramientas V3, sigue
el paso 9.

9. Herramientas V3, solo si las pido.

Sigue docs/v3-install.md. Con mi consentimiento puedes ejecutar, desde bridge/, las órdenes
de solo lectura:

./relayd doctor
./relayd setup --dry-run <las opciones V3 acordadas>
./relayd web

doctor no lee .env, la llave del supervisor ni perfiles del navegador; dry-run no escribe ni
cambia servicios. Resume sus estados ok/aviso/falta sin pegar rutas privadas ni direcciones.
Compilar node-pty (cd supervisor && npm run setup) descarga e instala dependencias: es una
decisión separada con mi consentimiento. Acuerda conmigo las opciones de setup (--supervisor,
--files, --web, --browser-habitual) y recuerda que la unidad se regenera con ellas: hay que
repetir todas las que ya uso. La instalación real la ejecuto yo en la terminal interactiva.

Son siempre pasos míos, que nunca ejecutas ni simulas:
- Todo lo de la consola de Tailscale: certificados HTTPS, tag del anfitrión y revisión de las
  reglas de acceso al Puente y a Hermes antes de etiquetarlo, Services, acceso y aprobación.
- Cada tailscale serve --service=… y tailscale serve clear que imprime relayd web.
- Cargar la extensión en chrome://extensions y comprobar su ID tras relayd browser.
- --restart-supervisor o reiniciar relay-supervisor: deja las terminales vivas como lost.
- loginctl enable-linger.
La validación real de Services está pendiente: no declares compatible la publicación web
hasta que yo registre lo que pide «Validación real pendiente» de docs/v3-install.md.
```

Referencias: [wizard del Puente](bridge-install.md), [desarrollo y plataformas](development.md),
[comandos del Puente](../bridge/README.md) y [APK Android](../mobile/README.md#compilar-el-apk).
