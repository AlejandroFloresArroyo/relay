# Relay v2: alcance confirmado

Ale confirmó el 2026-10-04 que v2 incluye todo el horizonte ordenado de la sección 5 de
[Relay v1](relay-v1.md#5-después-de-v1). La entrega empieza al cerrar v1 y su APK estable.
La instalación guiada del Puente tiene prioridad antes de las funciones de v2.

## Instalación guiada

Un wizard repetible comprueba requisitos, selecciona el Hermes existente, prepara el Puente
y guía el servicio y el emparejamiento. Respeta los perfiles, la configuración y el funcionamiento
de Hermes. Linux primero. Después de v2 siguen README con capturas, guía y prompt de setup; luego
se verifica si v3 está definida y lista para tomar, y se continúa con ella si lo está.
Si v3 no está lista, se toma la compatibilidad.

## Entregas, en orden

| Entrega | Resultado esperado |
|---|---|
| Actividad | Bitácora global y consulta del registro de cambios del Puente desde Relay. |
| Avisos | Avisos con la app cerrada y botones; aprobar abre Relay y pide huella. |
| Kanban | Columnas, elementos y cambios de estado con el vocabulario y diseño acordados. |
| Bifurcaciones | Pendiente por decisión de Ale: requiere soporte Hermes para copiar sin alterar la original ni perder historial de herramientas. |
| Presets de personalidad | Guardar y aplicar personalidades, conservando respaldo y registro. |
| Tablero web | Bloque web del Tablero, con límites y aislamiento definidos antes de servirlo. |
| Tema oscuro | Instrumento en claro y oscuro, con selección persistente. |
| Tablet | Diseño y distribución para pantalla amplia, con las acciones del teléfono y validación de orientación, navegación y lectura. Se completa dentro de v2 antes de la documentación posterior. |
| Compartir hacia un Agente | Recibir texto, enlaces e imágenes desde Android y elegir el destino. |
| Widget | Acceso y estado de Relay desde la pantalla de inicio, actualizado solo con Relay en segundo plano o cerrado (decisión de Ale del 2026-10-05; ver «Widget en vivo»). |
| APK desde el Servidor | Descargar una actualización verificable conservando firma y datos. |
| Estado de VPN | Distinguir Tailscale apagado de Servidor sin respuesta mediante datos verificables. |

## Límites y decisiones pendientes

Las decisiones de seguridad que quedaron sin ordenar en v1 no se incorporan automáticamente:
permiso de comandos similares por Conversación, escritura en Conversaciones de otros canales,
modelo por defecto del Agente, descubrimiento sin un Puente emparejado y eventos en vivo de
Turnos de otros canales. Cada una necesita su decisión aparte.

Ale eligió ntfy privado dentro de Tailscale para los avisos (2026-10-04). Relay conserva
la identidad y las acciones de sus avisos mediante una integración Android con el distribuidor;
la instalación y los permisos se guían sin modificar servicios de producción durante la construcción. La definición de cada entrega
debe comprobar qué ofrece Hermes antes de fijar el contrato de implementación. Los ejemplos
de diseño no sustituyen evidencia ni autorizan modificar Hermes o servicios de producción.

La construcción conserva las reglas de v1: pruebas primero, mutaciones de guardas críticas,
revisión independiente, demostraciones, gate y validación nativa. Los estados sin conexión
y revocación deben mantener el comportamiento de protección vigente.

## Continuidad

Hasta seis sesiones además del orquestador, organizadas con Herdr; los modelos por rol están en
`AGENTS.md`. Las sesiones libres toman la siguiente tarea. Al llegar al 10 % de uso restante
guardan handoff con worktree, rama, SHA, cambios, evidencia de pruebas, decisiones y pendientes.
Los builders hacen commit; el merge a `dev` sigue el orden del orquestador.


## Entrega posterior a v2

README con capturas verificadas, guía de instalación y prompt para que otros agentes hagan
el setup respetando Hermes. A continuación se verifica la preparación de v3: sesiones de código
remotas con terminal y un Puente para acceder a localhost desde el dispositivo. Que estas
funciones estén mencionadas no equivale a tener un contrato listo; la comprobación debe
registrar alcance, límites, decisiones y bloqueantes. Compatibilidad se toma si v3 no está lista.

## Bifurcaciones pendiente

El 2026-10-04 Ale decidió dejar esta función pendiente. El fork HTTP actual termina o modifica
la Conversación original; las entradas de historial alternativas pierden metadatos de herramientas.
No se desarrolla ni instala una extensión de Hermes como parte del trabajo actual. La función
no se presenta como terminada mediante un botón deshabilitado; las demás entregas continúan.

## Widget en vivo

El 2026-10-05 Ale decidió cambiar el modelo de privacidad del Widget: muestra el estado en la
pantalla de inicio en tiempo real, también con Relay en segundo plano, bloqueado o cerrado. Antes
se volvía un acceso neutro al salir de Relay. Muestra la misma proyección mínima: alias del
Servidor, hasta tres Agentes con etiquetas restringidas y estado enumerado, contador de
Aprobaciones vigentes y hora de la lectura. Nada de comandos, mensajes ni detalles. «Tiempo real»
significa que se renueva solo (aviso silencioso del Puente o, sin él, cada 15 minutos), no que se
invente estado: cada lectura tiene fecha y, si caduca sin renovarse, dice «sin datos recientes».
Se retira al revocar el dispositivo, quitar el Servidor o reemparejar. El Widget no aprueba nada:
tocarlo sigue pasando por LockGate y la huella. Con un Puente sin `GET /v1/widget` vuelve a ser
un acceso neutro. Detalle en [Widget de Relay](mobile-widget.md).
