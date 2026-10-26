'use strict';
// RP28 points 2 and 3: one «Pull requests» column (ready to merge first, then fixes, then checks still running) and the
// Clean column back by default (the Idle bar stays as the opt-in layout). view.js plus the real public/app.js in a vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');
const lib = require('../lib.js');

const ROOT = path.join(__dirname, '..');
// Windows runners check the repo out with CRLF line endings: read everything as LF so the regexes below do not depend on it.
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (f) => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const rule = (css, sel) => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};

// ---------- PRs ----------
const base = (n, rollup = [], o = {}) => lib.enrichPr({
  number: n, title: `pr ${n}`, url: `https://github.com/o/demo/pull/${n}`, headRefName: `task-${n}`, baseRefName: 'main', headRefOid: 'a'.repeat(40),
  isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, statusCheckRollup: rollup, author: { login: 'x' }, ...o,
});
const pending = (n) => base(n, [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }]);
const failing = (n) => base(n, [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' }]);
const conflicting = (n) => base(n, [], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
const behind = (n) => base(n, [], { mergeStateStatus: 'BEHIND' });
const draft = (n) => base(n, [], { isDraft: true });
const waiting = (n) => base(n, [], { mergeStateStatus: 'BLOCKED' }); // waiting for review: not ready, not a problem
const ready = (n) => base(n);

// ---------- view.js ----------
test('boardColumns: Pull requests replaces Open PRs and Ready to merge, between Committed and Merged', () => {
  assert.deepEqual(view.boardColumns(true, 0), ['clean', 'changes', 'committed', 'prs', 'merged']);
  assert.deepEqual(view.boardColumns(true, 5), ['clean', 'changes', 'committed', 'prs', 'merged'], 'Needs attention never shows next to Clean');
  assert.deepEqual(view.boardColumns(false, 0), ['changes', 'committed', 'prs', 'merged']);
  assert.deepEqual(view.boardColumns(false, 3), ['attention', 'changes', 'committed', 'prs', 'merged']);
  assert.deepEqual(view.boardColumns(), ['changes', 'committed', 'prs', 'merged']);
});

test('prColumn: PRESERVE still ranks a PR as ready | progress (the work queue and the scenarios rely on it)', () => {
  assert.equal(view.prColumn(ready(1)), 'ready');
  assert.equal(view.prColumn(pending(2)), 'progress');
  assert.equal(view.prColumn(failing(3)), 'progress');
});

test('prRank: ready 0, problems 1, the rest 2', () => {
  const table = [
    [ready(1), 0], [failing(2), 1], [conflicting(3), 1], [behind(4), 1],
    [pending(5), 2], [waiting(6), 2], [draft(7), 2],
  ];
  for (const [pr, rank] of table) assert.equal(view.prRank(pr), rank, `#${pr.number}`);
});

test('sortPrCards: ready first, then problems, then the rest, keeping the original order inside each group', () => {
  const prs = [pending(1), failing(2), ready(3), waiting(4), ready(5), conflicting(6), pending(7), behind(8)];
  const order = (list) => list.map((p) => p.number);
  assert.deepEqual(order(view.sortPrCards(prs)), [3, 5, 2, 6, 8, 1, 4, 7]);
  assert.deepEqual(order(prs), [1, 2, 3, 4, 5, 6, 7, 8], 'the input is not mutated');
  assert.deepEqual(order(view.sortPrCards([ready(9), ready(2), ready(5)])), [9, 2, 5], 'a stable order inside the group');
  assert.deepEqual(view.sortPrCards([]), []);
});

test('sortPrCards: works on wrapped items through a getter', () => {
  const items = [{ pr: pending(1), html: 'a' }, { pr: ready(2), html: 'b' }];
  assert.deepEqual(view.sortPrCards(items, (x) => x.pr).map((x) => x.html), ['b', 'a']);
});

// ---------- page ----------
const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

async function loadPage(stored = {}) {
  const app = { innerHTML: '' };
  const els = {};
  const saved = {};
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === '#app' ? app : sel === '#cleanAsColumn' ? (els[sel] = els[sel] || {}) : stub()) : stub) }),
    localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { saved[k] = v; } },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    confirm: () => true,
    fetch: async () => { throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(read('public/app.js'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (name) => vm.runInContext(name, ctx), app, saved, checkbox: els['#cleanAsColumn'] };
}

const local = (o = {}) => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', ...o });
const repo = (name) => ({ id: `id-${name}`, name, path: `C:/x/${name}`, group: 'g' });
const REPOS = { quiet: repo('quiet-repo'), manual: repo('manual-repo'), dirty: repo('dirty-repo'), prs: repo('prs-repo') };
const STATE = {
  quiet: [local(), []],
  manual: [local({ branch: null, detached: true }), []],
  dirty: [local({ files: [{ path: 'a.txt', status: 'M', untracked: false }] }), []],
};

function setup(page, keys, prs = []) {
  const S = page.get('S');
  const list = keys.map((k) => REPOS[k]);
  if (prs.length) list.push(REPOS.prs);
  S.groups = [{ name: 'g', repos: list }];
  for (const k of keys) { S.local[REPOS[k].id] = STATE[k][0]; S.prs[REPOS[k].id] = { prs: STATE[k][1], stale: null, repo: { url: 'https://github.com/o/x' } }; }
  if (prs.length) { S.local[REPOS.prs.id] = local({ branch: 'task', upstream: 'origin/task' }); S.prs[REPOS.prs.id] = { prs, stale: null, repo: { url: 'https://github.com/o/demo' } }; }
  return S;
}

function sections(html) {
  const out = [];
  const re = /<section class="col col-([a-z]+)">([\s\S]*?)<\/section>/g;
  let m;
  while ((m = re.exec(html))) out.push({ key: m[1], html: m[2] });
  return out;
}
const keys = (html) => sections(html).map((s) => s.key);
const byKey = (html, key) => sections(html).find((s) => s.key === key);
const order = (html) => [...html.matchAll(/data-act="merge" data-id="[^"]*" data-n="(\d+)"/g)].map((m) => Number(m[1]));
const FIVE = ['clean', 'changes', 'committed', 'prs', 'merged'];

test('page: the Pull requests column holds every open PR: ready first, then problems, then checks running', async () => {
  const page = await loadPage();
  setup(page, [], [pending(1), failing(2), ready(3), waiting(4), ready(5), conflicting(6)]);
  page.get('render')();
  const col = byKey(page.app.innerHTML, 'prs');
  assert.match(col.html, /<h2>Pull requests<\/h2>/);
  assert.match(page.app.innerHTML, /<div class="col-head" title="Open PRs: ready to merge first, then fixes, then checks still running">/);
  assert.match(col.html, /<span class="n">6<\/span>/);
  assert.deepEqual(order(col.html), [3, 5, 2, 6, 1, 4]);
  assert.ok(!/col-progress|col-ready|Open PRs<\/h2>|Ready to merge<\/h2>/.test(page.app.innerHTML), 'the old columns are gone');
});

test('page: a ready card carries the ready class and no other card does; text and merge button are unchanged', async () => {
  const page = await loadPage();
  setup(page, [], [pending(1), ready(3), failing(2)]);
  const card = (pr) => page.get('prCard')(REPOS.prs, pr, { url: 'u' });
  assert.match(card(ready(3)), /^<div class="card  ?ready">/);
  assert.match(card(failing(2)), /^<div class="card attn ?">/);
  assert.match(card(pending(1)), /^<div class="card +">/);
  assert.match(card(ready(3)), /<button class="merge" data-act="merge" data-id="id-prs-repo" data-n="3"\s+title="Merge into main">Merge · squash<\/button>/);
});

test('page: the problems count stays in the alert total and the problems filter still works', async () => {
  const page = await loadPage();
  const S = setup(page, [], [pending(1), failing(2), ready(3), conflicting(6)]);
  const built = page.get('buildCards')();
  assert.equal(built.problems, 2);
  assert.equal(built.cols.prs.length, 4);
  S.onlyProblems = true;
  page.get('render')();
  assert.deepEqual(order(byKey(page.app.innerHTML, 'prs').html), [2, 6]);
});

test('page: a snoozed PR parks under the Pull requests column in one Snoozed block, and the others stay', async () => {
  const page = await loadPage();
  const S = setup(page, [], [pending(1), ready(3), failing(2)]);
  S.snoozed.add('id-prs-repo:1');
  S.snoozed.add('id-prs-repo:2');
  page.get('render')();
  const col = byKey(page.app.innerHTML, 'prs');
  assert.deepEqual(order(col.html), [3]);
  assert.equal((col.html.match(/Snoozed \(/g) || []).length, 1);
  assert.match(col.html, /Snoozed \(2\)/);
  S.snoozedOpen.prs = true;
  page.get('render')();
  assert.match(byKey(page.app.innerHTML, 'prs').html, /data-act="unsnooze" data-id="id-prs-repo" data-n="1"/);
});

test('page: wakeReady still wakes a PR that became ready', async () => {
  const page = await loadPage();
  const S = setup(page, [], [pending(1)]);
  S.snoozed.add('id-prs-repo:1');
  page.get('(() => { setSnooze = (id, n, on, auto) => { globalThis.__woke = [id, n, on, auto]; }; })()');
  page.get('wakeReady')('id-prs-repo', { prs: [ready(1)] });
  assert.equal(JSON.stringify(page.get('globalThis.__woke')), '["id-prs-repo",1,false,true]');
});

// ---------- point 3: Clean back by default ----------
test('page: with no saved preferences the board is the five columns with Clean first, no Needs attention and no Idle bar', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'manual', 'dirty'], [ready(3)]);
  assert.equal(page.get('cleanAsColumn')(), true);
  page.get('render')();
  const html = page.app.innerHTML;
  assert.deepEqual(keys(html), FIVE);
  const clean = byKey(html, 'clean');
  assert.ok(clean.html.includes('quiet-repo') && clean.html.includes('manual-repo'), 'the compact rows and the attention cards live in Clean');
  assert.ok(!html.includes('Needs attention') && !html.includes('class="idle'));
});

