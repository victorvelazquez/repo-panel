'use strict';
// RP76 (S68), page side: api() marks every POST (and the GETs that a click causes) with x-priority: user, gives every request a time limit
// (S.timeouts, 25 s for a GET and 70 s for a POST) with an AbortSignal, and the chat of the card that was just opened is cancelled when the
// person switches card or closes it. The real public/app.js in a vm with a fake fetch, fake timers and no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- harness (copied from rp75-optimistic.test.js, plus timers, AbortController and captured fetch init) ----------
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

function loadPage({ answers = {} } = {}) {
  const els = {};
  const frames = [];
  const docL = {};
  const store = {};
  const fetches = [];
  const timers = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, AbortController,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, confirm: () => true,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    fetch: (url, opts = {}) => {
      fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, signal: opts.signal, body: opts.body });
      const a = Object.entries(answers).find(([k]) => url.startsWith(k));
      if (!a) return new Promise(() => {});
      return typeof a[1] === 'function' ? a[1](url, opts) : Promise.resolve({ ok: true, json: async () => a[1] });
    },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  return { ctx, get, flush, tick, fetches, timers, run: (code) => vm.runInContext(code, ctx) };
}

// A fetch that never answers but rejects like a browser when its signal aborts.
const hang = (url, opts) => new Promise((resolve, reject) => {
  if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});
const reply = (body) => Promise.resolve({ ok: true, json: async () => body });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const sess = (o = {}) => ({ id: 's1', name: 'panel:alpha', updatedAt: '2026-05-01T11:00:00Z', lastMessage: { role: 'user', text: 'last words' }, ...o });
const ADOPTED = { key: 'abc', adopted: { id: 's1', name: 'panel:demo', adoptedAt: 'x' }, adoptedFound: true, sessions: [sess()], live: { state: 'free', count: 1 } };
const histOf = (text) => ({ key: 'abc', sessionId: 's1', found: true, items: [{ role: 'user', text, at: null, tools: [] }], truncated: false, updatedAt: null });
const card = (o = {}) => ({
  id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' },
  next: null, blocking: [], lastMovement: { at: '2026-05-01T11:48:00Z', what: 'x' }, action: null, error: null, needs: false, rank: 9, ...o,
});

// Summary tab with two repos (abc, xyz); the chat is opened with openChat().
function chatPage(answers) {
  const page = loadPage({ answers });
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card(), card({ id: 'xyz', name: 'other' })], generatedAt: 'x' };
  page.run('draw()');
  return { page, S };
}
// The fake fetch takes the FIRST key the url starts with: the specific answers go before the generic ones.
// The fake fetch takes the FIRST key the url starts with: the specific answers go first, and a generic one only when the test did not replace it.
const chatAnswers = (extra = {}) => ({ ...extra, ...Object.fromEntries(Object.entries({ '/api/sessions': ADOPTED, '/api/chat': histOf('hello there') }).filter(([k]) => !(k in extra))) });
const withUrl = (page, part) => page.fetches.filter((f) => f.url.includes(part));

// ---------- 1. priority header ----------
test('every POST carries x-priority: user; a GET carries it only when the caller asks', async () => {
  const page = loadPage({ answers: { '/api/probe': {} } });
  page.run("api('/api/probe', { id: 'abc' })");
  page.run("api('/api/probe')");
  page.run("api('/api/probe', undefined, { priority: 'user' })");
  await page.tick();
  const [post, plain, asked] = withUrl(page, '/api/probe');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['x-priority'], 'user');
  assert.equal(post.headers['x-token'], 'token', 'the token header stays');
  assert.equal(plain.headers['x-priority'], undefined);
  assert.equal(asked.headers['x-priority'], 'user');
});

test('opening a chat reads /api/sessions and /api/chat with x-priority: user; the periodic chatTick poll does not', async () => {
  const { page } = chatPage(chatAnswers());
  page.run("openChat('abc')");
  await page.tick();
  const opened = [...withUrl(page, '/api/sessions'), ...withUrl(page, '/api/chat')];
  assert.equal(opened.length, 2);
  for (const f of opened) assert.equal(f.headers['x-priority'], 'user', f.url);
  page.fetches.length = 0;
  page.run('chatTick()');
  await page.tick();
  const polled = [...withUrl(page, '/api/sessions'), ...withUrl(page, '/api/chat')];
  assert.equal(polled.length, 2);
  for (const f of polled) assert.equal(f.headers['x-priority'], undefined, f.url);
});

