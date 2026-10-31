'use strict';
// RP63 (S60, S77): the page side of the Tasks tab, in the real public/app.js loaded in a vm (stubbed DOM, fake fetch with manual gates:
// no timers, no sleeps, no network, no Orca, no real config). The roadmap is asked from the page, once per chat opening, and never
// when the tab is not shown; the composer hides on the Tasks tab; nothing here ever sends text to a session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- harness (copied from rp75-optimistic.test.js: elements that keep their html; requests are held until a test answers) ----------
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

// `routes` maps an exact url to (url, opts) => a response promise. Any other url never answers (a held request).
function loadPage() {
  const els = {};
  const frames = [];
  const intervals = [];
  const fetches = [];
  const routes = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener() {}, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, signal: opts.signal });
      return routes[url] ? routes[url](url, opts) : new Promise(() => {});
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { ctx, get, flush, tick, fetches, routes, run: (code) => vm.runInContext(code, ctx) };
}

// ---------- fixtures ----------
const ASK = {
  state: 'waiting', count: 1,
  dialog: { lines: ['Proceed?'], selected: 0, choices: { fingerprint: 'f1', complete: true, options: [{ label: 'Yes', tone: 'affirmative' }, { label: 'No', tone: 'negative' }] } },
};
const FREE = { state: 'free', count: 1 };
const infoOf = (live, o = {}) => ({ key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [], live, ...o });
const histOf = (...texts) => ({ key: 'abc', sessionId: 's1', found: true, items: texts.map((text) => ({ role: 'user', text, at: null, tools: [] })), truncated: false, updatedAt: null });
const ok = (body) => ({ ok: true, json: async () => body });
const bad = (status = 500) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const gate = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plain = (x) => JSON.parse(JSON.stringify(x));
const keyOf = (info, hist) => JSON.stringify([info, hist]);

const SES = (id) => `/api/sessions?id=${id}`;
const CHAT = (id) => `/api/chat?id=${id}`;
const R_ABC = { id: 'abc', name: 'demo', path: 'p' };
const R_XYZ = { id: 'xyz', name: 'other', path: 'q' };
const localOf = () => ({ branch: 'main', detached: false, upstream: 'origin/main', noUpstream: false, ahead: 0, behind: 0, files: [{ path: 'a.txt', status: 'M', untracked: false }], added: 1, deleted: 0, head: 'h1', inProgress: null, base: 'main' });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9 });

// Summary tab with two repos, no request answered yet.
function boot() {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [R_ABC, R_XYZ] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  for (const r of [R_ABC, R_XYZ]) { S.local[r.id] = localOf(); S.prs[r.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } }; }
  return { page, S };
}
// Hold both reads of a repo: each answers when its gate is resolved.
function hold(page, id, { sessions = gate(), chat = gate() } = {}) {
  page.routes[SES(id)] = () => sessions.promise;
  page.routes[CHAT(id)] = () => chat.promise;
  return { sessions, chat };
}
function serve(page, id, info, hist) {
  page.routes[SES(id)] = () => Promise.resolve(ok(info));
  page.routes[CHAT(id)] = () => Promise.resolve(ok(hist));
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const close = (page) => page.run("ACTIONS['chat-close']({})");
const body = (page) => page.get('#chatBody').html;
const label = (page) => page.get('#sessState').html;
const chatState = (page) => plain(page.run('S.chat'));
// Only the chat reads: boot() also leaves its own requests (/api/config and others) in the list.
const urls = (page) => page.fetches.map((f) => f.url).filter((u) => /^\/api\/(sessions|chat)\?/.test(u));
const countOf = (page, url) => urls(page).filter((u) => u === url).length;

// ---------- RP63 fixtures ----------
const ROW = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...over });
const ROADMAP = { available: true, rows: [ROW('A1', 'Completada'), ROW('B1', 'En curso'), ROW('C1', 'Pendiente')], derived: {}, next: ROW('C1', 'Pendiente') };
const RM = (id) => `/api/roadmap?id=${id}`;
const roadmapReads = (page, id) => page.fetches.filter((f) => f.url === RM(id)).length;
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const tasksOpen = (page, id) => page.run(`ACTIONS['tasks-open']({ dataset: { id: '${id}' } })`);
const chatTab = (page) => page.run('S.chat.tab');

