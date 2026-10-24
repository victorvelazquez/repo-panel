# Put a repo in conditions for repo-panel

You are in the pi session of ONE repo, and the user typed an order that points you here. The order names the requirement ids to apply. Follow this file; do nothing outside it.

1. Read `requirements.json` in the panel folder (the folder that contains this `requirements/` folder). Each requirement has an `id`, a `title`, a `level` and a `remedy`.
2. Apply ONLY the ids named in the order. Skip every other requirement, even if it looks incomplete.
3. For each id, follow its `remedy`. The versioned blocks you add to `AGENTS.md` are the files in `requirements/blocks/` (`registro.md`, `ciclo.md`): copy the whole file, opening and closing markers included, unchanged. In the `ciclo` block, remove the lines from `<!-- SALA -->` to `<!-- /SALA -->` (markers included) unless the user says this repo belongs to a sala.
4. Never delete existing rules. Add the block to the existing `AGENTS.md`, or create the file if it does not exist.
5. If `AGENTS.md` already has a rule that conflicts with a block (for example a different roadmap path, state names, or a rule about commits or branches), STOP. Quote both rules, ask the user which one wins, and wait. Do not decide alone.
6. `docs/ROADMAP.md` follows the format of the `registro` block: the three header lines (`**Dónde está:**`, `**Qué sigue:**`, `**Qué lo bloquea:**`) and the units table. Do not invent units: if the project has no plan yet, ask the user for it.
7. Work on a task branch, not on the base branch. Do not commit, push or open PRs yourself: the user runs `/flow-commit` and `/flow-pr`.
8. Finish by writing ONE line that says what you did and the next step for the user (normally: run `/flow-commit`).
