'use strict';
// RP138 (S27): the /flow-next button of the repo card, of the chat and of the "Go work on" strip was hidden by ANY open pull request, also by the one that release-please keeps open for weeks
// (`chore(main): release 0.2.0`), which is nobody's task. Now only an open pull request that belongs to a unit of the roadmap holds the start back: its unit id is a whole token of its title or of
// its head branch, the same rule `deriveUnitStates` uses for "En revisión". With no usable roadmap every pull request counts, as before. The rule lives ONCE in view.js (shared by the server and
// the page) and `lib.matchesUnitId` is that same function. The card, the chat buttons and the strip read the one fact: the card is built by the server, the strip by the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const lib = require('../lib.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const { summarize } = require('../server/summary.js');
const { appSource } = require('./pagesrc.js');

const unit = (id, estado, extra = {}) => ({ id, entrega: `deliver ${id}`, resultadoVisible: `see ${id}`, dependsOn: [], externalDeps: [], estado, ...extra });
const RELEASE = { number: 133, title: 'chore(main): release 0.2.0', head: 'release-please--branches--main--components--repo-panel', ready: false };
const ROWS = [unit('RP131', 'Completada'), unit('RP132', 'Completada'), unit('RP133', 'Pendiente'), unit('RP134', 'Pendiente', { dependsOn: ['RP133'] })];
const pr = (number, title, head) => ({ number, title, head, ready: false });

// ---------- the rule ----------
test('t1: only an open pull request that belongs to a unit holds the start back: the unit id is a whole token of the title or of the head branch, in any case', () => {
  assert.deepEqual(V.taskPrs([RELEASE], ROWS), [], 'the release pull request is nobody\'s task');
  const byHead = pr(7, 'Move the explorer', 'feat/rp133-addresses');
  const byTitle = pr(8, 'feat(summary): one address per screen (RP133)', 'wip');
  const byCase = pr(9, 'x', 'FIX/Rp134-things');
  assert.deepEqual(V.taskPrs([RELEASE, byHead, byTitle, byCase], ROWS).map((p) => p.number), [7, 8, 9]);
  assert.deepEqual(V.taskPrs([pr(1, 'x', 'feat/rp13-a'), pr(2, 'x', 'feat/rp1330-a'), pr(3, 'RP13', 'a')], ROWS), [], 'a unit id is a whole token: RP13 and RP1330 are not RP133');
  assert.deepEqual(V.taskPrs([pr(4, 'x', 'dependabot/npm_and_yarn/lodash-4.17.21')], ROWS), []);
});

test('t2: with no usable roadmap every pull request counts, as before; malformed input never throws and the answer is always a new array', () => {
  const list = [RELEASE, pr(7, 'x', 'feat/y')];
  for (const rows of [null, undefined, [], 'rows', 5, {}, [null, 3, {}, { id: '' }, { id: 7 }]]) {
    const got = V.taskPrs(list, rows);
    assert.deepEqual(got.map((p) => p.number), [133, 7], JSON.stringify(rows));
    assert.notEqual(got, list, 'a copy');
  }
  for (const prs of [null, undefined, 'x', 5, {}, [null, 7, 'a', {}, { number: 1 }]]) {
    assert.doesNotThrow(() => V.taskPrs(prs, ROWS), JSON.stringify(prs));
    assert.ok(Array.isArray(V.taskPrs(prs, ROWS)));
  }
  assert.deepEqual(V.taskPrs([{ number: 1 }, { number: 2, title: 7, head: null }], ROWS), []);
  const frozen = Object.freeze([Object.freeze({ ...RELEASE })]);
  assert.doesNotThrow(() => V.taskPrs(frozen, Object.freeze(ROWS)));
});

test('t3: the matching rule is ONE function: the one view.js has is the one lib.js exports and deriveUnitStates uses', () => {
  assert.equal(typeof V.matchesUnitId, 'function');
  assert.equal(lib.matchesUnitId, V.matchesUnitId);
  assert.equal(V.matchesUnitId('feat/p2.1-x', 'p2'), false);
  assert.equal(V.matchesUnitId('feat/p2-x', 'P2'), true);
  assert.equal(V.matchesUnitId('', 'p2'), false);
  assert.equal(V.matchesUnitId('p2', ''), false);
  // the same rule decides "En revisión"
  assert.equal(lib.deriveUnitStates(ROWS, { prs: [pr(7, 'x', 'feat/rp133-a')] }).RP133.state, 'En revisión');
  assert.deepEqual(lib.deriveUnitStates(ROWS, { prs: [RELEASE] }), {});
});

