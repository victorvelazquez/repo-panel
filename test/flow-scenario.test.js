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
