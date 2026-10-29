'use strict';
// RP24 (S21): the /flow-commit button cannot be pressed by accident while the agent is still working.
// A: a declared `working` survives repo activity. B: a busy or asking pi session disables the commit pair.
// B2: files changed a few seconds ago disable it. All through the public pure helpers of view.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const view = require('../public/view.js');

const { commitAllowed, commitOverrideItem, stateLine, flowButtons, queueFlags, piPollTargets } = view;

const NOW = Date.parse('2026-10-25T12:00:00Z');
const file = { path: 'a.txt', status: 'M', untracked: false };
const dirty = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], head: 'b'.repeat(40), inProgress: null, base: 'main', stagedCount: 0, ...o });
const prs = (o = {}) => ({ prs: [], stale: null, ...o });
const declared = (state, o = {}) => ({ available: true, state, next: 'keep going', detail: null, at: new Date(NOW - 60000).toISOString(), stale: false, reason: null, ...o });
const ctx = (o = {}) => ({ now: NOW, ...o });
const cmds = (list) => list.map((b) => b.cmd);

// ---- A: working is not invalidated by activity ----

test('A: a stale working state still blocks /flow-commit and still shows as the current line', () => {
  const st = declared('working', { stale: true });
  assert.equal(commitAllowed(st, { now: NOW }), false);
  assert.deepEqual(flowButtons(dirty(), prs(), st, ctx()), []);
  const line = stateLine(st, { now: NOW });
  assert.equal(line.kind, 'current');
  assert.equal(line.dot, 'yellow');
  assert.equal(line.text, 'keep going');
});

test('A: a stale working state is still ended by the 30-minute expiry counted from its own `at`', () => {
  const old = declared('working', { stale: true, at: new Date(NOW - 31 * 60 * 1000).toISOString() });
  assert.equal(commitAllowed(old, { now: NOW }), true);
  assert.equal(stateLine(old, { now: NOW }).kind, 'outdated');
  const edge = declared('working', { stale: true, at: new Date(NOW - 29 * 60 * 1000).toISOString() });
  assert.equal(commitAllowed(edge, { now: NOW }), false);
});

test('A: a stale ready-to-commit, needs-input, ready-to-pr and blocked are still ignored (today behavior)', () => {
  for (const s of ['ready-to-commit', 'needs-input', 'ready-to-pr', 'blocked']) {
    const st = declared(s, { stale: true });
    assert.equal(commitAllowed(st, { now: NOW }), true, s);
    const line = stateLine(st, { now: NOW });
    assert.equal(line.kind, 'outdated', s);
    assert.equal(line.dot, 'gray', s);
    assert.equal(line.text, '', s);
    assert.match(line.title, /outdated/, s);
  }
});

test('A: the override lifts a stale working gating and the menu item offers it; the work queue agrees', () => {
  const st = declared('working', { stale: true });
  assert.deepEqual(commitOverrideItem(st, { now: NOW }), { act: 'show-commit', label: 'Show /flow-commit anyway' });
  assert.equal(commitOverrideItem(st, { now: NOW, override: true }), null);
  assert.deepEqual(cmds(flowButtons(dirty(), prs(), st, ctx({ override: true }))), ['flow-commit']);
  assert.deepEqual(queueFlags(dirty(), st, null, { now: NOW }), {});
  assert.equal(commitAllowed(declared('working', { stale: false }), { now: NOW }), false);
});

// ---- B: a live pi session ----

test('B: a busy session shows the commit button disabled with the reason; asking has its own reason', () => {
  const busy = flowButtons(dirty(), prs(), null, ctx({ session: 'busy' }));
  assert.deepEqual(busy, [{ cmd: 'flow-commit', label: '/flow-commit', disabled: true, reason: 'the session is still working' }]);
  const asking = flowButtons(dirty(), prs(), null, ctx({ session: 'asking' }));
  assert.deepEqual(asking, [{ cmd: 'flow-commit', label: '/flow-commit', disabled: true, reason: 'waiting for your answer in the session' }]);
});

test('B: the --unstage variant is disabled the same way, keeping its label', () => {
  const out = flowButtons(dirty({ stagedCount: 2 }), prs(), null, ctx({ session: 'busy' }));
  assert.deepEqual(out, [{ cmd: 'flow-commit-unstage', label: '/flow-commit --unstage', disabled: true, reason: 'the session is still working' }]);
});

test('B: idle, closed, ambiguous, unknown, undefined and null never block (fail open)', () => {
  for (const session of ['idle', 'closed', 'ambiguous', 'unknown', undefined, null, 'nonsense']) {
    const out = flowButtons(dirty(), prs(), null, ctx({ session }));
    assert.deepEqual(out, [{ cmd: 'flow-commit', label: '/flow-commit' }], String(session));
  }
});

test('B: the button enables itself again when the session is no longer busy', () => {
  assert.equal(flowButtons(dirty(), prs(), null, ctx({ session: 'busy' }))[0].disabled, true);
  assert.equal(flowButtons(dirty(), prs(), null, ctx({ session: 'idle' }))[0].disabled, undefined);
});

test('B: the override lifts the session gating and the menu offers the override while the session blocks', () => {
  assert.deepEqual(flowButtons(dirty(), prs(), null, ctx({ session: 'busy', override: true })), [{ cmd: 'flow-commit', label: '/flow-commit' }]);
  const item = { act: 'show-commit', label: 'Show /flow-commit anyway' };
  assert.deepEqual(commitOverrideItem(null, { now: NOW, session: 'busy' }), item);
  assert.deepEqual(commitOverrideItem(null, { now: NOW, session: 'asking' }), item);
  assert.equal(commitOverrideItem(null, { now: NOW, session: 'idle' }), null);
  assert.equal(commitOverrideItem(null, { now: NOW, session: 'busy', override: true }), null);
  assert.equal(commitOverrideItem(null, { now: NOW, session: 'busy', stale: true }), null);
});