// ---------- 2. time limit ----------
test('the default limits are 25 s for a GET and 70 s for a POST', () => {
  const page = loadPage();
  assert.deepEqual(JSON.parse(JSON.stringify(page.run('S.timeouts'))), { get: 25000, post: 70000 });
});

test('a GET that never answers rejects with a timed-out error and its signal is aborted', async () => {
  const page = loadPage({ answers: { '/api/slow': hang } });
  page.run('S.timeouts = { get: 1111, post: 2222 }');
  const p = Promise.resolve(page.run("api('/api/slow')"));
  const settled = p.then(() => 'resolved', (e) => e);
  await page.tick();
  const timer = page.timers.filter((t) => t.ms === 1111 && !t.cleared);
  assert.equal(timer.length, 1, 'one pending timer with the GET limit');
  const slow = page.fetches.find((f) => f.url === '/api/slow'); // the page makes other requests while loading: find ours by url
  assert.ok(slow && slow.signal && !slow.signal.aborted);
  timer[0].fn();
  const err = await settled;
  assert.ok(err && typeof err.message === 'string', String(err)); // an Error made inside the vm context is not instanceof this realm's Error
  assert.match(err.message, /timed out/i);
  assert.equal(slow.signal.aborted, true);
});

test('a POST uses the POST limit', async () => {
  const page = loadPage({ answers: { '/api/pi': hang } });
  page.run('S.timeouts = { get: 1111, post: 2222 }');
  const settled = Promise.resolve(page.run("api('/api/pi', { id: 'abc' })")).then(() => 'resolved', (e) => e);
  await page.tick();
  assert.equal(page.timers.filter((t) => t.ms === 2222 && !t.cleared).length, 1);
  assert.equal(page.timers.filter((t) => t.ms === 1111).length, 0);
  page.timers.find((t) => t.ms === 2222).fn();
  assert.match((await settled).message, /timed out/i);
});

test('a request that answers in time is not affected and leaves no timer pending (also when it fails)', async () => {
  const page = loadPage({ answers: { '/api/ok': { fine: 1 }, '/api/bad': () => Promise.resolve({ ok: false, status: 500, statusText: 'Boom', json: async () => ({ error: 'Boom' }) }) } });
  page.run('S.timeouts = { get: 1111, post: 2222 }');
  assert.deepEqual(JSON.parse(JSON.stringify(await page.run("api('/api/ok')"))), { fine: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(await page.run("api('/api/ok', { a: 1 })"))), { fine: 1 });
  await assert.rejects(Promise.resolve(page.run("api('/api/bad')")), /Boom/);
  const mine = page.timers.filter((t) => t.ms === 1111 || t.ms === 2222);
  assert.equal(mine.length, 3, 'every request armed its timer');
  assert.ok(mine.every((t) => t.cleared), 'every timer was cleared');
  assert.ok(page.fetches.every((f) => f.signal && !f.signal.aborted));
});

// ---------- 3. cancellation ----------
test('switching card aborts the requests of the previous card; its late answer never overwrites the new card', async () => {
  const late = gate();
  const { page, S } = chatPage(chatAnswers({
    '/api/sessions?id=abc': hang,
    '/api/sessions?id=xyz': { ...ADOPTED, key: 'xyz' },
    '/api/chat?id=xyz': { ...histOf('from B'), key: 'xyz' },
  }));
  page.run("openChat('abc')");
  await page.tick();
  const a = withUrl(page, '/api/sessions?id=abc');
  assert.equal(a.length, 1);
  assert.equal(a[0].signal.aborted, false);
  page.run("openChat('xyz')");
  assert.equal(a[0].signal.aborted, true, 'the request of card A was aborted');
  await page.tick();
  assert.equal(S.chat.id, 'xyz');
  assert.equal(S.chat.info.key, 'xyz');
  assert.ok(!S.chat.failed, 'an aborted request is not "Chat unavailable"');
  assert.equal(page.get('#toasts').children.length, 0, 'and shows no toast');
  late.resolve();
});

