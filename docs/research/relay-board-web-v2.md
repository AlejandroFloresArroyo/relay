# Tablero web v2: contrato Android + Puente y límites comprobados

Investigación independiente, 2026-10-04. Árbol de referencia: `30d80349999282625565d5371fee28750a950e7c`. Solo lectura y este documento; sin código de producto, dependencias nuevas, build Android, gate, Hermes, Puente real o servicios. La skill research se aplicó en esta sesión; su instrucción de delegar queda subordinada a la prohibición expresa de crear agentes.

## Resultado y condición para construir

**Sí existe la vía de renderizado:** un módulo Expo local puede exportar una `ExpoView` Kotlin que contenga `android.webkit.WebView`, y React la puede montar sin instalar `react-native-webview`. El SDK instalado ya contiene esas APIs. Esto requiere integrar el módulo en el binario propio; no basta Expo Go. No se ha compilado ni montado una vista Android aquí.

**El contrato completo de JS arbitrario sin ninguna salida de red no queda demostrado para todos los proveedores WebView Android 24+.** Las capas descritas abajo son realizables, pero el ajuste que bloquea recursos no constituye evidencia de firewall para toda API JavaScript. La especificación de CSP tiene una directiva específica para WebRTC; no se verificó su implementación en el proveedor del teléfono ni en el mínimo Android. No habilitar el contenido interactivo alegando que `connect-src`, permisos multimedia o `shouldOverrideUrlLoading` cubren eso. La condición de activación es una prueba nativa que cierre esta frontera; si no se cierra, mantener la capacidad `web` desactivada con causa explícita. HTML estático/JS apagado es una alternativa de alcance que Root debe decidir, no una sustitución silenciosa del requisito interactivo. [CSP §6.2.1](https://www.w3.org/TR/CSP/#directive-webrtc), [WebSettings](https://developer.android.com/reference/android/webkit/WebSettings#setBlockNetworkLoads(boolean)).

## Alcance existente y diseño

`protocol/board.ts:1-29` define siete tipos nativos, archivo de publicación de 32 KiB, 32 Tarjetas por Agente y 32 Agentes. `bridge/src/board.ts:31-58` usa descriptores relativos Linux, NOFOLLOW, archivo regular con un enlace, lectura acotada y comprobación de cambios. `:65-76` admite exclusivamente archivos JSON en `relay-board`. **Meter subdirectorios de bundles en ese directorio rompe hoy la lectura del Tablero.** El namespace web debe ser un hermano dedicado, sin ampliar el acceso genérico a archivos ni hacer que el Puente escriba perfiles.

`docs/relay-v2.md:24` exige definir aislamiento antes de servir. `docs/relay-v1.md:249-256` conserva atribución, fechas, estados y control local. `design/README.md` no enumera capturas 16b y `design/captures/instrumento-2` no contiene 16b en este SHA. La referencia web sí está en `design/source/relay-instrumento-2.dc.html:1913-1915` y `design/claude-design-prompts.md:166-167`: marco punteado/rayado, tipografía propia, rótulos CONTENIDO DEL AGENTE y HTML · AISLADO. No afirmar que se verificó una captura inexistente. Rótulo, atribución, fecha, error y acciones viven fuera del WebView, bajo control nativo.

## Módulo local, sin dependencias nuevas

Usar `mobile/modules/relay-board-web/` con `package.json`, `expo-module.config.json` (`platforms: ["android"]`, módulo Kotlin), Android library con el `expo-module-gradle-plugin` ya instalado y wrapper TS. `ModuleDefinitionBuilder.View(...)`, `ExpoView(context, appContext)` y `requireNativeViewManager(...)` existen en la fuente instalada; una `WebView` es un hijo Android de esa vista. Props de confianza: identificador de snapshot nativo y generación; nunca URL arbitraria ni cabeceras. El autolinker busca `./modules` por defecto. [Módulos locales](https://docs.expo.dev/more/create-expo-module/), [autolinking](https://docs.expo.dev/modules/autolinking/).

No introducir `androidx.webkit:webkit` indirectamente: no aparece declarado en los Gradle inspeccionados de Expo instalado; tampoco se resolvió un grafo Gradle para afirmar que esté disponible. `WebViewAssetLoader` es una utilidad AndroidX, no una API del framework. Su patrón HTTPS local es válido; sin añadir esa dependencia, usar `WebViewClient.shouldInterceptRequest` del framework con un mapa de bytes inmutable y la misma ausencia de fallback. No copiar su clase sin revisar licencia. [WebViewAssetLoader](https://developer.android.com/reference/androidx/webkit/WebViewAssetLoader).

## Negociación aditiva y compatibilidad v1/protocolo 2

Propuesta: `X-Relay-Board-Web: 1`, independiente de `X-Relay-Protocol: 2`. No ampliar incondicionalmente lo que recibe v1. En GET /v1/board, sin la cabecera, cada publicación web se proyecta a content `{type:'text',text:'Esta Tarjeta requiere soporte de contenido web. Actualiza Relay para verla.'}` dentro del DTO nativo existente, con los mismos id/Agente/title/updatedAt/maxAgeMs/state/status; sin propiedades adicionales, URL, bundleRef, revisión ni HTML. Las otras siete Tarjetas permanecen byte/semánticamente equivalentes. No hacer fallar el Page entero por el octavo tipo.

Con cabecera exactamente `1`, Puente capaz devuelve DTO web y confirma soporte mediante respuesta `X-Relay-Board-Web: 1` (exponerla por CORS si corresponde). La app nueva verifica esa confirmación; un Puente antiguo que ignora la petición o no anuncia soporte conserva lectura nativa y desactiva web con causa de capacidad, sin solicitar assets. Valor de versión no soportado: error de capacidad explícito; no alterar emparejamiento ni asumir que protocolo 2 implica web. Las rutas web exigen ambas cabeceras y auth normal fuera del WebView. GET nativo sin cabecera sigue utilizable. Probar clientes v1 contra página mixta, app nueva contra Puente antiguo y valor de versión desconocido. Es diseño de contrato; aún no implementado ni validado por componentes.

CookieManager/SW son globales del proceso, no aislamiento por Tarjeta. No extender esta propuesta a cookies del Puente, localhost o sesiones V3. Si otro módulo necesita cookies/SW, esta política global deja de ser suficiente: Root debe separar/reconciliar su propietario antes de activar, y verificar el aislamiento de ese nuevo diseño. No hay afirmación de perfil independiente en Android24 ni aislamiento por un hostname sintético por sí solo.

## Publicación y DTO propuesto — todavía no contrato implementado

Extensión aditiva de `BoardContent`: `{type:'web', bundleRef:string, revision:string}`. `bundleRef` es un identificador ASCII acotado, no ruta/URL; `revision` es SHA-256 del manifiesto canónico exacto. Campos extra rechazados. Conservar envoltorio de publicación/estados y versiones actuales; anunciar soporte con una capacidad explícita. Si el Puente antiguo no la anuncia, mostrar tipo no disponible, no pedir rutas inexistentes.

Namespace fijo propuesto por perfil conocido: `relay-board-web/<bundleRef>/<revision>/manifest.json` y archivos allí enumerados. Ningún componente proviene de una URL o home enviados por el Agente. Manifiesto exacto: schema, entry fijo `index.html`, archivos `{name,mime,bytes,sha256}`; revisión excluida del manifiesto para evitar hash circular. Propuesta conservadora para fijar por Root: manifiesto <=16 KiB, hasta 32 archivos, archivo <=256 KiB, suma <=1 MiB y hasta 8 MiB de bundles activos por Servidor. Rechazar el exceso, no truncar ni descomprimir ZIP. Solo nombres planos ASCII, sin slash, puntos especiales, `%`, query, fragmento o normalización ambigua. MIME por extensión allowlist: HTML, JS clásico, CSS, PNG/JPEG/WebP; sin SVG externo, documentos extra, módulos/Workers, fuentes remotas o recursos fuera del manifiesto. Datos de gráficas se incluyen en JS/HTML, sin fetch.

Reutilizar **la frontera de lectura por descriptor**, no validar con realpath y reabrir después. Validar ancestros, regular/nlink=1, tamaño real y hash, leer con límite+1, fstat antes/después y verificar hash final. Capturar los bytes completos de la revisión antes de entregar. Publicar mediante rename desde fuera del namespace, en el mismo filesystem. Los hashes fijan integridad/revisión; no convierten HTML en código de confianza ni autentican al Agente frente a otro proceso del mismo usuario Unix.

Rutas nuevas propuestas, GET autenticadas por dispositivo: `/v1/agents/:agentId/board-web/:bundleRef/:revision/manifest` y `/assets/:assetName`. Guardas de auth/protocolo al entrar, después de lecturas y antes de responder; sin redirects, paths arbitrarios, listado del perfil o capability URLs. Logs con etiqueta de ruta fija; errores sin contenido. DTO no incluye URI secreta. Respuestas bounded, MIME explícito, `nosniff`, `no-store`, sin cookies ni CSP del Agente. El cliente nativo descarga con la autorización normal **fuera del WebView**, verifica hashes y copia a un snapshot privado por Servidor+dispositivo/emparejamiento+Agente+Tarjeta+revisión. Publicar todo o nada; ninguna lectura de assets vuelve al Puente desde HTML.

## Sandbox propuesto y qué cubre cada capa

Origen sintético generado por Relay por snapshot, por ejemplo `https://b-<id-aleatorio>.relay.invalid/`; nunca origin del Puente ni de Hermes. Un mapa local solo sirve bytes seleccionados, sin filesystem accesible al motor. Todo recurso permitido devuelve `WebResourceResponse` local 200; lo demás una respuesta vacía 403, **jamás null**. Aceptar solo GET, URL canónica exacta, HTTPS, host y puerto exactos, sin usuario/query, y nombre presente con hash verificado. Ninguna respuesta local lleva redirección o Set-Cookie.

`shouldInterceptRequest` no cubre javascript/blob/assets Android y solo ve la primera URL de una redirección; `shouldOverrideUrlLoading` tampoco se llama en POST. Por eso no se usan solos: cancelar navegaciones de la página en ambos overloads, no abrir intents/CustomTabs, y combinar respuestas locales con bloqueo de recursos y CSP. La carga inicial la realiza exclusivamente el módulo con su URL construida. [WebViewClient](https://developer.android.com/reference/android/webkit/WebViewClient#shouldInterceptRequest(android.webkit.WebView,%20android.webkit.WebResourceRequest)).

| Control | API concreta y uso |
|---|---|
| Recursos de red/cache | `setBlockNetworkLoads(true)`, `setBlockNetworkImage(true)`, `setCacheMode(LOAD_NO_CACHE)`; comprobar en Android que el proveedor sirve las respuestas interceptadas locales con bloqueo activo. |
| Archivos/proveedores | `setAllowFileAccess(false)`, `setAllowContentAccess(false)`, `setAllowFileAccessFromFileURLs(false)`, `setAllowUniversalAccessFromFileURLs(false)`. No cargar file/content/data como documento inicial. |
| Persistencia web | `setDomStorageEnabled(false)`, `setDatabaseEnabled(false)`; las APIs obsoletas no sustituyen origen opaco ni CSP. |
| Contenido mixto | `setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW)`; nunca aflojar para recursos locales. |
| JS local útil | `setJavaScriptEnabled(true)` únicamente después de instalar todas las guardas; DOM, botones, filtros y canvas dentro del bloque. Sin evaluación de snippets enviados por React. |

Estas opciones son del framework y están disponibles antes de API 24. `setAllowFileAccess(false)` deja accesibles assets/res Android: requiere además CSP y casos maliciosos específicos, no prometer que ese flag los elimina. [WebSettings](https://developer.android.com/reference/android/webkit/WebSettings).

No `addJavascriptInterface`, web messages, listeners JS, shell, download manager o callbacks que ejecuten acciones del Agente. No inyectar Relaykey, identidad privada, credenciales, estado del chat o contenidos de otra Tarjeta. Si hay bridge Expo RN↔Kotlin para props de confianza, eso **no** es un bridge del JS del documento. Su contrato no ofrece comandos ni lectura arbitraria. [WebView](https://developer.android.com/reference/android/webkit/WebView#addJavascriptInterface(java.lang.Object,%20java.lang.String)).

CSP **en header nativo**, sobre documento wrapper de confianza y documento del Agente. Wrapper sin JS, iframe único `sandbox="allow-scripts"`; no allow-same-origin/forms/popups/top-navigation/downloads. El documento del Agente recibe también `sandbox allow-scripts`. Política base propuesta:

```text
default-src 'none'; script-src https://b-<snapshot>.relay.invalid;
style-src 'unsafe-inline' https://b-<snapshot>.relay.invalid;
img-src https://b-<snapshot>.relay.invalid;
connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none';
object-src 'none'; media-src 'none'; font-src 'none'; base-uri 'none';
form-action 'none'; sandbox allow-scripts; webrtc 'block'
```

El wrapper permite únicamente su iframe en frame-src; el documento del Agente no permite otros. JS clásico externo usa addEventListener; inline scripts/handlers/eval no se habilitan. CSP sandbox no funciona en meta. Las directivas de conexión cubren fetch/XHR/WebSocket/EventSource/beacon; no equiparar eso a toda conectividad. No configurar report-uri/report-to con destinos externos. `webrtc 'block'` debe ser comprobado, no asumido por existir en el estándar. [CSP](https://www.w3.org/TR/CSP/).

Cookies: `CookieManager.setAcceptCookie(false)` antes de cargar y `setAcceptThirdPartyCookies(view,false)`. El primero afecta todas las WebViews del proceso; coordinar su propiedad, no cambiarlo luego desde otro módulo. [CookieManager](https://developer.android.com/reference/android/webkit/CookieManager#setAcceptCookie(boolean)).

Service Workers API24+: antes de cualquier WebView, `ServiceWorkerController.getInstance()`: settings bloquean red/file/content y client devuelve denegación para toda petición. Es singleton para todas las WebViews y no hay toggle público equivalente a “serviceWorkerEnabled=false”. Origen opaco+worker-src impiden registro; controlador es defensa adicional. No cargar un origen con un worker previo. [Controller](https://developer.android.com/reference/android/webkit/ServiceWorkerController), [settings](https://developer.android.com/reference/android/webkit/ServiceWorkerWebSettings).

Popups: ventanas múltiples manejadas con `onCreateWindow=false`, sin crear otro WebView; `javaScriptCanOpenWindowsAutomatically=false`. Descargas: listener descarta sin HTTP/intents. ChromeClient niega permisos, geolocalización, file chooser, fullscreen y diálogos JS; console se consume sin registrar texto privado. No transmitir URL del documento a navegadores externos. [WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient).

## Retirada y uso desconectado

Generación monotónica de snapshot, invalidada por revocación, cambio de scope/emparejamiento, LockGate, blur, background y desmontaje. La invalidación retira la vista/contenido inmediatamente, cierra el mapa de recursos incluso si hay callbacks IO pendientes y descarta respuestas tardías. Deshabilitar JS, detener carga, retirar del padre y destruir el WebView en UI thread; no resucitar la instancia al desbloquear. Copias pendientes no pueden volver a publicar después de la purga. Revocación borra snapshot/cache tras esperar sus writes pendientes; blur/lock eliminan documento activo sin borrar preferencias nativas. No interpretar stopLoading por sí solo como parada de timers.

Sin conexión: fecha y causa nativas; **no reactivar JS de una caché antigua**. Se puede conservar metadata fechada dentro del scope válido y mostrar “Contenido web no disponible sin conexión”. No guardar screenshots privados por defecto. `setDataDirectorySuffix` solo existe desde API28 y es por proceso; no es aislamiento por Tarjeta ni una solución compatible con API24. [WebView](https://developer.android.com/reference/android/webkit/WebView#setDataDirectorySuffix(java.lang.String)).

## Evidencia mínima y bloqueantes de validación

Se ejecutó un selector sintético Node con mapas de bytes y SHA-256: **21 aserciones verdes**, dos assets válidos; rechazo de http/host distinto/puerto/user/query/%/dot-segments/file/content/data/blob/javascript/intent/wss/fragmento/asset ausente/POST/scope retirado/hash cambiado. El HTML adversarial incluido contenía img, form POST, iframe file, fetch, WebSocket y window.open. **No se ejecutó ese HTML en un motor**: el resultado prueba solamente la decisión del selector, no CSP, el WebView o la ausencia de tráfico. Sin red ni servicios. La proof reproducible es volver a pasar esa matriz a la función de selección real futura; no hay selector de producto implementado.

Antes de activar, prueba instrumentada con WebView real y bundle benigno contador/canvas + HTML adversarial: recursos externos, redirect, POST/form, popup/download, top navigation a intent/file/content/data/blob, frame/srcdoc/about:blank, worker/serviceWorker, cookies/localStorage/IndexedDB/cache, fetch/XHR/WebSocket/beacon/EventSource y RTCDataChannel/STUN/TURN. Medir **ausencia de egress**, no solo callback recibido/consoleerror. Probar API24 y proveedor soportado actual, cambios rápidos de scope, LockGate real/background y revocación durante copia/respuesta nativa. No cargar destinos de producción.

Bloqueantes: (1) garantizar ausencia de red WebRTC y verificar interacción blockNetworkLoads/intercepción local; (2) fijar proveedor/minimum supported WebView o negar la capacidad cuando no se pueda demostrar; (3) fijar por Root cuotas/MIME/namespace/DTO aditivo y retiro offline; (4) reconciliar globals de cookies/SW con otros módulos. Reemplazar RTCPeerConnection o fetch por un monkeypatch JS no es una frontera de seguridad: un realm nuevo o una referencia retenida puede evitarlo. `android:process` conserva permisos de la app; un firewall/servicio aislado adicional no fue investigado ni prometido como parte de una ExpoView mínima.

## Fuente instalada fijada por hashes

Los siguientes son fuente primaria del SDK instalado, no una afirmación de compatibilidad compilada. Versiones y SHA-256:

- [mobile/node_modules/expo-modules-core/package.json](../../mobile/node_modules/expo-modules-core/package.json) — versión 57.0.20; SHA-256 `4df983b690e6ffd4dbf72c1fba0634a576c4d6fa9270d1544838f74d580ccb90`.

- [mobile/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/views/ExpoView.kt](../../mobile/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/views/ExpoView.kt); SHA-256 `99748a6ec617d2685effd83561a25846d87f92b3fd57102b8b8fdbf973bf9a26`.

- [mobile/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/modules/ModuleDefinitionBuilder.kt](../../mobile/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/modules/ModuleDefinitionBuilder.kt); SHA-256 `f0e5a813be01e2dc28ada1f07218062e19f1c1ce857521b459cb2eefbc72a1c5`.

- [mobile/node_modules/expo-modules-core/src/NativeViewManagerAdapter.native.tsx](../../mobile/node_modules/expo-modules-core/src/NativeViewManagerAdapter.native.tsx); SHA-256 `65070fa4e75b84467caf88a5756f548ab022fe6725c937a87626b1204ff08651`.

- [mobile/node_modules/expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/ProjectConfiguration.kt](../../mobile/node_modules/expo-modules-core/expo-module-gradle-plugin/src/main/kotlin/expo/modules/plugin/ProjectConfiguration.kt); SHA-256 `ec8e6a05af1a6395a70db35f1d96529653181a2c00824608c1eb5221f46fd4d8`.

- [mobile/node_modules/expo-modules-autolinking/package.json](../../mobile/node_modules/expo-modules-autolinking/package.json) — versión 57.0.13; SHA-256 `09a8b86830391aa31b0e8d4d66bf2a3b3cd44ea1f910285d27f5cc9ccd42a448`.

- [mobile/node_modules/expo-modules-autolinking/src/commands/autolinkingOptions.ts](../../mobile/node_modules/expo-modules-autolinking/src/commands/autolinkingOptions.ts); SHA-256 `6d38a7bb5214d658eaece033b583d695a2b316fab37cfba9314a122472b78978`.

- [mobile/node_modules/expo-modules-autolinking/src/autolinking/findModules.ts](../../mobile/node_modules/expo-modules-autolinking/src/autolinking/findModules.ts); SHA-256 `ee2448f0e496896a72504ac450d2e5ba7e635838c66faa123b2f95d32bdbb208`.

- [mobile/node_modules/expo-web-browser/android/build.gradle](../../mobile/node_modules/expo-web-browser/android/build.gradle); SHA-256 `51dd1d1acf6ba701f27537b9a6782666b1cfa004d5369b8748cd5c6ce377330b`.

Prioridad de continuidad: conservar v1 + wizard + APK + todo v2; después README con capturas verificadas/instalación/setup; luego V3 si definida/lista y, si no, compatibilidad. Root coordina decisiones; no se hicieron preguntas a Ale.
