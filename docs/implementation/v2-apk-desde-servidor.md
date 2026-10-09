# APK desde el Servidor: contrato y entrega del Puente

El Puente sirve una publicación explícita, independiente de Hermes. Implementación sólo Linux:
requiere `/proc/self/fd`, `O_DIRECTORY`, `O_NOFOLLOW` y usuario propietario. No hay fallback por
paths, compatibilidad adicional, escaneo de builds, upload, instalación ni compilación del APK.

## DTO congelado

`protocol/appUpdate.ts`, SHA-256:
`d3dd54e4aecb02f8483674da019d2daaf0141437a7addd7a212b8abeb5a3aff6`.

Es aditivo, sin cambio de versión global ni imports de plataforma. Mobile conserva la misma copia.
Cualquier cambio futuro del DTO se coordina con Root antes de cambiar copias.

## Publicación explícita

La opción pública opcional `appUpdateRoot` se carga desde `RELAY_APP_UPDATE_ROOT`. Debe ser un
directorio absoluto canónico distinto del directorio privado del Puente; ninguno contiene al otro.
El valor no se recibe del cliente. Sin opción, los endpoints responden 404 `app_update_unavailable`.

El almacenamiento privado de snapshots es el hijo `<directorio de estado>/app-update`, que el Puente
crea con modo 0700, igual que Kanban crea `kanban/`. El directorio de estado puede ser 0755 (el de
producción lo es), pero debe pertenecer al usuario del Puente y no ser escribible por grupo/otros;
el hijo debe pertenecer a ese usuario y no tener ningún permiso de grupo/otros. Si no se cumple,
503 `app_update_invalid` (se recupera con `chmod 700 <estado>/app-update`).

Root publica exactamente `relay.apk` y `release.json`. Directorio 0700 del usuario del Puente;
archivos regulares privados, sin permisos de grupo/otros, normalmente 0600. Los ancestros no pueden
ser escribibles por grupo/otros. Todos los componentes se abren por descriptores fijados y no se
siguen symlinks. Hardlinks, archivos especiales, cambios de identidad/versión y escapes se rechazan.

Root genera el JSON sobre el APK firmado final: `schemaVersion: 1`, `applicationId`, `versionCode`,
`versionName`, `byteLength`, `sha256`, `signerSha256`, `builtAtMs`, `sourceCommit`. Nunca claves.
Paquete Android de 1..200 caracteres, versión visible 1..128 sin controles, versión numérica entero
positivo de 32 bits, tamaño 1..268435456, fecha entero seguro no negativo en **ms**, hashes hex
minúsculas de 64 caracteres, commit hex minúsculas de 40. Campos extra o tipos incorrectos fallan.
Metadata <=16384 bytes, comprobados antes de materializar/parsear. El certificado declarado es
metadata generada por Root; el Puente no valida una firma APK ni interpreta su paquete internamente.

Reemplazar el par puede producir un 503 transitorio hasta que metadata y bytes coincidan. Ambos
archivos ausentes en un directorio válido producen `unpublished`; una publicación parcial,
inaccesible, cambiante o inválida produce 503 `app_update_invalid`, sin contenido previo de fallback.
Una descarga ya admitida conserva su snapshot anterior aunque Root cambie la publicación.

## HTTP

Ambos GET requieren la llave normal del dispositivo y `X-Relay-Protocol` exacto. No aceptan query,
rangos, URL ni paths. La autorización se captura antes de esperar y se revalida tras cada espera.

- `GET /v1/app-update`: `{state:'unpublished'}` o `{state:'published', revision, artifact}`. Publicado
  incluye ETag fuerte. La revisión es SHA-256 del JSON canónico validado, que incluye el hash real.
- `GET /v1/app-update/apk`: `If-Match` obligatorio de una sola revisión fuerte exacta. Ausente o
  malformado: 428 `app_update_precondition`. Publicación distinta/retirada: 412 `app_update_changed`.
  Nunca selecciona otro APK automáticamente.