test('page: saved preferences WITHOUT the key (what the person has today) also show the column', async () => {
  const page = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true }) });
  setup(page, ['quiet']);
  assert.equal(page.get('cleanAsColumn')(), true);
  page.get('render')();
  assert.deepEqual(keys(page.app.innerHTML), FIVE);
  assert.equal(page.checkbox.checked, true, 'and the header checkbox is ticked');
});

test('page: saved true shows the column, saved false gives the Idle bar and the Needs attention column', async () => {
  const on = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true, cleanAsColumn: true }) });
  setup(on, ['quiet', 'manual']);
  on.get('render')();
  assert.deepEqual(keys(on.app.innerHTML), FIVE);

  const off = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true, cleanAsColumn: false }) });
  setup(off, ['quiet', 'manual']);
  assert.equal(off.get('cleanAsColumn')(), false);
  off.get('render')();
  const html = off.app.innerHTML;
  assert.deepEqual(keys(html), ['attention', 'changes', 'committed', 'prs', 'merged']);
  assert.ok(byKey(html, 'attention').html.includes('manual-repo'));
  assert.match(html, /Idle · 1 repo/);
  assert.equal(off.checkbox.checked, false, 'the header checkbox is unticked');
});

test('page: any value other than false (null, 0, "") keeps the column; only the exact false turns it off', async () => {
  for (const [v, expected] of [[undefined, true], [null, true], [0, true], ['', true], ['false', true], [true, true], [false, false]]) {
    const page = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true, cleanAsColumn: v }) });
    assert.equal(page.get('cleanAsColumn')(), expected, String(v));
  }
});

