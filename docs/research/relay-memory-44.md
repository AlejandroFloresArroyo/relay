# Memoria y personalidad de Relay v1 — entrega #44

Implementación en `feat/agent-memory`, sobre `a23e25c`. La especificación autoritativa consultada
fue `../relay-app-v1/docs/relay-v1.md`. La integración, el gate completo, los commits, el APK y
la revisión en el teléfono corresponden al orquestador.

## Corrección del review sobre `97324c3`

Se corrigieron los tres hallazgos y se incorporó la decisión de Ale del 2026-10-04:

- El lector/editor y la confirmación consultan `bucket.writable` actual, además de la conexión.
  Un archivo de solo lectura no habilita edición ni acciones, incluso con la hoja ya abierta.
- Al revocar o quitar el Servidor se desmontan las hojas y se purgan selección, confirmación y
  borrador. Las pruebas incluyen nodos ocultos para detectar contenido privado retenido.
- Python prepara y hace fsync del temporal mientras conserva el flock y los descriptores abiertos.
  Envía metadatos cerrados de preparación, ligados al PID real, bucket fijo, directorio, temporal
  UUID y revisión retenida. Node valida identidades exactas, bytes, configuración, lock y cadena
  pública. Después ejecuta la última guarda y `fs.renameSync` consecutivamente, sin `await`, por
  `/proc/<pid>/fd/<dirFd>`. Python recibe el ACK, hace fsync del directorio y termina.

No hay permiso compartido con caducidad. La revocación local que actualiza el registro en el mismo
bucle de eventos de Node no puede intercalarse entre esa guarda y el syscall síncrono. Si ya está
revocado antes de la guarda, no se reemplaza. Si la revocación se confirma después del reemplazo,
la respuesta es incierta; no se promete que un archivo cambiado siga intacto.

El contexto de escritura exige `AbortSignal`. Las rutas observan el registro local durante la
operación y retiran la suscripción en `finally`. Antes del reemplazo, perder autorización cancela
realmente el proceso: SIGTERM, espera de salida y SIGKILL tras 100 ms si no termina. El helper
limpia su temporal y libera flock. Un SIGKILL excepcional puede dejar un temporal privado `0600`;
el kernel libera los locks y descriptores. El reemplazo exige Linux con `/proc` accesible; falla
cerrado si no puede validar los descriptores del hijo.

**Límites:** esto protege la revocación local de ese proceso de Node, no cambios de autorización
externos que el registro local todavía no conoce. Flock coordina Hermes y Relay; un escritor que
lo ignore puede competir después de la última comprobación: el sistema de archivos no ofrece
compare-and-swap general sobre bytes. Una pérdida de ACK, fsync, autorización o auditoría después
del reemplazo produce `agent_memory_uncertain`; no hay garantía de rollback ni de durabilidad
cuando falta esa confirmación.

La prueba final pausa la salida nativa `prepared` del helper real, después de retención y controles
Python. Exige que el proceso muera **antes** de liberar la barrera, con archivo intacto y sin
temporal. Otra prueba altera la notificación del registro y verifica la guarda síncrona final.
La prueba en `renameSync` encola revocación real y demuestra el orden reemplazo→revocación; la
frontera de ACK comprueba archivo cambiado + respuesta incierta. No se sustituyó la reproducción
por una pausa dentro de la auditoría. Los dobles solo interceptan límites nativos y ejecutan el
helper real sobre perfiles sintéticos del worktree.

El DTO actual no contiene una promesa de alcance temporal. Se conservan contrato, normalizador,
backend y demo sin campos nuevos. Las pantallas reales, también utilizadas en demo, anuncian que
Hermes puede aplicar los cambios al reconstruir el contexto, incluso en la Conversación actual.
No se promete el instante exacto ni se fuerza reinicio. Según la decisión de Ale y la especificación
actualizada por root, modelo, proveedor, directorio de trabajo y compresión pueden reconstruir
contexto; no equivalen a una garantía de aplicación inmediata. Las pruebas de alcance modificadas
son únicamente las dos interacciones nuevas de memoria/SOUL en
`mobile/tests/components/memory.component.test.tsx`; las pruebas core/DTO/demo siguen sin cambiar.
No se infiere una ruptura del protocolo de chat fuera de esta función todavía no publicada.

Evidencia persistente e ignorada dentro del worktree:

- `standards44-late-revocation-repro.log`: reproducción recibida, cambio pese a revocación previa.
- `correction44-local-atomicity-red.log`: RED de la frontera nativa Node contra el diseño anterior.
- `correction44-node-commit-green.log`, `correction44-node-cancel-green.log`,
  `correction44-node-metadata-green.log`: slices de la nueva frontera síncrona y metadatos cerrados.
- `correction44-node-managed-red.log` y `correction44-node-managed-green.log`: configuración
  administrada aparecida después de la preparación rechaza el reemplazo.
