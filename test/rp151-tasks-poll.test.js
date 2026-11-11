'use strict';
// RP151 (S26): the Tasks tab of the column reads the roadmap again by itself, every minute, while it is open and the page is visible, so the person sees without touching anything what the automatic fetch of RP150 brought.
// The clock only reads (GET /api/roadmap through the loadTasks({ force }) of RP149); it stops by itself when the tab is not the Tasks one, the page is hidden, the repo changed, or the column is not on screen (a phone on the chat
// screen); it never doubles a read that is on its way, never hammers a server that fails (one try per minute, the last good answer stays on screen), and never paints a repo the person left. No real timers and no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const T0 = 1_700_000_000_000;
const due = (o = {}) => V.tasksPollDue({ chatId: 'abc', column: true, colTab: 'tasks', hidden: false, narrow: false, zone: 'chat', reading: false, at: T0, now: T0 + 60_000, ...o });

// ---------- the rule (pure) ----------
test('d1: it is due only when a whole minute has gone since the last try; 59 999 ms is not, 60 000 is', () => {
  assert.equal(V.TASKS_REFRESH_MS, 60_000);
  assert.equal(due({ now: T0 + 59_999 }), false);
  assert.equal(due({ now: T0 + 60_000 }), true);
  assert.equal(due({ now: T0 + 3_600_000 }), true);
  assert.equal(due({ now: T0 }), false);
});

test('d2: every guard turns it off: no repo, no column, another tab, a hidden page, a read on its way', () => {
  for (const o of [{ chatId: null }, { chatId: '' }, { chatId: 5 }, { column: false }, { column: 'yes' }, { colTab: 'changes' }, { colTab: 'status' }, { colTab: 'files' }, { colTab: undefined }, { colTab: 'Tasks' }, { hidden: true }, { reading: true }]) assert.equal(due(o), false, JSON.stringify(o));
  assert.equal(due({ hidden: undefined }), true, 'a document with no `hidden` is not hidden');
  assert.equal(due({ hidden: false, reading: false }), true);
});

test('d3: on a phone the column is on screen only on the Repo zone; on any other width the zone does not matter', () => {
  assert.equal(due({ narrow: true, zone: 'chat' }), false);
  assert.equal(due({ narrow: true, zone: undefined }), false);
  assert.equal(due({ narrow: true, zone: 'repo' }), true);
  assert.equal(due({ narrow: false, zone: 'chat' }), true);
  assert.equal(due({ narrow: false, zone: 'repo' }), true);
});

