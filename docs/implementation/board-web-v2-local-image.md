# Tablero web: PNG local y denegación de red

## RED real y diagnóstico acotado

Root ejecutó la matriz corregida con policyHash 93d813ff9051f7221382ad57c6b5ac0f005544688ba0e22cbdd98983ca62e765, WebView153/SDK36. nativeStore pasó. El baseline del motor produjo TCP27, UDP69 y tres ofertas RTC: control positivo real del motor, no solo sockets nativos. Restricted ejecutó contador/canvas/CSS pero falló local_image_not_executed antes de completar su prueba. Salida copiada a board-web-local-image-native-red.log del worktree. No permite activar proveedor ni afirmar zero egress.

La primera hipótesis es la carga de imagen deshabilitada antes de shouldInterceptRequest: el PNG usa el mismo origen HTTPS sintético y mapa privado que script/CSS, pero blockNetworkImage=true se traduce en Chromium a loads_images_automatically=false. La documentación Android distingue ese filtro por URI de blockNetworkLoads. No se ha observado aún en el dispositivo si el PNG alcanzaba el interceptor; por eso el residual agrega un contador nativo de respuestas de imagen y uno de errores del PNG. Si respuestas=0, sigue fallando antes del recurso; si respuestas>0 y onerror>0, investigar decode/CSP/origen. No volcar ConsoleMessage, URL ni cuerpos.

Fuentes primarias: [Android WebSettings](https://developer.android.com/reference/android/webkit/WebSettings#setBlockNetworkImage(boolean)), [WebViewClient](https://developer.android.com/reference/android/webkit/WebViewClient#shouldInterceptRequest(android.webkit.WebView,%20android.webkit.WebResourceRequest)), [Chromium AwSettings](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/java/src/org/chromium/android_webview/AwSettings.java) blob76190215a878645e7ffa4cf75ab9fc56cf4d9f56, y [mapeo Blink](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/browser/aw_settings.cc). Main consultado no se presenta como fuente exacta del proveedor153: es evidencia para el candidato; Root deberá comprobar el motor real.

## Candidato y guardas intactas

Único cambio funcional de política: al crear una vista nueva, blockNetworkImage=false deja que el renderer solicite imágenes al interceptor local. blockNetworkLoads=true sigue fijado antes de cargar cualquier documento, incluido SW; nunca se vuelve false. No se cambia CSP, esquemas, sandbox opaco, navegación, acceso file/content, cookies, storage, diálogos, permisos ni otras denegaciones. No hay data/blob alternativo, sustituto estático ni reescritura HTML. Todas las peticiones interceptadas conservan respuesta no nula: recurso exacto del snapshot o 403 vacío, nunca fallback de red. El callback de contador es Kotlin interno opcional, no prop/función Expo ni puente HTML, y se omite en producto.

La documentación Android advierte que blockNetworkLoads también impide imágenes de red incluso si el filtro de imágenes es false; no se abre ese bloqueo para arreglar el PNG. El candidato depende de respuestas locales interceptadas. Si el proveedor sigue impidiéndolas, este parche no es cierre y hay que resolver transporte local seguro sin relajar red.

Instrumentation conserva sin cambios imageLoaded.await como aserción benigna, baselineTcp>0/UDP>0/rtcOffers>0 y restrictedAttempts>=35/leaks=0/TCP=0/UDP=0. Los únicos campos nuevos son baseline/restrictedLocalImageResponses y LocalImageErrors, también presentes al fallar la prueba. onerror solo reporta etiqueta fija y no satisface imageLoaded.

## TDD y ejecución Root pendiente

Test primero es el RED Android real aportado por Root; worker no simula ese resultado. Tras agregar metadata de diagnóstico, dos pruebas estrechas de programación JS sintética siguen GREEN en board-web-local-image-fixture-green.log. Estas pruebas no prueban decode PNG, Kotlin ni WebView. No se construyó ni ejecutó Android por worker.

Root aplica estos cuatro archivos y reconstruye el APK QA con runner DEFAULT de matriz tras su coordinación de builds. Mantener solo loopback controlado y archivos sintéticos, sin producción. Exigir DOM/canvas/CSS/PNG benignos, control positivo real del motor y cero TCP/UDP/leaks en restricted. Capturar nuevos contadores y policyHash exactos. No añadir proveedores mientras falte matriz completa y revisión de WebRTC/DNS/mDNS/frontera.

Mutación causal exacta para Root después de GREEN: restablecer únicamente blockNetworkImage=true en BoardWebIsolation.kt, dejando diagnósticos y aserciones iguales. Debe recuperar local_image_not_executed. Restaurar el SHA256 congelado de policy y repetir GREEN. Guardar logs nativos mutation-red/restored-green en NativeQA. No retirar aserción ni interpretar constructor RTC rechazado como bloqueo de egress.
