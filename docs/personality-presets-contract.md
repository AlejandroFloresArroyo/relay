# Presets de personalidad: contrato para la app

Contrato congelado para construcción paralela de UI y Puente, 2026-10-04.
Fuente de tipos y constantes: `protocol/personalityPresets.ts`.
SHA-256: `4367dcd95a4f0a464e56630a8d30c7450d9d07df4cdabce6a90ea3e2941edd02`.
Cambios del DTO o de estas constantes pasan por Root antes de editarlo.

Todas las rutas necesitan dispositivo emparejado, autorización vigente y `X-Relay-Protocol: 2`.
No hay rutas de archivos ni contenido arbitrario de `instructions` aceptado desde el cliente.
Las solicitudes tienen claves exactas; campos desconocidos se rechazan. Las revisiones son
hashes hexadecimales de 64 caracteres y `requestId` es UUID. Tiempos: milisegundos Unix.

| Método y ruta | Entrada | Respuesta |
| --- | --- | --- |
| GET `/v1/personality-presets` | Sin query | 200 `PersonalityPresetCatalog`; lista de metadatos, sin contenido |
| POST `/v1/personality-presets` | `CreatePersonalityPreset` | 201 `PersonalityPresetVersion` |
| GET `/v1/personality-presets/:id` | UUID | 200 versión vigente; 404 después de borrar |
| GET `/v1/personality-presets/:id/versions/:revision` | UUID + hash | 200 versión inmutable; disponible también tras borrar |
| PATCH `/v1/personality-presets/:id` | `UpdatePersonalityPreset` | 200 nueva versión; tipo inmutable |
| DELETE `/v1/personality-presets/:id` | JSON `DeletePersonalityPreset` | 200 `DeletedPersonalityPreset` |
| GET `/v1/agents/:agentId/soul/preset-preview?presetId=UUID&presetRevision=HASH` | Solo las dos query, una vez cada una | 200 `SoulPresetPreview`: preset completo y SOUL actual completo |
| PUT `/v1/agents/:agentId/soul/preset` | `ApplySoulPreset` | 200 `AppliedSoulPreset` |
| GET `/v1/agents/:agentId/conversations/:conversationId/personality` | Sin query | 200 `ConversationPersonality` |
| PUT `/v1/agents/:agentId/conversations/:conversationId/personality` | `SelectConversationPersonality` | 200 `ConversationPersonality` |

## Cuotas y normalización

- Catálogo privado por Servidor: 64 presets activos. Historial y recibos cuentan en los 16 MiB
  del catálogo serializado; no se descartan versiones para liberar cuota.
- Nombre: entre 1 y 100 puntos de código Unicode, sin controles ni espacios exteriores.
- `kind`: `soul` u `overlay`, fijo desde la creación.
- Contenido UTF-8 válido: SOUL hasta 1 MiB; overlay hasta 64 KiB. Los límites cuentan bytes,
  no longitud UTF-16. El contenido completo se conserva sin recortar; puede estar vacío.
- `PERSONALITY_REQUEST_MAX_BYTES`: 6 MiB + 4096. `PERSONALITY_RESPONSE_MAX_BYTES`:
  12 MiB + 4096. Son límites de transporte JSON para caracteres escapados y preview doble;
  no elevan la cuota de contenido ni prometen que Hermes lo incorpore entero en su contexto.
- `capturedAt`, `createdAt`, `updatedAt`: enteros de milisegundos. La selección inicial lleva
  `preset: null` y `updatedAt: null` con una revisión válida.
- La selección contiene la versión completa congelada, no una consulta dinámica al catálogo.
  La app normaliza `bytes` contra UTF-8 y comprueba IDs, revisiones, tipos y todos los límites.

## Operación: cuotas llenas y respaldos

Los topes no cambian y el Puente no poda nada: conserva cada versión anterior (`AGENTS.md`).
Llegar a un tope es terminal hasta que alguien con acceso al Servidor archive datos a mano. En
el directorio de estado del Puente (`<estado>`, donde está `devices.json`) viven:

| Archivo | Qué es | Cuota |
|---|---|---|
| `personality-presets.json` | Catálogo: presets, todas sus versiones y los recibos de crear, editar y borrar | 16 MiB y 64 presets activos |
| `personality-<id>.previous` | Catálogo anterior a cada cambio | Ninguna |
| `personality-apply-<clave>.json` | Recibo de cada «Reemplazar con huella» | 4096 archivos de hasta 16 KiB |
| `personality-apply-<id>.previous` | Recibo anterior a su cierre | Ninguna |
| `memory-<id>.previous` | `SOUL.md` o memoria anteriores a cada escritura | Ninguna |

Los `<id>` de los `.previous` son el ID del registro de solicitud en `changes.jsonl`. Las capas
fijadas en Conversaciones están congeladas en el registro de Conversaciones, no en el catálogo.

Antes de tocar nada, siempre: detener el Puente (`systemctl --user stop relay-bridge.service` y
comprobar que `systemctl --user is-active relay-bridge.service` responde `inactive`), crear un
directorio de archivo fuera del estado y **mover**, nunca borrar:

