# Decisiones y pendientes

Registro de lo que se decidió al construir el prototipo (2026-10-02) y de lo que no se pudo
comprobar. Cada punto dice qué se hizo; si algo no convence, es el sitio donde cambiarlo.

## Decididas por Ale

| | Decisión |
|---|---|
| Stack | Expo / React Native. |
| Backend | Un servicio pequeño junto a Hermes (`bridge/`) que une sus dos servidores, lleva la bandeja de aprobaciones y manda avisos. |
| Diseño | El sistema del prototipo tal cual; prioridad a la fidelidad visual. |
| Tailscale | Solo se detecta. La app no enciende ni crea ninguna VPN. |
| API server de Hermes | No se toca. Queda documentado cómo habilitarlo. |
| `tailscale serve` | No se ejecuta. Queda documentado. |
| Riesgo de una aprobación | Lo calcula el puente con una tabla fija por tipo de comando (`bridge/src/risk.ts`). |
| Push | ntfy opcional, apagado hasta configurar `RELAY_NTFY_URL`. |

## Donde la app se aparta del prototipo

**Tarjeta "Red privada" (pantalla 01).** Tres estados en vez de dos: `CONECTADA` cuando el puente
reconoce al dispositivo en la tailnet, `SIN TAILNET` cuando el servidor responde por otra vía
(localhost, LAN) y `DESCONECTADA` cuando no responde. Tocar la tarjeta repite la detección. El
texto "ACTIVAR VPN" desaparece.

**Mensajes de "Probar conexión".** Hablan del puente, no de Hermes: `REVISA RELAY_KEY EN EL
SERVIDOR` y `¿RELAYD ACTIVO Y TAILSCALE ENCENDIDO?`.

**Hoja de aprobación (04).** Hermes solo envía el comando y la descripción de la regla que lo
marcó. Las filas `MOTIVO` y `AFECTA` se ocultan cuando no hay dato, que con Hermes real es siempre.
El bloque de riesgo se oculta si la regla no está en la tabla.

**Chat (03).**
- Solo los comandos que fallan tienen bloque de terminal propio. Una sesión real ejecuta decenas;
  todos siguen en el panel de actividad.
- El panel de actividad arranca plegado si el turno ya terminó y tiene más de seis pasos.
- Del markdown del agente solo se interpretan `código` y **negritas**.
- El clip no hace nada (la API de Hermes no acepta archivos). El micrófono tampoco; al escribir se
  convierte en botón de enviar.

**Logs (05).** El panel se queda al final, en las líneas más nuevas. La maqueta estática muestra
las primeras.

**Encabezado de servidor caído (02).** En el prototipo el host y `SIN RESPUESTA` se parten en dos
líneas por falta de ancho. Aquí el host se recorta con puntos suspensivos.

## Pantallas que no están en el prototipo

Hechas solo con piezas que ya existen en él.

- **Bandeja "Aprob."** La pestaña existe en el diseño, la pantalla no. Repite el banner de
  aprobación pendiente de la pantalla 02, uno por aprobación.
- **Lista de servidores.** A donde lleva "‹ Servidores". Reutiliza el bloque de Ajustes.
- **Pantalla de bloqueo.** El logotipo y un botón. Solo aparece en el teléfono con "Desbloquear
  con huella" activo.

## Controles que están dibujados pero no hacen nada todavía

- Selector de modelo y "+ Nueva" tarea (05).

## Avisos

- **Escribir desde el chat continúa la última sesión de ese perfil**, venga de donde venga
  (Discord, CLI, cron). La app no tiene todavía "conversación nueva".

- **"Detener" para el gateway real de un toque**, como en el diseño, sin confirmación. Detenerlo
  apaga también el API server de Hermes, y con él el chat y las aprobaciones.
- **En el navegador la llave se guarda en `localStorage`.** En el teléfono va al llavero
  (`expo-secure-store`). Web es solo para previsualizar.
- **`/v1/logs` entrega `agent.log` con una redacción por patrones.** No se revisó si el log real
  contiene secretos que esos patrones no cubran.
