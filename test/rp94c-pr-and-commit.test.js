'use strict';
// RP94 part c (S9): the Summary card shows two useful things that its data already had. The subject of the last commit (the row already carries it as `lastMovement.what`,
// which only the tooltip of the time showed) gets its own small line, and the open pull request gets a chip with the state of its checks. V.prChip(prs) is pure and
// total: no open PR, no chip. State is never colour alone: the chip says the number, a symbol and the counts. Work is not touched (it has its own PR cards). No new
// server data: the page already loads the PRs. How it LOOKS is for the person to approve by looking; these tests pin the structure, the rules and what is shown.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const checks = (state, o = {}) => ({ state, passed: 0, total: 0, failed: 0, pending: 0, items: [], ...o });
const pr = (number, c, o = {}) => ({ number, title: `title ${number}`, checks: c, ...o });
const OK = checks('success', { passed: 5, total: 5 });
const BAD = checks('failed', { passed: 3, total: 5, failed: 2 });
const RUN = checks('pending', { passed: 2, total: 5, pending: 3 });
const NONE = checks('none');

// ---------- pure: the PR chip ----------
test('p1: no open PR (an empty list, nothing, or something that is not a list) draws no chip', () => {
  for (const v of [[], null, undefined, 5, 'x', {}]) assert.equal(V.prChip(v), '', String(v));
});

test('p2: one PR with passing checks is a green chip with the number, a check mark and the counts', () => {
  assert.equal(V.prChip([pr(12, OK)]), '<span class="chip green" title="#12 title 12 — ✔ 5/5 checks">PR #12 ✔ 5/5</span>');
});

test('p3: failing checks are a red chip with a cross and how many failed; running ones are yellow with the dots and how many are running', () => {
  assert.equal(V.prChip([pr(12, BAD)]), '<span class="chip red" title="#12 title 12 — ✘ 2 failed · 3/5 checks">PR #12 ✘ 2 failed</span>');
  assert.equal(V.prChip([pr(12, RUN)]), '<span class="chip yellow" title="#12 title 12 — … 3 running · 2/5 checks">PR #12 … 3 running</span>');
});

test('p4: a PR with no checks is a gray chip that says so (the number is still useful)', () => {
  assert.equal(V.prChip([pr(12, NONE)]), '<span class="chip gray" title="#12 title 12 — no checks">PR #12 · no checks</span>');
  assert.equal(V.prChip([pr(12, undefined)]), '<span class="chip gray" title="#12 title 12 — no checks">PR #12 · no checks</span>', 'a missing checks object reads as none');
});

test('p5: several PRs make ONE chip: the count and the worst state (failed, then running, then passing, then none), and every PR is in the tooltip', () => {
  const h = V.prChip([pr(1, OK), pr(2, BAD), pr(3, RUN)]);
  assert.match(h, /^<span class="chip red" title="/);
  assert.match(h, />3 PRs ✘ 1 failing<\/span>$/);
  assert.ok(h.includes('#1 title 1 — ✔ 5/5 checks') && h.includes('#2 title 2') && h.includes('#3 title 3'));
  assert.match(V.prChip([pr(1, OK), pr(3, RUN)]), /^<span class="chip yellow"[\s\S]*>2 PRs … 1 running<\/span>$/);
  assert.match(V.prChip([pr(1, OK), pr(4, OK)]), /^<span class="chip green"[\s\S]*>2 PRs ✔ all passing<\/span>$/);
  assert.match(V.prChip([pr(1, NONE), pr(4, NONE)]), /^<span class="chip gray"[\s\S]*>2 PRs · no checks<\/span>$/);
});

test('p6: it is total and escapes: odd entries are skipped, numbers that are not numbers do not break it, and titles are escaped in the tooltip', () => {
  assert.equal(V.prChip([null, 5, 'x', {}]), '', 'no entry has a PR number');
  assert.doesNotMatch(V.prChip([pr('x', OK), pr(7, { state: 'success', passed: 'a', total: NaN })]), /NaN|undefined/);
  assert.match(V.prChip([pr(9, OK, { title: 'a"b<c' })]), /title="#9 a&quot;b&lt;c — /);
  assert.doesNotMatch(V.prChip([pr(9, OK, { title: 'a"b<c' })]), /<c/);
});

// ---------- the Summary card ----------
const row = (o = {}) => ({
  id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'feat/x', needs: false, rank: 9,
  progress: { total: 12, completada: 5, enRevision: 0, bloqueada: 0, pendiente: 7, enCurso: 0 }, next: null, blocking: [],
  lastMovement: { at: new Date(NOW - 12 * 60000).toISOString(), what: 'fix: the thing' }, session: { state: 'free' }, action: null, ...o,
});
const view = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [], changesFor: () => null, ...ctx });
const cardOf = (html) => /<article class="rs-card[\s\S]*?<\/article>/.exec(html)[0];

test('c1: the card shows the subject of the last commit on its own line, escaped, after the branch and before the chips', () => {
  const html = cardOf(view([row()], { changesFor: () => ({ files: 1, added: 1, deleted: 0, ahead: 0, behind: 0 }) }));
  assert.match(html, /<span class="rs-sub rs-commit" title="fix: the thing">fix: the thing<\/span>/);
  assert.ok(html.indexOf('rs-branch') < html.indexOf('rs-commit') && html.indexOf('rs-commit') < html.indexOf('rs-chips'));
  assert.match(cardOf(view([row({ lastMovement: { at: null, what: 'a"b<c' } })])), /title="a&quot;b&lt;c">a&quot;b&lt;c<\/span>/);
});

