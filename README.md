# Repo Panel

A local, single-window dashboard for the repos you work on. It answers one question: **what is left for me to do?**

- A kanban board with one card per pending thing, in six columns: **Clean · Changes · Committed · PR in progress · Ready to merge · Needs attention**. A repo with local changes and a ready PR shows up in both columns.
- Per repo: uncommitted files, `+/−` lines, unpushed commits, and a full diff viewer.
- Per open PR: CI status and a **Merge** button that only enables when every check is green and GitHub reports the PR as mergeable. PRs with failed checks, conflicts or an outdated branch go to *Needs attention*.
- Repos organised in groups (personal, work, commercial…), shown as a colored tag on each card, with a group filter and a name search.
- A roadmap block on each repo card (in progress or next unit, progress bar, a problems badge and, on click, the roadmap header). It reads `docs/ROADMAP.md` from the remote base branch, not the working tree; repos without that file look unchanged.
- The states `Lista`, `En revisión` and `En curso` (derived) are computed from Git and GitHub, never written in the file. A unit is linked to a branch or an open PR by its ID inside the branch name or the PR title; those units are skipped when picking the next one (`siguiente`).
- A **Go work on** strip above the board lists the next actions in order: a PR ready to merge, a repo whose branch already merged (`/flow-base`; with uncommitted changes it is only that, never also "Deliver changes"), changes not delivered yet, and a clean repo with a next roadmap unit. Clicking a chip filters the board to that repo. A manual order in `priority` (see Configuration) wins over the automatic one.
- The strip also has two chips for repos that must not be delivered yet: **Manual action** (red) for a repo that needs a person's hands (detached HEAD, commits on the base branch, a merge or rebase in progress, a diverged branch, or a `/flow-commit` that needs attention) and **Waiting for you** (blue) for a repo whose declared state is `needs-input` or `blocked`, with its next step. Such repos are no longer told to deliver changes; the full text is in the chip's tooltip.
- A **Conformity** button (with a count badge) opens a drawer listing every repo, whatever the filters, that has no usable `docs/ROADMAP.md` or whose file has problems, with the line of each problem. Info-level problems (such as a dependency outside the table) are not listed. It is built from the roadmap read from the remote base branch, so unpushed edits do not show. Opening the panel at `http://127.0.0.1:<port>/#conformity` opens that drawer on load.
- The Conformity drawer also shows the **requirements** a repo must meet to show well in the panel, listed in `requirements.json` at the panel root, and the **prerequisites** of this machine (`git`, `gh` logged in, `orca`). Failing, outdated and unavailable requirements come first, with their level (`required` or `recommended`), their category and a remedy (the instruction an AI agent applies in that repo, shown as a second line); passing ones are collapsed. The panel only **detects**: it reads the remote base branch and never edits a file of another repo; applying a remedy is the agent's job, through `/flow-commit` and `/flow-pr`. Whether `flow-skills` is registered in pi is not checked.
- A card of a repo that lacks a **required** requirement shows a compact "N requirements missing" warning (the tooltip lists the ids) with a ✕ to hide it. A gap that is only recommended shows nothing on the card (the drawer still lists it), and nothing is shown while the requirements load or if they failed to load. Hiding the warning keeps the repo on the panel with the basic features; the choice is saved as `dismissed` in `config.json`.
- A **⋯** menu on each card (before ✕) holds "Put in conditions", present only while some requirement is not passing, and "Hide warning" / "Show warning". "Put in conditions" asks `POST /api/pi` with the key `put-in-conditions`; the server builds ONE line from the repo's requirements (the ids that are not passing, required first) that tells the agent in the open pi session to read `requirements/INSTALL.md` (absolute path, in double quotes, with the user's authorization to read that one file outside the repo) and apply those ids. It needs Orca and exactly one idle pi session, like the other buttons, and it refuses with 409 when everything already passes or the requirements could not be read. `confirmed` only means the prompt left the idle state; it does not prove the agent read or applied anything.
- **Rooms.** A room is a repo where you coordinate a group of repos (for example `upen-ceo`). A repo assigned to a room shows a room tag next to its group tag, with a dot: green when a pi session is open in the room folder and idle, yellow when it is busy, gray when there is none, when several are open or when Orca could not be asked; the tooltip says which and gives the date of the room's last commit. The Conformity drawer has a **Rooms** section with each room's session, requirements and members. Repos outside every room look exactly as before. See Rooms below.
- A red banner at the top of the page appears when the server process is older than the page (for example after `git pull` without a restart). `GET /health` answers `{ "app": "repo-panel", "api": <n> }`; the page compares `api` with its own version and warns on a mismatch or a missing field. If the Conformity report cannot be computed, the drawer says so instead of claiming conformity.
- A **/flow-commit** button on cards with changes types that command into the pi session you already have open for that repo, through the Orca CLI. It sends only when exactly one pi session is open in that repo's worktree and it is idle with an empty prompt; otherwise it refuses and says why (no session, several sessions, busy, text already typed, Orca not running). **How a pi session is recognised:** by its screen, never by the terminal title (Orca renames the same live session: `pi`, `Windows PowerShell`, `π - name`, `Terminal 1`). The panel runs a fresh `orca terminal show` on each connected, writable terminal of the repo's worktree and looks at the last 8 non-empty lines for the prompt bars of Gentle Shell: `▎ <glyph> waiting for input` (idle when the next bar line is `▎   type, or / for commands`, otherwise text is typed) or `▎ <glyph> working…` (busy); the glyph alternates (`✿`, `❁`) and does not matter. A plain `pi` run without Gentle Shell, or a busy verb other than `working…`, is NOT detected: the panel then says there is no session and refuses to send. Each check costs one `orca terminal show` per terminal of the worktree, plus one `list`. Orca cannot confirm delivery, so the panel checks that the session left the idle prompt and says `not confirmed` when it did not. The browser sends a command key, never text, and only `/flow-commit`, `/flow-pr`, `/flow-base`, `/flow-base --stash` (key `flow-base-stash`), `put-in-conditions` and `fix-pr` exist on the server. `fix-pr` also takes `pr`, the integer number of an open pull request of that repo (`POST /api/pi` `{ id, command: "fix-pr", pr }`; `API_VERSION` 12): the server looks the PR up itself, refuses with 400 when `pr` is missing or not a positive integer and with 409 when the PR does not exist, is not open or has no failing checks, then builds ONE line from the PR number, title, head branch and up to 5 failing check names (control characters replaced by a space, double quotes dropped, title capped at 120 and each name at 60 characters). The order tells the agent to find out why with `gh`, switch to the PR branch only if the tree is clean (otherwise stop and ask), fix whatever is needed (production code, test code or configuration) as long as it serves the original objective of that PR (its title, description and commits), run the tests, and not commit, push or open pull requests. When the failure is unrelated to that objective or looks transient (infrastructure, a flaky run, a runner problem) it must not edit code: it says so and recommends **Re-run failed**; when the right fix would change the PR's scope or needs a product decision it stops and asks. It goes through the same safeguards as the other buttons (exactly one idle pi session, one send at a time per repo).
- Quick actions: open on GitHub, `git fetch --prune`, re-run failed checks, refresh.

