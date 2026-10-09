# Publicar Tarjetas del Tablero

Contrato aditivo de Relay v1 (#48a), definido en `protocol/board.ts`. No cambia la versión del
protocolo ni requiere una API nueva de Hermes, dependencias, configuración del gateway o servicios.

Cada Agente publica en un directorio **dedicado** `relay-board` dentro de su directorio de perfil.
El Puente utiliza los perfiles que ya conoce: el perfil predeterminado corresponde al directorio
base; los demás, a `profiles/<nombre>`. Esta separación coincide con
[el código de perfiles de Hermes fijado para esta entrega](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/profiles.py).
No se ha instalado ni ejecutado Hermes para esta implementación.

El Puente no crea directorios ni escribe perfiles. El Agente puede crear su directorio de
publicación cuando la persona se lo pida. En las pruebas solo se crean perfiles sintéticos dentro
del worktree. No se ha creado ninguna publicación en producción.

## Archivo

Una Tarjeta por archivo `<id>.json`, UTF-8 estricto, como `disk.json`. El identificador tiene de
1 a 64 caracteres ASCII, empieza por una letra o un número y admite letras, números, `.`, `_` y
`-`. El nombre del archivo da la identidad estable. Ni `id`, `agentId`, `agentName`, rutas,
cabeceras, credenciales, comandos, URL ejecutable ni campos adicionales pertenecen al JSON.

```json
{
  "title": "Disco /srv",
  "updatedAt": 1791028800000,
  "maxAgeMs": 3600000,
  "state": "ready",
  "content": { "type": "number", "value": "82", "unit": "%", "detail": "USO" }
}
```

Todos los campos son obligatorios. `title` tiene de 1 a 100 caracteres. `updatedAt` es el instante
real de la última actualización válida, en **milisegundos Unix**, entre 2000 y 2100, y no puede
superar el reloj del Puente en más de cinco minutos. `maxAgeMs` es un entero entre 1 000 y
2 592 000 000 (30 días). Los controles ASCII salvo tabulador y salto de línea se rechazan.

`state` admite `ready`, `updating` y `error`. El Agente debe publicar `updating` explícitamente
cuando empieza a actualizar; conserva contenido y fecha de la última lectura válida. Si falla,
publica `error` conservando esos datos. El Puente solo calcula `stale` cuando una publicación
`ready` supera `maxAgeMs`, usando su propio reloj. Nunca deduce `updating` de la edad.

| Tipo de `content` | Campos exactos adicionales a `type` |
|---|---|
| `number` | `value` texto hasta 32, `unit` hasta 24, `detail` hasta 120 |
| `meter` | `value` y `max` finitos, `0 ≤ value ≤ max`, `max > 0`; `unit` hasta 24 |
| `states` | `items`: 1–20 objetos con `label` hasta 100, `state` (`ok`, `warning`, `error`, `off`), `detail` hasta 100 |
| `series` | `unit` hasta 24; `points`: 1–120 objetos con `at` milisegundos crecientes, sin superar `updatedAt`, y `value` finito |
| `log` | `lines`: 1–50 cadenas de hasta 300 caracteres |
| `text` | `text`: hasta 4 000 caracteres, mostrado como texto nativo |
| `action` | `label`: hasta 60; `message`: texto no vacío de hasta 4 000 |

Los valores numéricos de contenido tienen magnitud máxima de un billón (`10^12`). El archivo no
puede superar 32 768 bytes, aunque todos los campos individuales quepan en sus límites.
Hay hasta 32 entradas de directorio por Agente y hasta 32 Agentes por consulta. Un archivo con
nombre inesperado o demasiadas entradas invalida ese directorio; no se trunca silenciosamente.

Para actualizar de forma atómica, preparar el archivo temporal **fuera de `relay-board`**, en el
mismo sistema de archivos, y renombrarlo a su destino final. No dejar temporales, subdirectorios,
symlinks ni hardlinks en el directorio publicado. Para retirar la publicación, eliminar su JSON.
El lector no acepta enlaces en ningún componente de la ruta, ni archivos con varios enlaces.

El texto publicado es visible para dispositivos emparejados: no publicar secretos. Esto no es
un sistema de aislamiento entre procesos del mismo usuario Unix. La atribución a un Agente viene
del perfil conocido que contiene la publicación, nunca de texto controlado por el JSON.

## Lectura y fallos

`GET /v1/board` requiere la autorización normal de un dispositivo de la tailnet y no acepta
parámetros. Devuelve `{ cards, observedAt, failedAgents }`; cada Tarjeta añade `id`, `agentId`,
`agentName` y `status`. La identidad del Agente sale de `Hermes.profiles()` y la publicación del
puerto opcional `Hermes.board.read(profile)`. Un adaptador que no lo implemente responde 503.

En Linux, el lector abre cada componente relativo al descriptor de su padre mediante
`/proc/self/fd`, con `O_DIRECTORY` y `O_NOFOLLOW`. Abre el archivo sin seguir enlaces y sin bloquear
con FIFO, exige archivo regular y `nlink = 1`, lee como máximo el límite más un byte y contrasta
longitud, tamaño, enlaces, mtime y ctime antes y después. No reabre una ruta validada para entregar
el contenido. Renombrar un directorio durante la lectura no redirige el descriptor ya abierto.
El lector falla de forma cerrada donde no existe esta capacidad Linux.

Si un archivo deja de ser válido, su Tarjeta queda fallida y conserva la última publicación
válida en memoria. Sin una anterior muestra un aviso genérico y `updatedAt: null`; no inventa
una fecha de actualización. Reiniciar el Puente vacía esa caché. Si no se puede abrir el
directorio, el Agente aparece en `failedAgents`. Si no existe, su Tablero está vacío. Una Tarjeta
retirada desaparece de la respuesta. Los errores nunca incluyen bytes del JSON, rutas ni errores
crudos del sistema; los logs solo registran la ruta fija, método, estado y duración.

## Botón de acción y refresco

```json
{
  "title": "Revisar backups",
  "updatedAt": 1791028800000,
  "maxAgeMs": 3600000,
  "state": "ready",
  "content": {
    "type": "action",
    "label": "Pedir revisión",
    "message": "Revisa los backups y dime si necesitan atención."
  }
}
```

El botón muestra el mensaje completo y su Agente. «Abrir Conversación nueva» navega al chat con
un borrador, sin enviar ni crear Turnos automáticamente. Pulsar «Enviar» crea una Conversación
Relay nueva y utiliza las rutas habituales `POST /v1/agents/:id/conversations` y
`POST /v1/agents/:id/runs`, con la cabecera y autorización habituales. No hay handler separado de
acción que pueda saltarse las guardas de chat, protocolo o Pausa general que integra el dueño
del Servidor. El borrador no recupera ni continúa la última Conversación existente.

Actualizar una Tarjeta prepara de la misma manera «Actualiza la Tarjeta …»; releer el Tablero
solo consulta archivos y nunca activa trabajo del Agente. No existe ejecución directa de shell,
HTTP, herramientas ni tareas programadas desde el contrato del Tablero.

## Preferencias y demostración

Orden, ocultas, quitadas y vistas se guardan localmente con `relay.board.<serverId>`; la identidad
local combina Agente y Tarjeta. Quitar no elimina el archivo del Agente. «Restaurar Tarjetas
quitadas» permite recuperarlas. Las ocultas se muestran en edición. Subir/Bajar permite ordenar
con controles accesibles sin depender de arrastrar. Las nuevas permanecen destacadas hasta
terminar edición o abrir una propuesta en el chat. Los fallos de almacenamiento se muestran.

La pestaña Servidores abre el Tablero; ADMIN. conserva la pantalla administrativa existente.
`demoBoardPage`, reexportado por `core/demo.ts`, incluye los siete tipos. El selector de demo
permite normal, estados de Tarjeta, vacío, cargando, error y sin respuesta. El estado de edición
y las propuestas se abren con sus controles habituales. No se usan WebViews.

## Verificación y límites de integración

- `bridge/test/board.test.ts`: HTTP contra Hermes falso, autorización/revocación, esquema,
  límites, siete tipos, fechas, estado explícito, symlinks, hardlinks y sustitución de directorio.
- `mobile/tests/components/Board.component.test.tsx`: AppProvider, ruta de chat y componentes
  reales; edición, preferencias por Servidor, estados, propuesta y envío explícito a Conversación
  nueva. Solo dobles compartidos de límites nativos, transporte y almacenamiento.
- Mutaciones RED/restaurar/GREEN en `board-mutation-*.log` del worktree (ignorados por Git).
- Las modificaciones de `hermes.ts`, `hermes_real.ts`, `server.ts`, clientes, demo, rutas y
  `ChatScreen.tsx` son puntos de integración compartidos que debe reconciliar root.
- Pausa general todavía no existe en este checkout base; no se implementa otra versión aquí.
  Al integrar su entrega, la acción hereda la misma guarda del chat porque no tiene vía propia.
- No se ha verificado APK ni dispositivo, ni tocado producción. Root ejecuta el gate completo
  después de integrar las entregas.
- La exportación web demo pasó. Se inspeccionó el estado de carga con Chromium offline y
  JavaScript desactivado; eso comprueba la estructura, no la hidratación ni las fuentes cargadas
  por la app. La revisión automática rechazó iniciar una vista previa HTTP por la prohibición
  de iniciar servicios. La revisión visual del contenido normal y edición queda a root.
