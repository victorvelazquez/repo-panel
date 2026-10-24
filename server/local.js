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

async function localState(repo) {
  if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
  const st = await git(repo.path, ['status', '--porcelain=v2', '-b', '-uall']);
  if (st.code !== 0) return { error: firstLine(st.stderr) || 'git status failed' };
  const s = lib.parseStatus(st.stdout);

  let ns = await git(repo.path, ['diff', 'HEAD', '--numstat', '--no-renames']);
  if (ns.code !== 0) ns = await git(repo.path, ['diff', '--numstat', '--no-renames']);
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
    const rl = await git(repo.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    ahead = rl.code === 0 ? Number(rl.stdout.trim()) || 0 : 0;
  }
  const fr = await git(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']);
  const gone = fr.code === 0 ? lib.parseGoneBranches(fr.stdout) : [];

  return {
    branch: s.branch, detached: s.detached, upstream: s.upstream, noUpstream,
    ahead, behind: s.behind, files,
    added: files.reduce((a, f) => a + f.added, 0),
    deleted: files.reduce((a, f) => a + f.deleted, 0),
    goneBranches: gone, currentGone: !!s.branch && gone.includes(s.branch),
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
async function baseBranchOf(repo) {
  if (repo.base) return repo.base;
  const sym = await git(repo.path, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  return lib.parseBaseBranch(sym.code === 0 ? sym.stdout : '');
}

module.exports = { localState, diffText, baseBranchOf };
