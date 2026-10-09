# Lectura segura de tablas Hermes

Corrección de revisión de #43/#48b, 2026-10-04. La única frontera SQL es `bridge/src/hermes_store.ts`, extraída del adaptador de Conversaciones conforme a ADR 0004. `hermes_conversations.ts`, `agentUsage.ts` y `serverUsage.ts` reciben proyecciones acotadas; las ventanas de calendario y las agregaciones de uso permanecen en sus módulos. Se conservan `readAgentUsage`, `readServerUsage`, los DTO y la distinción entre costo conocido cero y costo desconocido.

## Rutas modificadas

- `/home/user/dev/relay-app-v1/bridge/src/hermes_store.ts`
- `/home/user/dev/relay-app-v1/bridge/src/hermes_conversations.ts`
- `/home/user/dev/relay-app-v1/bridge/src/agentUsage.ts`
- `/home/user/dev/relay-app-v1/bridge/src/serverUsage.ts`
- `/home/user/dev/relay-app-v1/bridge/support/sqlite_reader_fault.ts`
- `/home/user/dev/relay-app-v1/bridge/test/hermesStoreSecurity.test.ts`
- `/home/user/dev/relay-app-v1/docs/adr/0004-lectura-de-conversaciones-hermes.md`
- `/home/user/dev/relay-app-v1/docs/hermes-store-reading.md`

`exec.ts` y el fixture existente de Conversaciones se restauraron sin delta final. No se modificó wiring root, UI, protocolo ni otro worktree. Sin commits, cambios de rama, agentes o gate.

## Apertura y fuentes

No se abre ninguna ruta original con SQLite, ni siquiera para leer encabezados o metadatos. El recorrido desde `/` fija cada directorio mediante `O_DIRECTORY | O_NOFOLLOW`; los archivos principal, WAL, SHM y journal se abren `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` a través del descriptor del directorio. Se rechazan archivos no regulares, hardlinks, symlinks, escapes y límites excedidos.

Antes y después de copiar se reabren las entradas sin seguir symlinks y se comparan con los descriptores fijados: dispositivo/inodo, tamaño, modo, número de enlaces, `mtimeNs` y `ctimeNs`. Los ancestros conservan su identidad. También se comprueba que los auxiliares inicialmente ausentes continúen ausentes. Una desaparición después de fijar el principal es error, nunca consumo cero. Una BD ausente desde el inicio conserva la semántica anterior de cada adaptador.

Se copian principal, WAL y journal en bloques de 64 KiB a un directorio aleatorio privado `0700`, con archivos `0600` creados exclusivamente. SHM se valida pero no se transporta: es un índice efímero que SQLite reconstruye en la copia. La conexión usa URI `mode=ro`, `readOnly`, `query_only` y `trusted_schema=OFF`; aplica el protocolo WAL normal, sin `immutable=1`. Así incluye los frames confirmados y descarta los no confirmados. Un perfil WAL sin SHM/WAL puede leerse si los controles de presencia y versión permiten una copia estable; nunca se deduce inmutabilidad por ausencia de SHM. Los auxiliares que SQLite cree o reinicialice son exclusivamente privados.

Un `lstat` posterior o una comprobación de los fds nativos no evitan una escritura anterior a SHM. La prueba P1 intercambia SHM por un hardlink justo antes de abrir SQLite. Al mutar el URI para abrir el original, SQLite cambia los bytes del destino enlazado: RED explícito. Con el URI privado restaurado, los bytes permanecen idénticos: GREEN. Se retiró la solución previa de subprocess/fds efectivos porque no protegía ese efecto inicial y ya no es necesaria.

## Límites reales