- **El puente lee `state.db` de Hermes** (solo lectura) para el último mensaje y las
  conversaciones.
- **El espacio para grabados está vacío.** El prototipo lo deja para arrastrar imágenes; no hay
  ninguna. Relay asigna ahora un avatar local estable a cada ID de Agente, también fuera de demo
  (2026-10-04); varios Agentes pueden compartir imagen.
- **Icono de la app:** generado a partir de la píldora de tres puntos del logotipo. El archivo
  `Relay Logo.dc.html` del proyecto de diseño no se importó.

## No comprobado

- **iOS.** No se ha visto en ningún iPhone.
- **Android, parcial.** El 2026-10-02 se abrió en un Galaxy S23 (Android 16, Expo Go 57.0.9) por
  USB con `adb reverse`. En modo demo, las seis pantallas, la hoja de aprobación y la bandeja se ven
  como en web: fuentes, brillos, sombras interiores y tramas incluidas. En modo real, con el puente
  escuchando en la IP de Tailscale de la máquina (`RELAY_HOST=100.64.0.10`, sin `tailscale serve`),
  la tarjeta de red detectó el teléfono (`s23-de-ana`), "Probar conexión" dio `CONEXIÓN OK` y
  la lista mostró los tres perfiles. Dos diferencias con web: el código en línea no lleva el fondo
  redondeado (React Native ignora el relleno en texto anidado) y la biometría no se ejercitó.
- **Chat contra Hermes real: comprobado por el puente, no desde la app.** El 2026-10-02 se
  habilitó el API server de Hermes (ver abajo) y un run real por `curl` contra relayd devolvió
  `message.delta` y `run.completed`, y otro mostró `tool.started` / `tool.completed`. Enviar desde
  la pantalla de chat del teléfono queda por probar.
- **Aprobación humana contra Hermes real: sin comprobar.** Hermes está en `approvals.mode: smart`
  (su valor por defecto): un modelo guardián aprueba o niega solo. En dos pruebas aprobó sin
  preguntar `rm -rf` de una carpeta en `/tmp` y `sudo rm -rf /var/lib/<ruta inexistente>`, así que
  nunca hubo petición que llevar a la hoja. Para verla haría falta `approvals.mode: manual`.
- **Toques reales en el navegador.** La automatización dejó de entregar clics a media sesión; los
  flujos se ejercitaron disparando los eventos desde JavaScript.
- **`hermes doctor` y las acciones del gateway** nunca se ejecutaron de verdad.
- **`tailscale serve` y ntfy** nunca se ejecutaron.

## Rastro que dejó la construcción en tu sistema

**API server de Hermes habilitado (2026-10-02, a petición de Ale).** Se añadió
`API_SERVER_ENABLED=true` y una `API_SERVER_KEY` a `~/.hermes/.env`, y una `API_SERVER_KEY` propia
a `profiles/coding/.env` y `profiles/personal/.env`. Cada archivo tiene respaldo al lado como
`.env.bak-relay-20261002`. El gateway se reinició una vez; Discord reconectó. Para deshacerlo:
restaurar los respaldos y `hermes -p default gateway restart`.

**Mensajes de prueba.** Quedaron tres sesiones cortas en el perfil `default` ("Prueba de Relay…").

El agente que hizo el puente, al investigar cómo se autentica el dashboard de Hermes, leyó
`~/.local/state/hermes/gateway-locks/host-serve.token` y lo envió a `127.0.0.1:9119` en seis
peticiones. Todas dieron 401 y Hermes las anotó como `session_rejected` en
`~/.hermes/profiles/coding/logs/dashboard-auth.log`. Nada más se escribió bajo `~/.hermes`.

## Ajustes, bloqueo y decisiones (2026-10-02)

- Ajustes conserva solo los interruptores de seguridad y `autoLockMs` (milisegundos): 0, 60 000,
  300 000 o 900 000. Los ajustes anteriores cargan sin las preferencias de notificaciones y tema.
