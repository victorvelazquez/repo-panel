'use strict';
// RP28 point 1B: right after a merge the cached "no merged PR" answer for that branch is dropped, so the next
// /api/prs can report «Merged: run /flow-base» at once instead of up to 15 s later. gh is injected, never real.
const test = require('node:test');
const assert = require('node:assert/strict');

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

function withClock(fn) {
  const real = Date.now;
  const t = 5_000_000;
  Date.now = () => t;
  const done = (v) => { Date.now = real; return v; };
  return Promise.resolve(fn()).then(done, (e) => { Date.now = real; throw e; });
}

const OPEN = {
  number: 7, title: 't', url: 'u', headRefName: 'task', baseRefName: 'main', headRefOid: 'a'.repeat(40), isDraft: false,
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: [], author: { login: 'x' },
};

// A fake gh: `state.merged` flips when the merge call is made (or, with putFails, only the PR view says MERGED).
function fakeGh(state) {
  const calls = [];
  const impl = async (cwd, args) => {
    calls.push(args.join(' '));
    const [a, b] = args;
    if (a === 'repo' && b === 'view') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', deleteBranchOnMerge: false }), stderr: '' };
    if (a === 'pr' && b === 'view') return { code: 0, stdout: JSON.stringify({ ...OPEN, state: state.merged ? 'MERGED' : 'OPEN' }), stderr: '' };
    if (a === 'api' && args.includes('PUT')) {
      if (state.putFails) { state.merged = true; return { code: 1, stdout: '', stderr: 'timeout' }; }
      if (state.refuse) return { code: 1, stdout: JSON.stringify({ message: 'Head branch was modified' }), stderr: '' };
      state.merged = true;
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (a === 'api' && args.includes('DELETE')) return { code: 0, stdout: '', stderr: '' };
    if (a === 'pr' && b === 'list') {
      state.listCalls++;
      return { code: 0, stdout: JSON.stringify(state.merged ? [{ number: 7, url: 'u', isCrossRepository: false }] : []), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { impl, calls };
}

const repo = (id) => ({ id, path: __dirname });

test('mergePr: a successful merge drops the cached "no merged PR" answer of that branch', async () => {
  const state = { merged: false, listCalls: 0 };
  const { github, restore } = loadGithub(fakeGh(state).impl);
  try {
    await withClock(async () => {
      assert.equal(await github.mergedPrFor(repo('m1'), 'task'), null);
      assert.equal(state.listCalls, 1);
      assert.equal(await github.mergedPrFor(repo('m1'), 'task'), null);
      assert.equal(state.listCalls, 1, 'precondition: the "none" answer is cached (clock frozen)');
      const r = await github.mergePr(repo('m1'), 7, 'squash', false);
      assert.equal(r.merged, true);
      const pr = await github.mergedPrFor(repo('m1'), 'task');
      assert.equal(state.listCalls, 2, 'asked GitHub again right after the merge');
      assert.equal(pr.number, 7);
    });
  } finally { restore(); }
});

test('mergePr: when gh api failed but the PR shows MERGED, the cache is dropped too', async () => {
  const state = { merged: false, putFails: true, listCalls: 0 };
  const { github, restore } = loadGithub(fakeGh(state).impl);
  try {
    await withClock(async () => {
      assert.equal(await github.mergedPrFor(repo('m2'), 'task'), null);
      const r = await github.mergePr(repo('m2'), 7, 'squash', false);
      assert.equal(r.merged, true);
      assert.equal((await github.mergedPrFor(repo('m2'), 'task')).number, 7);
      assert.equal(state.listCalls, 2);
    });
  } finally { restore(); }
});

test('mergePr: PRESERVE a refused merge still throws and keeps the cache of the branch', async () => {
  const state = { merged: false, refuse: true, listCalls: 0 };
  const { github, restore } = loadGithub(fakeGh(state).impl);
  try {
    await withClock(async () => {
      assert.equal(await github.mergedPrFor(repo('m3'), 'task'), null);
      await assert.rejects(github.mergePr(repo('m3'), 7, 'squash', false), (e) => e.status === 502 && /Head branch was modified/.test(e.message));
      assert.equal(await github.mergedPrFor(repo('m3'), 'task'), null);
      assert.equal(state.listCalls, 1, 'no extra request: the answer stays cached');
    });
  } finally { restore(); }
});

test('mergePr: PRESERVE the cache of another branch and another repo is left alone', async () => {
  const state = { merged: false, listCalls: 0 };
  const { github, restore } = loadGithub(fakeGh(state).impl);
  try {
    await withClock(async () => {
      await github.mergedPrFor(repo('m4'), 'other');
      await github.mergedPrFor(repo('m5'), 'task');
      assert.equal(state.listCalls, 2);
      await github.mergePr(repo('m4'), 7, 'squash', false);
      await github.mergedPrFor(repo('m4'), 'other');
      await github.mergedPrFor(repo('m5'), 'task');
      assert.equal(state.listCalls, 2, 'still cached');
    });
  } finally { restore(); }
});

test('mergePr: PRESERVE the answer and the branch cleanup of a successful merge', async () => {
  const state = { merged: false, listCalls: 0 };
  const fake = fakeGh(state);
  const { github, restore } = loadGithub(fake.impl);
  try {
    assert.deepEqual(await github.mergePr(repo('m6'), 7, 'squash', true), { merged: true, branch: 'deleted' });
    assert.ok(fake.calls.some((c) => /DELETE repos\/o\/r\/git\/refs\/heads\/task/.test(c)));
  } finally { restore(); }
});