// ---------- the card (built by the server) ----------
const facts = (prs, roadmap) => ({
  repo: { id: 'r1', name: 'repo-one', group: 'G', room: null },
  local: { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main' },
  prs: { prs, stale: null },
  roadmap,
  state: { available: false },
  session: 'closed',
  last: { at: '2026-10-28T10:00:00Z', what: 'a subject' },
  now: Date.parse('2026-10-28T12:00:00Z'),
});
const roadmap = (rows, next) => ({ available: true, rows, derived: {}, next });
const NEXT = ROWS[2];

test('s1: the card offers /flow-next when the only open pull request is the release one; a pull request of a unit still holds it back; no pull request offers it as before', () => {
  assert.equal(summarize(facts([], roadmap(ROWS, NEXT))).action.kind, 'start', 'before: no pull request');
  assert.equal(summarize(facts([RELEASE], roadmap(ROWS, NEXT))).action.kind, 'start', 'the release pull request does not hide it');
  const held = summarize(facts([pr(7, 'Move the explorer', 'feat/rp132-x')], roadmap(ROWS, NEXT)));
  assert.notEqual(held.action && held.action.kind, 'start', 'a unit pull request holds the start back');
  const both = summarize(facts([RELEASE, pr(7, 'x', 'feat/rp132-x')], roadmap(ROWS, NEXT)));
  assert.notEqual(both.action && both.action.kind, 'start', 'the release pull request does not cancel the other one');
});

test('s2: with no usable roadmap the pull requests still count, and a repo with changes or unpushed commits is never told to start (the other conditions of the start hold)', () => {
  const noRm = summarize(facts([RELEASE], { available: false, reason: 'missing' }));
  assert.notEqual(noRm.action && noRm.action.kind, 'start');
  const dirty = facts([RELEASE], roadmap(ROWS, NEXT));
  dirty.local = { ...dirty.local, files: [{ path: 'a', status: 'M' }] };
  assert.notEqual(summarize(dirty).action && summarize(dirty).action.kind, 'start');
  const ahead = facts([RELEASE], roadmap(ROWS, NEXT));
  ahead.local = { ...ahead.local, ahead: 2 };
  assert.notEqual(summarize(ahead).action && summarize(ahead).action.kind, 'start');
});

// ---------- the strip (built by the page) ----------
function element() {
  return { writes: 0, html: '', hidden: false, dataset: {}, style: {}, listeners: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, append() {}, get innerHTML() { return this.html; }, set innerHTML(v) { this.html = String(v); } };
}
function loadPage() {
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
  return { run: (code) => vm.runInContext(code, ctx) };
}
function stripFor(prs, rm) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'a', name: 'alpha', path: 'pa' }] }];
  S.local.a = { branch: 'main', files: [], ahead: 0, behind: 0, base: 'main', head: 'h' };
  S.prs.a = { prs, stale: null, repo: { url: 'u' } };
  S.roadmap.a = rm;
  return page.run('queueItems()');
}
const RM = { available: true, rows: ROWS, derived: {}, next: NEXT, progress: { total: 4, completada: 2, enRevision: 0, bloqueada: 0, pendiente: 2, enCurso: 0 }, summary: { kind: 'next', id: 'RP133', entrega: 'deliver RP133', state: null } };

test('q1: the strip does not count the release pull request as a pending one, and it still counts the pull request of a unit', () => {
  const free = stripFor([RELEASE], RM);
  assert.equal(free.length, 1);
  assert.equal(free[0].hasPrs, false, 'the release pull request does not hold it');
  assert.equal(free[0].next.id, 'RP133');
  assert.equal(free[0].next.entrega, 'deliver RP133');
  assert.equal(stripFor([pr(7, 'x', 'feat/rp132-x')], RM)[0].hasPrs, true);
  assert.equal(stripFor([RELEASE, pr(7, 'x', 'feat/rp132-x')], RM)[0].hasPrs, true);
  assert.equal(stripFor([], RM)[0].hasPrs, false);
});

test('q2: with no roadmap, or one that is not available, the strip counts every pull request as before', () => {
  assert.equal(stripFor([RELEASE], { available: false, reason: 'missing' })[0].hasPrs, true);
  assert.equal(stripFor([RELEASE], null)[0].hasPrs, true);
  assert.equal(stripFor([RELEASE], { available: true, rows: [], derived: {}, next: null })[0].hasPrs, true, 'an empty table is no roadmap to match against');
});

test('q3: the queue asks the server the same question the card answers: a start for the repo with the release pull request only', () => {
  const items = stripFor([RELEASE], RM);
  const [first] = lib.workQueue(items.map((i) => ({ ...i })), []);
  assert.equal(first.kind, 'start');
  assert.equal(first.unit.id, 'RP133');
  const [none] = lib.workQueue(stripFor([pr(7, 'x', 'feat/rp132-x')], RM), []);
  assert.equal(none, undefined, 'a unit pull request: nothing to start');
});
