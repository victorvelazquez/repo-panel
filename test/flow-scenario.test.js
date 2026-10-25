'use strict';
// One repo walked through the whole delivery lifecycle with the pure helpers the page renders from: which column
// each card is in and which flow button shows at every step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowButtons, fixPrAction, localPlacement, prColumn, isProblem } = require('../public/view.js');

const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], head: 'h1', inProgress: null, base: 'main', ...o });
const openPr = (checks, o = {}) => ({ number: 7, head: 'task', base: 'main', ready: false, mergeStateStatus: 'BLOCKED', checks: { failedRuns: [], ...checks }, ...o });
const pending = openPr({ state: 'pending' });
const failed = openPr({ state: 'failed', failedRuns: ['123'] });
const merged = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };

// Each step: what /api/local and /api/prs say, then the expected column of the local card (null: no local card),
// its flow buttons, and the column of the PR card.
const STEPS = [
  { name: '1. dirty working tree on a task branch', l: local({ files: [file], noUpstream: true, upstream: null }), p: { prs: [], stale: null }, column: 'changes', buttons: ['/flow-commit'] },
  { name: '2. after /flow-commit: clean, ahead 1, no PR', l: local({ ahead: 1, noUpstream: true, upstream: null }), p: { prs: [], stale: null }, column: 'committed', buttons: ['/flow-pr'] },
  { name: '3. PR created and pushed: checks pending', l: local(), p: { prs: [pending], stale: null }, column: null, buttons: [], pr: { column: 'progress', problem: false, fix: false } },
  { name: '4. checks failed', l: local(), p: { prs: [failed], stale: null }, column: null, buttons: [], pr: { column: 'progress', problem: true, fix: true } },
  { name: '5. the agent fixed it: dirty again, open PR', l: local({ files: [file] }), p: { prs: [failed], stale: null }, column: 'changes', buttons: ['/flow-commit'] },
  { name: '6. after /flow-commit: ahead 1, open PR of this branch', l: local({ ahead: 1 }), p: { prs: [failed], stale: null }, column: 'committed', buttons: ['/flow-pr (update PR)'] },
  { name: '7. PR merged and branch gone: stale and clean', l: local({ currentGone: true }), p: { prs: [], stale: merged }, column: 'clean', attn: true, buttons: ['/flow-base'] },
  { name: '7b. merged branch but files changed: carry them with --stash', l: local({ files: [file], currentGone: true }), p: { prs: [], stale: merged }, column: 'changes', attn: true, buttons: ['/flow-base --stash'] },
  { name: '8. after /flow-base: on the base branch, nothing ahead', l: local({ branch: 'main', upstream: 'origin/main' }), p: { prs: [], stale: null }, column: 'clean', row: true, buttons: [] },
];

test('the whole flow: column and flow buttons at every step', () => {
  for (const s of STEPS) {
    const place = localPlacement(s.l, s.p, s.p.prs.length, null);
    assert.equal(place.column, s.column, `${s.name}: column`);
    assert.equal(place.attn, !!s.attn, `${s.name}: attention`);
    assert.equal(place.row, !!s.row, `${s.name}: compact row`);
    assert.deepEqual(flowButtons(s.l, s.p, null, {}).map((b) => b.label), s.buttons, `${s.name}: buttons`);
    for (const pr of s.pr ? s.p.prs : []) {
      assert.equal(prColumn(pr), s.pr.column, `${s.name}: PR column`);
      assert.equal(isProblem(pr), s.pr.problem, `${s.name}: PR problem`);
      assert.equal(fixPrAction(pr).show, s.pr.fix, `${s.name}: Fix with pi`);
    }
  }
  assert.equal(failed.checks.failedRuns.length > 0, true); // step 4 also offers Re-run failed
});

test('the whole flow: no flow button when the repo needs manual action', () => {
  const p = { prs: [], stale: null };
  const detached = local({ branch: null, detached: true, ahead: 1 });
  const onBase = local({ branch: 'main', ahead: 1, upstream: 'origin/main' });
  for (const l of [detached, onBase, local({ ahead: 1, inProgress: 'rebase' })]) {
    assert.deepEqual(flowButtons(l, p, null, {}), []);
    assert.equal(localPlacement(l, p, 0, null).attn, true);
  }
  assert.equal(localPlacement(onBase, p, 0, null).column, 'committed');
  assert.equal(localPlacement(detached, p, 0, null).column, 'committed');
});

test('the whole flow: a stale repo with changes shows /flow-base --stash and no /flow-commit', () => {
  const l = local({ files: [file], currentGone: true });
  const p = { prs: [], stale: merged };
  assert.deepEqual(flowButtons(l, p, null, {}).map((b) => b.label), ['/flow-base --stash']);
  assert.deepEqual(localPlacement(l, p, 0, null), { column: 'changes', attn: true, row: false });
});