Not verified: the `/flow-pr` button, the manual-action bar, the "Show /flow-commit anyway" item and the committing/attention lines were checked through their pure helpers, a render smoke test with a stubbed page and real throwaway Git repos, but not in a browser; the verdict was not run against a real pi session end to end; and nothing was tried with many repos (each repo polled after a `/flow-commit` costs one `orca terminal list` per refresh).

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

#### Tray icon (Windows)

To avoid doing that by hand, `scripts/tray.ps1` puts an icon in the notification area (next to Docker and the like). It is a hidden PowerShell script (Windows PowerShell 5.1 or PowerShell 7, no dependencies).

```powershell
.\scripts\install-tray.ps1      # registers the per-user task repo-panel-tray at logon (no admin)
Start-ScheduledTask -TaskName repo-panel-tray   # start it now, without logging out
.\scripts\uninstall-tray.ps1    # removes the task (close a running tray with its "Quit tray" item)
```

`install-tray.ps1 -DryRun` (and `uninstall-tray.ps1 -DryRun`) only print what they would do. You can also run `powershell -File scripts\tray.ps1` by hand; a second launch exits quietly (one tray at a time). The port is read from `config.json` (or `REPO_PANEL_CONFIG`, or `-ConfigPath`), default 4310; an unreadable config uses the default.

