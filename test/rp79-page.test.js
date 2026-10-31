'use strict';
// RP79 (S68, S74), point 2 of the design: the chat is shown at once from a per-repo cache kept by the PAGE (S.chatCache), in the real
// public/app.js loaded in a vm (stubbed DOM, fake fetch with manual gates: no timers, no sleeps, no network, no Orca, no real config).
// Every check of the "at once" rule happens BEFORE any fake response is released.
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

// A cache with the chat of `id` stored the way the page stores it: a real first read (question open, one message), then the chat closed.
async function warm(id = 'abc', info = infoOf(ASK), hist = histOf('cached hello')) {
  const { page, S } = boot();
  serve(page, id, info, hist);
  open(page, id);
  await page.tick();
  close(page);
  page.flush();
  assert.ok(S.chatCache && S.chatCache[id], 'precondition: the first read filled the cache');
  page.fetches.length = 0;
  return { page, S, info, hist };
}

test('a: a successful loadChat stores { info, hist, key } of that repo in S.chatCache, and nothing else (no draft, no pending)', async () => {
  const { page, S } = boot();
  S.drafts.abc = 'secret draft';
  S.pending.abc = [{ text: 'secret pending', state: 'sending', base: 0 }];
  const info = infoOf(FREE);
  const hist = histOf('hello');
  serve(page, 'abc', info, hist);
  assert.deepEqual(Object.keys(plain(S.chatCache)), [], 'precondition: an empty cache owned by the page');
  open(page, 'abc');
  await page.tick();
  assert.deepEqual(Object.keys(plain(S.chatCache)), ['abc']);
  const e = plain(S.chatCache.abc);
  assert.deepEqual({ info: e.info, hist: e.hist, key: e.key }, { info, hist, key: keyOf(info, hist) });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'hist', 'info', 'key']);
  assert.ok(!JSON.stringify(S.chatCache).includes('secret'), 'a draft or a pending message never goes into the cache');
});

test('a: an answer with no adopted session is stored with hist null', async () => {
  const { page, S } = boot();
  const info = infoOf({ state: 'none', count: 0 }, { adopted: null, adoptedFound: false });
  serve(page, 'abc', info, histOf('ignored'));
  open(page, 'abc');
  await page.tick();
  assert.deepEqual(plain(S.chatCache.abc).hist, null);
  assert.equal(plain(S.chatCache.abc).key, keyOf(info, null));
});

test('a: a FAILED read stores nothing, whichever of the two requests fails', async () => {
  for (const [sessions, chat] of [[bad(500), ok(histOf('x'))], [ok(infoOf(FREE)), bad(500)]]) {
    const { page, S } = boot();
    page.routes[SES('abc')] = () => Promise.resolve(sessions);
    page.routes[CHAT('abc')] = () => Promise.resolve(chat);
    open(page, 'abc');
    await page.tick();
    assert.equal(S.chat.failed, true);
    assert.deepEqual(Object.keys(plain(S.chatCache)), [], JSON.stringify([sessions.status, chat.status]));
  }
});

test('a: an SSE applyLive update of the open chat stores the updated { info, hist, key }', async () => {
  const { page, S } = boot();
  const info = infoOf(FREE);
  const hist = histOf('hello');
  serve(page, 'abc', info, hist);
  open(page, 'abc');
  await page.tick();
  delete S.chatCache.abc; // so the entry below can only come from the SSE update
  page.run("applyLive([{ id: 'abc', state: 'busy', live: { state: 'working', count: 1 } }])");
  const e = plain(S.chatCache.abc);
  assert.deepEqual(e.info, { ...info, live: { state: 'working', count: 1 } });
  assert.deepEqual(e.hist, hist);
  assert.equal(e.key, plain(S.chat).key);
  assert.equal(e.key, keyOf(e.info, hist));
});

test('a: an SSE update of a repo whose chat is NOT open stores nothing', async () => {
  const { page, S } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('hello'));
  open(page, 'abc');
  await page.tick();
  page.run("applyLive([{ id: 'xyz', state: 'busy', live: { state: 'working', count: 1 } }])");
  assert.deepEqual(Object.keys(plain(S.chatCache)), ['abc']);
});

