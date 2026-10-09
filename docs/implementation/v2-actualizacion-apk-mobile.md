# Actualización APK desde el Puente: entrega mobile

Entrega sobre `9199135d5c782c01c687ee2f848bbca6bf611abe`, rama `feat/v2-app-update-mobile`.
El DTO de `protocol/appUpdate.ts` pertenece al constructor del Puente; su copia congelada no forma
parte de esta entrega. No se modifica el Puente ni se añaden dependencias.

## Flujo y estados

La administración del Servidor abre `/app-update/[server]`, conservando las cuatro pestañas.
La pantalla muestra la versión instalada y la publicación del Puente. Primero pide revisar las
versiones; después permite descargar por gesto, muestra bytes recibidos y permite cancelar.
La publicación solo permite decir «compatible según publicación»: nunca acredita una verificación
local. El paso «Instalar» aparece únicamente después de verificar el archivo descargado y requiere
otro gesto; abrir la confirmación de Android no se presenta como instalación terminada.

Los estados contemplan carga, sin publicación, versión actual, versión nueva, incompatibilidad,
permiso de fuentes desconocidas, módulo no disponible, Puente sin endpoint, ocupado, error y sin
conexión. Abrir los ajustes de fuentes desconocidas es explícito y no inicia una descarga al volver.
La ausencia del módulo nativo o Android anterior a 12 impide instalar. Cada estado dispone de demo;
los doce escenarios usan datos y límites nativos simulados y lo indican, incluida la verificación.
La demo no instala APK ni acredita una firma real.

## Lectura y transferencia

El cliente usa `GET /v1/app-update` y `GET /v1/app-update/apk`, autorización y protocolo existentes.
La descarga envía un `If-Match` fuerte de la revisión revisada; rechaza redirecciones, respuesta
parcial, revisión distinta, MIME incorrecto y longitud distinta. El límite publicado es 256 MiB;
los bytes realmente recibidos también se acotan y deben coincidir exactamente. No se aceptan
URLs de descarga del manifiesto, reanudaciones ni rangos.

Los metadatos se validan estrictamente y se acotan a 16 KiB reales. Las lecturas pendientes son
cancelables; metadatos tienen plazo de cinco segundos, transferencia diez minutos y cada lectura
o escritura pendiente treinta segundos como máximo. Los bloques entregados al límite nativo
son de hasta 64 KiB y se escriben en serie. Los cuerpos tardíos se cierran. Las causas conocidas
de autorización y protocolo se conservan con mensajes fijos; no se exponen cuerpos ni errores
arbitrarios del transporte o del SDK.

## Retirada permanente y aislamiento

El estado queda en memoria y no depende de SecureStore. La identidad de cliente, dirección,
llave y dispositivo, protocolo, autorización, visibilidad, foco, AppState y LockGate delimitan
la generación. Ocultar, bloquear, salir o invalidar retira permanentemente su descarga y contenido;
volver no recupera un archivo verificado anterior ni inicia un instalador tardío. Las guardas se
revalidan después de los awaits y antes de efectos nativos. Las acciones dobles quedan serializadas.
Una denegación terminal tardía del mismo cliente bloquea ese cliente aunque haya cambiado la
vista; una respuesta de un cliente reemplazado no invalida al nuevo.

## Módulo local y consentimiento Android

`mobile/modules/relay-apk-update` registra `RelayApkUpdate` en el paquete Kotlin
`expo.modules.relayapkupdate`, mediante el autolinking local de Expo (`./modules`). Es independiente
del módulo de avisos. El config plugin añade solo `REQUEST_INSTALL_PACKAGES`; el receptor explícito
no está exportado. No se añaden permisos de instalación silenciosa, desinstalación ni borrado de datos.

El módulo implementa un único candidato con token UUID, archivo en caché privada, directorio 0700
y archivo 0600, tamaño acotado y caducidad monotónica de diez minutos. Calcula SHA-256 con
`MessageDigest` por bloques y consulta el APK mediante `Android PackageManager`. Compara paquete,
versionCode, versión, bytes, digest y certificado contra la publicación; vuelve a comparar paquete,
versión y certificado con la app instalada dinámicamente. No confía en una firma constante de
Relay estable: Relay Dev puede usar otra. Rechaza múltiples firmantes.

