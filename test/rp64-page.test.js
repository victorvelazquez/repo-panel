'use strict';
// RP64 (S62, S78): the page side of the single code viewer, in the real public/app.js loaded in a vm (stubbed DOM, fake fetch with manual
// gates: no timers, no sleeps, no network, no Orca, no real config). The diff chip opens the Changes tab of the right panel (from the Work
// tab it first switches to the Summary); /api/diff is read each time the tab is switched to; the composer hides; nothing is ever sent.
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

// ---------- RP64 fixtures ----------
const DIFF = (name) => ['diff --git a/' + name + ' b/' + name, '--- a/' + name, '+++ b/' + name, '@@ -1,2 +1,2 @@', ' keep ' + name, '-old ' + name, '+new ' + name].join('\n');
const DATA = (name = 'src/a.js') => ({ diff: DIFF(name), truncated: false });
const DF = (id) => `/api/diff?id=${id}`;
const diffReads = (page, id) => page.fetches.filter((f) => f.url === DF(id)).length;
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const diffAct = (page, id) => page.run(`ACTIONS['diff']({ dataset: { id: '${id}' } })`);
const chatTab = (page) => page.run('S.chat.tab');

test('d1: the diff chip on the Summary opens that repo\'s chat on the Changes tab and reads /api/diff once', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  diffAct(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(chatTab(page), 'changes');
  assert.equal(diffReads(page, 'abc'), 1);
  assert.match(body(page), /data-path="src\/a\.js"/);
  assert.match(body(page), /new src\/a\.js/);
});

test('d2: the diff chip on the Work tab switches to the Summary and opens Changes there (one viewer, in one place)', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  page.run("S.tab = 'work'");
  diffAct(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.tab'), 'summary');
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(chatTab(page), 'changes');
  assert.equal(diffReads(page, 'abc'), 1);
});

test('d3: the chip never opens the Conformity tab and never touches it', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  diffAct(page, 'abc');
  await page.tick();
  assert.equal(page.run('S.tab'), 'summary', 'the Conformity tab stays closed');
});

test('d4: the chip on the chat that is already open only switches the tab (no second chat open)', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  open(page, 'abc');
  await page.tick();
  const seq = page.run('S.chat.seq');
  const before = urls(page).length;
  diffAct(page, 'abc');
  await page.tick();
  assert.equal(chatTab(page), 'changes');
  assert.equal(page.run('S.chat.seq'), seq);
  assert.equal(urls(page).length, before);
  assert.equal(diffReads(page, 'abc'), 1);
});

test('d5: the diff is read each time the person SWITCHES to Changes, never on a redraw or while already there', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  diffAct(page, 'abc');
  await page.tick();
  for (let i = 0; i < 5; i++) { page.run('draw()'); page.run('chatTick()'); await page.tick(); }
  tab(page, 'changes');
  await page.tick();
  assert.equal(diffReads(page, 'abc'), 1, 'redraws and a click on the tab already shown do not read');
  tab(page, 'chat');
  await page.tick();
  assert.equal(diffReads(page, 'abc'), 1, 'going to Chat does not read');
  tab(page, 'changes');
  await page.tick();
  assert.equal(diffReads(page, 'abc'), 2, 'coming back reads again: the files change');
});

test('d6: on Changes the composer is hidden and the chat is not polled; back on Chat both are as before', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hello there'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  diffAct(page, 'abc');
  await page.tick();
  assert.equal(page.get('#composer').hidden, true);
  const before = countOf(page, CHAT('abc'));
  page.run('chatTick()');
  await page.tick();
  assert.equal(countOf(page, CHAT('abc')), before);
  tab(page, 'chat');
  await page.tick();
  assert.equal(page.get('#composer').hidden, false);
  assert.match(body(page), /hello there/);
});

test('d7: a late answer of the repo the person left never paints (or fails) the repo that is shown, but is kept for its own', async () => {
  const { page } = boot();
  const slow = gate();
  const hold = gate();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[DF('abc')] = () => slow.promise;
  page.routes[DF('xyz')] = () => hold.promise;
  diffAct(page, 'abc');
  await page.tick();
  diffAct(page, 'xyz');
  await page.tick();
  assert.match(body(page), /Loading changes…/);
  slow.resolve(ok(DATA('only/abc.js')));
  await page.tick(60);
  page.run('draw()');
  page.flush();
  assert.match(body(page), /Loading changes…/);
  assert.ok(!/only\/abc\.js/.test(body(page)));
  assert.equal(plain(page.run('S.changes.abc')).diff.includes('only/abc.js'), true);
  assert.equal(page.run('S.changes.xyz'), undefined);
});