// ---------- (b) opening with a cache ----------
test('b: opening a repo with a cache paints its messages at once (before any request answers): no "Loading chat…", state unknown, no answer buttons', async () => {
  const { page, S } = await warm('abc', infoOf(ASK), histOf('cached hello'));
  hold(page, 'abc');
  open(page, 'abc');
  page.flush(); // the first draw(), nothing has answered
  assert.ok(body(page).includes('cached hello'), body(page));
  assert.ok(!body(page).includes('Loading chat…'));
  assert.ok(!body(page).includes('data-act="dialog-answer"'), 'the cached question is never offered');
  assert.ok(!body(page).includes('ch-ask'), 'nor its card');
  assert.ok(!body(page).includes('Proceed?'));
  assert.ok(label(page).includes('ss-unknown') && label(page).includes('unknown'), label(page));
  const c = chatState(page);
  assert.equal(c.id, 'abc');
  assert.equal(c.cached, true);
  assert.equal(typeof c.seq, 'number');
  assert.deepEqual(c.info.live, { state: 'unknown', count: 0 });
  assert.deepEqual(c.hist, histOf('cached hello'));
  assert.equal(c.key, plain(S.chatCache.abc).key);
});

test('b: the cached live state with a dialog never reaches S.chat, and the composer is not offered a send while it is unknown', async () => {
  const { page } = await warm();
  hold(page, 'abc');
  open(page, 'abc');
  page.flush();
  // `S.chat.key` keeps the server's own text (it is only compared with the next answer); what is shown and painted must carry no question.
  assert.ok(!JSON.stringify(chatState(page).info).includes('choices'));
  assert.ok(!JSON.stringify(chatState(page).info).includes('dialog'));
  assert.ok(!body(page).includes('dialog-answer') && !body(page).includes('ch-ask'));
  assert.equal(page.get('#msgSend').disabled, true);
  assert.equal(page.get('#msgSend').title, 'The session state is unknown');
});

test('b: a repo with no cache entry behaves as today: "Loading chat…", no info, state loading', async () => {
  const { page } = await warm('abc');
  hold(page, 'xyz');
  open(page, 'xyz');
  page.flush();
  assert.ok(body(page).includes('Loading chat…'), body(page));
  assert.ok(!body(page).includes('cached hello'), 'the cache of another repo is never shown');
  const c = chatState(page);
  assert.equal(c.info, undefined);
  assert.ok(!c.cached);
  assert.ok(label(page).includes('ss-loading'), label(page));
});

// ---------- (c) the refresh ----------
test('c: opening a cached repo still asks for both reads with priority user and the signal that closing the chat aborts', async () => {
  const { page } = await warm();
  hold(page, 'abc');
  open(page, 'abc');
  assert.deepEqual(urls(page), [SES('abc'), CHAT('abc')], 'one request per url, sessions first');
  for (const f of page.fetches) {
    assert.equal(f.method, 'GET');
    assert.equal(f.headers['x-priority'], 'user', f.url);
    assert.equal(f.signal.aborted, false, f.url);
  }
  close(page);
  assert.deepEqual(page.fetches.map((f) => f.signal.aborted), [true, true], 'the same abort signal as today');
});

test('c: when the refresh answers, cached goes away, the live state and the question card come with their buttons and the messages are the fresh ones', async () => {
  const { page } = await warm('abc', infoOf(FREE), histOf('old message'));
  const held = hold(page, 'abc');
  open(page, 'abc');
  page.flush();
  assert.ok(body(page).includes('old message'));
  const info = infoOf(ASK);
  const hist = histOf('old message', 'fresh message');
  held.chat.resolve(ok(hist));
  held.sessions.resolve(ok(info));
  await page.tick();
  const html = body(page);
  assert.ok(html.includes('old message') && html.includes('fresh message'), html);
  assert.ok(html.includes('data-act="dialog-answer"') && html.includes('Proceed?'), 'the fresh question has its buttons');
  assert.ok(label(page).includes('ss-waiting'), label(page));
  const c = chatState(page);
  assert.ok(!c.cached, 'no longer cached');
  assert.deepEqual(c.info, info);
  assert.deepEqual(c.hist, hist);
  assert.equal(c.key, keyOf(info, hist));
  assert.ok(!c.failed);
  assert.deepEqual(plain(page.run('S.chatCache.abc')).hist, hist, 'the cache holds the fresh answer');
});

