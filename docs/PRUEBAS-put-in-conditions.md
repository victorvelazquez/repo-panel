# Pruebas de «Put in conditions»: lo que solo se ve con una sesión real

`test/rp37-put-in-conditions-cases.test.js` prueba, con repos de mentira, todo lo que **decide el panel**: qué requisitos fallan y qué ids lleva la orden. Lo que **hace el agente** cuando recibe la orden no se puede automatizar: es comportamiento de un modelo en una sesión de pi. Esta lista es para mirarlo a mano.

## Antes de empezar

- Probá en un **clon descartable**, no en un repo con trabajo tuyo. Se hace con una carpeta nueva y un repositorio de prueba con origen propio.
- La sesión de pi tiene que estar abierta en ese clon, en reposo. El panel nunca contesta una pregunta del agente por vos.
- Después de cada caso: refrescá el panel (⟳) y mirá la tarjeta del repo. Si el caso salió bien, la advertencia desaparece.

## Lo que se mira siempre, en cada caso

Se comprueba en Git del repo de prueba, no leyendo lo que dijo el agente:

| Qué | Cómo se mira | Esperado |
| --- | --- | --- |
| Trabajó en una rama de tarea | `git branch --show-current` | no es la rama base |
| No commiteó nada | `git log origin/main..HEAD --oneline` | vacío |
| Índice vacío | `git diff --cached --name-only` | vacío |
| Cambió solo lo necesario | `git status --short` y `git diff` | solo los archivos del caso |
| Terminó con una línea | final de la respuesta | una sola línea: qué hizo y el siguiente paso (normalmente `/flow-commit`) |

## Los casos

1. **Repo sin `AGENTS.md`.** Esperado: crea `AGENTS.md` con los tres bloques (`registro`, `ciclo`, `estado`) copiados **tal cual** de `requirements/blocks/` (se compara con `diff`), crea `docs/ROADMAP.md` con las tres líneas de cabecera y la tabla con las columnas `ID`, `Entrega`, `Depende de` y `Estado`, y `docs/ORQUESTACION.md`. **No inventa unidades**: si el proyecto no tiene plan, te lo pregunta.
2. **Un bloque con versión vieja.** Dejá en el clon un bloque `registro` en `v0.9`. Esperado: reemplaza **solo ese bloque**, entero, con sus marcadores. Las reglas propias del `AGENTS.md` quedan intactas (el `git diff` solo toca el bloque).
3. **Una regla del repo choca con un bloque.** Por ejemplo, un `AGENTS.md` que dice que la hoja de ruta vive en otra ruta. Esperado: el agente **se frena**, cita las dos reglas y te pregunta cuál manda. No cambia ningún archivo hasta que contestes. Este es el caso más importante: es la razón por la que no hay un botón que lo aplique a todos los repos a la vez.
4. **Tabla de la hoja de ruta con otros nombres de columna** (`Unidad`, `Dependencias`). Esperado: renombra solo los encabezados y conserva todas las filas. Ya se probó de verdad en `flow-skills`.
5. **Repo de una sala.** Esperado: además de lo anterior, el bloque `ciclo` con las regiones `<!-- SALA -->` ... `<!-- /SALA -->`, sin tocarlas.
6. **`panel-ignored`.** Esperado: agrega `.panel/` a `.git/info/exclude`, **una sola vez**, y no toca `.gitignore`. Nada que entregar: es local al clon.
7. **Idempotencia.** Con el repo ya en condiciones (después de entregar con `/flow-commit` y `/flow-pr`), «Put in conditions» **ya no aparece** en el menú ⋯ de la tarjeta. Si el repo está conforme y alguien manda la orden igual, el panel responde 409 y no escribe nada.

## Qué anotar si algo falla

Qué caso, qué dijo el agente, qué mostró `git status` y la hora. Con eso se reproduce primero contra repos de mentira y se decide si el defecto está en las instrucciones (`requirements/INSTALL.md`, los remedios de `requirements.json`) o en el validador del panel.
