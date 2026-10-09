# Actividad: registro de cambios del Puente

Contrato aditivo en `protocol/activity.ts`. No cambia la versión del protocolo ni los endpoints
anteriores. `GET /v1/activity` exige el encabezado de protocolo vigente, tailnet y un dispositivo
emparejado activo. Un Puente anterior responde 404: la app debe indicar que no ofrece Actividad.
No se añade configuración ni se consulta Hermes para esta lectura.

## Consulta y datos

Parámetros opcionales: `limit` (50 por defecto, de 1 a 100), `cursor`, `agentId`, `category`
(`configuration`, `conversations`, `tasks`, `server`) y `failuresOnly` (`true` o `false`).
Se rechazan parámetros desconocidos, duplicados y valores inválidos. `agentId` admite hasta
256 caracteres ASCII de identificador: letras, números, punto, guion y guion bajo; comienza
con letra o número. La app combina ese identificador con su Servidor local.

Cada entrada tiene identidad, fecha UTC en milisegundos, actor (`server` o dispositivo por ID),
acción enumerada, categoría, resultado, alcance Servidor/Agente y referencia nullable a Conversación.
La app añade el nombre del Servidor y las etiquetas. No se entregan nombres libres de dispositivo,
IP, contenido, comandos, títulos, reglas, modelos, revisiones, rutas, backups ni errores originales.
Los errores HTTP contienen exclusivamente códigos y mensajes fijos.

`requested` significa **Solicitado**, incluso para cambios pendientes del Modo de aprobación,
herramientas y tareas. `failed` significa **No se pudo confirmar**: no garantiza que no hubo efectos.
`accepted` confirma aceptación, no ejecución; `uncertain` conserva la incertidumbre. `recorded`
identifica un hecho auditado sin convertirlo en ejecución. No se agrupan eventos en operaciones:
los productores actuales no guardan un identificador común para solicitud y desenlace.
«Solo fallos» incluye `failed`, `rejected` y `uncertain`, conservando etiquetas distintas:
«No se pudo confirmar», «Rechazado» y «Resultado incierto». Un rechazo puede ser una protección
deliberada; no equivale a fallo técnico. La incertidumbre no se convierte en un fallo confirmado.
Las solicitudes (`requested`) quedan fuera del filtro.

La referencia a Conversación se entrega solo para creación/renombrado confirmados y cambio de modelo
o de personalidad registrado. No demuestra existencia actual ni identifica un mensaje. Los cambios de Turno carecen
de una referencia durable a Conversación en este registro; llevan al Agente.

## Lectura, paginación y límites

Solo se abre `changes.jsonl` del directorio de estado que ya usa el Puente. La lectura es Linux,
con descriptores relativos a cada ancestro y `O_NOFOLLOW`; verifica identidad, versión, propiedad,
permisos privados y ausencia de enlaces duros. Nunca llama a recuperación del escritor ni crea,
trunca o repara archivos. Una cola incompleta de hasta 8 KiB queda fuera del prefijo consultable.
Una línea completa corrupta, archivo desaparecido o reemplazado produce error; nunca vacío ficticio.

La primera página fija el prefijo completo y ordena fecha e ID descendentes. Cada continuación
comprueba la identidad del archivo y sus ancestros, y el hash del mismo prefijo. Los anexados después
no entran hasta actualizar. El cursor opaco lleva MAC con material efímero del proceso, está ligado
al dispositivo y filtros, y caduca a los diez minutos, también si caduca durante una lectura lenta.
El límite de página puede cambiar. Reiniciar el Puente invalida cursores, sin borrar el historial.

Topes: 16 MiB de entrada por lectura inicial, 50.000 registros, 8 KiB por línea, 100 entradas por
respuesta, cuatro snapshots vivos y una lectura concurrente. La memoria retenida tiene un presupuesto
calculado de 32 MiB (512 bytes por entrada más dos veces su representación JSON, incluyendo todos los
registros del snapshot). Este presupuesto puede rechazar conjuntos antes del techo de 50.000 filas;
no es una medición del heap de V8. El buffer de lectura y la proyección temporal también quedan
acotados por los límites de bytes/filas y la exclusión de lecturas concurrentes.

No se expulsan snapshots válidos para admitir otros: `activity_busy` pide esperar o reintentar.
Los snapshots caducados liberan cuota al consultar. `activity_limit_exceeded` conserva el archivo
intacto; no se añade rotación o borrado automático. No usar sondeo que cree snapshots nuevos de
una lista paginada cada pocos segundos. Cada Servidor conserva su cursor; el agregado global de
la app marca fuentes incompletas y no promete sincronización entre relojes de máquinas.

Se revalida autorización tras cada espera y antes de entregar la página. La app elimina datos y
cursores ante revocación o reemparejamiento; distingue causas conocidas mediante el diagnóstico común.
Loading, vacío confirmado, error, offline parcial y demos corresponden a `16a-1..4` y estados asociados.
Los días de una consulta incompleta no se presentan como «Sin actividad».

## Cobertura y alcance

Actividad consulta cambios auditados del Puente. No inventa mensajes, comandos, Decisiones o eventos
Discord de los canvas; el historial de Decisiones continúa separado. Tampoco importa eventos de
otros canales ni conserva los Turnos en memoria más allá de su política actual.

Las pruebas cruzan el lector con filesystem sintético y GET con App real, dispositivos sintéticos
y Hermes fake. Las mutaciones temporales verifican privacidad, resultados, cursores, tiempo,
identidad/versión/integridad, enlaces, límites, autorización y protocolo, con evidencia RED por
aserción y restauración GREEN en `activity-mutation-*-{red,green}.log` del worktree.


## Composición con Personalidad y Avisos

El lector admite explícitamente estos productores válidos del registro, sin cambiar la versión
global del protocolo ni interpretar eventos desconocidos:

| Productor | Acción en el DTO | Categoría | Resultado |
|---|---|---|---|
| `personality.preset.create.requested/succeeded` | `personality.preset.create` | Configuración | Solicitado / Confirmado |
| `personality.preset.update.requested/succeeded` | `personality.preset.update` | Configuración | Solicitado / Confirmado |
| `personality.preset.delete.requested/succeeded` | `personality.preset.delete` | Configuración | Solicitado / Confirmado |
| `personality.soul.apply.requested/recorded` | `personality.soul.apply` | Configuración | Solicitado / Registrado |
| `conversation.personality.changed` | `conversation.personality.change` | Conversaciones | Registrado |
| `notification.registration.requested` | `notification.registration` | Servidor | Solicitado |

Los presets tienen alcance de Servidor. Su UUID no se entrega ni se convierte en una referencia
a Conversación. Aplicar a SOUL.md conserva únicamente el identificador del Agente; no entrega el
texto, nombre del preset o backup, ni promete aplicación exclusiva o inmediata en otros canales.
La elección de personalidad conserva la pareja Agente/Conversación auditada. Inscribir Avisos
no confirma recepción de notificaciones: el productor solo registra la solicitud.

La app valida categorías, alcances, referencias y resultados de estas acciones; copia únicamente
el DTO permitido. Una entrada completa desconocida o corrupta sigue rechazando la consulta entera,
sin descartarla ni mostrar un subconjunto que parezca completo. Un Puente/app anterior sin estas
acciones puede rechazar la lectura; no se cambia el contrato de chat ni se inventa compatibilidad.