test('c: a fresh answer IDENTICAL to the cached one (same key) still ends the cached state and paints the live question', async () => {
  const { page } = await warm('abc', infoOf(ASK), histOf('same message'));
  const held = hold(page, 'abc');
  open(page, 'abc');
  page.flush();
  assert.ok(!body(page).includes('data-act="dialog-answer"'));
  held.sessions.resolve(ok(infoOf(ASK)));
  held.chat.resolve(ok(histOf('same message')));
  await page.tick();
  assert.ok(!chatState(page).cached);
  assert.deepEqual(chatState(page).info.live, ASK);
  assert.ok(body(page).includes('data-act="dialog-answer"'), body(page));
  assert.ok(label(page).includes('ss-waiting'), label(page));
});

test('c: when the refresh FAILS, the cached messages stay, S.chat.failed is set, and still no question or buttons', async () => {
  for (const [sessions, chat] of [[bad(500), ok(histOf('x'))], [ok(infoOf(FREE)), bad(503)]]) {
    const { page } = await warm('abc', infoOf(ASK), histOf('cached hello'));
    const held = hold(page, 'abc');
    open(page, 'abc');
    held.chat.resolve(chat);
    held.sessions.resolve(sessions);
    await page.tick();
    const c = chatState(page);
    assert.equal(c.failed, true);
    assert.ok(body(page).includes('cached hello'), body(page));
    assert.ok(body(page).includes('⚠ Chat unavailable: showing the last data we have.'), body(page));
    assert.ok(!body(page).includes('Loading chat…'));
    assert.ok(!body(page).includes('data-act="dialog-answer"'));
    assert.deepEqual(plain(page.run('S.chatCache.abc')).hist, histOf('cached hello'), 'a failed read leaves the cache as it was');
  }
});

test('c: a repo with no cache whose read fails says "Chat unavailable" exactly as today', async () => {
  const { page } = boot();
  page.routes[SES('abc')] = () => Promise.resolve(bad(500));
  page.routes[CHAT('abc')] = () => Promise.resolve(ok(histOf('x')));
  open(page, 'abc');
  await page.tick();
  assert.ok(body(page).includes('Chat unavailable. Try again in a moment.'), body(page));
  assert.equal(chatState(page).failed, true);
});

test('d: /api/sessions and /api/chat are both requested before either resolves; the result is the same as before, whichever answers first', async () => {
  const info = infoOf(FREE);
  const hist = histOf('hello');
  for (const order of ['chat-first', 'sessions-first']) {
    const { page } = boot();
    const held = hold(page, 'abc');
    open(page, 'abc');
    assert.deepEqual(urls(page), [SES('abc'), CHAT('abc')], `both started synchronously (${order})`);
    await page.tick();
    assert.deepEqual(urls(page), [SES('abc'), CHAT('abc')], 'and no more while they are held');
    if (order === 'chat-first') { held.chat.resolve(ok(hist)); held.sessions.resolve(ok(info)); } else { held.sessions.resolve(ok(info)); held.chat.resolve(ok(hist)); }
    await page.tick();
    const c = chatState(page);
    assert.deepEqual({ info: c.info, hist: c.hist, key: c.key }, { info, hist, key: keyOf(info, hist) }, order);
    assert.equal(countOf(page, SES('abc')), 1);
    assert.equal(countOf(page, CHAT('abc')), 1);
    assert.ok(body(page).includes('hello'));
  }
});

test('d: with no adopted session the hist is null even if /api/chat answered something (and it was still asked in parallel)', async () => {
  const { page } = boot();
  const info = infoOf({ state: 'none', count: 0 }, { adopted: null, adoptedFound: false, sessions: [{ id: 's9', name: 'other', updatedAt: '2026-05-01T11:00:00Z' }] });
  const held = hold(page, 'abc');
  open(page, 'abc');
  assert.deepEqual(urls(page), [SES('abc'), CHAT('abc')]);
  held.chat.resolve(ok(histOf('should be ignored')));
  held.sessions.resolve(ok(info));
  await page.tick();
  const c = chatState(page);
  assert.equal(c.hist, null);
  assert.deepEqual(c.info, info);
  assert.equal(c.key, keyOf(info, null));
  assert.ok(body(page).includes('No session is adopted for this folder.'));
  assert.ok(!body(page).includes('should be ignored'));
});

test('d: if either request fails the whole read fails, and nothing of the other one is shown or stored', async () => {
  for (const failing of ['sessions', 'chat']) {
    const { page, S } = boot();
    const held = hold(page, 'abc');
    open(page, 'abc');
    if (failing === 'sessions') { held.sessions.reject(new Error('boom')); held.chat.resolve(ok(histOf('lonely'))); } else { held.sessions.resolve(ok(infoOf(FREE))); held.chat.reject(new Error('boom')); }
    await page.tick();
    const c = chatState(page);
    assert.equal(c.failed, true, failing);
    assert.equal(c.info, undefined, failing);
    assert.equal(c.hist, undefined, failing);
    assert.ok(!body(page).includes('lonely'));
    assert.deepEqual(Object.keys(plain(S.chatCache)), [], failing);
  }
});

