# Presets: evidencia de Hermes y límites de la construcción

Se contrastó únicamente fuente pública fijada en
`ea114c3e98c3339e13004adfc6098cf28ed7d754`; no se importó código de Hermes ni se ejecutaron
inicializadores. Las copias de investigación permanecen en logs ignorados del worktree:
`personality-hermes-api-source.log` y `personality-hermes-runs-source.log`.
El reporte adicional llamado `relay-board` no estaba disponible en este worktree al cerrar;
Root puede contrastarlo en la revisión independiente.

En [`api_server_runs.py`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/gateway/platforms/api_server_runs.py),
la admisión de `/v1/runs` lee `instructions` y lo entrega como `ephemeral_system_prompt` a la
construcción del Agente. Si se utiliza `previous_response_id` y se omite la instrucción, puede
heredar la anterior; Relay envía `session_id` y no utiliza esa cadena de respuestas. En
[`api_server.py`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/gateway/platforms/api_server.py),
la construcción del Agente recibe esa capa efímera junto con la configuración del Servidor.
Esto permite enviar el overlay por Turno sin editar configuración global ni otro archivo de Hermes.
No acredita un instante universal de reconstrucción de contexto.

Hay un caso aparte en la fuente fijada: una Conversación de la línea canónica Bot Chat que tenga
un dueño Desktop activo se entrega a su buzón; esa entrega pasa mensaje y autor, sin la capa de
`instructions` de la nueva admisión. El constructor nativo del API no ejecuta ese Turno.
Los presets de Conversación de Relay exigen recibo de creación propio y no conceden escritura a
Bot Chats externos. Si Hermes cambia externamente esa línea, no se promete que su dueño aplique
el overlay. Esto requiere contraste de Root si amplía el alcance a esa vía.

## Escrituras y recuperación

El catálogo pertenece al directorio privado del Puente, no a un perfil Hermes. Sus versiones,
recibos y respaldos son privados; el listado público autorizado no incluye contenidos.
Cada cambio conserva los bytes anteriores en archivo 0600 y sincroniza archivo/directorio,
registra una solicitud sin nombres ni contenidos y revalida identidad y bytes antes de reemplazar.
La revisión optimista protege cambios durante la retención. El reemplazo utiliza directorio
anclado, guarda y `renameSync` consecutivos. La guarda no acredita autorización distribuida ni
un CAS del sistema de archivos contra escritores arbitrarios en otro proceso.

Aplicar SOUL usa el único writer `agentMemory.changeSoul`, con señal de cancelación y guarda
actual del preset además de autorización. El límite de contexto de #44 continúa siendo un aviso
de truncamiento verificable, separado del límite de transporte; `null` significa desconocido.
La preview entrega todo el reemplazo y todo el SOUL actual. No se reinicia Hermes.

Antes de llamar al writer se crea y sincroniza un recibo de intención exclusivo por dispositivo
más `requestId`. Un resultado pendiente o corrupto no repite la escritura. Un éxito confirmado
se reconstruye desde metadatos y la versión inmutable, aunque el preset luego se edite o borre.
Un conflicto definitivo antes del reemplazo conserva ese mismo resultado. Una pérdida de ACK,
cancelación o fallo posterior conserva incertidumbre: no promete rollback ni ausencia de cambio.

El catálogo serializado tiene límite de 16 MiB incluyendo historial y recibos, y 64 presets
activos; no poda versiones. Los respaldos anteriores se conservan aparte y no se borran por
cuota. Los recibos de SOUL admiten como máximo 4096 archivos de hasta 16 KiB cada uno.
Cada Conversación admite 128 recibos de selección; llegar al límite rechaza cambios nuevos,
sin eliminar el replay de selecciones previas. Estas cuotas privadas no agregan campos al DTO.

El overlay completo se congela en el recibo durable de una Conversación nacida Relay. Las
selecciones anteriores también se conservan para replay. La selección vigente se toma antes de
la admisión de un Turno y no modifica el Turno ya activo. Seleccionar `null` omite la instrucción
extra de Relay; hereda la configuración y contexto de Hermes, sin prometer que solo quede SOUL.

## Evidencia acotada

Pruebas HTTP con Hermes fake, perfiles sintéticos, archivos reales privados, workers Python
controlados y canal nativo simulado. Los temporales y logs permanecieron dentro del worktree.
La reproducción de conflicto final retiene el mensaje real `prepared` con flock/dirFD vivos;
la de ACK mata realmente al worker después de `renameSync` antes de entregarle el ACK.
No se movió la prueba a una fase anterior de retención. Ambas verifican estado del archivo,
respuesta y replay, y confirman que el worker terminó.

La UI y su huella Android fuerte pertenecen a la construcción paralela de Root. Estas pruebas
no acreditan biometría ni presentación de Modal en teléfono; tampoco acceden a servicios,
configuración de producción, puertos protegidos, APK, ADB o dispositivos físicos.
