'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { manualAction, prAction, commitAllowed, stateLine, commitOverrideItem, commitVerdict } = require('../public/view.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const file = (p = 'a.txt') => ({ path: p, status: 'M', untracked: false });
// A clean task branch with two commits ahead of its upstream, as /api/local answers it.
const local = (o = {}) => ({
  branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 2, behind: 0, files: [],
  head: 'b'.repeat(40), inProgress: null, base: 'main', ...o,
});
const prs = (o = {}) => ({ prs: [], stale: null, ...o });
const pr = (head) => ({ number: 7, head, base: 'main' });

// ---------- manualAction ----------
test('manualAction: commits ahead while on the base branch', () => {
  assert.equal(manualAction(local({ branch: 'main', ahead: 1 }), 'main'), 'Commits on main: move them to a task branch');
  assert.equal(manualAction(local({ branch: 'develop', ahead: 3, noUpstream: true, upstream: null }), 'develop'), 'Commits on develop: move them to a task branch');
});

test('manualAction: detached HEAD', () => {
  assert.equal(manualAction(local({ branch: null, detached: true, ahead: 0 }), 'main'), 'Detached HEAD: switch to a task branch');
});

test('manualAction: an operation in progress, named', () => {
  for (const op of ['merge', 'rebase', 'cherry-pick', 'revert']) {
    assert.equal(manualAction(local({ inProgress: op }), 'main'), `A ${op} is in progress: finish or abort it`);
  }
  // a rebase leaves HEAD detached: the operation is the reason, not the detached HEAD
  assert.equal(manualAction(local({ inProgress: 'rebase', detached: true, branch: null }), 'main'), 'A rebase is in progress: finish or abort it');
});

test('manualAction: a branch that diverged from its upstream', () => {
  assert.equal(manualAction(local({ ahead: 1, behind: 2 }), 'main'), 'Diverged from origin/task: reconcile it by hand');
});

test('manualAction: does not fire for a clean branch that is only behind, a base with nothing ahead or a normal task branch', () => {
  assert.equal(manualAction(local({ ahead: 0, behind: 3 }), 'main'), null);
  assert.equal(manualAction(local({ branch: 'main', ahead: 0, behind: 0 }), 'main'), null);
  assert.equal(manualAction(local({ branch: 'main', ahead: 0, behind: 2 }), 'main'), null);
  assert.equal(manualAction(local({ ahead: 4 }), 'main'), null);
  assert.equal(manualAction(local({ ahead: 2, noUpstream: true, upstream: null }), 'main'), null);
});

test('manualAction: nothing to say without a loaded or readable local state, or without a base name', () => {
  for (const x of [undefined, null, {}, { error: 'Folder not found' }]) assert.equal(manualAction(x, 'main'), null);
  assert.equal(manualAction(local({ branch: 'main', ahead: 1 }), undefined), null);
});

// ---------- prAction ----------
test('prAction: shows for a clean task branch with commits ahead, with or without an upstream', () => {
  assert.deepEqual(prAction(local(), prs(), null), { show: true, update: false, reason: null });
  assert.deepEqual(prAction(local({ noUpstream: true, upstream: null, ahead: 3 }), prs(), null), { show: true, update: false, reason: null });
});

test('prAction: update is true only for an open PR whose head is the current branch', () => {
  assert.equal(prAction(local(), prs({ prs: [pr('task')] }), null).update, true);
  assert.equal(prAction(local(), prs({ prs: [pr('task')] }), null).show, true);
  assert.equal(prAction(local(), prs({ prs: [pr('other')] }), null).update, false);
  assert.equal(prAction(local(), undefined, null).show, true);
});