test('c2: with no commit subject (none, empty or blank) the line is not drawn, and the time and its tooltip stay as they were', () => {
  for (const lm of [{ at: null, what: null }, { at: null, what: '' }, { at: null, what: '   ' }, {}, null]) assert.doesNotMatch(cardOf(view([row({ lastMovement: lm })])), /rs-commit/, JSON.stringify(lm));
  assert.match(cardOf(view([row()])), /<span class="rs-sub rs-when" title="fix: the thing">12 min ago<\/span>/);
});

test('c3: an errored row and a loading row have no commit line', () => {
  assert.doesNotMatch(cardOf(view([row({ error: 'git failed' })])), /rs-commit/);
  assert.doesNotMatch(view([{ id: 'l1', name: 'loady', loading: true, lastMovement: { what: 'x' } }]), /rs-commit/);
});

test('c4: the card shows the PR chip after the change chips, inside the chips wrapper, and none when there is no open PR', () => {
  const html = cardOf(view([row()], { changesFor: () => ({ files: 1, added: 1, deleted: 0, ahead: 0, behind: 0 }), prsFor: () => [pr(12, OK)] }));
  const wrap = /<span class="rs-chips">([\s\S]*?)<\/span><span class="rs-spacer">/.exec(html)[1];
  assert.ok(wrap.indexOf('chip yellow chip-btn') < wrap.indexOf('PR #12'), 'after the change chips');
  assert.match(wrap, /<span class="chip green" title="#12 title 12 — ✔ 5\/5 checks">PR #12 ✔ 5\/5<\/span>$/);
  assert.doesNotMatch(cardOf(view([row()], { prsFor: () => [] })), /PR #|rs-chips/);
  assert.doesNotMatch(cardOf(view([row()])), /PR #/, 'a page that gives no PRs draws no chip and does not fail');
});

test('c5: an errored row has no PR chip, and the manual-action chip still comes last', () => {
  assert.doesNotMatch(cardOf(view([row({ error: 'git failed' })], { prsFor: () => [pr(12, OK)] })), /PR #/);
  const html = cardOf(view([row({ action: { kind: 'manual', label: 'x' } })], { prsFor: () => [pr(12, OK)] }));
  assert.ok(html.indexOf('PR #12') < html.indexOf('manual action'));
});

test('c6: RepoCard draws the commit slot after the branch in summary mode and nothing when it is empty or absent', () => {
  const m = { id: 'r', label: 'n', identity: '<b>n</b>', branch: { text: 'b', title: 'b' } };
  assert.match(V.RepoCard({ ...m, commit: '<i>C</i>' }, 'summary'), /<\/span><i>C<\/i><span class="rs-spacer">/);
  assert.equal(V.RepoCard(m, 'summary'), V.RepoCard({ ...m, commit: '' }, 'summary'));
  assert.doesNotMatch(V.RepoCard({ ...m, commit: 5 }, 'summary'), /5/);
});

// ---------- the styles ----------
test('s1: the commit line is a clipped single line, a full row in the stacked card and a bounded one in the wide card', () => {
  assert.match(css, /\.rs-commit\s*\{[^}]*white-space:\s*nowrap[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.rs-commit\s*\{[^}]*flex:\s*1 1 100%/);
  const wide = /@container cards \(min-width: 640px\)\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(wide, /\.rs-commit\s*\{[^}]*flex:\s*0 1 auto[^}]*max-width:/);
  assert.match(wide, /\.rs-commit[^{]*\{[^}]*order:\s*0|\.rs-commit,|, \.rs-commit/);
});

test('s2: in the stacked card the commit line sits between the time and the chips (order)', () => {
  const o = (sel) => Number((new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*order:\\s*(\\d+)`).exec(css) || [])[1]);
  assert.ok(o('.rs-when') < o('.rs-commit') && o('.rs-commit') < o('.rs-chips'), `${o('.rs-when')} ${o('.rs-commit')} ${o('.rs-chips')}`);
});

test('s3: between 640 and 959 px the commit line is not drawn (no room: it stays in the tooltip of the time) and that rule holds nothing else', () => {
  const i = css.indexOf('@container cards (min-width: 640px) and (max-width: 959px)');
  assert.ok(i >= 0, 'a container rule for 640 to 959 px');
  const body = css.slice(css.indexOf('{', i) + 1);
  assert.match(body, /^\s*\.rs-commit\s*\{\s*display:\s*none;\s*\}\s*\}/, 'it holds only the rule that hides the commit line');
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
  vm.runInContext(appSource(), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';

test('g1: the page gives the Summary the open PRs of the repo from the model it already has (nothing while they are not loaded or failed)', () => {
  const page = loadPage();
  page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.local.abc = { branch: 'main', files: [], ahead: 0, behind: 0 };`);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(summaryPrs("abc"))')), [], 'not loaded');
  page.run(`S.prs.abc = { prs: [${JSON.stringify(pr(12, OK))}] };`);
  assert.equal(JSON.parse(page.run('JSON.stringify(summaryPrs("abc"))'))[0].number, 12);
  page.run("S.prs.abc = { error: 'rate limited' };");
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(summaryPrs("abc"))')), [], 'a failed read says nothing');
  assert.match(appSource(), /prsFor: summaryPrs/);
});
