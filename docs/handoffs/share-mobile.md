# Compartir v2 · entrega congelada

Worktree `/home/user/dev/relay-app-v2-share-mobile`, rama `feat/v2-share-mobile`,
base `ab48d438afc1ed3bd1c9628f0baac0102f756973`. Sin commits, gate, prebuild,
Gradle, APK, ADB, servicios ni acceso a producción. Ninguna dependencia, DTO,
versión de app/protocolo o README cambió. `npm ci --ignore-scripts` usó el lock existente.

## Comportamiento y fronteras

El módulo local Expo `mobile/modules/relay-share` tiene Activity y registro propios.
Autolinking SDK57 resuelve `relay.modules.share.RelayShareModule`; su manifest se
fusiona desde la biblioteca, sin editar Android generado ni registrar otros módulos.
Acepta únicamente ACTION_SEND dirigido al receptor exacto: texto plain o una imagen
JPEG/PNG/WebP. Rechaza SEND_MULTIPLE, archivos, audio, selector/data, prefijo de grants,
extras/ClipData incompatibles, URI file externa y ausencia de permiso efectivo.
URLs son texto literal: no se descargan ni abren.

La imagen content:// se copia por stream acotado a cache privado (directorios 0700,
archivo 0600), con nombre aleatorio, sin persistir grants ni leer nombres de proveedor.
Límite fuente 16 MB, lado 10.000 px, 24 millones de píxeles; MIME declarado,
ContentResolver, firma y bounds deben coincidir. Reutiliza el pipeline v1 de
chatImages/ImageManipulator: JPEG hasta 1600 px y 2 MB. Texto + instrucción se
valida en UTF-8 hasta 64.000 bytes. El Puente conserva sus límites v1.

La bandeja nativa usa capacidades UUID sólo en memoria, 15 minutos, tres contenidos
más un aviso de desbordamiento. Arranque de proceso limpia copias nativas abandonadas;
no restaura autoridad. El launcher no recibe contenido, URI ni grants. `/share` no
acepta datos de deep link; la ruta de chat lleva únicamente el id opaco del borrador.
No hay WebView bridge ni notificaciones/logs de contenido, texto o nombres.

LockGate precede lectura de contenido y selección Servidor/Agente. AppProvider y
DraftProvider son reales. Caché de Agentes tiene fecha y sólo se consulta: preparar
borrador offline no envía peticiones. DraftStore nuevo (la base no tenía uno compartido)
es memoria privada, máximo ocho destinos, fijados a servidor + agente + cliente exacto.
No es outbox ni se reenvía al volver de offline/reiniciar. Confirmación de reemplazo
compara el id anterior; nuevo intent mantiene la vista anterior hasta acción explícita.

Se abre un compositor NUEVO, incluida imagen sin texto, sin cargar un canal externo.
Sólo Enviar humano crea Conversación/Turno por las APIs existentes. LockGate, fondo,
blur de ventana/ruta, clave sustituida, retiro, revocación y unmount invalidan permisos
capturados: preparación/Galería tardías se descartan, creación tardía no continúa al
Turno, recibo tardío no suscribe eventos ni se presenta como confirmación actual.
Si ya salió el POST del Turno, el resultado puede haberse aceptado: se avisa que no
se confirmó y no se reintenta automáticamente. Errores del envío Compartir son fijos;
no muestran el cuerpo remoto.

Denegación terminal se procesa antes de descartar una respuesta antigua. Clasificación
`pair` existente retira permanentemente ese objeto cliente en DraftStore, purga sus
referencias/copias y notifica todos los consumidores montados mediante useSyncExternalStore.
No afecta al cliente reemplazado. Texto editado, imagen retirada o sustituida sobreviven
remount del mismo ámbito; la miniatura aceptada usa recibos v1 existentes.