test('prAction: hidden, with a short reason, when anything is not clean', () => {
  const no = (l, p, v) => {
    const a = prAction(l, p, v);
    assert.equal(a.show, false);
    assert.equal(a.update, false);
    assert.ok(a.reason && a.reason.length < 80, a.reason);
    return a.reason;
  };
  assert.match(no(local({ files: [file()] }), prs(), null), /uncommitted/i);
  assert.match(no(local({ files: [{ path: 'new.txt', untracked: true }] }), prs(), null), /uncommitted/i);
  assert.match(no(local({ ahead: 0 }), prs(), null), /no commits/i);
  assert.match(no(local({ branch: 'main', ahead: 1 }), prs(), null), /Commits on main/);
  assert.match(no(local({ branch: null, detached: true }), prs(), null), /Detached/);
  assert.match(no(local({ inProgress: 'merge' }), prs(), null), /merge is in progress/);
  // a merge conflict leaves files changed too: the manual-action reason wins
  assert.match(no(local({ inProgress: 'merge', files: [file()] }), prs(), null), /merge is in progress/);
  assert.match(no(local({ behind: 1 }), prs(), null), /Diverged/);
  assert.match(no(local(), prs({ stale: { reason: 'Merged: run /flow-branch', via: 'merged' } }), null), /merged/i);
  assert.match(no(local(), prs(), 'attention'), /attention/i);
  assert.match(no(local(), prs(), 'running'), /committing/i);
});

test('prAction: an ok verdict does not hide it; a loading or unreadable local state does', () => {
  assert.equal(prAction(local(), prs(), 'ok').show, true);
  assert.equal(prAction(undefined, prs(), null).show, false);
  assert.equal(prAction({ error: 'x' }, prs(), null).show, false);
});

test('prAction: without a base name in the local state nothing is taken for the base', () => {
  assert.equal(prAction(local({ base: undefined }), prs(), null).show, true);
});

// ---------- commitAllowed: expiry of working and the override ----------
const st = (state, extra = {}) => ({ available: true, state, next: 'Do the thing.', detail: null, at: ago(MIN), stale: false, reason: null, ...extra });

test('commitAllowed: a working state older than 30 minutes (by its own at) is expired and usable again', () => {
  assert.equal(commitAllowed(st('working', { at: ago(29 * MIN + 59000) }), { now: NOW }), false);
  assert.equal(commitAllowed(st('working', { at: ago(30 * MIN + 1000) }), { now: NOW }), true);
  assert.equal(commitAllowed(st('working', { at: ago(5 * 60 * MIN) }), { now: NOW }), true);
});

test('commitAllowed: needs-input, blocked and ready-to-pr never expire by time', () => {
  for (const s of ['needs-input', 'blocked', 'ready-to-pr']) assert.equal(commitAllowed(st(s, { at: ago(48 * 60 * MIN) }), { now: NOW }), false, s);
  assert.equal(commitAllowed(st('ready-to-commit', { at: ago(48 * 60 * MIN) }), { now: NOW }), true);
});

test('commitAllowed: the override shows the button whatever the state says', () => {
  for (const s of ['working', 'needs-input', 'blocked', 'ready-to-pr', 'ready-to-commit']) assert.equal(commitAllowed(st(s), { now: NOW, override: true }), true, s);
  assert.equal(commitAllowed(st('blocked'), { now: NOW, override: false }), false);
});

test('commitAllowed: the one-argument call keeps working (a fresh working state still hides the button)', () => {
  assert.equal(commitAllowed(st('working', { at: new Date().toISOString() })), false);
  assert.equal(commitAllowed(undefined), true);
});

test('stateLine: an expired working state is only a gray marker, never shown as current', () => {
  const l = stateLine(st('working', { at: ago(31 * MIN) }), { now: NOW });
  assert.equal(l.kind, 'outdated');
  assert.equal(l.dot, 'gray');
  assert.equal(l.text, '');
  assert.equal(stateLine(st('working', { at: ago(29 * MIN) }), { now: NOW }).kind, 'current');
  assert.equal(stateLine(st('needs-input', { at: ago(48 * 60 * MIN) }), { now: NOW }).kind, 'current');
});

test('commitOverrideItem: offered only while a declared state hides the button and the override is off', () => {
  assert.deepEqual(commitOverrideItem(st('needs-input'), { now: NOW }), { act: 'show-commit', label: 'Show /flow-commit anyway' });
  assert.equal(commitOverrideItem(st('needs-input'), { now: NOW, override: true }), null);
  assert.equal(commitOverrideItem(st('ready-to-commit'), { now: NOW }), null);
  assert.equal(commitOverrideItem(undefined, { now: NOW }), null);
  assert.equal(commitOverrideItem(st('working', { at: ago(31 * MIN) }), { now: NOW }), null);
});

