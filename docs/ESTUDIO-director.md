# Estudio: el Director de la sala (RP109)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP109 de `docs/ROADMAP.md`: cómo construir un **Director** que lanza y ordena a un agente por repo miembro de una sala, recibe sus reportes, resuelve solo lo técnico y reversible y **le pregunta siempre a la persona** toda decisión. Compara arquitecturas, recomienda una y propone una secuencia de filas por etapas.

- **Parte de lo ya decidido** (ficha `odd/tasks/chat-alcance.md`, S6, L12): se llama Director; lanza y ordena; los agentes de repo le reportan; resuelve solo lo técnico y reversible dentro del alcance ya autorizado; en la duda pregunta; lo que resolvió solo queda registrado; la entrega sigue siendo de la persona. Y la arquitectura confirmada: «el director mande orden de abrir sesión en cada repo y cada repo debe tener su agente principal».
- **Parte de lo medido** en `docs/ESTUDIO-subagentes.md` (RP107), `docs/ESTUDIO-usos-subagentes.md` (RP108) y `docs/INFORME-entorno-chat.md` (RP110).
- **Cómo se obtuvo:** una exploración de solo lectura del código del panel (salas, host de sesiones, órdenes, archivo de estado, eventos) y la verificación propia de los puntos que más pesan. Cada afirmación dice si fue **observada** o **inferida**.
- **Lo que no se hizo:** no se construyó ni se probó nada, no se arrancó ninguna sesión y no se midió costo real.

## 1. Conclusiones

1. **La entrega de la persona es el freno natural, y conviene decirlo primero.** Una unidad avanza solo si el repo está en la rama base, limpio, sin stash y al día con el remoto (puerta de `AGENTS.md`), y ningún agente commitea, crea ramas, hace push ni abre PR. Por lo tanto **el Director no puede encadenar tareas dentro de un repo**: cada repo avanza una tarea por cada entrega que la persona hace. El paralelismo está **entre repos**, no dentro de uno.
2. **El Director tiene dos mitades de naturaleza distinta.** Una es mecánica y barata: abrir sesiones, ordenar `/flow-next`, esperar eventos, reunir preguntas, llevar un registro, respetar límites. La otra necesita criterio: decidir si una duda es técnica y reversible o es una decisión de la persona. La mecánica se puede construir ya con lo que el panel tiene; el criterio debe nacer **apagado**.
3. **La regla de seguridad más simple es también la más fuerte:** la lista de lo que el Director puede resolver solo **empieza vacía**. Todo se lo pregunta a la persona hasta que ella agregue, una por una, categorías concretas. «En la duda, pregunta» deja de ser una intención y pasa a ser el valor por defecto.
4. **Un Director de lenguaje natural (una sesión de modelo) es opcional y viene al final.** Sirve para redactar el resumen de la sala y proponer la siguiente orden, pero no debe ejecutar nada: toda orden sale de un vocabulario fijo que arma el panel.
5. **La sala ya tiene una convención hecha para esto:** el `ENLACES.md` de la sala, cuyas secciones obligatorias son Proyectos, Contratos, Dependencias, **Cola (de órdenes)** y último barrido (`requirements.json`, `room-enlaces-sections`). El Director no necesita inventar dónde viven los contratos entre repos ni la cola.
6. **Una restricción de `AGENTS.md` condiciona el diseño:** «Prohibido: llevar un estado paralelo (otro vocabulario de estados, otro tablero u otro índice)». El Director debe **derivar** su vista de `docs/ROADMAP.md` y de `.panel/state.json` de cada repo; solo puede tener un **registro** de lo que ordenó y resolvió, nunca un estado propio de las tareas.

## 2. El punto de partida: lo que el panel ya tiene

Todo observado en el código, salvo lo marcado.

