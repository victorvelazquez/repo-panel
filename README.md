# Repo Panel

A local, single-window dashboard for the repos you work on. It answers one question: **what is left for me to do?**

- A kanban board with one card per pending thing, in six columns: **Clean · Changes · Committed · PR in progress · Ready to merge · Needs attention**. A repo with local changes and a ready PR shows up in both columns.
- Per repo: uncommitted files, `+/−` lines, unpushed commits, and a full diff viewer.
- Per open PR: CI status and a **Merge** button that only enables when every check is green and GitHub reports the PR as mergeable. PRs with failed checks, conflicts or an outdated branch go to *Needs attention*.
- Repos organised in groups (personal, work, commercial…), shown as a colored tag on each card, with a group filter and a name search.
- A roadmap block on each repo card (in progress or next unit, progress bar, a problems badge and, on click, the roadmap header). It reads `docs/ROADMAP.md` from the remote base branch, not the working tree; repos without that file look unchanged.
- The states `Lista`, `En revisión` and `En curso` (derived) are computed from Git and GitHub, never written in the file. A unit is linked to a branch or an open PR by its ID inside the branch name or the PR title; those units are skipped when picking the next one (`siguiente`).
- A **Go work on** strip above the board lists the next actions in order: a PR ready to merge, a repo whose branch already merged (`/flow-branch`), changes not delivered yet, and a clean repo with a next roadmap unit. Clicking a chip filters the board to that repo. A manual order in `priority` (see Configuration) wins over the automatic one.
- A **Conformity** button (with a count badge) opens a drawer listing every repo, whatever the filters, that has no usable `docs/ROADMAP.md` or whose file has problems, with the line of each problem. Info-level problems (such as a dependency outside the table) are not listed. It is built from the roadmap read from the remote base branch, so unpushed edits do not show. Opening the panel at `http://127.0.0.1:<port>/#conformity` opens that drawer on load.
- The Conformity drawer also shows the **requirements** a repo must meet to show well in the panel, listed in `requirements.json` at the panel root, and the **prerequisites** of this machine (`git`, `gh` logged in, `orca`). Failing, outdated and unavailable requirements come first, with their level (`required` or `recommended`), their category and a remedy (the instruction an AI agent applies in that repo, shown as a second line); passing ones are collapsed. The panel only **detects**: it reads the remote base branch and never edits a file of another repo; applying a remedy is the agent's job, through `/flow-commit` and `/flow-pr`. Whether `flow-skills` is registered in pi is not checked.
- A card of a repo that lacks a **required** requirement shows a compact "N requirements missing" warning (the tooltip lists the ids) with a ✕ to hide it. A gap that is only recommended shows nothing on the card (the drawer still lists it), and nothing is shown while the requirements load or if they failed to load. Hiding the warning keeps the repo on the panel with the basic features; the choice is saved as `dismissed` in `config.json`.
- A **⋯** menu on each card (before ✕) holds "Put in conditions", present only while some requirement is not passing, and "Hide warning" / "Show warning". "Put in conditions" asks `POST /api/pi` with the key `put-in-conditions`; the server builds ONE line from the repo's requirements (the ids that are not passing, required first) that tells the agent in the open pi session to read `requirements/INSTALL.md` (absolute path, in double quotes, with the user's authorization to read that one file outside the repo) and apply those ids. It needs Orca and exactly one idle pi session, like the other buttons, and it refuses with 409 when everything already passes or the requirements could not be read. `confirmed` only means the prompt left the idle state; it does not prove the agent read or applied anything.
- A red banner at the top of the page appears when the server process is older than the page (for example after `git pull` without a restart). `GET /health` answers `{ "app": "repo-panel", "api": <n> }`; the page compares `api` with its own version and warns on a mismatch or a missing field. If the Conformity report cannot be computed, the drawer says so instead of claiming conformity.
- A **/flow-commit** button on cards with changes types that command into the pi session you already have open for that repo, through the Orca CLI. It sends only when exactly one pi terminal (title `π - …`) has that repo as its worktree and it is idle with an empty prompt; otherwise it refuses and says why (no session, several sessions, busy, text already typed, Orca not running). Orca cannot confirm delivery, so the panel checks that the session left the idle prompt and says `not confirmed` when it did not. The browser sends a command key, never text, and only `/flow-commit`, `/flow-pr` and `/flow-branch` exist on the server.
- Quick actions: open on GitHub, `git fetch --prune`, re-run failed checks, refresh.

The panel observes, merges when you click, and can hand `/flow-commit` to your open pi session; committing and opening PRs are still done by that session, not by the panel.

## Requirements

The panel shells out to `git` and the GitHub CLI, so both must be installed and working before you start. There are no npm dependencies and nothing else to install.