Para instalar usa `PackageInstaller.Session`, exige `USER_ACTION_REQUIRED`, copia y vuelve a
comprobar los bytes entregados al sistema y recibe el resultado mediante un PendingIntent
específico. Antes de abrir la confirmación comprueba de nuevo token, foco, ciclo de vida y app
instalada. La retirada intenta cerrar y borrar el archivo privado y abandonar la sesión que aún
no se entregó a Android. Un pequeño registro privado conserva únicamente el identificador de la
sesión propia pendiente; el arranque en frío intenta abandonarla y limpiar archivos anteriores,
sin reanudar candidatos ni confirmaciones. Tras abrir válidamente la confirmación, Android posee
los bytes y el consentimiento: esa entrega no se revoca por el background provocado por su propia
pantalla. No se afirma que la actualización se haya instalado.

## Evidencia y límites reales

En `/home/user/dev/relay-app-v2-app-update-mobile` quedan:

- `app-update-core-final.log`: 17 pruebas verdes de transporte, coordinador, demo y plugin.
- `app-update-components-final.log`: 27 componentes verdes con pantallas, AppProvider y LockGate
  reales; los dobles cubren únicamente límites nativos, transporte, navegación, almacenamiento y reloj.
- `app-update-types-final.log` y `app-update-lint-final.log`: ambos comandos terminan correctamente;
  lint conserva dos advertencias anteriores en `bridgeClient.ts` y `ServerScreen.tsx`.
- `app-update-mutations-manifest.log`: 16 mutaciones con RED por aserción, restauración SHA-256
  exacta y GREEN, con sus pares `app-update-mutation-*-red.log` y `*-green.log`.
- `app-update-design-detect.log`: detector de diseño ejecutado una vez, sin hallazgos.
- `app-update-delivery-manifest.log`: lista exacta de archivos y hashes; la copia del DTO queda excluida.

Dos oráculos iniciales sobrevivieron a la eliminación de guardas redundantes porque cancelar ya
abortaba el transporte o retiraba la verificación. Se conservan esos logs; se añadieron regresiones
con retirada independiente de la validez durante awaits para probar la guarda antes del efecto.
Con esos oráculos, ambas mutaciones producen RED por aserción y restauración exacta/GREEN.

**No se ha compilado ni ejecutado el módulo Android.** Los dobles del límite nativo no demuestran
SHA-256 real, PackageManager, permisos del sistema, receptor, consentimiento ni limpieza real del
archivo. Root debe comprobar Kotlin, API/autolinking y esos comportamientos en su compilación y
validación nativa, incluido cold restart y salida durante la confirmación pendiente. No se ejecutó
gate, Gradle, prebuild, APK, servicios, teléfono ni producción. La fidelidad se contrastó con
`05_Servidor` PNG/HTML y primitives/tokens; no se comprobó una captura Android de esta pantalla.

La base no contiene ThemeProvider. Se mantiene C/S existente; Root migrará a `usePalette` tras
integrar DarkTheme `2c279fd`. No se cambia README, paleta ni ramas.

## Referencias primarias consultadas

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/).
- [Module API de Expo](https://docs.expo.dev/modules/module-api/).
- [Autolinking de módulos locales](https://docs.expo.dev/modules/autolinking/).
- [PackageInstaller.SessionParams](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams).
- [SigningInfo](https://developer.android.com/reference/android/content/pm/SigningInfo).

Las APIs también se contrastaron con el SDK instalado, sin ejecutar compilación nativa.

## Residual SPEC de blur Android sobre cac74b1

AppState puede seguir en `active` mientras la ventana pierde foco. El hook escucha ahora `blur` y
`focus` además de los cambios de estado. El blur retira sin esperar al próximo render el candidato,
el token de permiso y la petición; avanza también la revisión para que un blur/focus agrupado no
recupere la verificación ni el gesto anterior. Mientras falta foco se oculta la pantalla. Al volver
se lee una publicación nueva y se exige revisar versiones y realizar los gestos otra vez.

Los dos repros originales de SPEC se conservan con sus aserciones. Se añaden primer commit bajo
Profiler, blur/focus agrupado, gesto de descarga retenido, permiso retenido y retorno de un permiso
pendiente: 34 componentes APK en total. Las guardas de retirada síncrona y revisión monotónica se
mutaron por separado: RED por aserción, restauración exacta del SHA y GREEN 34/34. Evidencia y hashes
quedan en `apk-mobile-blur-delivery-manifest.log`; es un residual separado del arnés Android en
preparación. No se cambian Kotlin, DTO ni dibujo C/S. El SDK nativo sigue sin compilar/ejecutar por
el worker; la retirada del archivo real y la cola main de Android requieren las pruebas de Root.