test('p1: tasks-open on a closed chat opens that repo\'s chat on the Tasks tab and asks /api/roadmap once', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(chatTab(page), 'tasks');
  assert.equal(roadmapReads(page, 'abc'), 1);
  assert.match(body(page), />B1</);
  assert.match(body(page), /task-next/);
});

test('p2: tasks-open on the chat that is already open only switches the tab (no second chat open, no stray reads)', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  const seq = page.run('S.chat.seq');
  const before = urls(page).length;
  tasksOpen(page, 'abc');
  await page.tick();
  assert.equal(chatTab(page), 'tasks');
  assert.equal(page.run('S.chat.seq'), seq, 'the chat was not reopened');
  assert.equal(urls(page).length, before, 'no new session or chat read');
  assert.equal(roadmapReads(page, 'abc'), 1);
});

test('p3: the Chat tab is the default and its body is the chat, with the composer visible', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hello there'));
  open(page, 'abc');
  await page.tick();
  assert.ok(chatTab(page) === undefined || chatTab(page) === 'chat');
  assert.match(body(page), /hello there/);
  assert.equal(page.get('#composer').hidden, false);
  assert.match(page.get('#chatHead').html, /data-tab="chat"[^>]*aria-selected="true"/);
});

test('p4: on the Tasks tab the composer is hidden and the body is the tasks; going back restores both without a new roadmap read', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hello there'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  tab(page, 'tasks');
  await page.tick();
  assert.equal(page.get('#composer').hidden, true);
  assert.ok(!/hello there/.test(body(page)));
  assert.match(page.get('#chatHead').html, /data-tab="tasks"[^>]*aria-selected="true"/);
  tab(page, 'chat');
  await page.tick();
  assert.equal(page.get('#composer').hidden, false);
  assert.match(body(page), /hello there/);
  tab(page, 'tasks');
  await page.tick();
  assert.equal(roadmapReads(page, 'abc'), 1, 'the answer is kept for this repo');
});

test('p5: the roadmap is asked ONCE per chat opening: redraws and the 60 s chat polling do not ask again', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  for (let i = 0; i < 5; i++) { page.run('draw()'); page.run('chatTick()'); await page.tick(); }
  assert.equal(roadmapReads(page, 'abc'), 1);
});

test('p6: while the Tasks tab is shown the chat is not polled', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  const before = countOf(page, CHAT('abc'));
  page.run('chatTick()');
  await page.tick();
  assert.equal(countOf(page, CHAT('abc')), before);
  tab(page, 'chat');
  await page.tick();
  page.run('chatTick()');
  await page.tick();
  assert.ok(countOf(page, CHAT('abc')) > before, 'back on the chat the polling is the same as today');
});

test('p7: a stale roadmap answer after the person switched repo is ignored', async () => {
  const { page } = boot();
  const slow = gate();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[RM('abc')] = () => slow.promise;
  page.routes[RM('xyz')] = () => Promise.resolve(ok({ ...ROADMAP, rows: [ROW('XX1', 'Pendiente')], next: null }));
  tasksOpen(page, 'abc');
  await page.tick();
  tasksOpen(page, 'xyz');
  await page.tick();
  slow.resolve(ok(ROADMAP));
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'xyz');
  assert.match(body(page), />XX1</);
  assert.ok(!/>B1</.test(body(page)), 'the answer of abc never paints xyz');
});

test('p8: a failed request shows the unavailable message; a later failure keeps the last good answer', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(bad(500));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.match(body(page), /Roadmap unavailable/);
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  close(page);
  tasksOpen(page, 'abc');
  await page.tick();
  assert.match(body(page), />B1</);
  page.routes[RM('abc')] = () => Promise.resolve(bad(500));
  close(page);
  tasksOpen(page, 'abc');
  await page.tick();
  assert.match(body(page), />B1</, 'the last good answer is kept');
});

test('p9: a repo without a ROADMAP says so in the tab', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok({ available: false, reason: 'missing' }));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.match(body(page), /No docs\/ROADMAP\.md in this repo/);
});

