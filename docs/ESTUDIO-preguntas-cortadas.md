# Estudio: las preguntas de seguridad que llegan cortadas (RP122)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP122 de `docs/ROADMAP.md`: por qué una pregunta de seguridad de pi puede llegar al chat con el comando cortado, por qué entonces la tarjeta solo ofrece **Deny**, y si el panel puede mostrar el comando completo antes de preguntar.

- **Parte de un caso real.** La tarjeta «Allow recognized data-loss command?» mostró un comando que terminaba en `…` con secuencias de color de terminal pegadas, y ofreció solo Deny con el aviso «The command is cut or not shown: answer it in the terminal». El comando era mucho más corto que los 4000 caracteres que el panel acepta.
- **Parte de lo decidido** en RP73 (el panel nunca ofrece Allow sobre un texto que no se ve entero) y en RP105 (los comandos se muestran resumidos a propósito, para no filtrar secretos).
- **Cómo se obtuvo:** una exploración de solo lectura, con permiso por escrito de la persona, del código de gentle-pi y de pi (carpeta `gentle-shell\versions\…\node_modules\.pnpm`), del historial de sesiones y del código del panel; la pieza central (el tope de 180 columnas y el título) la comprobó además la sesión principal leyendo el archivo.
- **Lo que no se hizo:** no se probó nada en vivo, no se arrancó ninguna sesión ni se provocó una pregunta, y no se escribió código. Abreviatura de rutas: `GP/` es `gentle-pi@4.6.0_…\node_modules\gentle-pi\`.

## 1. Conclusiones

1. **El recorte no lo hace el panel: llega hecho.** gentle-pi arma una vista previa del comando de como mucho 180 columnas y le pone `…`. El panel recibe ya el texto cortado y hace bien en no ofrecer Allow.
2. **El corte no depende de la terminal.** Es una constante (180 columnas). Un comando que pasa de unos 180 caracteres, contados desde 60 antes del punto donde saltó la regla, llega siempre cortado.
3. **La pregunta no trae ningún dato de la llamada que la provocó.** Solo lleva `id`, `method`, `title`, `message` y `timeout`. No hay `toolCallId`, nombre de herramienta, argumentos ni carpeta.
4. **El comando completo sí existe en otros dos lugares**, pero no hay un identificador que lo ate a la pregunta: el evento `tool_execution_start` (que el panel recibe y descarta a propósito) y la línea `toolCall` del archivo de la sesión.
5. **Emparejarlos sin ese identificador es adivinar.** Se podría usar «la última llamada de bash en curso», pero eso falla en varios casos reales (sección 5) y mostrar un comando que no es el que pide permiso es peor que no mostrar nada.
6. **Mostrar el comando entero choca con RP105.** Un comando que pide confirmación (`rm`, `curl` con una credencial) es el más sensible, y la redacción por patrones ya falló dos veces en encontrar todas las formas de colar un secreto.
7. **Recomendación:** dejar hoy el panel en solo-Deny para lo cortado (a) y pedir a gentle-pi que no corte el mensaje o que agregue el `toolCallId` (c). No emparejar por orden (b) ni poner un Allow con paso extra (d).

## 2. Por qué te llega cortado (verificado en el código)

- **Dónde se arma el título.** `GP/extensions/gentle-ai.ts:2179`: `evaluation.dataLoss ? "Allow recognized data-loss command?" : guardedCommandTitle(...)`. La pregunta se hace unas líneas después, con `ctx.ui.confirm(title, preview)`.
- **Dónde se arma y se corta la vista previa.** `GP/extensions/gentle-ai.ts:1698`, función `guardedCommandPreview(command, triggerIndex)`: arranca 60 caracteres antes del punto donde saltó la regla (con un `…` delante si no es el principio), reemplaza los espacios repetidos por uno y corta con `truncateToWidth(texto, 180 - prefijo, "…")`.
- **De dónde salen los `ESC[0m`.** `truncateToWidth` es de `pi-tui` (`dist/utils.js:1083`); al cortar cierra los estilos y arma `${prefijo}${cierre}\x1b[0m…\x1b[0m` (`finalizeTruncatedResult`, `utils.js:130`). Esos caracteres de control, más la elipsis final, son justo lo que el panel detecta como «no entero» (`hasHidden`, `wholeText` en `public/resumen.js`).
- **Cuándo pasa.** Con cualquier comando largo que dispare la regla, sin importar el ancho de la terminal. Los comandos que mezclan varias acciones en una línea (por ejemplo un borrado seguido de un `node -e`) son los típicos.

## 3. Qué lleva la pregunta

- **Verificado.** `pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:405-450`: `confirm` lleva `type, id, method, title, message, timeout?`. El `id` es un `crypto.randomUUID()` propio del diálogo (`rpc-mode.js:50`) y `rpc-mode.js:85` arma el `confirm` con `{method, title, message, timeout}`.
- **La API no puede cargar más.** `ctx.ui.confirm(title, message, opts)` no recibe identificador de llamada. Aunque gentle-pi lo tiene a mano (`event.toolCallId`, `GP/extensions/gentle-ai.ts:11889`), el protocolo no tiene dónde ponerlo.

## 4. Dónde está el comando completo

- **En el flujo de eventos.** `agent-loop.js` (`:~352, 385, 421`) emite `tool_execution_start` con `toolCallId`, `toolName` y `args` completos, antes de preparar la llamada, que es donde corre el hook que hace la pregunta. En modo paralelo la preparación sigue siendo secuencial (`agent-loop.js:421-430`). **Esto último es lectura del código, no una prueba en vivo.**
- **Lo que el panel conserva hoy.** `server/rpchost.js:83` deja pasar de ese evento solo `toolName`, `isError` y `durationMs`; el `toolCallId` y los `args` no salen del servidor (comentario de `rpchost.js:62`). El `onUi` de `server/rpc.js:152-168` guarda solo `id`, `method`, `title`, `message` y `options`.
- **Lo que hace `server/redact.js`.** `argSummary('bash', {command})` no oculta patrones: reconstruye el comando con una lista blanca (programa, subcomando, nombres de opciones, archivos, host) y cualquier otra palabra pasa a `…`, con un tope de 80 caracteres. Un comando como el del caso real quedaría como `cd … && rm … ; node …`: sirve de contexto, pero no alcanza para decidir un Allow.
- **En el archivo de la sesión.** El mensaje del asistente trae `{"type":"toolCall","id":"toolu_…","name":…,"arguments":{…}}` completo (formato visto en un `.jsonl` de la carpeta del repo, línea 7); el resultado va en otra línea con `toolCallId`. Por el orden del código, la llamada ya está escrita cuando se hace la pregunta (**inferido, no probado en vivo**).
- **Las preguntas no se guardan.** Buscar «data-loss» o «recognized» en los archivos de sesión del repo no dio resultados, y el `id` de la pregunta es un UUID distinto del `toolu_…`.

## 5. Por qué emparejar sin identificador es adivinar

Lo único posible hoy sería «la última llamada de bash en curso». Falla en estos casos:

- **Dos llamadas en paralelo.** La preparación es secuencial, pero depender de eso es depender de un detalle de implementación.
- **Un reintento** de la misma llamada.
- **Una pregunta que no viene de bash.** Hay otras fuentes de `confirm`: la guarda de gentle-pi para escribir y editar, los subagentes (`parentToolCallId`, `agent-session.js:338`) y la política de YOLO.
- **Un comando que cambia entre la llamada y la pregunta.** El hook recibe `validatedArgs`, que pueden diferir de los argumentos originales (`agent-loop.js:497-503`): lo que vio la guarda y lo que emitió `tool_execution_start` no son necesariamente idénticos.

Un emparejamiento equivocado es peor que ninguno: la persona vería un comando y aprobaría otro. Por eso un id compartido de pi es condición, no un detalle.

## 6. Privacidad

Mostrar el comando entero a la página es exactamente lo que RP105 evita a propósito. Las dos revisiones de esa fila encontraron 23 y luego 12 formas de colar un secreto con patrones, y por eso se cambió a un vocabulario cerrado. Un comando que dispara una confirmación es el caso más sensible. Una redacción por patrones no alcanza y la lista blanca lo deja ilegible: mostrarlo entero sería contradecir RP105 y habría que decidirlo de forma explícita, no como un efecto lateral.

## 7. Opciones

| | Qué es | Riesgo | Tamaño | Qué prueba demostraría que no se abusa |
| --- | --- | --- | --- | --- |
| **a** | No hacer nada: lo cortado sigue en solo-Deny. | Ninguno (es lo de hoy). | Cero. | Ya existe: no hay Allow si `truncated` o si hay caracteres ocultos. |
| **b** | Mostrar el comando emparejado por orden, redactado como RP105. | **Alto**: sin id compartido es una adivinanza, y además hay fuga de secretos. | Mediano: ampliar la lista blanca, mapear `toolCallId`, una redacción nueva. | Una llamada paralela y una pregunta que no es de bash, donde NO debe emparejar. |
| **c** | Pedir a gentle-pi un cambio: que no corte el mensaje (o dé más margen) o que agregue el `toolCallId` a la pregunta. | **Bajo**: el id lo da pi, no lo inferimos. La decisión de mostrar el comando pasa a ser explícita y única. | Pequeño en el panel; **no lo controlamos nosotros**. | Un `fake-pi-rpc` que mande el id; una pregunta sin id o con un id desconocido debe quedar en solo-Deny. |
| **d** | Un Allow con una segunda confirmación para lo cortado. | **Alto**: da falsa seguridad. | Pequeño. | No hay una prueba que demuestre que no se abusa: la persona seguiría aprobando un texto que no ve entero. |

## 8. Recomendación y decisión pendiente

1. **Hoy:** (a). Es seguro; el costo es que la persona va a la terminal en los casos largos, que suelen ser los destructivos. Quien escribe los comandos (la sesión de pi) los mantiene cortos, de una línea y sin secuencias de escape, para que casi nunca lleguen cortados. Esa medida ya está aplicada y no cambia código.
2. **Mejor:** (c). Pedir a gentle-pi que no corte el mensaje o que agregue el `toolCallId`. Con un id de pi, el panel podría mostrar el comando sin adivinar, y una pregunta sin id seguiría en solo-Deny. Depende de quien mantiene gentle-pi.
3. **Descartadas:** (b) y (d).

**Decisión de la persona (no tomada):** si quiere pedir el cambio (c) y por qué vía. Si lo pide, la implementación en el panel sería una unidad aparte, con ítem de seguridad (verificación independiente y pruebas de abuso primero), y solo después de que pi mande el id.

## 9. Evidencia

- `GP/extensions/gentle-ai.ts:1698` (`guardedCommandPreview`, tope 180) y `:2179` (título «data-loss»), comprobados por la sesión principal; `:11889` (`event.toolCallId`).
- `pi-tui@1.5.0`, `dist/utils.js:1083` (`truncateToWidth`) y `:130` (`finalizeTruncatedResult`).
- `pi-coding-agent/dist/modes/rpc/rpc-types.d.ts:405-450` y `rpc-mode.js:50, 85`; `agent-loop.js:~352, 385, 421-430, 497-503`; `agent-session.js:338`.
- `server/rpchost.js:62, 83`, `server/rpc.js:26-30, 133, 144-168`, `server/redact.js` (`argSummary`), `public/resumen.js` (`askAllowed`, `wholeText`, `hasHidden`, `CUT_NOTE`).
- Un archivo `.jsonl` de la sesión del repo, línea 7 (llamada) y línea 8 (resultado).

**Sin verificar:** no hay ninguna pregunta pendiente real en los historiales; el orden «el evento sale antes de la pregunta» está leído del código y no probado en vivo, ni en modo paralelo; no se confirmó si los subagentes o el modo YOLO preguntan con otro texto; no se probó qué hace pi cuando una pregunta vence sin respuesta (`expiresAt`).
