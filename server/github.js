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
  'additions', 'deletions', 'changedFiles', // RP94d: the size of the PR (additive; the Summary card flags a large one)
].join(',');

// RP278: GitHub did not really answer when gh was killed (its timeout), printed the Go JSON error or a 5xx of GitHub; a merge then
// answers one fixed message instead of a raw SyntaxError or 500. Each gh call of the merge carries its own short bound.
const NO_ANSWER = 'GitHub did not answer in time: check the PR on GitHub before retrying';
const NOT_CONFIRMED = 'GitHub did not confirm the merge: check the PR on GitHub before retrying';
const NO_ANSWER_RE = /unexpected end of JSON input|server error|HTTP 5\d\d|timeout|deadline exceeded/i;
const noAnswer = (r) => r.code < 0 || NO_ANSWER_RE.test(`${r.stderr}\n${r.stdout}`);
const READ = { timeout: 20000, waitMs: 20000 };
const PUT = { timeout: 30000, waitMs: 20000 };
const mergeTiming = { tries: 3, gapMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// The JSON of a gh answer; output that is not JSON is marked as no answer, keeping its message.
function parseJson(r) {
  try { return JSON.parse(r.stdout); } catch (e) { e.noAnswer = true; throw e; }
}

function ghError(r) {
  try { const j = JSON.parse(r.stdout); if (j.message) return j.message; } catch { /* not json */ }
  return firstLine(r.stderr) || firstLine(r.stdout) || `exit code ${r.code}`;
}

const metaCache = new Map();
const NO_REMOTE = /no git remotes|none of the git remotes|not a git repository|could not determine|unable to determine/i;

async function repoMeta(repo, opts) {
  const hit = metaCache.get(repo.id);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.data;
  const r = await gh(repo.path, ['repo', 'view', '--json', 'nameWithOwner,url,deleteBranchOnMerge,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'], opts);
  if (r.code !== 0) {
    const msg = firstLine(r.stderr);
    if (NO_REMOTE.test(r.stderr)) return { noRemote: true };
    throw Object.assign(new Error(msg || 'gh repo view failed'), { noAnswer: noAnswer(r) });
  }
  const j = parseJson(r);
  // RP226: the methods the repo allows; null when gh said none of them, which means "use the requested one". A flag gh did not answer counts as allowed, one that says false is honored.
  const flags = [j.mergeCommitAllowed, j.squashMergeAllowed, j.rebaseMergeAllowed];
  const methods = flags.some((f) => typeof f === 'boolean') ? { merge: flags[0], squash: flags[1], rebase: flags[2] } : null;
  const data = { slug: j.nameWithOwner, url: j.url, deleteBranchOnMerge: !!j.deleteBranchOnMerge, methods };
  metaCache.set(repo.id, { t: Date.now(), data });
  return data;
}

// Merged PRs per repo+branch, cached briefly so a refresh does not hit the API every time. A merged PR does not un-merge,
// so a found one is kept for a minute; "no merged PR" is kept only briefly, so a merge shows up within seconds.
const mergedCache = new Map();
const MERGED_TTL_FOUND = 60 * 1000;
const MERGED_TTL_NONE = 15 * 1000;

async function mergedPrFor(repo, branch) {
  const key = `${repo.id}:${branch}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.t < (hit.pr ? MERGED_TTL_FOUND : MERGED_TTL_NONE)) return hit.pr;
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
  // An open PR from this branch makes it live work whatever merged before (see lib.staleBranch): skip the lookup.
  const mergedPr = gone || openPrs.some((p) => p.head === branch) ? null : await mergedPrFor(repo, branch);
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

async function viewPr(repo, number, opts) {
  const r = await gh(repo.path, ['pr', 'view', String(number), '--json', `${PR_FIELDS},state`], opts);
  if (r.code !== 0) throw new HttpError(502, noAnswer(r) ? NO_ANSWER : firstLine(r.stderr) || 'gh pr view failed');
  let j;
  try { j = parseJson(r); } catch { throw new HttpError(502, NO_ANSWER); }
  return { ...lib.enrichPr(j), state: j.state };
}

// The state of the PR after a failed PUT, read up to `tries` times a few seconds apart; null when no read worked.
async function rereadState(repo, number, tries) {
  let state = null;
  for (let i = 0; i < tries; i++) {
    if (i) await mergeTiming.sleep(mergeTiming.gapMs);
    const after = await viewPr(repo, number, READ).catch(() => null);
    if (after) state = after.state;
    if (state === 'MERGED') break;
  }
  return state;
}

async function mergePr(repo, number, method, deleteBranch) {
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new HttpError(400, 'Invalid merge method');
  if (!Number.isInteger(number)) throw new HttpError(400, 'Invalid PR number');
  const meta = await repoMeta(repo, READ).catch((e) => { throw e.status ? e : new HttpError(502, e.noAnswer ? NO_ANSWER : e.message); });
  if (meta.noRemote) throw new HttpError(400, 'Repository has no GitHub remote');
  const pick = lib.pickMergeMethod(method, meta.methods);
  if (!pick) throw new HttpError(409, 'This repository allows no merge method');
  const pr = await viewPr(repo, number, READ);
  if (pr.state !== 'OPEN') throw new HttpError(409, `PR is ${pr.state}`);
  if (!pr.ready) throw new HttpError(409, `Not ready to merge: ${pr.blockedReason}`);

  // Merge through the API so the local working tree and branches are never touched.
  const m = await gh(repo.path, [
    'api', '-X', 'PUT', `repos/${meta.slug}/pulls/${number}/merge`,
    '-f', `merge_method=${pick.method}`, '-f', `sha=${pr.headOid}`,
  ], PUT);
  if (m.code !== 0) {
    // A clear refusal is read once, as before; an unclear failure is read a few times before saying it is not confirmed.
    const clear = !noAnswer(m);
    const state = await rereadState(repo, number, clear ? 1 : mergeTiming.tries);
    if (state !== 'MERGED') throw new HttpError(502, clear ? ghError(m) : state ? NO_ANSWER : NOT_CONFIRMED);
  }
  // The branch has a merged PR now: forget a cached "none" so the next /api/prs reports it at once.
  mergedCache.delete(`${repo.id}:${pr.head}`);

  // Branch cleanup: skip when the repo already deletes branches, or the head lives in a fork.
  let branch = 'kept';
  if (meta.deleteBranchOnMerge) branch = 'auto';
  else if (deleteBranch && !pr.isCrossRepository) {
    const d = await gh(repo.path, ['api', '-X', 'DELETE', `repos/${meta.slug}/git/refs/heads/${lib.encodeRef(pr.head)}`], READ).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    branch = d.code === 0 || /reference does not exist/i.test(d.stdout + d.stderr) ? 'deleted' : 'kept';
  }
  return pick.fellBack ? { merged: true, branch, method: pick.method, requested: pick.requested } : { merged: true, branch };
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

module.exports = { MERGED_TTL_FOUND, MERGED_TTL_NONE, mergeTiming, mergedPrFor, prState, mergePr, rerunFailed, forgetMeta: (id) => metaCache.delete(id) };