// ---------- commitVerdict ----------
const HEAD0 = 'a'.repeat(40);
const HEAD1 = 'b'.repeat(40);
const sent = (ms = MIN) => ({ at: NOW - ms, head: HEAD0, files: 3 });
const v = (s, l, session) => commitVerdict(s, l, session, NOW);

test('commitVerdict: running while the session is busy, even when nothing has changed yet', () => {
  assert.equal(v(sent(), local({ files: [file()], head: HEAD0 }), 'busy').state, 'running');
  assert.equal(v(sent(60 * MIN), local({ files: [file()], head: HEAD0 }), 'busy').state, 'running');
});

test('commitVerdict: ok when the repo is clean, HEAD changed and there are commits ahead', () => {
  assert.equal(v(sent(), local({ head: HEAD1, ahead: 2 }), 'idle').state, 'ok');
  assert.equal(v(sent(), local({ head: HEAD1, ahead: 1, noUpstream: true, upstream: null }), 'closed').state, 'ok');
  assert.equal(v(sent(), local({ head: HEAD1, ahead: 1 }), 'unknown').state, 'ok');
  assert.equal(v({ at: NOW - MIN, head: null, files: 1 }, local({ head: HEAD1 }), 'idle').state, 'ok');
});

test('commitVerdict: attention when the session is idle but files remain changed', () => {
  const one = v(sent(), local({ files: [file()], head: HEAD1 }), 'idle');
  assert.deepEqual(one, { state: 'attention', reason: '1 file still uncommitted after /flow-commit' });
  const two = v(sent(), local({ files: [file(), { path: 'n.txt', untracked: true }], head: HEAD1 }), 'idle');
  assert.equal(two.reason, '2 files still uncommitted after /flow-commit');
  assert.equal(v(sent(), local({ files: [file()], head: HEAD0 }), 'closed').state, 'attention');
});

test('commitVerdict: attention when HEAD did not change', () => {
  const a = v(sent(), local({ head: HEAD0, ahead: 2 }), 'idle');
  assert.equal(a.state, 'attention');
  assert.match(a.reason, /no new commit/i);
});

test('commitVerdict: attention when the session closed while running', () => {
  const a = v(sent(), local({ head: HEAD0 }), 'closed');
  assert.equal(a.state, 'attention');
  assert.match(a.reason, /closed/i);
});

test('commitVerdict: HEAD changed but nothing left to deliver is attention, not ok', () => {
  assert.equal(v(sent(), local({ head: HEAD1, ahead: 0 }), 'idle').state, 'attention');
});

test('commitVerdict: an unknown session is running for 15 minutes, then attention if nothing changed', () => {
  const same = local({ head: HEAD0, files: [file()] });
  assert.equal(v(sent(14 * MIN + 59000), same, 'unknown').state, 'running');
  assert.equal(v(sent(14 * MIN + 59000), same, undefined).state, 'running');
  assert.equal(v(sent(14 * MIN + 59000), same, 'ambiguous').state, 'running');
  const late = v(sent(15 * MIN + 1000), local({ head: HEAD0 }), 'unknown');
  assert.equal(late.state, 'attention');
  assert.match(late.reason, /15 minutes/);
  assert.equal(v(sent(15 * MIN + 1000), same, 'unknown').state, 'attention');
});

test('commitVerdict: just after sending, an idle or closed session is still running (it may not have started yet)', () => {
  const same = local({ head: HEAD0, files: [file()] });
  assert.equal(v(sent(5000), same, 'idle').state, 'running');
  assert.equal(v(sent(5000), same, 'closed').state, 'running');
  assert.equal(v(sent(31000), same, 'idle').state, 'attention');
});

test('commitVerdict: waits while the local state is not loaded; no record means no verdict', () => {
  assert.equal(v(sent(), undefined, 'idle').state, 'running');
  assert.equal(v(sent(), { error: 'x' }, 'idle').state, 'running');
  assert.equal(v(undefined, local(), 'idle'), null);
});

test('commitVerdict: always returns a reason', () => {
  for (const session of ['idle', 'busy', 'closed', 'unknown']) assert.ok(v(sent(), local({ files: [file()] }), session).reason);
});