1. **Node.js 20+** (`node --version`).
2. **Git** on your `PATH`, with access to your repos' remotes (`git fetch` must work from the terminal).
3. **GitHub CLI** ([install](https://cli.github.com)) logged in to the account that can see your repos:
   ```bash
   gh auth login
   gh auth status     # must show "Logged in"
   ```
   The token needs the `repo` scope (PRs, CI status, merging) and `workflow` to re-run failed checks. `gh auth login` grants `repo` by default; add `workflow` with `gh auth refresh -s workflow`.

4. *(Optional)* The `orca` CLI on your `PATH`, only for the `/flow-commit` button.

Quick check that everything is ready: `node --version && git --version && gh auth status`. PRs, CI status and Merge depend on `gh`; the local git view only needs `git`.

## Quick start

```bash
git clone <this-repo-url> repo-panel
cd repo-panel
npm start          # then open http://127.0.0.1:4310
```

Other commands:

```bash
npm run open       # same as start, and opens the browser (Windows only)
npm test           # run the test suite
```

## Start automatically at logon (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1    # install
powershell -ExecutionPolicy Bypass -File scripts/uninstall-autostart.ps1  # remove
```

This registers a per-user scheduled task (no admin needed) that runs the panel hidden at every logon and retries every minute if it fails. The port never changes, so the URL stays stable and you can pin it as a browser app. Launching the panel while it is already running just exits quietly. If another program owns the port, the launch fails with a clear message instead of picking a different port.

### Restart after an update

The page files are read from disk on every request, but the server code is loaded only when the process starts. After `git pull` (or any update of the panel) the server must be restarted, or the page will talk to old code and show the red out-of-date banner.

The autostart task is called `repo-panel` (it runs `conhost.exe --headless node server.js`). `Stop-ScheduledTask` alone does **not** stop the Node process: it stays alive holding the port, and a new start exits silently with "repo-panel is already running". Restart by ending the process that listens on the port and then starting the task:

```powershell
Get-NetTCPConnection -LocalPort 4310 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Start-ScheduledTask -TaskName repo-panel
```

Use the `port` from `config.json` if you changed it. To check: open `/health`, it must show the current `api`, and the red banner must disappear after reloading the page.

## Configuration

On first run there is nothing to configure: click **+ Repo** to add a single folder, or to scan a parent folder for every repo inside it. The panel saves your choices to `config.json`, which is git-ignored so your local paths are never committed.

You can also create `config.json` by hand; copy `config.example.json` as a starting point:

| Key | Meaning | Default |
| --- | --- | --- |
| `port` | Port to listen on | `4310` |
| `priority` | Optional list of repo names (e.g. `["repo-panel", "api"]`) that go first in the "Go work on" strip, in that order; case-insensitive, unknown names ignored | none |
| `dismissed` | Optional list of repo ids whose "requirements missing" warning is hidden; written by the panel (`POST /api/dismiss` `{ id, on }`), invalid entries and duplicates ignored | none |
| `groups` | Named groups of repos (`{ "name", "repos": [{ "path", "base", "roadmap" }] }`); `base` and `roadmap` are optional | `[]` |

`POST /api/queue` takes the per-repo facts from the browser (it does not rerun any git or gh command) and orders them: repos in `priority` first, then merge, branch, deliver and start, keeping board order within each kind. `POST /api/conformity` takes each repo's roadmap availability and problems and returns the repos that do not conform.

### Requirements

`requirements.json` is `{ "version", "blocks", "requirements": [{ "id", "title", "category", "level", "check", "remedy" }] }`. `blocks` holds the version each Orquestación block must have (`<!-- orquestacion:NAME vX.Y -->` ... `<!-- /orquestacion:NAME -->`). The checks are pure functions in `checks.js`; the server reads the files from `origin/<base>` (`AGENTS.md`, the roadmap, `docs/ORQUESTACION.md`) and `checks.js` decides.

- Categories: `verificable` (the panel decides and can show it as passing), `parcial` (shows evidence, a person confirms) and `criterio` (never passing, only a reminder). Only `verificable` requirements can pass; a repo is `ready` only when every `required` one passes. `recommended` ones never affect `ready`.
- Result status: `pass`, `fail`, `outdated` (the block has another version, or is the old unversioned section), `unavailable` (could not be read: no repo, no base branch, missing file, or an unknown check type). Unavailable is never shown as passing or as failing.
- The old unversioned `## Orquestación` section (or the `orquestacion:bloque` marker) counts as an outdated `registro` block that asks to be updated, not as a missing one.
- The agent's instructions live in the panel folder, not in another project: `requirements/INSTALL.md` (the procedure: apply only the ids named in the order, never delete rules, stop and ask the user on a conflict with the repo's `AGENTS.md`, work on a task branch, never commit, push or open PRs) and `requirements/blocks/registro.md` and `requirements/blocks/ciclo.md` (the exact text of the versioned blocks). Each `remedy` points at them. The panel never edits another repo: the agent does, and the user delivers it with `/flow-commit` and `/flow-pr`.
- A file that cannot be read from the base branch for any reason other than "not on that ref" is reported as `unavailable` (reason `error`), is not cached, and is never counted as failing or passing.
- `GET /api/requirements?id=<repoId>` returns `{ available, base, results, summary }`; `GET /api/prerequisites` returns `{ items: [{ id, ok, detail }] }` for `git`, `gh` and `orca` (a missing tool is `ok: false`, not an error).
- The drawer says "All repositories conform." only when the roadmap report is empty **and** the requirements of every repo and the prerequisites were loaded and every repo is `ready`. While they load it says it is computing; if they fail to load it says so.

`base` is the branch work is merged into. When omitted, the panel reads it from `origin/HEAD` and falls back to `main`. `roadmap` is the repo-relative path of its plan file (default `docs/ROADMAP.md`); unsafe values (absolute, starting with `-`, or containing `..`) are ignored.

## Merge behaviour

- Clicking **Merge** merges immediately, with no confirmation (like GitHub's own button). It is only enabled when the PR is green and mergeable.
- Merging goes through the GitHub API, so your local branches and working tree are never touched.
- The server re-checks readiness right before merging and pins the merge to the PR head SHA, so a late push cancels it.
- *Delete branch* is offered only when the repo does not already delete merged branches (`deleteBranchOnMerge`). If GitHub already removed the branch, that is treated as success, and local branches whose remote disappeared show as "remote branch deleted" instead of an error.
- A repo whose current branch (other than the base) already landed gets a red **Merged: run /flow-branch** mark and goes to the top of its column. The panel flags it when the remote branch is gone or a merged PR came from that branch, and not when a new open PR reuses the branch name.
- `GET /api/roadmap?id=<repo>` returns the parsed `docs/ROADMAP.md` read with `git show origin/<base>:<path>`, never from the working tree, so a unit counts as done only once its PR is merged. Run a fetch to see newer data. A repo without the file answers `available: false` (not an error).
- Branch protection and required reviews on GitHub still apply.

## Computed unit states

The roadmap file only holds `Pendiente`, `En curso`, `Completada` and `Bloqueada`. The panel adds three states computed from Git and GitHub, never written in the file. A unit is linked to work by its ID as a complete token in a branch name or in an open PR title (`p2` matches `p2-header` and `feat/p2_x`, not `p20-x`, `p2.1-x` or `rp3b-x` for `rp3`).

- Precedence per unit: `En revisión` > `Lista` > `En curso` (derived) > the state written in the file. `Completada` and `Bloqueada` units are never overridden.
- `En revisión`: an open PR has the ID in its title or head branch.
- `Lista`: the current branch has the ID and the tree has changes or commits over the base, or another local branch with the ID has commits over `origin/<base>`.
- `En curso` (derived): a local branch with the ID exists, but it has no commits over the base and the tree is clean. A row written as `En curso` in the file creates no derived entry; it is only replaced when it becomes `Lista` or `En revisión`.
- `siguiente` skips every unit that has a derived state.
- A branch merged by squash still counts as not merged for Git, so it can only affect units that are not `Completada`, and it is ignored when its remote branch was deleted.

Known limits and what is not verified:

- Not seen in a browser: the card warning, the ⋯ menu, closing it by clicking outside or with Escape, and the drawer's passing list keeping its open state. Only the pure helpers (`cardWarning`, `cardMenu`) and the server routes are tested.
- The `put-in-conditions` order was never typed into a real pi session: not verified that the agent can read a file outside the repo from the order, nor how `orca send` handles a long line.

- Only the first 30 local branches are inspected; a matching branch beyond that is not seen.
- The real GitHub path (`En revisión` from `gh pr list`) and its rendering in the browser have no automated test; pure functions cover the logic.
- The requirements and prerequisites blocks of the Conformity drawer have no browser test: their rendering (collapsed passing list, remedy lines, loading and failed messages) and the badge count were not seen on screen. Unit tests cover the checks, the routes and `conformityView`.
- The conformity view was only checked with a headless screenshot of the open drawer. Not verified in a browser: clicking the button and a repo name, closing the drawer, the `All repositories conform.` message, the `no-base` and `no-repo` statuses, and a repo whose only problems are info-level. Unit tests cover the report logic.

## Security

The server binds to `127.0.0.1` only, rejects unknown `Host` headers (DNS rebinding), requires a random per-run token on every API call, and only operates on repositories listed in `config.json`.
