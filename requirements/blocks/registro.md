<!-- orquestacion:registro v1.0 -->
## Orquestación: registro de trabajo

Este proyecto lleva su trabajo en `docs/ROADMAP.md` con el formato estándar de Orquestación (versión 1.0).

### Estados
`Pendiente` · `En curso` · `Lista` (hecha y verificada en el árbol, sin entregar) · `En revisión` (PR abierto) · `Completada` (cerrada en el diff de su unidad; vale al fusionar el PR) · `Bloqueada` (con el motivo escrito).

En la columna `Estado` de `docs/ROADMAP.md` se escribe **una sola palabra** entre `Pendiente`, `En curso`, `Completada` y `Bloqueada`; el detalle (número de PR, motivo de un bloqueo) va en `Notas`. `Lista` y `En revisión` **no se escriben**: se calculan desde Git y desde el alojamiento. El ID de la unidad va en el nombre de la rama o en el título del PR, para poder asociarlos.

### Comando `siguiente`
`siguiente` toma la primera fila `Pendiente` de `docs/ROADMAP.md` cuyas dependencias **que son filas de la tabla** estén `Completada`. Las dependencias que no son filas de la tabla (otro proyecto, una herramienta, una decisión de la persona) son **informativas**: se muestran y no bloquean. `siguiente <ID>` fuerza esa unidad (si no se puede, se detiene y lo dice); `siguiente?` solo informa. Antes de empezar, el árbol debe estar limpio y en la rama base: si no, decile a la persona qué falta y esperá.

### Al terminar una unidad
En el **mismo diff** que la implementa: su fila pasa a `Completada`, la cabecera de `docs/ROADMAP.md` se actualiza y la ficha `odd/tasks/<unidad>.md` se cierra.

### Memoria
Estas reglas viven acá, no solo en la memoria de la sesión. Mantené en `docs/ROADMAP.md` una cabecera de tres líneas que diga **dónde está el proyecto, qué sigue y qué lo bloquea**.
<!-- /orquestacion:registro -->
