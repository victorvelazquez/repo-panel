# Motor de sesiones: que pi + Gentle Shell funcione muy bien (RP231 a RP243)

Mejorar el motor que ya existe (pi en modo RPC bajo Gentle Shell) antes de sumar funciones, y después sumar escribir mientras la sesión trabaja, imágenes, subagentes y MCP. Rama base: main. Una tarea = un PR.
Origen: análisis de solo lectura del 2026-11-18 (cuatro revisiones en paralelo, más mediciones del agente). El motor sigue siendo pi + Gentle Shell; un segundo motor (Claude Code directo) no se hace por ahora.

## Specs

- **S1. Mejorar lo que ya existe.** «lo que podemos hacer si o si es mejorar suficientemente lo que ya tenemos hoy que es el motor con pi+gentle-shell. analizar todo lo que podamos corregir o mejorar, como flujo de trabajo, codigo que puede mejorar por hace trabajar mejor el motor, funcionaliddes que se puedan mejorar. y principalmente analizar todas esas tareas pendientes que tenemos si corresponden todavia avnazar o debemos mejorar antes de avanzar. principalmente las cuestiones de sala e imagenes para enviar en el chat, tambien conexion via mcp. viasualizar subagentes, ver su estado y que esta haciendo en vivo.»
- **S2. Primero lo que más rinde.** «podes escribir en el roadmap todas las filas necesarias y reordenar lo necesario para despues empezar a avanzar con el panel, quiero que se arregle todo lo que se pueda y primero los que mas resultados daran. arreglemos todo lo que se pueda y deba del motor, debe funcionar super bien para agilizar el trabajo del dia a dia.»
- **S3. Lo que NO se hace.** La latencia de los hooks no se toca: «creo que mejor olvidar este tema del tiempo que tarda, son unos pocos segundos a mas por querer ahorrar y perder todo lo que hace la herramienta no compensa.»

## Lo que encontró el análisis (2026-11-18)

Verificado en el código o en la documentación de pi 4.8 (Gentle Shell 4.8.0-1.5.2):

1. **La sesión queda libre antes de tiempo.** `server/rpc.js` pasa a libre con `get_state` al llegar `agent_end`, pero pi manda `agent_end` con `willRetry` (docs `json.md`) antes de reintentar, y la página espera `agent_settled` (`public/view.js`, `rpcReduce`). El desenlace (RP228) se fija en `agent_end` y el host descarta `willRetry`: durante un reintento, Projects puede decir Failed.
2. **La sesión puede quedar ocupada para siempre.** Si falla el `get_state` que sigue a un fin de corrida, `refresh()` en `server/rpc.js` traga el error y conserva el valor viejo.
3. **Los comandos no se comprueban.** `/flow-*` se manda como texto (`lib.js` PI_COMMANDS) y `piSend` (`server/pi.js`) responde `confirmed: true` sin mirar qué hizo pi; si el paquete flow-skills no está cargado, el modelo lo recibe como charla. pi tiene `get_commands`.
4. **La guarda de 45 s es de la época de leer la pantalla.** `sendGuard` en `server/pi.js` frena un Retry inmediato de un comando que falló; su causa nunca se confirmó y con RPC el estado viene de eventos.
5. **El cierre no es ordenado y los errores de arranque no se ven.** El panel mata el árbol con `taskkill /F`; la documentación de pi pide cerrar stdin y esperar. La salida de errores de pi se descarta (`stdio` con `ignore`).
6. **La página consume los nombres crudos de pi.** `rpcReduce` lee `agent_start`, `agent_settled`, `message_update`, `tool_execution_*` y `subagent_run`: cada función nueva que se apoye ahí suelda más el panel a pi.
7. **No se puede escribir mientras la sesión trabaja.** La caja dice «wait until it is idle, or press Stop» (`public/resumen.js`, COMPOSER_WAIT), aunque el servidor ya acepta `steer` y `followUp` (`server/rpchost.js`). La página no los usa.
8. **Las preguntas llegan como texto.** El panel borra `GENTLE_SHELL_INTERACTIVE_HOST` (`server/piruntime.js`, que quita todo `GENTLE_*`); con esa variable en 1, las herramientas de pregunta usan diálogos que el panel ya dibuja (estudio RP167). Con la misma variable, Gentle Shell también manda la actividad de los subagentes (`gentle-agents.activity/v1` por `setWidget`), que el panel hoy descarta: el esquema existe en el código instalado, pero su efecto no se midió. La variable cambia el comportamiento de toda la sesión, por eso decide la persona.
9. **Imágenes.** pi acepta `images` en `prompt`, `steer` y `follow_up`, y pi-claude-bridge las pasa a Claude. Una imagen queda en base64 dentro del archivo de sesión (118 a 262 KB por línea, medido), y el historial del chat lee solo los últimos 512 KB de ese archivo.
10. **Subagentes.** El servidor de la presencia (RP164) quedó sin uso desde RP168. Nunca se vio una tarea de la presencia con sus pasos: hay que medirlo en 4.8 antes de construir.
11. **MCP.** pi 4.8 trae MCP propio; está apagado por la configuración de la persona (`-builtin:mcp`). Encenderlo no lleva código del panel. Su estado no se puede leer por RPC.

