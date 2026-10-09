# Productores observables de Avisos v2

El Puente conserva el DTO `protocol/notifications.ts` y sus rutas de inscripción, Aprobaciones y
Decisiones. `availableKinds` incluye `approval`, `task`, `error` y `server` porque están cableados
en `createApp`; no significa que pueda observar todos los trabajos de Hermes ni todos los cambios
mientras nadie consulta el estado.

| Tipo | Evidencia que lo produce | Lo que no lo produce |
|---|---|---|
| `approval` | Petición retenida en un Turno de Relay, con identidad y Decisión existentes. | Entrega como consentimiento; ninguna ampliación de elección o ACK. |
| `task` | `run.completed` o snapshot terminal `completed` de un Turno iniciado por el Puente; fila `completed` reciente consultada en el historial de una tarea. | Aceptar un mensaje, crear una tarea, «Ejecutar ahora», `lastStatus`, trabajo activo. |
| `error` | `run.failed`/`run.interrupted` o snapshot terminal equivalente; fila `failed` reciente consultada en historial. | SSE perdido, timeout, Turno desconocido, cancelación, contenido del error. |
| `server` | Cambio confirmado `active`/`stopped` del gateway, cambio entre dos PID conocidos positivos de gateway activo o cambio confirmado de Pausa general. | Primera lectura, uptime, PID desconocido, error de red, petición pendiente, estado sin confirmar o Servidor caído inferido. |

El lector existente del Turno sigue consumiendo los eventos de sus propios Turnos aunque la app no
esté abierta. No se crea otro trabajador ni servicio, ni se consulta Hermes real en las pruebas.
Si el SSE pierde eventos, sólo un snapshot terminal confirmado permite publicar; ausencia del Turno
o falta de respuesta conserva la incertidumbre. Los avisos no abarcan Turnos de otros canales.

Gateway y Pausa general se observan en sus consultas autenticadas existentes y después de confirmar
las acciones ya autorizadas. La consulta previa a una acción fija el estado anterior; una petición
aceptada no prueba la transición. Las lecturas antiguas que terminan después de iniciar otra más reciente se descartan como
observaciones; Pausa pendiente tampoco prueba un estado nuevo. Esto puede omitir un cambio si la
lectura más reciente no lo confirma, y evita fabricar transiciones por respuestas tardías. Un error
de publicación no convierte una operación confirmada en fallida. El mismo PID tras un posible reinicio no lo prueba; sin cambio observable no se avisa.
Un Puente caído no puede avisar de su propia caída. No hay detector nuevo de VPN ni polling de Hermes.

## Historial de tareas: límite deliberado

El único punto nuevo es `GET /v1/agents/:id/jobs/:jobId/history`, después de su lectura y autorización.
Se usa la página que ya entrega `JobsManager.history`/`HermesJobs.history`: como máximo 50 filas, desde
la proyección segura del registro de ejecuciones. Se consideran sólo `completed`/`failed` con identidad
acotada y `finishedAt` interpretable con zona horaria. No se infiere un resultado de `claimed`,
`running`, `unknown`, delivery ni de una solicitud para ejecutar.

Las filas sin fecha de fin, antiguas, futuras o no terminales no producen aviso. Sólo se avisa de filas
cuya fecha de fin sigue dentro de cinco minutos del reloj del Puente. Consultar otras páginas o repetir
la misma página no reenvía la misma ejecución a la misma inscripción. Agente, tarea y ejecución son
parte de la identidad interna; nunca se publican.

No hay recorrido automático del historial. Sin una petición de historial, una tarea programada no
produce aviso por esta integración; con la app cerrada esto requiere que otro cliente autorizado
consulte esa página. No se promete historial completo ni entrega de toda tarea pasada. Este trabajo
no modifica el lector SQL, su protección de archivos, el escritor de tareas ni Native de relay-jobs.
La observabilidad corresponde al adaptador existente, fijado a Hermes
`ea114c3e98c3339e13004adfc6098cf28ed7d754`; no se importó ni ejecutó Hermes instalado.

