# Uso y costo del Servidor (#48b)

`GET /v1/usage?period=day|week|month` es una consulta autenticada y de solo lectura. El puerto
opcional `Hermes.usage` conserva la compatibilidad con adaptadores que aún no la implementan:
responden 503. No cambia la versión de protocolo.

## Significado de los datos

- Hoy empieza a medianoche del Servidor; semana, el lunes; mes, el día 1. Los días se construyen
  con calendario local, incluidos los de 23 o 25 horas. El límite superior es exclusivo; se excluyen
  Conversaciones que comiencen después del momento del cálculo.
- Hermes guarda `started_at` en segundos. La respuesta usa milisegundos para `capturedAt`, `from`
  y `until`, y declara la zona del Servidor. La app muestra la fecha usando esa zona.
- Los totales acumulados de cada Conversación se atribuyen a su fecha de inicio. **No son consumo
  exacto del día:** una Conversación iniciada ayer puede seguir consumiendo hoy y aparecer ayer.
- Los modelos son los registrados en `sessions.model`. No se reconstruyen cambios de modelo
  dentro de una Conversación. No se usa `model_config`, ni se suma uso auxiliar.
- Tokens totales significa entrada + salida. La caché leída se presenta separada y no se vuelve
  a sumar. Campos ausentes o nulos permanecen no disponibles.
- Todo importe es una **estimación en USD**, con `≈`. Se usa `estimated_cost_usd` solo con
  `cost_status` conocido (`estimated`, `actual` o `included`). Un cero con estado conocido es
  `≈ $0.00`; costo desconocido es `—`. La app no calcula precios ni cuotas.
- `total` queda nulo donde falte información. `totalsKnown` suma solo valores conocidos; si no hay
  ninguno, queda nulo. Un fallo de Agente invalida el total completo del Servidor y deja su suma
  conocida explícitamente parcial. Una BD ausente es no disponible; una corrupta es error.

La base de estas decisiones es el código oficial de Hermes fijado en
[`ea114c3…`, esquema de sesiones](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_state_common.py),
[contabilidad acumulada](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_state_usage.py)
y [estados de costo](https://github.com/NousResearch/hermes-agent/blob/ea114c3e98c3339e13004adfc6098cf28ed7d754/agent/usage_pricing.py).
Solo se consultó la fuente pública; las pruebas usan bases sintéticas y FakeHermes.

## Lectura acotada

La lectura abre una URI SQLite con `mode=ro`, `readOnly`, `query_only` y esquema no confiable.
Exige una tabla `sessions` real, sin sustituirla por vistas o tablas virtuales. Valida el
directorio del Agente y la BD, rechaza enlaces simbólicos y escapes de ruta, comprueba
la identidad de la BD tras abrirla y valida también WAL, SHM y journal existentes. No crea una BD
faltante. Incluye datos comprometidos en WAL.

Límites: 64 MiB por archivo, 50 000 filas de Conversación por BD y por respuesta, 128 Agentes,
512 modelos y 256 caracteres por identificador de modelo. Superar un límite deja el Agente en
error; no entrega un total truncado como si fuera completo. El timeout de bloqueo SQLite es
100 ms. No se exponen rutas ni errores internos de SQLite.

## App y demostración

La ruta `/usage/[server]` se abre desde **Uso y costo estimado** en Servidor. Consulta los tres
períodos de ese Servidor, con selección de período, reparto por Agente/modelo y barras nativas
que pasan a tokens cuando no hay costo conocido. Una barra permite consultar su día.

El último cálculo de cada período se guarda vinculado al Servidor, dirección y dispositivo
emparejado. Si falla la consulta, se muestra con fecha, zona y **Último cálculo · solo lectura**.
Reintentar lo sustituye al recuperar respuesta. Una caché inválida o de otro dispositivo no se
utiliza. Los períodos conservan su propia fecha si una consulta falla.

En `npm run demo`, abrir `/usage/atlas` y usar **Demostración · Cambiar** recorre resumen, solo
tokens, vacío, fallo parcial, sin respuesta con caché y carga. Referencias: PNG y HTML 17·1–7 de
`design/captures/instrumento-2/`. El alcance es un Servidor; no incluye cuotas ni Actividad global.

## Entrega para integración

Archivos propios:

- `protocol/serverUsage.ts`
- `bridge/src/serverUsage.ts`
- `bridge/test/serverUsage.test.ts`
- `bridge/test/serverUsageHttp.test.ts`
- `mobile/src/app/usage/[server].tsx`
- `mobile/src/core/serverUsage.ts`
- `mobile/src/core/serverUsage.test.ts`
- `mobile/src/core/serverUsageDemo.ts`
- `mobile/src/state/serverUsage.ts`
- `mobile/src/screens/UsageScreen.tsx`
- `mobile/tests/components/usage.component.test.tsx`
- `docs/server-usage.md`

Cambios aditivos en archivos compartidos, para conciliar con las otras entregas:

- `bridge/src/hermes.ts`: puerto opcional `usage`.
- `bridge/src/hermes_real.ts`: lectura de uso de los Agentes enumerados, sin cargar su configuración.
- `bridge/src/server.ts`: ruta autenticada y etiqueta de log sin query.
- `mobile/src/core/client.ts`: contrato `usage` del cliente.
- `mobile/src/core/bridgeClient.ts`: petición y validación de la respuesta.
- `mobile/src/core/demo.ts`: cliente, selector y reinicio de escenarios de uso.
- `mobile/src/screens/ServerScreen.tsx`: enlace a la ruta del Servidor.
- `mobile/src/ui/controls.tsx`: etiqueta accesible opcional para `Key`; al usarla expone rol de botón. (`controls.tsx` y `Key` se borraron al cerrar 3.1, #115; hoy la tecla es `Keycap` en `mobile/src/ui/kit.tsx`, con `accessibilityLabel`.)

Verificación final: 23 pruebas verdes (9 de agregación SQLite, 3 de lógica/caché/demostración,
4 de regresión de la demostración existente, 1 HTTP pública y 6 de componentes Android reales).
Tipos del Puente y de la app, lint de la app y `git diff --check` verdes. El detector de diseño no
reportó hallazgos. El arnés de componentes emitió avisos de solapamiento de `act()` sin pruebas
fallidas; no se alteró el arnés para ocultarlos.

Comandos y evidencias:

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-isolation=none bridge/test/serverUsage.test.ts mobile/src/core/serverUsage.test.ts mobile/src/core/demo.test.ts`
  → `usage-kernels-green.log`.
- `node --test --test-isolation=none bridge/test/serverUsageHttp.test.ts`
  → `usage-http-green.log` (HTTP efímero contra FakeHermes).
- `npm run test:components --prefix mobile -- --runTestsByPath tests/components/usage.component.test.tsx`
  → `usage-components-green.log`.
- `npm run typecheck --prefix bridge`, `npm run typecheck --prefix mobile`,
  `npm run lint --prefix mobile` → `usage-bridge-types.log`, `usage-mobile-types.log`,
  `usage-mobile-lint.log`.
- Mutaciones con aserción RED y restauración GREEN: DST, unidades de tiempo, rutas/archivos,
  costo desconocido, selección de período, identidad de caché, query del log HTTP y rechazo de una vista de proyección sin límite.
  Evidencia: `usage-mutation-{dst,units,paths,unknown-cost,period-wire,cache-source,http-log,bounded-view}-{red,green}.log`.

Se revisaron los siete PNG y HTML de referencia. No hubo navegador habilitado para capturas de
la app renderizada ni se verificó el APK. El gate completo queda para root al integrar, según
la instrucción de esta sesión. No se realizaron commits ni cambios de rama.
