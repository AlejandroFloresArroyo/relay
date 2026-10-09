# Implementación de Relay v1

Objetivo acordado con Ale el 2026-10-04: completar v1 en `dev`, con revisión, pruebas, APK propio
y documentación. La validación contra Hermes real la hace Ale al terminar; el Puente se actualiza
cuando se vaya a probar en el teléfono. No se llama a producción durante la construcción.

Alcance ampliado por Ale: después del cierre de v1, instalación fácil del Puente mediante un
wizard que respete Hermes existente y continuación con v2.
Ale confirmó todo el horizonte ordenado como v2. Después siguen README con capturas, guía y
prompt de setup; luego se verifica si v3 está lista antes de tomar compatibilidad.

## Entregas

| Ticket | Entrega | Estado |
|---|---|---|
| #37 | Turnos recuperables, redirección y Markdown | Integrada; validación real a cargo de Ale |
| #38 | Modelo por Conversación, búsqueda y proveedor | Integrada e instalada |
| #39 | Imágenes desde cámara y galería | Integrada en el worktree de v1; revisión corregida |
| #40 | Archivos anunciados por el Agente | Integrada; regresión de intercambio de fuente corregida y mutada |
| #41 | Dictado local | Integrada en el worktree de v1; revisión corregida |
| #42 | Registro de Decisiones | Correcciones integradas y revisión independiente cerrada, incluida identidad antes de esperar el registro |
| #43 | Ficha, uso, Modo de aprobación y reglas | Frontera SQL privada y costo desconocido corregidos; revisión independiente cerrada |
| #44 | Memoria y personalidad | Integrada; ambas revisiones cerradas, incluidos modales nativos y resultado incierto tras escritura |
| #45 | Herramientas y skills | Integrada; semántica next_turn aceptada por Ale y ambas revisiones cerradas |
| #46 | Tareas programadas | Correcciones y huella siempre al ejecutar ahora integradas; ambas revisiones cerradas |
| #47 | Pausa general y gateway | Correcciones integradas; ambas revisiones cerradas |
| #48 | Tablero, costo, descubrimiento y logs | Integradas y revisadas; segunda comprobación visual Android cerrada |

## Criterio de integración

Cada entrega incluye pruebas de comportamiento escritas primero, mutación de sus guardas
críticas, revisión independiente, demostraciones para los estados nuevos y gate completo.
Los constructores trabajan en worktrees separados; el orquestador integra y compila.
Las comprobaciones reales pendientes se registran sin presentarlas como realizadas.

## Deuda vigente del primer APK

Se contrasta #19 con el código actual antes de modificarlo: seguimiento al desplazarse,
normalización de direcciones, robustez y verificación de firma y comprobaciones nativas.
Los casos resueltos se retiran de la lista al registrar la evidencia correspondiente.

## Evidencia de implementación

- #19: seguimiento del chat extraído a un reductor; interacción real al enviar durante inercia y
  al terminar el gesto. Quitar el final de momentum rompió la prueba; restaurado, pasa.
- #19: la dirección sin esquema se normaliza por el hostname que interpreta `URL`; las variantes
  con query y barra invertida ya no habilitan HTTP fuera de `ts.net`.
- #19: el plugin de firma sustituye su bloque en prebuild sin `--clean`, conserva otros plugins y
  migra su bloque antiguo. Gradle rechazó propiedades sintéticas incompletas con la lista de
  campos ausentes; el error de Groovy anterior quedó cubierto.
- El dictado compiló en Android después del parche CNG que elimina logs de transcripción de la
  dependencia. Esto comprueba compilación y privacidad del código; la voz real queda a cargo de Ale.
- La falta de biometría ya no desbloquea Relay sin autenticación. Android debe confirmar huella
  o código del teléfono. La mutación que desbloqueaba ante un resultado fallido rompió la prueba.

