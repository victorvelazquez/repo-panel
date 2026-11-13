# Estudio: por qué la herramienta de selección dice «no disponible» en el chat del panel (RP167)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP167 de `docs/ROADMAP.md`: por qué la sesión del chat, cuando necesita una decisión, escribe las opciones como texto («Respondé `start_task`, `adjust_task` o `cancel`») en vez de hacer una pregunta con botones, y qué arreglo existe.

- **Cómo se obtuvo.** Lectura de solo lectura, con permiso por escrito de la persona y por ruta exacta, de cuatro archivos de la extensión Gentle Pi 4.7.0: dos de `extensions/` (`ask-user-choice.ts` y `ask-user-question.ts`) y dos de su `lib/` (`rpc-host.ts` y `questionnaire/schema.ts`). Además, los archivos de este proyecto que lanzan la sesión (`server/rpchost.js`, `server/piruntime.js`). No se escribió nada, no se copió texto de configuración ni de credenciales y no se arrancó ninguna sesión (no se gastó modelo). Son herramientas externas: **ninguna de las opciones de abajo las edita**.

## 1. Conclusiones

1. **Las dos herramientas se declaran no disponibles por una condición, no por una limitación.** `ask_user_choice` y `ask_user_question` fallan con «unavailable outside the interactive TUI» cuando el modo no es `tui` **y** `isInteractiveRpcHost(ctx.mode, process.env)` da falso (`ask-user-choice.ts:231-233`, `ask-user-question.ts:269-270`). **Verificado.**
2. **Esa función exige dos cosas** (`lib/rpc-host.ts`): que el modo sea `rpc` y que la variable de entorno `GENTLE_SHELL_INTERACTIVE_HOST` valga exactamente `1`. Su comentario dice que la pone «la app de escritorio» en el proceso pi que lanza con `--mode rpc`. **Verificado.**
3. **El panel borra esa variable.** `server/piruntime.js:13` quita del entorno todo lo que empiece con `PI_`, `GENTLE_` o `ENGRAM_` antes de lanzar la sesión, así que aunque el panel la tuviera, no llega. Y no figura entre las que el lanzador de Gentle Shell vuelve a fijar según `docs/INFORME-entorno-chat.md`. El panel lanza con `--mode rpc` (`server/rpchost.js`). **Verificado**, salvo que el lanzador la fije sin estar documentada (improbable).
4. **Con la variable en `1`, las herramientas ya tienen un camino para RPC** que usa `ctx.ui.select` (y `ctx.ui.input` para el texto libre de `ask_user_choice`). Son pedidos de interfaz que el panel **ya** recibe y dibuja como botones (`server/rpc.js`: `select`, `confirm`, `input`, `editor`; tarjeta `askCard`). **Verificado** que el camino existe y que el panel maneja esos métodos; **inferido** que juntos funcionarían, porque nadie lo probó.
5. **Los subagentes quedan fuera.** El paquete quita esa variable del entorno de los subagentes (`withoutInteractiveHost`), así que un subagente no podría abrir una pregunta que bloquee la sesión. **Verificado.**
6. **El arreglo, entonces, es nuestro y no toca la herramienta:** el panel puede fijar esa variable **en el proceso hijo que lanza**, después del borrado. Es un cambio del lanzamiento de la sesión del panel, no de Gentle Pi.

## 2. Lo que cambiaría y lo que no

| Aspecto | Qué pasa con la variable en `1` |
| --- | --- |
| Opciones y límites | Una pregunta de `ask_user_choice` tiene de 2 a 4 opciones y `ask_user_question` hasta 4 preguntas de 2 a 4 opciones, con etiquetas de hasta 60 caracteres: caben en los topes del panel (20 opciones, 200 caracteres). |
| Texto libre | `ask_user_choice` lo ofrece con una opción «Other…» y un `input`: el panel ya lo dibuja. `ask_user_question` no tiene equivalente en RPC (su fila «Type something.» es solo de la TUI). |
| Varias respuestas | El `multiSelect` se arma con rondas de `select` repetidas: cada ronda es una tarjeta nueva. |
| Descripción y vista previa | Los campos `description` y `preview` del esquema pueden no llegar al panel por el camino de diálogos. **Sin verificar.** |
| Una pregunta cortada | Si algo pasa los topes, el panel la deja solo con Cancelar (regla de RP122): conviene que las etiquetas sean cortas, como pide la guía de la propia herramienta. |
| Qué ve la persona | La sesión pasa a «Asking you something» y la tarjeta tiene botones reales: sin escribir. |

## 3. Opciones

| | Qué es | Riesgo | Tamaño |
| --- | --- | --- | --- |
| **a** | No cambiar nada. Quedan los botones de RP166, que detectan texto. | Ninguno. | Cero. |
| **b** | El panel fija `GENTLE_SHELL_INTERACTIVE_HOST=1` en el entorno de la sesión que lanza, tras el borrado, con una casilla en Settings. | **Medio a alto:** cambia qué herramientas y qué preguntas tienen **todas** las sesiones que abre el panel, y declara que el panel es un host interactivo. | Pequeño: unas 10 líneas de código y la casilla; más pruebas. |
| **c** | b, y dejar RP166 como respaldo: los botones reales ganan cuando hay una pregunta pendiente y los de texto solo salen cuando no la hay. | El de b. | El de b; RP166 ya está hecho. |

## 4. Recomendación

**c, en dos pasos y sin apuro.**
1. **Primero medir.** Antes de tocar el lanzamiento, una prueba corta y real: lanzar una sesión de prueba con la variable en `1` y pedirle una pregunta con `ask_user_choice`. Cuesta una pregunta de modelo y la persona tiene que dar el OK. Responde las dos incógnitas de abajo de una vez.
2. **Después**, si funciona, implementarlo detrás de una casilla de Settings, con pruebas primero y verificación independiente (alto riesgo: cambia el comportamiento de todas las sesiones). Apagada por defecto hasta que la persona lo pruebe.
- **a es válida** si la persona prefiere no abrir ese riesgo: RP166 ya resuelve el caso más común.
- **Descartado:** editar o forkear las herramientas de Gentle Pi (son externas).

**Decisión de la persona (no tomada):** a, b o c; y si da el OK para la medición real.

## 5. Evidencia y lo que no se sabe

- **Verificado:** los dos archivos de las herramientas, `rpc-host.ts` y `schema.ts` (el esquema de `ask_user_question`: de 1 a 4 preguntas, cada una con `header` de hasta 16 caracteres, `question` sin tope, de 2 a 4 opciones con `label` de hasta 60 y `description` obligatoria), y el borrado de variables del panel.
- **Sin verificar:** (1) si el lanzador (`gentle-shell.cmd`, `bin/gentle-shell.mjs`) deja pasar la variable que el panel le entregue o la recalcula: no se leyó; (2) qué valor trae `ctx.mode` en el RPC de pi: viene del paquete de pi y no se leyó (se infiere `rpc` porque la función lo compara y el comentario lo dice); (3) de dónde salen los topes de 200 caracteres y 20 opciones del camino de diálogos y si `preview`, `description` y `multiSelect` llegan tal cual; (4) si `reconcileToolAvailability` tiene otras condiciones; (5) que una sesión real del panel cargue la extensión de Gentle Pi con estas herramientas.
