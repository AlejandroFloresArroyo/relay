# Auditoría de cierre de Relay v1

SHA revisado: `3784e38715d4be33132d69f23ed22a6f250f9d6a`. Fuentes: `docs/relay-v1.md`, `CONTEXT.md` y código/pruebas del mismo objeto Git. Revisión independiente de especificación, 2026-10-04.

**Resultado: una omisión nueva comprobada.** Los demás bloques tienen implementación. Su existencia y cobertura local no acreditan funcionamiento nativo ni compatibilidad real de todas las operaciones. Los hallazgos y decisiones ya asignados por Root quedan fuera de este informe; «construido» no significa que esas correcciones estén cerradas.

## Omisión nueva

| Prioridad / requisito | Disparador y evidencia | Criterio de aceptación |
|---|---|---|
| **P2 — OMITIDO: avatar automático**, §3.5, especificación L225–226 | Con `DEMO=0`, cualquier Agente recibe `undefined` de `mobile/src/screens/AgentsScreen.tsx:21`. Lista y ficha llaman esa función (L176; `AgentDetailScreen.tsx:60`). `mobile/src/ui/controls.tsx:184–188` dibuja un hueco oscuro sin imagen. Los dos avatares demo ocultan la ausencia. | Asignar automáticamente un avatar a cada Agente real; mantener la misma asignación en sus vistas y al reabrir Relay, sin editor de avatar. Cubrir la variante fuera de demo. |

## Mapa de requisitos y cobertura disponible

Las pruebas citadas son archivos existentes del SHA: no se ejecutó un gate ni se atribuye un resultado verde nuevo a este cierre. Las pruebas de componentes montan pantallas/lógica de la app con límites nativos y transporte sustituidos; las HTTP y de archivos usan Hermes/datos sintéticos.