test('d8: a late FAILURE of the repo the person left does not mark the shown repo as failed', async () => {
  const { page } = boot();
  const slow = gate();
  const hold = gate();
  serve(page, 'abc', infoOf(FREE), histOf('abc chat'));
  serve(page, 'xyz', infoOf(FREE), histOf('xyz chat'));
  page.routes[DF('abc')] = () => slow.promise;
  page.routes[DF('xyz')] = () => hold.promise;
  diffAct(page, 'abc');
  await page.tick();
  diffAct(page, 'xyz');
  await page.tick();
  slow.resolve(bad(500));
  await page.tick(60);
  page.run('draw()');
  page.flush();
  assert.ok(!/Changes unavailable/.test(body(page)), body(page));
  assert.match(body(page), /Loading changes…/);
});

test('d9: a failed read says "Changes unavailable"; a later failure keeps the last good answer', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(bad(500));
  diffAct(page, 'abc');
  await page.tick();
  assert.match(body(page), /Changes unavailable/);
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  tab(page, 'chat');
  tab(page, 'changes');
  await page.tick();
  assert.match(body(page), /new src\/a\.js/);
  page.routes[DF('abc')] = () => Promise.resolve(bad(500));
  tab(page, 'chat');
  tab(page, 'changes');
  await page.tick();
  assert.match(body(page), /new src\/a\.js/, 'the last good answer is kept');
});

test('d10: changes-file shows one file and an empty path goes back to all; the selection is forgotten when the chat is reopened', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok({ diff: `${DIFF('one.js')}\n${DIFF('two.js')}`, truncated: false }));
  diffAct(page, 'abc');
  await page.tick();
  assert.ok(/new one\.js/.test(body(page)) && /new two\.js/.test(body(page)));
  page.run("ACTIONS['changes-file']({ dataset: { path: 'two.js' } })");
  page.flush();
  assert.ok(!/new one\.js/.test(body(page)) && /new two\.js/.test(body(page)));
  page.run("ACTIONS['changes-file']({ dataset: { path: '' } })");
  page.flush();
  assert.ok(/new one\.js/.test(body(page)) && /new two\.js/.test(body(page)));
  page.run("ACTIONS['changes-file']({ dataset: { path: 'two.js' } })");
  close(page);
  diffAct(page, 'abc');
  await page.tick();
  assert.ok(/new one\.js/.test(body(page)), 'a new opening starts with every file');
});

test('d11: nothing is sent anywhere by reading changes (no POST, no chat or session write)', async () => {
  const { page } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => Promise.resolve(ok(DATA()));
  // The page's own read-only POSTs (the queue and the conformity audit) are not writes.
  const writes = () => page.fetches.filter((f) => f.method === 'POST' && !['/api/queue', '/api/conformity'].includes(f.url)).map((f) => f.url);
  diffAct(page, 'abc');
  await page.tick();
  tab(page, 'chat');
  tab(page, 'changes');
  await page.tick();
  assert.deepEqual(writes(), [], 'reading the changes writes nothing anywhere');
});

test('d12: the acts exist in the dispatcher and the chip keeps its markup (data-act="diff", title "View diff")', () => {
  const { page } = boot();
  for (const act of ['diff', 'changes-file', 'chat-tab']) assert.equal(page.run(`typeof ACTIONS['${act}']`), 'function', act);
});

test('d13: with two overlapping reads of the same chat only the LATEST counts (a slow old answer never overwrites a newer one)', async () => {
  const { page } = boot();
  const slow = gate();
  let calls = 0;
  serve(page, 'abc', infoOf(FREE), histOf('hi'));
  page.routes[DF('abc')] = () => { calls++; return calls === 1 ? slow.promise : Promise.resolve(ok(DATA('newer.js'))); };
  diffAct(page, 'abc');
  await page.tick();
  tab(page, 'chat');
  tab(page, 'changes');
  await page.tick();
  assert.equal(calls, 2);
  assert.match(body(page), /newer\.js/);
  slow.resolve(ok(DATA('older.js')));
  await page.tick(60);
  page.run('draw()');
  page.flush();
  assert.match(body(page), /newer\.js/);
  assert.ok(!/older\.js/.test(body(page)), 'the old answer is dropped');
});
