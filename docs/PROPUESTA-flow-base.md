# Propuesta para `flow-skills`: renombrar `flow-branch` a `flow-base`

Escrita desde `repo-panel` el 2026-10-25, a pedido de la persona. Es un pedido de trabajo para la sesión de `flow-skills`. La persona acepta la orden en esa sesión y corre `/flow-commit` y `/flow-pr` ella misma.

## 1. Por qué

La skill `flow-branch` se describe como «seleccionar, actualizar o borrar una rama existente». Pero casi todo su uso es el modo **sin argumentos**: ir a la primera rama que exista entre `dev`, `develop`, `development`, `main` y `master`, actualizarla con el remoto (solo avance rápido) y dejar el árbol limpio para empezar un ciclo nuevo. El nombre `branch` no dice nada de eso y se confunde con crear ramas (eso lo hace `flow-commit`).

La persona pidió que el nombre represente su función principal: **volver a la rama base, actualizada y limpia**. El nombre elegido es **`flow-base`**. Se elige por lo que hace la skill (ir a la rama base de integración) y porque «rama base» es el término que ya usan Git y los PR para esa rama; no por costumbre.

## 2. Qué hay que hacer

Renombrar de punta a punta, **sin dejar alias**: la persona pidió actualizar todo y usar solo lo nuevo.

Archivos que hoy mencionan `flow-branch` (31 líneas en total, encontradas con `grep`; verificalas, puede haber más):

| Archivo | Cambio |
| --- | --- |
| `skills/flow-branch/` (carpeta y `SKILL.md`) | pasa a `skills/flow-base/`; `name: flow-base` y descripción nueva (ver 3) |
| `scripts/flow-branch.mjs` | pasa a `scripts/flow-base.mjs`; textos de uso y el `hint` `/flow-branch --stash` pasan a `/flow-base --stash` |
| `hosts/pi/agents/flow-branch.md` | pasa a `hosts/pi/agents/flow-base.md` |
| `hosts/pi/prompts/flow-branch.md` | pasa a `hosts/pi/prompts/flow-base.md` |
| `package.json`, `README.md`, `.atl/skill-registry.md` | actualizar las referencias |
| `odd/tasks/flow-learn.md` | es historia de otra unidad: dejarla como está salvo que algo la use como referencia viva |

Además hay que revisar **cómo se instalan los archivos de `hosts/`** en las carpetas globales de Pi y Gentle Shell (`~/.gentle-shell/agent/...`). Un renombre en el repo no borra lo ya instalado: asegurá que el nombre viejo deje de existir donde se instala, y dejale a la persona escrito el paso exacto que le falta (sincronizar o reiniciar) para que `/flow-base` exista y `/flow-branch` no.

## 3. Descripción nueva

> Volver a la rama base, actualizada y limpia, para empezar un ciclo nuevo; también listar, elegir o borrar ramas existentes.

Las reglas duras (no borrar sin confirmación, no borrar ramas protegidas, no `--force` sin aprobación por rama, el único stash permitido es `--stash` pedido a propósito) **no cambian**.

## 4. Mejora recomendada del modo `--stash`

Hoy `--stash` solo avanza si el ciclo de la rama actual terminó, y lo decide con `assessFinishedCycle`: la rama no tiene commits propios, es equivalente a la base (`git cherry`) o su rama remota ya se borró (`[gone]`). Con un **squash** los commits no son equivalentes a los de la base, y si la rama remota sigue viva el comando se niega aunque el PR esté fusionado. Es seguro, pero obliga a borrar la rama remota a mano.

Propuesta: contar también como «ciclo terminado» cuando existe un PR **fusionado** de esa rama (`gh pr list --state merged --head <rama>`) **y** el `HEAD` local coincide con el commit final de ese PR (`headRefOid`). La segunda condición es la que evita perder commits posteriores que nunca se publicaron. Si `gh` no está disponible o no responde, se mantiene el comportamiento actual (negarse y no cambiar nada).

## 5. Lo que `repo-panel` espera, para no romper el contrato

El panel manda estas dos líneas a la sesión, tal cual:

- `/flow-base`
- `/flow-base --stash`

Los campos de la respuesta que el flujo ya usa no deben cambiar de nombre: `stashRefused`, `stashed`, `stashRestored`, `stashRef`, `nextAction` (`stash-conflict`, `done`), `dirty` y `hint`.

## 6. Cómo trabajar

- Rama de tarea (no `main`). No hagas commit, push ni PR: la persona corre `/flow-commit` y `/flow-pr`.
- Correr las pruebas y chequeos del repositorio y mostrar el resultado real.
- **Dejar el índice de Git vacío.** No uses `git mv` ni `git add`: `/flow-commit` arma su propio staging y se niega a empezar si el índice no está vacío (`index-not-empty`). Mové los archivos con una operación de archivos normal, o, si ya usaste `git mv`, dejá escrito que la persona corra `git reset` antes de `/flow-commit`.
- No tocar otras skills ni agregar un alias de `flow-branch`.
- Terminar con **una línea** que diga qué se hizo y cuál es el siguiente paso de la persona.

## 7. Después, del lado de `repo-panel`

Cuando `/flow-base` exista y esté instalado, `repo-panel` cambia sus claves `flow-branch` y `flow-branch-stash` por `flow-base` y `flow-base-stash`, sus etiquetas, el README y las pruebas. Como la persona pidió **no dejar alias**, hay una ventana corta e inevitable entre que se sincroniza la skill nueva y se fusiona el cambio del panel: en ese rato el botón del panel mandaría `/flow-branch`, que ya no existe. Para acortarla, el orden es: (1) la sesión de `flow-skills` renombra y la persona fusiona; (2) la persona sincroniza o reinicia para que `/flow-base` exista; (3) recién entonces se fusiona el cambio del panel, que ya estará preparado. Durante la ventana la persona escribe `/flow-base` a mano en la sesión.
