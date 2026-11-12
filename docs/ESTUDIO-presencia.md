# Estudio: la presencia de los subagentes en la versión instalada de Gentle Pi (RP153)

Estudio de solo lectura. No cambia el código del panel. Responde a la fila RP153 de `docs/ROADMAP.md`: qué publica hoy Gentle Pi (4.7.0) sobre los subagentes en ejecución, si el formato que midió el estudio de la 4.6.0 (`docs/ESTUDIO-subagentes.md`) sigue valiendo, qué campos son seguros de mostrar y qué opciones hay para que el panel muestre el nombre del agente, su estado y su última actividad, con los estados Lento y Sin señal.

- **Cómo se obtuvo.** Una lectura de solo lectura, con permiso por escrito de la persona y con la ruta exacta, de la carpeta de presencia del perfil de Gentle Pi (`C:\Users\victor\.gentle-shell\agent\gentle-agents\presence\`). Se midió solo la FORMA: nombres de archivo (sin copiarlos), tamaños, fechas, claves, tipos de valor, números y palabras cortas en minúsculas como `running`. **No se leyó ni se copió ningún texto:** ni `label`, ni nombres de modelo, ni ids, ni rutas, ni el contenido del `thread`, del prompt o del resultado.
- **Una medición en vivo, provocada por mí.** Como al empezar no había ningún subagente corriendo, lancé uno de solo lectura y sin riesgo desde mi propia sesión y medí su presencia mientras corría (unos 25 segundos). Fue la única forma de ver una tarea real.
- **Lo que no se hizo.** No se escribió nada en la carpeta, no se borró nada, no se mandó nada a ninguna sesión y no se escribió código. No se abrió el contenido del `thread`.

## 1. Conclusiones

1. **La carpeta existe en la 4.7.0** y tiene 250 archivos: 84 `header`, 84 `activity` y 82 `discovery`, de 68 sesiones distintas y 84 arranques. Tamaños: `header` de 360 a 395 bytes, `discovery` de 532 a 1582 y `activity` de 185 bytes sin tareas a 498 con una tarea.
2. **El formato cambió respecto de la 4.6.0.** El `header` ahora trae `schema`, `sessionHash`, `incarnation`, `label`, `heartbeat`, `generation`, `counts`, `digest` y `unavailable`; el latido es un número en milisegundos de época; y `activity` guarda la lista en `activity.tasks`. Lo que sigue valiendo: `counts` con `running`, `queued`, `waiting` y `finished`, y el `summary` de cada tarea con los tiempos. **Lo que midió el estudio de la 4.6.0 no se puede dar por bueno sin volver a medir**, y por eso este estudio existía.
3. **Una tarea corriendo se ve así en la 4.7.0** (medido en vivo): `header.counts.running` pasa de 0 a 1; `activity.tasks` tiene una entrada con `summary` (`id`, `agent`, `label`, `model`, `status` con el valor `running`, `createdAt`, `startedAt`, `endedAt` en `null` mientras corre y `lastActivityAt`, todos los tiempos en milisegundos) y un `thread` con `version`, `dropped` e `items`. En ese momento `items` estaba vacío: **qué lleva cada ítem no se verificó.**
4. **La mayoría de los archivos son restos.** De 83 encabezados legibles, **3** tenían un latido de 3 segundos o menos (las 3 sesiones vivas), 7 de menos de un día y el resto de hasta unos 20 días. Nadie los limpia. Un lector que no mire el latido muestra fantasmas. Es coherente con lo que midió RP107 (76 encabezados, 5 vivos).
5. **Hay un campo que apunta a tu disco y a tus sesiones: `discovery`.** Trae rutas (`root`, `cwd`), el id de la sesión y alias. **No hay ninguna razón para leer ese archivo.**
6. **Un archivo cambió de tamaño entre dos lecturas.** En el primer listado un `activity` medía 11 KB y minutos después ninguno pasaba de 189 bytes: los archivos se reescriben cuando la tarea termina. Significa que el `thread` puede crecer bastante mientras la tarea corre.
7. **Un `header` y un `discovery` no se pudieron leer** (probablemente a medio escribir). Un lector tiene que tolerarlo y saltear ese archivo, sin inventar un estado.

## 2. Qué es seguro de mostrar

| Campo | Qué es | ¿Se manda a la página? |
| --- | --- | --- |
| `header.counts.*` | cuatro números | **Sí**, enteros acotados |
| `header.heartbeat` | milisegundos de época | **Sí, solo como «vivo o no»** (el servidor compara con su reloj; no viaja el número) |
| `summary.status` | `running` y otros valores cortos | **Sí**, solo si coincide con una lista cerrada |
| `summary.startedAt`, `lastActivityAt`, `endedAt` | milisegundos | **Sí**, como «hace N minutos» calculado en el servidor |
| `summary.agent` | nombre del agente | **Sí, con un patrón estricto** (letras, números, guion; largo acotado) |
| `summary.model` | nombre del modelo | Opcional; mismo patrón |
| `summary.label` y `header.label` | texto libre que pone quien lanza la tarea | **No** |
| `summary.id`, `sessionHash`, `incarnation`, `digest` | identificadores | **No** (sirven solo adentro del servidor) |
| `thread.items` | pasos de la tarea; el estudio de la 4.6.0 encontró salidas de herramientas | **No, nunca** |
| `discovery.*` | rutas, id de sesión, alias | **No, ni se abre** |

## 3. Opciones

| | Qué es | Riesgo | Tamaño | Qué prueba demostraría que no se abusa |
| --- | --- | --- | --- | --- |
| **a** | Leer solo el `header`: cuántos corren, esperan o están en cola, y si la sesión está viva por el latido. Sin nombres. | **Bajo**: son números y un latido. | Pequeño. | Un archivo cortado, un latido viejo que dice `running`, números enormes o negativos, y que la respuesta nunca lleve texto. |
| **b** | `header` más el `summary` de `activity.tasks`: nombre del agente, estado y última actividad, con los estados Lento, Posible bloqueo y Sin señal. | **Medio a alto**: se abre un archivo que lleva el `thread`; todo depende de una lista blanca estricta y de un tope de tamaño. | Mediano (más de 300 líneas con las pruebas). | Todas las de a, más: un `thread` hostil o enorme, un archivo mayor que el tope (se saltea), campos de más, nombres que escapan de la carpeta, y que el `thread` nunca pase por la respuesta. |
| **c** | No construirlo. RP161 y RP163 ya cuentan los subagentes en segundo plano y apagan los botones; RP152 muestra los que bloquean. | Ninguno. | Cero. | No aplica. |

## 4. Recomendación y decisión pendiente

1. **Recomendado: b, con una lista blanca estricta y un tope de tamaño del archivo**, empezando por la parte a dentro de la misma fila (primero los números y el latido, después los nombres). Es lo único que le agrega algo nuevo a lo que ya hay: saber **cuál** subagente trabaja, **desde cuándo** y si se **trabó**. El resto (apagar botones, contar los de segundo plano) ya está hecho.
2. **c es una respuesta válida.** Si hoy no te molesta no ver el nombre ni los estados Lento y Sin señal, no hace falta abrir un tema de privacidad.
3. **Descartado: leer `discovery`** y mandar `label` o `thread` a la página.

**Decisión de la persona (no tomada):** (i) a, b o c; (ii) los umbrales, que son propuestas desde el principio y nunca confirmadas: Lento a los 2 minutos sin actividad, Posible bloqueo a los 5 y Sin señal con el latido de más de 15 segundos (el `lastActivityAt` que se vio sirve para medirlos, pero cómo se mueve con una tarea real no se midió); (iii) si el nombre del agente se muestra (recomendado) y el `label` no. Con la decisión se reescribe el alcance de RP164, que es de alto riesgo, con pruebas de abuso primero y verificación independiente.

## 5. Evidencia y lo que no se sabe

- **Medido:** 250 archivos; la forma de `header`, `activity` y `discovery`; los tamaños; 3 latidos vivos de 83 encabezados legibles; la forma de una tarea corriendo (una sola, una sola vez).
- **Sin verificar:** qué lleva cada ítem de `thread` y cuánto pesa con una tarea larga (el único `activity` de 11 KB desapareció antes de poder medirlo); cada cuántos segundos se renueva el latido (las tres sesiones vivas tenían entre 2 y 3 segundos, coherente con los 5 que dice la 4.6.0, pero no se midió); qué pasa con `queued`, `waiting` y `finished` (solo se vio `running`); cómo se mueve `lastActivityAt` en una tarea larga; que `sha256` del id de la sesión adoptada coincida con el nombre del archivo en la 4.7.0 (el estudio de la 4.6.0 lo comprobó en 8 de 15; acá el `header` trae `sessionHash` pero no se cruzó con ninguna sesión); qué hace Gentle Pi con los archivos de un proceso que murió (hoy se acumulan); una sola versión (4.7.0) y una sola muestra de tarea.
