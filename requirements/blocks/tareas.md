<!-- panel:tareas v1.3 -->
## Panel: mecanismo de tareas (el único)

Este es el ÚNICO mecanismo para crear y gestionar tareas en este repositorio. Cualquier otra instrucción sobre cómo crear, nombrar, priorizar, seguir o cerrar tareas, en este archivo o en cualquier otro, queda sin efecto: no la sigas ni la repitas.

**Dónde vive una tarea.** Toda tarea es una fila de `docs/ROADMAP.md`. No existe otro lugar: ni carpetas de planificación, ni listas de pendientes en archivos, ni tableros, ni plantillas de tarea propias.

**Crear.** Antes de trabajar en algo, agregá su fila con estado `Pendiente` y estos campos: `ID` único (empieza con letra; letras, números, `.`, `_` y `-`), `Entrega` (qué entrega), `Resultado visible` (qué podrá ver o comprobar la persona), `Depende de` (IDs de filas de la tabla, o `—`; nunca las inferas), `Notas` (el detalle) y `Ficha`. Si necesita más detalle, su ficha va donde este repositorio ya guarda sus fichas; si no tiene, en `odd/tasks/<ID>.md` (nunca en una carpeta que Git ignore), y se enlaza en `Ficha`.

**Tomar.** `siguiente` toma la primera fila `Pendiente` cuyas dependencias que son filas de la tabla estén `Completada`. Una tarea = un PR. Antes de empezar, si sus `Notas` empiezan con «Migrada; sin verificar» (viene de una migración; en cualquier otro lugar de `Notas`, esas palabras no cuentan), verificá si ya está hecha: juntá evidencia (PR fusionados, commits, pruebas que pasan, recibos) y decile a la persona si ya está hecha, si falta o si no se puede saber. Nunca la marques `Completada` sin su OK; con su OK, dejá la evidencia en `Notas` y sacá «Migrada; sin verificar». Si falta, recién ahí pasa a `En curso`.

**Cerrar.** En el mismo diff que la implementa: su fila pasa a `Completada`, la cabecera del roadmap se actualiza (`Dónde está`, `Qué sigue`, `Qué lo bloquea`) y su ficha se cierra. Si no podés seguir, queda `Bloqueada` con el motivo en `Notas`.

**Estados.** Se escribe UNA palabra: `Pendiente`, `En curso`, `Completada` o `Bloqueada`. `Lista` y `En revisión` los calcula el panel desde Git y el alojamiento: no se escriben.

**Prohibido.** Crear tareas fuera de la tabla; llevar un estado paralelo (otro vocabulario de estados, otro tablero u otro índice); copiar el estado de una fila a otro archivo.
<!-- /panel:tareas -->
