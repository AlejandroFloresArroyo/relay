# Corrección P1 SPEC · congelada para Root

Base exacta `8d388d0d98f183e02921dbb0a9144756458aad57`; worktree `/home/user/dev/relay-app-v2-kanban-mobile`.
La reproducción original se copió literalmente de `kanban-mobile-spec-repro-source-8d388d0.log`
a la suite antes de tocar código: `kanban-denial-original-red.log` reprodujo título, caché y
referencia retenidos; `kanban-denial-original-green.log` registra los tres retirados.

La denegación terminal se procesa **antes** de descartar la respuesta por visibilidad/permiso.
Retira el cliente exacto en memoria, notifica consumidores montados y bloquea nuevas publicaciones
o escrituras de ese cliente; sigue retirado tras remount dentro del mismo AppProvider.
Un cliente nuevo o de otro Servidor conserva sus datos. La caché y las referencias se purgan
detrás de escrituras nativas ya iniciadas; admisión y purga verifican dueño al ejecutar la cola.
Un aviso retenido en storage no alcanza HTTP después del retiro. Preferencias no privadas intactas.

## Manifiesto residual exacto

Copiar **sólo** estos dos archivos y este handoff:

- `/home/user/dev/relay-app-v2-kanban-mobile/mobile/src/state/work.ts` · SHA256 `792c3618219407cad6a785178b3f1e980a893a6347fb1f3f11f4761f37a22bf0`
- `/home/user/dev/relay-app-v2-kanban-mobile/mobile/tests/components/Work.component.test.tsx` · SHA256 `fab2b2bddce7f1a9e4f6556c6accf1bf4a209bb166adc3cb50033fc0d2822074`
- `/home/user/dev/relay-app-v2-kanban-mobile/docs/handoffs/kanban-mobile.md`

`protocol/kanban.ts` preexistente sin editar, excluir del residual: SHA256 `20b003f851d87cf2da0aa2557d699b2ad2e75d47673c543158b2b7d722ff0db3`.
No se tocó dibujo/tema; migración `76adb4b` pertenece a Root. No DTO, dependencias, README,
commits, ramas, build, APK, gate ni producción. Worktree congelado al guardar este handoff.

## Pruebas y evidencia

- 29 componentes reales GREEN: originales + reproducción exacta + GET lista/detalle/comentarios,
  metadatos, aviso y consulta tardíos; seis casos de credenciales reemplazadas; otro Servidor;
  remount exacto; native writes de caché/referencia retenidos con cero HTTP de aviso.
- 10 pruebas core estrechas GREEN (`kanban`, `kanbanClient`, `demoKanban`).
- Tipos GREEN. Lint de state sin observaciones; suite conserva cuatro warnings de importación
  duplicada que ya existían en HEAD. `git diff --check` limpio.
- Siete mutaciones con **aserción explícita RED**, restauración byte a byte y 29 componentes GREEN:
  `operation-retirement-order`, `read-retirement-order`, `detail-retirement-order`,
  `replacement-owner`, `purge-queue-order`, `native-admission`, `client-retirement`.

Logs ignorados persistentes del worktree: `kanban-denial-original-red.log`,
`kanban-denial-original-green.log`, `kanban-denial-final.log`, `kanban-denial-core.log`,
`kanban-denial-types.log`, `kanban-denial-lint.log`,
`kanban-denial-mutation-<nombre>-red.log`, `kanban-denial-mutations-restored-green.log`,
`kanban-denial-mutations-source.log`, `kanban-denial-mutations-summary.log`.

Límite real: se conserva la API de storage existente (guardado de caché best effort). No se
puede cancelar una operación nativa ya iniciada; se ocultan los datos inmediatamente y su purga
se completa tras esa operación. Las pruebas verifican ese orden con storage sintético.
Root integra y ejecuta revisión/gate; trabajador retoma Compartir en su worktree aislado.

---

# Handoff a Root · Trabajo V2 mobile

Worktree: `/home/user/dev/relay-app-v2-kanban-mobile`, base `27d0468`, rama `feat/v2-kanban-mobile`. Sin commits, cambios de rama, agentes, gate, APK, servicios ni consultas de producción. `npm ci` sólo en `mobile/`, sin nuevas dependencias.

## Resultado

Trabajo por Servidor con cinco columnas manuales, carga/asignación diferenciadas de Turnos, crear, editar/asignar, mover, dependencias sin ciclos y comentarios humanos. Ruta `/work/[server]`; enlace propio `WorkLink` desde Agentes. Mantiene los cuatro tabs principales. **Root debe integrar el selector de Actividad con `WorkLink`; no se editó la pantalla ajena de Actividad.**

