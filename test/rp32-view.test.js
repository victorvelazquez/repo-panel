'use strict';
// RP32 A and C, the pure part in public/view.js: the commit buttons wait for the first live answer of the pi session
// (at most LIVE_CHECK_MS), and a command being sent already counts as a running one.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');

const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 1, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const PR = { prs: [], stale: null };

// ---------- A: liveSession ----------
test('liveSession: no answer yet, a dirty repo first seen less than LIVE_CHECK_MS ago is `checking`', () => {
  assert.equal(V.LIVE_CHECK_MS, 20000);
  const now = 1_000_000;
  assert.equal(V.liveSession({ dirtyAt: now - 1, now }), 'checking');
  assert.equal(V.liveSession({ dirtyAt: now - V.LIVE_CHECK_MS + 1, now }), 'checking');
});

test('liveSession: after LIVE_CHECK_MS it fails open', () => {
  const now = 1_000_000;
  assert.equal(V.liveSession({ dirtyAt: now - V.LIVE_CHECK_MS, now }), undefined);
  assert.equal(V.liveSession({ dirtyAt: now - 60000, now }), undefined);
});

test('liveSession: the first answer, success or failure, ends the checking', () => {
  const now = 1_000_000;
  assert.equal(V.liveSession({ dirtyAt: now - 1, live: 'busy', answered: true, now }), 'busy');
  assert.equal(V.liveSession({ dirtyAt: now - 1, live: 'idle', answered: true, now }), 'idle');
  assert.equal(V.liveSession({ dirtyAt: now - 1, answered: true, now }), undefined, 'a failed request: unknown, never blocks');
});

test('liveSession: a command of the page in flight, or a repo never seen dirty, is not checked', () => {
  const now = 1_000_000;
  assert.equal(V.liveSession({ sent: { cmd: 'flow-commit' }, dirtyAt: now - 1, live: 'busy', now }), undefined);
  assert.equal(V.liveSession({ now }), undefined);
  assert.equal(V.liveSession({ dirtyAt: now + 60000, now }), undefined, 'a time from the future is a clock problem');
});

// ---------- A: the buttons ----------
test('flowButtons: session `checking` disables /flow-commit with the reason', () => {
  assert.deepEqual(V.flowButtons(local(), PR, null, { session: 'checking' }), [{ cmd: 'flow-commit', label: '/flow-commit', disabled: true, reason: 'checking the pi session…' }]);
});

test('flowButtons: session `checking` disables /flow-commit --unstage too and keeps its label', () => {
  const [b] = V.flowButtons(local({ stagedCount: 2, stagedPaths: ['a', 'b'] }), PR, null, { session: 'checking' });
  assert.deepEqual([b.cmd, b.label, b.disabled, b.reason], ['flow-commit-unstage', '/flow-commit --unstage', true, 'checking the pi session…']);
});

test('flowButtons: `override` lifts the checking hold like the other holds', () => {
  assert.deepEqual(V.flowButtons(local(), PR, null, { session: 'checking', override: true }), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
});

test('flowButtons: previous behaviour holds (busy, asking, idle, undefined)', () => {
  assert.equal(V.flowButtons(local(), PR, null, { session: 'busy' })[0].reason, 'the pi session is still working');
  assert.equal(V.flowButtons(local(), PR, null, { session: 'asking' })[0].reason, 'waiting for your answer in the session');
  assert.deepEqual(V.flowButtons(local(), PR, null, { session: 'idle' }), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
  assert.deepEqual(V.flowButtons(local(), PR, null, {}), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
});

test('commitOverrideItem: offers «Show /flow-commit anyway» while checking, and not once lifted', () => {
  assert.deepEqual(V.commitOverrideItem(null, { session: 'checking' }), { act: 'show-commit', label: 'Show /flow-commit anyway' });
  assert.equal(V.commitOverrideItem(null, { session: 'checking', override: true }), null);
  assert.equal(V.commitOverrideItem(null, { session: 'idle' }), null);
});

// ---------- C: sendingVerdict ----------
test('sendingVerdict: a running pseudo-verdict with the SAME label as the real running verdict of each command', () => {
  for (const cmd of ['flow-commit', 'flow-commit-unstage', 'flow-pr', 'flow-base', 'flow-base-stash', 'fix-pr', 'put-in-conditions']) {
    const real = V.flowVerdict({ cmd, at: Date.now() }, local(), undefined, PR);
    const v = V.sendingVerdict(cmd);
    assert.deepEqual(v, { state: 'running', cmd, label: real.label, reason: 'Sending the order to the pi session' }, cmd);
  }
  assert.equal(V.sendingVerdict('flow-commit').label, 'committing…');
  assert.equal(V.sendingVerdict('flow-pr').label, 'creating pull request…');
});

test('sendingVerdict: disables every flow button of the repo through flowButtons({ running })', () => {
  const v = V.sendingVerdict('flow-commit');
  const buttons = V.flowButtons(local(), PR, null, { running: { cmd: v.cmd, label: v.label } });
  assert.equal(buttons.length > 0 && buttons.every((b) => b.disabled === true), true);
});
