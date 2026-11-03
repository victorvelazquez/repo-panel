'use strict';
// RP32 A and C, the pure part in public/view.js: a session value that nothing produces any more (`checking`) holds nothing,
// and a command being sent already counts as a running one.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/view.js');

const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 1, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const PR = { prs: [], stale: null };

test('flowButtons: previous behaviour holds (busy, asking, idle, undefined)', () => {
  assert.equal(V.flowButtons(local(), PR, null, { session: 'busy' })[0].reason, 'the session is still working');
  assert.equal(V.flowButtons(local(), PR, null, { session: 'asking' })[0].reason, 'waiting for your answer in the session');
  assert.deepEqual(V.flowButtons(local(), PR, null, { session: 'idle' }), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
  assert.deepEqual(V.flowButtons(local(), PR, null, {}), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
  assert.deepEqual(V.flowButtons(local(), PR, null, { session: 'checking' }), [{ cmd: 'flow-commit', label: '/flow-commit' }], 'holds nothing');
});

// ---------- C: sendingVerdict ----------
test('sendingVerdict: a running pseudo-verdict with the SAME label as the real running verdict of each command', () => {
  for (const cmd of ['flow-commit', 'flow-commit-unstage', 'flow-pr', 'flow-base', 'flow-base-stash', 'fix-pr', 'put-in-conditions']) {
    const real = V.flowVerdict({ cmd, at: Date.now() }, local(), undefined, PR);
    const v = V.sendingVerdict(cmd);
    assert.deepEqual(v, { state: 'running', cmd, label: real.label, reason: 'Sending the order to the session' }, cmd);
  }
  assert.equal(V.sendingVerdict('flow-commit').label, 'committing…');
  assert.equal(V.sendingVerdict('flow-pr').label, 'creating pull request…');
});

test('sendingVerdict: disables every flow button of the repo through flowButtons({ running })', () => {
  const v = V.sendingVerdict('flow-commit');
  const buttons = V.flowButtons(local(), PR, null, { running: { cmd: v.cmd, label: v.label } });
  assert.equal(buttons.length > 0 && buttons.every((b) => b.disabled === true), true);
});
