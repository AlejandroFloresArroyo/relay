# Codificaciones del editor de Relay V3

Recomendación de alcance: UTF-8, UTF-16LE, UTF-16BE, ISO-8859-1 real y Windows-1252 como cinco opciones distintas. Límite de producto: 5 MiB (5.242.880 bytes), comprobado sobre entrada y salida codificadas. Conservar codificación, presencia del BOM y terminadores originales; no normalizar CRLF, LF o CR durante el recorrido del editor.

## Capacidades verificadas de Node 26

`TextDecoder` admite UTF-8 y UTF-16; Windows-1252 depende de una compilación con ICU completo. Usar `fatal: true`: un error de decodificación lanza `TypeError`. La opción fatal no funciona sin ICU. `ignoreBOM: false` retira el BOM del texto, por lo que conviene registrar sus bytes por separado. `TextEncoder` solamente escribe UTF-8. [Documentación oficial de Node 26](https://nodejs.org/api/util.html#class-utiltextdecoder).

`Buffer` lee/escribe UTF-8, UTF-16LE y Latin-1 real. Latin-1 admite únicamente U+0000–U+00FF y trunca caracteres fuera del rango: validar antes de escribir. UTF-16BE puede escribirse como UTF-16LE y aplicar `swap16()` sobre una copia; no hay codec Buffer Windows-1252. [Codificaciones de Buffer](https://nodejs.org/api/buffer.html#buffers-and-character-encodings), [swap16](https://nodejs.org/api/buffer.html#bufswap16).

## Identificación y escritura segura

Los nombres `latin1` e `iso-8859-1` de WHATWG se resuelven a Windows-1252: **no usar `TextDecoder('iso-8859-1')` para prometer Latin-1 exacto**. Se distinguen especialmente en 0x80–0x9F: Latin-1 conserva controles; Windows-1252 contiene, entre otros, euro y comillas tipográficas. Los BOM reconocidos son EF BB BF (UTF-8), FF FE (UTF-16LE) y FE FF (UTF-16BE). [Etiquetas WHATWG](https://encoding.spec.whatwg.org/#names-and-labels), [BOM](https://encoding.spec.whatwg.org/#bom-sniff), [índice Windows-1252](https://encoding.spec.whatwg.org/index-windows-1252.txt).

Inferencia para el producto: sin BOM, bytes ASCII son compatibles con varias codificaciones; una decodificación UTF-8 válida tampoco prueba el origen. Proponer UTF-8 si es válido, mostrar la codificación y ofrecer selección manual antes de editar/guardar. Si falla, exigir selección; no reemplazar bytes inválidos silenciosamente. No presentar heurísticas como identificación cierta.

Antes de guardar: rechazar sustitutos Unicode aislados y todo carácter no representable; codificar y verificar igualdad exacta al decodificar de nuevo. Un archivo sin cambios debe recuperar exactamente sus bytes originales, incluido BOM y saltos mixtos. Preservar saltos mixtos exige conservarlos en el modelo o demostrar que la entrada nativa no los normaliza; guardar un mero indicador «CRLF» no basta. Bloquear el guardado y señalar el carácter incompatible, sin sustituirlo por `?`, eliminarlo ni cambiar de codificación automáticamente.

## Dependencias

No hace falta una dependencia para UTF-8, UTF-16LE/BE y Latin-1 con validaciones estrictas. Para Windows-1252, los builtins no ofrecen encoder: elegir entre una tabla inversa pequeña, aislada y probada contra el índice oficial, o una biblioteca de codecs mantenida que permita verificar representabilidad/roundtrip. La segunda opción requeriría autorización explícita para añadir dependencia; no se ha instalado ni añadido ninguna. Comprobar soporte ICU al arrancar si se elige TextDecoder Windows-1252. Esta nota es de planificación, no modifica código ni configuración.
