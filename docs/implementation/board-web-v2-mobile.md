# Tablero web v2: composición móvil y cierre pendiente

## Flujo

Los siete tipos nativos conservan contenido, acciones y preferencias por Servidor. El octavo tipo ocupa una Tarjeta completa y conserva título, Agente propietario, actualización y acciones nativas fuera del HTML. La descarga usa el transporte emparejado existente, protocolo 2 y capacidad Board Web 1 confirmada en cada respuesta; sin capacidad, el Puente anterior conserva una representación de texto nativo y no se solicitan recursos.

El cliente descarga manifiesto y archivos con lectura acotada, tipos y tamaños exactos, sin URL del Agente. Los bytes pasan al módulo nativo privado, que valida SHA256 del manifiesto canónico y cada archivo antes de sellar el snapshot. Un manifiesto o hash declarado no habilita proveedores: la lista de proveedores verificados permanece vacía. Ninguna llave, cookie del Puente ni API de acción entra al HTML. Los datos del Agente no generan mensajes de error ni logs.

El hook real retira primero generación y bytes, aborta transporte y descarta resultados posteriores a cada espera. Cambios de Servidor, cliente, credenciales, Agente, Tarjeta o revisión; LockGate, blur, background y desmontaje invalidan ejecución. Un callback de fallo de una vista retirada no puede retirar su sucesora. Sin conexión o sin Tablero confirmado se conserva solo metadata y no JavaScript anterior. Un proveedor no verificado tiene causa explícita y no descarga recursos. La retirada nativa independiente de foco y los límites de almacenamiento pertenecen al slice Native19, no se sustituyen con estados React.

## Diseño y demos

`design/captures/board-web-v2/FUENTE.md` documenta el fragmento Instrumento original y la ausencia de una captura 16b original. Hay referencias HTML/PNG para propuesta lista, claro/oscuro/tablet y estados cargando, error, offline, módulo ausente, proveedor sin verificar y retirado. Son diseños, no capturas Android. Se usan paleta, tokens y primitives existentes; el marco rayado distingue contenido del Agente.

Los escenarios Demo del Tablero incluyen esos estados y un bundle sintético inmutable TLS con botón de filtro y contador local. El escenario listo exige el mismo proveedor verificado que producción; no hay un bypass Demo. Los textos TLS son sintéticos y no se consultan dominios. Los estados de preview no ejecutan HTML.

## Evidencia estrecha

HTTP/lector: 21 casos GREEN contra Hermes falso y discos sintéticos, tipos Puente GREEN, siete mutaciones causales restauradas. Core móvil/contrato/transporte emparejado: 12 casos GREEN. Componentes: 17 casos GREEN montando AppProvider, LockGate y hook reales; solo límites nativos, almacenamiento, reloj, navegación y transporte son dobles. Tipos móvil GREEN. Lint sin errores; conserva tres avisos de la base en bridgeClient, ServerScreen y WorkScreen.

Las seis mutaciones móviles retiraron guardas de copia tardía, presentación bajo LockGate, capacidad de respuesta, negociación previa, límite de stream y callback nativo de generación retirada. Cada una tiene aserción RED y restauración GREEN en logs del worktree. Esta evidencia de componentes no demuestra que WebView bloquee tráfico ni que Kotlin compile. No se ejecutó gate, Gradle, APK, ADB ni servicio de producción.

## Prueba Android que corresponde a Root

Primero compilar y ejecutar el runner/fixture Native19 congelado según `board-web-v2-native-proof.md`. Baseline debe producir tráfico TCP/UDP sintético controlado; restricted debe ejecutar DOM, CSS, imagen y canvas benignos y completar matriz adversarial sin tráfico. La prueba aislada de viabilidad es separada. No usar Internet, destinos o datos de producción. Constructor RTC rechazado, timeout o contadores vacíos sin baseline no prueban aislamiento. Una salida loopback cero tampoco prueba por sí sola ausencia de DNS/mDNS o salida universal: queda pendiente revisar semántica del proveedor y completar evidencia nativa de zero egress, incluido WebRTC.

Solo después de esa decisión explícita Root puede registrar el proveedor exacto y política revisada. En su APK Demo, seleccionar «Web local», comprobar filtro y contador dentro de la Tarjeta real y capturar pantalla. Verificar también retiro por LockGate, background, scope, revocación y callback tardío. Si el candidato falla, no presentar el estado deshabilitado como función terminada: resolver aislamiento realizable o decidir alcance con Root. Este builder no autoautoriza proveedores.

CookieManager y ServiceWorkerController son globales y pertenecen por ahora al módulo Tablero. El futuro visor V3 deberá reconciliar su propiedad antes de coexistir; no se implementa V3 aquí. Se conserva prioridad: Tablet dentro de v2 antes de README/capturas verificadas/instalación/prompt de setup; luego V3 si está definida y lista, si no compatibilidad. Bifurcaciones siguen pendientes por decisión de Ale, sin extensión ni writer Hermes.
