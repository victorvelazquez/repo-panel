'use strict';
// RP18: the per-command verdict (flowVerdict) and the flow buttons while a command runs or files are staged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { commitVerdict, flowVerdict, flowButtons, localPlacement } = require('../public/view.js');

const NOW = 10_000_000;
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });
const sent = (cmd, o = {}) => ({ cmd, at: NOW - 60_000, head: 'h1', branch: 'task', files: 0, ahead: 0, ...o });
const openPr = (o = {}) => ({ number: 7, head: 'task', base: 'main', ...o });
const verdict = (s, l, session, prInfo = { prs: [], stale: null }, now = NOW) => flowVerdict(s, l, session, prInfo, now);

// ---------- no record, and the preserved /flow-commit verdict ----------
test('flowVerdict: no record is null', () => {
  assert.equal(flowVerdict(null, local(), 'idle', { prs: [] }, NOW), null);
  assert.equal(flowVerdict(undefined, local(), 'idle', { prs: [] }, NOW), null);
});

test('flowVerdict: /flow-commit is judged by commitVerdict, untouched, with the label added', () => {
  const s = sent('flow-commit', { files: 2 });
  const cases = [
    [local({ files: [file, file] }), 'busy'],
    [local({ ahead: 1, head: 'h2' }), 'idle'],
    [local({ files: [file] }), 'idle'],
    [local({ head: 'h1' }), 'closed'],
    [local({ files: [file] }), undefined],
    [null, 'idle'],
  ];
  for (const [l, session] of cases) {
    const v = flowVerdict(s, l, session, { prs: [] }, NOW);
    const old = commitVerdict(s, l, session, NOW);
    assert.deepEqual({ state: v.state, reason: v.reason }, old, `${session}`);
    assert.equal(v.label, 'committing…');
  }
  assert.equal(flowVerdict(sent('flow-commit', { at: NOW - 5000 }), local({ files: [file] }), 'idle', { prs: [] }, NOW).state, 'running');
});

test('flowVerdict: /flow-commit --unstage is the commit verdict, and ok also needs an empty index', () => {
  const s = sent('flow-commit-unstage', { files: 3 });
  const done = local({ ahead: 1, head: 'h2' });
  const ok = verdict(s, done, 'idle');
  assert.deepEqual([ok.state, ok.label], ['ok', 'committing…']);
  const stuck = verdict(s, local({ ahead: 1, head: 'h2', stagedCount: 2, stagedPaths: ['a', 'b'] }), 'idle');
  assert.equal(stuck.state, 'attention');
  assert.equal(stuck.reason, '2 files are still staged after /flow-commit --unstage');
  assert.equal(verdict(s, local({ files: [file] }), 'busy').state, 'running');
  assert.equal(verdict(s, local({ files: [file] }), 'idle').state, 'attention'); // files left: the commit verdict says so
});

// ---------- /flow-pr ----------
test('flowVerdict /flow-pr: running while busy, and while the idle prompt may just not have started', () => {
  const s = sent('flow-pr', { ahead: 1 });
  const l = local({ ahead: 1 });
  const busy = verdict(s, l, 'busy');
  assert.deepEqual([busy.state, busy.label], ['running', 'creating pull request…']);
  assert.equal(verdict(sent('flow-pr', { at: NOW - 5000 }), l, 'idle').state, 'running'); // grace period
  assert.equal(verdict(s, l, undefined).state, 'running'); // no answer yet
  assert.equal(verdict(s, null, 'idle').state, 'running'); // repo state not loaded
});

