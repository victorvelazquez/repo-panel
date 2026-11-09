'use strict';
// RP91 (S4, S5): the tasks of the open repo are a CARD in the right column (RP89), drawn by the same R.tasksView (done folded, the current one and the pending ones open, with the filter) and
// read from /api/roadmap when the repo OPENS, not when a tab is chosen. The Tasks tab of the chat only shows where there is no column (under 1100 px of layout), so nobody loses the tasks;
// with the column in, the tab is gone. The files card (RP92) fills the second card. The Claude usage stays in the header. No network, no timers, no real clock.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\r\n/g, '\n');

// ---------- pure ----------
test('c1 (RP92: no Changes tab either): with the column in, the head has no Tasks tab (Chat, Notes) and a Tasks tab left over reads as the chat; without the flag nothing changes', () => {
  const h = R.chatHead({ id: 'abc', tab: 'tasks' }, { name: 'demo', column: true });
  const tabs = [...h.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['chat', 'notes']);
  assert.match(h, /data-tab="chat"[^>]*aria-selected="true"/);
  const all = [...R.chatHead({ id: 'abc' }, { name: 'demo' }).matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(all, ['chat', 'tasks', 'changes', 'files', 'notes'], 'no column: the four tabs as before');
  assert.deepEqual([...R.chatHead({ id: 'abc' }, { name: 'demo', column: false }).matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]), all);
  assert.doesNotMatch(R.chatHead({ id: 'abc', tab: 'files' }, { name: 'demo', column: true }), /data-tab="files"/, 'RP130: with the column in the explorer belongs to the column, not to a tab of the chat');
});

test('c2 (RP128: tabs): the Tasks tab draws what the page gives it inside the panel; the repo name of the Changes panel is escaped in its label', () => {
  const t = R.columnView({ name: 'a<b>"c', tab: 'tasks', tasksHtml: '<p class="t">T</p>' });
  assert.match(t, /aria-labelledby="coltab-tasks"><p class="t">T<\/p><\/div>$/);
  const c = R.columnView({ name: 'a<b>"c', files: [{ path: 'x.js', status: 'M' }] });
  assert.match(c, /aria-label="Files with changes of a&lt;b&gt;&quot;c"/);
  assert.doesNotMatch(c, /a<b>/);
});

test('c3 (RP128: tabs): without tasks to show the Tasks tab says so; the column is total for odd input', () => {
  for (const arg of [{ name: 'x', tab: 'tasks', tasksHtml: '' }, { tab: 'tasks' }, { tab: 'tasks', tasksHtml: undefined }, {}, undefined, null]) {
    const h = R.columnView(arg);
    assert.match(h, /^<div class="col-tabs"/, JSON.stringify(arg));
    assert.doesNotMatch(h, /undefined|null/);
  }
  assert.match(R.columnView({ name: 'x', tab: 'tasks' }), /<p class="rs-sub" role="status">No tasks to show<\/p>/);
  assert.equal(R.columnNotice, undefined, 'the single notice of RP89 is gone');
});

