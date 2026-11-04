'use strict';
// RP100 (S5, S7): pi does not lock its session files (L7), so the panel cannot know that a session is open in a terminal. The hint it has is the time of the last write of the session file, which the
// list already carries (`updatedAt`). A session written to less than 2 minutes ago gets a tag in its row and its Open button asks first. Page only: the server does not change. A terminal that is open
// but quiet is not detected: it is a hint, not a guarantee. No network, no clock of the machine in the pure tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const NOW = Date.parse('2026-05-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60000;

test('recentlyActive: less than 2 minutes ago is recent; exactly 2 minutes or more is not', () => {
  assert.equal(R.recentlyActive({ updatedAt: ago(0) }, NOW), true);
  assert.equal(R.recentlyActive({ updatedAt: ago(30 * 1000) }, NOW), true);
  assert.equal(R.recentlyActive({ updatedAt: ago(2 * MIN - 1000) }, NOW), true);
  assert.equal(R.recentlyActive({ updatedAt: ago(2 * MIN) }, NOW), false);
  assert.equal(R.recentlyActive({ updatedAt: ago(2 * MIN + 1000) }, NOW), false);
  assert.equal(R.recentlyActive({ updatedAt: ago(3 * 3600 * 1000) }, NOW), false);
});

test('recentlyActive: a clock a little ahead still counts, one far ahead does not (a wrong date must not warn forever)', () => {
  assert.equal(R.recentlyActive({ updatedAt: ago(-30 * 1000) }, NOW), true);
  assert.equal(R.recentlyActive({ updatedAt: ago(-(2 * MIN - 1000)) }, NOW), true);
  assert.equal(R.recentlyActive({ updatedAt: ago(-2 * MIN) }, NOW), false);
  assert.equal(R.recentlyActive({ updatedAt: ago(-3600 * 1000) }, NOW), false);
});

test('recentlyActive is total: anything that is not a session with a valid date is not recent', () => {
  for (const bad of [null, undefined, {}, { updatedAt: '' }, { updatedAt: 'yesterday' }, { updatedAt: 5 }, { updatedAt: null }, { updatedAt: {} }, { updatedAt: new Date(NOW) }, { updatedAt: [ago(0)] }, 'text', 7, []]) assert.equal(R.recentlyActive(bad, NOW), false, JSON.stringify(bad)); // only the ISO text the server gives counts: a Date object or an array would be read as a date by Date.parse
  assert.equal(R.recentlyActive({ updatedAt: ago(0) }, NaN), false);
  assert.equal(R.recentlyActive({ updatedAt: ago(0) }, undefined), false);
  assert.equal(R.recentlyActive({ updatedAt: ago(0) }, 'now'), false);
});

const info = (sessions) => ({ key: 'r1', adopted: null, adoptedFound: false, sessions, live: { state: 'none', count: 0 } });
const sess = (id, o = {}) => ({ id, name: null, updatedAt: ago(3600 * 1000), lastMessage: { role: 'user', text: 'words' }, ...o });
const body = (c) => R.chatBody({ id: 'r1', ...c }, { now: NOW });
const rowOf = (html, id) => (html.split('<div class="ch-pick">').find((x) => x.includes(`data-session="${id}"`)) || '');

test('the row of a recently written session has the tag and its Open button says so; the other rows are as before', () => {
  const html = body({ info: info([sess('fresh', { updatedAt: ago(20 * 1000) }), sess('old'), sess('edge', { updatedAt: ago(2 * MIN) })]) });
  const fresh = rowOf(html, 'fresh');
  assert.match(fresh, /<span class="ch-busy"[^>]*>Active a moment ago, it may be open in a terminal<\/span>/);
  assert.match(fresh, /data-act="chat-adopt" data-id="r1" data-session="fresh" data-recent="1"/);
  for (const id of ['old', 'edge']) {
    assert.doesNotMatch(rowOf(html, id), /ch-busy|data-recent/, id);
    assert.match(rowOf(html, id), new RegExp(`data-act="chat-adopt" data-id="r1" data-session="${id}"[^>]*>Open</button>`));
  }
  assert.equal((html.match(/ch-busy/g) || []).length, 1);
  assert.equal((html.match(/data-act="chat-adopt"/g) || []).length, 3, 'the list is the same list');
});

test('the tag does not change what is disabled: Open stays disabled while a session starts and keeps its mark', () => {
  const html = body({ info: info([sess('fresh', { updatedAt: ago(1000) })]), starting: true });
  assert.match(html, /data-session="fresh" data-recent="1" disabled>Open<\/button>/);
});

test('the tag is fixed text and the id of the session is still escaped', () => {
  const html = body({ info: info([sess('<img src=x onerror=1>', { updatedAt: ago(1000) })]) });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /ch-busy/);
});