Bloquear Relay purga los borradores compartidos, no solo los permisos: DraftStore descarta
todos los borradores con su copia de imagen preparada, el chat compartido abierto deja de
mostrar el texto y el compositor, y se descartan en el módulo nativo las copias privadas
(`cacheDir/relay-share`) pendientes. Con bloqueo por inactividad se descartan todas las
pendientes en ese momento. Con bloqueo al volver de segundo plano se descartan las que había
al salir de Relay; lo compartido mientras Relay estaba fuera queda detrás del bloqueo, igual
que en un arranque en frío, para revisarlo tras desbloquear. Volver antes del plazo de
bloqueo no purga nada. Un borrador con envío en vuelo no se purga hasta que el Servidor
responda: si acepta el Turno, la imagen pasa al recibo local y el chat conserva el aviso de
resultado incierto; si lo rechaza y Relay sigue bloqueado, se purga con su imagen. Cubierto en
`Share.component.test.tsx` (pruebas de bloqueo).

## Diseño e integración

Se leyeron PNG + HTML `design/captures/instrumento-2/21-5..7`. Doce estados de
Compartir tienen demo real en `demoShare.ts` (exportada por demo.ts): texto, imagen,
no admitido, vacío, preparando, error, offline, conflicto, sin destino, nuevo intent,
cola llena y copia ocupada. Diseños derivados `design/captures/share-v2/21-8..19`
tienen HTML + PNG por estado. Son renders HTML sintéticos, explícitamente rotulados;
no capturas verificadas de React Native/APK. Los avisos del compositor reutilizan su
alerta existente y están cubiertos mediante interacción. Detector impeccable sin hallazgos;
revisión visual acotada de texto, conflicto, cola llena e imagen.

Root integra manualmente seis archivos compartidos: `_layout.tsx`, ruta chat,
`core/demo.ts`, `ChatScreen.tsx`, `chatImageNative.ts`, `useChatImages.tsx`.
Se conservó C/S/T de esta base como pidió Root; migración tema `76adb4b`/`2c279fd`
corresponde a Root, sin caché global de colores ni cambios de scopes por tema.
El parámetro legacy boardDraft de la base permanece; Compartir nunca lo emite.

## Pruebas y evidencia persistente

- `share-components-final.log`: 46 GREEN (32 Compartir + 13 imágenes v1 + 1 RootLayout/tablet/LockGate).
- `share-mutations-restored-core-native-green.log`: 8 GREEN (4 DraftStore + 2 chatImages + política JVM y autolinking real SDK57).
- `share-types.log`: los tres proyectos TypeScript pasan. `share-lint.log`: limpio, cero warnings.
- `share-mutations.log` y `share-mutations-source.log`: 19 aserciones RED explícitas, restauración byte por byte y GREEN. Cada RED está en `share-mutation-<nombre>-red.log`: destino, grant, URI, límite stream efectivo, MIME, reemplazo, scope, retiro imagen, conservación imagen, picker, tramo Send, recibo, callback terminal, orden terminal, dueño terminal, readmisión, suscripción terminal, redacción y LockGate.
- TDD original: `share-core-red.log`, `share-native-red.log`, `share-components-red.log`, `share-draft-remount-red.log`, `share-draft-image-red.log`, `share-send-scope-red.log`, `share-terminal-red.log`, `share-terminal-listeners-red.log`, `share-error-red.log`. Sus GREEN y validación final quedan junto a ellos.
- `share-autolinking.log`, `share-design-render.log`, `share-design-busy.log`, `share-design-detector.log`; `share-manifest.log` contiene hashes finales, incluido este handoff. Todos los logs están ignorados en ESTE worktree.

Comandos estrechos: node --test plugins/shareNative.test.js src/core/sharedDrafts.test.ts
src/core/chatImages.test.ts; test:components con los tres archivos citados; npm run
typecheck y ESLint sobre el manifiesto propio. JVM requiere Java17 existente en PATH,
JAVA_HOME o RELAY_SHARE_JAVA_BIN; no se instaló Java/SDK.

## Límites y siguiente paso Root

