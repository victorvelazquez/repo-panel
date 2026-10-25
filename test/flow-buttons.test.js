'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowButtons, fixPrAction } = require('../public/view.js');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const file = { path: 'a.txt', status: 'M', untracked: false };
// A task branch as /api/local answers it: clean, one commit ahead, pushed upstream.
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 1, behind: 0, files: [], head: 'b'.repeat(40), inProgress: null, base: 'main', ...o });
const dirty = (o = {}) => local({ ahead: 0, files: [file], ...o });
const prs = (o = {}) => ({ prs: [], stale: null, ...o });
const stale = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
const declared = (state) => ({ available: true, state, next: 'x', detail: null, at: new Date(NOW - 60000).toISOString(), stale: false, reason: null });
const cmds = (list) => list.map((b) => b.cmd);
const ctx = (o = {}) => ({ now: NOW, ...o });

test('flowButtons: which button each state of the repo shows', () => {
  const rows = [
    ['dirty tree', dirty(), prs(), null, ctx(), ['flow-commit']],
    ['dirty, declared needs-input hides the commit button', dirty(), prs(), declared('needs-input'), ctx(), []],
    ['dirty, needs-input but the person lifted the gating', dirty(), prs(), declared('needs-input'), ctx({ override: true }), ['flow-commit']],
    ['clean, ahead, no PR', local(), prs(), null, ctx(), ['flow-pr']],
    ['clean, ahead, an open PR of the branch', local(), prs({ prs: [{ number: 7, head: 'task' }] }), null, ctx(), ['flow-pr']],
    ['clean, ahead, commit verdict running', local(), prs(), null, ctx({ verdict: 'running' }), []],
    ['clean, ahead, commit verdict needs attention', local(), prs(), null, ctx({ verdict: 'attention' }), []],
    ['clean, nothing ahead', local({ ahead: 0 }), prs(), null, ctx(), []],
    ['local state failed to load', { error: 'boom' }, prs(), null, ctx(), []],
    ['local state not loaded', undefined, prs(), null, ctx(), []],
  ];
  for (const [name, l, p, state, c, want] of rows) assert.deepEqual(cmds(flowButtons(l, p, state, c)), want, name);
});

test('flowButtons: /flow-pr is labelled as an update only when the branch already has an open PR', () => {
  assert.deepEqual(flowButtons(local(), prs(), null, ctx()), [{ cmd: 'flow-pr', label: '/flow-pr' }]);
  assert.deepEqual(flowButtons(local(), prs({ prs: [{ number: 7, head: 'task' }] }), null, ctx()), [{ cmd: 'flow-pr', label: '/flow-pr (update PR)' }]);
  assert.deepEqual(flowButtons(dirty(), prs(), null, ctx()), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
});

test('flowButtons: /flow-base shows on a stale repo with a clean tree and explains itself', () => {
  const [b, ...rest] = flowButtons(local({ ahead: 0, noUpstream: true, upstream: null }), prs({ stale }), null, ctx());
  assert.equal(rest.length, 0);
  assert.equal(b.cmd, 'flow-base');
  assert.equal(b.label, '/flow-base');
  assert.match(b.reason, /fresh/i);
  assert.match(b.reason, /updated base branch/i);
  // commits ahead of a merged branch are not delivered with /flow-pr: only /flow-base
  assert.deepEqual(cmds(flowButtons(local(), prs({ stale }), null, ctx())), ['flow-base']);
});

test('flowButtons: a stale repo with changed or untracked files offers /flow-base --stash and no /flow-commit', () => {
  const untracked = { ...file, untracked: true, status: '?' };
  for (const l of [dirty(), dirty({ files: [untracked] }), dirty({ ahead: 2 })]) {
    const [b, ...rest] = flowButtons(l, prs({ stale }), null, ctx());
    assert.equal(rest.length, 0);
    assert.equal(b.cmd, 'flow-base-stash');
    assert.equal(b.label, '/flow-base --stash');
    assert.match(b.reason, /uncommitted changes/);
    assert.match(b.reason, /stash, switch, update, restore/);
    assert.match(b.reason, /refuses and changes nothing/);
    assert.match(b.reason, /not yet merged or its remote branch not yet deleted/);
  }
  // a declared state that hides /flow-commit does not hide the carry-over
  assert.deepEqual(cmds(flowButtons(dirty({ files: [untracked] }), prs({ stale }), declared('needs-input'), ctx())), ['flow-base-stash']);
});

test('flowButtons: a dirty repo that is not stale keeps /flow-commit and never shows the stash button', () => {
  assert.deepEqual(flowButtons(dirty(), prs(), null, ctx()), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
  assert.deepEqual(cmds(flowButtons(dirty(), undefined, null, ctx())), ['flow-commit']);
  assert.deepEqual(cmds(flowButtons(dirty(), prs({ stale: null }), declared('needs-input'), ctx())), []);
});

test('flowButtons: /flow-base is hidden when a manual action is needed or the commit verdict is running', () => {
  assert.deepEqual(flowButtons(dirty({ branch: null, detached: true }), prs({ stale }), null, ctx()), []);
  assert.deepEqual(flowButtons(dirty({ inProgress: 'rebase' }), prs({ stale }), null, ctx()), []);
  assert.deepEqual(flowButtons(dirty(), prs({ stale }), null, ctx({ verdict: 'running' })), []);
  assert.deepEqual(flowButtons(local({ ahead: 0, branch: null, detached: true }), prs({ stale }), null, ctx()), []);
  assert.deepEqual(flowButtons(local({ ahead: 0, inProgress: 'rebase' }), prs({ stale }), null, ctx()), []);
  assert.deepEqual(flowButtons(local({ ahead: 0 }), prs({ stale }), null, ctx({ verdict: 'running' })), []);
  assert.deepEqual(flowButtons(undefined, prs({ stale }), null, ctx()), []);
});

test('fixPrAction: "Fix with pi" shows only for a PR whose checks failed', () => {
  const withChecks = (state) => ({ number: 7, checks: { state, failedRuns: [] } });
  assert.equal(fixPrAction(withChecks('failed')).show, true);
  for (const state of ['pending', 'success', 'none']) {
    const a = fixPrAction(withChecks(state));
    assert.equal(a.show, false, state);
    assert.equal(typeof a.reason, 'string');
  }
  assert.equal(fixPrAction(undefined).show, false);
  assert.equal(fixPrAction({ number: 7 }).show, false);
});

test('staleChipTitle: names the real button, /flow-base for a clean repo and /flow-base --stash for a dirty one', () => {
  const { staleChipTitle } = require('../public/view.js');
  for (const s of [{ via: 'merged', pr: 7 }, { via: 'gone', pr: null }]) {
    const clean = staleChipTitle(s, false);
    assert.match(clean, /Press the \/flow-base button to start from a fresh, updated base branch\./);
    assert.equal(clean.includes('--stash'), false);
    const dirty = staleChipTitle(s, true);
    assert.match(dirty, /Press the \/flow-base --stash button/);
    assert.match(dirty, /carries your uncommitted changes/);
  }
  assert.match(staleChipTitle({ via: 'merged', pr: 7 }, false), /^PR #7 from this branch was merged\./);
  assert.match(staleChipTitle({ via: 'gone', pr: null }, true), /^The remote branch was deleted, so its work was merged\./);
});