// ---------- the page: Open asks first for a recent session ----------
function element(extra = {}) {
  const el = { html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', placeholder: '', attrs: {}, children: [], writes: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {}, get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra };
  return el;
}
const ok = (b) => ({ ok: true, json: async () => b });
function loadPage() {
  const frames = []; const fetches = []; const routes = []; const confirms = [];
  const state = { answer: true };
  const els = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const respond = (url, opts) => { for (const [m, fn] of routes) if (m(url)) return fn(url, opts); return new Promise(() => {}); };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: (m) => { confirms.push(m); return state.answer; },
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { get, tick, routes, fetches, confirms, state, run: (c) => vm.runInContext(c, ctx) };
}
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 1, completada: 0, enRevision: 0, bloqueada: 0, pendiente: 1, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMessage: {}, lastMovement: {}, activity: null });
async function boot() {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  const real = Date.now();
  const sessions = [sess('fresh', { updatedAt: new Date(real - 20 * 1000).toISOString() }), sess('old', { updatedAt: new Date(real - 3600 * 1000).toISOString() })];
  page.routes.push([(u) => u.startsWith('/api/sessions?'), () => Promise.resolve(ok({ key: 'abc', adopted: null, adoptedFound: false, sessions, live: { state: 'none', count: 0 } }))]);
  page.routes.push([(u) => u.startsWith('/api/chat?'), () => Promise.resolve(ok({ items: [], truncated: false }))]);
  page.routes.push([(u) => u.startsWith('/api/rpc/status'), () => Promise.resolve(ok({ state: 'closed', pendingDialogs: [], sessionId: null }))]);
  page.routes.push([(u) => u === '/api/sessions/adopt', () => Promise.resolve(ok({}))]);
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  await page.tick();
  return page;
}
const adopts = (page) => page.fetches.filter((f) => f.url === '/api/sessions/adopt' && f.method === 'POST');

test('the painted list tags the recent session and not the old one (the page uses the clock of the machine)', async () => {
  const page = await boot();
  const html = page.get('#chatBody').html;
  assert.match(rowOf(html, 'fresh'), /ch-busy/);
  assert.match(rowOf(html, 'fresh'), /data-recent="1"/);
  assert.doesNotMatch(rowOf(html, 'old'), /ch-busy|data-recent/);
});

test('Open on a recent session asks first, and refusing sends nothing; the question names the risk', async () => {
  const page = await boot();
  page.state.answer = false;
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'fresh', recent: '1' } })"); // not awaited: if it were let through it would not be asked first
  await page.tick();
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /terminal/i);
  assert.match(page.confirms[0], /history/i);
  assert.equal(adopts(page).length, 0);
});

test('accepting adopts it as usual', async () => {
  const page = await boot();
  page.state.answer = true;
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'fresh', recent: '1' } })");
  await page.tick();
  assert.equal(page.confirms.length, 1);
  assert.equal(adopts(page).length, 1);
  assert.deepEqual(JSON.parse(adopts(page)[0].body), { id: 'abc', session: 'fresh' });
});

test('Open on an old session never asks', async () => {
  const page = await boot();
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'old' } })");
  await page.tick();
  assert.equal(page.confirms.length, 0);
  assert.equal(adopts(page).length, 1);
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'old', recent: '' } })");
  await page.tick();
  assert.equal(page.confirms.length, 0, 'an empty mark is not a mark');
});

test('while a session is starting, Open still does nothing and does not even ask (RP99 stays as it was)', async () => {
  const page = await boot();
  page.run('S.chat.starting = true');
  page.run("ACTIONS['chat-adopt']({ dataset: { id: 'abc', session: 'fresh', recent: '1' } })");
  await page.tick();
  assert.equal(page.confirms.length, 0);
  assert.equal(adopts(page).length, 0);
});

test('the list uses the space of the chat: the box takes the whole width and the height that is left (it shrinks and scrolls inside the chat), with no fixed cap', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const rule = (sel) => (new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css) || [])[1] || '';
  const state = rule('.ch-state');
  assert.match(state, /display:\s*flex/);
  assert.match(state, /flex-direction:\s*column/);
  assert.match(state, /flex:\s*1 1 auto/, 'the state block fills the chat body');
  assert.match(state, /min-height:\s*0/);
  assert.doesNotMatch(state, /justify-items:\s*start/, 'children must not shrink to their content');
  const picks = rule('.ch-picks');
  assert.match(picks, /align-self:\s*stretch/, 'the box takes the whole width');
  assert.match(picks, /min-height:\s*0/);
  assert.match(picks, /overflow-y:\s*auto/);
  assert.match(picks, /max-height:\s*100%/, 'as high as the chat leaves it');
  assert.doesNotMatch(picks, /max-height:[^;]*\d(px|vh)/, 'no fixed cap on the list (the gap of the rows may be in px)');
  assert.match(rule('.ch-pick'), /flex:\s*none/, 'a row never squashes: the box scrolls instead');
});

test('the CSS has a rule for the tag, and the README says what it is and what it cannot see', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.ch-busy\s*\{[^}]*color:/);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /2 minutes/);
  assert.match(readme, /terminal/);
  assert.match(readme, /does not lock/i);
});
