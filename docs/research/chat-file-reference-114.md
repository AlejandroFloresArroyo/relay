# Adjuntar un archivo del Servidor por referencia (#114)

Fecha: 2026-10-06. Fuentes: Hermes instalado en `~/.hermes/hermes-agent` (solo lectura), la configuración
`~/.hermes/config.yaml`, el Puente (`bridge/`) y una prueba en vivo contra el Hermes en marcha.

**Conclusión: viable.** Hermes recibe la ruta como texto en el mensaje de la persona, el Agente la lee
él mismo en la máquina con `read_file` y el contenido no viaja por Relay.

## Cómo recibe Hermes la referencia

- El Puente manda cada Turno con `POST 127.0.0.1:8642[/p/<perfil>]/v1/runs` (`bridge/src/hermes_real.ts:692-711`),
  con el cuerpo de `hermesRunBody` (`bridge/src/chatImages.ts:32-46`): `input` es texto, o una lista de partes
  cuando hay imágenes.
- `/v1/runs` (`gateway/platforms/api_server_runs.py:620-760`) toma `body["input"]`; si es texto, es el mensaje de
  la persona (L650-656). **No hay campo de adjuntos.** `instructions` se convierte en `ephemeral_system_prompt`
  (L735): un prompt de sistema efímero que no queda en el historial, así que no sirve para la referencia.
- Los otros endpoints rechazan partes de archivo: `api_server.py:491-495, 528-571` («uploaded files and document
  inputs are not supported»).
- Las pasarelas propias de Hermes adjuntan documentos igual: una nota de texto antepuesta al mensaje
  (`gateway/run.py:2550-2569`, `run_inbound.py:1562-1590`), del tipo «It is saved at: <ruta>. Its content is not
  inlined here. Read the cached file yourself…».

Por eso la referencia viaja **como texto**: el Puente antepone a `input` una línea fija por archivo, una línea en
blanco y el texto de la persona:

```
[The user attached a file that is on this machine: <ruta real>. Its content is not included; read it from that path yourself when the request involves it.]
```

## Si la respeta: el Agente lee la ruta en la máquina

- Herramientas de `/v1/runs`: `api_server.py:2401` toma `_get_platform_tools(config, "api_server")`; sin entrada
  `api_server` en `platform_toolsets` se usa el toolset `hermes-api-server`, que es
  `_core_without('text_to_speech', 'clarify', 'computer_use')` (`toolsets.py:12-16, 207-210`). Incluye
  `read_file`, `terminal` y `vision_analyze`. Ni `config.yaml` ni `profiles/coding` ni `profiles/personal` tienen
  entrada `api_server` en `platform_toolsets`.
- Backend: `~/.hermes/config.yaml` `terminal.backend: local` (L44-46); `profiles/coding` y `profiles/personal`
  también son `local`. El Agente corre como la misma cuenta, en la misma máquina que el Puente.

## Límites que aplica Hermes

- Directorios: ninguno permitido de forma explícita. Las rutas absolutas se resuelven y no se anclan a un
  directorio de trabajo (`file_tools_paths.py:267-275`).
- La única guarda de lectura es una lista de rechazo aplicada tras `resolve()` (`agent/file_safety.py:365-412`):
  `.env*`, los almacenes de credenciales de Hermes, `skills/.hub`, `mcp-tokens/` y `browser-profile/`. Un archivo
  que el Puente acepte puede ser rechazado ahí; el Agente lo dice en su respuesta.
- Sandbox: no hay; el backend es `local`. Con `terminal` el Agente lee todo lo que la cuenta puede leer.
- Enlaces simbólicos: se siguen (`resolve()`). `file_tools.py:184-218` comprueba dispositivos en cada salto y
  rechaza FIFO y sockets.
- Tamaño: páginas de 2000 líneas o 100 000 caracteres por lectura (`file_operations_common.py:275`,
  `file_tools.py:51`); PDF y documentos de Office hasta 50 MB (`read_extract.py:30-36`). Como no cruza ningún byte
  por Relay, el Puente no pone tope de tamaño.

## Cómo lo ve el Agente

Como texto del mensaje de la persona. Queda tal cual en `state.db` (tabla `messages`), que Relay lee con
`messageText` (`bridge/src/hermes_conversations.ts:67-82`, lectura de la ADR 0004). Por eso la app y la vista
previa de la Conversación convierten las notas iniciales en chips y nunca muestran la nota en bruto.

## Prueba en vivo (2026-10-06)

Script fuera del repositorio (`/tmp/relay114-probe/probe.mjs`). La clave se lee del `.env` del perfil por defecto
en tiempo de ejecución y no se imprime.

1. Se escribió un nonce aleatorio en `/tmp/relay114-probe/nonce.txt`.
2. `POST /v1/runs` con `input` = nota de `/tmp/relay114-probe/nonce.txt` + línea en blanco + «Responde solo con la
   palabra que contiene el archivo adjunto.» → `202`, con `run_id`.
3. Eventos del Turno:
   - `tool.started` `tool: read_file`, `preview: nonce.txt`;
   - `tool.completed` `read_file`, `error: false`, contenido `1|relay114-2b0cb6d1`;
   - `run.completed` con `output: "relay114-2b0cb6d1"`, el nonce exacto.
4. La prueba dejó una sesión en `~/.hermes/state.db` (`run_7cadee2cb8a74fe28c4b5cc9d03b3037`, `source = api_server`),
   cuyo primer mensaje `user` empieza por la nota. No escribe en el perfil (ni memoria, ni `SOUL.md`, ni
   configuración).
5. Hermes falso: `FakeHermes.createRun` registra la petición (`bridge/support/fake_hermes.ts:296-297`), así que
   las pruebas del Puente comprueban el `input` compuesto con `hermes.callsTo('createRun')`.

## Qué valida el Puente

Lo mismo que ya sirve la capacidad Archivos, nada más amplio (no hay raíces por dispositivo, ADR 0006): Archivos
activo (`RELAY_REMOTE_FILES=1`), ruta absoluta canónica, existente, legible por la cuenta del Puente, archivo
regular (no carpeta, FIFO, socket ni dispositivo) y que no sea dato del Puente (`ProfileWriteGuard.check`, que
falla cerrado si no puede clasificar). Los enlaces se siguen y se manda la ruta real validada, que tampoco puede
tener caracteres de control. El Puente lo comprueba todo antes de crear él mismo una Conversación o un Turno.
La app, como con las imágenes, crea antes la Conversación nueva: un archivo rechazado deja esa Conversación vacía.
El contrato es aditivo: `files` opcional en `POST /v1/agents/:id/runs` y la capacidad `chat_files`;
`PROTOCOL_VERSION` no cambia.

## Riesgos aceptados

- **El Puente es una guarda del contrato, no un sandbox.** El Agente tiene `terminal` y lee toda la máquina, y la
  persona puede escribir una ruta a mano. La validación limita solo lo que Relay adjunta.
- TOCTOU: tras validar, un componente de la ruta real puede cambiar antes de que Hermes la lea. Se acepta por la
  misma razón.
- Hallazgo adyacente, sin arreglar aquí: con imágenes, `hermesRunBody` termina `input` con una parte `image_url`, y
  `_handle_runs` lee `raw_input[-1].get("content")` (L656). [INFERENCE] El texto de un Turno con imagen podría
  perderse; necesita una prueba de humo.