**Salas.** Una sala es `{ name, path, repos: [repoId] }` en `config.json` (`server/config.js:54`); un repo pertenece como mucho a una sala (`roomOf`, `:165`). El panel lee los datos de Git de la sala (`GET /api/rooms`, `server/rooms.js:20`) y verifica sus requisitos. La carpeta de la sala «solo se mira, nunca se escribe» (`server/rooms.js:4`). **Una sala hoy no puede tener sesión viva:** `liveFromHost` fuerza `closed` para las claves `room:` (`server/sessions.js:275`) y el host de sesiones resuelve ids con `findRepo`, que solo conoce repos (`server/http.js:224`, `server/config.js:157`).

**Abrir y mandar a una sesión de repo.** El host mantiene una sesión de `pi --mode rpc` por repo, hasta 6 a la vez (`server/rpchost.js:103`; el 7.º da 409, `:157`); arrancar tarda hasta 5 minutos (`server/rpc.js:14`) y el arranque real es lento e irregular (RP101). Una sesión pasa por `starting`, `idle`, `busy`, `asking` y `closed`. `piSend` (`server/pi.js:89`) arma el texto desde una lista fija, **solo lo manda si la sesión está libre** (`idle`; si no, 409) y evita repetir la misma orden durante 45 s. Devuelve en cuanto pi acepta el pedido, sin esperar el final de la corrida: el resultado se ve después por el estado. Las órdenes son `/flow-commit`, `/flow-pr`, `/flow-base`, `/flow-next` y las construidas «Put in conditions» y «Fix with pi» (`lib.js:467`, `server/pi.js`). **«Seguí con la tarea» ya existe: es `/flow-next` (RP58).**

**Cuando un agente pregunta.** Una pregunta llega como un diálogo (`select`, `confirm`, `input`, `editor`); la sesión pasa a `asking`, el panel la publica como evento y la página arma una tarjeta. La respuesta la arma la página, nunca el texto del botón, y un diálogo cortado no ofrece aprobar (`public/actions.js:148`). **Los permisos de herramientas llegan por la misma vía**, y la tarjeta es justamente cómo la persona los contesta.

**El estado declarado.** Cada repo puede tener `.panel/state.json` con `working`, `needs-input`, `ready-to-commit`, `ready-to-pr` o `blocked`, un `next` de una línea y un `detail` (`server/state.js:9`). El panel lo lee, lo da por vencido si el repo se movió después y lo usa para habilitar el botón de commit y para marcar «esperando».

**Lo que la página sabe de todos los repos a la vez.** El Resumen (`GET /api/summary`) trae por repo el estado de la sesión (`none`, `free`, `working`, `waiting`), el progreso del roadmap, qué espera, la acción siguiente y un orden de atención, con «Needs attention · N». Los eventos van por una corriente (`GET /api/events`, 8 clientes) y `GET /api/rpc/states` da el estado de todas las sesiones.

**Lo que falta** (inferido, nada lo hace hoy): una sala con sesión viva o con un coordinador; **un lugar donde se junten las preguntas de varios repos** (el Resumen dice «respondé en la sesión» pero no muestra la pregunta; la tarjeta existe solo en el chat de cada repo); dependencias entre repos (RP7, `Bloqueada`: el prefijo `PREFIJO-ID` no coincide con ninguna carpeta y se queda como dato informativo); un registro de lo que se ordenó y por qué; y el significado de «esta sala hoy».

**Precedente.** RP57 («Chat de la sala») se descartó con el rumbo RPC porque dependía de leer la sesión por pantalla, y su nota dice «si se retoma, se redefine sobre RPC»: esto es esa redefinición, con otro alcance (coordinar sesiones de repo, no conversar con una sesión de sala).

## 3. Restricciones duras

De los estudios anteriores y del repositorio:

