# Informe: el entorno de las sesiones del chat frente al de la terminal (RP110)

Informe de solo lectura. No cambia el código del panel y **no gastó tokens de modelo**: no se arrancó ninguna sesión. Responde a la fila RP110 de `docs/ROADMAP.md`: si una sesión que abre el panel carga lo mismo que una de la terminal (herramientas, memoria Engram y MCP), dado que el panel borra del entorno de cada sesión toda variable que empiece con `PI_`, `GENTLE_` o `ENGRAM_` (`server/piruntime.js:13`, `runtimeEnv` en `:61-66`).

- **Cómo se obtuvo:** una exploración de solo lectura del código de `gentle-engram` 0.4.2 y del lanzador de Gentle Shell 4.6.0, la lectura de los archivos de sesión que ya existen (3 del panel y 138 de la terminal) y tres comprobaciones propias de solo lectura. Cada afirmación dice si fue **observada** o **inferida**.
- **Citas de líneas:** comprobé una por una `gentle-engram/index.ts:30-31` y `:2450` y `bin/gentle-shell.mjs:1267`. Las demás salen de la exploración y no las comprobé.

## 1. Conclusiones

1. **La limpieza de variables es hoy neutra.** El lanzador de Gentle Shell vuelve a calcular todas las variables que el panel borra, y la persona no tiene ninguna definida a nivel de Usuario ni de Máquina en Windows (se miraron solo los nombres). Lo que se ve en el entorno de una sesión lo puso el propio lanzador.
2. **Engram carga igual en el panel y en la terminal.** Las sesiones del panel y las de la terminal tienen registradas las mismas herramientas (36 a 37 nombres), incluida `mem_save`; ninguna dice «memory disabled».
3. **No hay herramientas MCP en ningún lado, ni en la terminal.** `settings.json` desactiva el MCP integrado de Pi (`-builtin:mcp`) y no hay un adaptador instalado que lo reemplace. Es una decisión de configuración de la persona, no un efecto del panel.
4. **Lo único que el panel pisaría** son valores que la persona definiera a mano (`GENTLE_SHELL_HOME`, `ENGRAM_PORT`, `ENGRAM_URL`, `ENGRAM_BIN`, `ENGRAM_DATA_DIR`...). Hoy no existe ninguno.
5. **No se probó en vivo que Engram guarde y recupere desde el panel.** Los archivos de sesión del panel son chicos (2 y 7 llamadas de herramienta en total, ninguna a `mem_*`): no prueban ni refutan que funcione. Probarlo gasta tokens y necesita autorización aparte.
6. **Aviso de seguridad, ajeno al panel:** `C:\Users\victor\.gentle-shell\agent\mcp.json` guarda en texto plano el valor de `FIGMA_API_KEY` en el bloque `env` del servidor `figma`. No se reproduce aquí. Ese archivo es un secreto en disco: conviene moverlo a una variable de entorno de usuario y rotarlo si el archivo se compartió alguna vez. El panel no lo lee.

## 2. Evidencia

### 2.1 Qué borra el panel

Observado: `SCRUB = /^(PI_|GENTLE_|ENGRAM_)/i` (`server/piruntime.js:13`); `runtimeEnv` copia el entorno sin esas variables y, solo para el pi original, fija `PI_CODING_AGENT_DIR` al `agentDir` configurado.

### 2.2 Qué lee Engram (`gentle-engram` 0.4.2, `index.ts`)

| Variable | Si falta |
| --- | --- |
| `ENGRAM_PORT` (`:24`) | usa 7437 |
| `ENGRAM_URL` (`:25-26`) | usa `http://127.0.0.1:<puerto>`; sin servidor lanza `engram serve` (`:1038`), y si hay uno ajeno no lo adopta |
| `ENGRAM_BIN` (`:27`) | busca `engram` en el `PATH`; si no lo encuentra avisa y reintenta (`:743`, `:1113`) |
| `ENGRAM_STARTUP_POLICY` (`:30-31`) | si falta, el arranque está permitido; cualquier valor distinto de `allow` lo desactiva |

Observado: con la política desactivada el plugin registra solo el estado `🧠 memory disabled` y no registra las herramientas `mem_*` (`:2447-2456`; el estado en `:2450`). El plugin no lee ningún archivo de usuario; solo, como respaldo, `.engram/config.json` buscando hacia arriba desde el directorio de trabajo. El nombre del proyecto lo decide primero el servidor (`GET /project/current?cwd=`), después `project_name` del archivo, y por último el nombre de la carpeta.

### 2.3 Qué fija el lanzador para su hijo (de la exploración)