test('page: toggling off gives the bar and saves an explicit false; toggling on brings the column back and saves true', async () => {
  const page = await loadPage();
  setup(page, ['quiet', 'manual']);
  page.get('setPref')('cleanAsColumn', false);
  assert.strictEqual(JSON.parse(page.saved.prefs).cleanAsColumn, false);
  page.get('render')();
  assert.deepEqual(keys(page.app.innerHTML), ['attention', 'changes', 'committed', 'prs', 'merged']);
  assert.match(page.app.innerHTML, /data-act="toggle-idle"/);
  page.get('setPref')('cleanAsColumn', true);
  assert.strictEqual(JSON.parse(page.saved.prefs).cleanAsColumn, true);
  page.get('render')();
  assert.deepEqual(keys(page.app.innerHTML), FIVE);
});

test('page: the choice survives a reload (a new page load with the saved value)', async () => {
  const first = await loadPage();
  first.get('setPref')('cleanAsColumn', false);
  const second = await loadPage({ prefs: first.saved.prefs });
  setup(second, ['quiet']);
  second.get('render')();
  assert.ok(!keys(second.app.innerHTML).includes('clean'));
  assert.equal(second.checkbox.checked, false);
  second.get('setPref')('cleanAsColumn', true);
  const third = await loadPage({ prefs: second.saved.prefs });
  setup(third, ['quiet']);
  third.get('render')();
  assert.deepEqual(keys(third.app.innerHTML), FIVE);
  assert.equal(third.checkbox.checked, true);
});