- **Gentle Pi no permite subagentes dentro de un subagente** (RP107): el Director no puede ser el padre de los agentes de repo dentro de Gentle Pi. Por eso cada repo es una sesión de primer nivel que abre el panel por RPC y puede tener sus propios subagentes (hasta 5 a la vez por sesión).
- **Los mensajes entre sesiones de Gentle Pi son notificaciones, nunca órdenes**, y «aceptado» no es «leído» (RP108): sirven para avisar, no para mandar. Las órdenes del Director deben ser **texto armado por el panel** y enviado con la misma vía que ya usa `/flow-next`.
- **Una orden solo entra en una sesión libre** (`piSend`): el Director no puede «interrumpir» a un agente; si está ocupado, espera o cancela.
- **El panel admite 6 sesiones vivas.** Una sala de más de 6 repos no puede tener a todos abiertos.
- **Los agentes no commitean ni crean ramas** (`AGENTS.md`): el Director no puede ordenar `/flow-commit`, `/flow-pr` ni `/flow-base`; esas órdenes las manda la persona con sus botones.
- **El entorno de una sesión del panel equivale al de la terminal** para Engram (RP110); no hay MCP en ninguna.
- **Lo que no se puede reenviar a una página** (RP107): prompt de sistema, resultados completos, razonamiento y rutas.
- **El costo en dinero no es confiable** (RP107: 0 en 155 de 200 tareas); sí lo son los tokens.

## 4. Arquitecturas comparadas

### A. Director mecánico, dentro del panel (sin modelo)

El Director es código del panel. Abre las sesiones de la sala, ordena `/flow-next` a cada repo cuya puerta lo permita, escucha los eventos, reúne las preguntas en una **bandeja de decisiones** y mantiene un registro. No interpreta nada: aplica reglas fijas.

- **A favor:** es barato (cero tokens), predecible, probable con pruebas automáticas y reutiliza casi todo lo que ya existe (host de sesiones, `piSend`, eventos, Resumen). Cumple a rajatabla «las decisiones son tuyas», porque no tiene cómo decidir.
- **En contra:** no resuelve nada por criterio, así que la mitad «lo técnico lo resuelvo yo» queda reducida a reglas literales; y no redacta resumen ni triage.
- **Riesgo:** bajo. El peor caso es una orden de más a una sesión libre.

### B. Director como una sesión de pi (un agente de modelo)

Una sesión de pi, la del Director, recibe el estado de todos los repos y emite las órdenes. Es lo más parecido a «un asistente que dirige».

- **A favor:** puede razonar sobre dependencias, redactar el resumen, clasificar una duda y proponer la siguiente orden; es lo que la persona imaginó.
- **En contra:** necesita una sesión viva de sala, que hoy el panel no admite (§2): habría que ampliar el host. Gasta tokens todo el tiempo que vigila. Y lo más serio: **un agente de modelo que emite órdenes a otros agentes** mezcla en el mismo canal datos de un repo con instrucciones para otro. El texto libre que produce un agente de repo (un resultado, una pregunta) llega al Director como entrada y puede contener instrucciones: una inyección entre repos. Gentle Pi lo trata como dato (`authority: none`), pero eso no alcanza si el Director las ejecuta.
- **Riesgo:** alto (seguridad y costo), y de verificación difícil.

### C. Híbrido: Director mecánico con un asistente que propone (recomendada)

El **Director es el panel** (la mitad mecánica de A) y se le suma, **al final y como opción**, un asistente de modelo que **solo lee y propone**: redacta «la sala hoy» y sugiere qué ordenar. Toda orden la arma y la manda el panel desde un vocabulario fijo, con la puerta de siempre; el asistente nunca ejecuta ni toca una sesión de repo.

- **A favor:** la parte peligrosa (mandar órdenes y contestar preguntas) queda en código determinista y probable; la parte valiosa y barata de probar (resumen, sugerencias) usa un modelo sin autoridad. Se construye por etapas útiles cada una por sí sola, y la primera no necesita modelo.
- **En contra:** la sugerencia del asistente no es una orden: hace falta un clic de la persona (o una regla que la persona escribió) para que se ejecute. Es más lento que B a cambio de ser seguro.
- **Riesgo:** bajo en las primeras etapas, medio al sumar el asistente.