test('d4: a try time that is not a real time, or that is in the future, is never due; nothing that is not an object breaks it', () => {
  for (const at of [undefined, null, NaN, Infinity, -1, '1', {}]) assert.equal(due({ at, now: T0 + 999_999 }), false, String(at));
  assert.equal(due({ at: T0 + 10_000, now: T0 }), false, 'a clock that went back is not a minute');
  assert.equal(due({ now: NaN }), false);
  assert.equal(due({ now: '1' }), false);
  for (const bad of [null, undefined, 5, 'x', [], true]) assert.equal(V.tasksPollDue(bad), false, String(bad));
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
const ROW = (id, estado, entrega = `Delivery of ${id}`) => ({ id, entrega, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1 });
const roadmap = (...rows) => ({ available: true, rows, derived: {}, next: rows.find((r) => r.estado === 'Pendiente') || null });
const RM = (id) => `/api/roadmap?id=${id}`;
const ok = (body) => Promise.resolve({ ok: true, json: async () => body });
const fail = () => Promise.resolve({ ok: false, status: 500, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null });

function boot(width = 1400) {
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const clock = { t: T0 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '', pathname: '/', search: '' }, history: { pushState() {}, replaceState() {}, back() {} }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET' }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const S = vm.runInContext('S', ctx);
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  const layout = get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  get('#split').offsetWidth = 10;
  get('#split2').offsetWidth = 10;
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  const page = {
    get, doc, fetches, routes, clock, tick, run: (c) => vm.runInContext(c, ctx),
    reads: (id) => fetches.filter((f) => f.url === RM(id)).length,
    col: () => get('#colBody').html,
    open: async (id) => { page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`); await tick(); },
    tasksTab: async () => { page.run("ACTIONS['col-tab']({ dataset: { tab: 'tasks' } })"); await tick(); },
    changesTab: async () => { page.run("ACTIONS['col-tab']({ dataset: { tab: 'changes' } })"); await tick(); },
    advance: async (ms) => { clock.t += ms; page.run('tasksTick()'); await tick(); },
  };
  return page;
}
// A repo open on the Tasks tab of the column, read twice (opening + entering the tab), clock at T0.
async function ready(width) {
  const page = boot(width);
  page.routes[RM('abc')] = () => ok(roadmap(ROW('A1', 'Completada'), ROW('C1', 'Pendiente')));
  await page.open('abc');
  await page.tasksTab();
  return page;
}

test('p1: with the Tasks tab open it reads again after a minute and paints what is new; before the minute it does not', async () => {
  const page = await ready();
  assert.equal(page.reads('abc'), 2);
  page.routes[RM('abc')] = () => ok(roadmap(ROW('A1', 'Completada'), ROW('C1', 'Pendiente'), ROW('D9', 'Pendiente', 'A task that came with the fetch')));
  await page.advance(59_999);
  assert.equal(page.reads('abc'), 2);
  assert.doesNotMatch(page.col(), /came with the fetch/);
  await page.advance(1);
  assert.equal(page.reads('abc'), 3);
  assert.match(page.col(), /A task that came with the fetch/);
});

test('p2: it keeps going: one read per minute, not one per tick', async () => {
  const page = await ready();
  for (let minute = 1; minute <= 3; minute++) {
    await page.advance(59_000);
    assert.equal(page.reads('abc'), 2 + minute - 1, `before minute ${minute}`);
    await page.advance(1_000);
    assert.equal(page.reads('abc'), 2 + minute, `at minute ${minute}`);
  }
});

test('p3: a hidden page does not read; when it is visible again the next tick reads', async () => {
  const page = await ready();
  page.doc.hidden = true;
  await page.advance(300_000);
  assert.equal(page.reads('abc'), 2);
  page.doc.hidden = false;
  await page.advance(1);
  assert.equal(page.reads('abc'), 3);
});

test('p4: on any other tab of the column it does not read; going back to Tasks reads at once (RP149) and the minute starts again from there', async () => {
  const page = await ready();
  await page.changesTab();
  await page.advance(300_000);
  assert.equal(page.reads('abc'), 2);
  await page.tasksTab();
  assert.equal(page.reads('abc'), 3);
  await page.advance(59_000);
  assert.equal(page.reads('abc'), 3);
  await page.advance(1_000);
  assert.equal(page.reads('abc'), 4);
});

test('p5: when the person changes repo it does not read the one they left; the new one follows its own clock and its own tab', async () => {
  const page = await ready();
  page.routes[RM('xyz')] = () => ok(roadmap(ROW('X1', 'Pendiente')));
  await page.open('xyz');
  const before = page.reads('abc');
  await page.advance(300_000);
  assert.equal(page.reads('abc'), before, 'the repo that was left is not read');
  assert.equal(page.reads('xyz'), 1, 'the new repo is on its opening tab, not Tasks: only the read of the opening');
  await page.tasksTab();
  const atTab = page.reads('xyz');
  await page.advance(60_000);
  assert.equal(page.reads('xyz'), atTab + 1);
  assert.equal(page.reads('abc'), before);
});

test('p6: a read that is on its way is the one that answers: no second request is started while it lasts', async () => {
  const page = await ready();
  page.routes[RM('abc')] = () => new Promise(() => {});
  await page.advance(60_000);
  assert.equal(page.reads('abc'), 3);
  await page.advance(10_000);
  await page.advance(120_000);
  assert.equal(page.reads('abc'), 3);
});

test('p7: a server that fails is tried once a minute, never more, and the last good list stays on screen', async () => {
  const page = await ready();
  assert.match(page.col(), /Delivery of C1/);
  page.routes[RM('abc')] = () => fail();
  await page.advance(60_000);
  assert.equal(page.reads('abc'), 3);
  assert.match(page.col(), /Delivery of C1/, 'the good answer is still there');
  await page.advance(10_000);
  await page.advance(10_000);
  assert.equal(page.reads('abc'), 3, 'a failed try is still a try: no hammering');
  await page.advance(40_000);
  assert.equal(page.reads('abc'), 4);
  page.routes[RM('abc')] = () => ok(roadmap(ROW('A1', 'Completada'), ROW('C1', 'Pendiente', 'Back again')));
  await page.advance(60_000);
  assert.match(page.col(), /Back again/);
});

test('p8: on a phone it reads only while the Repo screen is the one on screen', async () => {
  const page = boot(500);
  page.routes[RM('abc')] = () => ok(roadmap(ROW('A1', 'Completada'), ROW('C1', 'Pendiente')));
  await page.open('abc');
  page.run("ACTIONS['zone-set']({ dataset: { zone: 'repo' } })");
  await page.tick();
  await page.tasksTab();
  const base = page.reads('abc');
  page.run("ACTIONS['zone-set']({ dataset: { zone: 'chat' } })");
  await page.tick();
  await page.advance(300_000);
  assert.equal(page.reads('abc'), base, 'the column is out of sight on the chat screen');
  page.run("ACTIONS['zone-set']({ dataset: { zone: 'repo' } })");
  await page.tick();
  await page.advance(1);
  assert.equal(page.reads('abc'), base + 1);
});

test('p9: with no repo open the tick does nothing and never throws', async () => {
  const page = boot();
  await page.advance(300_000);
  assert.deepEqual(page.fetches.filter((f) => f.url.startsWith('/api/roadmap')), []);
});

test('w1: the page really runs the tick every few seconds, and it writes nothing (only reads)', () => {
  const src = appSource();
  assert.match(src, /setInterval\(tasksTick, \d+\);/);
  const fn = /function tasksTick\(\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'tasksTick exists');
  assert.doesNotMatch(fn[0], /method:\s*'POST'|api\(`\/api\/(?!roadmap)/);
  assert.match(fn[0], /loadTasks\(\{ force: true \}\)/);
});