La revisión de Ajustes y Aprobaciones detectó que el prototipo podía omitir la huella al aprobar;
se corrige con #42 antes de integrar la supervisión. El estado de #19 relativo a Metro y a las
etiquetas de conexión ya tiene implementación anterior: `withTailnetCleartext`,
`ServerConnectionStatus` y `ServerRows`. La precedencia del EnvironmentFile es deliberada y sus
variantes se prueban con datos sintéticos; el arranque valida la dirección local de Tailscale.
Las comprobaciones de teléfono y arranque tras reiniciar el Servidor permanecen pendientes.

- Revisión independiente de #39/#41: se corrigieron la pérdida de imagen entre creación y rechazo
  del Turno, la pérdida de copia al cerrar durante el envío y el dictado detrás del bloqueo.
  Las pruebas reproducen cada transición; la mutación de la guarda de visibilidad vuelve a fallar.
  Los rechazos definitivos liberan su reserva local; los resultados inciertos conservan la copia.
- Revisión independiente de #40: se corrigen la inicialización escondida en lectores upstream,
  la caducidad confundida con archivo ausente y los anuncios `media:` en minúsculas. Los anuncios
  con extensión desconocida que Hermes nunca llegó a extraer no pueden reconstruirse tras borrar
  el archivo; los ya observados conservan el estado ausente mientras el mensaje siga intacto.

- Las 41 pruebas de interacción del chat integrado pasan; el gate completo pasó sus siete pasos.
  La revisión de compatibilidad encontró después una importación del extractor oficial de Hermes
  que los dobles no ejercitaban. Se elimina la importación de inicializadores y se verifican los
  cuerpos públicos fijados con perfiles sintéticos; esta corrección ya está integrada.
- #39: `model_not_configured` y `conversation_busy` también liberan la reserva de imagen al
  rechazar el Turno antes de iniciarlo; ambas reproducciones fallaron antes de la corrección.
- #44: cinco pruebas del núcleo cubren el delimitador completo de Hermes, BOM, whitespace de
  Python, caracteres Unicode, nota exacta y conservación de notas ajenas. Mutar identidad de
  nota y contar UTF-16 rompió las pruebas; restauradas pasan. La lectura y escritura de perfiles
  y las pantallas se están cerrando en su worktree.

## Orquestación en Herdr (2026-10-04)

Ale confirmó continuar la implementación paralela, con un máximo de diez sesiones incluyendo
al orquestador. Cada constructor tiene su worktree; dos sesiones hacen revisión independiente
de especificación y estándares. El orquestador integra, corre el gate y prepara el APK.

Ale fijó Sol 6.1 para todas las sesiones. Toda sesión nueva se inicia con el argumento explícito
`-m gpt-6.1-sol` y se comprueba el modelo antes de asignar trabajo; no hereda el modelo de la
configuración local.

## Integración de supervisión y revisión

- La compatibilidad de archivos ejecuta cuerpos AST originales de Hermes fijados por hash, sin
  importar el gateway. Diez pruebas pasan y el smoke con los archivos públicos completos y
  PyYAML real, en un entorno sintético, conserva intactos los perfiles de prueba. La revisión
  independiente de especificación no encontró problemas nuevos.
- Ficha y Decisiones están integradas con imágenes, archivos y dictado. El gate de `2d9a6d6` pasó siete pasos:
  404 pruebas del Puente, 235 de lógica móvil, componentes, tipos, lint y exportación web. Se
  adaptó la prueba integral de chat no disponible al reloj aditivo `serverNow`.
- La revisión de la ficha detectó que una edición de reglas podía revalidar un modo pendiente
  invalidado por cambios externos, y que algunas reglas heredadas con espacios no se podían
  quitar. Ambas reproducciones fallaron antes de corregirlas; las dos guardas mutadas volvieron
  a fallar y se restauraron. Siete pruebas HTTP quedan verdes. Evidencia ignorada en
  `bridge/agent-details-review-*.log` y `supervision-integration-gate.log`.