### Comparación

| | A · mecánico | B · sesión de modelo | C · híbrido |
| --- | --- | --- | --- |
| Quién decide una duda | Nadie (todo a la persona) | El modelo | La persona; lo permitido lo fija una lista suya |
| Costo en tokens | Cero | Continuo | Cero, y bajo si se suma el asistente |
| Resumen y sugerencias | No | Sí | Sí (etapa final) |
| Inyección entre repos | No aplica | **Sí, riesgo alto** | Cerrada: las órdenes salen de plantillas |
| Necesita ampliar el host de sesiones | No | Sí (sala con sesión viva) | No (el asistente va aparte y solo lee) |
| Se prueba con pruebas automáticas | Sí | Poco | La parte que manda, sí |

## 5. Los temas pedidos, uno por uno (sobre la arquitectura C)

**Reparto con dependencias entre repos.** Por repo ya existe la regla `siguiente`. Entre repos hace falta resolver `PREFIJO-ID` (RP7, hoy `Bloqueada`: el prefijo no coincide con ninguna carpeta y haría falta un alias en la configuración) o leer la sección «Dependencias» del `ENLACES.md` de la sala. Se propone empezar leyendo la sala y mostrando «este repo espera a aquel», sin bloquear, igual que hoy con las dependencias externas.

**Contratos entre repos.** Es el caso de más valor para una sala. Viven en la sección «Contratos» de `ENLACES.md`. La primera versión debe **avisar y no bloquear**: cuando el PR de un repo toca un archivo listado como contrato, el Director lo señala en la bandeja para el repo que lo consume. Qué archivos son contrato es un dato que escribe la persona; el panel no lo adivina.

**Verificación y revisión cruzadas.** Se apoya en el botón «Verify» que propone RP108: el Director puede ofrecerlo como acción por repo, pero **ordenarlo solo con un clic** al principio. La revisión de un repo contra lo que otro espera necesita antes los contratos.

**Visibilidad.** La pieza central es la **bandeja de decisiones**: un solo lugar que junta, de todos los repos de la sala, las preguntas pendientes (con su texto y sus opciones, las mismas tarjetas de hoy), los repos en `needs-input` o `blocked`, y los listos para entregar. Es lo primero que se construye, porque da el valor de «un solo lugar» sin ningún modelo. Debajo, un registro de lo que el Director ordenó y de lo que resolvió solo.

**Costo y presupuesto.** Hay tres topes que ya existen y conviene mostrarlos: 6 sesiones del panel, 5 subagentes por sesión (30 procesos hijos en el peor caso) y la cola sin tope de Gentle Pi. El presupuesto debe medirse en **tokens** (los datos de dinero no son confiables). Las unidades de límite del Director son: sesiones abiertas a la vez, un tope de **tres fallos seguidos** por orden antes de parar y no reintentar sin pedido de la persona, y un tope de tokens por sesión: el comando `get_session_stats` de pi devuelve, sin llamar al modelo, `tokens` (entrada, salida, caché y total), `cost` y `contextUsage` (`agent-session.d.ts:204`). Es el dato que haría falta; `cost` en dinero conviene ignorarlo (RP107).

**Cancelación en cascada.** El panel puede abortar una corrida (`/api/rpc/abort`) y cerrar la sesión (`/api/rpc/close`). Al cerrar una sesión de pi se detienen sus tareas en curso y **no se dan por recuperadas** (RP108); `subagent_cancel` solo existe dentro de la sesión padre. Entonces la cascada es: abortar y cerrar la sesión del repo; no hay un nivel más fino desde fuera. «Cancelar» y «abandonar» deben ser acciones distintas, con confirmación de la persona.

**Memoria compartida.** Engram funciona igual en el panel que en la terminal (RP110) y separa por proyecto (por carpeta), así que cada agente de repo conserva su propia memoria sin mezclar contexto. La memoria de la sala sería la del proyecto de la sala. Lo que el Director comparta de un repo con otro debe ser un dato mínimo y explícito (por ejemplo «el contrato X cambió»), nunca la conversación.

