# Historial de Decisiones acotado

El registro durable y Hermes no se borran ni se recortan. El límite es una proyección de
lectura: los 100 registros confirmados más recientes por Servidor, ordenados por fecha
(descendente) e identidad para desempatar. Los filtros HTTP se aplican antes del límite.

El contrato de protocolo 2 añade campos opcionales: `window: { limit, total }` cuenta los
registros confirmados que coinciden con la consulta, y `commandTruncated` indica una vista
abreviada. Actor, resultado, elección, fecha, clase de fecha e identidades se conservan.
El comando histórico ocupa como máximo 512 unidades UTF-16, incluida la elipsis; el corte
respeta pares Unicode. La pantalla muestra «COMANDO ABREVIADO» y avisa del historial limitado.
La vista abreviada nunca se utiliza como identidad de consentimiento ni para enviar una elección.

La app normaliza también respuestas legacy sin metadata: guarda como máximo 100 registros
por Servidor y monta como máximo 100 globales después de aplicar los filtros locales.
Cambiar de Agente permite revisar los registros recientes de ese Servidor aunque sean más
antiguos que el límite global inicial. Los filtros locales sólo abarcan la ventana recibida,
no todo el ledger. `window` presente debe tener exactamente dos cuentas enteras coherentes;
metadata o registros corruptos, incluso fuera de la ventana seleccionada, fallan cerrados.

Android usa `expo/fetch`: la lectura del cuerpo se acota antes de parsear JSON y tiene timeout.
El máximo defensivo legacy es 20 MiB, superior al ledger durable de 16 MiB para dejar margen
para elecciones completas sin confirmar y previews. Un cuerpo mayor, sin stream acotable,
inválido o que exceda el timeout se rechaza; no se muestra como historial completo/vacío.
La respuesta se cancela y las continuaciones tardías no consumen nuevos datos.

Aprobaciones pendientes y Decisiones sin confirmar conservan todos sus registros y comandos,
sin aplicarles los límites anteriores. Una revocación retira el historial guardado, un fallo
transitorio conserva el último historial acotado con fecha, y un cambio de identidad retira
la caché anterior. No hay paginación nueva ni modificación de autorizaciones o temporizadores.
No se añade virtualización: el montaje confirmado ya queda acotado a 100 filas; las filas
pendientes y sin confirmar mantienen su presentación existente y no se ocultan por cupo.

Demo: «Historial limitado» muestra 180 registros sintéticos de origen, con previews largos,
para recorrer ambos indicadores sin Servidor. Las regresiones usan normalizador real,
HTTP/RunManager/ledger reales con Hermes fake y AppProvider/LockGate/pantalla Android reales
con límites nativos compartidos. Esto no sustituye una comprobación física de rendimiento.
