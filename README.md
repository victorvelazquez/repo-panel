# Repo Panel

A local, single-window dashboard for the repos you work on. It answers one question: **what is left for me to do?**

- A kanban board with one card per pending thing, in six columns: **Clean · Changes · Committed · PR in progress · Ready to merge · Needs attention**. A repo with local changes and a ready PR shows up in both columns.
- Per repo: uncommitted files, `+/−` lines, unpushed commits, and a full diff viewer.
- Per open PR: CI status and a **Merge** button that only enables when every check is green and GitHub reports the PR as mergeable. PRs with failed checks, conflicts or an outdated branch go to *Needs attention*.
- Repos organised in groups (personal, work, commercial…), shown as a colored tag on each card, with a group filter and a name search.
- Quick actions: open on GitHub, open in VS Code, `git fetch --prune`, re-run failed checks, refresh.

Committing and opening PRs stay manual — the panel only observes, and merges when you click.

## Requirements

Node 20+, `git`, and the GitHub CLI (`gh`) already authenticated (`gh auth status`). No npm dependencies, nothing to install.

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

## Configuration

On first run there is nothing to configure: click **+ Repo** to add a single folder, or to scan a parent folder for every repo inside it. The panel saves your choices to `config.json`, which is git-ignored so your local paths are never committed.

You can also create `config.json` by hand; copy `config.example.json` as a starting point:

| Key | Meaning | Default |
| --- | --- | --- |
| `port` | Port to listen on | `4310` |
| `editor` | Command used by the *Editor* button | `code` |
| `groups` | Named groups of repos (`{ "name", "repos": [{ "path" }] }`) | `[]` |

## Merge behaviour

- Clicking **Merge** merges immediately, with no confirmation (like GitHub's own button). It is only enabled when the PR is green and mergeable.
- Merging goes through the GitHub API, so your local branches and working tree are never touched.
- The server re-checks readiness right before merging and pins the merge to the PR head SHA, so a late push cancels it.
- *Delete branch* is offered only when the repo does not already delete merged branches (`deleteBranchOnMerge`). If GitHub already removed the branch, that is treated as success, and local branches whose remote disappeared show as "remote branch deleted" instead of an error.
- Branch protection and required reviews on GitHub still apply.

## Security

The server binds to `127.0.0.1` only, rejects unknown `Host` headers (DNS rebinding), requires a random per-run token on every API call, and only operates on repositories listed in `config.json`.
