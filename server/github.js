'use strict';
// GitHub state through gh: open PRs, merge, re-run failed checks.
const fs = require('node:fs');
const lib = require('../lib.js');
const { HttpError } = require('./errors.js');
const { git, gh, firstLine } = require('./exec.js');
const { baseBranchOf } = require('./local.js');

const PR_FIELDS = [
  'number', 'title', 'url', 'headRefName', 'baseRefName', 'headRefOid', 'isDraft', 'isCrossRepository',
  'mergeable', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup', 'author',
].join(',');

function ghError(r) {
  try { const j = JSON.parse(r.stdout); if (j.message) return j.message; } catch { /* not json */ }
  return firstLine(r.stderr) || firstLine(r.stdout) || `exit code ${r.code}`;
}

const metaCache = new Map();
const NO_REMOTE = /no git remotes|none of the git remotes|not a git repository|could not determine|unable to determine/i;

async function repoMeta(repo) {
  const hit = metaCache.get(repo.id);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.data;
  const r = await gh(repo.path, ['repo', 'view', '--json', 'nameWithOwner,url,deleteBranchOnMerge']);
  if (r.code !== 0) {
    const msg = firstLine(r.stderr);
    if (NO_REMOTE.test(r.stderr)) return { noRemote: true };
    throw new Error(msg || 'gh repo view failed');
  }
  const j = JSON.parse(r.stdout);
  const data = { slug: j.nameWithOwner, url: j.url, deleteBranchOnMerge: !!j.deleteBranchOnMerge };
  metaCache.set(repo.id, { t: Date.now(), data });
  return data;
}

// Merged PRs per repo+branch, cached briefly so a refresh does not hit the API every time.
const mergedCache = new Map();
const MERGED_TTL = 60 * 1000;

async function mergedPrFor(repo, branch) {
  const key = `${repo.id}:${branch}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.t < MERGED_TTL) return hit.pr;
  const r = await gh(repo.path, ['pr', 'list', '--state', 'merged', '--head', branch, '--limit', '5', '--json', 'number,url,isCrossRepository']);
  if (r.code !== 0) return null; // an unknown answer must not raise a false alarm, and is not cached
  let pr = null;
  try { pr = JSON.parse(r.stdout).find((p) => !p.isCrossRepository) || null; } catch { /* keep null */ }
  mergedCache.set(key, { t: Date.now(), pr });
  return pr;
}

// The current branch when its work already landed, so the next unit must start from a fresh branch.
async function staleState(repo, openPrs) {
  const b = await git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = b.code === 0 ? b.stdout.trim() : '';
  if (!branch) return null;
  const base = await baseBranchOf(repo);
  if (branch === base) return null;
  const fr = await git(repo.path, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads']);
  const gone = fr.code === 0 && lib.parseGoneBranches(fr.stdout).includes(branch);
  const mergedPr = gone ? null : await mergedPrFor(repo, branch);
  return lib.staleBranch({ branch, base, gone, mergedPr, openPrs });
}

async function prState(repo) {
  if (!fs.existsSync(repo.path)) return { error: 'Folder not found' };
  let meta;
  try { meta = await repoMeta(repo); } catch (e) { return { error: e.message }; }
  if (meta.noRemote) return { noRemote: true, prs: [] };
  const r = await gh(repo.path, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS]);
  if (r.code !== 0) return { repo: meta, error: firstLine(r.stderr) || 'gh pr list failed' };
  const prs = JSON.parse(r.stdout).map(lib.enrichPr);
  return { repo: meta, prs, stale: await staleState(repo, prs) };
}

async function viewPr(repo, number) {
  const r = await gh(repo.path, ['pr', 'view', String(number), '--json', `${PR_FIELDS},state`]);
  if (r.code !== 0) throw new HttpError(502, firstLine(r.stderr) || 'gh pr view failed');
  const j = JSON.parse(r.stdout);
  return { ...lib.enrichPr(j), state: j.state };
}

async function mergePr(repo, number, method, deleteBranch) {
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new HttpError(400, 'Invalid merge method');
  if (!Number.isInteger(number)) throw new HttpError(400, 'Invalid PR number');
  const meta = await repoMeta(repo);
  if (meta.noRemote) throw new HttpError(400, 'Repository has no GitHub remote');
  const pr = await viewPr(repo, number);
  if (pr.state !== 'OPEN') throw new HttpError(409, `PR is ${pr.state}`);
  if (!pr.ready) throw new HttpError(409, `Not ready to merge: ${pr.blockedReason}`);

  // Merge through the API so the local working tree and branches are never touched.
  const m = await gh(repo.path, [
    'api', '-X', 'PUT', `repos/${meta.slug}/pulls/${number}/merge`,
    '-f', `merge_method=${method}`, '-f', `sha=${pr.headOid}`,
  ]);
  if (m.code !== 0) {
    const after = await viewPr(repo, number).catch(() => null);
    if (!after || after.state !== 'MERGED') throw new HttpError(502, ghError(m));
  }

  // Branch cleanup: skip when the repo already deletes branches, or the head lives in a fork.
  let branch = 'kept';
  if (meta.deleteBranchOnMerge) branch = 'auto';
  else if (deleteBranch && !pr.isCrossRepository) {
    const d = await gh(repo.path, ['api', '-X', 'DELETE', `repos/${meta.slug}/git/refs/heads/${lib.encodeRef(pr.head)}`]);
    branch = d.code === 0 || /reference does not exist/i.test(d.stdout + d.stderr) ? 'deleted' : 'kept';
  }
  return { merged: true, branch };
}

async function rerunFailed(repo, number) {
  const pr = await viewPr(repo, number);
  const ids = pr.checks.failedRuns;
  if (!ids.length) throw new HttpError(409, 'No failed GitHub Actions runs to re-run');
  let ok = 0;
  const errors = [];
  for (const id of ids) {
    const r = await gh(repo.path, ['run', 'rerun', id, '--failed']);
    if (r.code === 0) ok++; else errors.push(firstLine(r.stderr));
  }
  if (!ok) throw new HttpError(502, errors[0] || 'Re-run failed');
  return { rerun: ok };
}

module.exports = { prState, mergePr, rerunFailed, forgetMeta: (id) => metaCache.delete(id) };