- Las tres correcciones de Decisiones quedaron integradas en `3960397`: huella pendiente
  invalidada tras ocultarse, ACK confirmado después de finalizar o limpiar el Turno y repetición
  durable sin reenviar. Pasaron 104 pruebas del Puente, 36 de componentes y doce mutaciones;
  la revisión del parche sigue pendiente.
- Tablero (`f78a9a7`), uso (`9fd4f9a`), descubrimiento/logs (`1149084`), controles (`459b37d`)
  y herramientas (`bf8afd2`) están integrados. Los rangos originales se revisan por separado;
  construir e integrar no equivale a cerrar sus hallazgos.
- Tablero pasó revisión SPEC sin hallazgos y cinco componentes integrados, incluido el borrador
  de una Conversación nueva con envío explícito. Los controles y uso pasan doce componentes.
- Dos regresiones y sus mutaciones comprueban que Pausa general rechaza el Turno antes de aplicar
  un Modo de aprobación pendiente, en HTTP y demo. Los archivos de configuración y la cola
  quedan intactos. Evidencia `server-control-*-order-mutation-{red,green}.log`.
- La regresión de integridad de medios ahora intercepta `Path.read_bytes`. Releer la fuente
  después de verificar el hash rompe una aserción; restaurar el loader deja diez casos verdes.
  Evidencia `hermes-media-changed-source-*.log`; commit `067fc8f`.
- La revisión de estándares detectó lectores SQL separados de `sessions` y apertura por nombre
  tras comprobación de ruta en ficha y uso. Una corrección compartida concentra la frontera y
  comprueba la apertura efectiva; todavía no se presenta como resuelta.
- Siguen en corrección las acciones tardías o confirmaciones visibles tras bloqueo, la parada
  inmediata de Turnos propios, la recuperación desde pausa pendiente, las causas de revocación,
  la redacción multilínea, la cancelación del último consumidor de descubrimiento y la identidad
  del cliente al presentar logs. Cada corrección requiere regresión y revisión independiente.
- Se investiga el alcance real de los cambios de herramientas: Hermes puede releer la selección
  en cada Turno de una Conversación existente. La promesa de aplicación solo a Conversaciones
  nuevas requiere un mecanismo comprobado o una decisión explícita de Ale.
- El gate final combinado, la comprobación visual Android y el APK siguen pendientes.


## Continuidad del objetivo

Cada sesión que termine toma otra tarea asignada por el orquestador. Al llegar al 10 % de uso
restante deja un handoff duradero con estado Git, archivos exactos, evidencias y pendientes.
El orquestador conserva la integración y asigna las revisiones a quienes no construyeron el cambio.


## Corte de cierre al 2026-10-04

- Wizard Linux integrado en `b1814b9`, con revisiones SPEC y Standards sin hallazgos: conserva
  Hermes existente, configuración privada y perfiles. 44 pruebas sintéticas y cuatro mutaciones.
  No se ejecutó una instalación interactiva real ni se modificaron servicios de producción.
- Avatares locales automáticos integrados en `ff3e963` y revisados; identificación estable
  independiente del modelo y del orden de la lista.
- «Ejecutar ahora» quedó cerrado por ambas revisiones en `2231e06`; nueva huella en cada acción
  y retiro de autorizaciones tras bloqueo, revocación o cambio de ámbito.
- Gate de `3f6b112`: siete pasos verdes, 566 pruebas del Puente y 254 de núcleo móvil.
  Los cambios posteriores requieren un nuevo gate final; no heredan aquella certificación.
- Relay Dev compiló e instaló con datos demo. La primera comprobación de Agentes y Tablero
  detectó títulos partidos; la segunda captura de `362ffcc` confirma títulos compactos y chip NUEVA en el pie.
- App 1.1.0/código 2 preparada en `b8152f1`, conservando identificador. El APK firmado final,
  el APK release ya compiló, verificó su firma e instaló con `adb install -r`; la validación real de Hermes sigue a cargo de Ale.