**«La sala hoy».** Es una vista derivada, no un estado: se arma con el Resumen (qué se está haciendo y qué espera), los `.panel/state.json` y la bandeja. La primera versión no necesita modelo; el asistente de la etapa final solo la redacta mejor.

**Abrir la sala con una orden.** Existe `POST /api/rpc/start` por repo. Abrir una sala es repetirlo por cada miembro, **de a uno** (el arranque es lento e irregular) y hasta el tope de 6; una sala de más de 6 repos necesita que la persona elija cuáles.

## 6. La regla de escalado, convertida en una política

El Director trata cada cosa que le llega como un **caso** con una **categoría**, y la política dice quién decide. **Todo caso es de la persona salvo que su categoría esté en la lista de permitidas, y esa lista empieza vacía.**

| Categoría del caso | Quién decide | Nota |
| --- | --- | --- |
| Permiso de una herramienta (un diálogo de permiso) | **Siempre la persona** | Nunca se contesta por el Director, ni con asistente |
| Producto, diseño o alcance; un contrato entre repos; seguridad; gasto; cualquier entrega | **Siempre la persona** | Es lo que fijó la ficha (S6) |
| Una duda que el agente de repo no puede resolver con lo que ya hay | La persona | En la duda, pregunta |
| Reabrir una sesión que se cerró por un error | Candidata a la lista permitida | Reversible; se registra |
| Reordenar qué repo sigue primero cuando no hay dependencias entre ellos | Candidata a la lista permitida | Reversible; se registra |
| Reintentar una orden fallida | Candidata, con el tope de tres fallos | Se registra |

Cada vez que el Director resuelve algo solo, escribe en el registro una línea «resolví X porque Y» que la persona puede revisar. La lista permitida vive en la pestaña Settings (RP111b) y **solo la persona la cambia**.

**Texto que cruza entre repos:** las órdenes y los avisos que el Director manda se arman **solo con plantillas del panel** y datos mínimos validados (identificadores, nombres de archivo de la lista de contratos), nunca con el texto libre que escribió otro agente. Es la misma regla que ya aplican `/flow-next` y Gentle Pi: lo que viene de otro agente es dato, no instrucción.

## 7. Dónde viven el registro y la cola

- **Registro de órdenes y de lo resuelto solo:** es un **registro**, no un estado, así que `AGENTS.md` lo permite. No puede ir en `config.json` (es un contrato de configuración) ni en la carpeta de la sala (el panel no la escribe, `server/rooms.js:4`). Lo natural es un archivo propio junto a la configuración del panel, solo de agregado, con tope de tamaño, sin textos de agentes ni rutas. Es una decisión para la persona.
- **La cola de órdenes de la sala:** la sección «Cola» del `ENLACES.md` es de la persona y de los agentes de la sala; el Director debe **leerla** y no reescribirla.
- **Si el panel se reinicia,** las sesiones terminan y vuelven con el mismo `--session-id` (RPC1b); el Director no debe tener estado que se pierda: al volver, recalcula todo desde el roadmap, los `state.json` y el registro.

## 8. Riesgos

- **Costo descontrolado.** Seis sesiones, cada una con hasta cinco subagentes, multiplican los tokens (Claude Code lo advierte de sus equipos de agentes: «significativamente más tokens»). Mitigación: tope de sesiones abiertas, tope de fallos y, si se puede medir, un tope de tokens; el Director no abre sesiones que nadie vaya a usar.
- **Inyección entre repos.** Cerrada con plantillas y con el asistente sin autoridad (§6).
- **Contestar un permiso por error.** Es el daño más grave y el más barato de evitar: los diálogos de permiso nunca pasan por el Director.
- **Estado paralelo.** El Director podría terminar duplicando el roadmap. Mitigación: vista derivada y registro de solo agregado.
- **Arranque lento e irregular de pi.** Abrir de a una y mostrar «iniciando»; no tratar la demora como un fallo antes de tiempo.
- **Privacidad entre repos.** Engram ya separa por proyecto; el Director no copia conversaciones entre repos y respeta la lista de lo que no se reenvía (RP107).
- **Que el Director se vuelva un cuello de botella para la persona.** Si la bandeja crece, el valor se pierde. Mitigación: ordenar por urgencia (el Resumen ya ordena por atención) y mostrar primero lo que bloquea a otros repos.

