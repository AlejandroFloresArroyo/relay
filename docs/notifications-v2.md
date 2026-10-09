# Avisos propios de Relay por ntfy privado

Ale eligió ntfy dentro de Tailscale el 2026-10-04. El Puente publica un JSON genérico por UnifiedPush;
el distribuidor ntfy Android entrega los bytes a Relay; Relay crea sus cuatro canales Android,
su presentación y sus PendingIntent propios. No usar notificaciones de la app ntfy como UI Relay.
No FCM, Expo Push, proveedor público, acciones HTTP ntfy, llaves/códigos/comandos en payload.

## Contrato fijado para native/UI

`protocol/notifications.ts` es aditivo a protocolo 2. Todas las rutas nuevas requieren
`X-Relay-Protocol: 2` y `X-Relay-Notifications: 1`, además de auth por dispositivo.
No hay fallback de acciones a `/v1/approvals/:id` en Puentes antiguos.

| Ruta | Resultado |
|---|---|
| GET /v1/notifications | Capacidad, preferencias del dispositivo, revisión, inscripción y estado honesto de publicación. Sin endpoint ni llaves. |
| PUT /v1/notifications/registration | Body NotificationRegistrationInput exacto. CAS revision; endpoint del distribuidor en origen privado configurado. Nueva inscripción invalida todos los avisos viejos. |
| DELETE /v1/notifications/registration | Body exacto {schema:1,revision}. Conserva preferencias con enabled=false, retira endpoint y acciones. |
| GET /v1/notifications/notices/:noticeId | NotificationNotice fresco y privado solo al dispositivo inscrito dueño. |
| POST /v1/notifications/notices/:noticeId/decision | NotificationDecisionInput exacto, once o deny; identidad Agente+Turno+Aprobación y inscripción obligatorias. ACK solo confirmado. |

Identidad de app: Servidor local + dispositivo/emparejamiento + registrationId + noticeId;
identidad del comando retenido: Agente + Turno + Aprobación. Nunca Servidor seleccionado/default.
Endpoint UnifiedPush es URL de capacidad privada: conservarlo en almacenamiento privado, nunca logs.
Inscripción dura siete días y se renueva explícitamente desde Relay con CAS. Desactivada por defecto;
preferencias por dispositivo, cuatro tipos, preview genérico. Silenciar no decide ni cambia expiry.
availableKinds informa productores realmente integrados: approval, task, error y server. Los
productores y sus límites están en [Productores de Avisos](notification-producers-v2.md); ninguno
promete avisos de un Servidor caído desde él mismo.
delivery=accepted significa ntfy aceptó publicación, jamás prueba recepción ni decisión.
El mismo canal lleva, desde el 2026-10-05, la señal silenciosa del Widget
`{schema:1,kind:'widget',registrationId}` (`protocol/widget.ts`): sin noticeId, expiry ni contenido;
nunca se muestra ni crea acciones. Solo pide al widget leer `GET /v1/widget`. Ver [Widget](mobile-widget.md).

Aprobar: PendingIntent directo a Activity, explícito/inmutable y específico al aviso; arrancar AppProvider,
desbloquear LockGate, consultar aviso, mostrar comando y huella NUEVA strong/sin código. Solo once;
similares nunca por botón nativo. Foco real+visibilidad+AppState active+alive+scope; generación
invalidada permanentemente por blur/bloqueo/background/unmount/revocación/cambio de emparejamiento.
Revalidar tras huella y última lectura. Abrir/Revisar no consienten ni arrancan huella de aprobar.

Rechazar: PendingIntent propio a receptor no exportado; gesto protegido y Android desbloqueado.
No huella, no necesidad de foco React en headless; nunca aceptar un broadcast ntfy o enlace externo
como consentimiento. Comprobar keyguard/scope/generation tras esperas, límite del gesto 60 s,
sin cola hasta que vuelva VPN ni reenvío automático. Con bloqueo 21-4 solo Revisar genérico.

Puente revalida dispositivo/inscripción/identidad/expiry antes del efecto Hermes, después de la última
lectura/prepare. Usa ledger existente; uncertain no se reenvía. Expiry manda el reloj del Puente;
wire ms, no TTL ntfy inventado: ntfy no ofrece TTL por publicación equivalente a FCM. expiresAt
en envelope y reconsulta obligatoria; cache desactivada. Avisos ya mostrados requieren cancelación
local. Publicar no puede prolongar expiry. Revocación aborta publicaciones pendientes y elimina
acciones del dispositivo. Mensajes ya enviados no se pueden retirar atómicamente de un teléfono
sin red: son genéricos y ya no autorizan POST.

No persistir command/results en el registro de transporte. Preferencias/endpoints se guardan con
archivo privado, respaldo previo y audit sin contenido antes de reemplazar. Guard después de última
lectura y antes del reemplazo; fallos inciertos cierran entrega. Referencias de avisos son efímeras:
tras reinicio del Puente el aviso antiguo es desconocido, no se reenvía Decisión; revisar bandeja.