| Requisito v1 | Implementación | Cobertura disponible / estado |
|---|---|---|
| §2.1 compilación local, firma propia, Relay Dev y actualización | `mobile/app.config.js:8`, plugins `withReleaseSigning.js`, `withTailnetCleartext.js`; `mobile/README.md:143` | Pruebas de plugins/configuración. **Construido; entrega nativa pendiente.** |
| §2.2–2.4 tailnet, Puente sin shell, servicio y ntfy apagado | `core/client.ts`, `withTailnetCleartext.js`; `bridge/src/config.ts:77`, `setup.ts:35`, `exec.ts`, `notify.ts` | `core.test.ts`, pruebas de plugin, `config/setup/execInput/notify.test.ts`. Reinicio del Servidor pendiente. |
| §2.5 QR/manual, llave por dispositivo, expiración, revocación y rate limit | `ConnectScreen.tsx:39,86,143`; `core/pairing.ts`; `bridge/src/pairing.ts`, almacén de dispositivos y CLI | `pairing.test.ts`, `pairingHttp/auth/deviceStore/cli/setup/qr.test.ts`. Cámara real pendiente; decodificador QR externo opcional puede omitir su prueba. |
| §2.5 autodescubrimiento desde un Puente emparejado | `DiscoveryPanel.tsx`; transporte/rutas de descubrimiento del Puente | `DiscoveryLogs.component.test.tsx`, `discoveryHttp/discoveryTransport.test.ts`. Tailnet real pendiente. |
| §2.6 respaldo previo y registro sin contenido | `bridge/src/agentFiles.ts`, `changeLog.ts`, lectores/escritores de perfil | `agentFiles/changeLog/chatChangeLog/agentMemoryHttp/agentToolsHttp/agentDetailsHttp.test.ts`. Correcciones asignadas no se recertifican aquí. |
| §2.7 versiones independientes, aviso y operaciones compatibles | `bridge/src/protocolHealth.ts:3`; `core/protocolVersion.ts:9`, `connection.ts:30` | `protocolHealth/protocolVersion/connection.test.ts`: aviso con operaciones disponibles y aislamiento por Servidor. Número Android pendiente de entrega. |
| §3.1 lista, estados, último mensaje y Conversación reciente | `AgentsScreen.tsx:125,174`; `bridge/src/hermes_conversations.ts`, adaptador real | `hermes_real.test.ts`: último mensaje y última Conversación interactiva; pruebas de chat/almacenamiento. Avatar omitido arriba. |
| §3.2 panel, canales, fondo apagado, CRUD, conteo y búsqueda | `ConversationPanel.tsx`, `ChatScreen.tsx`; `bridge/src/conversations.ts`, lector SQL | `Conversations.component.test.tsx:24–280`, `conversationsHttp/conversationsSql.test.ts`: búsqueda, paginación, conflictos y respuestas tardías. **Construido.** |
| §3.3 detener, redirigir, Markdown y estados de chat | `ChatScreen.tsx`, controlador de Turnos, `Markdown.tsx`; `bridge/src/runs.ts` | `ChatTurn/ChatTransport/ChatVisibility/Markdown.component.test.tsx`, `runs/hermes_real.test.ts`. Redirección real pendiente. |
| §3.3 / §4 modelo por Conversación, catálogo, búsqueda/proveedor y siguiente Turno | `ConversationModelSheet.tsx:81,87,113,146`; `ChatScreen.tsx:533`; `hermes_real.ts:200` | `ChatModels.component.test.tsx:23–73`, `ConversationModelSheet.component.test.tsx`, pruebas de catálogo/runtime. Conservación del modelo actual y atribución separada cubiertas localmente. |
| §3.3 imágenes, reducción, miniatura y límite de petición | preparación/transporte de imágenes, `ChatScreen.tsx`, adaptador de Turnos | `ChatImages.component.test.tsx`, `chatImages/chatPreparation/chatSlots.test.ts`, `hermes_real.test.ts`. Persistencia multimodal real pendiente. |
| §3.3 archivos anunciados, política Hermes, límites, abrir/compartir | `bridge/src/agentFiles.ts`, extractor fijado; componentes/clientes de archivos | `agentFiles/hermesMedia.test.ts`, `ChatFiles.component.test.tsx`. Fuentes públicas fijadas y perfiles sintéticos; abrir/compartir Android pendiente. |
| §3.3 dictado local, idioma, parciales, permisos y modelo ausente | módulo nativo, controlador de dictado y plugin de privacidad | `dictation.test.ts`, `ChatDictation.component.test.tsx`, pruebas del plugin. Audio/red y última palabra requieren teléfono. |
| §3.4 Decisiones, huella, expiración, modos pendientes, reglas y Guardián | `ApprovalSheet.tsx`, `ApprovalsScreen.tsx`, `AgentDetailScreen.tsx`; `runs/decisionStore/agentConfig` | Componentes de Aprobaciones/Decisiones/ficha; pruebas HTTP y persistencia. Escenarios reales de §7 pendientes. |
| §3.5 identidad/modelo readonly, memoria/SOUL, herramientas, skills, uso y caché | ficha y rutas `/agent/[server]/[agent]/*`; lectores/escritores correspondientes del Puente | Componentes `AgentDetails/memory/AgentTools`; pruebas HTTP/core. **Construido salvo avatar; cierres y decisión ya asignados excluidos.** |
| §3.6 Servidores y Administración integrada | `server-admin.tsx:5`; `BoardScreen.tsx:73`; `ServerScreen.tsx:120,121,221,247`; `ServerRows` | `pairedServers/serverRows.test.ts`, almacenamiento y `ServerControl.component.test.tsx`. Administración es alcanzable desde Tablero; no es una pantalla ausente. |
| §3.6 siete Tarjetas, publicación segura, estados, preferencias y acción a borrador nuevo | `screens/board/BoardCardView.tsx:21–27`; `BoardScreen.tsx:82–96`; `bridge/src/board.ts`; `docs/board-publication.md` | `Board.component.test.tsx:12–86`, `board.test.ts`: siete tipos, preferencias por Servidor, preview y envío explícito. Publicación real por Agente pendiente. |
| §3.6 Tareas, historial y campos readonly; pausa, gateway, diagnóstico/logs, uso | `JobsScreen.tsx`, `ServerScreen.tsx`, `UsageScreen.tsx`; módulos Jobs/control/uso/logs del Puente | Componentes `ScheduledJobs/ServerControl/DiscoveryLogs/usage`; pruebas HTTP/core correspondientes. Hallazgos asignados excluidos; mutaciones Hermes reales pendientes. |
| §3.7–3.8 bloqueo, tiempos, vocabulario y recuperación | `LockGate.tsx:71`, `SettingsScreen.tsx`, `ServerConnectionStatus`, clientes de conexión | `LockGate/ConnectionStatus.component.test.tsx`, `lock/connectionStatus/tailscaleButton.test.ts`. Bloqueo y enlace Tailscale Android pendientes. |
| §4 matriz de huella/confirmación/libre; §6 diseño | hojas/controles de cada acción; primitivas y capturas Instrumento | Interacciones de componentes para acciones; **validación visual y biométrica Android pendiente**. Ejecutar ahora sigue el cierre ya asignado. |

## Criterios abiertos de entrega, no omisiones de funciones