test('the whole flow: a running /flow-commit hides /flow-pr and /flow-base', () => {
  const ctx = { verdict: 'running' };
  assert.deepEqual(flowButtons(local({ ahead: 1 }), { prs: [], stale: null }, null, ctx), []);
  assert.deepEqual(flowButtons(local(), { prs: [], stale: merged }, null, ctx), []);
  // a failed /flow-commit puts the card in attention without moving it
  assert.deepEqual(localPlacement(local({ ahead: 1 }), { prs: [], stale: null }, 0, 'attention'), { column: 'committed', attn: true, row: false });
});

// ---------- RP18: sending a command shows it running, and the card moves when the session finishes ----------
const { flowVerdict } = require('../public/view.js');

test('the whole flow: /flow-pr is sent, runs (disabled), finishes, and the card moves to the PR column after the refresh', () => {
  const NOW = 50_000_000;
  const none = { prs: [], stale: null };
  const sent = { cmd: 'flow-pr', at: NOW - 60_000, head: 'h1', branch: 'task', files: 0, ahead: 1 };
  const committed = local({ ahead: 1, noUpstream: true, upstream: null });
  // 1. COMMITTED card with /flow-pr enabled
  assert.deepEqual(flowButtons(committed, none, null, {}).map((b) => [b.label, b.disabled]), [['/flow-pr', undefined]]);
  // 2. sent, the session works: running, same card and column, the button disabled (the second click is impossible)
  const running = flowVerdict(sent, committed, 'busy', none, NOW);
  assert.deepEqual([running.state, running.label], ['running', 'creating pull request…']);
  assert.deepEqual(flowButtons(committed, none, null, { running }).map((b) => [b.label, b.disabled]), [['/flow-pr', true]]);
  assert.equal(localPlacement(committed, none, 0, running.state).column, 'committed');
  // 3. the session finished and the refresh brought the pushed branch with its open PR: ok, and the card is the PR's
  const refreshed = { l: local(), p: { prs: [pending], stale: null } };
  const done = flowVerdict(sent, refreshed.l, 'idle', refreshed.p, NOW);
  assert.equal(done.state, 'ok');
  assert.equal(localPlacement(refreshed.l, refreshed.p, 1, null).column, null);
  assert.equal(prColumn(pending), 'progress');
  // a /flow-pr that finished without creating the PR needs attention instead
  assert.equal(flowVerdict(sent, committed, 'idle', none, NOW).reason, 'No open pull request for task after /flow-pr');
});

test('the whole flow: staged renames -> /flow-commit --unstage -> unstaged dirty tree -> /flow-commit -> /flow-pr', () => {
  const NOW = 60_000_000;
  const none = { prs: [], stale: null };
  const renamed = local({ files: [file, file], stagedCount: 2, stagedPaths: ['new.txt', 'old.txt'], noUpstream: true, upstream: null });
  // 1. the index is not empty: only the unstage button, with its explanation
  assert.deepEqual(flowButtons(renamed, none, null, {}).map((b) => b.label), ['/flow-commit --unstage']);
  // 2. sent: running, disabled
  const unstage = { cmd: 'flow-commit-unstage', at: NOW - 60_000, head: 'h1', branch: 'task', files: 2, ahead: 0 };
  const running = flowVerdict(unstage, renamed, 'busy', none, NOW);
  assert.equal(running.state, 'running');
  assert.deepEqual(flowButtons(renamed, none, null, { running }).map((b) => [b.label, b.disabled]), [['/flow-commit --unstage', true]]);
  // 3. the index is empty but the tree is still dirty and nothing was committed: attention, plain retry label
  const unstaged = local({ files: [file, file], noUpstream: true, upstream: null });
  const stuck = flowVerdict(unstage, unstaged, 'idle', none, NOW);
  assert.equal(stuck.state, 'attention');
  assert.deepEqual(flowButtons(unstaged, none, null, { verdict: stuck.state, retry: true }).map((b) => b.label), ['Retry /flow-commit']);
  // 4. /flow-commit commits: ok, and the COMMITTED card offers /flow-pr
  const commit = { cmd: 'flow-commit', at: NOW - 60_000, head: 'h1', branch: 'task', files: 2, ahead: 0 };
  const committed = local({ ahead: 1, head: 'h2', noUpstream: true, upstream: null });
  assert.equal(flowVerdict(commit, committed, 'idle', none, NOW).state, 'ok');
  assert.deepEqual(flowButtons(committed, none, null, {}).map((b) => b.label), ['/flow-pr']);
});
