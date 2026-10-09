# Residual Compartir: blur y revocación de sondeo

Base congelada: `f72274f90ad6329d4f28ea3cbabb546f22f532c0`. Sin commits, gate, APK ni servicios. Root conserva su migración de tema V2Share28cf; no se cambian componentes de dibujo ni `usePalette`.

## Entrega aislada

- `mobile/src/state/useShareScope.ts`: disponibilidad síncrona antes de `setState` en blur; ningún permiso nuevo entre callback y render. La generación sigue invalidando permisos anteriores.
- `mobile/src/state/app.tsx`: WeakMap privado de identidad efectiva del cliente que produjo cada snapshot, expuesto mediante `snapshotClient`. Sin cambio del DTO ni persistencia de credenciales adicional.
- `mobile/src/state/sharedDrafts.tsx`: denegación terminal del sondeo retira permanentemente esa identidad mediante DraftStore real y purga referencias/copias. Una respuesta offline no la recupera. Snapshot antiguo no retira credenciales nuevas.
- `mobile/tests/components/Share.component.test.tsx`: 39 tests Share, incluyendo tres repros, purga de imagen/referencia, escritura nativa pendiente, reemplazo de cliente y otro Servidor.
- Este documento.

`share-residual-manifest.log` contiene SHA256 y rutas exactas de estos cinco archivos; `share-residual-patch.log` contiene el diff de los cuatro archivos existentes. **Excluir** `mobile/tests/native-share/**` y `docs/handoffs/share-native-harness-plan.md`: son QA aparte, no residual. Los otros 50 archivos del manifiesto original de 53 permanecen intactos; los tres originales modificados están en este manifiesto. `app.tsx` es el único archivo adicional de producto requerido: al integrar, incorporar sus ocho líneas de propiedad causal sobre el archivo actual de Root, sin sustituir wiring concurrente.

## Evidencia

Tres repros copiados literalmente antes de corregir, tres aserciones RED: `share-residual-original-red.log`; fuentes originales en `share-spec-repros-f72274f.log` y `review-share-polling-revocation-repro-source.log`. Los dos repros blur se conservan literalmente. El repro de sondeo adapta sólo selectores posteriores al offline a `queryByText`, porque el estado corregido oculta el Agente revocado; exige navegación cero y aviso de emparejamiento visible. No se añade etiqueta/UI para sostener un selector obsoleto.

RED adicional de retiro/causalidad: `share-residual-retirement-red.log`. GREEN: `share-residual-components-green.log`, 62 tests en Share, ChatImages, AppProviderPolling y AppProviderStorage. `share-residual-types.log`: tipos app/core/componentes. `share-residual-lint.log`: ESLint de los cuatro archivos.

Cuatro mutaciones causales temporales, aserción explícita RED y restauración GREEN por separado: `share-residual-mutation-{blur-latch,permanent-retirement,causal-owner,poll-ownership}-{red,restored-green}.log`; resumen `share-residual-mutations.log`. Ninguna mutación queda aplicada.

## Límites y siguiente tarea

Componentes con AppProvider/LockGate/DraftStore y núcleo reales; dobles sólo en límites autorizados. No NativeGREEN: Android no compilado ni ejecutado. Root hace integración y revisión. Se retoma el arnés nativo sintético separado, sin alterar esta entrega congelada.

Prioridad persistente: finalizar todo V2 (tablet; forks pendientes de Ale), después README con capturas verificadas, guía de instalación y prompt setup para agentes; luego V3 si definida y lista, de lo contrario compatibilidad. No compatibilidad inmediatamente después de V2.
