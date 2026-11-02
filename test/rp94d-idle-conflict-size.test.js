'use strict';
// RP94 part d (S9): three more useful chips on the Summary card, each shown only when there is something to say. How long uncommitted work has sat untouched (the server
// already sends `lastChangeMs`, the newest edit among the changed files: it says "last touched", not "since when"), a merge conflict of an open PR (it already sends
// `mergeStateStatus`, DIRTY means a conflict with the base), and a LARGE PR (400 changed lines or more, the same ceiling this project uses for its own PRs). Only the size is
// new data: three ADDITIVE, optional fields of every PR (`additions`, `deletions`, `changedFiles`), null when GitHub does not say. Work is not touched. How it LOOKS is for the
// person to approve by looking; these tests pin the rules, the thresholds and the data. No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.UTC(2026, 4, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// ---------- the server: three additive fields ----------
const RAW = { number: 5, title: 't', url: 'u', headRefName: 'h', baseRefName: 'main', headRefOid: 'abc', mergeStateStatus: 'CLEAN', statusCheckRollup: [] };

test('d1: enrichPr passes the size of the PR as numbers, and keeps every field it had', () => {
  const pr = lib.enrichPr({ ...RAW, additions: 120, deletions: 30, changedFiles: 8 });
  assert.equal(pr.additions, 120);
  assert.equal(pr.deletions, 30);
  assert.equal(pr.changedFiles, 8);
  for (const k of ['number', 'title', 'url', 'head', 'base', 'headOid', 'isDraft', 'isCrossRepository', 'author', 'reviewDecision', 'mergeStateStatus', 'checks', 'ready', 'blockedReason']) assert.ok(k in pr, k);
});

test('d2: when GitHub does not say (missing, null, a string, a negative number, NaN) the field is null, never a made-up number', () => {
  for (const bad of [undefined, null, 'x', -3, NaN, Infinity, {}]) {
    const pr = lib.enrichPr({ ...RAW, additions: bad, deletions: bad, changedFiles: bad });
    assert.deepEqual([pr.additions, pr.deletions, pr.changedFiles], [null, null, null], String(bad));
  }
  const none = lib.enrichPr(RAW);
  assert.deepEqual([none.additions, none.deletions, none.changedFiles], [null, null, null]);
  assert.equal(lib.enrichPr({ ...RAW, additions: 7.9 }).additions, 7, 'a fraction is cut');
});

test('d3: the three fields are asked of GitHub for the PR list and for one PR (the list of fields has them)', () => {
  const src = read('server/github.js');
  const fields = /const PR_FIELDS = \[([\s\S]*?)\]\.join/.exec(src)[1];
  for (const f of ['additions', 'deletions', 'changedFiles']) assert.match(fields, new RegExp(`'${f}'`), f);
  for (const f of ['number', 'mergeStateStatus', 'statusCheckRollup']) assert.match(fields, new RegExp(`'${f}'`), `${f} is still asked`);
});

// ---------- pure: how long the changes have sat ----------
test('i1: with changes older than a day the chip says how many days ago the last edit was; gray under a week, yellow from a week', () => {
  assert.equal(V.idleChip(NOW - 3 * DAY, NOW), '<span class="chip gray" title="Newest uncommitted change: 2026-05-07 12:00 UTC">⏳ edited 3 d ago</span>');
  assert.match(V.idleChip(NOW - 6 * DAY - 23 * HOUR, NOW), /^<span class="chip gray"[^>]*>⏳ edited 6 d ago<\/span>$/);
  assert.match(V.idleChip(NOW - 7 * DAY, NOW), /^<span class="chip yellow"[^>]*>⏳ edited 7 d ago<\/span>$/);
  assert.match(V.idleChip(NOW - 40 * DAY, NOW), />⏳ edited 40 d ago</);
});

test('i2: under a day (24 h exactly counts as one day) there is nothing to say; a future date, a missing date or a non-number draws nothing', () => {
  assert.equal(V.idleChip(NOW - 24 * HOUR + 1, NOW), '');
  assert.match(V.idleChip(NOW - 24 * HOUR, NOW), />⏳ edited 1 d ago</);
  for (const bad of [NOW + HOUR, NOW, null, undefined, 'x', NaN, Infinity, {}]) assert.equal(V.idleChip(bad, NOW), '', String(bad));
});

// ---------- pure: a merge conflict ----------
const pr = (number, o = {}) => ({ number, title: `title ${number}`, mergeStateStatus: 'CLEAN', checks: { state: 'success', passed: 5, total: 5 }, additions: null, deletions: null, changedFiles: null, ...o });