| Fuente | Evidencia y aceptación necesaria |
|---|---|
| **#19: chat** | `core/scrollFollowing.ts` y su prueba; `ChatScroll.component.test.tsx:25` cubre envío durante inercia. Verificar en S23 envío estando arriba, seguimiento hasta el siguiente arrastre y posición final tras terminar la inercia. |
| **#19: direcciones y mensajes** | Casos de hostname engañoso en `core/core.test.ts`; estado compartido integrado en Agentes, Servidor y Ajustes. Correcciones presentes. |
| **#19: firma, Metro y servicio** | Plugin de firma reemplaza su bloque al repetir prebuild, conserva otros bloques y rechaza campos faltantes; Relay Dev habilita loopback para Metro; EnvironmentFile preservado deliberadamente con validación de dirección local. Verificar Relay Dev instalada junto a Relay y conectada a Metro, y arranque del Puente tras reiniciar el Servidor. |
| **#19 / §3.7 / §7: teléfono** | Verificar bloqueo al volver después de 1 minuto y aprobación con huella; cancelación, falta de registro biométrico y regreso desde segundo plano deben impedir la acción pendiente. |
| **§2.1–2.7: APK final** | `mobile/app.json:13` no fija `versionCode`. Registrar en el APK final un número mayor que el instalado, certificado igual y actualización por `adb install -r` que conserve Servidores, llaves y preferencias. No inferirlo de `version: 1.0.0`. |
| **§2.5 / §7: QR y conexión** | Escanear QR generado por el comando, probar permiso denegado/manual, expiración/reuso y persistencia; probar descubrimiento real y abrir Tailscale o su fallback. El flujo está construido; cámara no acreditada por pruebas core. |
| **§7: compatibilidad Hermes y uso diario** | Con autorización de Root/Ale, validar operaciones pendientes enumeradas en §7: steer, renombrado/modelos, herramientas, Jobs/historial, pausa/reanudación, reglas/memoria/SOUL y skills; Guardián smart y similares dentro del Turno; imagen/modelo no multimodal; publicación/archivos/búsqueda. La lectura pública y las pruebas sintéticas no sustituyen esta aceptación. |
| **§3.3 / §6–7: experiencia nativa** | Dictado sin salida de audio, modelo ausente sin grabación, última palabra tras soltar; abrir/compartir archivos y comparación visual del APK completo con el diseño. |

No se detectó otra omisión concreta en los focos solicitados. Las secciones de pendientes históricos de la especificación y las notas de integración no son por sí mismas evidencia de ausencia actual. Esta auditoría no inicia servicios, no usa producción, no cambia código y no certifica un APK ni la ejecución de Hermes real.


## Revalidación independiente: Ejecutar ahora — 2231e06

SHA revisado: `2231e0633c89623284b5f548ef8dadbef8e85c02`. Esta nota complementa el corte histórico de `3784e38`; no reinterpreta aquel árbol ni certifica cambios posteriores.

**SPEC: cerrado, sin hallazgos nuevos.** La decisión confirmada por Ale exige huella siempre para «Ejecutar ahora», incluso si la Tarea ya está habilitada, porque Hermes puede reactivarla ante una pausa concurrente (`docs/relay-v1.md` §3.6 L255–257 y §4 L304,314–316 del SHA revisado).

- `mobile/src/screens/JobsScreen.tsx:226` llama incondicionalmente a `action.perform(true, ...)` para cada ejecución admitida; L224 explica la posible reanudación de Hermes. Las Tareas pausadas siguen requiriendo reanudar primero con huella.
- `mobile/src/state/useJobAction.ts:39–56` reserva la acción antes de esperar, obtiene una autorización nueva, comprueba su vigencia después de la huella y envía al ámbito capturado. `confirmWithFingerprint.ts:9–11` exige hardware/registro y biometría fuerte sin PIN como alternativa para la acción sensible.
- Los callbacks de respuesta comprueban vigencia antes de actualizar datos, publicar éxito o recargar. La identidad incluye Servidor, Agente, Tarea, URL, llave y dispositivo (`JobsScreen.tsx:162,177,226`).

Se ejecutaron únicamente las regresiones de componentes relacionadas con run, Tarea pausada y respuesta antigua: **22 pasan, 23 casos ajenos al filtro omitidos**. Montan pantallas, AppProvider, hooks y LockGate reales con límites sintéticos. Cubren ejecución repetida con nueva huella, doble toque, cancelación, falta de hardware/registro, error biométrico, vencimiento, blur/background, bloqueo y regreso, revocación y los seis cambios de ámbito. Las fuentes comprobadas coinciden con el SHA fijo.

El pendiente de construcción/revisión de huella para Ejecutar ahora queda cerrado. Sigue pendiente la aceptación biométrica nativa del APK. No se modificó código, no se hizo gate completo, commit ni operación de producción.
