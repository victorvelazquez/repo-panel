# Propuesta para `flow-skills`: opción `--unstage` en `flow-commit`

Escrita desde `repo-panel` el 2026-10-25, a pedido de la persona. Es una tarea **aparte** del renombre `flow-branch` a `flow-base`: se empieza recién cuando ese renombre esté fusionado. La persona acepta la orden en la sesión de `flow-skills` y corre `/flow-commit` y `/flow-pr` ella misma.

## 1. Problema, con evidencia

El 2026-10-25 `/flow-commit` falló dos veces seguidas con el mismo motivo: `index-not-empty`. Una sesión había movido archivos con `git mv`, lo que deja los cambios en staging, y Flow Commit se detuvo en la preparación y no creó ningún commit. El contenido estaba intacto en el árbol de trabajo; solo había que sacarlo del staging. Pero ni el agente ni la skill pueden hacerlo (la skill prohíbe mutar Git por su cuenta), así que la persona tuvo que abrir otra terminal y correr `git reset` a mano.

## 2. Por qué se niega hoy

En `scripts/flow-commit.mjs`, `ensureReady` lanza `index-not-empty` cuando `state.stagedPaths` no está vacío. No es un descuido: el comando arma su propio staging por unidad y ata el **índice vacío** al comprobante de preparación, para verificar con exactitud qué entró en cada commit y poder deshacer si algo sale mal.

## 3. Propuesta

Una opción **explícita**, `--unstage`, que ejecuta el propio runtime (no el agente):

- Se pasa solo cuando la persona la pide. El agente **nunca** la agrega por su cuenta tras un fallo; presenta el error con su sugerencia y se detiene, igual que con `--stash` en `flow-branch`. La sugerencia del error `index-not-empty` pasa a incluir `hint: "/flow-commit --unstage"`.
- Con la opción y el índice con cosas, el runtime: (1) guarda la lista de rutas en staging; (2) ejecuta un `git reset -q` **mixto** (solo el índice; nunca toca el árbol de trabajo); (3) vuelve a leer el estado y sigue con la preparación normal; (4) informa `unstaged: [rutas]` en el resultado, para que la persona vea exactamente qué sacó.
- **No** se aplica, y sigue negándose como hoy, si hay una operación en curso (merge, rebase, cherry-pick, revert) o archivos con conflicto sin resolver.
- No usa `reset --hard`, ni stash, ni borra nada.

Por qué opción y no comportamiento automático: un índice con cosas puede ser una selección deliberada (`git add -p`), y un `reset` silencioso descartaría esa intención sin avisar.

## 4. Pruebas que deberían existir

- Renombre en staging (`R100`): con `--unstage` se sacan del staging, el commit final las trata correctamente y el árbol queda limpio.
- Staging parcial (`git add -p`): los hunks quedan en el árbol de trabajo como cambios sin staging; no se pierde contenido.
- Sin la opción: sigue negándose con `index-not-empty` y muestra la sugerencia.
- Con operación en curso y con archivos en conflicto: se niega aunque se pase la opción.
- El resultado trae `unstaged` con las rutas exactas.

## 5. Lo que `repo-panel` espera

Cuando el panel detecta archivos en staging (lo calcula con Git), ofrece el comando fijo `/flow-commit --unstage` en lugar del `/flow-commit` común, con un aviso del motivo. No cambian los códigos del error (`index-not-empty`) ni los campos que ya usa el flujo.

## 6. Cómo trabajar

- Rama de tarea, **después** de fusionado el renombre a `flow-base`. No hagas commit, push ni PR: la persona corre `/flow-commit` y `/flow-pr`.
- **Dejá el índice vacío.** No uses `git mv` ni `git add`: es justo el problema que esta propuesta resuelve y no hay que repetirlo. Mové archivos con una operación de archivos normal.
- Correr las pruebas del repositorio y mostrar el resultado real.
- Terminar con **una línea** que diga qué se hizo y cuál es el siguiente paso.