test('a late answer of card A (ignoring the abort) never overwrites card B', async () => {
  const lateA = gate();
  const { page, S } = chatPage(chatAnswers({
    '/api/sessions?id=abc': () => lateA.promise,
    '/api/sessions?id=xyz': { ...ADOPTED, key: 'xyz' },
    '/api/chat?id=xyz': { ...histOf('from B'), key: 'xyz' },
    '/api/chat?id=abc': { ...histOf('from A'), key: 'abc' },
  }));
  page.run("openChat('abc')");
  await page.tick();
  page.run("openChat('xyz')");
  await page.tick();
  lateA.resolve({ ok: true, json: async () => ({ ...ADOPTED, key: 'abc' }) });
  await page.tick();
  assert.equal(S.chat.info.key, 'xyz');
  assert.ok(!JSON.stringify(S.chat.hist).includes('from A'));
});

test('closeChat aborts the requests in flight; no failure and no toast', async () => {
  const { page, S } = chatPage(chatAnswers({ '/api/sessions': hang }));
  page.run("openChat('abc')");
  await page.tick();
  const f = withUrl(page, '/api/sessions')[0];
  assert.equal(f.signal.aborted, false);
  page.run('closeChat()');
  assert.equal(f.signal.aborted, true);
  await page.tick();
  assert.equal(S.chat.id, null);
  assert.ok(!S.chat.failed);
  assert.equal(page.get('#toasts').children.length, 0);
});

// ---------- 4. the pool ----------
test('a refresh queue of 30 pending jobs does not delay a request with priority user', async () => {
  const page = loadPage({ answers: { '/api/local': hang, '/api/rooms': { rooms: [] }, '/api/pi': { sent: true } } });
  page.run("for (let i = 0; i < 30; i++) pooled(() => api('/api/local?id=r' + i)).catch(() => {})");
  await page.tick();
  assert.equal(withUrl(page, '/api/local').length, 6, 'the pool still runs 6 refresh calls at a time');
  const before = page.fetches.length;
  page.run("api('/api/rooms', undefined, { priority: 'user' })");
  page.run("api('/api/pi', { id: 'abc' })");
  assert.equal(page.fetches.length, before + 2, 'both were sent in the same tick');
  assert.equal(page.fetches[before].headers['x-priority'], 'user');
});

test('opening a chat while the pool is saturated sends its requests at once', async () => {
  const { page } = chatPage(chatAnswers({ '/api/local': hang }));
  page.run("for (let i = 0; i < 30; i++) pooled(() => api('/api/local?id=r' + i)).catch(() => {})");
  await page.tick();
  page.run("openChat('abc')");
  assert.equal(withUrl(page, '/api/sessions').length, 1, 'sent in the same tick');
  assert.equal(withUrl(page, '/api/sessions')[0].headers['x-priority'], 'user');
});

// ---------- 4. the Summary is slow until RP78: its own limit ----------
test('the Summary request has its own 90 s limit: the 25 s GET limit would cut a 26 s build and show a false failure', async () => {
  const page = loadPage({ answers: { '/api/summary': hang } });
  page.run('S.timeouts = { get: 1111, post: 2222 }');
  page.run('loadSummary()');
  await page.tick();
  assert.ok(page.fetches.find((f) => f.url === '/api/summary'), 'the Summary was requested');
  assert.equal(page.timers.filter((t) => t.ms === 90000 && !t.cleared).length, 1, 'one pending timer with the Summary limit');
  assert.equal(page.timers.filter((t) => t.ms === 1111 && !t.cleared).length, 0, 'not the generic GET limit');
});

test('api(): opts.timeoutMs overrides the limit of the kind of request', async () => {
  const page = loadPage({ answers: { '/api/slow': hang } });
  page.run('S.timeouts = { get: 1111, post: 2222 }');
  page.run("api('/api/slow', undefined, { timeoutMs: 4444 }).catch(() => {})");
  await page.tick();
  assert.equal(page.timers.filter((t) => t.ms === 4444 && !t.cleared).length, 1);
});