## 9. Filas propuestas, por etapas

No se agregan al roadmap: las decide la persona. Los IDs se asignan al agregarlas. Cada etapa sirve sola, y las primeras no usan modelo.

| Etapa | Qué entrega | Depende de | Riesgo |
| --- | --- | --- | --- |
| D1 | **Bandeja de decisiones de la sala:** un lugar con las preguntas pendientes de todos los repos de una sala (texto y opciones), los repos en `needs-input` o `blocked` y los listos para entregar; solo lectura al principio | — | Bajo |
| D2 | **Abrir la sala:** un botón que abre la sesión de cada repo miembro, de a una, hasta el tope; sin mandar órdenes | D1 | Bajo |
| D3 | **Seguir con la sala:** `/flow-next` a cada repo cuya puerta lo permita, uno por clic de la persona y luego «a todos»; con las dependencias entre repos mostradas, sin bloquear | D2 | Medio |
| D4 | **Registro del Director y límites:** qué se ordenó y cuándo, tope de fallos (tres), tope de sesiones, y cancelar y abandonar por separado | D3 | Medio |
| D5 | **«La sala hoy»:** una vista derivada del Resumen, los estados y la bandeja | D1 | Bajo |
| D6 | **Contratos entre repos:** leer la sección «Contratos» del `ENLACES.md` y avisar al repo consumidor cuando el PR de otro toca un contrato | D1 | Medio |
| D7 | **Resolución propia con lista permitida:** la persona habilita categorías en Settings y el Director las resuelve y las registra; con verificación independiente | D4, RP111b | Alto |
| D8 | **Asistente de resumen y sugerencias** (una sesión de modelo que solo lee y propone), opcional | D5 | Medio |

Se cruzan con lo que ya propuso RP108: las alertas de sesión (RP112) y el botón «Verify» (RP114) encajan en D1 y D3.

## 10. Lo que queda para decidir

1. **Si el Director arranca sin modelo (A, la primera mitad de C) o se quiere de entrada la sesión de modelo (B).** La recomendación es C: la mecánica primero.
2. **Dónde vive el registro del Director** (§7), y si puede tener tope de tamaño y vencimiento.
3. **Si la sala tiene una sesión propia** (necesitaría ampliar el host de sesiones) **o no**. En C no hace falta: el Director es el panel.
4. **Qué categorías, si alguna, empiezan en la lista permitida.** La recomendación es ninguna.
5. **Qué se hace con una sala de más de 6 repos.**

## 11. Lo que no se pudo verificar

- Nada de lo propuesto se construyó ni se probó; los «bajo, medio, alto» miden el tamaño de lo que hay que construir y el daño posible, no una prueba.
- No se leyeron las pruebas del host de sesiones ni del almacén del Resumen, así que el orden exacto de los eventos y el tope de 20 diálogos pendientes no se confirmaron en pruebas.
- Del comando `get_session_stats` se leyó solo el tipo (`SessionStats`), no se lo llamó: no se sabe si el RPC lo devuelve con esos campos ni cada cuánto conviene consultarlo.
- Los 6 repos por sala y los 5 subagentes por sesión son valores por defecto; no se probó cuánto tarda abrir una sala de seis repos en esta máquina.
- No se vio cómo se comporta el panel ante dos preguntas simultáneas de repos distintos más allá de lo que dice el código.
