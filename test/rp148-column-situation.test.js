'use strict';
// RP148 (S38): (1) the right column OPENS on the tab that fits the situation of the repo: uncommitted changes -> Changes; an open PR of the branch -> Status; a clean tree with nothing ahead to deliver ->
// Tasks; anything else -> Changes. It is decided ONCE per opening, as soon as the facts are known: a tab the person chose with a click is never changed by itself, and neither is the one it decided when the
// situation changes later. (2) The tabs read Tasks, Changes, Status, Files (Tasks, Changes, Files without a PR). (3) The Tasks tab has no search box any more (the person never uses it).
// What does NOT change: the tabs themselves, the click that opens one, the arrow keys among them, and what the Tasks list shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');
const lib = require('../lib.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const FILE = { path: 'a.js', status: 'M', added: 1, deleted: 0 };

// ---------- the rule (pure) ----------
const pick = (o) => V.columnTabFor({ files: [], ahead: 0, hasPr: false, prsKnown: true, ...o });

test('r1: the table: changes -> Changes; an open PR -> Status; clean and nothing ahead -> Tasks; anything else -> Changes', () => {
  assert.equal(pick({ files: [FILE] }), 'changes');
  assert.equal(pick({ hasPr: true }), 'status');
  assert.equal(pick({}), 'tasks');
  assert.equal(pick({ ahead: 2 }), 'changes', 'commits waiting and no PR: there is something to deliver');
});

test('r2: the rows are checked in the order of the table: changes beat a PR, and a PR beats commits ahead', () => {
  assert.equal(pick({ files: [FILE], hasPr: true }), 'changes');
  assert.equal(pick({ hasPr: true, ahead: 3 }), 'status');
  assert.equal(pick({ files: [FILE], ahead: 1 }), 'changes');
});

test('r3: nothing is decided while the facts that matter are not known (null), and a clear answer needs no more', () => {
  for (const files of [undefined, null, 'x', {}, 7]) assert.equal(pick({ files }), null, String(files));
  assert.equal(pick({ prsKnown: false }), null, 'clean and the PRs are still loading: a PR could still turn up');
  assert.equal(pick({ files: [FILE], prsKnown: false }), 'changes', 'changes need no PR answer');
  assert.equal(V.columnTabFor(), null);
  assert.equal(V.columnTabFor(null), null);
  assert.equal(V.columnTabFor('x'), null);
  assert.equal(V.columnTabFor([]), null);
});

test('r4: an `ahead` that is not a whole number of at least 0 is never read as «nothing to deliver»', () => {
  for (const ahead of [-1, 1.5, NaN, Infinity, '0', null, undefined, {}]) assert.equal(pick({ ahead }), 'changes', String(ahead));
});

test('r5: a PR that is not strictly true is no PR (no text from outside makes a tab)', () => {
  for (const hasPr of [1, 'yes', {}, [], 'true']) assert.equal(pick({ hasPr }), 'tasks', String(hasPr));
  assert.equal(pick({ hasPr: false }), 'tasks');
});

// ---------- the order of the tabs ----------
test('o1: the tabs read Tasks, Changes, Status, Files with a PR; Tasks, Changes, Files without one; the same tabs as before, only reordered', () => {
  assert.deepEqual(R.COLUMN_TABS, ['tasks', 'changes', 'status', 'files']);
  const ids = (h) => [...h.matchAll(/data-act="col-tab" data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(R.columnView({ name: 'demo', files: [FILE] })), ['tasks', 'changes', 'files']);
  const git = { id: 'abc', branch: 'feat/x', ahead: 1, pr: { number: 7, state: 'open', checks: { total: 0, pending: 0 } }, merge: { enabled: false, label: 'Merge · squash', title: 't' }, rerun: { show: false, enabled: false, title: '' } };
  assert.deepEqual(ids(R.columnView({ name: 'demo', files: [FILE], git })), ['tasks', 'changes', 'status', 'files']);
  assert.equal((R.columnView({ name: 'demo', files: [FILE], git }).match(/role="tab"/g) || []).length, 4);
});

test('o2: the tab that is asked for is the one marked, whatever the position', () => {
  for (const t of ['tasks', 'changes', 'files']) {
    const sel = [...R.columnView({ name: 'demo', files: [FILE], tab: t }).matchAll(/id="coltab-(\w+)" data-act="col-tab" data-tab="\w+" aria-selected="true"/g)].map((m) => m[1]);
    assert.deepEqual(sel, [t], t);
  }
});

// ---------- no search box ----------
const RP = { available: true, rows: [{ id: 'A1', entrega: 'Alpha thing', dependsOn: [], estado: 'Pendiente' }, { id: 'A2', entrega: 'Beta thing', dependsOn: [], estado: 'Completada' }], derived: {}, next: { id: 'A1' } };

test('f1: the Tasks list has no search box, compact or not, and an old caller that still passes a filter changes nothing', () => {
  for (const compact of [true, false]) {
    for (const filter of [undefined, '', 'zzz', 'alpha']) {
      const h = R.tasksView(RP, { compact, filter });
      assert.ok(!/<input|tasksFilter|Filter tasks|task-filter/.test(h), `${compact} ${filter}`);
      assert.ok(h.includes('A1'), `the task is still listed whatever the filter: ${compact} ${filter}`);
      assert.ok(!h.includes('No task matches'));
    }
  }
});

test('f2: the page code and the stylesheet no longer have the search box: no action, no state, no input handler, no focus juggling, no rule', () => {
  const src = appSource();
  for (const gone of ['tasksFilter', 'tasks-filter']) assert.ok(!src.includes(gone), `the page code does not have ${gone}`);
  assert.ok(!/\.task-filter/.test(read('style.css')));
  assert.ok(!read('resumen.js').includes('tasksFilter'));
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false, focused: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused++; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const routes = {};
  const docL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => (routes[url] ? routes[url](url, opts) : new Promise(() => {})),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, routes, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, attention: null });
// A real pull request: what GitHub sends, reduced by the same enrichPr the server uses (as in rp129).
const RUN = { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/51' };
const PR = lib.enrichPr({ number: 7, title: 'feat(x): the title', url: 'https://github.com/o/r/pull/7', headRefName: 'feat/x', baseRefName: 'main', headRefOid: 'abc123', isDraft: false, isCrossRepository: false, author: { login: 'me' }, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 4, deletions: 1, changedFiles: 1, statusCheckRollup: [RUN] });
function boot({ local = { branch: 'feat/x', ahead: 0, files: [] }, prs = { prs: [] } } = {}) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  if (local) S.local.abc = local;
  if (prs) S.prs.abc = prs;
  const layout = page.get('#sumLayout');
  layout.clientWidth = 1400;
  layout.getBoundingClientRect = () => ({ left: 0, right: 1400, width: 1400 });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.routes['/api/roadmap?id=abc'] = () => Promise.resolve(ok({ available: true, rows: [{ id: 'A1', entrega: 'Alpha', resultadoVisible: '', dependsOn: [], estado: 'Pendiente', notas: '', line: 1 }], derived: {}, next: { id: 'A1' } }));
  return page;
}
const open = async (page) => { page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })"); await page.tick(); };
const col = (page) => page.get('#colBody').html;
const selected = (page) => (/id="coltab-(\w+)"[^>]*aria-selected="true"/.exec(col(page)) || [])[1];
const redraw = (page) => { page.run('draw()'); page.flush(); };

test('b1: opening a repo with uncommitted changes shows Changes', async () => {
  const page = boot({ local: { branch: 'feat/x', ahead: 0, files: [FILE] } });
  await open(page);
  assert.equal(selected(page), 'changes');
});

test('b2: opening a repo whose branch has an open PR shows Status', async () => {
  const page = boot({ prs: { prs: [PR] } });
  await open(page);
  assert.equal(selected(page), 'status');
});

test('b3: opening a repo that is clean with nothing ahead and no PR shows Tasks, with the list and no search box', async () => {
  const page = boot();
  await open(page);
  assert.equal(selected(page), 'tasks');
  assert.match(col(page), /Alpha/);
  assert.ok(!/<input/.test(col(page)));
});

test('b4: opening a repo with commits ahead and no PR shows Changes; so do a repo without a remote that has changes and one whose PRs failed to load but has commits ahead', async () => {
  const a = boot({ local: { branch: 'feat/x', ahead: 2, files: [] } });
  await open(a);
  assert.equal(selected(a), 'changes');
  const b = boot({ local: { branch: 'feat/x', ahead: 0, files: [FILE] }, prs: { noRemote: true } });
  await open(b);
  assert.equal(selected(b), 'changes');
  const c = boot({ local: { branch: 'feat/x', ahead: 1, files: [] }, prs: { error: 'boom' } });
  await open(c);
  assert.equal(selected(c), 'changes');
});

test('b5: a clean repo without a remote (the PRs say so) is a clean cycle: Tasks', async () => {
  const page = boot({ prs: { noRemote: true } });
  await open(page);
  assert.equal(selected(page), 'tasks');
});

test('b6: while the facts are not known the column shows Changes and decides nothing; when they arrive it decides ONCE, and a later change of situation does not move it', async () => {
  const page = boot({ local: null, prs: null });
  await open(page);
  assert.equal(selected(page), 'changes', 'nothing known yet: the default');
  assert.equal(page.run('S.chat.colTab'), undefined, 'nothing was decided');
  const S = page.run('S');
  S.local.abc = { branch: 'feat/x', ahead: 0, files: [] };
  redraw(page);
  assert.equal(selected(page), 'changes', 'clean but the PRs are still loading: a PR could turn up');
  S.prs.abc = { prs: [] };
  redraw(page);
  assert.equal(selected(page), 'tasks', 'now it is known: a clean cycle');
  S.local.abc = { branch: 'feat/x', ahead: 0, files: [FILE] };
  redraw(page);
  assert.equal(selected(page), 'tasks', 'the situation changed with the repo open: the tab does not jump by itself');
});

test('b7: a tab chosen with a click is never replaced by the rule, whenever the facts arrive', async () => {
  const page = boot({ local: null, prs: null });
  await open(page);
  page.run("ACTIONS['col-tab']({ dataset: { tab: 'files' } })");
  page.flush();
  const S = page.run('S');
  S.local.abc = { branch: 'feat/x', ahead: 0, files: [] };
  S.prs.abc = { prs: [] };
  redraw(page);
  assert.equal(selected(page), 'files');
  page.run("ACTIONS['col-tab']({ dataset: { tab: 'changes' } })");
  page.flush();
  S.prs.abc = { prs: [PR] };
  redraw(page);
  assert.equal(selected(page), 'changes');
});

test('b8: closing and opening the repo again decides again; opening another repo does not inherit the tab', async () => {
  const page = boot({ local: { branch: 'feat/x', ahead: 0, files: [FILE] } });
  await open(page);
  assert.equal(selected(page), 'changes');
  page.run('closeChat()');
  page.run('S.local.abc = { branch: "feat/x", ahead: 0, files: [] }');
  await open(page);
  assert.equal(selected(page), 'tasks', 'a new opening: the new situation');
});

test('b9: a Tasks tab asked for from a task chip still opens Tasks, whatever the situation (the explicit way in is kept)', async () => {
  const page = boot({ local: { branch: 'feat/x', ahead: 0, files: [FILE] } });
  page.run("ACTIONS['tasks-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.equal(selected(page), 'tasks');
});

test('b10: the arrow keys among the tabs follow the order on screen', () => {
  const src = appSource();
  assert.match(src, /R\.COLUMN_TABS/);
});