test('c4 (RP128: tabs): the styles: the panel can shrink and a row of the compact tasks is one clipped line', () => {
  assert.match(css, /\.col-pane\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.tk-tx\s*\{[^}]*text-overflow:\s*ellipsis/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const winL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET' }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  // Two rounds: the first draw runs at the first flush and starts the read of the tasks; the second lets the answer land and be painted.
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, fetches, routes, winL, doc, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const bad = () => ({ ok: false, status: 500, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const ROW = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...over });
const ROADMAP = { available: true, rows: [ROW('A1', 'Completada'), ROW('B1', 'En curso'), ROW('C1', 'Pendiente')], derived: {}, next: ROW('C1', 'Pendiente') };
const RM = (id) => `/api/roadmap?id=${id}`;
const reads = (page, id) => page.fetches.filter((f) => f.url === RM(id)).length;
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
function boot(width = 1400) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  return page;
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const tasksOpen = (page, id) => page.run(`ACTIONS['tasks-open']({ dataset: { id: '${id}' } })`);
const col = (page) => page.get('#colBody').html;
const head = (page) => page.get('#chatHead').html;
const tasksTab = (page) => { page.run("ACTIONS['col-tab']({ dataset: { tab: 'tasks' } })"); page.flush(); }; // RP128: the tasks are a tab of the column

test('p1: with the column in, opening a repo reads its roadmap once and draws the tasks in the column; the chat stays on the Chat tab and the head has no Tasks tab', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  assert.equal(reads(page, 'abc'), 1);
  assert.doesNotMatch(col(page), /tk-bar/, 'the column opens on Changes');
  tasksTab(page);
  assert.match(col(page), /class="tk-bar"/);
  assert.match(col(page), /Delivery of B1/);
  assert.match(col(page), /Delivery of C1/);
  assert.doesNotMatch(col(page), /Delivery of A1/, 'the completed one is folded');
  assert.equal(page.run('S.chat.tab || "chat"'), 'chat');
  assert.doesNotMatch(head(page), /data-tab="tasks"/);
  assert.match(col(page), /id="coltab-changes"/);
});

test('p2: the roadmap is read ONCE per opening: redraws, a resize and the filter never ask again', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  page.run('draw()');
  page.flush();
  for (const fn of page.winL.resize || []) fn({ type: 'resize' });
  page.run("ACTIONS['tasks-filter']({ value: 'B1' })");
  page.flush();
  assert.equal(reads(page, 'abc'), 1);
});

test('p3: the tasks keep working in the column: the filter narrows the rows and keeps its value, and the completed fold opens (RP128: with its own button)', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  tasksTab(page);
  page.run("ACTIONS['tasks-filter']({ value: 'B1' })");
  page.flush();
  assert.match(col(page), /Delivery of B1/);
  assert.doesNotMatch(col(page), /Delivery of C1/);
  assert.match(col(page), /id="tasksFilter"[^>]*value="B1"/);
  page.run("ACTIONS['tasks-filter']({ value: '' })");
  assert.doesNotMatch(col(page), /Delivery of A1/, 'folded until its button is touched');
  page.run("ACTIONS['tasks-fold']({ dataset: { fold: 'done' } })");
  page.flush();
  assert.match(col(page), /Delivery of A1/, 'the completed group is open');
});

test('p3b: the filter box of the column keeps the focus (and the cursor) across redraws', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  tasksTab(page);
  const box = page.get('#tasksFilter');
  const calls = [];
  box.value = 'B1';
  box.focus = () => calls.push('focus');
  box.setSelectionRange = (a, b) => calls.push(`range ${a} ${b}`);
  page.doc.activeElement = { id: 'tasksFilter' };
  page.run("ACTIONS['tasks-filter']({ value: 'B1' })");
  page.flush();
  assert.deepEqual(calls, ['focus', 'range 2 2']);
  page.doc.activeElement = { id: 'somethingElse' };
  calls.length = 0;
  page.run('draw()');
  page.flush();
  assert.deepEqual(calls, [], 'with the focus elsewhere nothing is focused');
});

test('p4: while the roadmap is on its way the card says so, and a failed read says it is unavailable', async () => {
  const page = boot();
  open(page, 'abc');
  page.flush();
  tasksTab(page);
  assert.match(col(page), /Loading tasks…/);
  const bad1 = boot();
  bad1.routes[RM('abc')] = () => Promise.resolve(bad());
  open(bad1, 'abc');
  await bad1.tick();
  bad1.run("ACTIONS['col-tab']({ dataset: { tab: 'tasks' } })");
  bad1.flush();
  assert.match(col(bad1), /Roadmap unavailable/);
});

