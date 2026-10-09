# Presets de personalidad en Relay

El catálogo de un Servidor se abre desde **Personalidad → Gestionar presets del Servidor**
o desde **Conversación → Personalidad → Gestionar presets del Servidor**. Su ruta es
`/presets/[server]`. En tablet conserva la navegación de Servidores y un ancho de lectura
acotado; las hojas se centran y no superan 620 puntos.

## Catálogo y versiones

La lista trae únicamente metadatos, hasta 64 presets. Abrir uno lee la revisión inmutable
que se eligió. Crear y editar guardan una versión; no cambian un Agente ni una Conversación.
SOUL admite hasta 1 MiB y una capa de Relay hasta 64 KiB, medidos en UTF-8. Borrar exige
confirmación libre; las versiones ya fijadas en Conversaciones se conservan. La UI no
muestra éxito antes de recibir y validar el ACK del Puente.

Un conflicto o resultado incierto exige **Recargar**, descarta el borrador y no reenvía la
operación. Cerrar el editor no habilita otra escritura con la lectura antigua. Los errores
libres del Servidor no se muestran: se conserva el diagnóstico conocido de revocación,
llave rechazada, HTTP bloqueado por Android o incompatibilidad.

## Reemplazar SOUL

**Aplicar preset SOUL** muestra el contenido completo anterior y el reemplazo, con las
revisiones exactas de ambos. Antes de solicitar una huella nueva, se vuelve a consultar esa
vista previa. Después de la huella fuerte de Android se consulta otra vez; cualquier cambio
exige revisar la nueva vista previa y confirmar de nuevo. La escritura pasa exclusivamente
por `useAgentDocument.write`; no existe otro escritor ni se reutiliza una huella anterior.
El Puente conserva respaldo y auditoría. Hermes puede aplicar los cambios al reconstruir
el contexto, incluso en esta Conversación.

Alcance de la huella: se comprueba solo en el teléfono, no en el Puente. «Reemplazar con huella»
protege contra quien use el teléfono desbloqueado, no contra un dispositivo comprometido: un
dispositivo emparejado con su llave puede llamar al PUT de aplicar sin huella. Es el mismo modelo
que la edición de `SOUL.md` y las Aprobaciones; el contrato de v2 no promete verificación en el
Puente.

Si el PUT de aplicar falla sin una respuesta definitiva del Puente (sin red, tiempo agotado, 5xx),
la app lo muestra como `personality_uncertain`: el SOUL puede haberse reemplazado, no se reenvía
y hay que recargar. Solo los rechazos anteriores a escribir (400, 401, 403, 404, 409, 426, 429)
conservan su propia causa.

## Guardar SOUL actual como preset

**Guardar SOUL actual como preset**, en la pantalla Personalidad del Agente, abre una hoja con
el nombre del preset y el SOUL que se está mostrando, con su revisión. Guardar crea un preset
SOUL en el catálogo del Servidor con ese texto exacto, fijado a la revisión del catálogo leída
al abrir la hoja. No cambia el SOUL de ningún Agente, así que no pide huella. Si `SOUL.md` no
existe o la lectura es de caché o de solo lectura, el botón queda desactivado. Un fallo muestra
su causa conocida y bloquea otro envío desde la misma hoja: hay que cerrarla y abrirla de nuevo.
No hay diseño propio en `design/captures/`: usa la hoja, el contenido y los controles de esta
misma pantalla.

## Capa de una Conversación

El control **Personalidad** vive junto al título y el modelo de la Conversación. La selección
fija una versión inmutable para los siguientes Turnos, conservando historial, modelo y Turno
actual. Durante un Turno la confirmación dice explícitamente que sólo afecta al siguiente.
**Sin capa extra de Relay** hereda la configuración del Servidor, que puede incluir
`system_prompt` y `personality` de Hermes; no significa usar únicamente SOUL. Las Conversaciones
de otros canales son de solo lectura y no consultan ni aplican presets privados desde ese control.

## Retiro y límites

Un bloqueo de Relay, paso a segundo plano, pérdida de foco, desmontaje, cambio de cliente, emparejamiento,
Servidor, Agente o Conversación invalida de forma permanente el intento anterior. Se retiran
por completo las hojas y su contenido. Las comprobaciones nativas anteriores a la huella
aceptan una guarda opcional; no abren un prompt después de perder autorización. Un ACK tardío
no publica contenido ni éxito en el destino nuevo. Esto no deshace un efecto ya admitido por
el Puente; la seguridad de esa escritura corresponde también a sus comprobaciones y recibos.

Los datos nuevos de presets permanecen únicamente en memoria y en su contexto. SOUL conserva
el almacenamiento ya existente del lector/escritor de documentos. Los métodos del cliente son
opcionales para Puentes anteriores; una ausencia produce un aviso de indisponibilidad.

## Demo y diseño

`core/demoPresets.ts`, exportado desde `core/demo.ts`, ofrece catálogo, creación, edición,
borrado y versiones fijadas, además de vacío, carga, offline, error, revocación, conflicto,
incertidumbre, límite, SOUL cambiado/protegido, huella rechazada y Turno en curso/otro canal. Las hojas y el
catálogo incorporan controles de escenario DEMO; no necesitan un Servidor real.

La fuente [`personality-presets.html`](../design/source/personality-presets.html) y los 26
pares PNG/HTML de [`design/captures/personality-presets`](../design/captures/personality-presets)
usan Instrumento, las fuentes bloqueadas y datos sintéticos. Derivan de los canvases 13·12,
13·22 y 09·6; corrigen sus promesas de aplicación según el contrato. Son referencias de diseño,
no capturas de un APK. La validación nativa corresponde a Root; esta entrega no requiere cambios nativos.
