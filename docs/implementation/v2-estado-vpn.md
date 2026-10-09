# Estado de VPN: red predeterminada de Relay

Relay observa únicamente su propia red predeterminada Android. No descubre ni configura VPN,
no identifica al proveedor y no consulta estado interno de Tailscale. Un timeout no demuestra que
el Servidor esté caído. No se añaden dependencias, servicios, pestañas ni productores de fondo.

## Fuentes primarias fijadas

- Android Connectivity `android16.0.0_r2`, commit
  `627eb3c63e7c7cb3cb9f8ea319e4bb1676079c3a`: [ConnectivityManager](https://android.googlesource.com/platform/packages/modules/Connectivity/+/627eb3c63e7c7cb3cb9f8ea319e4bb1676079c3a/framework/src/android/net/ConnectivityManager.java)
  y [NetworkCapabilities](https://android.googlesource.com/platform/packages/modules/Connectivity/+/627eb3c63e7c7cb3cb9f8ea319e4bb1676079c3a/framework/src/android/net/NetworkCapabilities.java).
- Tailscale Android, commit público `6d63d3e29a1d1f9710f78863a91cc76b39ea2f9a`:
  [manifest](https://github.com/tailscale/tailscale-android/blob/6d63d3e29a1d1f9710f78863a91cc76b39ea2f9a/android/src/main/AndroidManifest.xml),
  [IPNService](https://github.com/tailscale/tailscale-android/blob/6d63d3e29a1d1f9710f78863a91cc76b39ea2f9a/android/src/main/java/com/tailscale/ipn/IPNService.kt)
  y [MainActivity](https://github.com/tailscale/tailscale-android/blob/6d63d3e29a1d1f9710f78863a91cc76b39ea2f9a/android/src/main/java/com/tailscale/ipn/MainActivity.kt).
  El servicio es privado; no hay aquí una API pública de lectura de su estado. Su actividad admite
  `tailscale://navigate`, reutilizada sólo al pulsar «Abrir Tailscale», sin conectar/desconectar VPN.

`vpn-primary-source-manifest.log` conserva hashes de los bytes públicos consultados. Android documenta
que `getActiveNetwork` puede devolver null si no hay red o está bloqueada para quien consulta; eso
no prueba VPN apagada. El callback predeterminado corresponde a la red usada por Relay, que puede
ser distinta de la de otras apps. `TRANSPORT_VPN` no identifica Tailscale; `NOT_VPN` sólo descarta
VPN en esa red. Una VPN puede coexistir con transports físicos y excluir apps.

## Contrato nativo congelado

`mobile/src/native/vpnContract.ts`, SHA-256
`3c4ab68da957f810f25d72b513dacf04f87354d6202b52271115d3b6c38c6b7a`.

Snapshot y evento tienen exactamente `version:1`, `scope:'relay-default-network'`, `generation`,
`sequence`, `vpn` y `reason`. No incluyen IP, SSID, identificadores de red, nombres de paquete ni
credenciales. `observe(generation)` registra y devuelve snapshot; `snapshot(generation)` lee;
`stop(generation)` sólo retira esa generación; `onNetworkChanged` es la suscripción.

| vpn | Evidencia y límite |
|---|---|
| available | Capabilities de la red actual: `TRANSPORT_VPN` y no `NOT_VPN`. No prueba proveedor, Internet ni acceso al Puente. |
| absent | Capabilities de la red actual: `NOT_VPN` y sin `TRANSPORT_VPN`. No prueba que todas las VPN estén apagadas. |
| unknown | Sin red predeterminada accesible, bloqueo, transición, capacidades ambiguas, error, módulo ausente o app inactiva. |

Sólo se usan APIs públicas y el permiso normal `ACCESS_NETWORK_STATE`, ya utilizado por Expo.
El plugin local lo conserva idempotente, sin privilegios ni servicio VPN. Android >=24 permite el
callback predeterminado; versiones anteriores quedan unknown. El snapshot consulta red/capabilities
fuera de callbacks y comprueba nuevamente la identidad de red. Los callbacks usan sus argumentos;
no hacen consultas síncronas que puedan competir con el estado entregado por Android.

Al aparecer una nueva red, la lectura anterior pasa a unknown. Los callbacks de capabilities esperan
el estado explícito no bloqueado, disponible desde Android 29; antes de esa versión un snapshot
público puede verificar capabilities, pero una transición posterior puede quedar unknown hasta la
siguiente observación. Esta limitación conservadora no diagnostica VPN apagada.

## Estado y UI

AppProvider usa el hook real: al background, blur, cambio de Servidor, cliente emparejado o refresh
retira la generación y deja unknown. El scope de render evita devolver una lectura de otra
configuración; promesas y eventos retirados no modifican el nuevo scope. Un número de secuencia
menor o igual no sobrescribe un evento posterior. Módulo/emisor ausente o error queda unknown.

El panel existente `ServerConnectionStatus` sólo refina causas desconocidas. Revocación, llave,
dirección/política HTTP y otros errores conocidos conservan su acción. El aviso de protocolo
sustituye el diagnóstico desconocido. Una respuesta pública vigente del Puente prevalece incluso
si la carga privada falla. Un Servidor alcanzable no muestra el panel offline.

- absent: «SIN VPN PARA RELAY», explica el alcance y ofrece Abrir Tailscale/Reintentar.
- available sin respuesta: «SERVIDOR SIN RESPUESTA», dice VPN activa para Relay, sin proveedor,
  y que no se conoce si falla el Servidor o la ruta; ofrece Reintentar.
- unknown: «SIN RESPUESTA», declara que no pudo comprobar la VPN y conserva las pistas/reintento.

Se reutilizan Panel, Led, M, T y controles/tokens Instrumento. Referencias originales 15·5 y 08b·5;
los tres estados tienen HTML/PNG propios en `design/captures/instrumento-v2-vpn/`, renderizados
sin red desde fuentes locales. Son referencias de diseño, no capturas Android verificadas.
Las demos `offline_vpn_available`, `offline_vpn_absent`, `offline_vpn_unknown` se seleccionan
con el control «Demostración… · Cambiar» ya existente en Agentes, sin Servidor.

## Verificación y límites de entrega

RNTL monta AppProvider, hook, clientes y panel reales con límites compartidos fake. Cubre acciones,
precedencia, eventos/snapshots tardíos, background/blur, cambio de Servidor y reemparejamiento,
envelopes inválidos y fallo nativo. Seis mutaciones conductuales registran RED y restauración GREEN;
plugin/autolinking usa Expo instalado y manifest sintético, sin ejecutar Gradle.

El constructor no ejecutó APK/Gradle; Root aportó después el PASS Android y los cinco controles
causales documentados al final. Esa fixture verifica el observador con límites sintéticos, sin leer
conectividad real. El módulo sirve al panel común de Servidores; los estados específicos de un Turno
cortado y del emparejamiento siguen sus flujos actuales. Notificaciones/widget podrán reutilizar el
DTO sólo con su propio ciclo de vida; no se integra ningún productor ni se promete entrega en fondo.

Prioridad vigente: Tablet v2 antes de README/capturas verificadas/instalación/prompt; después V3 si
ya está definida/lista y, si no, compatibilidad. Bifurcaciones queda pendiente por decisión de Ale.


## Runner Android aislado de ciclo de vida

La fixture única `RelayVpnLifecycleInstrumentation`, en el `androidTest` del módulo local,
ejerce el observador `VpnObservation` que utiliza el módulo de producción. No duplica su
clasificación, retiro ni guardas: sustituye sólo el límite Android de registro, lectura de red y
acceso a `NetworkCapabilities`. El adaptador de producción conserva `ConnectivityManager` y
los accesores Android reales. El DTO, el contrato JS y el comportamiento de UI no cambian.

El runner sólo admite un paquete de prueba/desarrollo terminado en `.test` o `.dev`. No arranca
una Activity, no obtiene un manager real, no consulta endpoints, no modifica VPN/conectividad y
no crea servicios. Usa el Looper principal y callbacks `NetworkCallback` reales con datos
sintéticos. Los objetos Network se crean con Parcel/CREATOR; su formato de un entero está
verificado en [AOSP Connectivity `13e5a48cb748cedc3af397fca0d62324292dec7e`](https://android.googlesource.com/platform/packages/modules/Connectivity/+/13e5a48cb748cedc3af397fca0d62324292dec7e/framework/src/android/net/Network.java).
Esta codificación queda limitada a la fixture, sin sockets, DNS ni lecturas de redes existentes.
NetworkCapabilities vacío requiere [API 30](https://developer.android.com/reference/android/net/NetworkCapabilities#NetworkCapabilities());
por ello el runner exige Android 11+, sin elevar el mínimo del módulo de producción. Los flags
se inyectan en sus accesores porque el SDK público no ofrece setters de capacidades; no se usa
reflexión ni API oculta.

Comprueba snapshot inicial y secuencia, red ajena ignorada, bloqueo, retiro y refoco, callback
viejo incluso al reutilizar generación, stop/snapshot de generación ajena, callback encolado antes
del retiro, background, ausencia de Activity, destrucción y fallo de registro parcial. Los eventos
sólo pueden contener los seis campos permitidos y nunca la excepción sintética del límite Android.
Cada salida limpia los listeners sintéticos. Blur se prueba como `stop(generation)`, la operación
que invoca el hook JS existente; no se afirma un callback nativo de foco de ventana ni se añade
uno. La interacción Android de foco completo sigue pendiente de la verificación física de Root;
los componentes reales conservan la cobertura JS de blur/refocus y retiro de suscripciones.

Root puede compilar `:relay-vpn-status:assembleDebugAndroidTest` y ejecutar el runner configurado
`expo.modules.relayvpn.RelayVpnLifecycleInstrumentation` en su paquete nativo aislado. Debe
verificar el nombre Gradle y paquete efectivo al integrar. El éxito esperado es
`Relay VPN lifecycle checks passed.`; un error de instalación/compilación no cuenta como RED causal.
El constructor no ejecuta Gradle, APK, ADB ni afirma resultados nativos.

Diseño de las mutaciones de plataforma, una por vez y con restauración exacta:

| Guarda retirada | Aserción causal esperada |
|---|---|
| Identidad `callback === this` en accept | Un callback reemplazado publica al reutilizar generación. |
| Recheck completo dentro de post, ejecutando action sin guarda | Un callback retirado publica después de refoco o stop. |
| Propietario `requested == generation` de stop | Un stop viejo retira el listener vigente. |
| Unregister de retire | El conjunto de listeners conserva un registro al blur/background. |
| Rechazo de snapshot de generación ajena | La lectura vieja consulta Android y devuelve estado de la generación vigente. |

Para cada mutante se exige la aserción RED del APK de prueba, restaurar los hashes de entrega,
recompilar y registrar GREEN con el mismo runner. Root cerró esos cinco resultados en la evidencia
nativa siguiente; no se confunden con las pruebas host del constructor.
Las pruebas Node de VPN/plugin, los 15 componentes VPN y tipos/lint móviles sólo verifican sus
límites respectivos; no sustituyen compilación Kotlin, wiring Expo ni conectividad del sistema.


## Evidencia Android de Root: S23 / SDK 36 y cierre de cinco controles causales

Root aportó ejecución en Samsung Galaxy S23 con Android SDK 36. El control del runner QA
`vpn-lifecycle-qa-v1`, versión 1, obtuvo **PASS de framework Android**: variante `control`,
`relayQaStatus=PASS`, `relayQaCheck=NONE` y `INSTRUMENTATION_CODE=-1`. Esto registra un resultado
actual de la fixture en ese dispositivo, no una simulación Node ni sólo compilación Kotlin.
Esta actualización de documentación no ejecutó build, APK, ADB ni pruebas en el teléfono.

La copia QA del runner conserva `VpnObservation` de producción y sus aserciones; añade un
reporter sólo de prueba que distingue `CheckFailure` de excepciones ajenas y preserva el fallo
causal durante cleanup. Una caída, bootstrap fallido o `ERROR/UNEXPECTED` no cuenta como RED.
Cada RED siguiente tiene la variante compilada exacta, `CHECK_FAIL`, el código indicado y footer
`0`; después, un control restaurado da `PASS/NONE`, variante `control` y footer `-1`.
Los diez logs causales contienen diez run IDs distintos; el parser valida los seis campos únicos,
versión/fixture, variante/run ID y footer único. No se publican run IDs ni serial del dispositivo.

| Variante | Guarda retirada en el APK de prueba | RED exacto | Control restaurado |
|---|---|---|---|
| `callback_identity` | Identidad `callback === this` de `accept`, incluso al reutilizar generación. | `CALLBACK_REPLACED` | GREEN `PASS/NONE/-1` |
| `queued_guard` | Recheck dentro de `post`, dejando ejecutar una acción encolada retirada. | `CALLBACK_RETIRED` | GREEN `PASS/NONE/-1` |
| `stop_owner` | Propietario `requested == generation` de `stop`. | `STOP_OWNER` | GREEN `PASS/NONE/-1` |
| `unregister` | Unregister del listener en `retire`. | `BLUR_CLEANUP` | GREEN `PASS/NONE/-1` |
| `snapshot_owner` | Rechazo de generación ajena antes de consultar el snapshot. | `SNAPSHOT_OWNER` | GREEN `PASS/NONE/-1` |

Las fuentes originales de `54685d814aa39348721e80c874dc299695b963f4` están restauradas byte por
byte después de las cinco mutaciones. SHA-256 comprobados en el worktree y en la revisión de Root:

- [RelayVpnStatusModule.kt](../../mobile/modules/relay-vpn-status/android/src/main/java/expo/modules/relayvpn/RelayVpnStatusModule.kt):
  `2daec7539d6a93e3ad3bab43648df4bf04c3f90474ec0491f3c5f2c88de82b3c`.
- [RelayVpnLifecycleInstrumentation.kt](../../mobile/modules/relay-vpn-status/android/src/androidTest/java/expo/modules/relayvpn/RelayVpnLifecycleInstrumentation.kt):
  `e57ff8d1967f11748b6ed24f1d717c5535f95abb2ce412c62b793397fdfd424f`.
- Helper separado de NativeQA `native-qa/vpn-native-qa.mjs`, generador/parser sin aplicación
  automática de cambios: `2b44195eabd9e4b14853e851d7629b9ee769587b4c17269324122ee6a38d7dc0`.

Root conserva los APK y la evidencia ignorada en el worktree NativeQA. El resumen
`vpn-native-causal-device-*-summary.log` tiene SHA-256
`72fb69f7c25b9fbcab1b4ed6074f3869b77900c4fb4f4310f89492a1745621a5`.
Registra control inicial APK `97343ed86e62dbfad3a5788777267ca03297b05f24974df876355348015421e1`
y los cinco controles restaurados APK
`a990164a590dd8e35c28872ea29fbe47e40f27738dd36b6c2f4cc6d092fb5aff`, además de los APK mutantes.
`review-vpn-native-causal-fixed-evidence.log`, SHA-256
`0f496f91df0bc7e279f50870b78694a37aa1431b16b559bd169fe4f09972f1d8`, fija los hashes de los diez
logs crudos. La revisión independiente `review-vpn-native-causal-closure-standards-security.log`,
SHA-256 `8d3b18599f69125419a26842ea65eabc1bdf1676e53df7bd8fc792f4c5f60959`, cierra las cinco
mutaciones con cero hallazgos nuevos de Standards/seguridad. Los hashes identifican los artefactos;
la procedencia de instalación/ejecución y su asociación al APK siguen siendo responsabilidad de Root.

**Frontera probada y límites:** son reales `VpnObservation`, Handler/Looper, los objetos Android
Network/NetworkCapabilities y los callbacks NetworkCallback. Son sintéticos el puerto de
registro/unregister, la lectura de red y los accesores de capacidades, así como la presencia de
Activity. La fixture no obtiene un ConnectivityManager real ni arranca una Activity. Por ello
no lee el estado real de VPN ni consulta Tailscale, Tailnet, Servidores o endpoints; no modifica
conectividad ni requiere autorización privilegiada. El retiro por blur se ejerce mediante `stop`,
no mediante un gesto físico de foco de ventana. El resultado no valida por sí solo el wiring Expo
completo, otras versiones Android/proveedores, una ruta real al Puente ni todo v2. Se mantienen
los límites de API, el estado `unknown` conservador y la verificación física de foco pendiente.
