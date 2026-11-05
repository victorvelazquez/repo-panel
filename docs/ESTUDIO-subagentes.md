# Estudio: cómo quedan registrados los subagentes en disco (RP107)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP107 de `docs/ROADMAP.md`: dónde guarda Gentle Shell a los subagentes (sesión propia, enlace con la sesión padre, estado, duración, resultado) y qué se puede mostrar de eso en el chat del panel.

- **Versión estudiada:** gentle-pi 4.6.0, dentro de Gentle Shell 4.6.0-1.5.0, en Windows.
- **Cómo se obtuvo:** una exploración de solo lectura de los archivos de `C:\Users\victor\.gentle-shell\agent\` y del código de gentle-pi, más tres scripts míos de solo lectura para medir (sobre 200 tareas reales y 15 sesiones padre de este repo). Cada afirmación dice si fue **observada** (con ejemplo o línea de código) o **inferida**.
- **Citas de líneas:** salen de la exploración. Comprobé una por una `agents-runner.ts:333`, `agents-runner.ts:257`, `gentle-agents.ts:422`, `gentle-agents.ts:90`, `orchestrator-presence.ts:43` y `orchestrator-presence.ts:208`; las demás no.

## 1. Conclusiones

1. **La hipótesis del inicio era solo en parte cierta.** Sí: cada subagente corre en su propia sesión, en un archivo aparte. Pero el padre ve bastante más que el chip `subagent_run`: guarda el resultado de cada tarea y los avisos que el hijo le manda.
2. **Hay tres fuentes, de distinto costo y distinta privacidad.** El archivo del padre (ya lo lee el panel), un archivo por tarea terminada (`gentle-agents\tasks\<id>.json`) y un registro de presencia para las tareas en curso (`gentle-agents\presence\`).
3. **El enlace es sólido:** `parentSessionId` de la tarea es el id de la cabecera del archivo de sesión del padre (151 de 200 tareas medidas se enlazan a archivos de esta carpeta; el resto son de otras carpetas).
4. **El modelo es plano:** un hijo no puede lanzar subagentes. No existen nietos.
5. **Casi todo lo que hay en esos archivos es privado** (prompt de sistema, salida de herramientas, razonamiento, rutas). Lo que se puede enviar a la página es una lista corta de campos.

## 2. Evidencia por punto

### 2.1 ¿Un archivo por subagente?

**Observado: sí.**
- Cada hijo es un proceso `pi --mode rpc --session-dir <gentle-agents>\sessions` (`lib/agents-runner.ts:333`). Su sesión es un `.jsonl` plano, **fuera** de `agent\sessions\--<carpeta>--\`.
- Nombre: `<timestamp>_<uuid7>.jsonl`. La primera línea es la cabecera mínima de siempre y **no trae ningún dato del padre, de la tarea ni del agente**: `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`.
- Los mensajes del hijo no se copian en el archivo del padre.
- `subagent_continue` reutiliza el mismo archivo (`--session <sessionPath>`): un archivo de hijo puede servir a varias tareas.
- Medido: las 200 tareas guardadas tienen `sessionPath` y las 200 rutas existen.

### 2.2 El vínculo tarea ↔ padre ↔ llamada

**Observado.** El vínculo vive en `gentle-agents\tasks\<taskId>.json`, que se escribe **una sola vez, al terminar** la tarea. Campos de la tarea (medido en un archivo real):

| Campo | Qué es |
| --- | --- |
| `id`, `agent`, `mode` (`task` o `background`), `label`, `cwd` | quién es |
| `parentSessionId` | el id de la sesión padre (cabecera de su `.jsonl`) |
| `status` | `queued`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `timed_out` |
| `createdAt`, `startedAt`, `endedAt`, `lastActivityAt` | tiempos en milisegundos; **no hay campo de duración**, sale de `endedAt - startedAt` |
| `model`, `modelSource`, `thinking`, `turns`, `toolCalls`, `tokens`, `cost` | uso |
| `sessionPath` | el archivo del hijo |
| `prompt`, `result`, `error`, `lastStep` | texto (privado salvo `lastStep`) |

Datos medidos sobre las 200 tareas guardadas: 198 `completed` y 2 `cancelled`; 188 `task` y 12 `background`; la duración mediana es de **91 s**, el percentil 90 de 197 s y el máximo de 3144 s. Todas tienen `tokens`, pero el **`cost` en dinero es 0 en 155 de 200** (el proveedor `claude-bridge` no lo informa): para mostrar uso conviene `tokens`, no dinero.

**Desde el archivo del padre** (el panel ya lo lee):
- La llamada es un mensaje del asistente con un bloque `toolCall` de nombre `subagent_run` (argumentos: `agent`, `task`, `mode`, `label`).
- Su `toolResult` trae `details.gentleAgents`: `{ taskId, agent, status, mode, cwd, label, turns, toolCalls, lastStep, model, thinking }` y, si hay error, `error`. Lo arma `taskDetails()` en `extensions/gentle-agents.ts:422`. Con `mode: "background"` el `status` ahí es `queued` o `running` **al momento de lanzar**: no se actualiza.
- `subagent_status` y `subagent_result` devuelven el mismo `details`; `subagent_continue` devuelve uno con un **taskId nuevo**. `subagent_list_tasks`, `subagent_cancel`, `subagent_send_message` y `subagent_reply` devuelven solo texto, sin `details`. (Esto último sale del código, no hay ejemplos reales de esas llamadas.)
- Al terminar una tarea el runtime agrega al padre una entrada `custom_message` `gentle-agents.result` (`extensions/gentle-agents.ts:90`) con el mismo `details` y, en `content`, **el resultado completo**.

**Otras entradas `gentle-agents.*` del padre** (observadas): `message` (avisos del hijo; si el hijo pregunta, `display: true`), `stale-result` y `stale-notice` (el resultado llegó con el padre ocupado), `wake-identity` (reconoce el mensaje de despertar), `orchestrator-message` (mensajes entre sesiones) y `published-state` (una foto del trabajo **de la sesión**, no de una tarea; es la más numerosa: 1039 de 20 139 entradas).

### 2.3 Las tareas en curso

**Observado.** El estado vivo no está en `tasks\` (esos archivos nacen al terminar) sino en `gentle-agents\presence\`, publicado por `PresencePublisher` (`lib/orchestrator-presence.ts`). Hay tres archivos por sesión y arranque: `<sha256(sessionId)>.<incarnation>.{header,activity,discovery}.json`.
- `header` (≤16 KiB): `label`, `heartbeat`, `generation` y `counts: { running, queued, waiting, finished }`.
- `activity`: una lista de tareas con `summary: { id, agent, label, status, model, createdAt, startedAt, endedAt, lastActivityAt }` y un `thread` con los pasos.
- El `heartbeat` se renueva cada 5 s; un lector lo da por vivo si tiene **15 s o menos**.
- El panel puede calcular el nombre del archivo: `sessionHash` es el `sha256` en hexadecimal del id de la sesión (`lib/orchestrator-presence.ts:43`), y ese id está en la cabecera de su `.jsonl`. Comprobado: coincide en 8 de los 15 padres de esta carpeta; los otros 7 ya no tienen archivo de presencia.
- **Limpieza:** solo cierra bien el proceso que cierra bien. Los lectores no borran nada (`lib/orchestrator-presence.ts:208`). Medido hoy: **76 headers, 5 vivos**. Un header obsoleto sigue diciendo `running` aunque el proceso haya muerto: hay que mirar siempre el `heartbeat`.
- Otro canal, no de disco: con `GENTLE_SHELL_INTERACTIVE_HOST=1`, un host RPC recibe un widget `gentle-agents.activity/v1` (documentado en `docs/gentle-agents-activity.md` de gentle-pi). El panel es un host RPC: **está por verificar** si ya lo recibe en los eventos que hoy descarta la lista blanca.

### 2.4 Las demás sesiones del perfil

`orchestrator_list` lee esos mismos archivos de presencia más un catálogo; `orchestrator_send_message` entrega por un socket (en Windows, una tubería con nombre) y "aceptado" no significa leído. Hay ~28 registros en `transport\presence\`, casi todos viejos; no hay evidencia de limpieza en Windows. Es un canal de mensajes, no de estado: no lo necesita el panel.

### 2.5 Subagentes en segundo plano

Observado: al terminar, el runtime guarda `gentle-agents.result` en el padre **antes** de despertarlo. El despertar es un mensaje de rol `user` ("[System-generated Gentle Agents notification…] [gentle-agents wake: <nonce>]"), y se guarda también `gentle-agents.wake-identity` para reconocerlo. Es el mensaje que aparece en este chat cuando termina un trabajo.

### 2.6 Anidamiento

**Observado en el código: un hijo no puede lanzar subagentes.** El proceso hijo arranca como hijo (`GENTLE_PI_AGENTS_CHILD=1`; ver `extensions/child-safety.ts:14`) y la extensión de agentes solo le registra `subagent_parent_message`; además las herramientas que recibe son una lista explícita. Los agentes del perfil dicen "Never delegate". No hay tope de profundidad porque no hace falta, y por eso **no hay enlace de nietos**: solo `parentSessionId`.

### 2.7 Tamaños y qué no se debe reenviar

Medido sobre las 15 sesiones padre de esta carpeta (20 139 entradas): `message` del asistente 6734, `toolResult` 7342, `custom` 3193, `custom_message` 1538. Las entradas `gentle-agents.*` son **1087, el 5,4 %**, y casi todas son `published-state` (1039); las de tarea son pocas (`result` 14, `message` 16). Un archivo de tarea pesa en promedio **54 KB** y llega a 531 KB, en una sola línea: **no conviene leer 200 por cada consulta**.

**No reenviar a la página** (observado): el prompt de sistema (`message.role: "system"` del padre y del hijo); `prompt` y `result` de la tarea y el `content` de `gentle-agents.result`; el razonamiento (`thinking`); el `thread` de la tarea y de `presence\*.activity.json`, que lleva la salida de cada herramienta (el propio código avisa que es una lista blanca de campos y no una limpieza: "retained text can contain secrets"); `data.evidence` de `gentle-pi.session-change/v1`, con el contenido completo de los archivos editados; y las rutas absolutas (`cwd`, `sessionPath`, `workspace`, `root`).

## 3. Qué se puede mostrar, y de dónde

| Dato | Fuente | Costo de leerlo | Privacidad |
| --- | --- | --- | --- |
| Que hubo un subagente, su nombre (`agent`), su `status` al terminar, vueltas y llamadas | `details.gentleAgents` del `toolResult` y de `gentle-agents.result` en el archivo del padre | **Ninguno nuevo**: el panel ya lee ese archivo | Bajo, si solo se sacan esos campos |
| Cuánto tardó (foreground) | `durationMs` del `toolResult` | Ninguno | Bajo |
| Cuánto tardó (background), tokens, modelo, estado final | `tasks\<id>.json` (solo esos campos), bajo demanda | Medio: 54 KB por tarea | Medio: el archivo trae `prompt`, `result` y `thread`; hay que parsear y descartar |
| Qué hay en ejecución ahora | `presence\<hash>.<incarnation>.header.json` (conteos) y `activity.json` (solo `summary`) | Bajo para el header, alto para `activity` si crece | Medio: `activity` trae `thread` con salidas |
| Qué hizo el hijo por dentro | su `.jsonl` (`sessionPath`) con el mismo `readChat` | Bajo (ventana de 512 KB) | Igual que el chat: solo texto, nombres de herramienta y las reglas de RP105 y RP106 |

## 4. Propuesta de pantalla

Tres niveles, de menor a mayor esfuerzo y riesgo. Cada nivel es útil solo.

**Nivel 1: el chip dice qué subagente fue.** Sin lectura nueva. Hoy el chip dice `✓ subagent_run flow-commit 2m40s`; pasaría a mostrar también el estado final y las vueltas, y una nota en la línea de tiempo cuando termina un trabajo en segundo plano (como la línea «Context compacted» de RP105b), sin el texto del resultado.

**Nivel 2: una tira «Subagents» junto a la caja de texto**, solo mientras hay trabajo en curso, desde `presence` de la sesión adoptada:

```
┌─ Subagents ───────────────────────────────────────────────┐
│ ● flow-pr      running   1m 12s                           │
│ ○ gentle-ai-verify  queued                                │
└───────────────────────────────────────────────────────────┘
```

Nombre, estado y tiempo transcurrido; solo del header y de `summary`, y solo si el `heartbeat` tiene 15 s o menos.

**Nivel 3: un panel «Subagents de esta sesión»** (una pestaña junto a Chat, Tasks, Files y Changes), con las tareas terminadas de `tasks\` enlazadas por `parentSessionId`: agente, estado, duración, vueltas, llamadas, tokens y modelo; y un clic que abre la conversación del hijo con el mismo visor del chat. No muestra dinero (el `cost` casi siempre es 0).

**Decisiones que quedan para la persona:** si el `label` de la tarea (texto libre que escribe el agente) se muestra; hoy el chip del panel lo oculta a propósito. Y si el Nivel 3 va detrás de un interruptor en Settings, como los resultados de herramientas (RP106b).

## 5. Riesgos y límites

- **Formato interno.** Todo esto es el formato de gentle-pi 4.6.0, no un contrato público. Una lectura tolerante (campos opcionales, versión del esquema, sin lanzar errores) y pruebas con archivos reales sanitizados son obligatorias.
- **Presencia obsoleta.** 71 de 76 headers estaban muertos. Un lector que no mire el `heartbeat` muestra fantasmas.
- **Privacidad.** Cualquier nivel debe sacar campos de una lista blanca y nunca copiar un objeto entero. Aquí rige lo aprendido en RP105: una lista de patrones no alcanza para texto libre; hay que partir de lo permitido.
- **Costo de lectura.** No leer `tasks\*.json` completos en cada consulta; resolver por `taskId` y bajo demanda.
- **Acciones.** Cancelar o escribirle a un subagente son herramientas internas de la sesión de pi (`subagent_cancel`, `subagent_send_message`), sin una interfaz externa: el panel solo podría hacerlo escribiéndole un pedido a esa sesión. Queda para RP108.

## 6. Lo que esto significa para RP108 y RP109

- **Confirmado por la persona:** «la idea es luego que el director mande orden de abrir sesión en cada repo y cada repo debe tener su agente principal». Es exactamente la arquitectura que el punto siguiente deja como la viable.
- **RP109 (el Director de la sala):** como un hijo no puede tener hijos, «un agente por repo, y cada uno con sus subagentes» **no se puede armar dentro de gentle-pi**. Sí se puede con lo que ya hace el panel: cada repo tiene su propia sesión de pi por RPC (una sesión de primer nivel, con sus propios subagentes), y el Director sería el panel (o una sesión de pi más) que coordina esas sesiones. Es una restricción de diseño, no un detalle.
- **RP108 (usos posibles):** lo medido aquí sirve de base: duración mediana de 91 s, 6 % de las tareas en segundo plano, costo en dinero poco confiable, estado vivo de 15 s de resolución.

## 7. Lo que no se pudo verificar

- Ejemplos reales de `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_cancel`, `subagent_send_message` y del despertar nativo: solo código.
- Si el panel, como host RPC, recibe hoy el widget `gentle-agents.activity/v1` y con qué forma.
- Si `transport\presence\` lo usa el transporte de Windows hoy o son restos.
- Otras versiones de gentle-pi: solo se miró la 4.6.0.
- Una tarea en curso a mitad de ejecución: se vio un `activity.json` vivo, pero no se midió su tamaño bajo carga.

**Corrección a la exploración:** el informe inicial calculó un 0,18 % de entradas de subagente; el conteo completo sobre 15 sesiones da **5,4 %** (casi todo `published-state`). Vale el segundo.
