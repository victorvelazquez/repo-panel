# Put a repo in conditions for repo-panel

You are in the pi session of ONE repo, and the user typed an order that points you here. The order names the requirement ids to apply. Follow this file; do nothing outside it.

1. Read `requirements.json` in the panel folder (the folder that contains this `requirements/` folder). Each requirement has an `id`, a `title`, a `level` and a `remedy`.
2. Apply ONLY the ids named in the order. Skip every other requirement, even if it looks incomplete.
3. For each id, follow its `remedy`. The versioned blocks you add to `AGENTS.md` are the files in `requirements/blocks/` (`registro.md`, `ciclo.md` and, for the panel's own `estado-block`, `estado.md` with the markers `<!-- panel:estado v1.0 -->` and `<!-- /panel:estado -->`): copy the whole file, opening and closing markers included, unchanged. The `ciclo` block has regions between `<!-- SALA -->` and `<!-- /SALA -->`: Keep the SALA region (both marker lines and everything between them) when the repo is a member of a room or when the order names `sala-region`; remove it only when neither applies. If a kept region is missing from the `ciclo` block already in `AGENTS.md`, restore it exactly as in `requirements/blocks/ciclo.md`.
4. For `panel-ignored`, append the line `.panel/` to `.git/info/exclude` of the repo (create the file if it does not exist, and do not duplicate the line). Never add it to `.gitignore` and never commit it: it is local to this clone, so there is nothing to deliver.
5. Never delete existing rules. Add the block to the existing `AGENTS.md`, or create the file if it does not exist.
6. If `AGENTS.md` already has a rule that conflicts with a block (for example a different roadmap path, state names, or a rule about commits or branches), STOP. Quote both rules, ask the user which one wins, and wait. Do not decide alone.
7. `docs/ROADMAP.md` follows the format of the `registro` block: the three header lines (`**Dónde está:**`, `**Qué sigue:**`, `**Qué lo bloquea:**`) and the units table. Do not invent units: if the project has no plan yet, ask the user for it.
8. Work on a task branch, not on the base branch. Do not commit, push or open PRs yourself: the user runs `/flow-commit` and `/flow-pr`.
9. Never use `git mv` or `git add`: leave the git index empty (use plain file operations to move or rename files), because `/flow-commit` refuses to start when files are staged.
10. Finish by writing ONE line that says what you did and the next step for the user (normally: run `/flow-commit`).