test('e: open A then B before A answers: A\'s late answer does not touch B but goes into A\'s cache entry', async () => {
  const { page, S } = boot();
  const a = hold(page, 'abc');
  open(page, 'abc');
  const b = hold(page, 'xyz');
  open(page, 'xyz');
  page.flush();
  assert.deepEqual(urls(page), [SES('abc'), CHAT('abc'), SES('xyz'), CHAT('xyz')]);
  const infoA = infoOf(FREE);
  const histA = histOf('message of A');
  a.sessions.resolve(ok(infoA));
  a.chat.resolve(ok(histA));
  await page.tick();
  const c = chatState(page);
  assert.equal(c.id, 'xyz');
  assert.equal(c.info, undefined, 'B was not touched by A\'s answer');
  assert.ok(body(page).includes('Loading chat…') && !body(page).includes('message of A'));
  assert.deepEqual(Object.keys(plain(S.chatCache)), ['abc']);
  assert.deepEqual(plain(S.chatCache.abc).info, infoA);
  assert.deepEqual(plain(S.chatCache.abc).hist, histA);
  const infoB = infoOf(FREE, { adopted: { id: 's2', name: 'panel:other', adoptedAt: 'x' } });
  b.sessions.resolve(ok(infoB));
  b.chat.resolve(ok(histOf('message of B')));
  await page.tick();
  assert.ok(body(page).includes('message of B'));
  assert.deepEqual(Object.keys(plain(S.chatCache)).sort(), ['abc', 'xyz']);
});

test('e: closing the chat clears nothing from the cache, and reopening that repo paints it at once', async () => {
  const { page, S } = await warm('abc', infoOf(FREE), histOf('kept message'));
  const before = plain(S.chatCache);
  assert.deepEqual(Object.keys(before), ['abc']);
  hold(page, 'abc');
  open(page, 'abc');
  close(page);
  assert.deepEqual(plain(S.chatCache), before);
  open(page, 'abc');
  page.flush();
  assert.ok(body(page).includes('kept message'));
});

test('f: the composer keeps its text when reopening a cached repo, and the draft is not in the cache', async () => {
  const { page, S } = await warm('abc', infoOf(FREE), histOf('cached hello'));
  hold(page, 'abc');
  open(page, 'abc');
  page.get('#msgBox').value = 'work in progress';
  close(page);
  assert.equal(S.drafts.abc, 'work in progress');
  open(page, 'abc');
  page.flush();
  assert.equal(page.get('#msgBox').value, 'work in progress');
  assert.ok(body(page).includes('cached hello'));
  assert.ok(!JSON.stringify(S.chatCache).includes('work in progress'));
});

test('f: a pending message is not stored: a read that finishes while one is sending leaves the cache without it, and the chat still shows it', async () => {
  const { page, S } = boot();
  S.pending.abc = [{ text: 'unsent words', state: 'sending', base: 0 }];
  serve(page, 'abc', infoOf(FREE), histOf('hello'));
  open(page, 'abc');
  await page.tick();
  assert.ok(body(page).includes('unsent words'), 'control: it is painted from S.pending');
  assert.ok(!JSON.stringify(S.chatCache).includes('unsent words'));
});

test('g: chatTick reads both urls without priority and, when the answer changes, paints it and refreshes the cache', async () => {
  const { page, S } = boot();
  serve(page, 'abc', infoOf(FREE), histOf('first'));
  open(page, 'abc');
  await page.tick();
  page.fetches.length = 0;
  const hist = histOf('first', 'second');
  serve(page, 'abc', infoOf(FREE), hist);
  page.run('chatTick()');
  assert.deepEqual(urls(page), [SES('abc'), CHAT('abc')], 'both started at once by the poll too');
  for (const f of page.fetches) assert.equal(f.headers['x-priority'], undefined, 'the poll has no priority');
  await page.tick();
  assert.ok(body(page).includes('second'));
  assert.deepEqual(plain(S.chatCache.abc).hist, hist);
  assert.equal(plain(S.chatCache.abc).key, chatState(page).key);
});
