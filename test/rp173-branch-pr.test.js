'use strict';
// RP173: a pull request also counts as a task PR when its head is the CURRENT local branch (the work this checkout carries and has in review), whatever the roadmap says: under the Level-0
// process the row of the PR's own task is born in the same diff as its work, so the base roadmap does not have it while the PR is open. A pull request of another branch with no unit id
// (dependabot-like, RP138) still does not count. With no branch the behaviour is the one of RP138.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const { summarize } = require('../server/summary.js');
const { appSource } = require('./pagesrc.js');

const unit = (id, estado, extra = {}) => ({ id, entrega: `deliver ${id}`, resultadoVisible: `see ${id}`, dependsOn: [], externalDeps: [], estado, ...extra });
const ROWS = [unit('RP170', 'Completada'), unit('RP171', 'Completada'), unit('RP173', 'Pendiente')];
const pr = (number, title, head) => ({ number, title, head, ready: false, checks: { state: 'pending', total: 4, passed: 0, pending: 4 } });
const BRANCH = 'feat/rp172-merge-then-base';
const OWN = pr(231, 'feat(actions): send /flow-base after a panel merge (RP172)', BRANCH);
const BOT = pr(5, 'chore: bump x', 'dependabot/npm/x');
const nums = (list) => list.map((p) => p.number);

test('b1: the pull request of the current branch counts although no row carries its id (the reproduction)', () => {
  assert.deepEqual(nums(V.taskPrs([OWN], ROWS)), [], 'before: nobody\'s task');
  assert.deepEqual(nums(V.taskPrs([OWN], ROWS, { branch: BRANCH })), [231]);
  assert.deepEqual(nums(V.taskPrs([BOT, OWN], ROWS, { branch: BRANCH })), [231], 'order kept, the other one still out');
});

test('b2: a pull request of another head with no id does not count, with a current branch set (RP138 stays)', () => {
  assert.deepEqual(V.taskPrs([BOT], ROWS, { branch: BRANCH }), []);
  assert.deepEqual(V.taskPrs([BOT], ROWS, { branch: 'main' }), []);
});

test('b3: the head matches whole and case-sensitive, never by substring', () => {
  const short = pr(1, 'x', 'feat/rp172');
  const long = pr(2, 'x', `${BRANCH}-2`);
  const upper = pr(3, 'x', BRANCH.toUpperCase());
  assert.deepEqual(V.taskPrs([short, long, upper], ROWS, { branch: BRANCH }), []);
  assert.deepEqual(V.taskPrs([OWN], ROWS, { branch: 'feat/rp172' }), []);
  assert.deepEqual(V.taskPrs([OWN], ROWS, { branch: `${BRANCH}-2` }), []);
  assert.deepEqual(V.taskPrs([OWN], ROWS, { branch: ` ${BRANCH}` }), []);
  assert.deepEqual(V.taskPrs([OWN], ROWS, { branch: BRANCH.toUpperCase() }), []);
});

test('b4: a pull request whose id matches a row counts as before, with or without a branch', () => {
  const byRow = pr(8, 'x', 'feat/rp173-x');
  assert.deepEqual(nums(V.taskPrs([byRow, BOT], ROWS)), [8]);
  assert.deepEqual(nums(V.taskPrs([byRow, BOT], ROWS, { branch: 'main' })), [8]);
  assert.deepEqual(nums(V.taskPrs([byRow, OWN, BOT], ROWS, { branch: BRANCH })), [8, 231]);
});

test('b5: odd values for the branch change nothing', () => {
  const list = [OWN, BOT, pr(8, 'x', 'feat/rp173-x')];
  const base = nums(V.taskPrs(list, ROWS));
  for (const branch of [null, undefined, 5, {}, '', [], [BRANCH], true, () => BRANCH, 'x'.repeat(100000)]) {
    assert.deepEqual(nums(V.taskPrs(list, ROWS, { branch })), base, String(typeof branch));
  }
  for (const opts of [null, undefined, 'feat', 7, [], {}, BRANCH]) assert.deepEqual(nums(V.taskPrs(list, ROWS, opts)), base, String(opts));
  assert.deepEqual(nums(V.taskPrs([{ ...OWN, head: '' }], ROWS, { branch: '' })), [], 'an empty head never matches an empty branch');
});

