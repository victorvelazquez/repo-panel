# Estudio: usos posibles de los subagentes en el panel (RP108)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP108 de `docs/ROADMAP.md`: qué hacen otras herramientas (Claude Code, la herramienta anterior de terminales y worktrees, y Gentle Pi) con los subagentes y qué podría hacer el panel con ellos. Parte de `docs/ESTUDIO-subagentes.md` (RP107): el modelo de Gentle Pi es plano, el estado en vivo está en `presence`, y hay campos que no se pueden reenviar a la página.

- **Cómo se obtuvo:** dos exploraciones de solo lectura (la herramienta anterior y Gentle Pi), la documentación oficial de Claude Code leída hoy, y el código del propio panel. Cada afirmación dice de dónde sale.
- **Lo que no se hizo:** no se ejecutó nada de la herramienta anterior (no se corrió su comando), no se probó ninguna de las posibilidades y no se midió costo real.

## 1. Conclusiones

1. **Las tres herramientas resuelven el mismo problema de tres maneras.** Claude Code: subagentes dentro de la sesión, sesiones en segundo plano con una pantalla común y un modo experimental de equipos. La herramienta anterior: un coordinador con tareas, mensajes y puertas de decisión sobre terminales y worktrees. Gentle Pi: subagentes con tope de concurrencia, reglas de cuándo delegar y verificación independiente.
2. **Hay una diferencia que decide el diseño del Director:** Claude Code permite subagentes anidados (hasta tres niveles); Gentle Pi no (un hijo no puede lanzar subagentes). Para la idea de la persona (el Director ordena abrir una sesión en cada repo, y cada repo tiene su agente principal) eso es una ventaja: cada repo es una sesión de primer nivel y no hace falta anidar.
3. **Casi todo lo que hace valioso a un coordinador ya existe como idea probada:** reaccionar a eventos y no sondear, un identificador de tarea y de intento en cada orden, preguntas con opciones que bloquean hasta que la persona decide, un tope de fallos y no recuperar sin prueba. la herramienta anterior lo hace así y coincide con la regla del proyecto de que las decisiones son de la persona.
4. **Lo más barato y de más valor no necesita subagentes:** avisar cuando una sesión necesita una respuesta, terminó o falló. El panel ya recibe esos eventos.
5. **Lo más caro y riesgoso es crear worktrees por tarea:** choca con la regla de este repositorio (los agentes no crean ni cambian ramas; entrega la persona con `/flow-*`).

## 2. Qué hacen las otras herramientas

### 2.1 Claude Code (documentación oficial, leída hoy)

Fuentes: `code.claude.com/docs/en/sub-agents`, `/agents`, `/agent-teams` y `/worktrees`.