test('flowVerdict /flow-pr: ok only when clean, published and an open PR of the current branch exists', () => {
  const s = sent('flow-pr', { ahead: 1 });
  const prs = { prs: [openPr()], stale: null };
  for (const session of ['idle', 'closed', 'busy', 'unknown', undefined]) {
    const expected = session === 'busy' ? 'running' : 'ok';
    assert.equal(verdict(s, local(), session, prs).state, expected, session); // Git decides, except while busy
  }
  const no = (l, p) => verdict(s, l, 'idle', p);
  assert.equal(no(local({ ahead: 1 }), prs).state, 'attention'); // not pushed yet
  assert.equal(no(local({ noUpstream: true, upstream: null }), prs).state, 'attention'); // never published
  assert.equal(no(local({ files: [file] }), prs).state, 'attention'); // dirty
  assert.equal(no(local(), { prs: [openPr({ head: 'other' })], stale: null }).state, 'attention'); // PR of another branch
  assert.equal(no(local(), { prs: [], stale: null }).state, 'attention');
  assert.equal(no(local(), null).state, 'attention');
});

test('flowVerdict /flow-pr: attention names the branch after the grace period, a closed session says so', () => {
  const s = sent('flow-pr', { ahead: 1 });
  const l = local({ ahead: 1 });
  assert.equal(verdict(s, l, 'idle').reason, 'No open pull request for task after /flow-pr');
  assert.equal(verdict(s, l, 'closed').reason, 'No open pull request for task after /flow-pr');
  assert.equal(verdict(sent('flow-pr', { at: NOW - 5000 }), l, 'closed').reason, 'The pi session closed while the command was running');
});

test('flowVerdict /flow-pr: an unknown session gets 15 minutes, then it is attention', () => {
  const l = local({ ahead: 1 });
  assert.equal(verdict(sent('flow-pr', { at: NOW - 14 * 60_000 }), l, 'unknown').state, 'running');
  const late = verdict(sent('flow-pr', { at: NOW - 16 * 60_000 }), l, 'unknown');
  assert.equal(late.state, 'attention');
  assert.match(late.reason, /15 minutes after \/flow-pr/);
});

// ---------- /flow-base and /flow-base --stash ----------
test('flowVerdict /flow-base: running while busy; ok on a clean, up-to-date base branch', () => {
  const s = sent('flow-base', { branch: 'task' });
  const onBase = local({ branch: 'main', upstream: 'origin/main' });
  assert.deepEqual([verdict(s, local(), 'busy').state, verdict(s, local(), 'busy').label], ['running', 'updating base branch…']);
  assert.equal(verdict(s, onBase, 'idle').state, 'ok');
  assert.equal(verdict(sent('flow-base', { branch: 'task', files: 2 }), local({ ...onBase, files: [file] }), 'idle').state, 'attention'); // plain variant needs a clean tree when it was dirty when sent (RP34: new work after a clean send is fine)
  assert.equal(verdict(s, local({ ...onBase, behind: 2 }), 'idle').state, 'attention');
  assert.equal(verdict(s, local({ ...onBase, ahead: 1 }), 'idle').state, 'attention');
});

test('flowVerdict /flow-base: attention "Still on <branch>" after the grace period, running before it', () => {
  const s = sent('flow-base', { branch: 'task' });
  assert.equal(verdict(s, local(), 'idle').reason, 'Still on task after /flow-base');
  assert.equal(verdict(sent('flow-base', { at: NOW - 5000 }), local(), 'idle').state, 'running');
  assert.equal(verdict(s, local(), 'closed').reason, 'Still on task after /flow-base');
  assert.equal(verdict(sent('flow-base', { at: NOW - 5000 }), local(), 'closed').reason, 'The pi session closed while the command was running');
  assert.equal(verdict(s, local({ branch: 'other' }), 'idle').state, 'attention'); // moved, but not onto a clean up-to-date base
  assert.equal(verdict(sent('flow-base', { at: NOW - 16 * 60_000 }), local(), 'unknown').state, 'attention');
});

