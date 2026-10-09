# Tablero web: residual QA de programación del fixture

## Evidencia y cambio

Root compiló fuente 76443d9 y ejecutó el runner en Android: store validó hash/retirada, pero baseline terminó matrix_not_executed antes de restricted. No permite activar ningún proveedor. En la sonda isolated, internetDenied=true y constructor=not_initialized son viabilidad negativa del candidato, no evidencia de una arquitectura realizable.

El fixture hacía download y form.submit con target por defecto antes de iniciar RTC y del timer de navegación. Un formulario navega el documento fuente y puede cancelar ese timer y las tareas RTC. Los dos ataques se mueven al mismo tramo diferido que las demás navegaciones; no se eliminan ni se sustituyen. El argumento globalThis.RTCPeerConnection evita además una ReferenceError fuera del try de rtc si la API falta: el intento se rechaza y la matriz continúa; la ausencia de oferta mantiene baseline inconcluso.

No cambian Instrumentation, Module, store, política productiva ni controles positivos: baseline exige TCP>0, UDP>0 y rtcOffers>0; restricted exige >=35 ataques, leaks=0 y ambos contadores cero, además de DOM/canvas/CSS/PNG benignos. No se acepta constructor rechazado como prueba de egress. El timer conserva su segundo de espera; RTC que no complete antes de una navegación no puede fingir una oferta, y Root debe verificar su ejecución real.

## Prueba estrecha y límites

`node --test mobile/modules/relay-board-web/android/src/androidTest/fixtures/probeScheduling.test.cjs` ejecuta el probe original completo contra límites sintéticos de navegador. Reproduce retiro del realm fuente por form/anchor, timers descartados y RTC disponible/ausente, sin sockets ni destinos reales. Exige que no haya retiro temprano, que se programe oferta RTC antes de navegaciones, que siga el control benigno, que se sometan >=35 ataques y que no falten download/POST/intent/top/data/blob. El caso RTC ausente exige rechazo honesto, matriz completa y ninguna oferta.

Dos aserciones RED antes del cambio, dos GREEN después. Mutación exacta: mover únicamente POST del timer al tramo anterior a rtc; vuelve a fallar la aserción de navegación temprana y matrix-submitted. Restauración byte a byte devuelve dos GREEN. Logs board-web-fixture-scheduling-{red,green,mutation-red,restored-green}.log. Este doble comprueba programación, no semántica universal del navegador ni aislamiento nativo.

Root debe recompilar y repetir baseline y restricted completos en su APK QA, con loopback controlado y sin datos/endpoints de producción. Un baseline todavía inconcluso exige diagnóstico, nunca reducir TCP/UDP/ofertas o saltar benigno. El policyHash cambia por fuentes de fixture; ningún registro se habilita automáticamente. La matriz de red y lifecycleProbeOnly siguen separadas; el residual lifecycle congelado no cambia aquí. Root es el único ejecutor Android. No build/ADB/Gradle/gate/deps/commit desde el worker.