## Privacidad, vigencia y límites

Los nuevos tipos publican sólo el `NotificationEnvelope` existente: schema, kind, noticeId aleatorio,
registrationId y expiresAt. No tienen comando, salida, nombre privado, ruta, key, URL de endpoint,
PID ni botones con efectos. No entran al registro privado de Aprobaciones: `GET …/notices/:id` y
`POST …/decision` devuelven 404 para esos noticeId. Native conserva la presentación genérica por canal;
abrir Relay o recibir un Aviso no constituye consentimiento ni elige un Servidor por defecto.
El diseño 21·1 da los cuatro canales; su texto privado y «Servidor no responde» no se convierten en
payload ni se presentan como hechos que el Puente no observó. UI/Native quedan a cargo de Root.

La entrega exige inscripción vigente, dispositivo válido y opt-in global y por tipo. Reemplazar,
deshabilitar o revocar aborta publicaciones pendientes mediante el mismo registro. El actor que
originó una lectura debe seguir autorizado después de las esperas del almacenamiento y antes de
publicar, incluso cuando el destinatario sea otro dispositivo válido. Después del transporte se
revalida inscripción, autorización, cancelación, cierre y vencimiento; una respuesta tardía no
puede restaurar `accepted` de la inscripción nueva. Cerrar el Puente impide nuevas publicaciones
procedentes de lecturas ya pendientes.

Los avisos genéricos vencen cinco minutos después de observar Turno/Servidor, o cinco minutos tras
`finishedAt` para tareas. El envelope además limita su vencimiento al de la inscripción: no extiende
la inscripción de siete días. `accepted` sólo confirma aceptación por el transporte; no recepción.
Un envío iniciado válidamente puede alcanzar ntfy antes de una revocación o vencimiento posteriores:
no se puede retirar de forma atómica de un teléfono sin red. El payload es genérico y no concede acciones.

La deduplicación efímera guarda como máximo 2048 hashes por tipo, observación e inscripción; vence
con la ventana de observación de cinco minutos. No expulsa entradas vivas para admitir otras. Se permiten como máximo 64 publicaciones
genéricas pendientes en total y ocho por dispositivo (incluyendo sus otras publicaciones pendientes
al evaluar el cupo). Lo que excede estos cupos se descarta, sin cola automática. Una publicación fallida
conserva su marca hasta vencer, sin retry. Tras reiniciar el Puente o registrar de nuevo puede volver
a observarse una fila aún reciente: la deduplicación no promete exactamente una vez entre procesos.
Un error nunca incorpora respuesta upstream al log ni altera el resultado confirmado de una tarea.

## Evidencia y coordinación

Pruebas en `bridge/test/notificationProducersHttp.test.ts`: servidor HTTP, RunManager y registro reales,
Hermes/publicador fake, perfiles y disco sintéticos dentro del worktree. Se ejercitan terminales,
recuperación, preferencias, vigencia, límites, lectura tardía, revocación con otro destinatario válido,
cola durable, cierre y redacción. Las pruebas previas de Avisos/ACK y suites de Turnos, Pausa general,
tareas y publicador conservan su comportamiento. Logs RED/GREEN y manifiesto quedan ignorados en
`notification-producers-handoff.log` y `notification-producers-mutation-*.log`.

Root compone `server.ts` con relay-jobs y Native; el DTO no cambió. Sin commits, gate, APK ni llamadas
a producción en este trabajo. La prioridad global sigue siendo v1 + wizard + APK + todo v2, incluida
Tablet; después README con capturas verificadas, instalación y prompt de setup; luego verificar V3
(código remoto, terminal y localhost desde el teléfono), tomarla si está lista y, en otro caso,
compatibilidad. No se adelanta compatibilidad inmediatamente tras v2.