- `correction44-application-ui-red.log` y `correction44-application-ui-green.log`: aviso aprobado.
- `correction44-node-mutation-*.log`: aserciones RED y restauración GREEN de guarda final,
  revisión de archivo/configuración, bucket, cancelación real, incertidumbre tras reemplazo,
  aviso de contexto, editor/confirmación de solo lectura y privacidad al revocar.
- `correction44-bridge-final.log`, `correction44-components-final.log`,
  `correction44-client-final.log`, `correction44-bridge-types.log`,
  `correction44-mobile-types.log`, `correction44-mobile-lint.log`: validación final acotada.
- `correction44-handoff.log`: manifiesto exacto, hashes y resultados para revisión independiente.

Los logs anteriores de permiso de 250 ms y sus mutaciones son evidencia histórica del intento
sustituido, no prueba de atomicidad del parche final. El RED de propuesta de campo de protocolo
`correction44-application-contract-red.log` tampoco pertenece al contrato entregado.

Validación de esta corrección: 108 pruebas HTTP/Puente, 21 pruebas de componentes y 5 pruebas
core/cliente/demo verdes; ambos typechecks verdes. Lint acotado: cero errores y una advertencia
`no-require-imports` preexistente en la prueba de blur. Once mutaciones discriminantes actuales
producen aserciones RED y restauración GREEN. No se ejecutó gate ni se modificó producción.

## Comportamiento

- `GET/PATCH /v1/agents/:id/memory`: leer, editar y borrar notas existentes en
  `memories/MEMORY.md` y `memories/USER.md`. No permite añadir notas ni aceptar rutas del cliente.
  Borrar pide confirmación; editar es libre.
- `GET/PUT /v1/agents/:id/soul`: leer y editar `SOUL.md` completo. Un archivo ausente se crea
  únicamente al guardar, dentro de un Agente existente con configuración verificable.
- Las rutas móviles son `/agent/[server]/[agent]/memory` y `/soul`; la ficha de #43 ya las enlaza.
- Guardar personalidad exige biometría Android fuerte y desactiva la alternativa del código del
  teléfono. El `pendingRef` se toma antes de esperar la huella. Una respuesta tardía pierde validez
  tras blur, bloqueo, salida de la pantalla, cambio de credenciales o revocación del Servidor.
- La caché se muestra con fecha y antigüedad, en solo lectura. Una revocación oculta su contenido.
  Un conflicto conserva el borrador y obliga a recargar. Se avisa que Hermes puede incorporar
  los cambios al reconstruir contexto, incluso en una Conversación existente; no se fija el instante.
- La demo incluye lectura, edición, confirmación de borrado, SOUL completo, vacío, archivo ausente,
  carga, error, sin red con/sin caché, configuración de solo lectura, conflicto, exceso de cuota y
  advertencia de truncamiento. Los controles de estados solo aparecen en demo.

## Archivos y concurrencia

La lectura y escritura usan un proceso Python aislado, controlado desde `exec.ts`, sin importar
inicializadores de Hermes. Abre los componentes del perfil por descriptores relativos, exige
raíces y directorios del Agente propiedad del usuario sin escritura de grupo/otros, y rechaza
symlinks, hardlinks, FIFO, archivos excesivos y UTF-8 inválido. Una revisión combina hash de bytes,
identidad de archivo/directorios, Agente, archivo y configuración efectiva verificable.

Para memoria, el proceso conserva un `flock(LOCK_EX)` de kernel sobre `MEMORY.md.lock` o
`USER.md.lock` durante lectura, retención, auditoría y reemplazo. Una contención devuelve ocupado;
no sobrescribe. SOUL usa su propio `SOUL.md.lock` para coordinar escritores de Relay. Una cola de
Node no sustituye este bloqueo.

Antes del reemplazo, se guardan los bytes anteriores en el directorio privado del Puente, con
modo `0600`, fsync del archivo y del directorio. `memory-<id del registro>.previous` permite
relacionar la copia con el registro de solicitud. Este contiene fecha, dispositivo, Agente,
archivo lógico y si existía una versión anterior; nunca contenido, cabeceras, rutas privadas o
llaves. Después se registra la terminación. Si no puede confirmarse, se devuelve estado incierto.

Tras la retención se vuelven a comprobar revisión, configuración, directorio público y la
identidad del lock. Node repite estos controles, reemplaza síncronamente por el descriptor vivo y Python hace
fsync del directorio antes del ACK final. El bloqueo protege
la concurrencia con Hermes. Los editores externos que no respeten ese lock se detectan mediante
revisión antes y durante la retención; esto no convierte una revisión optimista en una operación
compare-and-swap frente a un escritor arbitrario que intervenga después de la última comprobación.

El núcleo existente conserva delimitador completo, strip de Python, caracteres Unicode,
índice + texto previo exactos y BOM/bytes de las notas hermanas. Se añadió la lectura universal
de newlines de Python para archivos CRLF/CR, conservando sus separadores físicos al editar. Borrar
sigue permitido si la memoria existente supera su cuota.

## Límites y fuente fijada

