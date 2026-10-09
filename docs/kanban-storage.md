# Trabajo: almacenamiento privado y avisos explícitos

El contrato compartido está en [`protocol/kanban.ts`](../protocol/kanban.ts). No cambia
la versión del protocolo ni las rutas existentes. El Puente conserva metadatos manuales
por Servidor; mover, completar, reasignar o comentar un elemento nunca inicia un Turno.

## Persistencia y límites

`kanban.json`, con permisos `0600`, contiene la versión 1 del estado, el respaldo completo
de la mutación anterior y la auditoría pendiente. Se prepara un archivo privado, se sincroniza,
se reemplaza mediante rename y se sincroniza el directorio. La entrega del registro de cambios
se confirma antes de responder éxito; su identificador permite recuperar la auditoría sin
repetirla. Vaciar la auditoría pendiente no rota el respaldo. Se conserva **un** respaldo
anterior, no un historial ilimitado de versiones.

`kanban.initialized` es una marca privada de 16 bytes, sincronizada antes de confirmar
la primera mutación. Distingue un estreno de la pérdida de `kanban.json` al reiniciar.
Una pérdida conocida, corrupción, versión desconocida o resultado incierto de escritura
cierra el acceso; no se reconstruye un registro vacío. La marca puede completarse al recuperar
un estado válido cuya primera escritura se interrumpió antes de crearla.

Los límites del contrato son 500 elementos, 16 dependencias por elemento, 200 comentarios
por elemento, 10 000 comentarios y 20 000 recibos compartidos. Los recibos no se desalojan.
El archivo completo, **incluido el respaldo**, tiene un máximo de 16 MiB; por eso ese límite
puede alcanzarse antes de llenar los contadores. Si un checkpoint válido de una versión
anterior no deja espacio para recuperar `pending` y rotar el respaldo, se conserva completo
sin reescribir: la lectura proyecta esos recibos como `uncertain`, conserva su reserva y
registra la recuperación una sola vez mediante un identificador estable y la fecha del
checkpoint. El store queda en lectura; toda mutación nueva recibe `kanban_store_full`.
No se evictan recibos ni se reduce o elimina el respaldo para hacer espacio. La siguiente escritura se rechaza sin
reemplazar el estado; los recibos previos siguen disponibles. Las peticiones se limitan a
80 000 bytes, los títulos a 200 unidades UTF-16, los comentarios a 4096 bytes UTF-8 y el
texto confirmado del aviso a 64 000 bytes UTF-8. Las respuestas no superan 1 MiB.

El acceso usa descriptores relativos en Linux, ancestros fijados y `O_NOFOLLOW`.
Se comprueban dueño, permisos privados, enlaces duros, identidad, versión y contenido del
archivo antes de servirlo o reemplazarlo. No hay rutas elegidas por el cliente ni lecturas
de respaldos de Hermes. `kanban.lock`, creado con exclusión atómica por directorio,
abarca lectura/comprobación, reemplazo, recuperación y confirmación de auditoría. Dos stores
o procesos cooperantes no pueden confirmar escrituras solapadas: el contendiente recibe
`kanban_store_unavailable`, sin esperar ni robar el lock. La liberación comprueba la identidad
y versión del archivo propio sin una espera intermedia. Un lock ajeno, reemplazado o sobrante
tras una caída nunca se elimina automáticamente; requiere recuperación explícita del operador.

Una escritura externa confirmada invalida los stores que conservan la versión anterior;
deben abrirse de nuevo antes de leer o escribir. La exclusión exige que todos los escritores
cooperen. No ofrece CAS absoluto frente a procesos arbitrarios que ignoren el lock o cambien
entradas del directorio por su cuenta. La revocación local conocida conserva las comprobaciones
antes de cada efecto y después de las esperas; un efecto ya admitido que pierda autorización
antes de responder no se reconoce como éxito al solicitante.

## Revisiones, recibos y paginación

Cada edición y comentario exige la revisión del elemento. Las dependencias deben existir
en el mismo Servidor, ser distintas y formar un grafo sin ciclos. La numeración se asigna
al confirmar el estado y no se reutiliza. Los comentarios son exclusivamente humanos.

Los recibos se vinculan al dispositivo y a la huella de operación, recurso y campos validados;
el orden de las propiedades JSON no cambia la huella. Repetir la misma solicitud devuelve
su resultado, incluso con otra revisión actual o durante Pausa general. Cambiar sus campos
o reutilizar el identificador en otro recurso produce conflicto. Se comprueba revocación
antes del replay y de entregar una respuesta privada.

Los cursores llevan autenticación HMAC, dispositivo, recurso, filtro, límite y revisión.
No retienen snapshots en RAM. La página siguiente exige la misma revisión; cambiar el conjunto
o reiniciar el Puente invalida el cursor. Los elementos se ordenan por creación descendente
y UUID ascendente; los comentarios, por número ascendente. Los contadores cubren todo el Servidor.

## Avisar al Agente

El aviso es una acción explícita posterior a guardar el elemento. Antes del intento durable
se exige asignación coincidente, revisión vigente, dependencias completadas y admisión de
Pausa general. El Puente vuelve a comprobar esas condiciones después de las esperas y antes
de crear el Turno. Usa la creación existente de una **Conversación nueva** propia de Relay,
y el camino existente que aplica un Modo de aprobación pendiente antes del próximo Turno.
No expande el texto confirmado ni añade imágenes.

El recibo `pending` precede a cualquier efecto. `started` sólo confirma que Hermes aceptó
el Turno y registra sus identificadores; no confirma consumo ni terminación. Un rechazo
conocido es `rejected`. Un resultado que no puede confirmarse es `uncertain`, sin reintento.
Los identificadores recibidos de un efecto ya autorizado se conservan aunque llegue pausa
o revocación durante esa espera; la revocación sigue impidiendo la respuesta y todo efecto nuevo.

Un intento pendiente, incierto o sin evidencia terminal reserva el elemento para todos los
dispositivos. Un nuevo aviso requiere otra acción humana después de rechazo o resultado terminal
confirmado. Sólo se observa el Turno registrado cuando coinciden Agente, Conversación y Turno
con la identidad local. El puerto actual `runStatus` de Hermes no expone la identidad de
Conversación, por lo que su estado por sí solo no se adopta después de reiniciar: la observación
permanece desconocida y la reserva sigue vigente. No se atribuye un desenlace a un aviso por
coincidencia de `runId`; no se reconecta ni se reanuda. Al reiniciar, `pending` pasa a `uncertain`.
Un intento incierto sin identificador de Turno permanece reservado: este corte no incorpora
una acción para descartarlo o adivinar su resultado. El recibo y el último aviso de la ficha
se exponen únicamente al dispositivo que los solicitó.

## Actividad

Las acciones aditivas son `kanban.create`, `kanban.update`, `kanban.comment` y `kanban.notify`,
en la categoría Trabajo (`tasks`) y alcance Servidor. Las mutaciones confirmadas registran
`succeeded`; los avisos conservan `requested`, `accepted`, `rejected` o `uncertain`.
La auditoría sólo agrega identificadores del elemento y solicitud al esquema del actor
autenticado. Nunca guarda título, comentario, entrada, respuesta ni configuración. La proyección
de Actividad omite nombres del dispositivo y detalles privados.
