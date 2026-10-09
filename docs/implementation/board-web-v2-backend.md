# Tablero web v2: publicación y entrega del Puente

Implementación Linux de lectura, sin escritura de perfiles, subida, ZIP, búsqueda genérica ni URL del Agente. `Hermes.boardWeb` es opcional; Hermes real resuelve exclusivamente homes de perfiles conocidos. Las pruebas usan Hermes falso y archivos sintéticos privados del worktree.

## Publicación

La Tarjeta conserva el JSON de `relay-board/<card>.json`, con content exacto `{type:"web",bundleRef:"counter",revision:"<sha256>"}`. Su autor deriva del perfil propietario. El bundle vive en el hermano `relay-board-web/<bundleRef>/<revision>/`: `manifest.json` y recursos planos. Publicar toda la revisión mediante rename desde un directorio temporal del mismo filesystem y después cambiar el JSON de la Tarjeta; no editar revisiones publicadas.

El manifiesto exacto es `{schemaVersion:1,entry:"index.html",files:[{name,mime,bytes,sha256}]}`. Orden canónico de archivos ASCII ascendente; orden de claves como aquí. Revisión = SHA256 de UTF-8 de JSON.stringify de la representación canónica validada, sin espacios. Hashes minúsculos hex de 64 caracteres. Bundle ASCII de hasta 64 caracteres; nombres planos ASCII de hasta 64 con extensión permitida html/js/css/png/jpg/jpeg/webp y MIME fijo. No campos adicionales. Máximos: manifiesto 16 KiB, 32 archivos, archivo 256 KiB, suma de recursos 1 MiB, snapshots retenidos 8 MiB por instancia Puente, 32 consumidores concurrentes. Una sola captura simultánea; cada captura reserva 1 MiB antes de leer, aunque su tamaño final sea menor. Exceso devuelve 429 y Retry-After: 1.

## Negociación y rutas

GET /v1/board sin X-Relay-Board-Web conserva siete tipos: una publicación web se proyecta a texto nativo sin bundle/revisión/HTML. Con X-Relay-Board-Web: 1 exige X-Relay-Protocol: 2 y confirma respuesta 1. El cliente debe verificar esa respuesta antes de pedir recursos.

La cabecera es un marcador de versión, no prueba de un proveedor verificado: el Puente sirve el DTO web a cualquier dispositivo emparejado que la envíe. Por eso la app solo envía `X-Relay-Board-Web: 1` cuando la capacidad nativa del WebView es `verified`; con `unverified` o `unsupported` pide el Tablero sin ella y recibe la Tarjeta proyectada a texto.

GET autenticados /v1/agents/:agent/board-web/:bundle/:revision/manifest y /assets/:name requieren ambas cabeceras. Sin query, Range, rutas cliente, POST ni redirects. Metadata `{bundleRef,revision,manifest}`; bytes con MIME fijo, Content-Length, nosniff, no-store y sin cookies. Logs usan etiqueta estática; errores estáticos no revelan paths, bytes ni credenciales.

## Seguridad y límites

Cadena Linux de descriptores abiertos relativos por /proc/self/fd, NOFOLLOW en cada ancestro y recurso, archivos regulares del UID del Puente con nlink=1, tamaño antes de reservar bytes, lectura límite+1, fstat y hashes. Captura completa antes de publicar; descriptores retenidos se revalidan antes de cada respuesta. Cambio/reemplazo de origen invalida la revisión en vez de servir HTML anterior. Auth se comprueba antes/después de IO y antes de responder; retirada de publicación durante captura descarta el resultado. Solicitud desconectada no publica respuesta tardía. Una publicación retirada puede conservar cuota hasta la siguiente lectura o cierre, siempre acotada; cierre concurrente comparte una única promesa y solo libera cuota al terminar. Los hashes son integridad, no una firma ni defensa frente al propietario Unix malicioso después de la comprobación final.

No auditoría de lectura. No se ha ejecutado Hermes instalado ni producción. El backend no demuestra aislamiento del motor: activación móvil queda sujeta a evidencia nativa de salida cero, incluida WebRTC, y nunca al manifiesto por sí solo.

## Evidencia

Pruebas HTTP y lector reales, entradas sintéticas: v1/proyección, negociación, auth, revocación durante read, retirada durante IO, límites, symlinks/hardlinks, cambio de directorio, crecimiento, cambio de manifiesto, cuota y cierre concurrente. Mutaciones causales nlink, pin, revocación, protocolo, proyección, cuota y propiedad del cierre tienen aserción RED y restauración GREEN en board-web-*-mutation-red.log y board-web-backend-restored-green.log. Root ejecuta gate e integración; aquí solo pruebas estrechas y tipos.
