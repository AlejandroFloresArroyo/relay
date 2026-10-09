# Entrega 42: registro de Decisiones

Implementación lista para revisión independiente, sin commits del constructor.
Base: `2c646fc`; worktree: `relay-app-decisions`; rama: `feat/decision-records`.

Relay muestra pendientes y registro histórico con filtros por Servidor/Agente, persona, Guardián, expiradas, sin atribuir y canal. El historial de otros canales usa solo metadatos estructurados del resultado de terminal de Hermes; se etiqueta la hora del resultado. Un comando ejecutado sin evidencia de consentimiento nunca se presenta como aprobado. Los intentos cuyo resultado no se conoce quedan separados y no se reenvían. Una falla parcial identifica el Servidor afectado y conserva los registros disponibles. Al revocar el dispositivo se descarta el historial en caché.

Aprobar siempre exige biometría fuerte, incluso con la preferencia antigua desactivada. El permiso de comandos similares comienza apagado y solo dura el Turno. Cierre, cambio de identidad/credenciales, segundo toque, expiración y paso a segundo plano invalidan envíos tardíos. El Puente entrega `serverNow` en Aprobaciones; la cuenta incorpora el desfase del teléfono. El registro privado usa reemplazo atómico, permisos 0600, fsync y límite de 16 MiB, sin truncar datos. El adaptador de arranque espera tanto la recuperación como las escrituras pendientes.

## Validación final

- Puente: 142 pruebas verdes de registro, arranque, Turnos, lectura SQLite, HTTP y revocación.
- App: 55 pruebas core verdes; 26 pruebas de componentes Android verdes con AppProvider, transporte y biometría reales salvo límites nativos.
- Tipos Puente/App, lint App y `git diff --check`: verdes.
- Doce mutaciones críticas: aserción roja y restauración verde en elección, huella, desfase, expiración tras huella, revocación tras persistencia, preparación duradera, tope del registro, unidades, actor al expirar, atribución estructurada, replay y redacción. También hubo rojo/verde al corregir filtro de intentos, falla parcial, metadatos contradictorios y espera de la cola al arrancar.

Evidencia duradera: `.scratch/decisions/` (ignorado localmente), especialmente `mutations.json`, pares `*-red.log`/`*-restored.log`, `bridge-final.log`, `core-final.log`, `components-final.log`, `*-types-final.log`, `lint-final.log` y `startup-ready-{red,green}.log`. La primera mutación de unidades falló con TypeError; se reemplazó por una alteración de duración que produjo aserción explícita y luego verde. No se contabiliza el TypeError como evidencia crítica.

## Límites y siguiente paso

- Pendientes de otros canales y denegaciones del Guardián en ellos no son observables; no se inventan.
- El historial importado no prueba el instante del consentimiento ni una correspondencia con IDs de Aprobación de Relay. Solo se atribuyen metadatos exactos del Hermes inventariado.
- El registro lleno falla cerrado; su conservación y respaldo son explícitos, sin eliminar historial automáticamente.
- Puentes antiguos sin `serverNow` conservan desfase cero; la corrección de reloj requiere el Puente actualizado.
- Caché de pantalla durante la sesión; no se persisten comandos de historial adicionalmente en el teléfono.
- Revisión visual DEMO, revisión independiente, integración, gate y APK corresponden al orquestador. No se llamó ni modificó producción.
