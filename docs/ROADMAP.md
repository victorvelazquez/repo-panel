# Hoja de ruta de repo-panel

**Dónde está:** el panel muestra cambios, commits, PR y CI, marca las ramas ya fusionadas, adoptó el registro de Orquestación (RP0, RP4), lee `docs/ROADMAP.md` de la rama base remota (RP1, RP2), la tarjeta del repositorio muestra la unidad en curso o siguiente, el progreso, la cabecera en vivo y una insignia de problemas (RP3), calcula `Lista` y `En revisión` desde Git y GitHub (RP3b), y el tablero tiene una franja «Ir a trabajar en» con la lista ordenada de acciones y `priority` en la configuración (RP5), y hay una vista de conformidad que lista los repositorios sin `docs/ROADMAP.md` o con problemas (RP6).
**Qué sigue:** la aprobación visual de la persona con datos reales (criterio 5) y cerrar la serie; RP7 queda diferida.
**Qué lo bloquea:** la aprobación visual de la persona (criterio 5).

<!-- Estado: UNA palabra entre Pendiente, En curso, Completada y Bloqueada.
     "Lista" y "En revisión" las calculan Git y el alojamiento; no se escriben.
     Depende de: IDs separados por coma, o —. Entre proyectos, con prefijo (CATALOGO-C4).
     El detalle (número de PR, motivo de un bloqueo) va en Notas. -->

| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |
| --- | --- | --- | --- | --- | --- | --- |
| RP0 | Adoptar la Orquestación (perfil «compatible con panel») | Reglas en `AGENTS.md` y esta hoja de ruta | — | Completada | | — |
| RP1 | `parseRoadmap(markdown)` puro en `lib.js`, con pruebas | Función probada con las muestras A y B | RP0 | Completada | | — |
| RP2 | El servidor lee `docs/ROADMAP.md` de la rama base remota | Datos de tareas en el estado de cada repositorio | RP1 | Completada | Rama base: `origin/HEAD`, respaldo `main` | — |
| RP3 | Tarjeta con en curso, siguiente, progreso, cabecera e insignia de problemas | Unidad y progreso visibles en la tarjeta | RP2 | Completada | | — |
| RP3b | Estados calculados `Lista` y `En revisión` | Unidades con trabajo en marcha marcadas | RP2 | Completada | Reglas en el README. No verificado: la vía real de GitHub (En revisión) y su renderizado en el navegador no tienen prueba automática; límite conocido: 30 ramas locales | — |
| RP4 | Razón «Merged: run /flow-branch» | Tarjeta con marca de atención en rama ya fusionada | RP0 | Completada | Se hizo antes que RP1; suma `base` por repo en la configuración. No verificado: la vía `gh` (PR fusionado) no tiene prueba de integración; la cubren la prueba pura y una comprobación manual | — |
| RP5 | Franja «Ir a trabajar en» y `priority` en la configuración | Lista ordenada de acciones sobre el tablero | RP3, RP3b, RP4 | Completada | | — |
| RP6 | Vista de conformidad | Lista de repositorios sin `ROADMAP.md` o con problemas | RP3 | Completada | Suma `POST /api/conformity` porque el navegador no puede importar `lib.js`. No verificado en navegador: clic del botón y del nombre de repo, cerrar el cajón, «All repositories conform.», estados no-base y no-repo y el caso solo-info (solo pruebas unitarias) | — |
| RP7 | Dependencias con prefijo de otro proyecto (`PREFIJO-ID`) | «espera: …» y estado del otro repositorio | RP2, RP3 | Pendiente | Diferida: la sala ya vigila las dependencias entre proyectos; hacerla si el panel se usa sin sala. Informativa, nunca bloquea | — |