test('x1: an open PR with a conflict (DIRTY) is a red chip with its number; several make one chip with every number', () => {
  assert.equal(V.conflictChip([pr(12, { mergeStateStatus: 'DIRTY' })]), '<span class="chip red" title="Merge conflicts with the base branch">✘ merge conflict #12</span>');
  assert.match(V.conflictChip([pr(12, { mergeStateStatus: 'DIRTY' }), pr(13), pr(9, { mergeStateStatus: 'DIRTY' })]), />✘ merge conflict #12, #9</);
});

test('x2: any other merge state says nothing here (behind and blocked are not conflicts; the board card tells them), and so do no PRs or odd input', () => {
  for (const s of ['CLEAN', 'BEHIND', 'BLOCKED', 'UNKNOWN', 'UNSTABLE', 'HAS_HOOKS', undefined, null]) assert.equal(V.conflictChip([pr(1, { mergeStateStatus: s })]), '', String(s));
  for (const bad of [[], null, undefined, 5, 'x', {}, [null, 5, 'x', {}], [{ number: 'x', mergeStateStatus: 'DIRTY' }]]) assert.equal(V.conflictChip(bad), '', JSON.stringify(bad));
});

// ---------- pure: a large PR ----------
test('z1: a PR of 400 changed lines or more is a yellow "large PR" chip with its number and its lines; 399 is not', () => {
  assert.equal(V.sizeChip([pr(12, { additions: 300, deletions: 100, changedFiles: 9 })]), '<span class="chip yellow" title="#12 title 12 — +300 −100 · 9 files">large PR #12 · +300 −100</span>');
  assert.equal(V.sizeChip([pr(12, { additions: 300, deletions: 99 })]), '');
  assert.match(V.sizeChip([pr(12, { additions: 400, deletions: 0 })]), />large PR #12 · \+400 −0</);
});

test('z2: with several PRs it names the largest one only; a PR whose size GitHub did not say is never large', () => {
  const h = V.sizeChip([pr(1, { additions: 500, deletions: 0 }), pr(2, { additions: 900, deletions: 100 }), pr(3)]);
  assert.match(h, />large PR #2 · \+900 −100</);
  assert.equal(V.sizeChip([pr(3), pr(4, { additions: null, deletions: 900 })]), '', 'half a size is not a size');
});

test('z3: it is total and escapes: no PRs or odd input draw nothing, and a title is escaped in the tooltip', () => {
  for (const bad of [[], null, undefined, 5, 'x', {}, [null, 5, 'x', {}]]) assert.equal(V.sizeChip(bad), '', JSON.stringify(bad));
  assert.match(V.sizeChip([pr(9, { title: 'a"b<c', additions: 500, deletions: 0 })]), /title="#9 a&quot;b&lt;c — \+500 −0"/);
});

test('z4: the PR chip tooltip adds the size of each PR when GitHub said it, and is exactly as before when it did not', () => {
  assert.match(V.prChip([pr(12, { additions: 120, deletions: 30, changedFiles: 8 })]), /title="#12 title 12 — ✔ 5\/5 checks · \+120 −30 · 8 files"/);
  assert.match(V.prChip([pr(12, { additions: 120, deletions: 30 })]), /title="#12 title 12 — ✔ 5\/5 checks · \+120 −30"/);
  assert.match(V.prChip([pr(12)]), /title="#12 title 12 — ✔ 5\/5 checks"/);
});

// ---------- the Summary card ----------
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'b', needs: false, rank: 9,
  progress: { total: 12, completada: 5, enRevision: 0, bloqueada: 0, pendiente: 7, enCurso: 0 }, next: null, blocking: [],
  lastMovement: {}, session: { state: 'free' }, action: null, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [], changesFor: () => null, ...ctx });
const cardOf = (html) => /<article class="rs-card[\s\S]*?<\/article>/.exec(html)[0];
const chipsOf = (html) => (/<span class="rs-chips">([\s\S]*?)<\/span><span class="rs-spacer">/.exec(cardOf(html)) || [])[1] || '';
const CH = { files: 2, added: 5, deleted: 1, ahead: 0, behind: 0, noUpstream: false };

test('k1: the card shows the chips in this order: the change chips, how long they have sat, the PR, its conflict, its size, and the manual action last', () => {
  const html = view([row({ action: { kind: 'manual', label: 'x' } })], {
    changesFor: () => CH, idleFor: () => NOW - 3 * DAY,
    prsFor: () => [pr(12, { mergeStateStatus: 'DIRTY', additions: 900, deletions: 100 })],
  });
  const c = chipsOf(html);
  const order = ['chip yellow chip-btn', 'edited 3 d ago', 'PR #12', 'merge conflict #12', 'large PR #12', 'manual action'].map((s) => c.indexOf(s));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('k2: with nothing to say the card has none of them, and a page that gives no idle time or PRs does not fail', () => {
  assert.doesNotMatch(view([row()]), /edited|merge conflict|large PR|PR #/);
  assert.doesNotMatch(view([row()], { changesFor: () => CH, idleFor: () => NOW - HOUR, prsFor: () => [pr(1, { additions: 10, deletions: 10 })] }), /edited|merge conflict|large PR/);
});

test('k3: an errored row shows none of the new chips', () => {
  const html = view([row({ error: 'git failed' })], { idleFor: () => NOW - 9 * DAY, prsFor: () => [pr(1, { mergeStateStatus: 'DIRTY', additions: 999, deletions: 9 })] });
  assert.doesNotMatch(html, /edited|merge conflict|large PR/);
});

test('k4: the idle chip uses the clock the page gives (never the real one)', () => {
  assert.match(view([row()], { idleFor: () => NOW - 2 * DAY, now: NOW }), />⏳ edited 2 d ago</);
  assert.match(view([row()], { idleFor: () => NOW - 2 * DAY, now: NOW + 5 * DAY }), />⏳ edited 7 d ago</);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('public/app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';

test('g1: the page gives the time of the newest uncommitted change only for a repo that HAS uncommitted changes', () => {
  const page = loadPage();
  page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }];`);
  assert.equal(page.run('summaryIdle("abc")'), null, 'not loaded');
  page.run("S.local.abc = { branch: 'main', files: [], ahead: 0, behind: 0, lastChangeMs: 1234 };");
  assert.equal(page.run('summaryIdle("abc")'), null, 'a clean repo has nothing sitting');
  page.run("S.local.abc = { branch: 'main', files: [{ path: 'a', status: 'M' }], ahead: 0, behind: 0, lastChangeMs: 1234 };");
  assert.equal(page.run('summaryIdle("abc")'), 1234);
  page.run("S.local.abc = { branch: 'main', files: [{ path: 'a', status: 'M' }], ahead: 0, behind: 0 };");
  assert.equal(page.run('summaryIdle("abc")'), null, 'no time reported');
  assert.match(read('public/app.js'), /idleFor: summaryIdle/);
});
