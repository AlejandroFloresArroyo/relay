# Actividad en Android

La sección Agentes ofrece el selector AGENTES / ACTIVIDAD y conserva las cuatro pestañas.
La UI sigue Instrumento `16a-1..4`: filtros compactos, fecha y hora en columna, iconos sobre
riel, entradas beige, énfasis naranja para selección y rojo para resultados que requieren
atención. Los intervalos muestran «sin registros visibles»; una consulta paginada no prueba
que el registro completo carezca de actividad esos días.

## Contrato y presentación

`RelayClient.activity` lee `GET /v1/activity` con autorización y encabezado de protocolo.
El normalizador conserva únicamente los campos enumerados de `protocol/activity.ts`.
Nunca muestra comandos, mensajes, nombres de dispositivo, IP ni errores libres. El actor
se etiqueta Este dispositivo, Otro dispositivo o Puente; su ID no se imprime.

Cada Servidor aparece por separado, conserva el orden recibido y su `capturedAt`, y presenta
«Fecha del Servidor · UTC» porque el contrato declara milisegundos UTC. No se calcula desfase
con el teléfono ni se ordenan entre sí relojes de Servidores distintos. Los filtros combinan
Servidor, Agente, categoría y SOLO FALLOS. Este último incluye `failed`, `rejected` y `uncertain`.

SOLICITADO no confirma aplicación; ACEPTADO no confirma finalización. NO CONFIRMADO explica
que el cambio pudo tener efectos. INCIERTO conserva la incertidumbre y RECHAZADO aclara que
puede ser una protección deliberada. Solo `succeeded` recibe el indicador verde. No se unen
solicitudes y desenlaces sin un identificador de operación que los relacione.

Las referencias validadas abren las rutas existentes de Agente, Conversación o administración
del Servidor. Una referencia histórica no demuestra que la Conversación todavía exista;
no se promete un punto exacto ni un mensaje anclado.

## Lectura e invalidación

Una cola por cliente admite una lectura activa y un único pendiente reemplazable. El pendiente
revalida su vigencia antes de iniciar; nunca inicia una consulta retirada. Cargar más serializa
el doble toque, valida captura estable y progreso del cursor, detecta ciclos y deduplica por ID.
Se conservan hasta 500 entradas por Servidor y hasta ocho filtros por cliente en memoria.
Cada respuesta se limita a 256 KiB: tamaño declarado y bytes reales del cuerpo cuando existe
lector de stream; el fallback JSON nativo valida el tamaño después de decodificar.

La caché es volátil, fechada y de solo lectura. No usa SecureStore ni depende de escrituras
pendientes. Un cliente nuevo por origen, llave o dispositivo no hereda la lectura anterior,
incluso si conserva el ID local del Servidor. Revocación y protocolo incompatible eliminan
la caché. Una denegación terminal recibida por una lectura ya retirada sigue perteneciendo
al mismo cliente: se procesa antes de drenar la cola, purga la lectura y retira el pendiente.
Un cliente reemplazado por origen, llave o dispositivo no recibe esa denegación. Un rechazo de versión del endpoint también la purga, aunque el último health sea
compatible; ese cliente no vuelve a leer hasta renovarse tras actualizar Relay. Ocultación, blur, background/inactive y LockGate retiran permanentemente resultados,
avisos y cursores pendientes; volver requiere una nueva consulta. Los cursores nunca se guardan
en la caché. La visibilidad tiene una generación monotónica; el primer commit al volver
solo puede presentar una última lectura fechada sin cursor. La cuota y caducidad se resuelven por el backend, sin comparar su reloj con el teléfono.

No hay refresco periódico de Actividad. Actualizar es manual y puede recibir `activity_busy`:
el Puente admite cuatro snapshots vivos por lector, 32 MiB retenidos, una lectura simultánea
y diez minutos de TTL; reiniciar invalida los cursores. La UI muestra el estado ocupado y permite
reintentar, sin crear un bucle de snapshots. Una lectura ya iniciada puede terminar hasta su timeout
acotado; se descarta su resultado si perdió vigencia. El reemplazo del cliente puede coincidir con
esa lectura anterior: el backend puede responder ocupado y la UI lo conserva explícitamente.

## Estados y evidencia

Hay loading, vacío confirmado, error, offline sin lectura, última lectura en memoria, agregado
parcial, endpoint no admitido, ocupado y cursor caducado. Demo incluye esos estados y relojes
distintos, usando el mismo contrato y normalizador. Los fixtures contienen datos sintéticos,
y las tareas conservan SOLICITADO porque sus productores actuales solo auditan solicitudes;
los otros desenlaces se demuestran con acciones que sí los registran.

