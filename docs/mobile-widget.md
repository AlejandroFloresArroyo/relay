# Widget de Relay

La extensión Android es local: `mobile/modules/relay-widget`, autolink de Expo y
`mobile/plugins/withRelayWidget.js`. Un receptor privado produce dos `RemoteViews`: compacto desde
140 × 180 dp; amplio al recibir un ancho mínimo de 280 dp. El launcher decide las celdas reales.
Ambos siguen el Servidor elegido en Relay (se recuerda; ADR 0007); todas las instancias comparten ese alcance.
El formato amplio muestra hasta tres Agentes y REVISAR; el compacto centra el contador y su
franja de LED, y abre APROB. al tocarlo. No agrega otros Servidores silenciosamente.

## Estado en vivo (decisión de Ale, 2026-10-05)

El widget muestra el estado en la pantalla de inicio y se renueva solo, también con Relay en
segundo plano, bloqueado o cerrado. Ya no se retira al hacer blur, background, bloquear o cerrar
Relay. Este es el cambio de modelo de privacidad que Ale decidió para el pendiente N1 de v2
([Relay v2](relay-v2.md#widget-en-vivo)); antes, al salir de Relay, el widget era un acceso neutro.

La proyección es la misma mínima de antes y la entrega el Puente en `GET /v1/widget`
(`protocol/widget.ts`): hasta tres Agentes con etiquetas restringidas de 24 caracteres y estado
enumerado, contador de Aprobaciones con vencimiento conocido y futuro, y la hora de la lectura con
su vencimiento. El alias del Servidor y el tema los aporta Relay. No hay comandos, mensajes,
modelos, rutas, identidades de Aprobación ni detalles. Las etiquetas son nombres permitidos, no un
canal de texto libre: las credenciales reconocibles y las etiquetas fuera de formato se sustituyen
por Agente o Servidor, en el Puente y otra vez en el teléfono.

«Tiempo real» significa que se actualiza solo, no que invente estado. Cada lectura dice
**LECTURA** con su fecha y hora. Vence 30 minutos después de leerse, o antes si vence la primera
Aprobación contada. Una lectura vencida no se muestra como actual: el widget dice
**SIN DATOS RECIENTES**, el contador pasa a «—», los Agentes conservan el nombre con el LED
neutro y sin estado, y se ve **ÚLTIMO DATO** con su hora (diseño 21·8).

## Cómo se renueva sin abrir Relay

1. **Empuje.** Cuando cambian las Aprobaciones (nueva, decidida, vencida, incierta) o el trabajo de
   un Agente (Turno iniciado o terminado), y tras un cambio confirmado del gateway, el Puente
   publica `{schema: 1, kind: "widget", registrationId}` por el canal privado ntfy/UnifiedPush de
   los Avisos. No lleva contenido. Se agrupa: como máximo una señal cada 10 segundos, con una
   señal final para los cambios dentro de la ventana. Requiere una inscripción de Avisos activada;
   no depende de las preferencias por tipo. La revocación o una inscripción nueva abortan la
   señal en vuelo, como cualquier aviso. No se reintenta.
2. **Lectura.** El receptor UnifiedPush existente comprueba la inscripción (también que no haya
   vencido su plazo, como para los Avisos) y avisa al proveedor del widget con un broadcast explícito
   a su componente no exportado. El widget pide `GET /v1/widget` sin abrir la UI, mediante
   `PairedRead` del módulo de Avisos. Las señales se agrupan también en el teléfono
   (`RefreshFlight`): una lectura en curso y como máximo una pendiente. Una señal que encuentra ya
   una pendiente se descarta y termina al instante, porque esa lectura empieza después de ella. Una
   ráfaga de señales reentregadas (ntfy guarda los mensajes y el distribuidor los reenvía al
   reconectar) cuesta dos lecturas, y ningún receptor espera más que la lectura en curso y la suya.
3. **Respaldo periódico.** Un trabajo de `JobScheduler` cada 15 minutos (el mínimo de Android),
   con cualquier red. Si una lectura por empuje llegó hace menos de 14 minutos, no consulta. Sin
   cambios, renueva la lectura para que no caduque. Doze puede retrasarlo.

Además se lee al cambiar el Servidor que sigue el widget, al añadir el widget y al primer desbloqueo
tras arrancar el teléfono: el sistema envía `APPWIDGET_UPDATE` a los proveedores con widgets salvo
que la app esté detenida a la fuerza
([`AppWidgetServiceImpl`](https://android.googlesource.com/platform/frameworks/base/+/master/services/appwidget/java/com/android/server/appwidget/AppWidgetServiceImpl.java),
al desbloquear el usuario), y eso vuelve a programar el trabajo; por eso no se pide
`RECEIVE_BOOT_COMPLETED`. Una alarma inexacta (`ELAPSED_REALTIME`, sin despertar el teléfono) vuelve
a dibujar el widget al vencer la lectura; cuenta tiempo transcurrido, así que mover el reloj no la
mueve. Desde API 31 Android puede estirar su ventana hasta 10 minutos; la hora de la lectura sigue
visible. Una lectura con fecha futura (el reloj del teléfono se atrasó) se borra al dibujar: si no,
volvería a ser vigente al alcanzar el reloj su fecha, después de su vencimiento real.

### La llave en segundo plano

La llave del dispositivo ya está en el snapshot privado de Avisos: AES/GCM con una llave de
AndroidKeyStore **sin** autenticación de usuario, reconciliado desde Relay para cada
emparejamiento (fuera de LockGate). Se lee en segundo plano sin huella y también con el teléfono
bloqueado: a diferencia de las Decisiones desde un Aviso, `PairedRead` no exige el desbloqueo. Es
la consecuencia buscada de que el widget se actualice con Relay cerrado. Se eligió esta vía y no
`expo-secure-store` porque la lectura ocurre sin JS y el snapshot ya aplica la validación de
origen `*.ts.net`, el DNS limitado a IP Tailnet, sin redirects ni reintentos, y retira la inscripción
de Avisos al recibir `device_revoked`/`key_unknown`. La llave nunca sale de `relay-notifications`; el widget
solo guarda el destino: Servidor, dispositivo, URL, alias de alcance, etiqueta y tema.

### Cuándo se retira

| Evento | Resultado |
|---|---|
| Revocación vista por Relay (sondeo) | Relay retira el destino; el widget queda neutro al instante, aunque Relay esté bloqueado. |
| Revocación vista por el widget (401/403 de dispositivo) | Borra destino y lectura. |
| Quitar el Servidor o reemparejar | Otro destino: la lectura anterior se borra antes de leer de nuevo. Una lectura en curso para el destino anterior no se guarda. |
| El emparejamiento ya no está en el snapshot | Borra la lectura y conserva el destino. |
| Puente sin `GET /v1/widget` (404) o con otro protocolo (426) | Acceso neutro: «ABRE RELAY / SIN DATOS VISIBLES». |
| Error de red o del Puente | Conserva la lectura fechada; caduca sola. |
| Se quita el último widget | Borra la lectura y cancela trabajo y alarma. |

## Tiempo y desfase de reloj

El teléfono no traduce horas absolutas del Puente: solo usa su duración
(`expiresAt - observedAt`), anclada en el instante del teléfono en que empezó la petición. El
desfase entre las dos máquinas se cancela, y el ancla nunca es posterior a la lectura. Una lectura
con duración nula, negativa o mayor que 30 minutos se descarta. Si el reloj del teléfono retrocede
antes de la lectura, deja de ser actual. Lo comprueba `WidgetReadingTest.java` en la JVM, con el
reloj del Puente una hora adelantado y una hora atrasado.

## Almacenamiento

`noBackupFilesDir`, privado de la variante, `AtomicFile`, como máximo 4 KiB por archivo (el
lector corta en 4 KiB + 1): `relay-widget-target.json` con el destino y `relay-widget.json` con la
lectura en hora del teléfono. Al dibujar se valida de nuevo la forma y el tiempo. No hay promesa de
limpieza instantánea de la caché del launcher si Android mata el proceso: una vista retenida
conserva su fecha explícita.

## Apertura

Los dos objetivos de toque usan `PendingIntent` explícitos al `MainActivity` de la variante,
`FLAG_IMMUTABLE`, `FLAG_UPDATE_CURRENT` e identidad independiente por widget y objetivo. El
intent no lleva URI, comandos, elecciones, autorización ni consentimiento. Solo ID de widget,
objetivo enumerado y alias opaco de alcance. El receptor de apertura comprueba componente,
acción, widget instalado, campos y vencimiento local del pedido; lo consume una vez. Después
`WidgetBridge`, bajo LockGate, comprueba foco y alcance actuales antes de navegar a AGENTES o
APROB. Un toque no abre una hoja de comando ni responde una Aprobación. El intent no es una
credencial y un intent fabricado no concede acceso: el bloqueo, la huella y las guardas normales
continúan. El widget no aprueba nada.

## Código

- Puente: `GET /v1/widget` en `bridge/src/server.ts`; señal en `Notifications.widgetChanged`
  (`bridge/src/notifications.ts`); cambios desde `RunManager.subscribeChanges`.
- App: `WidgetTarget` (fuera de LockGate) entrega el destino; `WidgetBridge` (bajo LockGate) solo
  atiende toques. `mobile/src/core/widget.ts` construye el destino sin la llave.
- Nativo: `WidgetLive` (lectura y `WidgetRefreshJob`), `WidgetStore`, `RelayWidgetProvider`,
  `WidgetReading.java` (decisiones puras), `PairedRead` en `relay-notifications`. La dependencia
  Gradle va de `relay-widget` a `relay-notifications`; el receptor de Avisos nombra al proveedor
  por cadena.
- Permisos: ninguno nuevo. El servicio del trabajo exige `BIND_JOB_SERVICE` (solo el sistema puede
  enlazarlo) y se declara en el manifiesto del módulo.

## Diseño y prueba

Referencia: `design/captures/instrumento-2/21-8.png` y `.html`. Los estados sintéticos están en
`demoWidget.ts`, reexportados desde `demo.ts`: lectura reciente, sin pendientes, sin datos
recientes y sin lectura. En demo: Ajustes → Ver widgets; la ruta de vista previa es exclusiva de
demo. Las vistas React usan `usePalette` y los primitives actuales con los mismos textos del
proveedor nativo. Android RemoteViews usa sus fuentes nativas sans/monospace y un área táctil de
48 dp; no promete la tipografía cargada por Expo ni equivalencia exacta con un launcher no probado.
Las capturas `design/captures/widget-v2/` son diseños HTML anteriores con datos sintéticos, no
capturas de un APK.

Pruebas: `bridge/test/widgetHttp.test.ts` (proyección, autenticación, señal sin contenido,
agrupación, inscripción vencida, revocación en vuelo); `mobile/src/core/widget.test.ts`;
`mobile/plugins/nativeJvm.test.js` con `WidgetReadingTest.java` y `RefreshFlightTest.java`
(agrupación de señales en el teléfono);
`mobile/tests/components/Widget.component.test.tsx` y `WidgetRoot.component.test.tsx` con
AppProvider, LockGate y raíz reales. El Kotlin del lector, el trabajo, la alarma y el receptor solo
se compila; su comportamiento en un teléfono real está pendiente en
[el cierre de v2](audits/v2-closure.md) (paso 9 del guion).

La instrumentación `RelayWidgetLifecycleInstrumentation` probaba el retiro al salir de Relay y se
eliminó con ese modelo. Sigue vigente la corrección del NPE de `MainActivity` (`63d51c0`): la
fábrica de `RelayWidgetPackage` solo construye el listener y obtiene el contexto de aplicación en
`onCreate`; un intent antes de `onCreate` o tras destrucción se rechaza.

Fuentes oficiales: [Expo SDK57](https://docs.expo.dev/versions/v57.0.0/),
[autolinking local](https://docs.expo.dev/modules/autolinking/),
[actualización de widgets](https://developer.android.com/develop/ui/views/appwidgets/advanced),
[JobScheduler](https://developer.android.com/reference/android/app/job/JobInfo.Builder#setPeriodic(long)),
[AlarmManager](https://developer.android.com/reference/android/app/AlarmManager#setWindow(int,%20long,%20long,%20android.app.PendingIntent)),
[PendingIntent](https://developer.android.com/reference/android/app/PendingIntent).