Fuentes públicas consultadas, sin acceder al Hermes instalado:

- [Bloqueo, delimitador, strip y presupuestos de memoria](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/tools/memory_tool_store.py).
- [Configuración de memoria incorporada](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/tools/memory_tool.py).
- [Defaults de memoria y contexto](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/config_defaults.py).
- [Configuración administrada](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/managed_scope.py).

`memory_char_limit` y `user_char_limit` se obtienen de configuración local verificable; sus
defaults son 2200 y 1375. El conteo incluye los delimitadores entre notas, en code points como
Python. Configuración administrada, referencias externas o configuración no verificable producen
cuotas desconocidas y solo lectura.

`context_file_max_chars` explícito se muestra como límite de carga en contexto. Con el default
resuelto dinámicamente por la ventana del modelo se muestra «no conocido»: no se inventa un
límite universal de 20 000. Superarlo advierte de truncamiento en Hermes, pero permite guardar el
archivo completo. Separadamente, el Puente limita cada archivo a 1 MiB, las peticiones JSON a
6 MiB + 4096 y las respuestas a 12 MiB + 4096 en el cliente, también para errores. No se añaden
dependencias; el parser YAML usa el entorno Python ya instalado de Hermes.

## Integración con #43

Los helpers `bridge/src/hermesRuntime.ts` y `mobile/src/state/confirmWithFingerprint.ts` son copias
exactas de #43. No se copiaron ni se modificaron sus módulos privados de retención. La retención
actual solo se usa en memoria/personalidad; no se creó una abstracción común ni una migración de
AgentDetailsService.

Al integrar, conservar ambas extensiones de los archivos compartidos:

- `bridge/src/hermes.ts`, `hermes_real.ts`, `server.ts`, `exec.ts`, `changeLog.ts`.
- `mobile/src/core/client.ts`, `bridgeClient.ts`, `demo.ts`.
- En `changeLog.ts`, añadir las acciones de memoria/personalidad y la variante cerrada de
  `details: { file: 'memory' | 'user' | 'soul', previous: boolean }` solo para solicitudes de estas
  acciones. La auditoría existente de emparejamiento, seguridad y chat conserva sus validadores.
- `protocol/agentMemory.ts` es independiente. `Hermes.memory` es opcional; la ausencia del puerto
  produce una respuesta explícita de función no disponible. Las rutas exigen el protocolo actual;
  los errores y respuestas se normalizan y se validan por Agente en el cliente.

## Evidencia

Los seams ejercitados son core puro, HTTP con fake Hermes/perfiles sintéticos y componentes
Android con AppProvider, hooks y LockGate reales. Los dobles de componentes siguen ADR 0003.
Toda la evidencia está en logs ignorados dentro de este worktree:

- `memory-bridge-final.log`: 116 pruebas verdes del slice y regresiones de ChangeLog, exec,
  servidor y RealHermes con fakes.
- `memory-client-final.log`: 20 pruebas verdes de cliente, límites de respuestas,
  normalizadores, demo, conexión y versión de protocolo.
- `memory-components-final.log`: 14 pruebas verdes de interacción, huella fuerte, doble toque, confirmación,
  respuestas tardías, caché persistente, bloqueo real, errores y archivos ausentes.
- `memory-bridge-types.log`, `memory-mobile-types.log`, `memory-mobile-lint.log`.
- `memory-mutations-bridge.log`, `memory-mutations-components.log`,
  `memory-mutations-pending.log`, `memory-mutations-final.log`: RED y restauración GREEN de
  identidad, conteo UTF-16 incorrecto, revisión posterior a retención, flock, symlink, bytes de
  retención, autorización, protocolo, huella tardía/débil, borrado sin confirmación, doble envío,
  newlines y límite de payload. La primera mutación del pendingRef fue insensible; se reforzó el
  doble toque dentro del mismo act y su segunda mutación sí produjo RED, seguido de GREEN.
- `memory-newlines-red.log` y `memory-newlines-green.log`: lectura CRLF/CR y conservación de bytes.
- `memory-outcome-red.log` y `memory-outcome-green.log`: fallo de auditoría posterior al reemplazo.
- `memory-retention-association-red.log`: copia anterior inicialmente sin relación con el registro;
  el test de asociación queda verde en la suite final.
- `memory-preview-export.log`: exportación web de demo. Se revisaron los PNG y HTML 13-1/5/12/20/
  21/22/6/7/8/9 y se conservaron primitives/tokens. La captura de la preview con Chromium no terminó
  (`Page.captureScreenshot` agotó su plazo); no se afirma verificación visual final ni en Android.

Sin commits, merges, gate completo, APK, ADB ni acceso a producción. La comprobación de huella en
el dispositivo y la revisión visual independiente quedan en la integración del orquestador.
La comprobación final no encontró workers Python, navegadores de la preview ni perfiles sintéticos
pendientes; los helpers compartidos siguen siendo copias exactas de #43 y `git diff --check` pasó.
