'use strict';
// RP226: the repo decides the merge method. The panel asks GitHub which methods the repo allows and never sends a prohibited one:
// it falls back (squash, rebase, merge) or answers 409 without any PUT. gh is injected, never real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib.js');

const EXEC_PATH = require.resolve('../server/exec.js');
const GITHUB_PATH = require.resolve('../server/github.js');

function loadGithub(ghImpl) {
  const exec = require(EXEC_PATH);
  const realGh = exec.gh;
  exec.gh = ghImpl;
  delete require.cache[GITHUB_PATH];
  const github = require(GITHUB_PATH);
  return { github, restore: () => { exec.gh = realGh; delete require.cache[GITHUB_PATH]; } };
}

const OPEN = {
  number: 7, title: 't', url: 'u', headRefName: 'task', baseRefName: 'main', headRefOid: 'a'.repeat(40), isDraft: false,
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], author: { login: 'x' },
};

// A fake gh that records every call; `view` is what `gh repo view` answers besides the slug and url.
function fakeGh(view) {
  const calls = [];
  let merged = false;
  const impl = async (cwd, args) => {
    calls.push(args.join(' '));
    const [a, b] = args;
    if (a === 'repo' && b === 'view') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', deleteBranchOnMerge: false, ...view }), stderr: '' };
    if (a === 'pr' && b === 'view') return { code: 0, stdout: JSON.stringify({ ...OPEN, state: merged ? 'MERGED' : 'OPEN' }), stderr: '' };
    if (a === 'api' && args.includes('PUT')) { merged = true; return { code: 0, stdout: '{}', stderr: '' }; }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { impl, calls, puts: () => calls.filter((c) => c.includes('-X PUT')) };
}

let n = 0;
async function runMerge(view, method) {
  const g = fakeGh(view);
  const { github, restore } = loadGithub(g.impl);
  try {
    const repo = { id: `rp226-${n++}`, path: __dirname };
    const out = await github.mergePr(repo, 7, method, false).then((r) => ({ r }), (e) => ({ e }));
    return { ...out, g };
  } finally { restore(); }
}

const ONLY_SQUASH_REBASE = { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true };
const ALL = { squash: true, merge: true, rebase: true };

// A flag that says false is honored even when gh did not answer the other two: the panel never sends a method the repo says it prohibits.
test('a partial answer from gh still honors a flag that says false: merge false alone sends squash, never merge', async () => {
  const { r, g } = await runMerge({ mergeCommitAllowed: false }, 'merge');
  assert.deepEqual(r, { merged: true, branch: 'kept', method: 'squash', requested: 'merge' });
  assert.equal(g.puts().length, 1);
  assert.match(g.puts()[0], /merge_method=squash/);
  assert.doesNotMatch(g.puts()[0], /merge_method=merge/);
});

test('pickMergeMethod: the requested method wins when allowed', () => {
  assert.deepEqual(lib.pickMergeMethod('merge', ALL), { method: 'merge', requested: 'merge', fellBack: false });
  assert.deepEqual(lib.pickMergeMethod('rebase', ALL), { method: 'rebase', requested: 'rebase', fellBack: false });
});

test('pickMergeMethod: a prohibited request falls back in the order squash, rebase, merge', () => {
  assert.deepEqual(lib.pickMergeMethod('merge', { squash: true, merge: false, rebase: true }), { method: 'squash', requested: 'merge', fellBack: true });
  assert.deepEqual(lib.pickMergeMethod('merge', { squash: false, merge: false, rebase: true }), { method: 'rebase', requested: 'merge', fellBack: true });
  assert.deepEqual(lib.pickMergeMethod('squash', { squash: false, merge: true, rebase: true }), { method: 'rebase', requested: 'squash', fellBack: true });
  assert.deepEqual(lib.pickMergeMethod('rebase', { squash: false, merge: true, rebase: false }), { method: 'merge', requested: 'rebase', fellBack: true });
});

test('pickMergeMethod: unknown or partial flags count as allowed', () => {
  for (const a of [null, undefined, {}, { squash: false }, { merge: 'no' }]) {
    assert.deepEqual(lib.pickMergeMethod('merge', a), { method: 'merge', requested: 'merge', fellBack: false }, JSON.stringify(a));
  }
  assert.deepEqual(lib.pickMergeMethod('merge', { merge: false, squash: false }), { method: 'rebase', requested: 'merge', fellBack: true });
});

test('pickMergeMethod: nothing allowed gives null', () => {
  assert.equal(lib.pickMergeMethod('squash', { squash: false, merge: false, rebase: false }), null);
});

test('mergePr: a prohibited method falls back to an allowed one and says so', async () => {
  const { r, e, g } = await runMerge(ONLY_SQUASH_REBASE, 'merge');
  assert.equal(e, undefined);
  assert.deepEqual(r, { merged: true, branch: 'kept', method: 'squash', requested: 'merge' });
  assert.equal(g.puts().length, 1);
  assert.ok(g.puts()[0].includes('-f merge_method=squash'), g.puts()[0]);
  assert.ok(!g.puts()[0].includes('merge_method=merge'));
});

test('mergePr: an allowed method is sent as is and the answer is exactly the old one', async () => {
  const { r, g } = await runMerge(ONLY_SQUASH_REBASE, 'rebase');
  assert.deepEqual(r, { merged: true, branch: 'kept' });
  assert.equal(g.puts().length, 1);
  assert.ok(g.puts()[0].includes('-f merge_method=rebase'), g.puts()[0]);
});

test('mergePr: gh without the new fields uses the requested method', async () => {
  const { r, g } = await runMerge({}, 'merge');
  assert.deepEqual(r, { merged: true, branch: 'kept' });
  assert.ok(g.puts()[0].includes('-f merge_method=merge'), g.puts()[0]);
});

test('mergePr: asks GitHub for the three flags and only reads', async () => {
  const { g } = await runMerge(ONLY_SQUASH_REBASE, 'squash');
  const view = g.calls.find((c) => c.startsWith('repo view'));
  assert.ok(/mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed/.test(view), view);
  assert.deepEqual(g.calls.filter((c) => /-X (PATCH|POST|DELETE)/.test(c)), []);
});

test('mergePr: no allowed method answers 409 and sends no PUT', async () => {
  const { r, e, g } = await runMerge({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }, 'squash');
  assert.equal(r, undefined);
  assert.equal(e.status, 409);
  assert.equal(e.message, 'This repository allows no merge method');
  assert.deepEqual(g.puts(), []);
  assert.ok(!g.calls.some((c) => c.includes('merge_method')));
});

test('mergePr: an invalid method still answers 400 and calls nothing', async () => {
  const { e, g } = await runMerge(ONLY_SQUASH_REBASE, 'octopus');
  assert.equal(e.status, 400);
  assert.equal(e.message, 'Invalid merge method');
  assert.deepEqual(g.calls, []);
});

test('doMerge: the toast gets the extra text only when the answer has requested', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'actions.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('async function doMerge'), src.indexOf('function persistLive'));
  assert.ok(body.includes('r.requested ?'), 'conditional on r.requested');
  assert.ok(body.includes('merged with ${r.method} (${r.requested} is not allowed here)'));
  assert.ok(body.includes("${r.branch === 'deleted' ? ' · branch deleted' : r.branch === 'auto' ? ' · branch auto-deleted' : ''}${r.requested ?"));
});
