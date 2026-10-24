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
- Quick actions: open on GitHub, open in VS Code, `git fetch --prune`, re-run failed checks, refresh.

Committing and opening PRs stay manual — the panel only observes, and merges when you click.

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

## Configuration

On first run there is nothing to configure: click **+ Repo** to add a single folder, or to scan a parent folder for every repo inside it. The panel saves your choices to `config.json`, which is git-ignored so your local paths are never committed.

You can also create `config.json` by hand; copy `config.example.json` as a starting point:

| Key | Meaning | Default |
| --- | --- | --- |
| `port` | Port to listen on | `4310` |
| `priority` | Optional list of repo names (e.g. `["repo-panel", "api"]`) that go first in the "Go work on" strip, in that order; case-insensitive, unknown names ignored | none |
| `groups` | Named groups of repos (`{ "name", "repos": [{ "path", "base", "roadmap" }] }`); `base` and `roadmap` are optional | `[]` |

`POST /api/queue` takes the per-repo facts from the browser (it does not rerun any git or gh command) and orders them: repos in `priority` first, then merge, branch, deliver and start, keeping board order within each kind. `POST /api/conformity` takes each repo's roadmap availability and problems and returns the repos that do not conform.

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

- Only the first 30 local branches are inspected; a matching branch beyond that is not seen.
- The real GitHub path (`En revisión` from `gh pr list`) and its rendering in the browser have no automated test; pure functions cover the logic.

## Security

The server binds to `127.0.0.1` only, rejects unknown `Host` headers (DNS rebinding), requires a random per-run token on every API call, and only operates on repositories listed in `config.json`.