test('flowVerdict /flow-base --stash: the carried files stay dirty and it is still ok', () => {
  const s = sent('flow-base-stash', { branch: 'task', files: 1 });
  const onBase = local({ branch: 'main', upstream: 'origin/main', files: [file] });
  assert.equal(verdict(s, onBase, 'idle').state, 'ok');
  assert.equal(verdict(s, local({ ...onBase, behind: 1 }), 'idle').state, 'attention');
  assert.equal(verdict(s, local({ files: [file] }), 'idle').reason, 'Still on task after /flow-base --stash');
  assert.equal(verdict(s, local(), 'busy').label, 'updating base branch…');
});

// ---------- fix-pr and put-in-conditions: no Git verdict ----------
test('flowVerdict fix-pr and put-in-conditions: running while busy, no verdict once the session is idle', () => {
  for (const [cmd, label] of [['fix-pr', 'fixing pull request…'], ['put-in-conditions', 'putting repo in conditions…']]) {
    const s = sent(cmd);
    const busy = verdict(s, local(), 'busy');
    assert.deepEqual([busy.state, busy.label], ['running', label], cmd);
    assert.equal(verdict(sent(cmd, { at: NOW - 5000 }), local(), 'idle').state, 'running', `${cmd} grace`);
    assert.equal(verdict(s, local(), 'idle'), null, `${cmd} idle`);
    assert.equal(verdict({ ...sent(cmd, { at: NOW - 5000 }), busySeen: true }, local(), 'idle'), null, `${cmd} idle after busy`);
    assert.equal(verdict(s, local({ files: [file] }), 'idle'), null, `${cmd} dirty or not, no verdict`);
    assert.equal(verdict(sent(cmd, { at: NOW - 5000 }), local(), 'closed').reason, 'The pi session closed while the command was running');
    assert.equal(verdict(sent(cmd, { at: NOW - 16 * 60_000 }), local(), 'unknown').state, 'attention');
  }
});

test('flowVerdict: a session seen busy and now idle skips the grace period for the commands without a commit verdict', () => {
  const s = { ...sent('flow-pr', { at: NOW - 5000, ahead: 1 }), busySeen: true };
  assert.equal(verdict(s, local({ ahead: 1 }), 'idle').state, 'attention');
  assert.equal(verdict(s, local(), 'idle', { prs: [openPr()], stale: null }).state, 'ok');
});

// ---------- flowButtons: running ----------
const dirty = local({ files: [file] });
const none = { prs: [], stale: null };
const running = (cmd, label) => ({ running: { cmd, label } });

test('flowButtons with ctx.running: the same buttons come back disabled with a reason naming the running command', () => {
  const plain = flowButtons(dirty, none, null, {});
  const during = flowButtons(dirty, none, null, running('flow-commit', 'committing…'));
  assert.deepEqual(during.map((b) => [b.cmd, b.label]), plain.map((b) => [b.cmd, b.label]));
  assert.equal(during.every((b) => b.disabled === true), true);
  assert.equal(during[0].reason, 'Running /flow-commit (committing…): wait for it to finish');
  const pr = flowButtons(local({ ahead: 1 }), none, null, running('flow-pr', 'creating pull request…'));
  assert.deepEqual(pr.map((b) => [b.cmd, b.label, b.disabled]), [['flow-pr', '/flow-pr', true]]);
  assert.match(pr[0].reason, /^Running \/flow-pr \(creating pull request…\)/);
  const stale = flowButtons(local({ currentGone: true }), { prs: [], stale: { via: 'merged', pr: 7 } }, null, running('flow-base', 'updating base branch…'));
  assert.deepEqual(stale.map((b) => [b.cmd, b.disabled]), [['flow-base', true]]);
  assert.match(flowButtons(dirty, none, null, running('fix-pr', 'fixing pull request…'))[0].reason, /^Running the fix order \(fixing pull request…\)/);
  assert.match(flowButtons(dirty, none, null, running('put-in-conditions', 'putting repo in conditions…'))[0].reason, /^Running the put-in-conditions order/);
});

