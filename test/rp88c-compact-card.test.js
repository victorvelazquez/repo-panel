'use strict';
// RP88c (S9, S10), part 3 of 3: the compact mode of V.RepoCard draws the clean row (a repo with nothing to do, one line) from the same function as the
// Summary card and the board card (RP88b). The frame is shared: the row element, the identity line, the branch with its tooltip, the order of the parts. What
// differs (the "behind" count, the GitHub warning, the actions, the requirements notice and the roadmap block) is passed in as ready HTML by cleanRow. The
// HTML comes out byte for byte the same as before (checked against the base commit by a differential script, not committed). No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const K = (o = {}) => ({ identity: '<b>who</b>', branch: { text: 'main', title: 'main' }, tail: '', actions: '<i>A</i>', after: [], ...o });

// ---------- pure ----------
test('k1: the clean row is the row element with, one per line: the identity, the branch with its tail, the actions, then the lines after', () => {
  assert.equal(V.RepoCard(K({ tail: '<u>T</u>', after: ['<p>1</p>', '<p>2</p>'] }), 'compact'),
    '<div class="clean-row">\n    <b>who</b>\n    <span class="branch" title="main">main</span><u>T</u>\n    <i>A</i>\n    <p>1</p>\n    <p>2</p>\n  </div>');
});

test('k2: with nothing after, the row ends after the actions; an empty line stays an empty line (as the row always had it)', () => {
  assert.equal(V.RepoCard(K(), 'compact'), '<div class="clean-row">\n    <b>who</b>\n    <span class="branch" title="main">main</span>\n    <i>A</i>\n  </div>');
  assert.equal(V.RepoCard(K({ after: ['', '<p>x</p>'] }), 'compact'), '<div class="clean-row">\n    <b>who</b>\n    <span class="branch" title="main">main</span>\n    <i>A</i>\n    \n    <p>x</p>\n  </div>');
});

test('k3: the branch text and its tooltip are escaped; the slots are the caller HTML, untouched', () => {
  const h = V.RepoCard(K({ branch: { text: '<b>', title: 'a"b' }, identity: '<u>ok</u>' }), 'compact');
  assert.match(h, /<span class="branch" title="a&quot;b">&lt;b&gt;<\/span>/);
  assert.ok(h.includes('<u>ok</u>'));
});

test('k4: it is total: a bad model draws nothing, missing parts draw empty and never "undefined", and the other two modes still draw as before', () => {
  for (const m of [null, undefined, 5, 'x', []]) assert.equal(V.RepoCard(m, 'compact'), '');
  assert.equal(V.RepoCard({}, 'compact').includes('undefined'), false);
  assert.equal(V.RepoCard({ identity: 'x', after: 'not a list' }, 'compact').includes('undefined'), false);
  assert.match(V.RepoCard({ id: 'r1', label: 'a', identity: '', branch: { text: 'b', title: 'b' }, body: '' }, 'summary'), /^<article class="rs-card"/);
  assert.match(V.RepoCard({ top: '<p>T</p>', branch: { text: 'b', title: 'b' } }, 'work'), /^<div class="card ">/);
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
function loadPage(view = V) {
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
  ctx.RepoPanelView = view;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';
const seed = (page, local, prs = { prs: [] }) => page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = ${JSON.stringify(prs)};`);

test('p1: cleanRow is drawn by RepoCard in compact mode', () => {
  const calls = [];
  const real = V.RepoCard;
  const page = loadPage({ ...V, RepoCard: (m, mode) => { calls.push(mode); return real(m, mode); } });
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 2 });
  const h = page.run(`cleanRow(${REPO})`);
  assert.deepEqual(calls, ['compact']);
  assert.match(h, /^<div class="clean-row">/);
  assert.match(h, /<span class="behind" title="2 commits behind the remote — time to pull">↓2<\/span>/);
});

test('p2: the parts of the row keep their order: identity, branch, behind, GitHub warning, actions, requirements notice, roadmap', () => {
  const page = loadPage();
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 2 }, { prs: [], error: 'rate limited' });
  page.run(`S.req.abc = { state: 'loaded', data: { results: [{ id: 'R1', level: 'required', status: 'fail' }] } };
    S.roadmap.abc = { available: true, summary: { kind: 'next', id: 'X1', entrega: 'y', waiting: [], extra: 0, problems: { total: 0 }, done: 1, total: 2, pct: 50, header: {} } };`);
  page.run("S.groups.push({ name: 'Work', repos: [] }); S.group = '';"); // RP94b: the group tag shows with several groups
  const h = page.run(`cleanRow(${REPO})`);
  const at = (s) => { const i = h.indexOf(s); assert.ok(i >= 0, `${s} is on the row`); return i; };
  const order = ['class="tag"', 'class="repo-name"', 'class="branch"', 'class="behind"', 'class="warn"', 'class="row-actions"', 'class="req-warn"', 'class="roadmap"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('p3: the row markup lives once, in view.js: cleanRow no longer builds the row element or the branch span', () => {
  const has = (f, s) => read(f).split(s).length - 1;
  assert.equal(has('view.js', '<div class="clean-row">'), 1);
  assert.equal(has('app.js', '<div class="clean-row">'), 0);
  assert.equal(has('app.js', '<span class="branch" title='), 0);
});

test('p4: the branch of the row shows its label and keeps the full branch name as its tooltip, and a detached repo says so', () => {
  const page = loadPage();
  seed(page, { branch: 'feat/x', files: [], ahead: 0, behind: 0 });
  assert.match(page.run(`cleanRow(${REPO})`), /<span class="branch" title="feat\/x">feat\/x<\/span>/);
  seed(page, { branch: '', detached: true, files: [], ahead: 0, behind: 0 });
  assert.match(page.run(`cleanRow(${REPO})`), /<span class="branch" title="">\(detached\)<\/span>/);
});