- El bloqueo al volver del segundo plano usa el tiempo elegido. «AHORA» bloquea incluso con
  cero milisegundos fuera. Los valores positivos también muestran el aviso de ocho segundos del
  lienzo 22b·2 antes de bloquear por inactividad; cualquier toque o «Seguir» reinicia el plazo.
  La Conversación queda montada y oculta durante el bloqueo para conservar sus eventos.
- La hoja empieza con «Permitir comandos similares en este turno» apagado: envía `once`, o
  `session` solo si se activa y está disponible. Rechazar envía `deny`.
- La app muestra «EXPIRÓ SIN RESPUESTA» si y solo si el evento `approval.resolved` declara
  `resolution: 'expired'`. Con `resolution: 'decision'` y `choice: 'deny'` muestra rechazo.
  Si falta `resolution` (Puente anterior), `deny` es rechazo genérico; nunca se infiere una
  expiración por el reloj del teléfono ni por decisiones locales. La causa se conserva cuando
  se observa en vivo o en la repetición SSE; el historial actual no permite reconstruirla tras
  reinicios.
- En demostración, Ajustes permite ver el bloqueo y el aviso. La Conversación de `research`
  muestra una decisión expirada; `dev` conserva la Aprobación pendiente.
- La evidencia independiente de una expiración observada se conserva en memoria por ID de
  Aprobación, aunque no haya una herramienta previa o el historial use otro ID. Una recarga de
  la misma Conversación la conserva; otra Conversación no la hereda. El aviso aparece una sola
  vez, en el paso asociado o en su bloque de comando independiente. Las Decisiones no expiradas
  liberan ese registro independiente. Al terminar un Turno (cancelación, fallo o finalización),
  sus Aprobaciones aún sin Decisión se descartan sin afirmar que expiraron.
- Las decisiones de identidad/selección de la hoja, configuración/visibilidad del bloqueo y
  normalización de ajustes viven en unidades probadas. Pruebas estáticas de delegación comprueban
  los argumentos y props de los componentes sin incorporar un framework de renderizado; no
  sustituyen la comprobación de biometría y visibilidad nativa en el teléfono.
- La carga inicial pasa las dos cadenas guardadas a una función pura, con errores independientes
  para Servidores y ajustes. Los arrays de Servidores conservan sus campos; una cadena corrupta
  o un valor que no sea array da una lista vacía sin descartar los ajustes válidos.
- El reductor del bloqueo recibe configuración y eventos; decide el plazo, la petición inicial
  de huella y las posteriores. El componente ejecuta la petición elegida y consume ese aviso;
  guardar el primer Servidor no pide huella. El selector proporciona las props de ocultación
  sin que el componente añada estilos que las sustituyan. La comprobación nativa sigue pendiente.

## Implementación completa de v1 (2026-10-04)

- El objetivo incluye las entregas pendientes #39–48, la deuda de #19 que siga vigente y la
  documentación. Las funciones de después de v1 siguen fuera del alcance.
- Pausar una tarea programada es libre. Reanudar una tarea e iniciar el gateway piden huella.
- La app y el Puente llevan versiones independientes; el número de compilación Android crece
  en cada actualización. El constructor decide la numeración, separada del protocolo.
- El asistente implementa, revisa, prueba en entornos aislados e instala el APK. Ale valida
  contra Hermes real al terminar. El Puente se actualiza cuando se vaya a probar en el teléfono,
  sin reiniciarlo durante la implementación.

- El cambio de Modo de aprobación se guarda pendiente y se aplica antes del siguiente Turno de
  Relay. La ficha advierte que Hermes puede aplicarlo también a comprobaciones de comandos en
  otros canales que sigan activos. Ale confirmó esta adaptación al contrato real de Hermes
  (2026-10-04).

## Primera prioridad después de v1 (2026-10-04)

