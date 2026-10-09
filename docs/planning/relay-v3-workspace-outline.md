# Esquema de herramientas del Servidor para V3

Esquema de baja fidelidad aprobado por Ale el 2026-10-04 en [Definir el flujo entre terminal, archivos y web en teléfono y tablet](https://github.com/AlejandroFloresArroyo/relay-app/issues/70). No son pantallas de producción ni fija sus detalles visuales. Referencia: Instrumento, `design/captures/instrumento/05_Servidor.png`; conservar nombre del Servidor, jerarquía y estilo del producto.

```text
TELÉFONO
Servidor · atlas
Terminal | Archivos | Web | Navegador
┌────────────────────────────────────┐
│ Una herramienta a pantalla completa│
│ conservando su estado al cambiar   │
└────────────────────────────────────┘
Volver a la Conversación de origen
```

```text
TABLET
Servidor · atlas
┌─────────────────┬─────────────────┐
│ Terminal        │ Web             │
│ [shell 1] [+]   │ localhost:3000   │
│                 │                 │
└─────────────────┴─────────────────┘
Dos paneles con herramientas elegibles
```

Las herramientas viven en el Servidor y se abren sin una Conversación. Sus accesos desde el chat conservan un retorno a la Conversación de origen. Una terminal no se representa como Turno o Conversación de Hermes.

Recorrido acordado:

1. Abrir Terminal en atlas, elegir shell y carpeta y ejecutar herdr o tmux normalmente. Una segunda terminal se abre en una pestaña distinta.
2. Cambiar a Archivos sin terminar la terminal. Entrar en el proyecto y editar un archivo de texto; conservar el borrador al alternar.
3. Desde una carpeta, abrir una terminal nueva allí; desde un archivo, copiar su ruta.
4. Elegir en Web un servicio local descubierto. Abrirlo en Relay o solicitar autorización para el navegador del teléfono, según el contrato de autorización acordado.
5. Si la aplicación necesita ajustes para el proxy, abrirla en el navegador del Servidor. Elegir navegador dedicado o una pestaña autorizada del habitual.
6. En tablet, elegir dos herramientas para trabajar lado a lado; el foco de teclado debe indicar claramente qué panel recibe entrada. Mantener disponible una vista de un solo panel.
7. Volver a la Conversación sin perder terminales, carpeta, borrador ni página.

La terminal adapta columnas y filas al espacio disponible y al teclado; el teléfono dispone de barra de teclas especiales y admite teclado físico. El diseño final requiere validación de interacción en Android; el esquema solo decide organización y flujo.