- Las notas cronológicas anteriores describen sus cortes respectivos. Los estados de la tabla
  y esta sección indican los pendientes actuales.

## Cierre de código y APK v1

- Memoria: `289a376` y residual `2f9c10d`, integrado en `60e4eb3`, cerrados por ambas
  revisiones. Guarda local síncrona hasta el reemplazo, modales retirados por bloqueo/foco y
  resultado incierto si se pierde la confirmación después de intentar escribir. Linux/proc,
  bloqueo cooperativo; no se promete CAS frente a editores externos.
- Herramientas: `f2586d1` cerrado por ambas revisiones. Los cambios pueden entrar al siguiente
  Turno de una Conversación existente; memoria y SOUL al reconstruir contexto. Relay muestra
  ese alcance aprobado por Ale y no promete aplicación solo a Conversaciones nuevas.
- Gate sobre `60e4eb3`: siete pasos verdes; 627 pruebas del Puente y 261 de lógica móvil,
  más componentes, tipos, lint y exportación. La corrección posterior de cancelación del gate
  se verifica por separado y requiere otra ejecución completa de integración.
- APK release, sin demo, de `60e4eb3`: Relay 1.1.0/código 2, arm64, 55 034 787 bytes.
  SHA256 `13bd21de9c4d1d73f548fe8df6d137f84bc29f45c74650b000aa62c413726c25`.
  Firma SHA256 `2048c7ed50e4cfaa2e91a95225adbcf82c5f3c3fd76f12b1d81fa697a8e6dd96`,
  coincidente con la instalación anterior. `adb install -r` devolvió Success y Android confirmó
  versión 1.1.0/código 2. No se borraron datos ni se llamó a Hermes real durante estas pruebas.
- Las capturas demo Android verifican Agentes y Tablero. Componentes y compilación no acreditan
  biometría, dictado ni efectos reales sobre Hermes: Q2 lo realiza Ale después de implementar.

## Medición del gate paralelo

Los siete pasos independientes se ejecutan en paralelo y conservan salida ordenada y estado
fallido global. Tres pasadas de `50f9871`: 19,197 / 19,046 / 19,126 s, mediana **19,126 s**
(presupuesto caliente ≤30 s). Con caché de transformaciones Jest ausente: **30,107 s**
(presupuesto frío ≤45 s); dependencias y otras cachés permanecieron presentes. Esto no acredita
un equipo nuevo ni una instalación sin todas sus cachés.

La revisión detectó que cancelar podía dejar procesos de comprobación activos. `baf7ad8`
los coloca en grupos propios, termina y espera esos grupos antes de retirar temporales.
La reproducción falla sin la guarda y pasa tras restaurarla; no se omitieron comprobaciones.

## Decisión posterior de v2

Ale dejó bifurcaciones pendiente al comprobar que Hermes actual altera la original y las
alternativas pierden historial de herramientas. No se prepara ni instala una extensión Hermes.
El resto de v2, incluida Tablet, continúa. Después: README con capturas verificadas, instalación,
prompt de setup y comprobación de preparación de v3 antes de tomar compatibilidad.
El README conserva el enlace de apoyo https://buymeacoffee.com/relayapp.


## Integración final de v1

Las revisiones SPEC y Standards cerraron también el residual de cancelación durante el arranque
(`ba2e950`, integrado en `4487276`): Bash recoge todos sus jobs antes de retirar temporales,
incluso antes del registro de un PID. Cuatro pruebas sintéticas y el repro independiente pasan.
Gate completo de `4487276`: **629 pruebas del Puente, 261 de lógica móvil y los siete pasos
verdes en 20,784 s**. El APK instalado conserva el código móvil de `60e4eb3`; los cambios
posteriores son documentación y el script de verificación, sin cambios en el binario móvil.
V1 queda integrada en `dev`; v2 continúa en su rama separada con revisiones y correcciones propias.
