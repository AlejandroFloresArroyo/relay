# Descubrimiento y logs: entrega 48c/48d

ENTREGA #48c + #48d — feat/discovery-logs

Implementado en este worktree. Sin commits, push, merge, cambio de rama, APK, ADB,
agentes adicionales, dependencias nuevas ni acceso a producción. No se copió el helper de huella.

CONTRATOS PARA ROOT
- protocol/discovery.ts: DiscoveryResult { bridges: DiscoveredBridge[], truncated: boolean }.
  DiscoveredBridge { name, url, protocolVersion: number|null, minAppProtocolVersion: number|null }.
- AppDeps.discovery?: Discovery; discover(): Promise<DiscoveryResult>.
  createDiscovery({exec, port, probe?}); producción inyectada en bridge/src/main.ts.
- GET /v1/discovery requiere dispositivo emparejado; no acepta query.
  Sin servicio o fallo de tailscale: 503 unavailable con mensaje fijo.
  Revalidación de autorización después del await y al serializar la respuesta.
- GET /v1/logs añade agentId opcional; omitirlo conserva default.
  Hermes.logs({level, lines, agentId?}); RelayClient.logs(level, lines?, agentId?).
  Los filtros son umbrales de severidad. TODO en la UI pide DEBUG explícitamente.
- RelayClient.discovery(); plazo de esta petición: 15 s, resto conserva su plazo.
- Navegación /connect?discoveredUrl=... inicia el formulario manual con dirección;
  requiere el código existente del Puente candidato, nunca reutiliza una llave.
- Componentes DiscoveryPanel y AgentLogs({serverId}) integrados en pantallas existentes.
  demo.ts expone estados normal/vacío/error e incompatibilidad para descubrimiento.

LÍMITES Y SEGURIDAD
- Solo nombres máquina.tailnet.ts.net del mismo sufijo que Self de tailscale status.
  IP de conexión fijada a una dirección Tailscale del peer; sin resolución DNS ambiental.
- 24 candidatos, cuatro sondeos simultáneos, 1,5 s y 4096 bytes por health.
  tailscale status: timeout 3 s y JSON máximo 1 MiB; llamadas simultáneas comparten búsqueda.
- GET /health público sin bearer/cookies ni cabeceras reenviadas; redirecciones rechazadas.
- Puerto único: el configurado en el Puente origen. Otros puertos requieren emparejar a mano.
- Lectura de logs Linux mediante /proc/self/fd: sin symlinks, hardlinks ni archivos especiales.
  Lectura máxima 512 KiB desde el inicio conocido del archivo, hasta 1000 entradas,
  mensajes de hasta 4000 caracteres tras redactar. Si el archivo supera 512 KiB, no se lee
  contenido y GET /v1/logs devuelve 502 upstream genérico. No se ofrece una cola truncada:
  su primera línea completa puede continuar una credencial entre comillas iniciada fuera
  de la ventana. Ausencia del archivo: vacío; fallo de lectura: error opaco. Sin bitácora
  global/changeLog.
- Redacción por patrones conocidos, no garantía sobre secretos arbitrarios ni datos personales.
- Conservado diagnóstico. 19-* es kanban fuera de v1: referencias usadas 15-1, 23-6 y 05 Servidor,
  PNG y HTML. No se hizo validación visual en dispositivo ni build/export; root integra y corre gate.

VALIDACIÓN
- bridge-final.log: 103 pruebas en verde, HTTP fake, transporte fake y hogares sintéticos.
- components-final.log: 10 pruebas en verde (DiscoveryLogs y ConnectionStatus).
- mobile-core-final.log: tres archivos core afectados en verde.
- types-bridge.log, types-mobile.log y lint-mobile.log: verdes. git diff --check limpio.
- Mutaciones críticas RED / restaurar / GREEN, logs ignorados del worktree:
  mutation-redaction, mutation-symlink, mutation-revocation, mutation-tailnet,
  mutation-log-scope, mutation-protocol-ui (sufijos -red.log y -green.log).
- logs-all-levels-red.log: prueba fallida antes de corregir TODO; restauración funcional
  comprobada en components-final.log.
- npm ci ejecutado en bridge y mobile. Gate completo reservado a root.

FUENTES PÚBLICAS CONSULTADAS
https://raw.githubusercontent.com/NousResearch/hermes-agent/ea114c3e98c3339e13004adfc6098cf28ed7d754/hermes_cli/config.py
https://docs.expo.dev/versions/v57.0.0/
https://docs.expo.dev/llms.txt


CORRECCIÓN P1 RESIDUAL DE REDACCIÓN — BASE a71575b
- Se reprodujo por HTTP una apertura clientSecret fuera de 512 KiB con continuación
  que aparenta otra entrada de log dentro de la ventana. La respuesta anterior filtraba
  esa continuación aunque la redacción del archivo completo la ocultaba.
- logTail.ts rechaza archivos mayores al límite antes de leer su contenido. No busca
  prefijos, no lee el archivo entero fuera del presupuesto y no infiere contexto por
  salto de línea. Para archivos completos dentro del límite se conserva la redacción
  antes del parser. El error utiliza el contrato existente; no añade entradas ficticias.
- Limitación deliberada: tampoco se muestran logs grandes que no contengan credenciales.
  Sin contexto de inicio demostrable, la seguridad prima sobre mostrar su cola. La app
  recibe el estado genérico de error existente, sin fragmentos ni rutas del archivo.
- Pruebas HTTP con RealHermes y hogares sintéticos: comillas simples y dobles, escapes,
  valor sin cierre, continuación con formato de log, cuatro umbrales de severidad,
  archivo de exactamente 512 KiB y archivo de 512 KiB + 1 byte. El límite de lectura se
  observa en la frontera de fs.readSync; una respuesta segura por sí sola no lo prueba.
- redaction-tail-tdd-red.log reproduce la fuga con ERR_ASSERTION;
  redaction-tail-tdd-green.log verifica la corrección.
- redaction-tail-narrow.log: 15 pruebas verdes (logsHttp y util).
  redaction-tail-adapter.log: pruebas de logs del adaptador con perfil sintético.
  redaction-tail-types.log: tipos de bridge verdes. Bridge no declara tarea lint;
  mobile no cambia. Gate completo reservado a root.
- Cuatro mutaciones temporales: omitir la negativa por contexto desconocido, exceder
  los bytes leídos, analizar antes de redactar y omitir la redacción completa entre
  comillas. Cada una falla por aserción; se restaura el archivo y vuelve a verde.
  Evidencias redaction-tail-mutation-<nombre>-red.log / -green.log y manifiesto
  redaction-tail-mutations.log. Handoff durable: redaction-tail-handoff.log.
- Solo cambia código de logTail.ts, pruebas logsHttp.test.ts y este documento.
  hermes_real.ts y util/redact.ts quedaron restaurados tras las mutaciones. Sin commits,
  gate, nuevos agentes, servicios, dependencias ni acceso a producción.