test('page: the Show as column button in the bar still turns the column on', async () => {
  const page = await loadPage({ prefs: JSON.stringify({ method: 'squash', del: true, cleanAsColumn: false }) });
  setup(page, ['quiet']);
  page.get('ACTIONS')['clean-as-column']();
  assert.strictEqual(JSON.parse(page.saved.prefs).cleanAsColumn, true);
  assert.equal(page.checkbox.checked, true);
});

test('source: every read of the preference goes through the one helper', () => {
  const app = read('public/app.js');
  const reads = app.split('\n').filter((l) => /S\.prefs\.cleanAsColumn/.test(l));
  assert.equal(reads.length, 1, 'only the helper reads S.prefs.cleanAsColumn');
  assert.match(app, /const cleanAsColumn = \(\) => S\.prefs\.cleanAsColumn !== false;/);
  assert.match(app, /\$\('#cleanAsColumn'\)\.checked = cleanAsColumn\(\)/);
});

// ---------- css and README ----------
test('css: the Pull requests column is merge-button green and the old two rules are gone; the ready card has a green inset accent', () => {
  const css = read('public/style.css');
  assert.match(rule(css, '.col-prs'), /border-top-color:\s*#238636/);
  assert.equal(rule(css, '.col-progress'), null);
  assert.equal(rule(css, '.col-ready'), null);
  const card = rule(css, '.card.ready');
  assert.match(card, /box-shadow:\s*inset 3px 0 0 #238636/);
  assert.ok(!/animation|transition/.test(card), 'no animation');
  assert.match(rule(css, '.card.attn'), /inset 3px 0 0 var\(--red\)/, 'PRESERVE the red accent');
});

test('README: describes the one Pull requests column and says Clean is a column by default with the Idle bar as an option', () => {
  const readme = read('README.md');
  assert.match(readme, /\*\*Pull requests\*\*/);
  assert.ok(!/Open PRs · Ready to merge/.test(readme));
  assert.match(readme, /\*\*Clean\*\* is a column by default/);
  assert.match(readme, /untick \*\*Clean column\*\*|Untick \*\*Clean column\*\*/);
  assert.match(readme, /Idle/);
});