La cobertura narrow vive en `mobile/src/core/activity.test.ts` y
`mobile/tests/components/Activity.component.test.tsx`. Los componentes montan AppProvider,
LockGate, hooks y pantallas reales; solo transporte, navegación, almacenamiento, reloj y
límites nativos son dobles. La observación de commits comprueba que el cliente reemplazado
no muestra contenido anterior antes de los effects. Las pruebas de páginas tardías retienen
el cuerpo nuevo para detectar una publicación inválida transitoria.

Las evidencias TDD y las mutaciones RED por aserción / restauración exacta / GREEN viven en
`activity-*.log` del worktree. El manifiesto final enumera archivos y SHA256; el protocolo copiado
permanece sin editar y se excluye de la entrega. No se ejecuta gate, exportación ni APK en este
trabajo. Root conserva integración y validación visual en teléfono. Se inspeccionaron los cuatro
PNG y HTML locales, primitives/tokens y el detector acotado; no se presenta esa inspección como
una captura verificada de Android.

## Residual SPEC de a46a4b5

Los repro independientes se conservan intactos en `activity-spec-repro-a46a4b5.log` y
`activity-spec-repro-stdout-a46a4b5.log`. Se reprodujeron ambas aserciones RED antes de corregir.
`ActivityResidual.component.test.tsx` conserva la observación de commits y la aserción de
purga, y exige que la lectura pendiente ni siquiera empiece tras la denegación. Cubre
revocación y protocolo tras actualizar o cambiar filtro, remontaje y aislamiento del cliente
reemplazado. La regresión previa de error tardío mantiene sus aserciones con un error no
terminal 404; la regla de ignorar una revocación del mismo cliente era el defecto corregido.

Evidencia: 46 componentes de Actividad, tipos y lint verdes (dos avisos preexistentes).
Dos mutaciones de las guardas fallan por aserción, se restauran byte a byte y pasan:
`activity-residual-mutations-manifest.log`. El manifiesto de archivos y hashes exactos está
en `activity-residual-delivery-manifest.log`. No se ejecutó gate, APK ni producción.


## Demo de composición

El selector «Personalidad y Avisos» añade los diez desenlaces emitidos por los productores reales:
solicitudes y confirmaciones de crear/editar/eliminar presets, solicitud y registro de aplicar
SOUL.md, elección registrada en Conversación e inscripción solicitada de Avisos. Usa el mismo
normalizador, paginación y filtros; los presets y Avisos no aparecen al filtrar por Agente.

Las etiquetas distinguen CONFIRMADO, REGISTRADO y SOLICITADO. Solo la elección registrada ofrece
ABRIR CONVERSACIÓN; los presets conducen a administración del Servidor y SOUL.md al Agente.
No se imprimen nombres, contenidos o UUID de presets. La captura de diseño sintética
`design/captures/activity-composition/composition.{html,png}` documenta las etiquetas y resultados
sobre los tokens de Instrumento; no es una captura verificada de un teléfono físico.


## Residual de foco Android sobre 58ad7e7

`AppState.blur` retira síncronamente las lecturas y gestos de Actividad, aunque el estado
de la app siga siendo `active` y la ruta conserve foco. `focus` permite una consulta nueva;
un evento `active` intermedio no vuelve a mostrar la lectura mientras la ventana siga sin foco.
La revisión cambia incluso cuando React agrupa blur y focus en un solo render, para impedir
que el primer commit conserve un cursor anterior. Los callbacks retenidos de filas,
paginación y actualización pertenecen a su lectura renderizada y no recuperan permiso al volver.

`ActivityFocus.component.test.tsx` monta AppProvider, LockGate y ActivityScreen reales. Cubre
la página diferida, ocultación incluyendo elementos ocultos, retiro antes del commit,
blur/focus agrupados observando cada commit con Profiler, gestos retenidos y retorno offline.
La última lectura offline conserva fecha, contenidos permitidos y navegación de solo lectura,
sin cursor. Las pruebas existentes conservan reemplazo de cliente, revocación y bloqueo.

Evidencia local: 51 componentes de Actividad, tipos móviles y lint de los dos archivos
modificados verdes. Siete mutaciones causales fallan por aserción y se restauran byte a byte
con GREEN después de cada una; `activity-focus-mutations-manifest.log` enumera sus hashes.
`activity-focus-delivery-manifest.log` y `activity-focus-handoff.log` fijan la entrega.
No se modifica el DTO ni los productores de Avisos. El arnés simula el límite nativo Android;
no constituye validación visual en teléfono. No se ejecuta gate, build, APK ni producción.
