# Tablero web: bootstrap autónomo de lifecycle QA

## Alcance separado

Este residual no reescribe Module, BoardWebIsolationInstrumentation ni board-web-v2-native-proof.md registrados en lifecycle3=60fc50b. Añade un runner autónomo y una Activity sintética únicamente en androidTest; modifica solo su manifest QA y este documento propio. Composición48=636bfb7 conserva hashes. No modifica código productivo, dependencias, build.gradle ni proveedores verificados.

El APK de pruebas real generado por NativeQA tiene package y target relay.boardweb.test, sin launcher ni ReactApplication. Por eso lifecycleProbeOnly del runner anterior no es receta válida para ese APK. El runner autónomo tiene targetPackage previsto relay.boardweb.test y rechaza cualquier otro paquete tanto en context como targetContext. Su declaración adicional en el manifest fuente no garantiza registro en el APK: AGP empaqueta la instrumentación seleccionada por defaultConfig.testInstrumentationRunner y reemplazó esa declaración en la prueba real de Root. Abre por componente la Activity privada BoardWebLifecycleActivity, sin intent MAIN ni launcher. No ejecutarla contra producción.

## Contexto y envelope

La Activity usa FrameLayout real de Android. El fixture inicia el SoLoader ya instalado con OpenSourceMergedSoMapping y crea BridgeReactContext real, ThemedReactContext y KotlinInteropModuleRegistry/AppContext reales, con proveedor de módulos vacío. No inicia ReactHost, JS runtime/Catalyst, Metro ni tráfico. El único doble es el límite React/proveedor del fixture: constructor interno existente admite verificación sintética; el constructor público Expo productivo sigue requireVerified. No se fingen store, WebView, callbacks de attach/detach, descriptores ni generaciones.

BridgeReactContext es API de prueba de la versión RN instalada y está deprecada. Si la configuración concreta minifica/rechaza la arquitectura legacy o el bootstrap no se puede inicializar, se devuelve native_bootstrap_unavailable: no modificar flags/config ni declarar prueba pasada. Root compiló fuente 50ae934 con su helper de classpath QA: clases y Activity compilan. La invocación del componente secundario falló Unable to find instrumentation info antes de ejecutar lifecycle, según board-web-native-lifecycle-corrected-device.log. Hace falta seleccionar y reconstruir el runner; no cuenta como RED conductual ni GREEN del fix. No afirmar que Dev171 sirve: su APK actual no contiene módulo Board. No se requiere Dev ni ReactApplication para esta receta autónoma.

Toda acción que puede disparar una aserción en main pasa por onMain: catch Throwable dentro de runOnMainSync y propagación al hilo de Instrumentation. FixedCheckFailure lleva únicamente causa literal estática. El resultado se emite después del cleanup, que nunca reemplaza el primer fallo causal; no hay mensajes arbitrarios, contenido, rutas o stack volcados. La mutación debe obtener cause=lifecycle_retire_not_cleared, no un crash de main ni un timeout.

## Prueba Root

Root selecciona un único runner por APK mediante su init QA que sobrescribe defaultConfig.testInstrumentationRunner exclusivamente para esta compilación. Requiere opt-in explícito `-PboardQaLifecycle=true` y ese init: la propiedad sola no selecciona nada en las fuentes del módulo. El valor seleccionado debe ser `relay.boardweb.BoardWebLifecycleInstrumentation`. No cambiar Module ni build.gradle productivo ni asumir varios runners registrados simultáneamente.

Después de terminar controlledgate3, Root recompila assembleDebugAndroidTest del módulo con esa selección, conserva artifact/policyHash exactos y verifica que el manifest empaquetado registra ese nombre con target relay.boardweb.test. Luego instala el APK QA correspondiente y ejecuta:

```text
relay.boardweb.test/relay.boardweb.BoardWebLifecycleInstrumentation
```

El APK DEFAULT actualmente instalado para la matriz no registra ese componente: no volver a invocarlo sobre el artifact equivocado. Worker no inicia compilación, instalación ni ejecución. Root instala y ejecuta el componente solo tras verificar la selección en su APK QA propio. No pasa lifecycleProbeOnly a este runner. Solo usa snapshot HTML sintético local, sin endpoints, producción ni perfiles. Esperar nativeLifecycle=detach-reattach-retire-pass, matrix=lifecycle-only-no-egress-claim y resultado OK. La prueba hace attach/show, detach, reattach de misma instancia/show nuevo, retire off-main y observación posterior en main de hijos retirados, generación nula, JavaScript apagado y bytes retirados. Un bootstrap fallido no cuenta como prueba del fix.

RED original: en el checkout NativeQA propio de Root, conservar este runner y sustituir únicamente Module por el candidato board-web-lifecycle-before-fix-module.log del manifiesto lifecycle. Debe devolver lifecycle_retire_not_cleared. Restaurar Module db5056ed9cc49c0a157062a4746177c9e888091305b42d54af7f46afb750efde y comprobar GREEN. Mutación causal exacta: borrar solo BoardWebViews.add(this) entre asignación snapshotId/generation y engine=create, mantener alta inicial, fixture y aserciones. Exigir otra vez ese paquete RED; restaurar hash y repetir GREEN. Logs RED/restoreGREEN en el worktree NativeQA, nunca afirmar que el worker los ejecutó.

Para volver a la matriz, Root retira el opt-in lifecycle en su init QA, selecciona de nuevo defaultConfig.testInstrumentationRunner=`relay.boardweb.BoardWebIsolationInstrumentation`, recompila el APK de pruebas, verifica su manifest e instala ese artifact. Entonces usa `relay.boardweb.test/relay.boardweb.BoardWebIsolationInstrumentation`. Compilar clases y Activity no demuestra que un runner secundario esté registrado. No sustituir la selección por lifecycleProbeOnly del runner anterior, porque ese camino requiere launcher/ReactHost ausentes en el target autónomo.

El test funcional de lifecycle no prueba aislamiento. La matriz baseline/restricted conserva sus controles positivos y el residual de programación de probe.js es independiente. Root tiene evidencia anterior nativeStore pasado, baseline matrix_not_executed sin restricted, e isolated internetDenied=true/constructor=not_initialized; no existe autorización de motor ni arquitectura aislada demostrada. Proveedores siguen vacíos. Cierre de Tablero web exige benigno y zero egress WebRTC reales; esta entrega de QA no cierra esa función.