Crear y avisar son operaciones distintas. Un rechazo que conserva una Conversación se muestra como resultado parcial y permite abrir únicamente su ID registrado. «Crear y revisar aviso» guarda primero y abre un editor; sólo «Enviar este aviso» llama `/notify`, con el texto exacto, revisión, Agente y requestId del preview. La app nunca llama a `createConversation` ni `startRun` desde Trabajo: esa operación pertenece al backend. La fábrica de demo reutiliza los adaptadores existentes de Conversaciones, Turnos y Pausa general, sólo con datos sintéticos.

Scope real de `useControlScope`: cliente/credenciales, Servidor/dispositivo, elemento y revisiones, foco, background, conexión y LockGate. Se vuelve a comprobar después del storage nativo y después de HTTP. Ni una respuesta vieja ni desbloquear/reconectar restaura un permiso anterior. Sheets inline heredan el ocultamiento de LockGate. El aviso no añade una nueva regla biométrica a la política existente de chat.

Caché fechada sólo para lectura de elementos; detalle, comentarios y avisos ausentes se marcan no disponibles. Revocación oculta los datos y purga caché/referencias tras escrituras anteriores. Se conservan únicamente referencias locales de recibos, sin texto ni envío en cola; se consultan por acción humana. Un resultado incierto o no observado bloquea nuevos avisos. Un 404 de consulta no se interpreta como prueba de que nunca hubo efectos. No hay reenvío automático al iniciar o reconectar.

El transporte reaprovecha auth/protocolo/redirect del cliente existente, limita cuerpo y tiempo, comprueba DTO y vínculo del recibo, sin mostrar mensajes upstream. Pagina un máximo de 500 elementos y 200 comentarios; rechaza páginas mezcladas o incompletas. Título 200, dependencias 16, comentario 4096 bytes, aviso 64000 bytes UTF-8 y JSON 80000. Preferencias reales por Servidor: columna y compacto; compacto automático con 18 elementos.

## Manifiesto exacto

Rutas relativas a `/home/user/dev/relay-app-v2-kanban-mobile`:

Archivos propios:

- `mobile/src/app/work/[server].tsx`
- `mobile/src/core/kanban.ts`
- `mobile/src/core/kanban.test.ts`
- `mobile/src/core/kanbanClient.ts`
- `mobile/src/core/kanbanClient.test.ts`
- `mobile/src/core/demoKanban.ts`
- `mobile/src/core/demoKanban.test.ts`
- `mobile/src/state/work.ts`
- `mobile/src/screens/WorkScreen.tsx`
- `mobile/src/screens/WorkCard.tsx`
- `mobile/src/screens/WorkLink.tsx`
- `mobile/src/screens/DemoWorkStates.tsx`
- `mobile/tests/components/Work.component.test.tsx`
- `docs/handoffs/kanban-mobile.md`

Wiring compartido que integra Root:

- `mobile/src/core/client.ts`: `kanban?` opcional y códigos de error aditivos.
- `mobile/src/core/bridgeClient.ts`: fábrica del adaptador, usa request existente.
- `mobile/src/core/demo.ts`: fábrica/reset y puerto de aviso con Conversación/Turno/Pausa existentes.
- `mobile/src/screens/AgentsScreen.tsx`: importar y colocar `WorkLink` por Servidor.

Diseño complementario (PNG renderizados del HTML, **no capturas de APK/React Native**):

- `design/captures/kanban-v2/README.md`
- `design/captures/kanban-v2/19-11-aviso-editor.html`
- `design/captures/kanban-v2/19-11-aviso-editor.png`
- `design/captures/kanban-v2/19-12-aviso-preview.html`
- `design/captures/kanban-v2/19-12-aviso-preview.png`
- `design/captures/kanban-v2/19-13-recibo-pendiente.html`
- `design/captures/kanban-v2/19-13-recibo-pendiente.png`
- `design/captures/kanban-v2/19-14-recibo-sin-observacion.html`
- `design/captures/kanban-v2/19-14-recibo-sin-observacion.png`
- `design/captures/kanban-v2/19-15-recibo-rechazado.html`
- `design/captures/kanban-v2/19-15-recibo-rechazado.png`
- `design/captures/kanban-v2/19-16-recibo-incierto.html`
- `design/captures/kanban-v2/19-16-recibo-incierto.png`
- `design/captures/kanban-v2/19-17-referencia-local.html`
- `design/captures/kanban-v2/19-17-referencia-local.png`
- `design/captures/kanban-v2/19-18-conversacion-parcial.html`
- `design/captures/kanban-v2/19-18-conversacion-parcial.png`