test('b6: with no usable roadmap every pull request counts, branch or not; malformed prs are ignored as before', () => {
  for (const rows of [null, [], 'rows']) {
    assert.deepEqual(nums(V.taskPrs([BOT, OWN], rows, { branch: BRANCH })), [5, 231]);
    assert.deepEqual(nums(V.taskPrs([BOT, OWN], rows)), [5, 231]);
  }
  for (const prs of [null, undefined, 'x', 5, {}, [null, 7, 'a', {}, { number: 1 }]]) {
    assert.doesNotThrow(() => V.taskPrs(prs, ROWS, { branch: BRANCH }));
    assert.deepEqual(V.taskPrs(prs, ROWS, { branch: BRANCH }), V.taskPrs(prs, ROWS));
  }
  assert.deepEqual(V.taskPrs([null, 3, { number: 1, head: BRANCH }], ROWS, { branch: BRANCH }).map((p) => p.number), [1]);
});

test('b7: differential: without the third argument the answer is the frozen one of RP138', () => {
  const rows = [unit('RP131', 'Completada'), unit('RP132', 'Completada'), unit('RP133', 'Pendiente'), unit('RP134', 'Pendiente')];
  const release = { number: 133, title: 'chore(main): release 0.2.0', head: 'release-please--branches--main--components--repo-panel' };
  const list = [release, pr(7, 'Move the explorer', 'feat/rp133-addresses'), pr(8, 'one address (RP133)', 'wip'), pr(9, 'x', 'FIX/Rp134-things'), pr(1, 'x', 'feat/rp13-a'), pr(2, 'x', 'feat/rp1330-a'), pr(3, 'RP13', 'a'), pr(4, 'x', 'dependabot/npm_and_yarn/lodash-4.17.21')];
  assert.deepEqual(nums(V.taskPrs(list, rows)), [7, 8, 9]);
  assert.deepEqual(nums(V.taskPrs(list, null)), [133, 7, 8, 9, 1, 2, 3, 4]);
  assert.deepEqual(V.taskPrs([{ number: 1 }, { number: 2, title: 7, head: null }], rows), []);
  assert.deepEqual(nums(V.taskPrs([release], rows)), []);
});

// ---------- the card (built by the server) ----------
const facts = (branch, prs) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null },
  local: { branch, files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs, stale: null },
  roadmap: { available: true, rows: ROWS, derived: {}, next: ROWS[2] },
  state: { available: false },
  session: 'closed',
  last: { at: '2026-10-28T10:00:00Z', what: 'a subject' },
  now: Date.parse('2026-10-28T12:00:00Z'),
});

test('s1: a clean repo whose current branch has an open pull request (checks pending) is not told /flow-next; on main with that pull request open it still is', () => {
  const row = summarize(facts(BRANCH, [OWN]));
  assert.notEqual(row.action && row.action.kind, 'start');
  assert.ok(!/flow-next/.test(String(row.action && row.action.label)), JSON.stringify(row.action));
  assert.equal(summarize(facts('main', [OWN])).action.kind, 'start', 'a different head: today\'s behaviour');
  assert.equal(summarize(facts(BRANCH, [BOT])).action.kind, 'start', 'a bot pull request is still nobody\'s');
  assert.equal(summarize(facts(BRANCH, [])).action.kind, 'start');
});

// ---------- the strip (built by the page) ----------
function element() {
  return { writes: 0, html: '', hidden: false, dataset: {}, style: {}, listeners: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, append() {}, get innerHTML() { return this.html; }, set innerHTML(v) { this.html = String(v); } };
}
function stripFor(branch, prs) {
  const els = {};
  const frames = [];
  const get = (sel) => (els[sel] ||= element());
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], createElement: () => element(), body: element(), addEventListener() {}, activeElement: null },
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true, fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const S = vm.runInContext('S', ctx);
  S.groups = [{ name: 'G', repos: [{ id: 'a', name: 'alpha', path: 'pa' }] }];
  S.local.a = { branch, files: [], ahead: 0, behind: 0, base: 'main', head: 'h' };
  S.prs.a = { prs, stale: null, repo: { url: 'u' } };
  S.roadmap.a = { available: true, rows: ROWS, derived: {}, next: ROWS[2], progress: { total: 3, completada: 2, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, summary: { kind: 'next', id: 'RP173', entrega: 'deliver RP173', state: null } };
  return vm.runInContext('queueItems()', ctx);
}

test('q1: the strip counts the pull request of the current branch, and only on that branch', () => {
  assert.equal(stripFor(BRANCH, [OWN])[0].hasPrs, true);
  assert.equal(stripFor('main', [OWN])[0].hasPrs, false);
  assert.equal(stripFor(BRANCH, [BOT])[0].hasPrs, false);
  assert.equal(stripFor(BRANCH, [])[0].hasPrs, false);
});
