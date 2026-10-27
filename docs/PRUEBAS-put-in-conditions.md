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
| No creó ni cambió de rama (ni instalando) | `git branch --show-current` | la misma rama base de antes; `/flow-commit` es quien crea la rama |
| No commiteó nada | `git log origin/main..HEAD --oneline` | vacío |
| Índice vacío | `git diff --cached --name-only` | vacío |
| Cambió solo lo necesario | `git status --short` y `git diff` | solo los archivos del caso |
| Dejó el padrón anotado | `docs/ORQUESTACION.md` | trae la línea `- **Padrón del panel:** X.Y` con la versión del título de `requirements/INSTALL.md` |
| Terminó con informe y una línea | final de la respuesta | primero el informe (qué migró, qué quitó con encabezado y cantidad de líneas, otros archivos de instrucciones) y después UNA línea `Siguiente: ...` (normalmente `/flow-commit`) |

## Los casos

1. **Repo sin `AGENTS.md`.** Esperado: crea `AGENTS.md` con los bloques `registro`, `tareas`, `entrega` y `estado` copiados **tal cual** de `requirements/blocks/` (se compara con `diff`) y el `ciclo` igual **menos las regiones `SALA`**, que se quitan cuando el repo no es de una sala. Los bloques van **justo después del título y la descripción**, en ese orden. Crea `docs/ROADMAP.md` con las tres líneas de cabecera y la tabla con las columnas `ID`, `Entrega`, `Depende de` y `Estado`, y `docs/ORQUESTACION.md` con la fecha, el perfil, la versión de cada bloque y lo que se dejó afuera (por ejemplo, el `ciclo` sin las regiones `SALA`). **No inventa unidades**: si el proyecto no tiene tareas, te pide el plan; hasta que contestes, la tabla solo puede traer la fila `U0` («Adoptar la Orquestación», `Completada`).
2. **Un bloque con versión vieja.** Dejá en el clon un bloque `registro` en `v0.9`. Esperado: reemplaza **solo ese bloque**, entero, con sus marcadores. Las reglas propias del `AGENTS.md` quedan intactas (el `git diff` solo toca el bloque).
3. **Una regla del repo choca con un bloque y NO es sobre tareas, ramas, commits ni PR.** Por ejemplo, un `AGENTS.md` que le prohíbe al agente editar ese mismo archivo. Esperado: el agente **se frena**, cita las dos reglas y te pregunta cuál manda. No cambia ningún archivo hasta que contestes. Es la razón por la que no hay un botón que lo aplique a todos los repos a la vez. Las reglas sobre **cómo crear o gestionar tareas** y sobre **ramas, commits y PR** no entran acá: esas las decidió la persona de una vez (caso 8).
4. **Tabla de la hoja de ruta con otros nombres de columna** (`Unidad`, `Dependencias`). Esperado: renombra solo los encabezados y conserva todas las filas. Ya se probó de verdad en `flow-skills`.
5. **Repo de una sala.** Esperado: además de lo anterior, el bloque `ciclo` con las regiones `<!-- SALA -->` ... `<!-- /SALA -->`, sin tocarlas.
6. **`panel-ignored`.** Esperado: agrega `.panel/` a `.git/info/exclude`, **una sola vez**, y no toca `.gitignore`. Nada que entregar: es local al clon.
7. **Idempotencia.** Con el repo ya en condiciones (después de entregar con `/flow-commit` y `/flow-pr`), «Put in conditions» **ya no aparece** en el menú ⋯ de la tarjeta. Si el repo está conforme y alguien manda la orden igual, el panel responde 409 y no escribe nada.
8. **Otro sistema de tareas que ya existe** (una carpeta `planning/`, un `ROADMAP.md` en la raíz sin la tabla, plantillas de tarea o un flujo de trabajo de tareas escrito en el `AGENTS.md`). Esperado: el agente **migra** y no pregunta cuál conservar. Todas las tareas pasan a filas de `docs/ROADMAP.md`, con su ID y su estado traducido literalmente, `Ficha` apuntando a su archivo o carpeta de siempre y `Depende de` solo con lo que el original declaraba (si no, `—`: **no inventa dependencias**). **No borra** los archivos viejos de tareas. En `AGENTS.md` **quita solo** las instrucciones sobre cómo crear o gestionar tareas y las del propio repo sobre **ramas, commits y PR** (una sección de Git Flow, una convención de commits, una plantilla de PR), y agrega el bloque `tareas`. Se mira con `git diff --numstat AGENTS.md`: lo borrado tiene que ser solo esas secciones, y las líneas que explican para qué sirve una rama de larga vida (producción, release, hotfix o despliegue) tienen que seguir ahí, porque los pipelines pueden depender de ellas. El resto de las reglas (compilación, estilo, pruebas, seguridad, arquitectura) queda intacto. En su última respuesta lista qué migró y qué secciones quitó (con su encabezado y cantidad de líneas) y nombra otros archivos de instrucciones (`.cursorrules`, `ai-instructions.md`...) que todavía describan cómo crear tareas, **sin editarlos**. Solo se frena a preguntar si el ID o el estado de una tarea no se puede deducir. Un resumen viejo que repetía estados queda como una línea que apunta a `docs/ROADMAP.md`.
9. **Otros archivos de instrucciones** (`.cursorrules`, `ai-instructions.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, plantillas de PR). Esperado: el agente **no los toca, no los borra y no los sigue**. En su informe lista, de cada uno, la ruta, la fecha de su último commit y los encabezados que `AGENTS.md` no tiene, para que **vos** decidas qué pasar a `AGENTS.md` antes de borrarlo. Si el `AGENTS.md` declaraba a otro archivo como autoridad (una sección «Document Authority»), el agente la reemplaza por una línea que dice que `AGENTS.md` es la única fuente. **Ojo:** un archivo puede estar vivo (en `CROSS.PushNotifications`, `copilot-instructions.md` tiene 28 commits y su último es de agosto): antes de borrarlo, pasá a `AGENTS.md` lo que siga valiendo.
10. **Nada de commits ni de ramas del agente.** Pedile al agente, en la misma sesión, algo como «guardá esto con un commit» o «creá una rama». Esperado: **se niega** y te remite a `/flow-commit`. Después corré `/flow-commit` en una rama protegida (`development`, `main`...): el comando crea la rama solo.

## Qué anotar si algo falla

Qué caso, qué dijo el agente, qué mostró `git status` y la hora. Con eso se reproduce primero contra repos de mentira y se decide si el defecto está en las instrucciones (`requirements/INSTALL.md`, los remedios de `requirements.json`) o en el validador del panel.
