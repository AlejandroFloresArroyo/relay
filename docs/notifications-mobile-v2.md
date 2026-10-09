# Avisos v2: módulo Android y UI

Esta entrega consume `protocol/notifications.ts` congelado por Root (SHA256
`8a8b2a817ac9d99b970fd1bfe705f161031ebb9c62ead96b2b955bf771d6f599`).
No modifica el contrato ni el Puente. El backend inicial produce Aprobaciones. Native acepta los cuatro kinds del envelope congelado;
Tareas, Errores y Servidor permanecen deshabilitados hasta que el Puente anuncie sus capacidades.
Los productores pertenecen a relay-memory, no a esta entrega.

## Separación

- `mobile/src/core/notifications.ts`: validación de DTO, protocolo aditivo, cliente y errores sin contenido privado.
- `notificationTransport.ts`: adaptador HTTP exclusivamente nativo, sin fallback a red JS.
- `notificationCache.ts`: ajustes por Servidor/URL/dispositivo; retiro permanente del scope y
  borrado serializado después de escrituras tardías. Nunca guarda comandos, respuestas, endpoints ni llaves.
- `mobile/src/state/notifications.tsx`: reconciliación fuera de LockGate, polling del gesto propio,
  scope y generación de operaciones. Blur, bloqueo, background, desmontaje y cambio de emparejamiento
  invalidan capturas anteriores aunque se vuelva a mostrar la pantalla.
- `mobile/modules/relay-notifications`: módulo Expo Android local descubierto por autolinking.
  El plugin CNG agrega permiso y visibilidad del distribuidor; no se edita Android generado.
- `/notifications/[server]`: preferencias de este teléfono, permiso por gesto, inscripción CAS,
  selección explícita del distribuidor, desactivación y renovación explícita de siete días.
- `/notices/[server]/[notice]`: lectura fresca del aviso, comando, reloj del Puente y Decisión segura.
  La entrada está en Ajustes y conserva las cuatro pestañas existentes.

## Canal y transporte

El usuario configura previamente **ntfy privado dentro de Tailscale** en el distribuidor Android.
Relay enumera distribuidores instalados y no escoge uno silenciosamente. REGISTER usa UUIDv4 privado,
SHARE_IDENTITY desde API34 y PendingIntent inmutable dummy en versiones anteriores. El receptor
exportado valida token conocido, paquete seleccionado y UID instalado; verifica sentFromUid cuando
Android lo proporciona. Un distribuidor que no comparte UID sigue autenticado por el token secreto.
Endpoint cambiado invalida generación e inscripción. Sin endpoint privado válido no se registra el Puente.