El lanzador (`gentle-shell.cmd`, que ejecuta `gentle-pi/bin/gentle-shell.mjs`) fija `PI_CODING_AGENT_DIR`, `GENTLE_PI_AGENT_HOME`, `GENTLE_SHELL_USER_PI_HOME`, `PI_PROGRAM_STATUS_APP`, `GENTLE_SHELL_PREFIX`, `PI_SKIP_VERSION_CHECK` y `GENTLE_PI_AGENTS_PI`, y calcula `ENGRAM_URL`, `ENGRAM_BIN` y `ENGRAM_STARTUP_POLICY` justo antes de lanzar Pi (sondea `127.0.0.1:7437` y arranca Engram si no está). Solo sondea si la persona no puso variables `ENGRAM_*` de selección: tenerlas puestas **desactivaría** ese cálculo. Por eso borrarlas es neutro o incluso favorable. Es lectura de código; no se ejecutó el lanzador.

### 2.4 Sesiones reales del panel y de la terminal

Medido sobre 141 archivos de sesión (3 con id `panel-*`, 138 de la terminal). En el prompt de sistema de cada sesión:

| Sesión | Herramientas del prompt | `mem_save` | Aviso «memory disabled» | Herramientas MCP |
| --- | --- | --- | --- | --- |
| Panel, repo-panel | 37 | sí | no | ninguna |
| Panel, otro repo | 37 | sí | no | ninguna |
| Panel, de prueba | 36 | sí | no | ninguna |
| Terminal, reciente | 37 | sí | no | ninguna |
| Terminal, otra | 36 | sí | no | ninguna |

La diferencia entre una sesión del panel y una de la terminal de la misma época es **vacía** en ambos sentidos. Límite: la lista sale del texto del prompt; una herramienta registrada por otro medio no aparecería, y las sesiones comparadas son de antes de las últimas herramientas (ninguna lleva `subagent_run`).

### 2.5 MCP

Observado: `settings.json` lista `extensions: ["-builtin:codemode", "-builtin:mcp", …/claude-usage.ts]` y `packages` con `gentle-engram`, `pi-web-access`, `pi-btw`, `pi-claude-bridge` y `flow-skills`; no está `pi-mcp-adapter`. El lanzador avisa por la salida de error cuando se da esa situación: «Pi built-in MCP is disabled… servers in mcp.json will not load» (`bin/gentle-shell.mjs:1267`). `mcp.json` declara `atlassian` y `figma`; ninguno depende de variables `PI_*`, `GENTLE_*` ni `ENGRAM_*`. `mcp-cache.json` guarda herramientas de `grafana`, que ya no está en `mcp.json` (restos). Inferido: con esta configuración no carga ningún servidor MCP, ni en la terminal.

### 2.6 Lo que el panel puede ver de una sesión sin llamar al modelo

Observado (`rpc-types.d.ts`): `get_state` (modelo, estado de la sesión y cantidad de mensajes), `get_commands` (comandos de extensiones, prompts y skills, con su origen), `get_available_models`, `get_session_stats` y los de historial. **No existe ningún comando que liste herramientas ni servidores MCP**, y `get_state` no dice si Engram está cargado. Lo que sí delata el estado de la memoria son los eventos de interfaz de extensión (`setStatus("engram", …)` y `notify`): con la memoria desactivada llega «🧠 memory disabled». Hoy la lista blanca del panel (`server/rpchost.js`) no deja pasar esos eventos a la página.

## 3. Propuesta mínima

- **No cambiar la limpieza del entorno por ahora.** Es neutra; una lista de variables permitidas solo hace falta si la persona empieza a definir variables propias. Si llega el momento, que la lista sea explícita, configurable (pestaña Settings) y que el valor nunca se muestre en la página.
- **Mostrar el estado de la memoria sin leer el entorno**, a partir del evento de estado del plugin: si llega «memory disabled» se avisa en el chat; si no llega, no se afirma nada.
- **MCP:** si la persona quiere MCP, hay que instalar un adaptador y quitar el `-builtin:mcp` de `settings.json`; es configuración de Gentle Shell, fuera del panel.
- **Antes de dar por probada la memoria desde el panel**, una prueba viva con una sesión descartable que guarde y recupere una nota (gasta tokens, necesita autorización).
- Con esto, **RP110b** puede achicarse a: el indicador del estado de la memoria y, solo si hace falta, la lista permitida detrás de Settings. RP109 (el Director) ya no necesita esperar a un arreglo del entorno.

## 4. Lo que no se pudo verificar

- Guardar y recuperar una memoria desde una sesión del panel (no se arrancó ninguna sesión).
- Si el plugin de memoria emite hoy `setStatus` con la política `allow`, y qué texto.
- El entorno real del proceso del panel cuando arranca (se miraron las variables a nivel de Usuario y de Máquina, no las de un proceso concreto).
- Qué extensión cargaría los servidores de `mcp.json`, si alguna; y quién lee `trust.json`.
- Otras versiones de Gentle Shell o de `gentle-engram`: solo 4.6.0 y 0.4.2.
