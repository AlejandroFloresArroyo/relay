# Relay

Control remoto, desde el teléfono, para agentes de Hermes que ya existen y corren en máquinas del
usuario. Este glosario fija las palabras del proyecto.

## Language

**Relay**:
La app móvil con la que una persona opera sus propios agentes de Hermes a través de su tailnet.
_Avoid_: Relay Instrumento (es el nombre del estilo visual, no del producto)

**Relay Negocio**:
Un proyecto aparte, para equipos (tareas, conocimiento, cuotas). No forma parte de Relay.
_Avoid_: Hermes negocio, fase 2

**Agente**:
Un perfil de Hermes, con su propio modelo, memoria y conversaciones.
Su identificador es el nombre del perfil que entrega el Puente. Relay le asigna un avatar local
a partir de ese identificador, estable entre aperturas e independiente del modelo y del orden de
la lista. Varios Agentes pueden compartir imagen; el avatar no sustituye su nombre ni su Servidor.
_Avoid_: Perfil (es la palabra de Hermes, no la de Relay), bot

**Servidor**:
Una máquina del usuario donde corre Hermes y a la que Relay se conecta.
_Avoid_: Host, nodo

**Puente**:
El servicio que corre en el Servidor, junto a Hermes, y que es lo único con lo que Relay habla.
_Avoid_: Backend, relayd (es el nombre del programa), API

**Conversación**:
Un hilo de mensajes entre una persona, o un canal, y un Agente.
_Avoid_: Sesión (es la palabra de Hermes), chat (es la pantalla)

**Turno**:
Una vuelta de trabajo de un Agente dentro de una Conversación: desde que recibe un mensaje hasta que termina de responder.
_Avoid_: Run (es la palabra de Hermes), ejecución

**Tablero**:
El panel de un Servidor, hecho de Tarjetas.
_Avoid_: Dashboard; no usar "tablero" para el kanban

**Tarjeta**:
Una pieza del Tablero, mantenida por un Agente.
_Avoid_: Widget, bloque; no usar "tarjeta" para lo que se reparte en el kanban

**Pausa general**:
El estado de un Servidor en el que ningún Agente empieza trabajo nuevo hasta que una persona lo reanuda.
_Avoid_: Botón de pánico, pausa de emergencia

**Aprobación**:
La petición a una persona para que decida sobre un comando que un Agente quiere ejecutar y que Hermes retuvo. Existe mientras está pendiente.
_Avoid_: Permiso, confirmación

**Decisión**:
El resultado sobre un comando retenido: aprobado, rechazado o expirado, y quién lo resolvió (la persona o el Guardián).
_Avoid_: Aprobación resuelta, respuesta

**Guardián**:
El modelo auxiliar de Hermes que, en modo `smart`, aprueba por su cuenta los comandos retenidos y pasa a una persona los casos en que duda o niega.
_Avoid_: Smart approval, IA de seguridad

**Modo de aprobación**:
Quién decide sobre los comandos retenidos de un Agente: la persona siempre (`manual`), el Guardián (`smart`) o nadie (`off`). Si la configuración del Agente no lo fija, rige el que Hermes trae por defecto (`smart` en Hermes 0.21); si Relay no puede leerlo, lo muestra como desconocido, nunca supone uno.
_Avoid_: Nivel de autonomía, permisos del agente

**Entorno propio**:
El conjunto de trabajo remoto creado para un dispositivo y separado del trabajo previo o compartido del Servidor. Una sesión de terminal previa o compartida a la que el dispositivo se conecta no pertenece a su Entorno propio.
_Avoid_: Turno (pertenece a una Conversación), trabajo del Servidor (incluye el de otros dispositivos)

**Autorización web**:
El acceso temporal que un dispositivo emparejado concede a una aplicación del Servidor para abrirla en el navegador del teléfono o tablet. Es distinto del emparejamiento del dispositivo con el Puente.
_Avoid_: Llave del dispositivo, Conversación

**Terminal remota**:
La terminal interactiva de un Servidor que una persona abre y usa desde Relay. Permite trabajar con herramientas y Agentes de la máquina; su trabajo no es por ello un Turno ni una Conversación de Hermes.
_Avoid_: Conversación, caja de comandos

**Navegador del Servidor**:
El navegador que corre en el Servidor y cuyas páginas una persona controla desde Relay. Puede ser dedicado a Relay o el habitual del usuario; sus inicios de sesión permanecen en el Servidor.
_Avoid_: Visor web (carga la aplicación en el teléfono), escritorio remoto