## Tasks

Orden de la tabla (el de `siguiente`), primero lo que más rinde en el día a día:

- [ ] **T1. RP231** — Estado fiable de la sesión (hallazgos 1 y 2).
- [ ] **T2. RP232** — Verificaciones del motor, sin código: `/flow-ship` por RPC, sesión libre con un subagente vivo, la presencia de 4.8 y el efecto de la variable interactiva.
- [ ] **T3. RP233** — Comandos comprobados con `get_commands` y con la respuesta de pi (hallazgo 3).
- [ ] **T4. RP234** — Quitar la guarda de 45 s, si RP232 confirma que ya no hace falta (hallazgo 4).
- [ ] **T5. RP235** — Vocabulario propio entre el servidor y la página, sin cambio visible (hallazgo 6).
- [ ] **T6. RP236** — Escribir mientras la sesión trabaja (hallazgo 7).
- [ ] **T7. RP237** — Preguntas con botones de verdad (hallazgo 8; decide la persona con lo que mida RP232).
- [ ] **T8. RP238** — Cierre ordenado y diagnóstico del arranque (hallazgo 5).
- [ ] **T9. RP239** — Detener corta también un reintento, y costo y tokens junto al contexto.
- [ ] **T10. RP240** — Un historial que aguanta imágenes (hallazgo 9).
- [ ] **T11. RP215 y RP215b** — Imágenes en el chat: el servidor y la pantalla (ficha `odd/tasks/adjuntar-capturas.md`).
- [ ] **T12. RP241** — Subagentes dentro del chat (hallazgo 10).
- [ ] **T13. RP242** — Subagentes en vivo (hallazgo 8, después de RP237 y RP241).
- [ ] **T14. RP243** — MCP en las sesiones del panel: configuración de la persona (hallazgo 11).

La sala (RP229, RP221, RP221b, RP244, RP222, RP223, RP225) va después de esta serie, reordenada en `odd/tasks/salas.md` (L86 y L87).

## Log

- **L1.** Mensaje de la persona (2026-11-18), tal cual: el de S1.
- **L2.** Lectura del agente de L1 y lo que se hizo. Lanzó cuatro revisiones de solo lectura en paralelo (la sala, imágenes y MCP, subagentes, y la integración con pi) y verificó por su cuenta los hallazgos que cambian el plan: que la caja no deja escribir con la sesión ocupada, que la página no usa `steer` ni `followUp`, que `agent_end` trae `willRetry`, lo que dice el estudio RP167 y que el esquema `gentle-agents.activity/v1` existe en el código instalado. Descartó una sospecha propia: las sesiones vacías de Engram vienen de a dos por cada sesión de pi (la de pi y la sesión espejo del bridge), no una por turno; es ruido de la lista, no una pérdida, y no lleva fila. No cambió código ni configuración.
- **L3.** Mensaje de la persona (2026-11-18), tal cual: el de S2, seguido de la pregunta sobre las imágenes (guardada en `odd/tasks/adjuntar-capturas.md`, L3).
- **L4.** Lectura del agente de L3 y lo que se hizo. Registró las filas RP231 a RP244 y RP215b, reescribió RP215 como la parte del servidor, partió RP221 en RP221 y RP221b, pasó RP224 a Bloqueada (espera Q5 y Q15 del cuaderno de la sala) y movió las filas pendientes al final de la tabla en el orden de arriba, que es el que usa `siguiente`. Lectura del agente, no decisión de la persona: el orden pone primero el estado fiable y las verificaciones, porque varias filas se apoyan en ellos. Quedan para la persona: la variable interactiva (RP237), la configuración de MCP (RP243) y confirmar la forma de mandar imágenes (ficha de RP215, L4).
- **L5.** La persona confirmó el 2026-11-18 que las imágenes van directo a pi (ficha de RP215, L5 y L6).