La [especificación Android de UnifiedPush](https://unifiedpush.org/developers/spec/android/)
actual es AND_3.1.0 y exige cifrado RFC8291. El contrato congelado publica JSON genérico con
ntfy UnifiedPush; esta implementación es **compatibilidad de ntfy con ese transporte**, no conformidad
completa AND_3.1.0 ni soporte de VAPID. Maneja los cinco broadcasts, límites de token/endpoint/mensaje,
ACK de id y servicio vacío de importancia temporal. No acepta fallback automático a otro distribuidor.
La compatibilidad con los bytes sin transformar se contrastó con el
[código oficial del distribuidor ntfy](https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/up/Distributor.kt)
y su [receptor](https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/up/BroadcastReceiver.kt).
La configuración privada del cliente ntfy y sus logs son responsabilidad de la instalación manual:
Relay no puede inspeccionar ni garantizar la configuración interna de otra app.

Native conserva scopes, tokens, capability y llave en un snapshot privado AES/GCM con AndroidKeyStore,
commit síncrono y fallo cerrado. No registra datos privados. El envelope solo identifica un aviso genérico;
recibirlo no consulta ni persiste su comando. HTTP usa OkHttp ya incluido por React Native, DNS del socket
limitado a IP Tailnet, sin redirects ni retries, buffers y tiempos acotados; revalida scope/keyguard antes
de enviar tras DNS/connect. No hay acciones HTTP de ntfy ni llaves en enlaces o PendingIntent.

## Acciones

Los avisos `task`, `error` y `server` usan su canal y contenido genérico, y solo Revisar.
El nonce conserva kind; tras LockGate abren `/servers`, el destino Relay existente en esta base,
seleccionando explícitamente su Servidor. No consultan `/notices`, no llaman huella de aprobación ni
POST de Decisión. Root puede cambiar el destino a Actividad cuando integre esa ruta, sin ampliar DTO.
El receptor de rechazo además exige kind approval; los genéricos nunca obtienen una acción de rechazo.


Cada notificación de Relay usa canal propio, tag por Servidor/aviso y PendingIntent explícito,
inmutable y nonce privado de un uso en un extra, sin URI ni deep link. RequestCode específico;
una colisión de hash cancela el PendingIntent anterior y falla cerrado, sin cambiar consentimiento. Los nonces son consentimientos propios; enlaces externos o
broadcasts del distribuidor nunca son consentimiento. Con Android bloqueado solo se muestra Revisar genérico.

**Aprobar** abre directamente la Activity de Relay, pasa por LockGate y consulta el aviso.
Después el usuario pulsa **Aprobar con huella**: nueva huella strong sin fallback a código,
segunda lectura fresca, mismo comando/target/inscripción, expiry y última guarda antes de POST once.
Esta decisión conservadora exige un gesto explícito adicional dentro de Relay; Abrir/Revisar no
arrancan huella de aprobación ni deciden por un parámetro de enlace. Un resultado confirmado no se
reclasifica por fallo de retirada local del aviso; la UI muestra el resultado y el fallo local por separado.

**Rechazar** va a receptor no exportado y no necesita foco React. Consume el nonce propio antes de
trabajar; exige dispositivo seguro desbloqueado, scope/generación, gesto de menos de 60 s, lectura
fresca con deny ofrecido, expiry del Puente y guardas después de esperas y antes del socket/POST.
No hay reenvío ni cola cuando vuelve la VPN. ACK opuesto o incompleto nunca confirma rechazo.

Revocación observada por AppProvider elimina acciones, inscripción y caché incluso con escrituras
pendientes. Sin red no puede retirarse atómicamente un aviso ya enviado: es genérico y el Puente
revalida autorización. El reloj nativo usa tiempo transcurrido y boot count; después de reboot incierto
solo Revisar. Desde API26 se aplica timeout visual; API24–25 conservan la guarda del Puente pero
no ofrecen ese timeout de notificación. Android puede retrasar o impedir broadcasts por restricciones,
force-stop, batería o distribuidor detenido. No se promete un servicio permanente ni entrega garantizada.

## Demo y diseño

En DEMO, Ajustes ofrece enlaces a estados sintéticos. Ajustes: configured, all-kinds (capacidades sintéticas anunciadas), unconfigured,
permission-denied, unavailable, revoked, protocol. Aviso: pending, approved, rejected, expired,
uncertain, unknown. Rutas independientes; los datos se exportan también desde `core/demo.ts`.
Referencias Instrumento: `design/captures/notifications-v2/21-9-*.{html,png}` y
`21-10-*.{html,png}` y genéricos seguros `21-11-*.{html,png}`, usando el lenguaje de 21-1…21-4 y tokens/primitives existentes.
Son renders HTML de referencia sintética inspeccionados, **no capturas verificadas del APK**.

## Evidencia y límites

Pruebas estrechas: 10 core/plugin y 26 componentes con AppProvider, NotificationProvider y LockGate
reales. Incluyen huella tardía, foco/background/scope, autolock y unlock, expiry del Servidor,
comando cambiado, elección opuesta, permiso por gesto, CAS/renovación y remontaje offline tras escritura
pendiente y revocación por polling. Ocho mutaciones críticas están restauradas con assertion RED/GREEN.
Tipos y lint propios pasan; autolinking encuentra la clase local. No se ejecutó gate, prebuild ni APK.

Root debe compilar Kotlin e integrar el plugin; esas pruebas no ejecutan el código Android. La validación
sintética nativa pendiente incluye UID/token falso, replay de nonce, keyguard durante awaits, DNS público,
redirect, revocación antes del socket, expiry y ACK ambiguo del rechazo headless, entrega con React cerrado
y fidelidad Tablet/Android. No sustituir esos casos por mocks de componentes ni afirmar éxito real antes
de probarlos. Tampoco se certificó capacidad/pruning del snapshot de nonces ante volúmenes sostenidos.

APIs contrastadas con [Expo Modules](https://docs.expo.dev/modules/module-api/) y la instalación SDK57,
[PendingIntent](https://developer.android.com/reference/android/app/PendingIntent),
[timeout de notificación](https://developer.android.com/reference/android/app/Notification.Builder#setTimeoutAfter(long))
y [acciones protegidas](https://developer.android.com/reference/android/app/Notification.Action.Builder#setAuthenticationRequired(boolean)).
No se añadió dependencia npm/runtime; el módulo compila contra el ReactAndroid ya presente.