- Linux con `/proc/self/fd` y semántica local fiable de identidad y tiempos. Otras plataformas fallan como indisponibles.
- Principal: 64 MiB para Conversaciones/Servidor; 512 MiB para Agente, manteniendo su límite anterior. Cada auxiliar: 64 MiB. Lectura por bloques, sin cargar esos archivos completos en memoria.
- Proyección: hasta 50.000 sesiones y 200.000 mensajes, presupuesto conjunto de 12 MiB de contenido más una cuenta conservadora por fila. Lista y búsqueda seleccionan las columnas usadas por Relay y omiten las salidas de herramientas; el historial carga solamente la familia de la Conversación elegida. Decisiones conserva la identidad del resultado y los metadatos de aprobación, sin materializar la salida del comando. Las revisiones para borrar siguen incluyendo todas las columnas, también contexto y razonamiento privados, con el mismo presupuesto. Un registro SQLite no supera 1 MiB; SQL no supera 64 KiB. Se itera para cortar antes de materializar todo el resultado.
- Los controles de versión no son un snapshot atómico del filesystem ni un bloqueo cooperativo del escritor. Una escritura/checkpoint detectada durante la copia produce indisponibilidad, sin reintentos; un perfil con actividad continua puede fallar con mayor frecuencia. Se requiere que el filesystem refleje fielmente los cambios en sus metadatos. Una manipulación privilegiada capaz de falsearlos queda fuera de esta garantía.
- Lectura y copia síncronas: el costo de E/S crece con el tamaño de los archivos. No se añade worker, dependencia ni servicio.
- Las copias contienen datos del perfil, son privadas y se eliminan al cerrar, también ante excepciones. Una terminación abrupta puede dejar el directorio privado; no hay recolector nuevo ni recuperación tras crash en esta corrección.
- Corrupción, incompatibilidad, límites y fallos de copia son errores opacos. No se publican rutas, mensajes nativos, SQL ni contenido. Un fallo de Agente continúa visible en los resultados parciales del Servidor.

## Pruebas y evidencia

Solo fixtures sintéticos y HTTP contra fake Hermes. Sin producción, secretos, servicios ni gate.

```sh
node --test --test-timeout=20000 \
  /home/user/dev/relay-app-v1/bridge/test/hermesStoreSecurity.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/agentUsage.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/serverUsage.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/conversationsSql.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/conversationsHttp.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/agentDetailsHttp.test.ts \
  /home/user/dev/relay-app-v1/bridge/test/serverUsageHttp.test.ts
npm --prefix /home/user/dev/relay-app-v1/bridge run typecheck
```

Resultado: 88 pruebas verdes; tipos del Puente verdes, incluida la corrección de `sqlite_reader_fault.ts`. Los contratos cubren intercambios antes de abrir fd, nombres restaurados, symlinks de principal/ancestro/auxiliares, reemplazos regulares, hardlinks estáticos y durante OPEN, bytes del destino intactos, escrituras durante copia, auxiliares nuevos, WAL confirmado/no confirmado, ausencia sin creación original, corrupción, presupuestos, búsqueda Unicode, identidades binarias, revisiones, tiempos/DST, costos desconocidos/cero y fallos parciales.

Evidencias persistentes ignoradas en `/home/user/dev/relay-app-v1/`:

- `review-hermes-store-final-tests.log` y `review-hermes-store-types.log`.
- Nueve logs `review-hermes-store-mutation-{private-boundary,source-binding,copy-version,file-nofollow,ancestor-nofollow,hardlink,sidecar-appearance,row-bound,byte-bound}.log`: cada uno contiene aserción RED, restauración y GREEN con la arquitectura final de copia. `private-boundary` falla específicamente por bytes SHM modificados.
- Los demás logs con ese prefijo documentan la exploración anterior; las evidencias finales anteriores son las aplicables a la entrega.

## Fuentes oficiales

[Node: DatabaseSync](https://nodejs.org/api/sqlite.html#new-databasesyncpath-options) acepta rutas, no un descriptor ya fijado; `readOnly` evita crear el principal ausente. [SQLite: WAL](https://www.sqlite.org/wal.html#read_only_databases) explica la creación de auxiliares con principal readonly y el índice compartido; [implementación del índice SHM](https://www.sqlite.org/wal.html#implementation_of_shared_memory_for_the_wal_index) describe su archivo mapeado. Son la razón para consultar solo la copia privada, en vez de confiar en comprobaciones después del OPEN original.