test('p5: switching repo draws the tasks of the NEW repo, and a late answer of the repo left never paints the shown one', async () => {
  const page = boot();
  let late;
  page.routes[RM('abc')] = () => new Promise((resolve) => { late = resolve; });
  page.routes[RM('xyz')] = () => Promise.resolve(ok({ ...ROADMAP, rows: [ROW('Z1', 'En curso')], next: null }));
  open(page, 'abc');
  page.flush(); // the first draw starts the read of abc
  open(page, 'xyz');
  await page.tick();
  tasksTab(page);
  assert.match(col(page), /Delivery of Z1/);
  late(ok(ROADMAP));
  await page.tick();
  assert.match(col(page), /Delivery of Z1/);
  assert.doesNotMatch(col(page), /Delivery of B1/);
});

test('p5b: a chat read that starts while the roadmap is on its way (the 5 s poll bumps S.chat.seq) does not make the answer be dropped', async () => {
  const page = boot();
  let answer;
  page.routes[RM('abc')] = () => new Promise((resolve) => { answer = resolve; });
  open(page, 'abc');
  page.flush(); // the first draw starts the read of the roadmap
  assert.equal(reads(page, 'abc'), 1);
  page.run('S.chat.seq += 3'); // what loadChat does on every poll
  answer(ok(ROADMAP));
  await page.tick();
  tasksTab(page);
  assert.match(col(page), /Delivery of B1/, 'the answer of THIS opening is applied');
  assert.equal(page.run('S.chat.tasksLoading'), false);
});

test('p6: tasks-open (the bar of a card) opens the repo; with the column in it opens the Tasks tab of the column (RP128), so the chat stays on the Chat tab', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(page.run('S.chat.tab || "chat"'), 'chat');
  assert.equal(reads(page, 'abc'), 1);
  assert.match(col(page), /id="coltab-tasks"[^>]*aria-selected="true"/);
  assert.match(col(page), /Delivery of B1/);
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.tab || "chat"'), 'chat');
  assert.equal(reads(page, 'abc'), 1);
});

test('p7: choosing the Tasks tab while the column is in does nothing (it is the Chat tab)', async () => {
  const page = boot();
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  tab(page, 'tasks');
  page.flush();
  assert.equal(page.run('S.chat.tab'), 'chat');
});

// ---------- where there is no column ----------
test('n1: under 1100 px (no column) nothing changes: the Tasks tab is there, the roadmap is read only when it is chosen, and the column holds no tasks view', async () => {
  const page = boot(1000);
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  assert.equal(reads(page, 'abc'), 0, 'not read until the tab is chosen');
  assert.match(head(page), /data-tab="tasks"/);
  assert.doesNotMatch(col(page), /col-tasks|tasksFilter/);
  tab(page, 'tasks');
  await page.tick();
  assert.equal(reads(page, 'abc'), 1);
  assert.match(page.get('#chatBody').html, /Delivery of B1/);
  assert.equal((page.get('#chatBody').html + col(page)).split('id="tasksFilter"').length - 1, 1, 'one filter box on the page, never two');
});

test('n2: under 1100 px tasks-open opens the repo on the Tasks tab, as before', async () => {
  const page = boot(1000);
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'tasks');
  assert.equal(reads(page, 'abc'), 1);
});

test('n3: when the window grows past 1100 px the column takes the tasks (read once) and a Tasks tab that was open reads as the Chat tab', async () => {
  const page = boot(1000);
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'tasks');
  page.get('#sumLayout').clientWidth = 1400;
  for (const fn of page.winL.resize || []) fn({ type: 'resize' });
  page.run('draw()');
  await page.tick();
  assert.equal(reads(page, 'abc'), 1, 'it was already read: no second request');
  tasksTab(page);
  assert.match(col(page), /Delivery of B1/);
  assert.doesNotMatch(head(page), /data-tab="tasks"/);
  assert.doesNotMatch(page.get('#chatBody').html, /tasksFilter/, 'the body is not the tasks view any more');
});

test('s1: the Claude usage is not in the column (it stays in the header): the column code has no usage', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'resumen.js'), 'utf8');
  const view = src.slice(src.indexOf('const columnView'), src.indexOf('const columnView') + 900);
  assert.doesNotMatch(view, /usage|Usage/);
});