## Errores y protección de estado nativo

El Puente devuelve ApiError sin contenido privado: 401 sin auth, 403 device_revoked, 426 protocolo,
400 solicitud mal formada, 404 aviso desconocido/ajeno, 409 inscripción/identidad/expiry o
Decisión incierta, 503 configuración/registro no disponible. Consultar el code, no inferir una
causa por texto o convertir el error en éxito. Reintentar una Decisión incierta está prohibido.

El trabajador nativo conserva scope Servidor + emparejamiento + inscripción al recibir el endpoint
y al crear cada PendingIntent; no usa el Servidor activo/default para resolver un aviso.
La revocación observada por polling AppProvider invalida generaciones y elimina inscripción,
avisos, acciones y caché local aun si había escrituras pendientes. No persistir payload privado
del aviso en el almacenamiento de transporte; bloquear/blur/background retira cualquier diálogo
y vuelve inválida definitivamente una huella en curso, aunque se desbloquee antes de su respuesta.

## Reparto

Este worktree: protocol/notifications.ts, servicio/almacenamiento/publicador Puente, rutas HTTP,
fake Hermes, pruebas y guía manual. Root integra main/server compartidos si necesita resolver conflictos.
Otro trabajador: módulo/connector UnifiedPush Android, registro/receptor/Keyguard/actuaciones, cache,
preferencias UI, ruta enfocada, componentes AppProvider+LockGate, demo y canvas. No asumir expo-notifications
ni expo-task-manager; connector/módulo propio puede usar APIs Android sin nuevas dependencias npm.
Connector expuesto para distribuidor es distinto del receptor de acciones no exportado.
UnifiedPush REGISTER/NEW_ENDPOINT/MESSAGE/UNREGISTER y verificación de identidad del distribuidor
según SDK Android (FLAG_SHARE_IDENTITY en SDK 34+, identidad PendingIntent en versiones anteriores); token de conexión local no es llave de Relay. No iniciar servicio perpetuo Relay:
ntfy distribuidor mantiene la conexión, con sus restricciones y aviso permanente.
El origen configurado del Puente debe coincidir exactamente con el endpoint distribuido; redirects
prohibidos y DNS resuelto/pinado a IP Tailnet por el publicador. Sin origen configurado no se envía.

## Wizard manual, sin ejecutar aquí

Guía repetible: `bash scripts/notifications-wizard.sh`. No lee ni escribe configuración;
solo presenta los seis pasos y abre fuentes oficiales cuando la persona lo ejecuta.

1. La persona instala ntfy privado y revisa su versión/configuración; escucha solo en dirección Tailnet,
   sin Funnel/serve público, upstream-base-url, firebase-key-file, Web Push ni integraciones de salida.
2. Configura acceso ntfy manualmente: auth-default-access deny-all y escritura anónima write-only
   para el topic de capacidad UnifiedPush, preferentemente por topic exacto. El ejemplo oficial
   por prefijo es `ntfy access '*' 'up*' write-only`; lectura restringida al distribuidor autorizado.
   La política Tailnet restringe las máquinas que pueden acceder; no poner bearer Relay en ntfy.
   Si no se configura el acceso compatible, mantener entrega apagada.
3. Introduce en configuración privada del Puente únicamente RELAY_NTFY_ORIGIN, un origen
   http(s)://nombre.tailnet.ts.net:puerto sin path, usuario, query ni fragment. No usar RELAY_NTFY_URL
   de v1 para este canal; su publicador antiguo queda sin activar en el nuevo wiring.
4. La persona aplica el arranque/reinicio manualmente conforme al wizard existente. Este trabajo no
   instala, toca servicios, escribe .env ni lee configuración real. No se ejecutan comandos de ejemplo.
5. En Android, instala/configura ntfy con el servidor privado, conecta Tailscale y elige distribuidor.
   Relay recibe endpoint, pide permiso de notificaciones por gesto y registra endpoint + preferencias
   con el Puente. Aún requiere implementación native/UI por otro trabajador.
6. Prueba sintética visible: apagar/reabrir app, bloqueo, expiry, revocación y rechazo con red ausente.
   Sin VPN/permisos/force-stop no prometer entrega. No habilitar uso real hasta revisión y pruebas Root.

Fuentes primarias verificadas:
[UnifiedPush Android](https://unifiedpush.org/developers/spec/android/),
[ntfy UnifiedPush](https://docs.ntfy.sh/publish/#unifiedpush),
[ntfy Android](https://docs.ntfy.sh/subscribe/phone/),
[ntfy configuración](https://docs.ntfy.sh/config/),
[Android Doze](https://developer.android.com/training/monitoring-device-state/doze-standby).