- The icon is green when `http://127.0.0.1:<port>/health` answers `repo-panel`, gray when it does not (checked every 5 seconds); the tooltip says `repo-panel: running (port N)` or `repo-panel: stopped`.
- Right-click menu: **Open panel** (also the double-click), **Restart panel**, **Start panel** (enabled only when stopped) and **Quit tray** (the panel keeps running).
- **Restart panel** ends only the processes listening on the port whose command line runs this repo's `server.js` (a path inside this folder, or the `node server.js` form of the autostart task that also answers `/health` as `repo-panel`). If something else holds the port it ends nothing and says so. Then it runs the `repo-panel` task, or, if that task does not exist, `conhost.exe --headless node server.js` in this folder, waits up to 15 seconds for `/health` and reports the result in a balloon tip.
- It only talks to `127.0.0.1`. Errors show as a balloon tip; the tray keeps running.
- `scripts\tray.ps1 -SelfTest` prints the facts the menu uses (port, health, listeners, owned listeners, task) as one JSON line and opens no window; `-SelfTestRestart` runs the end-and-relaunch logic and refuses unless `REPO_PANEL_CONFIG` is inside the temp folder. The tests use these two modes.
- Windows only. Not verified by the tests (they cannot see the desktop): that the icon is visible, its colors, the right-click menu, the balloon tips, and clicking **Open panel** / **Restart panel** in the real menu. If the tray process is killed (not quit), Windows may keep a ghost icon until the mouse passes over it.

## Configuration

On first run there is nothing to configure: click **+ Repo** to add a single folder, or to scan a parent folder for every repo inside it. The panel saves your choices to `config.json`, which is git-ignored so your local paths are never committed.

You can also create `config.json` by hand; copy `config.example.json` as a starting point:

| Key | Meaning | Default |
| --- | --- | --- |
| `port` | Port to listen on | `4310` |
| `priority` | Optional list of repo names (e.g. `["repo-panel", "api"]`) that go first in the "Go work on" strip, in that order; case-insensitive, unknown names ignored | none |
| `dismissed` | Optional list of repo ids whose "requirements missing" warning is hidden; written by the panel (`POST /api/dismiss` `{ id, on }`), invalid entries and duplicates ignored | none |
| `rooms` | Optional list of rooms, `[{ "name", "path", "repos": [repoId] }]`; written by the panel's **+ Room** screen and the card menu, or by hand (see Rooms) | none |
| `groups` | Named groups of repos (`{ "name", "repos": [{ "path", "base", "roadmap" }] }`); `base` and `roadmap` are optional | `[]` |

`POST /api/queue` takes the per-repo facts from the browser (it does not rerun any git or gh command) and orders them: repos in `priority` first, then merge, branch, deliver and start, keeping board order within each kind. `POST /api/conformity` takes each repo's roadmap availability and problems and returns the repos that do not conform.

### Requirements

`requirements.json` is `{ "version", "blocks", "requirements": [{ "id", "title", "category", "level", "check", "remedy" }] }`. `blocks` holds the version each Orquestación block must have (`<!-- orquestacion:NAME vX.Y -->` ... `<!-- /orquestacion:NAME -->`). The checks are pure functions in `checks.js`; the server reads the files from `origin/<base>` (`AGENTS.md`, the roadmap, `docs/ORQUESTACION.md`) and `checks.js` decides.

