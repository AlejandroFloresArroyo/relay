# Matrices de referencia QR

Generadas el 2026-10-02 con **qrencode/libqrencode 4.1.1**, una implementación
independiente de Project Nayuki. Los textos son sintéticos. No se usó el módulo
bajo prueba para generar ninguna matriz.

Para cada `text` de `matrices.json`, se enviaron sus bytes UTF-8 por stdin a:

```sh
qrencode -8 -l M -m 0 -s 1 -t PNG -o <archivo-temporal.png>
```

`-8` fuerza un único segmento byte, `-l M` fija la corrección M, `-m 0` elimina
el margen y `-s 1` produce un píxel por módulo. Pillow leyó cada PNG en RGB:
negro `(0, 0, 0)` se guardó como `1`, blanco como `0`. Se inspeccionaron las
dimensiones, las dos copias de información de formato y la correspondencia de
todos los módulos con las pruebas. No hay ECI ni optimización numérica.

| Caso | Bytes UTF-8 | Versión mínima | Lado |
|---|---:|---:|---:|
| small | 5 | 1 | 21 |
| byte-v1-limit | 14 | 1 | 21 |
| byte-v2-first | 15 | 2 | 25 |
| unicode | 20 | 2 | 25 |
| long-hostname | 128 | 8 | 49 |

Con M, las versiones 1, 2, 7 y 8 tienen respectivamente 16, 28, 124 y 154
codewords de datos. El encabezado byte en versiones 1–9 necesita 12 bits:
4 de modo y 8 de longitud. Sus capacidades son 14, 26, 122 y 152 bytes.
Por eso 14→15 cambia de versión 1 a 2 y 128 bytes necesitan la versión 8.
En la versión 40 M hay 2334 codewords y el encabezado usa 20 bits: caben
2331 bytes; 2332 ya no caben.

Las implementaciones pueden elegir máscaras diferentes. Las pruebas comprueban
las dos copias del formato BCH (M y máscara 0–7), retiran la máscara de los
módulos de datos y comparan la matriz completa, excluyendo solamente las
palabras de formato que dependen de la máscara. Los patrones funcionales, los
datos y la corrección se comparan con la referencia. Otra prueba verifica que
la selección automática varía según el contenido.

La prueba de integración reconstruye los módulos de los cinco casos desde el
ANSI, crea PNG temporales y los lee con **zbarimg 0.23.93**. Verifica el texto
original incluso en los casos de máscaras diferentes. Se ejecuta cuando el lector está
disponible; no instala herramientas ni las requiere para ejecutar el Puente.
