# Entrega 43: ficha y seguridad del Agente

Implementada en `feat/agent-details`, sobre `2c646fc`, sin commit del constructor.

La ficha muestra identidad/avatar, Servidor, modelo por defecto en solo lectura, uso estimado y
Conversaciones recientes. La fila del Agente conserva la apertura del chat; su avatar en el chat
abre la ficha. Una Conversación reciente abre exactamente su identificador, y el botón
Conversaciones abre el panel del chat. Hay caché local validada y fechada, estados de carga/error,
último conocido en solo lectura y escenarios demo.

Seguridad usa `GET /v1/agents/:id/details`, `POST /approval-mode` y `POST /block-rules`.
El modo queda pendiente, durable, con dispositivo/revisión; solo se escribe antes del siguiente
Turno de Relay. La ficha explica que al aplicarlo otros canales activos pueden notarlo. La
revocación del dispositivo que lo pidió, cambios externos y fallos de retención bloquean la
aplicación. Subir protección y añadir reglas es libre; bajarla y quitar reglas requieren
confirmación y huella Android fuerte. Un prompt pendiente no escribe después de bloqueo,
desmontaje, pérdida de conexión o abandono de pantalla. Las reglas son globs exactos y siguen
activas en Off. La política del Guardián es de solo lectura; cuando no se configuró explícitamente,
se indica «Política predeterminada de Hermes; texto no disponible».

El adaptador usa solo PyYAML del entorno de Hermes, sobre bytes acotados proporcionados por el
Puente. No importa inicializadores de Hermes. Valida directorios por descriptores y no sigue
symlinks/hardlinks; conserva los bytes anteriores en copia privada, sincroniza y registra el
cambio sin contenido antes de reemplazar la hoja autorizada. La revisión y la identidad se
comprueban también después de la retención. El modo Off se escribe como string YAML.
Configuración administrada, referencias externas y estructuras incompatibles quedan en solo
lectura. El uso suma acumulados de Conversaciones según su fecha inicial y la zona del Servidor;
la ficha dice esa limitación y excluye consumo auxiliar. Un fallo de lectura no se representa como
consumo cero.

## Verificación

- 13 pruebas estrechas del Puente: `agentConfig`, `agentDetailsHttp`, `agentUsage`.
- 9 pruebas de componentes, con ficha, AppProvider, transporte y autenticación nativa reales en sus
  límites declarados; 2 pruebas core del validador/cambio de protección.
- Tipos Puente/mobile, lint mobile y `git diff --check`: verdes.
- 15 mutaciones críticas detectadas por aserciones rojas y restauradas: retención, revisión después
  de retención, no-follow, string Off, milisegundos, dispositivo revocado, modo aplicado exacto,
  audit previo, copia anterior, éxito de huella, revisión enviada, visibilidad, fallback biométrico,
  unidades del uso y calendario DST. La primera mutación de revisión era redundante con otra
  guarda; se añadió el caso de edición externa durante retención y se mutó esa guarda. La prueba
  Off ahora exige explícitamente que la escritura no rechace.
- Detector mecánico de interfaz: sin hallazgos. Inspección visual Android, revisión independiente
  y gate completo corresponden al integrador.

Evidencia durable e ignorada en este worktree: `agent-details-bridge-final.log`,
`agent-details-cache-red.log`, `agent-details-cache-green.log`,
`agent-details-mutations.log`, `agent-details-mutations-followup.log`,
`agent-details-mutation-*.log`, `agent-details-policy-red.log`,
`bridge/agent-details-types.log`, `mobile/agent-details-red.log`,
`mobile/agent-details-green.log`, `mobile/agent-details-components-final.log`,
`mobile/agent-details-types.log`, `mobile/agent-details-lint.log`,
`agent-details-design.log`. El manifiesto exacto de rutas está en `agent-details-files.log`.

## Integración y límites

- Entradas de entregas 44/45: `/agent/[server]/[agent]/{memory,soul,tools,skills}`, parámetros
  `server` y `agent`. Sus rutas aún deben incorporarse en la integración; no hay páginas temporales
  que se presenten como funciones terminadas.
- Cambios compartidos con 40/42/44: opciones `hermesMediaSource/hermesMediaPython`, fábrica
  RealHermes, rutas de servidor, esquemas de auditoría, cliente/demo y helper biométrico. Conservar
  ambos comportamientos al integrar. No aumenta la versión de protocolo por estos endpoints
  aditivos.
- El texto predeterminado efectivo del Guardián no está verificado: se declara indisponible en vez
  de inferirlo. El uso diario no reconstruye consumo ocurrido hoy en una Conversación antigua.
- Ninguna llamada a Hermes real, Puente de producción, secretos, servicios ni teléfono.