test('B: it only touches the commit pair: a clean card, a stale card and the PR and base buttons are unaffected', () => {
  const clean = { ...dirty(), files: [], ahead: 1 };
  assert.deepEqual(flowButtons(clean, prs(), null, ctx({ session: 'busy' })), [{ cmd: 'flow-pr', label: '/flow-pr' }]);
  const merged = { via: 'merged', pr: 7, reason: 'Merged: run /flow-base' };
  assert.deepEqual(cmds(flowButtons({ ...clean, ahead: 0 }, prs({ stale: merged }), null, ctx({ session: 'busy' }))), ['flow-base']);
  const stash = flowButtons(dirty(), prs({ stale: merged }), null, ctx({ session: 'busy' }));
  assert.deepEqual(cmds(stash), ['flow-base-stash']);
  assert.equal(stash[0].disabled, undefined);
  assert.deepEqual(flowButtons(dirty({ inProgress: 'rebase' }), prs(), null, ctx({ session: 'busy' })), []);
  assert.deepEqual(flowButtons({ error: 'x' }, prs(), null, ctx({ session: 'busy' })), []);
});

test('B: a running command of the panel keeps its own reason over the session reason', () => {
  const out = flowButtons(dirty(), prs(), null, ctx({ session: 'busy', running: { cmd: 'flow-commit', label: 'committing…' } }));
  assert.equal(out.length, 1);
  assert.equal(out[0].disabled, true);
  assert.match(out[0].reason, /^Running \/flow-commit/);
});

test('B: a state that hides the button still hides it (no disabled button for a not-ready state)', () => {
  assert.deepEqual(flowButtons(dirty(), prs(), declared('needs-input'), ctx({ session: 'busy' })), []);
});

test('B: piPollTargets polls dirty repos with no command in flight, never clean ones or hidden tabs', () => {
  const local = { a: dirty(), b: { ...dirty(), files: [] }, c: dirty(), d: { error: 'x' }, e: undefined };
  const base = { ids: ['a', 'b', 'c', 'd', 'e', 'f'], local, sent: {}, hidden: false };
  assert.deepEqual(piPollTargets(base), ['a', 'c']);
  assert.deepEqual(piPollTargets({ ...base, sent: { c: { cmd: 'flow-commit' } } }), ['a']);
  assert.deepEqual(piPollTargets({ ...base, hidden: true }), []);
  assert.deepEqual(piPollTargets({ ids: [], local: {}, sent: {}, hidden: false }), []);
  assert.deepEqual(piPollTargets({ ids: ['a'], local: {}, hidden: false }), []);
});

// ---- B2: quiet period ----

test('B2: the quiet period is exactly 20 seconds and a missing or non-finite value never blocks', () => {
  assert.equal(view.QUIET_MS, 20000);
  const at = (ago) => ({ lastChangeMs: NOW - ago });
  const reasonOf = (l) => { const b = flowButtons(dirty(l), prs(), null, ctx())[0]; return b.disabled ? b.reason : null; };
  assert.equal(reasonOf(at(0)), 'files changed a few seconds ago');
  assert.equal(reasonOf(at(19999)), 'files changed a few seconds ago');
  assert.equal(reasonOf(at(20000)), null);
  assert.equal(reasonOf(at(60000)), null);
  for (const v of [null, undefined, NaN, Infinity, 'x']) assert.equal(reasonOf({ lastChangeMs: v }), null, String(v));
  assert.equal(reasonOf({}), null);
});

test('B2: a time far in the future (clock skew) does not hold the button forever', () => {
  const b = flowButtons(dirty({ lastChangeMs: NOW + 3_600_000 }), prs(), null, ctx())[0];
  assert.equal(b.disabled, undefined);
});

test('B2: the quiet period disables the --unstage variant too, the override lifts it, and a busy session reason wins', () => {
  const l = dirty({ stagedCount: 1, lastChangeMs: NOW - 1000 });
  assert.deepEqual(flowButtons(l, prs(), null, ctx()), [{ cmd: 'flow-commit-unstage', label: '/flow-commit --unstage', disabled: true, reason: 'files changed a few seconds ago' }]);
  assert.deepEqual(flowButtons(l, prs(), null, ctx({ override: true })), [{ cmd: 'flow-commit-unstage', label: '/flow-commit --unstage', reason: view.flowButtons(dirty({ stagedCount: 1 }), prs(), null, ctx())[0].reason }]);
  assert.equal(flowButtons(l, prs(), null, ctx({ session: 'busy' }))[0].reason, 'the session is still working');
});

test('B2: the quiet period alone does not put the "Show /flow-commit anyway" item in the menu', () => {
  assert.equal(commitOverrideItem(null, { now: NOW }), null);
});

test('B2: the API changed, so API_VERSION is 15', () => {
  assert.equal(view.API_VERSION, 15);
});

// ---- C: the estado block text ----

test('C: the estado block tells the agent to keep working while a background job runs, and keeps its version', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'requirements', 'blocks', 'estado.md'), 'utf8');
  assert.match(text, /^<!-- panel:estado v1\.0 -->/);
  assert.match(text, /segundo plano/);
  assert.match(text, /- `working`:[^\n]*segundo plano/);
});