- Categories: `verificable` (the panel decides and can show it as passing), `parcial` (shows evidence, a person confirms) and `criterio` (never passing, only a reminder). Only `verificable` requirements can pass; a repo is `ready` only when every `required` one passes. `recommended` ones never affect `ready`.
- Result status: `pass`, `fail`, `outdated` (the block has another version, or is the old unversioned section), `unavailable` (could not be read: no repo, no base branch, missing file, or an unknown check type). Unavailable is never shown as passing or as failing.
- The old unversioned `## Orquestación` section (or the `orquestacion:bloque` marker) counts as an outdated `registro` block that asks to be updated, not as a missing one.
- The agent's instructions live in the panel folder, not in another project: `requirements/INSTALL.md` (the procedure: apply only the ids named in the order, never delete rules, stop and ask the user on a conflict with the repo's `AGENTS.md`, work on a task branch, never commit, push or open PRs) and `requirements/blocks/registro.md`, `requirements/blocks/ciclo.md` and `requirements/blocks/estado.md` (the exact text of the versioned blocks). Each `remedy` points at them. The panel never edits another repo: the agent does, and the user delivers it with `/flow-commit` and `/flow-pr`.
- Two more requirements, both `recommended` (they never change `ready`), belong to the agent state (see Agent state): `estado-block` (AGENTS.md on the base branch has a closed `<!-- panel:estado v1.0 -->` ... `<!-- /panel:estado -->` block; the check declares its marker namespace, `"namespace": "panel"`, and the Orquestación blocks keep the default) and `panel-ignored` (Git ignores `.panel/state.json` in the repo's **working tree**: it runs `git check-ignore -q .panel/state.json` there, so it is a local fact, not read from the base branch; exit 0 is `pass`, 1 is `fail`, anything else, such as a missing folder, is `unavailable`). `panel-ignored` does not apply to rooms. Its remedy appends `.panel/` to `.git/info/exclude` (never `.gitignore`, never committed), so there is nothing to deliver with `/flow-commit`.
- A file that cannot be read from the base branch for any reason other than "not on that ref" is reported as `unavailable` (reason `error`), is not cached, and is never counted as failing or passing.
- `GET /api/requirements?id=<repoId>` returns `{ available, base, results, summary }`; `GET /api/prerequisites` returns `{ items: [{ id, ok, detail }] }` for `git`, `gh` and `orca` (a missing tool is `ok: false`, not an error).
- The drawer says "All repositories conform." only when the roadmap report is empty **and** the requirements of every repo and the prerequisites were loaded and every repo is `ready`. While they load it says it is computing; if they fail to load it says so.

### Agent state

Work is often unfinished while the repo already shows changes (the agent is waiting for a decision), and after switching sessions it is easy to forget what to do next. So each agent session declares its state in a small file that the panel reads, and ends its replies with one clear line.

- **File**: `.panel/state.json` in the repo's working tree, ignored with `.git/info/exclude` (see `panel-ignored`), never committed. `{ "state", "next", "detail", "at" }`: `state` is `working` (still in progress), `needs-input` (waits for a decision of yours), `ready-to-commit` (done and verified), `ready-to-pr` (committed, ready for a pull request) or `blocked` (cannot continue; `detail` says why); `next` is one line saying what you should do now; `detail` is optional longer text; `at` is an ISO 8601 date-time.
- **The `estado` block** (`requirements/blocks/estado.md`, in Spanish like the other blocks, installed into the repo's `AGENTS.md` by "Put in conditions") tells the agent to rewrite the file after every action that writes files or needs a decision, and to end its reply with one line `Siguiente: <next>`.
- **Reader**: `GET /api/state?id=<repoId>` (token required, 404 for an unknown id) returns `{ available, state, next, detail, at, stale, reason }`. `available: false` has a `reason`: `missing` (no file), `invalid` (unparsable JSON, not an object, unknown `state`, `next` not a string or over 300 characters, `detail` over 4000, `at` not an ISO date-time or more than 5 minutes in the future), `unsafe` (`.panel` or the file is a symlink or link, not a regular file, or over 64 KB; checked with `lstat` before reading and never followed) or `error` (any other read failure). It never throws. An empty or whitespace-only `next` is `invalid`, and `next` is trimmed. `GET /api/local` only gains the additive fields listed under Delivering.
- **Stale**: `stale` is true when `at` is older (whole seconds) than the repo's last activity: the newest of the local `HEAD` commit date and the modification time of each changed or untracked file (the state file itself excluded, at most 200 files). A stale state is returned but flagged. If Git cannot say, it is not flagged.
- **Card**: with a valid, fresh state the card shows its `next` line (one line, full text, `detail` and `at` in the tooltip) with a dot: working yellow, needs-input blue, ready-to-commit and ready-to-pr green, blocked red. A stale state shows only a small gray "outdated" marker, never the old text. The `/flow-commit` button of a card with changes is hidden unless there is no usable state or the usable state is `ready-to-commit`, or you chose **Show /flow-commit anyway** (below); the server-side checks of the button (one idle session, lock) are unchanged. The line is only shown on cards with changes or unpushed commits.
- **Expiry of `working`**: a declared `working` older than 30 minutes (by its own `at`) counts as expired: the card shows only the gray "outdated" marker and the commit button is usable again, because an agent that crashed would otherwise hide it forever. `needs-input`, `blocked` and `ready-to-pr` never expire by time.
- **Show /flow-commit anyway**: when a declared state hides the commit button, the card's **⋯** menu offers this item. It brings the button back for that repo until the page is reloaded (kept in the page, never persisted). A merged branch with changes never shows it: that card offers `/flow-base --stash` instead of `/flow-commit`. The red stale mark names the real button in its tooltip (`/flow-base`, or `/flow-base --stash` with the uncommitted changes it carries).
- **A missing, invalid, unsafe, failed or stale state never blocks anything**: the panel behaves as before. The state can only hide the commit button.
- **Not verified**: the panel cannot tell whether an agent follows the block and writes the file (a model may skip it or write a wrong time, which makes its state look stale); and the line and dots were only checked with unit tests of the helpers, not in a browser.

### Delivering: /flow-pr, manual action and the verdict

The Committed column means "clean tree with commits not delivered yet". That alone is not enough to hand the branch to `/flow-pr`, so the card checks more and says when a person has to step in.

- **`GET /api/local`** gains three additive fields and changes nothing else: `head` (full SHA of `HEAD`, `null` for an unborn branch or on any Git error), `inProgress` (`null`, or `merge`, `rebase`, `cherry-pick` or `revert`, detected from the git dir with `git rev-parse --git-path`, so worktrees and submodules work; it never throws) and `base` (the base branch: the configured one, else `origin/HEAD`, else `main`). `API_VERSION` is now 8.
- **/flow-pr button.** A Committed card shows `/flow-pr` only when ALL hold: no changed or untracked file, commits ahead (also on a branch with no upstream), the branch is not the base and not detached, nothing needs manual action, the repo is not flagged stale (`Merged: run /flow-base`) and no `/flow-commit` verdict is running or needs attention. When an open PR from the current branch already exists, the label is **`/flow-pr (update PR)`**, because `/flow-pr` creates the PR or updates the open one. Otherwise there is no button. Committed cards no longer carry `/flow-commit`: with a clean tree there is nothing to commit; the button stays on Changes cards.
- **Needs manual action.** Commits are made only through `/flow-commit`, and PRs through `/flow-pr`. A card shows a red bar "Needs manual action: …", hides both buttons, goes to the top of its column and counts in the ⚠ problems filter (like a stale card) when: there are commits ahead while the current branch IS the base ("Commits on main: move them to a task branch"); HEAD is detached; a merge, rebase, cherry-pick or revert is in progress; or the branch diverged from its upstream (commits both ahead and behind). It does not fire for a clean branch that is only behind, a base branch with nothing ahead, or a task branch with commits ahead. A repo whose local state cannot be read keeps its existing error card.
- **Verdict after /flow-commit.** When a `/flow-commit` is sent from the page, the page remembers `{ at, head, files }` for that repo (in the page only: no history, nothing persisted, lost on reload) and polls the new read-only `GET /api/pi-status?id=<repoId>` on the normal refresh cycle, only for such repos. It answers `{ state }`: `closed`, `idle`, `busy`, `ambiguous` or `unknown`, from `orca terminal list` and a fresh `show` exactly as the room presence (never `send`; an Orca failure is `unknown`, never `closed`; token required; 404 for an unknown repo).
  - **running** ("committing…"): the session is busy; or the session state is unknown or ambiguous and less than 15 minutes passed; or less than 30 seconds passed since sending (an idle prompt right after sending may not have started yet).
  - **ok**: the tree is clean (untracked files included), `HEAD` differs from the one recorded and there are commits ahead. The record is cleared and the card lives in Committed with its `/flow-pr` button. The session being busy still wins, so the verdict waits for it.
  - **attention** (red bar with the reason and a ✕ to dismiss; `/flow-pr` is NOT offered while it shows): the session is idle or closed but N files are still uncommitted, or `HEAD` did not change, or the session closed before a commit, or `HEAD` changed but nothing is left to deliver; or 15 minutes passed with an unknown session and nothing changed.
  - It is judged from Git and the session state, never from terminal text, and the panel does not judge the quality of the commits.

### When each flow button appears

One rule set (`flowButtons` in `public/view.js`) decides the buttons of a repo's local card; the page and the tests share it. The column comes from Git state alone.

| State of the repo | Column | Button |
| --- | --- | --- |
| Changed or untracked files | Changes | `/flow-commit` (hidden while a declared state says the work is not ready, see "Show /flow-commit anyway") |
| Clean, commits ahead, no open PR for the branch | Committed | `/flow-pr` |
| Clean, commits ahead, an open PR from this branch | Committed | `/flow-pr (update PR)` |
| Branch already merged (or its remote branch deleted), clean tree | Clean (red mark) | `/flow-base`: starts from a fresh, updated base branch |
| Branch already merged, but files changed | Changes (red mark) | `/flow-base --stash` and no `/flow-commit`: the skill carries the uncommitted changes aside (stash, including untracked files), switches to the fresh base branch, updates it and restores them. It refuses and changes nothing when the work of the branch is not yet merged or its remote branch not yet deleted |
| Needs manual action (detached HEAD, commits on the base branch, merge or rebase in progress, diverged) | Wherever Git puts it | none |
| A `/flow-commit` is running | Changes or Committed | no `/flow-pr` and no `/flow-base` until it settles |
| Open PR, checks failed | Open PRs (red) | `Fix with pi` (any fix, in test or production code or configuration, as long as it serves the PR's own objective; for a transient failure it does not touch code and recommends `Re-run failed`; if the fix would change the PR's scope or needs a product decision it stops and asks), plus `Re-run failed` when a GitHub Actions run failed |
| Open PR, all checks passed and mergeable | Ready to merge | `Merge` |

**How a card returns after a fix.** `Fix with pi` types one order into the open pi session (see below). The agent edits files and commits nothing, so the repo is dirty and its card moves to **Changes** with `/flow-commit`. After `/flow-commit` the repo is ahead and the card moves to **Committed**, where an open PR from the branch already exists, so the button reads `/flow-pr (update PR)`. `/flow-pr` pushes the fix to the same PR and its card goes back to **Open PRs** while the checks run. Nothing in the panel tracks this: each step is just the new Git state.

### Rooms

A room is a repo (a folder with its own `origin`) where you coordinate a group of repos (for example one room for your H2O projects and another for your tools). Repos do not declare which room they belong to, so the panel does, in `config.json`. You do not have to edit it: use the screen.

- **+ Room** (next to **+ Repo**) opens a dialog: a room name and its folder (the field suggests the folders of the repos already in the panel; a browser cannot open a native folder picker, so type or paste the path). Errors show inside the dialog.
- The card's **⋯** menu has an **Assign to room** group: one item per room (the current one is marked ✓) and **No room**. With no rooms it offers **Create a room…**.
- The Conformity drawer's **Rooms** section has a **Remove room** button per room, with a confirmation.

By hand, the same data is (remember to escape backslashes in JSON, or use forward slashes):

```json
"rooms": [{ "name": "UPEN", "path": "C:\\Users\\you\\Developer\\upen\\upen-ceo", "repos": ["969522dd0c"] }]
```

`repos` holds repo ids (the `id` that `GET /api/config` shows for each repo). Rules: the name is trimmed, non-empty, at most 60 characters and unique (case-insensitive, the first wins); `path` must be absolute; `repos` keeps unique strings; a repo id belongs to at most one room (the first room wins). Reload the page after editing by hand.

- **Routes** (token required, like the rest): `POST /api/rooms/create` `{ name, path }`, `POST /api/rooms/remove` `{ name }` and `POST /api/rooms/assign` `{ id, room }` (`room` is a room name, or `null` to leave every room). They answer `{ rooms }`. `create` answers 400 with the reason when the name is empty, longer than 60 characters or already used, or when the path is not absolute, does not exist, is not a folder or has no `.git`; `remove` and `assign` answer 404 for an unknown room or repo. `assign` takes the repo out of any other room first, and removing a repo from the panel also takes it out of its room.
- **Removing a room never touches files.** It deletes only the entry in `config.json` (its members become unassigned); the room folder and the repos are never created, edited or deleted by the panel.
- **Entries the panel does not understand are kept.** An entry under `rooms` that is not usable (not an object, a bad or duplicate name, a relative path) is ignored at runtime but written back to `config.json` exactly as it was on every save, in its place, so a typo cannot erase a room. `GET /api/config` lists them in `roomIssues` (short strings such as `rooms[2]: path must be absolute`; `[]` when all is fine) and the Conformity drawer shows "N entries in config.json under rooms are invalid and ignored" with the reasons. Fix the entry in the file by hand. A `rooms` value that is not a list is reported the same way, kept as is, and the panel refuses to create a room until you fix it.

- **Room requirements** (`roomRequirements` in `requirements.json`, evaluated against the room repo's remote base branch, all required): `room-base-branch`, `room-agents-file` (`AGENTS.md`), `room-enlaces-file` (the link map `ENLACES.md` at the root or under `estrategia/`, because the template does not fix the path) and `room-enlaces-sections` (a markdown heading for each of Proyectos, Contratos, Dependencias, Cola and barrido, matched case-insensitively inside the heading text; the detail lists which are missing). It only proves the headings exist, not that they are filled in.
- **Member requirements** (a repo listed in a room; in `requirements.json` a requirement can have `"onlyInRoom": true`, omitted for repos outside every room, and `"levelInRoom"`, which replaces its level for members): `sala-region` (required: the `ciclo` block holds both `<!-- SALA -->` and `<!-- /SALA -->`) and `ciclo-block`, recommended elsewhere but required for members. `ready` is unchanged: every required requirement, after that override, must pass. `GET /api/requirements?id=` adds `room: { name }` for a member; for any other repo the answer is the same as before. `requirements/INSTALL.md` tells the agent to keep the SALA region (both marker lines and everything between them) when the repo is a member of a room or when the order names `sala-region`, and to remove it only when neither applies.
- **Active** means: `GET /api/rooms` returns, per room, its requirement results and `presence.state`: `closed` (no pi screen in any terminal of the room folder), `idle`, `busy`, `ambiguous` (two or more pi screens) or `unknown` (Orca could not be asked, or a `show` failed and no pi screen was seen elsewhere; never reported as closed), plus `lastCommit` (ISO date of the room's local `HEAD`, or `null`). Sessions are recognised by their screen (a fresh `orca terminal show` per terminal of the room folder, whatever the terminal title), as for the buttons; a prompt with text typed in it counts as idle. Only `list` and `show` are used, never `send`.
- The Conformity drawer does not say "All repositories conform." while the rooms load, fail to load, or any room has a required requirement that is not passing.
- **Not covered**: that a member repo is listed in `ENLACES.md` (free markdown, it would give false positives) and whether the room is behind (last sweep older than merged PRs). Nothing here edits the room or its members; the agent applies remedies and you deliver them with `/flow-commit` and `/flow-pr`.

`base` is the branch work is merged into. When omitted, the panel reads it from `origin/HEAD` and falls back to `main`. `roadmap` is the repo-relative path of its plan file (default `docs/ROADMAP.md`); unsafe values (absolute, starting with `-`, or containing `..`) are ignored.

## Merge behaviour

- Clicking **Merge** merges immediately, with no confirmation (like GitHub's own button). It is only enabled when the PR is green and mergeable.
- Merging goes through the GitHub API, so your local branches and working tree are never touched.
- The server re-checks readiness right before merging and pins the merge to the PR head SHA, so a late push cancels it.
- *Delete branch* is offered only when the repo does not already delete merged branches (`deleteBranchOnMerge`). If GitHub already removed the branch, that is treated as success, and local branches whose remote disappeared show as "remote branch deleted" instead of an error.
- A repo whose current branch (other than the base) already landed gets a red **Merged: run /flow-base** mark and goes to the top of its column. The panel flags it when the remote branch is gone or a merged PR came from that branch, and not when a new open PR reuses the branch name.
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

- Rooms: the room tag, its dot, the **+ Room** dialog, the **Assign to room** menu group, the **Remove room** confirmation and the drawer's Rooms section were never seen in a browser (only the pure helpers and the routes are tested); neither were the dialog's focus and keyboard behavior. Presence was read against the real Orca only as a read-only listing, never against a live room session, and not with two rooms or many members.
- Only the first 30 local branches are inspected; a matching branch beyond that is not seen.
- The real GitHub path (`En revisión` from `gh pr list`) and its rendering in the browser have no automated test; pure functions cover the logic.
- The requirements and prerequisites blocks of the Conformity drawer have no browser test: their rendering (collapsed passing list, remedy lines, loading and failed messages) and the badge count were not seen on screen. Unit tests cover the checks, the routes and `conformityView`.
- The conformity view was only checked with a headless screenshot of the open drawer. Not verified in a browser: clicking the button and a repo name, closing the drawer, the `All repositories conform.` message, the `no-base` and `no-repo` statuses, and a repo whose only problems are info-level. Unit tests cover the report logic.

## Security

The server binds to `127.0.0.1` only, rejects unknown `Host` headers (DNS rebinding), requires a random per-run token on every API call, and only operates on repositories listed in `config.json`.
