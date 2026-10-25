'use strict';
// Local Git state of a repo: status, line counts, diff and the base branch.
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib.js');
const { git, firstLine } = require('./exec.js');

function countLines(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return { lines: 0, binary: false };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { lines: 0, binary: true };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return { lines: n, binary: false };
  } catch { return { lines: 0, binary: false }; }
}

// Full SHA of HEAD, or null for an unborn branch or any failure.
async function headOf(repo, run) {
  const r = await run(repo.path, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => null);
  const sha = r && r.code === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

// The git-dir markers of an operation in progress, in priority order (a rebase can leave other markers too).
const OPERATIONS = [['rebase', 'rebase-merge'], ['rebase', 'rebase-apply'], ['merge', 'MERGE_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD']];

// merge | rebase | cherry-pick | revert, or null. `--git-path` resolves the real git dir, so worktrees and submodules work.
async function inProgressOf(repo, run) {
  const r = await run(repo.path, ['rev-parse', ...OPERATIONS.flatMap(([, name]) => ['--git-path', name])]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const paths = r.stdout.split(/\r?\n/).filter(Boolean);
  if (paths.length !== OPERATIONS.length) return null;
  for (let i = 0; i < OPERATIONS.length; i++) {
    try { if (fs.existsSync(path.resolve(repo.path, paths[i]))) return OPERATIONS[i][0]; } catch { /* unreadable: not in progress */ }
  }
  return null;
}

const STAGED_CAP = 20;

// The runner is injectable so tests can force failures; the facts above never throw.
async function localState(repo, { git: run = git } = {}) {
  if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
  const st = await run(repo.path, ['status', '--porcelain=v2', '-b', '-uall']);
  if (st.code !== 0) return { error: firstLine(st.stderr) || 'git status failed' };
  const s = lib.parseStatus(st.stdout);

  let ns = await run(repo.path, ['diff', 'HEAD', '--numstat', '--no-renames']);
  if (ns.code !== 0) ns = await run(repo.path, ['diff', '--numstat', '--no-renames']);
  const stats = lib.parseNumstat(ns.code === 0 ? ns.stdout : '');

  const files = s.files.map((f) => {
    const letter = lib.statusLetter(f.xy);
    let added = 0; let deleted = 0; let binary = false;
    if (f.xy === '??') {
      const c = countLines(path.join(repo.path, f.path));
      added = c.lines; binary = c.binary;
    } else if (stats.has(f.path)) {
      ({ added, deleted, binary } = stats.get(f.path));
    }
    return { path: f.path, status: letter, untracked: f.xy === '??', conflict: !!f.conflict, added, deleted, binary };
  });

  let ahead = s.ahead;
  let noUpstream = !s.upstream;
  if (noUpstream && !s.detached) {
    const rl = await run(repo.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    ahead = rl.code === 0 ? Number(rl.stdout.trim()) || 0 : 0;
  }
  const fr = await run(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']);
  const gone = fr.code === 0 ? lib.parseGoneBranches(fr.stdout) : [];

  const [head, inProgress, base] = await Promise.all([headOf(repo, run), inProgressOf(repo, run), baseBranchOf(repo, run).catch(() => null)]);

  // Paths with a change in the index (renames included), from the same status parse; untracked files are never staged.
  const staged = s.files.filter((f) => f.xy !== '??' && f.xy[0] !== '.').map((f) => f.path).sort();

  return {
    branch: s.branch, detached: s.detached, upstream: s.upstream, noUpstream,
    ahead, behind: s.behind, files,
    added: files.reduce((a, f) => a + f.added, 0),
    deleted: files.reduce((a, f) => a + f.deleted, 0),
    goneBranches: gone, currentGone: !!s.branch && gone.includes(s.branch),
    head, inProgress, base,
    stagedCount: staged.length, stagedPaths: staged.slice(0, STAGED_CAP),
  };
}

const DIFF_CAP = 3 * 1024 * 1024;
async function diffText(repo) {
  let d = await git(repo.path, ['diff', 'HEAD', '--no-color', '--no-renames']);
  if (d.code !== 0) d = await git(repo.path, ['diff', '--no-color', '--no-renames']);
  let text = d.code === 0 ? d.stdout : '';
  const st = await git(repo.path, ['status', '--porcelain=v2', '-uall']);
  const untracked = st.code === 0 ? lib.parseStatus(st.stdout).files.filter((f) => f.xy === '??').slice(0, 50) : [];
  for (const f of untracked) {
    if (text.length > DIFF_CAP) break;
    const full = path.join(repo.path, f.path);
    const c = countLines(full);
    if (c.binary || !fs.existsSync(full) || fs.statSync(full).size > 512 * 1024) {
      text += `\ndiff --git a/${f.path} b/${f.path}\nnew file\nBinary or large file not shown\n`;
      continue;
    }
    const r = await git(repo.path, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path]);
    text += `\n${r.stdout}`;
  }
  const truncated = text.length > DIFF_CAP;
  return { diff: truncated ? text.slice(0, DIFF_CAP) : text, truncated };
}

// The branch work is merged into: the configured one, else origin/HEAD, else "main".
async function baseBranchOf(repo, run = git) {
  if (repo.base) return repo.base;
  const sym = await run(repo.path, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  return lib.parseBaseBranch(sym.code === 0 ? sym.stdout : '');
}

module.exports = { localState, diffText, baseBranchOf };
