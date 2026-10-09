# Tablero web v2: residuales de errores y presentación

Corrección acotada sobre la composición `636bfb7` y el retiro nativo `60fc50b`.
Sólo cambia el cliente Core, el hook de presentación y sus pruebas. El contrato,
el Puente, los proveedores verificados y las fuentes nativas conservan sus dueños.

## Errores de lectura

El límite público `createBridgeClient().boardWeb` rechaza JSON inválido y UTF-8
inválido con `RelayError(unavailable)` y texto fijo, sin conservar el cuerpo ni
la excepción del parser en mensaje, stack, propiedades o causa. Se mantienen
los límites de lectura por bytes y la decodificación estricta. Las negativas
válidas conservan sus códigos conocidos y estado HTTP con un mensaje fijo.

El RED inicial usa un canario sintético corto en respuestas de Tablero y
manifiesto, tanto correctas HTTP como errores HTTP, y en errores de assets.
No se afirma que el error anterior llegara a la pantalla: el defecto estaba en
el error público del cliente, aunque la pantalla ya mostraba una causa fija.

## Retiro y primer commit

Al recibir blur o salida del estado activo se retira la generación y se cancela
su lectura en el manejador, antes de esperar un render. Un contador monotónico
obliga a renovar la presentación incluso si React agrupa blur/focus o
background/active y sus booleanos finales coinciden con los anteriores.

Los resultados se vinculan a una presentación que incluye el alcance, cliente,
credencial, visibilidad, reintento y contador de retiro. Sólo la presentación
actual puede montar una vista lista. Al recuperar visibilidad, el primer commit
retira la vista anterior y una copia nueva verifica capacidad antes de publicar.
Las guardas tras cada espera siguen descartando copias retiradas. Un callback de
fallo de una vista anterior no puede retirar la generación actual.

## Evidencia y límites

Las pruebas usan AppProvider, LockGate y BoardScreen reales, AppState Android,
transporte sintético y el doble del límite nativo compartido. Profiler observa
cada commit, incluidos elementos ocultos; una segunda copia queda diferida para
impedir que un resultado inmediato encubra una vista anterior. También se
comprueban bloqueo, revocación, reemplazo de emparejamiento, metadatos offline y
la falta de soporte o verificación del proveedor.

Los registros ignorados `board-web-residual-*.log` del worktree conservan RED,
GREEN y siete mutaciones causales con restauración exacta de SHA256. No hubo
prueba nativa, build ni acceso a un teléfono o servicio. Estas pruebas verifican
el cableado JavaScript y sus llamadas/props en el límite nativo; no demuestran
cero egreso real de WebView. El catálogo de proveedores verificados sigue vacío
hasta que su dueño complete la verificación nativa independiente.