Kotlin/manifest y recepción Android real no fueron compilados/ejecutados: Root debe
validar APK, arranque frío/caliente, grants/ClipData efectivos, rechazos dirigidos,
permisos y tamaños en dispositivo, rotación JPEG y composición tablet. No se afirma
fidelidad de APK ni compatibilidad de recepción nativa iOS/web.

Un ContentProvider puede bloquear open/read indefinidamente. A los 15 segundos se
rechaza la vista; sólo existe un worker y se rechazan nuevas copias como ocupado.
El IO bloqueado no es cancelable de forma fiable; su limpieza ocurre al retornar.
La eliminación de archivos es asíncrona con API v1: si falla el almacenamiento, pueden
quedar bytes privados sin referencia accesible/restaurable desde la UI. No hay envío
ni autorización persistida por eso.

Trabajo P1 SPEC quedó corregido y congelado por separado en
`/home/user/dev/relay-app-v2-kanban-mobile/docs/handoffs/kanban-mobile.md` (sólo tres
paths residuales). No se volvió a editar durante este cierre.

Prioridad retenida: todo v2 incluyendo tablet; forks pendientes de Ale. Después,
README con capturas verificadas + instalación + prompt setup. Comprobar v3 y tomarla
si está lista; si no, compatibilidad. Root asigna Widget/u otro pendiente; no se crea
sesión/agente ni se asume un trabajo nuevo.

## Fuentes primarias

