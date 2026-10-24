'use strict';
// Roadmap of a repo, read from its remote base branch, plus the live facts that derive unit states.
const fs = require('node:fs');
const lib = require('../lib.js');
const { git, gh } = require('./exec.js');
const { baseBranchOf } = require('./local.js');

// Read from the remote base branch, not the working tree: a unit is done only once its PR is merged.
const fileCache = new Map();
const roadmapCache = new Map();

const withSummary = (data) => ({ ...data, summary: lib.roadmapSummary(data) });

// One file of a repo as it is on origin/<base>. The text is cached by the sha of the base commit, so an
// unchanged base costs one rev-parse. reason: no-repo | no-base | missing (the file is not on the ref) |
// error (any other failure: not cached, and never to be read as a verified failure or pass).
async function remoteFile(repo, file) {
  if (!fs.existsSync(repo.path)) return { available: false, reason: 'no-repo' };
  const top = await git(repo.path, ['rev-parse', '--git-dir']);
  if (top.code !== 0) return { available: false, reason: 'no-repo' };
  const base = await baseBranchOf(repo);
  const ref = `origin/${base}`;
  const rev = await git(repo.path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  if (rev.code !== 0) return { available: false, reason: 'no-base', base };
  const sha = rev.stdout.trim();
  const key = `${repo.id}|${file}`;
  const hit = fileCache.get(key);
  let text = hit && hit.sha === sha ? hit.text : undefined;
  if (text === undefined) {
    const show = await git(repo.path, ['show', `${ref}:${file}`]);
    if (show.code === 0) text = show.stdout;
    else {
      // Only an empty listing proves the path is not on the ref; anything else may be a transient failure.
      const listed = await git(repo.path, ['ls-tree', '--name-only', ref, '--', file]);
      if (listed.code !== 0 || listed.stdout.trim() !== '') return { available: false, reason: 'error', base, sha };
      text = null;
    }
    fileCache.set(key, { sha, text });
  }
  return text === null ? { available: false, reason: 'missing', base, sha } : { available: true, reason: null, base, sha, text };
}

async function roadmapState(repo) {
  const file = repo.roadmap || 'docs/ROADMAP.md';
  const rf = await remoteFile(repo, file);
  if (rf.reason === 'no-repo') return { available: false, reason: 'no-repo' };
  if (rf.reason === 'no-base') return { available: false, reason: 'no-base', base: rf.base, path: file };
  if (rf.reason === 'error') return { available: false, reason: 'error', base: rf.base, path: file };
  const { base, sha } = rf;
  const key = `${repo.id}|${file}`;
  const hit = roadmapCache.get(key);
  let data = hit && hit.sha === sha ? hit.data : null;
  if (!data) {
    data = rf.available
      ? withSummary({ available: true, base, sha, path: file, ...lib.parseRoadmap(rf.text) })
      : { available: false, reason: 'missing', base, path: file };
    roadmapCache.set(key, { sha, data });
  }
  if (!data.available) return data;
  // The file is cached by sha, but the derived states depend on live Git and GitHub state.
  const derived = lib.deriveUnitStates(data.rows, await derivedFacts(repo, base).catch(() => ({})));
  return { ...data, derived, next: lib.nextUnit(data.rows, derived), summary: lib.roadmapSummary({ ...data, derived }) };
}

// Live facts that link units to work: branches (bounded) and open PRs. Any failure means "no info".
const MAX_BRANCHES = 30;
const prsCache = new Map();
const PRS_TTL = 15 * 1000;

async function openPrsFor(repo) {
  const hit = prsCache.get(repo.id);
  if (hit && Date.now() - hit.t < PRS_TTL) return hit.prs;
  const r = await gh(repo.path, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName'], { timeout: 20000 });
  let prs = [];
  try { if (r.code === 0) prs = JSON.parse(r.stdout).map((p) => ({ number: p.number, title: p.title, head: p.headRefName })); } catch { /* no PRs */ }
  prsCache.set(repo.id, { t: Date.now(), prs });
  return prs;
}

async function derivedFacts(repo, base) {
  const ref = `origin/${base}`;
  const lines = (r) => (r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []);
  const [cur, st, ahead, merged, tracks, prs] = await Promise.all([
    git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(repo.path, ['status', '--porcelain']),
    git(repo.path, ['rev-list', '--count', `${ref}..HEAD`]),
    git(repo.path, ['for-each-ref', `--no-merged=${ref}`, '--format=%(refname:short)', 'refs/heads']),
    git(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']),
    openPrsFor(repo).catch(() => []),
  ]);
  const current = cur.code === 0 && cur.stdout.trim() ? cur.stdout.trim() : null;
  const gone = new Set(tracks.code === 0 ? lib.parseGoneBranches(tracks.stdout) : []);
  const usable = (names) => names.filter((n) => n !== base && !gone.has(n));
  return {
    current,
    dirty: st.code === 0 && st.stdout.trim() !== '',
    aheadCurrent: ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0,
    branches: usable(lines(merged)).filter((n) => n !== current).slice(0, MAX_BRANCHES),
    localBranches: usable(tracks.code === 0 ? tracks.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean) : []).slice(0, MAX_BRANCHES),
    prs,
  };
}

module.exports = { roadmapState, remoteFile };
