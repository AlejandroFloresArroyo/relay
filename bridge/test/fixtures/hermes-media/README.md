# Funciones oficiales de medios de Hermes

Fixture del commit público `ea114c3e98c3339e13004adfc6098cf28ed7d754` de
[Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/ea114c3e98c3339e13004adfc6098cf28ed7d754),
con licencia MIT incluida en `LICENSE`. Conserva los nodos AST originales que el adaptador
selecciona de `gateway/platforms/base.py`, `gateway/media_policy.py` y `hermes_constants.py`.
La clase conserva exactamente los tres métodos de extracción, sin su herencia ni el resto
del gateway. No se sustituyen el parser ni la validación por dobles.

`manifest.json` registra el SHA-256 completo de cada fuente pública, el del fixture y los
nombres seleccionados. Los nodos y métodos se compararon mediante `ast.dump` con la fuente
pública íntegra. El adaptador de producción exige los hashes completos; únicamente el arnés
de pruebas permite los hashes de este fixture reducido.

Las pruebas ejecutan Python aislado con un perfil temporal y prohíben importar el grafo de
configuración, sesiones, terminal y credenciales. En ese arnés solo YAML se sustituye por un
lector JSON; la extracción y las políticas son reales. El smoke adicional usa un venv
sintético, PyYAML real y los tres archivos públicos completos, sin acceder al Hermes instalado.

Comprobaciones: extracción con mayúsculas/minúsculas, extensión desconocida existente,
ejemplos protegidos, política por defecto y estricta, caché, directorio permitido,
configuración administrada, archivos ausentes, credenciales bloqueadas, rechazo de Docker
e intentos de escritura, chmod o lectura de `.env` aun cuando se capture su excepción.