El registro usa los mecanismos documentados de [módulos locales Expo](https://docs.expo.dev/modules/get-started/),
[autolinking](https://docs.expo.dev/modules/autolinking/) y [Module API](https://docs.expo.dev/modules/module-api/),
contrastados con el código instalado SDK57 (expo-clipboard Gradle y expo-modules-core Kotlin).
Se consultó [Expo SDK57](https://docs.expo.dev/versions/v57.0.0/sdk/expo/).
La recepción sigue [Android: recibir contenido](https://developer.android.com/develop/ui/compose/sharing/receive),
[contrato Intent y flags de grants](https://developer.android.com/reference/android/content/Intent)
y [lectura segura de archivos compartidos](https://developer.android.com/training/secure-file-sharing/retrieve-info).
No se usaron fuentes ni archivos de Hermes instalado.

## Manifiesto exacto

Todos los paths siguientes son relativos al worktree absoluto indicado arriba.
Este handoff también es parte de la entrega; su hash está en share-manifest.log para
evitar una autorreferencia. No copiar los logs como código.

- `design/captures/share-v2/21-10-rejected.html` · SHA256 `e12b34e5454d4c35b6f367dbd4414edc5e10a54e6f838d9010c58b10c4f62923`
- `design/captures/share-v2/21-10-rejected.png` · SHA256 `7b35eaeaf8a482c11af065a8c0b0e12392f48a9450ffd5c6774d49d7aa6a3552`
- `design/captures/share-v2/21-11-empty.html` · SHA256 `1d397cfbb179ca26d73696064049118b13872f352a2ea5b468dc8980219ce556`
- `design/captures/share-v2/21-11-empty.png` · SHA256 `d91963bb2935ab5185f245451cf2ae81638235c40a3466d0c62a231bda7623d8`
- `design/captures/share-v2/21-12-preparing.html` · SHA256 `6530cf22a80a6976ccab6dfd5d3dfee034bd6d7ac7d1aa2dbb5b4b9cbba1376f`
- `design/captures/share-v2/21-12-preparing.png` · SHA256 `3218db42bc3f332803d0e8bf3d8fbd143843b882d59a27199408cca9db225e67`
- `design/captures/share-v2/21-13-error.html` · SHA256 `2b87ae11841ec52d83ba854b2149538ea63068c1896f978340dabec5119840f1`
- `design/captures/share-v2/21-13-error.png` · SHA256 `65c2502ac4a7d1fd943338976013abd712455af5908beabdce82999b3dad57f9`
- `design/captures/share-v2/21-14-offline.html` · SHA256 `b9841ea6720e6f173965140e7663fc4d41603a88057003aeca06745b1a403838`
- `design/captures/share-v2/21-14-offline.png` · SHA256 `54ee4282abe6e74aaca495826071e2f7dbe347099829fc68115ace1be2fd3b91`
- `design/captures/share-v2/21-15-conflict.html` · SHA256 `58ee34e37618d27cd248e37b31d148cec4a0d913ca1161325c1250befd77eaeb`
- `design/captures/share-v2/21-15-conflict.png` · SHA256 `e38e75a5c2fb4cc1135c92bb12812648e254ebde2ea4381742e2155e3454db51`
- `design/captures/share-v2/21-16-no-server.html` · SHA256 `7c9fea8cf397e3fcb2ee61c43526d8bd40b56ac07446c5fbb551be4c7d471dde`
- `design/captures/share-v2/21-16-no-server.png` · SHA256 `4706183a99bd7d0a547b42c47d54014b5ad97b3f30e46ff3586ed8e6a07a6c67`
- `design/captures/share-v2/21-17-new-intent.html` · SHA256 `705eb906bada4c4413930ac35da56d7475a67d8adebf1cde5d311a966b9bea48`
- `design/captures/share-v2/21-17-new-intent.png` · SHA256 `614d761dd41f07854e1dab282827080b696bbecbeae472efaf26bb1ed2fae21d`
- `design/captures/share-v2/21-18-queue-full.html` · SHA256 `74e5272d15570dd6fe666dfbca696ee3917a4a42ef93c9cccec1be49b197e394`
- `design/captures/share-v2/21-18-queue-full.png` · SHA256 `068319bce5f17c0d80b8a4b2b4235b445d1768b45ffce34d890719a9b224f795`
- `design/captures/share-v2/21-19-busy.html` · SHA256 `ddd3fe7c49d5acec701205af422013ab38954d29a5c5d5ae02eb319e9149b578`
- `design/captures/share-v2/21-19-busy.png` · SHA256 `4c4149a890fb1cb914f78d78f79d027b3cfe5ab0414afb02265303787e21d34e`
- `design/captures/share-v2/21-8-text.html` · SHA256 `399703391bbd4273babc4ac568a7d829515c3e9c40d6f2b711e814c9fdbaf0a3`
- `design/captures/share-v2/21-8-text.png` · SHA256 `fe330d2b4f751f4619b9e2390a275dc78b71e27739452e4207996ef632b8063c`
- `design/captures/share-v2/21-9-image.html` · SHA256 `3a3c36db847a5cab616f6a4aeb52f13b71667dbe3106ee3f5ea9962735a3c534`
- `design/captures/share-v2/21-9-image.png` · SHA256 `33f8cc2ab13fd29f4d155696e9e5c746b901a16529e556f19f4c3f8972779409`
- `mobile/modules/relay-share/android/build.gradle` · SHA256 `bf74142b8273d969e26f81d1841c7c78008cac3aa25a10bd9e6974fca110cbd3`
- `mobile/modules/relay-share/android/src/main/AndroidManifest.xml` · SHA256 `00e80eac97e43e6bd6ebb4fdd8d31e86d9c1ea897ac7e2f358fa205ac81a80ea`
- `mobile/modules/relay-share/android/src/main/java/relay/modules/share/RelayShareModule.kt` · SHA256 `6daa9b5b13113a5c74334a94767fcc6a45a287415ee564955f640bac36bce96b`
- `mobile/modules/relay-share/android/src/main/java/relay/modules/share/ShareInbox.kt` · SHA256 `25ea929e0c05147a8c43b7a3c28adea846711930f24121ba3949439ab632e8c2`
- `mobile/modules/relay-share/android/src/main/java/relay/modules/share/SharePolicy.java` · SHA256 `c50fa4b8339e8421244526adc7a3f72cc95e29b3e693bfa7ef618f8a585d04d4`
- `mobile/modules/relay-share/android/src/main/java/relay/modules/share/ShareReceiverActivity.kt` · SHA256 `69c9f34f2747bf2468c1dc888bf0c5ad92fcb117468a62179d5c81bfe2fecce4`
- `mobile/modules/relay-share/expo-module.config.json` · SHA256 `9c10718364fe6b73864b86e466cae448b063558cced69b860772cefc5d09af49`
- `mobile/modules/relay-share/package.json` · SHA256 `3da7562dee30ff6a48eff6d666abacb94be659da173d1972e01835123d2af350`
- `mobile/modules/relay-share/test/SharePolicyTest.java` · SHA256 `25cdc9c1dd23432b73e232439cd21b7d17c17cb08874ba7e350e9460f32978cf`
- `mobile/plugins/shareNative.test.js` · SHA256 `47ad73108856f3062d5003a4358767df03c589fa5ff01a6198101bcce2d19b27`
- `mobile/src/app/_layout.tsx` · SHA256 `ed6e74b88fec21261c477a09b4aa646cd1776133abc322d764f9d50b43bff373`
- `mobile/src/app/chat/[server]/[agent].tsx` · SHA256 `3eece0e5d9953b6c522714a59b24db09b2368d50e346103a1c1b80ad7fe532f2`
- `mobile/src/app/share.tsx` · SHA256 `ab617b6ce002853bfaf0cf8309d9215e58fc47c4a0fad8dc9619d3382ace63f1`
- `mobile/src/core/demo.ts` · SHA256 `b3412820d6092b76832dab2f58d75a9d54f36d1720b5fd77c8c8142acd15a597`
- `mobile/src/core/demoShare.ts` · SHA256 `2a6860c9c6854c0ade1cf6611f057aa5eeb0c51592f671d7aa49ddbd30bc208c`
- `mobile/src/core/sharedDrafts.test.ts` · SHA256 `5513e309e0346242c4caf254d59375937beaacb29eb324b8cb347d96a3e6dc2d`
- `mobile/src/core/sharedDrafts.ts` · SHA256 `5a793683fd70b9f8fbaac2d2023015d1036782195b2b7b7d346129d0ed904c73`
- `mobile/src/native/externalShare.ts` · SHA256 `52c84aa015fffacd215e7e7098fe4bed6bc1867c244dc43c3f0b529eb81952c8`
- `mobile/src/screens/ChatScreen.tsx` · SHA256 `8f8999b0446da14b55fd2c4428f326889b0462bc3ed0dfd080f74acbfd9a6fa1`
- `mobile/src/screens/ShareLauncher.tsx` · SHA256 `664be3b1af55d449dfce788cfe1ad957b4b7b02f6263e03215450b93651ca3da`
- `mobile/src/screens/ShareScreen.tsx` · SHA256 `52117f29d6cf6bbe4e7297f2f92f89fb6b4f4dc095b293eb6492eaf0bd3907ba`
- `mobile/src/screens/SharedChat.tsx` · SHA256 `6dc78fb30805c919c8c08460e3b9db4f41f30c5df35d63a97a28cf3fda583b2d`
- `mobile/src/screens/chat/chatImageNative.ts` · SHA256 `228a62ffd8af755ddbecac3eca3f0bdc4e7119f0b7dfb8a0a58981d9daa31ce7`
- `mobile/src/screens/chat/useChatImages.tsx` · SHA256 `4a85277d636730927ba9e041686e76e2114453cd1e1e13bc68aae9850e5041be`
- `mobile/src/state/sharedDrafts.tsx` · SHA256 `8e6131fad8a5ec01748d8b5a14eea1bf80864fbf8f30d6bf198c688357080d04`
- `mobile/src/state/useShareScope.ts` · SHA256 `2363d9bf676835ef67acf044d7fda249a602c298170909eaab3a40c2276f8eac`
- `mobile/tests/components/Share.component.test.tsx` · SHA256 `fbcf66375b8b8eec961e3ad3bb152d9f979e095a53ebe56ddd67c225a9ba7770`
- `mobile/tests/support/externalShare.ts` · SHA256 `2c2b5c803064d2783c9015994f44d8acd5230c8b1051f55560eaac13a73970d3`
