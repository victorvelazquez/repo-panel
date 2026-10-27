# Worked examples for INSTALL.md

Every example is checked by the tests (`test/rp41-standard.test.js` and `test/rp43-history-and-pending.test.js`): the "after" tables must pass the panel's validator. If an example and INSTALL.md disagree, INSTALL.md wins; say so in your report.

## A. A table with other column names (step 7)

Before: the panel rejects it with `Table is missing required columns: Entrega, Depende de`.

```md ejemplo:a-antes
| ID | Unidad | Dependencias | Estado | Notas |
| --- | --- | --- | --- | --- |
| FS1 | Skill de aprendizaje | - | Completada | PR #66 |
| FS2 | Renombrar una skill | FS1 | Completada | PR #68 |
```

After: only the headers change (and `-` becomes `—`); every row is kept, with its ID and its notes.

```md ejemplo:a-despues
| ID | Entrega | Depende de | Estado | Notas |
| --- | --- | --- | --- | --- |
| FS1 | Skill de aprendizaje | — | Completada | PR #66 |
| FS2 | Renombrar una skill | FS1 | Completada | PR #68 |
```

## B. Another way of tracking tasks (step 7)

Before: a summary in `planning/README.md`, one section per task, each with its own folder.

```md ejemplo:b-antes
### kubernetes-health-probes
**Objetivo:** Endpoints de salud de Kubernetes con validación de Redis
**Path:** `planning/kubernetes-health-probes/`
**Status:** Ready to Start
**Bloqueadores:** Ninguno

### bullmq-health-indicator
**Objetivo:** Indicador de salud de BullMQ
**Path:** `planning/bullmq-health-indicator/`
**Status:** Done
**Bloqueadores:** kubernetes-health-probes
```

After: one row per task. The ID is the one it already has (the folder name here), `Ficha` points to its old folder (which is kept), the state is translated with example C, and `Depende de` comes only from `Bloqueadores`.

```md ejemplo:b-despues
| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |
| --- | --- | --- | --- | --- | --- | --- |
| kubernetes-health-probes | Endpoints de salud de Kubernetes con validación de Redis | — | — | Pendiente | Status original: Ready to Start | planning/kubernetes-health-probes/ |
| bullmq-health-indicator | Indicador de salud de BullMQ | — | kubernetes-health-probes | Completada | Status original: Done | planning/bullmq-health-indicator/ |
```

`planning/README.md` itself is replaced by one line pointing to `docs/ROADMAP.md`.

## C. State words

The source says on the left; you write on the right. A word that is not here: STOP and ask the user.

```md ejemplo:c-estados
| La fuente dice | Escribí |
| --- | --- |
| Ready to Start, Pending, Todo, Backlog, Pendiente | Pendiente |
| In progress, WIP, En progreso, En curso | En curso |
| Done, Delivered, Merged, Entregado, Integrado, Completada | Completada |
| Blocked, Bloqueado, Bloqueada | Bloqueada |
| Paused or On hold, naming what blocks it (`Paused - Bloqueado por DevOps`) | Bloqueada |
| Paused or On hold, naming nothing (`Paused - Nice-to-have`) | Pendiente |
```

## D. Rules about branches, commits and pull requests in `AGENTS.md` (step 8)

Before:

```md ejemplo:d-antes
## 📝 Commit Convention (Spanish)

Format: `<type>(<scope>): <descripción>`

## 🌿 Branching Strategy (Git Flow)

- `master` - Production
- `development` - Development
- `feature/ABC-123-descripcion` - Features
- `release/1.0.0` - Releases
- `hotfix/XYZ-456-descripcion` - Hotfixes

## 🧪 Testing

Run `npm test` before every PR.
```

After: the commit convention and the naming of day-to-day branches are gone (the `entrega` block replaces them); what each long-lived branch is for stays, because pipelines may depend on it; the testing rule is not about delivery, so it stays.

```md ejemplo:d-despues
## Ramas de larga vida

- `master` - Production
- `development` - Development
- `release/1.0.0` - Releases
- `hotfix/XYZ-456-descripcion` - Hotfixes

## 🧪 Testing

Run `npm test` before every PR.
```

## E. The last answer (step 11)

In the user's language; the report, then ONE last line.

```md ejemplo:e-informe
Migré 2 tareas a docs/ROADMAP.md: kubernetes-health-probes (Pendiente) y bullmq-health-indicator (Completada).
Quité de AGENTS.md: «Commit Convention (Spanish)» (3 líneas) y la línea `feature/ABC-123-descripcion` de «Branching Strategy (Git Flow)» (1 línea). Conservé las ramas de larga vida y la regla de pruebas.
Otros archivos de instrucciones, ahora obsoletos (no los toqué):
- .cursorrules — último commit 2025-11-27 — encabezados que AGENTS.md no tiene: «Cursor rules», «Prompts»
- .github/copilot-instructions.md — último commit 2026-08-05 — encabezados que AGENTS.md no tiene: «Input Validation», «Security Checklist»
Siguiente: correr /flow-commit; el ID de la tarea para el título del PR es kubernetes-health-probes.
```

## F. A checklist inside each change (step 7)

Before: `openspec/changes/export-users/tasks.md`. It is the breakdown of ONE change, not a list of the project's tasks.

```md ejemplo:f-antes
# Tasks: export-users (openspec/changes/export-users/tasks.md)

- [x] 1.1 Export endpoint contract
- [x] 1.2 Export endpoint implementation
- [ ] 2.1 CSV streaming for large exports
- [ ] 2.2 Rate limit of the export endpoint
- [ ] 3.1 Document the export in the API guide
```

After: the folder stays untouched, as history, and the roadmap gets ONE row for the whole change: pending, marked "sin verificar", with the count of unchecked steps. A change with every step checked, and an archived one, gets no row.

```md ejemplo:f-despues
| ID | Entrega | Resultado visible | Depende de | Estado | Notas | Ficha |
| --- | --- | --- | --- | --- | --- | --- |
| export-users | Exportar usuarios en CSV | — | — | Pendiente | Migrada; sin verificar si ya se implementó (3 de 5 pasos sin marcar) | openspec/changes/export-users/ |
```
