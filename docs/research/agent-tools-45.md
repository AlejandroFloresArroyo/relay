# Herramientas y skills del Agente (#45)

Entrega aislada en `feat/agent-tools`. Root integra, hace el gate completo, compila el APK y valida
el teléfono. Esta construcción usa exclusivamente perfiles sintéticos, FakeHermes, transporte
controlado y los límites nativos del arnés. No se ejecutó Hermes real ni se reinició ningún servicio.

## Fuente fijada y decisiones

Se leyó el código público de Hermes en
[`ea114c3e98c3339e13004adfc6098cf28ed7d754`](https://github.com/NousResearch/hermes-agent/tree/ea114c3e98c3339e13004adfc6098cf28ed7d754).
La copia descargada queda ignorada bajo `hermes-source.log/`; no se importó ni ejecutó.

- [`_handle_toolsets`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/gateway/platforms/api_server.py#L2968)
  devuelve el catálogo canónico de `api_server`: nombre, etiqueta, descripción, `enabled`,
  `configured` y herramientas concretas. Relay lo conserva; no construye un catálogo alternativo.
- [`_save_platform_tools`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/tools_config.py#L722)
  también retira entradas de `agent.disabled_toolsets`. Por eso Relay no usa la CLI para encender
  o apagar. Escribe solamente las hojas `api_server` de `platform_toolsets`,
  `known_builtin_toolsets` y `known_plugin_toolsets`, sin tocar las restricciones globales.
- [`_get_platform_tools`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/tools_config.py#L590)
  expande los compuestos, conserva MCP y aplica las restricciones globales al final. Relay materializa
  la selección canónica habilitada, conserva las entradas MCP explícitas y `no_mcp`, y mantiene
  `context_engine` cuando ya correspondía. Los nombres canónicos se registran como conocidos para
  evitar que un conjunto recién reconocido se encienda por su ausencia de la lista.
- [`_create_agent`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/gateway/platforms/api_server.py#L2374)
  vuelve a leer configuración y selección del canal al crear la instancia del Agente. Ale confirmó
  con Hermes real que la selección puede entrar en el siguiente Turno de una Conversación
  existente. El aviso expresa esa posibilidad; no exige una Conversación nueva ni promete una
  actualización del Turno activo. Relay guarda la selección de `api_server`, el canal del chat
  de Relay, y no ofrece controles para modificar la selección de otros canales. Esta corrección
  usa esa comprobación de Ale; no se ejecutó Hermes real desde este worktree.
- [`_handle_skills`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/gateway/platforms/api_server.py#L2952)
  pasa `include_editorial=True`, que
  [`_find_all_skills`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/tools/skills_tool.py#L184)
  no admite en este commit: de ahí el 500. La CLI
  [`do_list`](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/skills_hub.py#L817)
  llama a `ensure_hub_dirs()`. Relay evita ambos caminos y lee metadata instalada sin inicializar
  directorios ni importar Hermes.

## Contratos y archivos

`protocol/agentTools.ts` aporta tipos y constantes separados del protocolo principal. El puerto
opcional `Hermes.agentTools` permite que los Hermes anteriores sigan compilando. Las únicas rutas
nuevas son:

- `GET /v1/agents/:id/tools`
- `POST /v1/agents/:id/tools/:toolset`, con `{ "enabled": boolean }`
- `GET /v1/agents/:id/skills`

El DTO de lectura y del resultado de guardar usa `platform: "api_server"` y
`appliesTo: "next_turn"`: describe cuándo puede entrar la selección, incluso en una Conversación
existente; no garantiza aplicación inmediata ni exclusividad a Conversaciones nuevas. El lector,
la demo, el normalizador y BridgeClient comparten ese contrato. Los literales antiguos o desconocidos
se rechazan también en un ACK de guardado: no se presentan como cambios confirmados. Una caché con
`new_conversations` se descarta para Herramientas, sin migrarla ni habilitar escrituras.

Los endpoints de Herramientas no estaban publicados en el APK anterior. Se corrige su literal sin
cambiar la versión global del protocolo; el chat conserva su contrato y su cabecera existentes.
Un Puente antiguo puede pasar la comprobación global de protocolo 2 y devolver
`appliesTo: "new_conversations"`. Relay rechaza esa lectura para Herramientas y no permite editar.
Si el Servidor sigue alcanzable y compatible, la UI informa que Herramientas no tiene una lectura
válida o disponible, recomienda actualizar si el Puente usa el contrato anterior y conserva la
compatibilidad independiente del chat. No lo atribuye a una falta de respuesta de toda la máquina.
Las causas conocidas de revocación, protocolo o conexión se conservan; el diagnóstico no inventa
una causa concreta para otros errores de lectura que no se pueden distinguir desde ese estado.

Usan la autorización y `X-Relay-Protocol` existentes. El teléfono confirma huella fuerte antes de
encender, sin fallback al PIN; apagar es libre. El Puente no verifica huella: es la frontera de
seguridad fijada por la especificación.

El adaptador nuevo está en `bridge/src/hermesAgentTools.ts`. Su transformador
`agent_tools_metadata.py` importa solamente biblioteca estándar y PyYAML del Python de Hermes;
no agrega dependencias al proyecto ni instala paquetes. Puede inyectarse `toolsPython` para pruebas
sintéticas. Si Python/PyYAML no está disponible, falla con un mensaje fijo y no escribe.

Antes de escribir, el adaptador conserva el archivo raw anterior en el directorio privado del
Puente (`agent-tools-<uuid>.previous`, 0600, sincronizado), registra un intento sin contenido en
la bitácora y vuelve a comprobar autorización y que el raw no haya cambiado. Después reemplaza
atómicamente el archivo. Los intentos fallidos pueden dejar respaldo y registro; no se presentan
como cambios confirmados. Se serializan los cambios de Relay por Agente.

La app usa `AgentToolsScreen.tsx`, `state/agentTools.ts` y los validadores de `core/agentTools.ts`.
Las rutas son `/agent/[server]/[agent]/tools` y `/agent/[server]/[agent]/skills`. La primera muestra
herramientas y skills siguiendo 13-2; la segunda muestra solo skills. La confirmación sigue 13-18.
La última lectura se guarda con su fecha y con alcance por Servidor, dirección, dispositivo y
Agente. Una nueva identidad emparejada no hereda la caché anterior. Los cambios requieren una lectura
válida de herramientas y conexión compatible; la caché siempre se presenta en solo lectura si no hay respuesta.

`confirmWithFingerprint.ts` es una copia exacta del helper autorizado de #43, tomada de
`../relay-app-agent-details`. Root debe resolver ese archivo duplicado al integrar.

Los cambios compartidos que root debe integrar están en `hermes.ts`, `hermes_real.ts`, `server.ts`,
`changeLog.ts`, `client.ts`, `bridgeClient.ts` y `demo.ts`. La ficha de #43 enlaza las rutas acordadas;
no se modificó su worktree. Demo tiene datos para configuración, deshabilitación, huella, skills
instaladas/deshabilitadas y el Agente sin respuesta; en la pantalla permite elegir normal, vacío,
parcial y sin respuesta.

## Límites reales

- Una restricción global que coincida con el conjunto o sus herramientas bloquea encender. Si el
  nombre global no se puede resolver desde el catálogo canónico, también se bloquea: se revisa en
  el Servidor. Una restricción canónica ajena permanece intacta y no impide el cambio.
- Los compuestos personalizados del canal que no se puedan expandir de forma segura bloquean la
  escritura. Los compuestos estándar del commit fijado se materializan desde el catálogo.
- YAML con aliases, anchors, claves duplicadas o profundidad excesiva se rechaza. No se interpreta
  código. La comparación semántica verifica que solamente cambien las tres hojas del canal.
- Skills tiene alcance explícito `profile_installed`: lee `<Agente>/skills/**/SKILL.md`.
  No importa plugins, busca en proyectos ni sigue directorios externos configurados. Tampoco
  comprueba credenciales, aplicaciones o requisitos de ejecución. Por eso dice «INSTALADA» o
  «DESHABILITADA», nunca inventa «ACTIVA».
- La lectura limita profundidad a 8, entradas a 2048, skills a 256, cada archivo a 64 KiB y contenido
  agregado a 2 MB. El perfil admite hasta 1 MiB de configuración. Rechaza symlinks, hardlinks y
  archivos especiales; la app avisa cuando la lectura es parcial. No se sirven instrucciones de
  las skills, solo metadata.
- La lectura segura fija descriptores mediante `/proc/self/fd`: este adaptador requiere Linux.
  En otros sistemas falla sin escribir; no se validó portabilidad.
- Los tests comprueban el cableado Android con React Compiler y límites nativos controlados.
  La presentación y la huella reales del teléfono quedan para root; no se validaron aquí.

## Pruebas y mutaciones

Pruebas nuevas: `bridge/test/agentTools.test.ts`, `bridge/test/agentToolsHttp.test.ts`,
`mobile/src/core/agentTools.test.ts` y `mobile/tests/components/AgentTools.component.test.tsx`.
Cubren catálogo, aislamiento de canales, respaldo/auditoría antes de escribir, configuración,
restricciones globales, YAML, seguridad y límites de skills, revocación durante lectura, protocolo,
redacción, huella cancelada/pendiente/válida, apagar libre, metadatos inválidos y caché persistente.

Se guardaron RED, restauración y GREEN de doce mutaciones en archivos ignorados `*.log` del worktree:
configuración, respaldo raw, auditoría previa, symlinks, restricción global, tamaño de skills,
huella, controles offline, revocación, milisegundos/segundos, protocolo y redacción de errores.
Los logs de validación final usan el prefijo `tools-`. El gate completo y el APK pertenecen a root.

Validación final: 10 pruebas del adaptador, 5 HTTP, 2 de contrato core y 9 de componentes, todas
en verde. Regresiones acotadas: 8 de auditoría, 26 de cliente/core y 4 de demo, también en verde.
Pasaron tipos de Puente y app (incluidos componentes), lint y `git diff --check`. El helper de
huella coincide byte a byte con #43. No se ejecutaron gate completo, exportación web ni APK.