- Ale pidió facilitar la instalación de todo en otras computadoras como primera entrega después
  de v1, antes de Actividad. Incluye una instalación guiada de Hermes, Tailscale y el Puente, los
  requisitos, el arranque del Puente, la comprobación de conexión y el emparejamiento del nuevo
  Servidor con Relay.
- El alcance y los sistemas operativos compatibles se concretarán al tomar esa entrega. Esta
  prioridad queda registrada en la sección 5 de `docs/relay-v1.md`.


## Ejecutar ahora y alcance ampliado (2026-10-04)

- «Ejecutar ahora» pide huella siempre. Hermes reactiva la tarea al ejecutarla y no ofrece una
  operación que impida esa reactivación si otro canal pausa la tarea al mismo tiempo. Ale eligió
  huella para conservar la protección exigida al reanudar.
- El objetivo vigente es cerrar v1, preparar una instalación fácil del Puente con un wizard que
  respete el Hermes existente y entregar un APK estable; continuar después con v2. Compatibilidad
  con Windows queda al final si hay tiempo. Este acuerdo sustituye la exclusión anterior de
  trabajo posterior a v1 dentro de la ejecución del objetivo, sin ampliar el corte de v1.
- Los agentes que terminen pasan a la siguiente tarea. Al llegar al 10 % de uso restante guardan
  un handoff con worktree, rama, SHA, cambios, pruebas, decisiones y pendientes para otra sesión.
- Todas las sesiones siguen en GPT-6.1-Sol, con un máximo de diez incluido el orquestador.


## Corte de v2 (2026-10-04)

Ale confirmó todo el horizonte ordenado después de v1 como v2. El alcance y las exclusiones
quedan en [Relay v2](docs/relay-v2.md). La instalación del Puente con wizard conserva la primera
prioridad; las decisiones de seguridad sin ordenar se toman aparte.


## Alcance real de herramientas, memoria y personalidad (2026-10-04)

Ale confirmó usar el comportamiento real de Hermes con la limitación visible en Relay.
Herramientas pueden aplicarse al siguiente Turno del chat de Relay dentro de una Conversación
existente. Memoria y `SOUL.md` pueden entrar cuando Hermes reconstruye el contexto, incluyendo
Conversaciones existentes. Se retira la promesa de aplicación exclusiva a Conversaciones nuevas.
No se modifica Hermes para fijar una versión de configuración por Conversación.


## Avisos privados de v2 (2026-10-04)

Ale eligió ntfy privado dentro de Tailscale. La entrega requiere un servidor y distribuidor ntfy;
la recepción depende de Android, sus permisos y la conectividad. Aprobar abre Relay y pide
huella nueva. Ninguna acción incluye llaves de Relay en enlaces o peticiones de ntfy.
La implementación y sus pruebas usan límites falsos; instalar o modificar infraestructura
de producción se guía por separado.


## Orden posterior a v2 (2026-10-04)

Ale conserva el objetivo anterior y cambia su tramo final. Después de completar v2 se actualiza
el README con capturas de pantalla y una guía de instalación, y se entrega un prompt de setup
para agentes que respete el Hermes existente. Después se comprueba si v3 está definida y lista
para tomar: sesiones de código remotas con terminal y acceso a localhost desde el teléfono.
Si está lista, se continúa con v3; si no, se comienza la compatibilidad. No se toma compatibilidad
inmediatamente después de v2. Este acuerdo sustituye la prioridad final anterior de Windows.


## Tablet dentro de v2 (2026-10-04)

Ale confirmó que el diseño para tablet se completa dentro de v2, antes del README y la guía
posteriores. Incluye distribución para pantalla amplia y revisión de orientación, navegación,
lectura y acciones, conservando las protecciones y la experiencia del teléfono.


## Bifurcaciones queda pendiente (2026-10-04)

Ale decidió dejar la función pendiente después de revisar la limitación de Hermes: el fork
HTTP modifica la original y el historial alternativo no conserva intercambios completos de
herramientas. No autoriza preparar ni instalar una extensión upstream en este trabajo.
Las demás funciones de v2 continúan, incluida Tablet antes de la documentación posterior.