- Binario: MIME `application/vnd.android.package-archive`, nombre fijo `relay.apk`, tamaño exacto,
  ETag, `nosniff`; respuestas sin caché. Errores estáticos, sin paths ni mensajes del filesystem.
- Capacidad ocupada: 429 `app_update_busy`, `Retry-After: 1`. No audit de lectura: el log habitual
  registra sólo método/ruta/status, sin cuerpos, headers, metadata ni credenciales.

## Snapshot, límites y cancelación

Se copian bloques <=64 KiB hacia archivo privado exclusivo. Se manejan escrituras parciales y se
vuelve a leer/hashear **el descriptor retenido** del snapshot, comparándolo con metadata. Se verifican
la cadena de directorios y las identidades/versiones originales antes/después. El APK nunca se
materializa completo en memoria ni se reabre desde el path publicado para servirlo.

Una construcción compartida; máximo 64 consumidores de esa construcción, 4 descargas globales y
1 por dispositivo. Dos reservas exclusivas fijas `app-update-slot-0`/`app-update-slot-1` bajo el
almacenamiento privado: <=512 MiB de bytes de APK gestionados. Los snapshots pendientes de borrado
siguen ocupando reserva. Ninguna instancia examina/reutiliza reservas ya existentes. Tras una
interrupción pueden quedar reservas: si ambas están ocupadas, se devuelve 429; su recuperación
local por Root queda fuera del endpoint (procedimiento: detener el Puente, borrar solo
`<estado>/app-update/app-update-slot-0` y `-1`, arrancarlo; ver `bridge/README.md`). No se escanean ni se borran automáticamente archivos de
otra instancia. Operación normal elimina parciales y libera reservas al descartarlos/cerrar. La limpieza mantiene abiertos los descriptores
propios: libera únicamente el APK cuya identidad coincide dentro de esa reserva, incluso si el
directorio fue renombrado. Antes de retirar el nombre del slot vuelve a comprobar dispositivo,
inodo, modo y propietario contra el descriptor capturado. Un nombre reemplazado, ausente o
convertido en symlink se conserva; los contenidos desconocidos nunca se eliminan recursivamente.
La retirada del directorio usa `rmdir`, por lo que una reserva ajena poblada no puede ser borrada.
Como las API de archivos de Node no ofrecen `unlinkat` condicionado por inodo, esto no promete
atomicidad frente a un proceso hostil del mismo usuario que cambie una reserva vacía entre la
última comprobación y `rmdir`. El directorio privado no debe ser manipulado mientras se utiliza.

Copia/validación <=30 s, transferencia <=10 min, inactividad <=30 s. Cancelar la última espera corta
la construcción; revocar un consumidor no cancela al consumidor válido que comparte el trabajo.
Revocación/cierre de socket corta el stream, incluso durante lectura o `drain`; no puede retirar
bytes ya recibidos. I/O regular pendiente puede terminar después del aborto; su continuación está
bloqueada y limpia los recursos al regresar. No hay cola ilimitada ni continuación privada revocada.

## Verificación y frente Mobile

Pruebas con publicaciones/usuarios sintéticos y HTTP real frente a Hermes fake, nunca producción.
Cubren schema, límites previos a lectura, symlinks/hardlinks/ancestros, cambios durante copia,
corrupción de snapshot, hash, revisión exacta, concurrencia/reservas, plazos, cancelación y revocación.
Logs TDD y diez mutaciones restauradas RED/GREEN viven en el worktree, bajo `app-update-*.log`.

Mobile/instalador es otro frente. Root asignó el módulo nativo para comprobar archivo descargado,
paquete y firma locales; el manifest por sí solo no verifica el archivo. La descarga requiere gesto
y el instalador consentimiento Android. No hay instalación silenciosa, uninstall ni borrado de
datos. Esta entrega no usa ni comprueba el APK firmado de 55 MB comunicado por Root.

Bifurcaciones queda pendiente y fuera del cierre ejecutable de v2 por decisión de Ale: dependencia
upstream documentada, sin preparar extensión/escritor Hermes. Investigaciones congeladas en el
worktree de investigación; hashes y decisión en su `fork-v2-frozen-manifest.log`.