- **Subagentes personalizados:** un archivo Markdown con `name` y `description` obligatorios, y campos opcionales `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `permissionMode`, `memory`, `background`, `isolation: worktree`, `hooks` y `skills`.
- **Primer plano y segundo plano.** En primer plano bloquea la conversación y los pedidos de permiso pasan a la persona; en segundo plano corren a la vez y los pedidos de permiso aparecen en la sesión principal nombrando al subagente. Los subagentes que lanza la sesión principal arrancan en segundo plano por defecto.
- **Anidado:** sí, hasta tres capas bajo la conversación principal; se cambia con `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (1 lo apaga).
- **Seguir con uno ya terminado:** se le manda un mensaje (`SendMessage`, con su identificador o nombre) y retoma con su historial completo.
- **Dónde queda:** `~/.claude/projects/{proyecto}/{sesión}/subagents/agent-{id}.jsonl`, con un `.meta.json` del nombre; se borran a los 30 días. El padre recibe el resumen final y un identificador.
- **Límites:** 20 subagentes corriendo a la vez por defecto (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`); no hay tope de costo, y cada subagente gasta sus propios tokens.
- **Ganchos:** `SubagentStart` y `SubagentStop`, que permiten llevar un registro de cada uno desde fuera.
- **Vista de agentes** (`claude agents`, vista previa de investigación): una pantalla para lanzar y vigilar sesiones en segundo plano, con el estado de cada una y cuáles necesitan una respuesta. Una sesión lanzada desde ahí se mueve a su propio worktree antes de editar, e informa «solo a la persona». También hay mensajes entre sesiones, en esta máquina, en otra o en la nube.
- **Equipos de agentes** (experimentales, apagados por defecto): una sesión líder y compañeros, con una lista de tareas compartida (pendiente, en curso, completada, con dependencias) y buzones. Los pedidos de permiso de los compañeros aparecen en la sesión líder. Usan «significativamente más tokens», se sugieren 3 a 5 compañeros, no se anidan y no se aíslan en worktrees (hay que repartir los archivos).
- **Flujos dinámicos:** un guion que lanza muchos subagentes y contrasta resultados; `/batch` parte un cambio en 5 a 30 subagentes aislados en worktrees.

### 2.2 La herramienta anterior de terminales y worktrees (la que la serie RPC reemplazó)

Las tres skills locales son solo un cartel que remite a un comando de la propia herramienta, y no se ejecutó ese comando: lo que sigue puede diferir de la versión instalada.

- **Conceptos:** worktree (con un estado de trabajo y un punto de «no leído» para llamar la atención de la persona), terminal (`list`, `read`, `send`, `wait`), agente (`agent launch`, con `--model` y `--effort`), y una capa de **orquestación**: corrida, tarea (pendiente, lista, despachada, completada, fallida, bloqueada, con dependencias), despacho (un intento de una tarea), mensajes (`status`, `dispatch`, `worker_done`, `escalation`, `question`, `heartbeat`) y **puertas de decisión**: «una pregunta del coordinador que bloquea una tarea hasta que se resuelve».
- **Supervisión:** el coordinador no sondea; termina su turno y la herramienta lo despierta con `worker_done`, `escalation` o `question`. Para redirigir manda un mensaje al despacho; para cancelar, `worker-stop`, que termina en `stop_unknown` si no puede probar que el agente paró. Prohíbe redirigir escribiendo en la terminal del trabajador.
- **Preguntas:** un trabajador usa `ask` con opciones y plazo, termina su turno y recibe la respuesta; el coordinador contesta solo si la respuesta sale de la tarea o de las instrucciones de la persona, y si no, pregunta primero a la persona.
- **Aislamiento:** cada trabajador recibe su propio checkout (`worker-start --worktree new-child`); el coordinador no crea checkouts por su cuenta. Traspaso completo a otro agente: `worktree create --no-parent --agent … --prompt`, sin esperar al receptor.
- **Fallos:** el silencio, un plazo vencido o un estado no verificable «nunca prueban la salida ni autorizan la recuperación autónoma»; un reintento lleva el identificador del intento para que uno viejo no complete el equivocado; tras tres arranques fallidos en una cadena el despacho se corta y la tarea falla, y solo se reabre si la persona lo pide.
- **Latidos:** cada 5 minutos por defecto, de 1 a 60 o apagados.
- **Costo y concurrencia:** no hay nada de tokens ni de tope de concurrencia en las guías leídas.
- **Qué perdió el panel al dejar esa herramienta** (`odd/tasks/rpc.md`, L1, L2 y L14): necesitaba entorno gráfico y el servidor en la nube sería solo de línea de comandos. Se perdió el indicador de sala activa, la lectura de las sesiones que la persona abre a mano en terminales, los analizadores de pantallas y la sala que orquesta. Sigue sin existir en el panel: worktrees por tarea, grafo de tareas, buzón entre agentes, latidos, puertas de decisión, reintento con corte y traspaso entre agentes de distinto tipo.

### 2.3 Gentle Pi 4.6.0 (paquete y carpeta de usuario)

- **Catálogo:** 13 agentes. De solo lectura: `gentle-ai-explore`, `gentle-ai-verify` (sin editar el repo), los jueces y las lentes de revisión. Con escritura: `gentle-ai-worker` (sin commit, stage ni push) y `jd-fix-agent`; y los tres de entrega, `flow-commit`, `flow-pr` y `flow-base`, que mutan Git a través del runtime y se autorizan con la invocación manual de la persona.
- **Herramientas del padre:** `subagent_run` (`task` o `background`), `status`, `result`, `list_tasks`, `send_message` (dirige a uno que corre, antes de su próxima llamada al modelo), `reply` (una sola vez a la consulta de un hijo), `cancel` y `continue`.
- **Límites configurables** (`subagents.json`, el del proyecto gana): 5 tareas a la vez (`max_concurrency`; las demás se encolan, sin tope de cola), 4 minutos de silencio (30 con una herramienta en curso) y 200 tareas guardadas. No hay un plazo absoluto por tarea.
- **Cuándo delegar** (política de instrucciones, no de código, salvo lo marcado): explorar si hace falta más de una tanda de lecturas; escritores en paralelo solo con superficies de edición disjuntas que el runtime hace cumplir, o con worktrees; un verificador independiente solo si se nombra un ítem de alto riesgo. Es la política que un Director podría heredar.
- **Revisión:** la revisión nativa es una vista externa más y nunca autoriza la entrega; los bloqueos hacia la persona se retransmiten completos, sin resumir; una pregunta sin interfaz detiene el trabajo.
- **Sesiones entre sí:** `orchestrator_*` publica una nota curada (`authority: none`, `ownerReply: false`) y entrega mensajes como **notificaciones, nunca órdenes**; «aceptado» no es «leído».
- **Fallos:** un hijo en segundo plano no puede mostrar diálogos a la persona (solo en `task`); un padre ocupado recibe las completiones como avisos compactos tras 90 s; al cerrar la sesión las tareas en curso se detienen y «nunca se dan por recuperadas».

### 2.4 Comparación

| | Claude Code | Herramienta anterior | Gentle Pi |
| --- | --- | --- | --- |
| Anidado | Sí (3 niveles) | Coordinador y trabajadores | **No** (modelo plano) |
| Concurrencia | 20 subagentes | Sin tope en las guías | 5 (configurable) |
| Estado en vivo | Vista de agentes, ganchos | `worker-list` con `liveness` | `presence` en disco (RP107) |
| Cancelar | Detener desde la vista | `worker-stop` | `subagent_cancel` (solo desde la sesión padre) |
| Mensaje a uno en curso | `SendMessage` | `send` al despacho | `subagent_send_message` |
| Pregunta a la persona | Pedidos de permiso en la sesión principal | Puerta de decisión | `subagent_reply` y bloqueo retransmitido |
| Aislamiento de archivos | `isolation: worktree` | Un worktree por trabajador | Superficies disjuntas o `workspace_root` |
| Costo | Sin tope; el uso se multiplica | No tratado | No tratado (tokens en la tarea; dinero poco confiable) |

## 3. Qué podría hacer el panel

Cada posibilidad se mide con tres cosas: **valor** (qué cambia para la persona), **costo** (cuánto hay que construir, según lo que ya existe) y **riesgo** (con los ítems del proyecto). «Dato» dice de dónde saldría la información, según RP107.

| # | Posibilidad | Valor | Costo | Riesgo | Dato y notas |
| --- | --- | --- | --- | --- | --- |
| P1 | **Alertas**: avisar cuando una sesión necesita una respuesta, terminó o falló | Alto | Bajo | Bajo | Eventos RPC que el panel ya recibe (`dialog`, `agent_settled`, error, reintento); no necesita subagentes |
| P2 | **Chip de subagente enriquecido** y línea de fin de un trabajo en segundo plano | Medio | Bajo | Bajo | `details.gentleAgents` del archivo del padre (ya se lee); sin copiar texto del resultado |
| P3 | **Tira «Subagents»** mientras hay trabajo en curso | Medio | Medio | Medio | `presence` (latido de 15 s o menos); solo `summary`, nunca `thread` |
| P4 | **Verificación independiente desde una tarjeta** | Alto | Medio | Bajo | Una orden a la sesión del repo para lanzar `gentle-ai-verify` sobre la rama; reutiliza el mecanismo de órdenes de `/flow-*`; el verificador es de solo lectura |
| P5 | **Subagentes de esta sesión** y ver la conversación del hijo | Medio | Medio | Medio | `tasks\<id>.json` (solo campos permitidos) y el `.jsonl` del hijo con el mismo visor; detrás de un interruptor en Settings |
| P6 | **Tokens y duración por subagente** | Bajo | Bajo | Bajo | `tokens` es confiable; el dinero **no** (0 en 155 de 200 tareas) |
| P7 | **Cancelar un subagente o mandarle un mensaje** | Medio | Medio | Medio | No hay interfaz externa: solo pidiéndoselo a la sesión padre («cancelá la tarea X»); con confirmación; sin recuperación autónoma |
| P8 | **Ejecución en paralelo por sala** (el Director) | Alto | Alto | Alto | Depende de RP109 y RP110; el panel hoy admite 6 sesiones; costo en tokens se multiplica; conflictos entre repos |
| P9 | **Lanzar una fila del roadmap en un worktree aislado** | Alto | Alto | Alto | **Choca con la regla del repositorio** (nadie salvo `/flow-*` crea ramas); haría falta un flujo de entrega nuevo y la decisión de la persona |

Ideas de la herramienta anterior que valen como regla para cualquier posibilidad que mande órdenes: un identificador de tarea y de intento en cada orden, pregunta con opciones que bloquea hasta que decide la persona, un tope de tres fallos antes de parar, «silencio no prueba nada», y separar cancelar de abandonar.

## 4. Orden recomendado y filas propuestas

Se proponen en el orden de menor riesgo y mayor valor por costo. No se agregan al roadmap: las decide la persona (RP109 y RP110 siguen abiertas y cambian lo de abajo).

| Fila propuesta | Qué entrega | Depende de |
| --- | --- | --- |
| RP112 | **Alertas de sesión** (P1): título de la pestaña, contador y notificación del navegador cuando una sesión pide una respuesta, termina o falla | — |
| RP113 | **Chip de subagente y fin de trabajo en segundo plano** (P2) | — |
| RP114 | **Botón «Verify»** en la tarjeta (P4): ordena a la sesión del repo lanzar el verificador independiente | RP113 |
| RP115 | **Tira «Subagents» en curso** (P3) | RP113 |
| RP116 | **Subagentes de la sesión, con tokens y duración, y ver al hijo** (P5 y P6), detrás de un interruptor en Settings | RP115 |
| RP117 | **Cancelar o mandar un mensaje a un subagente** (P7), por pedido a la sesión y con confirmación | RP116 |

P8 y P9 quedan para después de RP109 (el Director) y exigen una decisión de la persona sobre la regla de ramas.

## 5. Lo que esto significa para RP109 (el Director)

- **Arquitectura confirmada por la persona:** el Director manda la orden de abrir una sesión en cada repo y cada repo tiene su agente principal. Es una sesión de primer nivel por RPC; puede tener sus propios subagentes, sin anidar nada en Gentle Pi.
- **Modelo de la herramienta anterior para el coordinador:** no sondea, reacciona a eventos; cada orden y cada reporte llevan identificador de tarea y de intento; una pregunta de un agente de repo llega al Director con opciones, y **el Director solo contesta lo que sale de las instrucciones; si no, se lo pregunta a la persona** (que es la regla de RP109).
- **Límites a fijar:** concurrencia (el panel admite 6 sesiones; Gentle Pi 5 subagentes), un tope de fallos y un presupuesto de tokens por corrida.
- **La entrega sigue siendo de la persona:** los agentes dejan el trabajo en `ready-to-commit` y no crean ramas.
- **Lo que no existe y habría que construir:** el buzón entre el Director y los agentes de repo (Gentle Pi solo ofrece notificaciones entre sesiones, que no son órdenes), el registro de lo que el Director resolvió solo, y las puertas de decisión visibles en el panel.

## 6. Lo que no se pudo verificar

- La herramienta anterior: se leyó su documentación pública y no el programa instalado, y no se leyeron las guías de ubicación remota, automatizaciones y mensajería; puede diferir de la versión local.
- Claude Code: la vista de agentes es una vista previa y los equipos son experimentales; sus detalles pueden cambiar. De la vista de agentes no se leyeron las acciones exactas (observar, responder, detener).
- Gentle Pi: solo la versión 4.6.0; no se vio el valor efectivo de la política de segundo plano.
- Costos reales de cualquier posibilidad: no se midieron; las estimaciones de «bajo, medio y alto» son del tamaño de lo que hay que construir, no de una prueba.

## 7. Fuentes

- Claude Code: `https://code.claude.com/docs/en/sub-agents`, `https://code.claude.com/docs/en/agents`, `https://code.claude.com/docs/en/agent-teams`, `https://code.claude.com/docs/en/worktrees`.
- La herramienta anterior: sus guías públicas (nombre y enlaces en la ficha `odd/tasks/chat-alcance.md`, entrada L13) y `odd/tasks/rpc.md` de este repositorio.
- Gentle Pi: `extensions/gentle-agents.ts`, `lib/agents-*.ts`, `lib/orchestrator-*.ts`, `assets/orchestrator*.md` y `docs/gentle-agents-activity.md` del paquete 4.6.0; `subagents.json` de la carpeta de usuario.
- Este repositorio: `docs/ESTUDIO-subagentes.md`, `server/rpchost.js` y `odd/tasks/chat-alcance.md`.