**Excluir `protocol/kanban.ts` de esta entrega.** Es la copia aprobada ya presente, propiedad de relay-control; no se editó. SHA256 comprobado frente a la copia del instalador: `20b003f851d87cf2da0aa2557d699b2ad2e75d47673c543158b2b7d722ff0db3`. Ningún archivo de instalador editado.

## Verificación y evidencias persistentes

- 13 componentes con AppProvider, pantalla/hook/core y LockGate reales. Dobles compartidos sólo para transporte, almacenamiento, reloj, nativos y navegación. Cero peticiones no declaradas. `cleanupAsync` al finalizar cada prueba evita el solapamiento de desmontajes async del arnés existente cuando hay más de un montaje.
- 24 pruebas Node estrechas: kernel/cliente/demo de Trabajo más regresiones de demo, emparejamiento y protocolo.
- Tipos app, core y componentes: GREEN.
- Lint de archivos propios y wiring: sin errores; único warning preexistente `unavailableChat` sin usar en `bridgeClient.ts:41` (confirmado en HEAD, no corregido fuera del alcance).
- `git diff --check`: limpio. No gate completo; Root lo ejecuta al integrar.

Comandos desde `mobile/`:

```sh
node --test src/core/kanban.test.ts src/core/kanbanClient.test.ts src/core/demoKanban.test.ts src/core/demo.test.ts src/core/pairedBridgeClient.test.ts src/core/protocol.test.ts
npm run test:components -- --runTestsByPath tests/components/Work.component.test.tsx
npm run typecheck
```

Logs ignorados en la raíz del worktree: `kanban-component-final.log`, `kanban-regressions.log`, `kanban-types.log`, `kanban-lint.log`, `kanban-design-render.log`, `kanban-mobile-install.log`.

Ocho mutaciones críticas dieron RED con aserción explícita y se restauraron:

- `kanban-mutation-exact-input-red.log`: texto oculto añadido, rompe igualdad del body.
- `kanban-mutation-late-result-red.log`: quitar guard de respuesta revive un Turno viejo.
- `kanban-mutation-storage-admission-red.log`: quitar guard tras storage emite HTTP después del retiro.
- `kanban-mutation-offline-write-red.log`: quitar fresh habilita crear desde caché.
- `kanban-mutation-revocation-red.log`: desactivar rechazo conserva datos revocados.
- `kanban-mutation-receipt-binding-red.log`: aceptar recibo de otro elemento.
- `kanban-mutation-byte-bound-red.log`: aceptar respuesta mayor al límite.
- `kanban-mutation-timestamp-unit-red.log`: aceptar segundos como milisegundos.

`kanban-mutations-restored-green.log` acredita la restauración. RED iniciales: `kanban-core-red.log`, `kanban-boundaries-red.log`, `kanban-component-red.log`, `kanban-actions-red.log`, `kanban-demo-red.log`, `kanban-demo-ports-red.log`, `kanban-receipt-persistence-red.log`, `kanban-drag-red.log`, `kanban-connection-red.log`, `kanban-notice-limit-red.log`, `kanban-partial-conversation-red.log`.

## Demos y límites reales

En `npm run demo`, abrir Trabajo desde Agentes y usar el selector de estados. 19·1..10 corresponden a columnas, detalle, mover, dependencias, crear, compacto, vacío, cargando, offline y error. Para detalle/crear/mover se interactúa con el elemento, el botón + o la pulsación larga. También hay pendiente, incierto, Pausa general, Conversación registrada sin Turno confirmado, Turno observado/no disponible y respuesta perdida. Los recibos precargados son sintéticos: su botón de Conversación no navega a una sesión inventada. Los avisos ejecutados explícitamente en la demo sí crean una Conversación en la fábrica sintética existente.

Arrastre por PanResponder, pulsación larga y destino medido; soltar fuera cancela. Kernel de geometría y long press/cancelación cubiertos; **gesto físico y fidelidad final en Android pendientes de la verificación APK de Root**. Alternativa accesible: abrir detalle y tocar columna; Bloqueado abre dependencias antes del PATCH. La lista conserva una columna seleccionada y muestra un peek lateral de la siguiente; ese peek es decorativo y la navegación accesible usa el selector de columnas. No hubo pruebas contra el backend en construcción ni Hermes real: integración HTTP final corresponde a Root/relay-control.

## Prioridad vigente de Ale

Conservar v1 + wizard + APK + todo V2. Después de V2: README con capturas verificadas, guía de instalación y prompt setup para agentes. Luego comprobar si V3 está definida y lista (sesiones de código remotas con terminal y acceso localhost desde teléfono); si está lista continuar V3, si no compatibilidad. **No hacer compatibilidad inmediatamente después de V2.** Root coordina el alcance siguiente; no se abrieron sesiones ni se preguntó a Ale.