test('p10: tasks-done toggles the Completed group', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.ok(!/>A1</.test(body(page)));
  page.run("ACTIONS['tasks-done']({})");
  await page.tick();
  assert.match(body(page), />A1</);
  page.run("ACTIONS['tasks-done']({})");
  await page.tick();
  assert.ok(!/>A1</.test(body(page)));
});

test('p11: the filter keeps its value across redraws and filters the rows', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  assert.match(body(page), /id="tasksFilter"/);
  assert.match(body(page), /aria-label="Filter tasks"/);
  page.get('#tasksFilter').value = 'c1';
  page.run("ACTIONS['tasks-filter'] ? ACTIONS['tasks-filter'](document.querySelector('#tasksFilter')) : 0");
  await page.tick();
  assert.ok(/>C1</.test(body(page)) && !/>B1</.test(body(page)));
  for (let i = 0; i < 3; i++) { page.run('draw()'); await page.tick(); }
  assert.match(body(page), /id="tasksFilter"[^>]*value="c1"/, 'the box is painted with the value the person typed');
  assert.ok(!/>B1</.test(body(page)));
});

test('p12: a filter typed in the box never reaches a request or the chat', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  const n = page.fetches.length;
  const posts = page.fetches.filter((f) => f.method === 'POST').length;
  page.get('#tasksFilter').value = 'anything';
  page.run("ACTIONS['tasks-filter'] ? ACTIONS['tasks-filter'](document.querySelector('#tasksFilter')) : 0");
  await page.tick();
  assert.equal(page.fetches.length, n);
  assert.equal(page.fetches.filter((f) => f.method === 'POST').length, posts, 'nothing is sent anywhere');
});

test('p13: switching to the chat of another repo goes back to the Chat tab', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  tasksOpen(page, 'abc');
  await page.tick();
  open(page, 'xyz');
  await page.tick();
  assert.ok(chatTab(page) === undefined || chatTab(page) === 'chat');
  assert.match(body(page), /xyz chat/);
});

test('p14: the tab buttons and the card bar are reachable from the dispatcher (acts exist)', () => {
  const { page } = boot();
  for (const act of ['tasks-open', 'chat-tab', 'tasks-done', 'tasks-filter']) assert.equal(page.run(`typeof ACTIONS['${act}']`), 'function', act);
});

test('p15: a late answer of the repo the person left is kept for it but never paints (or fails) the repo that is shown', async () => {
  const { page } = boot();
  const slow = gate();
  const hold = gate();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[RM('abc')] = () => slow.promise;
  page.routes[RM('xyz')] = () => hold.promise;
  tasksOpen(page, 'abc');
  await page.tick();
  tasksOpen(page, 'xyz');
  await page.tick();
  assert.match(body(page), /Loading tasks…/);
  slow.resolve(ok(ROADMAP));
  await page.tick(60);
  page.run('draw()');
  page.flush();
  assert.match(body(page), /Loading tasks…/, 'the answer of abc does not paint xyz');
  assert.equal(plain(page.run('S.tasks.abc')).rows.length, 3, 'it is kept for abc');
  assert.equal(page.run('S.tasks.xyz'), undefined);
});

test('p16: a late FAILURE of the repo the person left does not mark the shown repo as failed', async () => {
  const { page } = boot();
  const slow = gate();
  const hold = gate();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[RM('abc')] = () => slow.promise;
  page.routes[RM('xyz')] = () => hold.promise;
  tasksOpen(page, 'abc');
  await page.tick();
  tasksOpen(page, 'xyz');
  await page.tick();
  slow.resolve(bad(500));
  await page.tick(60);
  page.run('draw()');
  page.flush();
  assert.ok(!/Roadmap unavailable/.test(body(page)), body(page));
  assert.match(body(page), /Loading tasks…/);
});

test('p17: choosing the Chat tab explicitly never reads the roadmap', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[RM('abc')] = () => Promise.resolve(ok(ROADMAP));
  open(page, 'abc');
  await page.tick();
  tab(page, 'chat');
  await page.tick();
  assert.equal(roadmapReads(page, 'abc'), 0);
});
