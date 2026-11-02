'use strict';
// RP94 part a (S9): the cards show less. Four things that need no new data go away or move: the loose ✕ button (it is an item of the ⋯ menu now, with the same
// confirmation), the count next to the bars (the title and the aria-label still say how many are completed), the "↓ N behind" chip (shared by the board card
// and the Summary card) and the "no GitHub remote" chip. The clean row keeps its own "↓N". Nothing else changes: the other chips, the menu items and the roadmap
// block stay. How it LOOKS is for the person to approve by looking; these tests pin the structure and what is still shown. No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const C = (o = {}) => ({ files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false, ...o });

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
  vm.runInContext(read('app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';
const seed = (page, local, prs = { prs: [] }) => page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = ${JSON.stringify(prs)}; S.menu = null;`);
const ROADMAP = "S.roadmap.abc = { available: true, summary: { kind: 'next', id: 'X1', entrega: 'y', waiting: [], extra: 0, problems: { total: 0 }, done: 3, total: 12, pct: 25, header: {} } };";
const DIRTY = { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 1, behind: 3 };

// ---------- the ✕ button is a menu item ----------
test('x1: the board card has no loose ✕ button, and its ⋯ menu has "Remove from panel…" (open menu only)', () => {
  const page = loadPage();
  seed(page, DIRTY);
  const closed = page.run(`repoCard(${REPO})`);
  assert.doesNotMatch(closed, /class="x"/);
  assert.match(closed, /data-act="toggle-menu" data-menu="abc\|repo"/, 'the menu button is still there');
  page.run("S.menu = 'abc|repo';");
  const open = page.run(`repoCard(${REPO})`);
  assert.match(open, /<button role="menuitem" data-act="remove" data-id="abc" title="Remove from panel \(deletes nothing\)">Remove from panel…<\/button>/);
});

test('x2: the clean row too: no loose ✕, the item is in its ⋯ menu', () => {
  const page = loadPage();
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 0 });
  assert.doesNotMatch(page.run(`cleanRow(${REPO})`), /class="x"/);
  page.run("S.menu = 'abc|row';");
  assert.match(page.run(`cleanRow(${REPO})`), /data-act="remove" data-id="abc"[^>]*>Remove from panel…</);
});

test('x3: the item comes after the others (the room choices, the requirement items) and nothing else of the menu is lost', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run("S.menu = 'abc|repo'; S.rooms = [{ name: 'UPEN', repos: [] }];");
  const h = page.run(`repoCard(${REPO})`);
  assert.ok(h.indexOf('data-act="assign-room"') >= 0, 'the room choices stay');
  assert.ok(h.indexOf('data-act="remove"') > h.indexOf('data-act="assign-room"') || h.indexOf('data-act="remove"') < h.indexOf('class="more-head"'), 'the item has a fixed place');
});

test('x4: removing still asks first and removes by id (the handler is the same one, now reached from the menu)', () => {
  const src = read('app.js');
  assert.match(src, /'remove': async \(el\) => \{\s*const id = el\.dataset\.id;\s*if \(!confirm\(/);
  assert.equal((src.match(/data-act="remove"/g) || []).length, 1, 'one place builds the remove button');
});

// ---------- the count next to the bar ----------
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const baseRow = (o = {}) => ({ id: 'r1', name: 'alpha', group: 'g', room: null, branch: 'b', needs: false, rank: 9, progress: { total: 12, completada: 5, enRevision: 1, bloqueada: 1, pendiente: 5, enCurso: 0 }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null, ...o });
const summary = (rows, ctx = {}) => R.summaryView({ rows, generatedAt: 't' }, { now: NOW, scope: { kind: 'all' }, rooms: [], changesFor: () => null, ...ctx });

test('b1: the Summary card bar has no count next to it, and the title and aria-label still say how many are completed', () => {
  const html = summary([baseRow()]);
  assert.doesNotMatch(html, /rs-count|5\/12/);
  assert.match(html, /title="5 of 12 completed · 1 in review · 1 blocked · Click to see the tasks"/);
  assert.match(html, /aria-label="5 of 12 completed · 1 in review · 1 blocked"/);
});

test('b2: the bar of a room (the sum of its repos) has no count either; "no units" and "no data" still say so', () => {
  const room = summary([baseRow({ room: 'UPEN' })], { rooms: [{ name: 'UPEN', repos: ['r1'] }], roomData: { rooms: [{ name: 'UPEN', repos: ['r1'], presence: { state: 'idle' }, lastCommit: null }] } });
  assert.match(room, /rs-card rs-room/);
  assert.doesNotMatch(room, /rs-count/);
  assert.match(summary([baseRow({ progress: { total: 0 } })]), /no units/);
  assert.doesNotMatch(summary([baseRow({ progress: { total: null } })]), /rs-count/);
});

test('b3: the roadmap block of the board card and the clean row has no count on its line, and keeps its bar and its text', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run(ROADMAP);
  for (const fn of ['repoCard', 'cleanRow']) {
    const h = page.run(`${fn}(${REPO})`);
    assert.doesNotMatch(h, /rm-count|3\/12/, fn);
    assert.match(h, /class="rm-text" title="Next: X1 y">Next: X1 y<\/span>/, fn);
    assert.match(h, /class="rm-bar"><span style="width:25%">/, fn);
  }
});

// ---------- the chips ----------
test('c1: the shared change chips no longer have the "behind" chip; files and unpushed stay, in that order, and the unpushed chip still says "no upstream"', () => {
  assert.equal(V.changeChips(C({ behind: 3 }), 'abc'), '');
  assert.equal(V.changeChips(C({ files: 1, added: 1, deleted: 0, ahead: 2, behind: 5, noUpstream: true }), 'abc'),
    '<button class="chip yellow chip-btn" data-act="diff" data-id="abc" title="View diff">● 1 file <span class="add">+1</span> <span class="del">−0</span></button><span class="chip blue">↑ 2 unpushed · no upstream</span>');
});

test('c2: neither card shows a behind chip, but both keep their other chips', () => {
  const page = loadPage();
  seed(page, DIRTY, { prs: [], noRemote: true });
  const work = page.run(`repoCard(${REPO})`);
  assert.doesNotMatch(work, /behind/);
  assert.match(work, /chip yellow chip-btn/);
  assert.match(work, /↑ 1 unpushed/);
  const row = { id: 'abc', name: 'demo', group: 'g', room: null, branch: 'b', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null };
  const card = R.summaryView({ rows: [row], generatedAt: 't' }, { now: 0, scope: { kind: 'all' }, rooms: [], changesFor: () => C({ files: 1, added: 1, ahead: 1, behind: 4 }) });
  assert.doesNotMatch(card, /behind/);
  assert.match(card, /↑ 1 unpushed/);
});

test('c3: the board card has no "no GitHub remote" chip; the "remote branch deleted" chip and the GitHub error line stay', () => {
  const page = loadPage();
  seed(page, { ...DIRTY, currentGone: true }, { prs: [], noRemote: true });
  const h = page.run(`repoCard(${REPO})`);
  assert.doesNotMatch(h, /no GitHub remote/);
  assert.match(h, /remote branch deleted/);
  seed(page, DIRTY, { error: 'rate limited' });
  assert.match(page.run(`repoCard(${REPO})`), /class="err">GitHub: rate limited</);
});

test('c4: the clean row keeps its own "↓N" and its GitHub warning', () => {
  const page = loadPage();
  seed(page, { branch: 'main', files: [], ahead: 0, behind: 2 }, { prs: [], error: 'rate limited' });
  const h = page.run(`cleanRow(${REPO})`);
  assert.match(h, /<span class="behind" title="2 commits behind the remote — time to pull">↓2<\/span>/);
  assert.match(h, /class="warn"/);
});
