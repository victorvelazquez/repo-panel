# Estudio: la sesión espera un trabajo en segundo plano y el panel la ve libre (RP160)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP160 de `docs/ROADMAP.md`: por qué el panel muestra libre una sesión que espera un trabajo en segundo plano (un job de shell o un subagente), por qué entonces habilita `/flow-commit`, si el panel puede saber que hay algo pendiente y qué opciones hay.

- **Parte de un caso real.** Una sesión de otro repo dijo «Falta el resultado de la suite completa (job-5), que tarda unos 8 minutos… Espero el resultado», y el botón `/flow-commit` ya estaba habilitado. Cuando la persona le escribió, la sesión pasó a working y el botón se deshabilitó; al terminar esa respuesta volvió a habilitarse con el trabajo todavía sin terminar.
- **Cómo se obtuvo.** Una lectura de solo lectura, con permiso por escrito de la persona y con la ruta exacta, de UN archivo de sesión de este repo (`...\.gentle-shell\agent\sessions\--C--Users-victor-Developer-Tools-repo-panel--\`, la sesión principal de este trabajo, 6405 líneas). Se leyó solo la forma: tipos de entrada, nombres de herramientas, claves y tipos de los `details`, tiempos y conteos. **No se copió ningún texto de mensajes, comandos ni rutas.**
- **Lo que no se hizo.** No se capturó el flujo de eventos en vivo que recibe el panel, no se leyó el código de pi ni de gentle-pi, no se arrancó ninguna sesión y no se escribió código. Se miró un solo archivo y una sola versión de gentle-pi (4.7.0).

## 1. Conclusiones

1. **El panel no se equivoca: sabe lo que le dicen.** El estado `working` es «el agente está respondiendo» (`server/rpc.js:72`, de `agent_start` a `agent_end`). Una sesión que lanzó un trabajo en segundo plano y terminó su turno está, para pi, libre de verdad.
2. **El hueco es largo, no un parpadeo.** Entre el último mensaje del agente y el aviso de fin del trabajo pasaron una mediana de **47 segundos** y un máximo de casi **10 minutos** (123 casos). Todo ese tiempo el panel muestra la sesión libre.
3. **Lanzar el trabajo es instantáneo.** `bash_background` y `monitor` contestan en una mediana de **16 ms**; `subagent_run` en modo background también contesta de inmediato. No hay una herramienta «en ejecución» que el panel pueda ver durante la espera: el único rastro es la respuesta inicial.
4. **El fin del trabajo llega como un mensaje.** Cada aviso queda en la sesión como una entrada `custom_message` con `customType` `gentle-jobs.notice` (jobs) o `gentle-agents.result` (subagentes en background), con un objeto `details` que trae el estado. Ese mensaje no es una herramienta ni un evento de la lista blanca del panel.
5. **El `jobId` no identifica al trabajo.** En 87 arranques solo hay 22 `jobId` distintos: la numeración se reinicia. Lo único único es `outputPath`, que es una ruta de archivo (no debe salir del servidor).
6. **Un monitor avisa varias veces mientras sigue corriendo** (`status` `running`, `event` `events`) y termina con `status` `exited`. Solo `exited` o `stopped` terminan un trabajo.
7. **Detener un trabajo a mano no manda aviso de fin.** `job_stop` deja `status` `stopped` en su propia respuesta. De 95 trabajos, 91 terminaron con aviso, 3 con `job_stop` y 1 no terminó (probablemente el que seguía corriendo al leer).
8. **Existe un camino que el panel ya recorre y no usa:** el archivo de la sesión. El servidor lo lee para el chat (`server/sessions.js`, últimos 512 KB). Ahí están, con `status`, el arranque y el fin de cada trabajo.

## 2. Qué hay en la sesión (forma, sin texto)

| Dato | Dónde | Forma |
| --- | --- | --- |
| Arranque de un job | respuesta de `bash_background` / `monitor`, `details.gentleJobs` | `jobId`, `kind` (`command` o `monitor`), `label`, `status: running`, `exitCode: null`, `outputPath` |
| Fin de un job | `custom_message` `gentle-jobs.notice`, `details.gentleJobs` | las mismas claves; `status: exited` y `exitCode` numérico (99 casos); `status: running` con `event: events` en los avisos intermedios de un monitor (52) |
| Corte manual | respuesta de `job_stop`, `details.gentleJobs` | `status: stopped` o `exited`, sin aviso aparte |
| Subagente en background | respuesta de `subagent_run`, `details.gentleAgents` | `taskId`, `mode: background`, `status: queued`; el resultado llega como `custom_message` `gentle-agents.result` con `status: completed` |
| Subagente bloqueante | respuesta de `subagent_run` | dura minutos (mediana 115 s): ya lo cubre el chip de RP152 |

## 3. Por qué el panel no lo sabe hoy

- **El flujo en vivo no lo trae.** `server/rpchost.js` solo deja pasar de `tool_execution_*` el nombre, `isError` y `durationMs`, y de `message_start`, `message_end` y `agent_end` **nada** (llevan el prompt de sistema entero, unos 180 KB). Un `custom_message` de fin de trabajo, si pi lo emite por ahí, se descarta.
- **El arranque sí es visible** (`tool_execution_end` con `toolName` `bash_background`, `monitor` o `subagent_run`), pero sin `jobId` ni `taskId`, y sin el aviso de fin no hay cómo cerrarlo: un contador solo de arranques crece y nunca baja.
- **No se sabe si pi manda esos mensajes personalizados por el canal RPC.** El archivo de sesión los tiene; que el canal los tenga **no está verificado**.

## 4. Opciones

| | Qué es | Riesgo | Tamaño | Qué prueba demostraría que no se abusa |
| --- | --- | --- | --- | --- |
| **a** | Ampliar la lista blanca del flujo en vivo: arranque por `toolName` y fin por un `message_end` que se reduce a `customType` y `status`. | **Alto**: depende de un evento que **no se verificó** que llegue; sin id compartido hay que emparejar por orden; toca lo que RP105 protege. | Mediano. | Una llamada de `job_stop`, un monitor con avisos intermedios y un trabajo sin aviso no deben dejar el contador pegado. |
| **b** | Un botón manual por repo, «esperando un trabajo en segundo plano», que frena los botones de entrega hasta desmarcarlo. | **Bajo**: solo de la página, no toca datos. Depende de que la persona se acuerde. | Pequeño. | Una prueba de que, marcado, ningún botón de entrega queda habilitado, y de que al recargar hace lo que se decida. |
| **c** | **Derivar el número en el servidor desde el archivo de la sesión que el panel ya lee.** Por cada `outputPath` (se empareja ahí, y la ruta no sale del servidor) y por cada `taskId` de subagente en background: pendiente si hay arranque con `status` `running` o `queued` y no hay un fin (`exited`, `stopped`, `completed`) después. A la página solo viaja un **entero**, y la regla de RP159 (`V.deliveryHold`) lo usa con el motivo «hay N trabajos en segundo plano». | **Medio**: lee un formato de gentle-pi que puede cambiar, pero no abre ninguna lista blanca ni saca texto del servidor. | Mediano (el servidor y una entrada nueva en el estado de la sesión). | Un archivo sin esos datos, truncado o con una entrada rota no debe dar un número inventado; un monitor con avisos intermedios y un `job_stop` deben cerrar; ninguna ruta ni texto debe aparecer en la respuesta. |
| **d** | **c** más **b** como válvula: el «Show /flow-commit anyway» que ya existe levanta el freno, y el botón manual cubre lo que **c** no vea. | Medio. | Mediano más pequeño. | Las de c y b. |

## 5. Recomendación y decisión pendiente

1. **Recomendado: c** (con el «anyway» que ya existe como válvula). Usa un dato que el panel ya lee, empareja por un identificador único sin sacarlo del servidor, y a la página llega solo un número. No depende del canal en vivo, que no se pudo verificar.
2. **Descartada hoy: a.** Si más adelante se verifica que pi manda esos mensajes por RPC, se puede revisar, pero hoy depende de algo no comprobado.
3. **b queda como plan B** si c resulta frágil frente a otra versión de gentle-pi.

**Decisión de la persona (no tomada):** (i) si va c, a, b o d; (ii) si un **monitor** que sigue corriendo debe frenar los botones o solo los jobs de comando y los subagentes (un monitor que se olvidó abierto frenaría para siempre); (iii) qué hacer con un trabajo que nunca termina (1 de 95 en la muestra): un tope de tiempo o solo el «anyway». Con la decisión se registra una fila nueva con ítem de alto riesgo de privacidad (RP105), pruebas de abuso primero y verificación independiente.

## 6. Evidencia

- Archivo de sesión leído: el de la sesión principal de este repo, 6405 líneas, con 87 respuestas de `bash_background`, 220 de `subagent_run` (3 en background), 9 de `monitor`, 151 avisos `gentle-jobs.notice`, 3 `gentle-agents.result` y 4 `job_stop`. Las cuentas salen de scripts de solo lectura que imprimen formas y números, sin texto.
- Panel: `server/rpc.js:72` (el estado), `server/rpchost.js` (la lista blanca, comentario sobre el prompt de sistema), `server/sessions.js` (`baseDir`, `CHAT_WINDOW`), `public/view.js` (`rpcReduce`, RP152; `deliveryHold`, RP159).

**Sin verificar:** que el panel muestre libre toda la espera (se infiere de `agent_end` y del estado `idle`, no se capturó en vivo); si pi manda los `custom_message` por el canal RPC; cuándo se escribe el aviso en el archivo respecto de cuándo arranca el turno siguiente; el comportamiento en otra versión de gentle-pi o con otra herramienta de segundo plano; una sola sesión como muestra; el efecto de la compactación sobre la ventana de lectura de 512 KB cuando un trabajo largo arrancó antes.