```bash
dest=~/.local/share/relay-backups/personality-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$dest"
```

Al terminar, arrancar el Puente y comprobar `GET /health`.

**Catálogo lleno** (`personality_limit` al crear, editar o borrar, aunque haya menos de 64
presets: el historial ocupa los 16 MiB y ni borrar cabe). Mover el catálogo entero:
`mv <estado>/personality-presets.json "$dest"/`. Sin ese archivo el Puente arranca con un
catálogo vacío y una revisión nueva. Después, volver a crear desde la app los presets que se
quieran conservar: el contenido vigente de cada uno es la última entrada de `versions` de los
presets con `"deleted":false` en el archivo movido, y «Guardar SOUL actual como preset» sirve
para el SOUL de un Agente. Efectos: las Conversaciones conservan su capa congelada; las hojas
abiertas en la app reciben conflicto y deben recargar; repetir a mano una aplicación ya
completada que citaba una versión archivada ya no la encuentra. Nada se reenvía solo.

**4096 recibos de aplicar** (`personality_limit` en «Reemplazar con huella»). Mover los
recibos más antiguos que ya terminaron y conservar los `pending`, que son resultados inciertos:

```bash
cd <estado>
ls -tr personality-apply-*.json | head -n 2048 | xargs grep -L '"state":"pending"' | xargs -r mv -t "$dest"
```

Un recibo movido deja de proteger el replay de su `requestId`. La app no repite aplicaciones
(cada intento lleva un `requestId` nuevo y una huella nueva), así que solo afecta a una
repetición manual de una petición antigua.

**Crecimiento de los `.previous`**. No cuentan en ninguna cuota y el Puente no los lee; solo
ocupan disco. Medir con `du -ch <estado>/*.previous | tail -n 1`. Si hace falta espacio, mover
los más antiguos al archivo con el mismo procedimiento (`ls -tr <estado>/*.previous`). No se
borran: son la versión anterior que exige `AGENTS.md`.

## Confirmación y efectos

Crear necesita `catalogRevision`; editar y borrar necesitan la revisión vigente del preset.
`requestId` se conserva al recuperar el mismo resultado. El mismo ID con cuerpo distinto
conflicta; una operación incierta no genera reintentos automáticos ni un ID nuevo automático.

Aplicar SOUL muestra el reemplazo exacto y el contenido actual mediante preview, y pide huella
Android fuerte nueva. Envía ambas revisiones observadas. El Puente usa exclusivamente
`agentMemory.changeSoul`, con guarda y señal de cancelación; conserva respaldo y registro.
La UI respeta `soul.writable`, muestra su razón cuando no permite escribir y retira contenido
privado y confirmaciones al bloquear, perder foco, pasar a segundo plano, revocar o cambiar alcance.

Un overlay se selecciona libremente en una Conversación nacida Relay; una Conversación externa
responde `personality_read_only`. Seleccionar congela la versión vigente antes del siguiente Turno.
Editar o borrar el preset no altera el snapshot elegido. Cambiar selección durante un Turno activo
no lo redirige: afecta posteriores admisiones. `preset: null` omite la capa Relay y hereda la
configuración del Servidor. No significa que el contexto contenga solamente SOUL.

Textos visibles de las constantes congeladas:

- «Hermes puede aplicar los cambios al reconstruir el contexto, incluso en esta Conversación.»
- «Sin capa extra de Relay. Se hereda la configuración del Servidor.»

No se promete un instante exacto de reconstrucción de contexto ni exclusividad de Conversaciones
nuevas. Sin conexión, la app puede mostrar caché fechada de solo lectura; no guarda cambios.

## Errores

Envelope existente `ApiError`: `error.code`, mensaje estático seguro, `retryable`.
Usar mensajes locales de `PERSONALITY_MESSAGES`; nunca mostrar texto upstream ni contenido
recibido en un error. Incertidumbre nunca autoriza reenvío automático, aunque el transporte marque
un 503 como recuperable para lectura.

| Código | HTTP | Comportamiento |
| --- | --- | --- |
| `personality_invalid` | 400 | Forma, Unicode o cuota individual inválida |
| `personality_not_found` | 404 | Preset o versión no disponible |
| `personality_conflict` | 409 | Recargar y volver a confirmar; identidad o revisión cambió |
| `personality_limit` | 409 | Capacidad agotada; no se borró historial |
| `personality_read_only` | 403 | Conversación nacida fuera de Relay |
| `personality_uncertain` | 503 | Efecto no confirmado; no reintentar automáticamente |
| `personality_unavailable` | 503 | Catálogo o capacidad inaccesible o insegura |

Se conservan errores comunes: autorización/revocación, protocolo 426, agente inexistente,
solicitud demasiado grande, capacidad de Conversación y `AGENT_MEMORY_ERROR_STATUS/MESSAGES`
para SOUL (conflicto, solo lectura, cuota efectiva, lock ocupado, no disponible). Los códigos de
#44 siguen teniendo su semántica; no se convierten en éxito ni en garantía de no escritura.