test('flowButtons: without ctx.running the buttons carry no disabled flag, and a bare running verdict still hides them', () => {
  for (const b of flowButtons(dirty, none, null, {})) assert.equal('disabled' in b, false);
  assert.deepEqual(flowButtons(local({ ahead: 1 }), none, null, { verdict: 'running' }), []);
  assert.deepEqual(flowButtons(local(), { prs: [], stale: { via: 'merged', pr: 7 } }, null, { verdict: 'running' }), []);
  assert.deepEqual(flowButtons(dirty, none, null, running('flow-pr', 'x')).map((b) => b.cmd), ['flow-commit']);
});

test('flowButtons: nothing to disable when the card has no button or needs manual action', () => {
  assert.deepEqual(flowButtons(local(), none, null, running('flow-pr', 'creating pull request…')), []);
  assert.deepEqual(flowButtons(local({ files: [file], inProgress: 'rebase' }), none, null, running('flow-commit', 'committing…')), []);
});

// ---------- flowButtons: staged files ----------
test('flowButtons: staged files replace /flow-commit with /flow-commit --unstage, with a reason', () => {
  const staged = local({ files: [file], stagedCount: 2, stagedPaths: ['a', 'b'] });
  const b = flowButtons(staged, none, null, {});
  assert.deepEqual(b.map((x) => [x.cmd, x.label]), [['flow-commit-unstage', '/flow-commit --unstage']]);
  assert.match(b[0].reason, /empty index/);
  assert.deepEqual(flowButtons(dirty, none, null, {}).map((x) => x.cmd), ['flow-commit']); // nothing staged: as before
  assert.deepEqual(flowButtons(local({ files: [file], stagedCount: undefined }), none, null, {}).map((x) => x.cmd), ['flow-commit']);
});

test('flowButtons: staged files do not touch clean or ahead repos, a stale repo, a hidden or a manual-action card', () => {
  assert.deepEqual(flowButtons(local({ ahead: 1, stagedCount: 1 }), none, null, {}).map((x) => x.cmd), ['flow-pr']);
  assert.deepEqual(flowButtons(local({ files: [file], stagedCount: 1, currentGone: true }), { prs: [], stale: { via: 'merged', pr: 7 } }, null, {}).map((x) => x.cmd), ['flow-base-stash']);
  assert.deepEqual(flowButtons(local({ files: [file], stagedCount: 1, inProgress: 'merge' }), none, null, {}), []); // manual action wins
  const needsInput = { available: true, state: 'needs-input', next: 'x', at: new Date().toISOString(), head: 'h1' };
  assert.deepEqual(flowButtons(local({ files: [file], stagedCount: 1 }), none, needsInput, {}), []); // gating still hides it
  assert.deepEqual(flowButtons(local({ files: [file], stagedCount: 1 }), none, needsInput, { override: true }).map((x) => x.cmd), ['flow-commit-unstage']);
});

test('flowButtons: ctx.retry labels the commit button "Retry …" and nothing else', () => {
  assert.deepEqual(flowButtons(dirty, none, null, { retry: true }).map((x) => x.label), ['Retry /flow-commit']);
  const staged = local({ files: [file], stagedCount: 1, stagedPaths: ['a'] });
  assert.deepEqual(flowButtons(staged, none, null, { retry: true }).map((x) => x.label), ['Retry /flow-commit --unstage']);
  assert.deepEqual(flowButtons(local({ ahead: 1 }), none, null, { retry: true }).map((x) => x.label), ['/flow-pr']);
  assert.deepEqual(flowButtons(dirty, none, null, {}).map((x) => x.label), ['/flow-commit']);
});

test('localPlacement: a card keeps its column while any command verdict runs or needs attention', () => {
  assert.deepEqual(localPlacement(local({ ahead: 1 }), none, 0, 'running'), { column: 'committed', attn: false, row: false });
  assert.deepEqual(localPlacement(local({ ahead: 1 }), none, 0, 'attention'), { column: 'committed', attn: true, row: false });
});
