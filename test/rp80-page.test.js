'use strict';
// RP80 (S68, S75), design points 5-6: view.js boardApply / boardWait (pure) and the real public/app.js in a vm (stubbed DOM, fake clock, fake fetch
// with queued answers and gates: no timers, no sleeps, no network, no real config, Orca, git or gh) reading the board from the server's memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const BASE = 1000000;
const BUTTON = '[data-act="refresh-all"]';

// ---------- harness (rp79-page.test.js, plus: a fake clock, captured intervals and listeners, a queue of /api/board answers, optional auto answers) ----------
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
const ok = (body) => ({ ok: true, json: async () => body });
const fail = (status) => ({ ok: false, status, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const gate = () => { let resolve; const promise = new Promise((a) => { resolve = a; }); return { promise, resolve }; };
const plain = (x) => JSON.parse(JSON.stringify(x));
const offline = () => Promise.reject(new Error('offline'));

const facts = (tag) => ({
  local: { branch: tag, detached: false, upstream: `origin/${tag}`, noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [] },
  prs: { prs: [], stale: null, repo: { url: `https://github.com/o/${tag}` } },
  roadmap: { available: false, reason: tag },
  state: { available: false, tag },
  req: { available: true, base: 'main', results: [], summary: { ok: 1, total: 1 }, tag },
});
const KINDS = ['local', 'prs', 'roadmap', 'state', 'req'];
const AUTO = { local: '/api/local', prs: '/api/prs', roadmap: '/api/roadmap', state: '/api/state', req: '/api/requirements' };
const entry = (rev, tag, at = BASE, over = {}) => ({ rev, at: Object.fromEntries(KINDS.map((k) => [k, at])), ...facts(tag), errors: {}, stale: [], ...over });
const board = (rev, repos = {}, refreshing = []) => ({ rev, repos, refreshing });
const answer = (b) => () => Promise.resolve(ok(b));

function loadPage({ auto = false, boardDefault = null } = {}) {
  const clock = { t: BASE };
  const els = { [BUTTON]: element({ on: undefined, classList: { toggle(n, on) { els[BUTTON].on = on; }, add() {}, remove() {}, contains: () => false } }) };
  const frames = [];
  const intervals = [];
  const fetches = [];
  const routes = {};
  const boards = [];
  const listeners = {};
  const counter = { draws: 0 };
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = {
    hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []),
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null,
  };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } }
  const page = { boardDefault };
  const respond = (url, opts) => {
    if (routes[url]) return routes[url](url, opts);
    if (url.startsWith('/api/board?')) { const next = boards.shift(); return next ? next() : (page.boardDefault ? page.boardDefault() : new Promise(() => {})); }
    if (url === '/api/board/refresh') return Promise.resolve(ok({ started: true }));
    const kind = auto && KINDS.find((k) => url.startsWith(`${AUTO[k]}?`));
    return kind ? Promise.resolve(ok(facts('direct')[kind])) : new Promise(() => {});
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), ctx);
  const realDraw = ctx.draw;
  ctx.draw = (...a) => { counter.draws++; return realDraw(...a); };
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const run = (code) => vm.runInContext(code, ctx);
  const fire = (ms) => intervals.filter((i) => i.ms === ms).forEach((i) => i.fn());
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'alpha', path: 'p' }, { id: 'xyz', name: 'beta', path: 'q' }] }];
  return Object.assign(page, { ctx, S, get, flush, tick, run, fire, fetches, routes, boards, listeners, doc, intervals, clock, counter, button: () => els[BUTTON].on });
}
// Board and per-repo requests only, as `METHOD url`, from index `from`.
const RELEVANT = /^\/api\/(board|local|prs|roadmap|requirements|state|pi-status)\b/;
const reqs = (page, from = 0) => page.fetches.slice(from).filter((f) => RELEVANT.test(f.url)).map((f) => `${f.method} ${f.url}`);
const perRepo = (page, from = 0) => reqs(page, from).filter((r) => !r.includes('/api/board'));
const readsOf = (id, kinds = ['local', 'prs', 'roadmap', 'requirements', 'state']) => kinds.map((k) => `GET /api/${k}?id=${id}`);
const bodyOf = (page, url) => JSON.parse(page.fetches.filter((f) => f.url === url).at(-1).body);
// A page whose board works: one answer applied.
async function working(page, b = board(5, { abc: entry(5, 'a1') })) {
  page.boards.push(answer(b));
  await page.run('loadBoard()');
  return page.fetches.length;
}

// ---------- point 5: boardApply ----------
const L = facts('t');
const full = (at = {}, over = {}) => ({ rev: 3, at: { local: 5000, prs: 5000, roadmap: 5000, state: 5000, req: 5000, ...at }, ...L, errors: {}, stale: [], ...over });
const applyOf = (repos, o = {}) => V.boardApply({ rev: 9, refreshing: ['abc'], repos }, { lastAt: {}, now: 9000, ...o });
const cleaned = (set) => Object.fromEntries(Object.entries(set).map(([id, f]) => [id, Object.fromEntries(Object.entries(f).filter(([k, v]) => !(k === 'errors' && !Object.keys(v || {}).length)))]));

test('boardApply: every fact of every repo is set, rev and refreshing come through, nothing is missing, the board is not changed', () => {
  const b = { rev: 9, refreshing: ['abc'], repos: { abc: full(), xyz: full() } };
  const before = plain(b);
  const out = V.boardApply(b, { lastAt: {}, now: 9000 });
  assert.deepEqual(Object.keys(out).sort(), ['missing', 'refreshing', 'rev', 'set']);
  assert.deepEqual(cleaned(out.set), { abc: L, xyz: L });
  assert.deepEqual([out.rev, out.refreshing, out.missing], [9, ['abc'], []]);
  assert.deepEqual(plain(b), before);
  const none = V.boardApply({ rev: 2, repos: {} }, { lastAt: {}, now: 1 });
  assert.deepEqual([none.set, none.rev, none.refreshing, none.missing], [{}, 2, [], []]);
});

test('boardApply: a fact is dropped when the page read it directly at the same time or later; older or unknown page time never blocks', () => {
  for (const kind of KINDS) {
    const others = KINDS.filter((k) => k !== kind);
    const kept = (pageAt) => Object.keys(cleaned(applyOf({ abc: full() }, { lastAt: pageAt === undefined ? { abc: {} } : { abc: { [kind]: pageAt } } }).set).abc || {});
    assert.deepEqual(kept(4999), KINDS, `${kind}: page older than the board`);
    assert.deepEqual(kept(5000), others, `${kind}: equal, the page wins`);
    assert.deepEqual(kept(5001), others, `${kind}: page newer`);
    assert.deepEqual(kept(undefined), KINDS, `${kind}: unknown page time`);
  }
  assert.deepEqual(Object.keys(applyOf({ abc: full() }, { lastAt: {} }).set.abc), KINDS, 'no record of the repo at all');
  const mixed = applyOf({ abc: full({ local: 7000, prs: 3000 }) }, { lastAt: { abc: { local: 6000, prs: 4000 }, xyz: { local: 99999 } } });
  assert.deepEqual(Object.keys(mixed.set.abc), KINDS.filter((k) => k !== 'prs'), 'each fact is judged on its own, each repo on its own');
});

test('boardApply: errors come with their repo and kind; the error of a dropped fact is dropped with it; a value and an error can come together', () => {
  const errs = { local: 'git down', prs: 'gh down' };
  const gone = { ...L };
  delete gone.local; delete gone.prs;
  const noValue = applyOf({ abc: { rev: 1, at: { roadmap: 5000, state: 5000, req: 5000 }, ...gone, errors: errs, stale: ['local', 'prs'] } });
  assert.deepEqual(noValue.set.abc.errors, errs);
  assert.deepEqual(Object.keys(noValue.set.abc).sort(), ['errors', 'req', 'roadmap', 'state']);
  const both = applyOf({ abc: full({}, { errors: { prs: 'gh down' } }) });
  assert.deepEqual([both.set.abc.prs, both.set.abc.errors], [L.prs, { prs: 'gh down' }]);
  const dropped = applyOf({ abc: full({}, { errors: { local: 'git down', prs: 'gh down' } }) }, { lastAt: { abc: { local: 5000 } } });
  assert.equal('local' in dropped.set.abc, false);
  assert.deepEqual(dropped.set.abc.errors, { prs: 'gh down' });
});

test('boardApply: missing lists, in board order, the repos that came without a good local, prs, roadmap or state (req does not count; a dropped fact still came)', () => {
  const only = (kind) => { const e = full(); delete e[kind]; return e; };
  const out = applyOf({ a: full(), b: only('local'), c: only('prs'), d: only('roadmap'), e: only('state'), f: { rev: 0, at: {}, errors: {}, stale: [] }, g: only('req'), h: full({}, { errors: { prs: 'x' } }) });
  assert.deepEqual(out.missing, ['b', 'c', 'd', 'e', 'f']);
  const errorOnly = { ...full(), errors: { prs: 'x' } };
  delete errorOnly.prs;
  assert.deepEqual(applyOf({ a: errorOnly }).missing, ['a'], 'an error is not a good value');
  assert.deepEqual(applyOf({ a: full() }, { lastAt: { a: { local: 9999, prs: 9999, roadmap: 9999, state: 9999 } } }).missing, [], 'dropped by the page guard: the board did bring it');
});

test('boardWait: 3000 ms while it works, then 3000 * 2^failures capped at 30000 after a failure', () => {
  assert.equal(V.boardWait({ ok: true, failures: 0 }), 3000);
  assert.equal(V.boardWait({ ok: true, failures: 2 }), 3000);
  const after = (failures) => V.boardWait({ ok: false, failures });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(after), [3000, 6000, 12000, 24000, 30000, 30000, 30000, 30000]);
});

// ---------- point 6a: loadBoard ----------
test('a: loadBoard asks since=S.boardRev (first 0), applies the five facts as the old loaders do, keeps the rev, and draws ONCE; no change draws nothing', async () => {
  const page = loadPage();
  const { S } = page;
  assert.equal(page.run('S.boardRev'), 0);
  page.boards.push(answer(board(5, { abc: entry(5, 'a1'), xyz: entry(4, 'x1') })), answer(board(5)), answer(board(6, { xyz: entry(6, 'x2', BASE + 10) })));
  const mark = page.fetches.length;
  await page.run('loadBoard()');
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0']);
  assert.equal(page.counter.draws, 1);
  for (const [id, tag] of [['abc', 'a1'], ['xyz', 'x1']]) {
    const f = facts(tag);
    assert.deepEqual(plain([S.local[id], S.prs[id], S.roadmap[id], S.state[id], S.req[id]]), [f.local, f.prs, f.roadmap, f.state, { state: 'loaded', data: f.req }], id);
  }
  assert.equal(page.run('S.boardRev'), 5);
  page.counter.draws = 0;
  await page.run('loadBoard()');
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0', 'GET /api/board?since=5']);
  assert.equal(page.counter.draws, 0, 'an answer with no change does not draw');
  await page.run('loadBoard()');
  assert.deepEqual([page.counter.draws, page.run('S.boardRev'), reqs(page, mark).at(-1)], [1, 6, 'GET /api/board?since=5']);
  assert.deepEqual(plain(S.local.xyz), facts('x2').local);
  assert.deepEqual(plain(S.local.abc), facts('a1').local, 'a repo that did not come keeps what it had');
});

test('a: a board answer that only changes `refreshing` still draws once (the Refresh button must follow)', async () => {
  const page = loadPage();
  await working(page, board(5, { abc: entry(5, 'a1') }));
  page.counter.draws = 0;
  page.boards.push(answer(board(5, {}, ['abc'])));
  await page.run('loadBoard()');
  assert.equal(page.counter.draws, 1);
});

test('a: noteLocal after local; wakeReady and releaseMerged after prs', async () => {
  const page = loadPage();
  const { S } = page;
  const dirty = { ...facts('d').local, files: [{ path: 'a.txt', status: 'M', untracked: false }] };
  const ready = { ...facts('d').prs, prs: [{ number: 1, title: 'P', head: 'd', ready: true, isCrossRepository: false }] };
  S.snoozed = new Set(['abc:1']);
  S.merged = { 'abc:5': BASE, 'xyz:5': BASE };
  page.boards.push(answer(board(3, { abc: entry(3, 'd', BASE, { local: dirty, prs: ready }) })));
  const mark = page.fetches.length;
  await page.run('loadBoard()');
  await page.tick();
  assert.equal(S.dirtyAt.abc, BASE, 'noteLocal saw the dirty repo');
  assert.ok(reqs(page, mark).includes('GET /api/pi-status?id=abc'), 'and asked for the live state, as it does after the old loader');
  const snooze = page.fetches.slice(mark).find((f) => f.url === '/api/snooze');
  assert.deepEqual(snooze && JSON.parse(snooze.body), { id: 'abc', number: 1, on: false, wasReady: false }, 'wakeReady');
  assert.deepEqual(plain(S.merged), { 'xyz:5': BASE }, 'releaseMerged forgot the merge GitHub no longer lists, of that repo only');
});

test('a: a fact with an error and no value sets what the old loader sets on failure; with an older value the value stays', async () => {
  const page = loadPage();
  const { S } = page;
  const bare = { rev: 2, at: {}, errors: { local: 'e1', prs: 'e2', roadmap: 'e3', state: 'e4', req: 'e5' }, stale: KINDS };
  const kept = entry(3, 'old', BASE, { errors: { local: 'e1', prs: 'e2', roadmap: 'e3', state: 'e4', req: 'e5' } });
  page.boards.push(answer(board(3, { abc: bare, xyz: kept })));
  await page.run('loadBoard()');
  assert.deepEqual(plain([S.local.abc, S.prs.abc, S.roadmap.abc, S.state.abc, S.req.abc]), [{ error: 'e1' }, { error: 'e2' }, null, null, { state: 'failed' }]);
  const f = facts('old');
  assert.deepEqual(plain([S.local.xyz, S.prs.xyz, S.roadmap.xyz, S.state.xyz, S.req.xyz]), [f.local, f.prs, f.roadmap, f.state, { state: 'loaded', data: f.req }]);
});

test('a: a failed or 404 board request changes nothing, draws nothing and does not throw', async () => {
  for (const next of [offline, () => Promise.resolve(fail(404)), () => Promise.resolve(fail(500))]) {
    const page = loadPage();
    await working(page);
    const before = plain([page.S.local, page.S.prs, page.run('S.boardRev')]);
    page.counter.draws = 0;
    page.boards.push(next);
    await page.run('loadBoard()');
    assert.deepEqual(plain([page.S.local, page.S.prs, page.run('S.boardRev')]), before);
    assert.equal(page.counter.draws, 0);
  }
});

// ---------- point 6b: first load ----------
test('b: refreshAll asks the board first; only a repo that came without its facts is read with the old loaders (the others make no request)', async () => {
  const page = loadPage();
  const { S } = page;
  const hold = gate();
  const partial = entry(4, 'x1');
  delete partial.roadmap; delete partial.state; delete partial.req;
  page.boards.push(() => hold.promise);
  const mark = page.fetches.length;
  page.run('refreshAll()');
  await page.tick();
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0'], 'nothing per repo before the board answers');
  hold.resolve(ok(board(5, { abc: entry(5, 'a1'), xyz: partial })));
  await page.tick();
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0', ...readsOf('xyz')], 'only xyz, only its five reads, in the old order');
  assert.deepEqual(plain(S.local.abc), facts('a1').local, 'abc was painted from the board');
  assert.deepEqual(plain(S.local.xyz), facts('x1').local, 'and so was what xyz did come with');
  assert.ok(page.counter.draws >= 1);
});

test('b: with every repo complete, refreshAll makes no per-repo request at all', async () => {
  const page = loadPage();
  page.boards.push(answer(board(5, { abc: entry(5, 'a1'), xyz: entry(5, 'x1') })));
  const mark = page.fetches.length;
  page.run('refreshAll()');
  await page.tick();
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0']);
});

test('b: a board that cannot answer (404, network error) leaves refreshAll as it is today: every repo is read with the old loaders', async () => {
  for (const next of [() => Promise.resolve(fail(404)), offline]) {
    const page = loadPage({ auto: true });
    page.boards.push(next);
    const mark = page.fetches.length;
    page.run('refreshAll()');
    await page.tick();
    assert.equal(reqs(page, mark)[0], 'GET /api/board?since=0', 'the board is asked first');
    assert.deepEqual(perRepo(page, mark), [...readsOf('abc'), ...readsOf('xyz')]);
  }
});

// ---------- point 6c: polling ----------
test('c: while the board works, the 60 s refresh and the refresh tick make no per-repo request, and a boardTick is exactly one board request', async () => {
  const page = loadPage({ auto: true });
  assert.ok(page.intervals.some((i) => i.ms === 60000) && page.intervals.some((i) => i.ms === 2000), 'precondition: the old polls are registered');
  const mark = await working(page);
  page.clock.t += 120000;
  page.fire(60000);
  page.fire(2000);
  await page.tick();
  assert.deepEqual(perRepo(page, mark), []);
  page.boards.push(answer(board(5)));
  const mark2 = page.fetches.length;
  page.run('boardTick()');
  await page.tick();
  assert.deepEqual(reqs(page, mark2), ['GET /api/board?since=5']);
});

test('c: a 404 is the end of the board at once; three network errors in a row are; fewer are not. The old polling then runs exactly as today', async () => {
  const page = loadPage({ auto: true, boardDefault: offline });
  await working(page);
  for (let i = 1; i <= 2; i++) {
    await page.run('boardTick()');
    page.fire(2000);
    await page.tick();
    assert.deepEqual(perRepo(page), [], `after ${i} failure(s) the board is still the way`);
  }
  await page.run('boardTick()');
  page.fetches.length = 0;
  page.fire(2000);
  await page.tick();
  assert.deepEqual(perRepo(page), ['GET /api/local?id=abc', 'GET /api/state?id=abc', 'GET /api/local?id=xyz', 'GET /api/state?id=xyz'], 'refreshTick again');
  page.fetches.length = 0;
  page.fire(60000);
  await page.tick();
  assert.deepEqual(perRepo(page), [...readsOf('abc'), ...readsOf('xyz')], 'and the full refresh again');

  const gone = loadPage({ auto: true });
  await working(gone);
  gone.boards.push(() => Promise.resolve(fail(404)));
  await gone.run('boardTick()');
  gone.fetches.length = 0;
  gone.fire(2000);
  await gone.tick();
  assert.deepEqual(perRepo(gone), ['GET /api/local?id=abc', 'GET /api/state?id=abc', 'GET /api/local?id=xyz', 'GET /api/state?id=xyz']);
});

test('c: a board that is down is retried by boardTick, one request each, and when it answers again the old polling stops', async () => {
  const page = loadPage({ auto: true });
  await working(page);
  page.boards.push(() => Promise.resolve(fail(404)));
  await page.run('boardTick()');
  page.boards.push(answer(board(5)));
  const mark = page.fetches.length;
  await page.run('boardTick()');
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=5'], 'the slow retry is one board request');
  page.clock.t += 120000;
  page.fire(2000);
  await page.tick();
  assert.deepEqual(perRepo(page, mark), []);
});

// ---------- point 6d: visibility ----------
test('d: becoming visible asks the board once; no full refresh, no per-repo burst, no summary, prerequisites or rooms request', async () => {
  const page = loadPage({ auto: true });
  const mark = await working(page);
  page.S.lastRefresh = 0; // the old handler would refresh everything now
  page.boards.push(answer(board(5)));
  page.doc.hidden = false;
  for (const fn of page.listeners.visibilitychange) fn({});
  await page.tick();
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=5']);
  assert.deepEqual(page.fetches.slice(mark).map((f) => f.url).filter((u) => /^\/api\/(summary|prerequisites|rooms)/.test(u)), []);
  const hiddenMark = page.fetches.length;
  page.doc.hidden = true;
  for (const fn of page.listeners.visibilitychange) fn({});
  await page.tick();
  assert.deepEqual(reqs(page, hiddenMark), [], 'hidden asks nothing');
});

test('d: with the board down, becoming visible refreshes everything as today', async () => {
  const page = loadPage({ auto: true, boardDefault: () => Promise.resolve(fail(404)) });
  await working(page);
  await page.run('boardTick()');
  page.S.lastRefresh = 0;
  page.fetches.length = 0;
  for (const fn of page.listeners.visibilitychange) fn({});
  await page.tick();
  assert.deepEqual(perRepo(page), [...readsOf('abc'), ...readsOf('xyz')]);
  assert.ok(page.fetches.some((f) => f.url === '/api/summary'));
});

// ---------- point 6e: the Refresh button ----------
test('e: Refresh paints from memory first, then POSTs /api/board/refresh (no id, user priority); the button is busy while `refreshing` lists repos; cards follow the answers', async () => {
  const page = loadPage({ auto: true });
  const { S } = page;
  const post = gate();
  page.routes['/api/board/refresh'] = () => post.promise;
  page.boards.push(answer(board(1, { abc: entry(1, 'm1') })));
  const mark = page.fetches.length;
  page.run("ACTIONS['refresh-all']()");
  await page.tick();
  assert.deepEqual(reqs(page, mark), ['GET /api/board?since=0', 'POST /api/board/refresh']);
  assert.deepEqual(plain(S.local.abc), facts('m1').local, 'painted from memory while the POST is still open');
  const sent = page.fetches.find((f) => f.url === '/api/board/refresh');
  assert.equal(sent.headers['x-priority'], 'user');
  assert.equal('id' in JSON.parse(sent.body), false);
  post.resolve(ok({ started: true }));
  page.boards.push(answer(board(2, { abc: entry(2, 'm2') }, ['abc', 'xyz'])), answer(board(3, { xyz: entry(3, 'n3') }, ['xyz'])), answer(board(3, {}, [])));
  await page.tick();
  await page.run('boardTick()');
  await page.tick();
  assert.equal(page.button(), true, 'busy while two repos refresh');
  assert.deepEqual(plain(S.local.abc), facts('m2').local);
  await page.run('boardTick()');
  await page.tick();
  assert.equal(page.button(), true, 'busy while one still refreshes');
  assert.deepEqual(plain(S.local.xyz), facts('n3').local);
  await page.run('boardTick()');
  await page.tick();
  assert.equal(page.button(), false, 'idle again once nothing is refreshing');
  assert.deepEqual(perRepo(page, mark), [], 'not one per-repo request in the whole refresh');
});

test('e: with the board down, Refresh is the old full refresh', async () => {
  const page = loadPage({ auto: true, boardDefault: () => Promise.resolve(fail(404)) });
  await working(page);
  await page.run('boardTick()');
  page.fetches.length = 0;
  page.run("ACTIONS['refresh-all']()");
  await page.tick();
  assert.deepEqual(perRepo(page), [...readsOf('abc'), ...readsOf('xyz')]);
});

// ---------- point 6f: the person's own action ----------
test('f: after fetch or merge the direct reads win over an older or equal board fact, a newer one wins, and the store is asked to catch up for that repo', async () => {
  for (const act of ["fetchRepo('abc')", "doMerge('abc', 1)"]) {
    const page = loadPage({ auto: true });
    const { S } = page;
    S.prs.abc = { prs: [{ number: 1, title: 'P', head: 'h', ready: true, isCrossRepository: false }], stale: null };
    page.routes['/api/fetch'] = () => Promise.resolve(ok({ ok: true }));
    page.routes['/api/merge'] = () => Promise.resolve(ok({ branch: 'kept' }));
    const mark = page.fetches.length;
    await page.run(act);
    await page.tick();
    assert.deepEqual(perRepo(page, mark), readsOf('abc'), act);
    const direct = facts('direct');
    assert.deepEqual(plain([S.local.abc, S.prs.abc, S.roadmap.abc, S.state.abc, S.req.abc]), [direct.local, direct.prs, direct.roadmap, direct.state, { state: 'loaded', data: direct.req }]);
    const refresh = page.fetches.slice(mark).filter((f) => f.url === '/api/board/refresh');
    assert.equal(refresh.length, 1, act);
    assert.deepEqual(JSON.parse(refresh[0].body), { id: 'abc' });
    assert.equal(refresh[0].headers['x-priority'], 'user');
    for (const [at, who] of [[BASE - 1, 'older'], [BASE, 'equal']]) {
      page.boards.push(answer(board(7, { abc: entry(7, 'board', at) })));
      await page.run('loadBoard()');
      assert.deepEqual(plain([S.local.abc, S.prs.abc, S.roadmap.abc, S.state.abc, S.req.abc]), [direct.local, direct.prs, direct.roadmap, direct.state, { state: 'loaded', data: direct.req }], `${act}: ${who} board fact`);
    }
    page.boards.push(answer(board(8, { abc: entry(8, 'board', BASE + 1) })));
    await page.run('loadBoard()');
    assert.deepEqual(plain(S.local.abc), facts('board').local, `${act}: a newer board fact wins`);
    assert.deepEqual(plain(S.req.abc), { state: 'loaded', data: facts('board').req });
  }
});

// ---------- verification probes (second look): stale answers, errors, healing, the board chain, polling that must stay ----------
test('P1 (S68) an older board answer arriving after a newer one is dropped', async () => {
  const page = loadPage(); const { S } = page; const slow = gate();
  page.boards.push(() => slow.promise, answer(board(6, { abc: entry(6, 'new', BASE + 50) })));
  const first = page.run('loadBoard()');
  await page.run('loadBoard()');
  slow.resolve(ok(board(5, { abc: entry(5, 'old', BASE + 10) })));
  await first;
  assert.equal(plain(S.local.abc).branch, 'new');
  assert.equal(page.run('S.boardRev'), 6);
});

test('P2 (S68) an error with no value never overwrites a good fact the page holds', async () => {
  const page = loadPage(); const { S } = page;
  S.local.abc = facts('direct').local;
  page.boards.push(answer(board(2, { abc: { rev: 2, at: {}, errors: { local: 'boom' }, stale: ['local'] } })));
  await page.run('loadBoard()');
  assert.equal(plain(S.local.abc).branch, 'direct');
});

test('P3 (S68) a failed DIRECT read heals on Refresh while the board leads: the repo is read again with the old route', async () => {
  const page = loadPage(); const { S } = page;
  await working(page, board(5, { abc: entry(5, 'a1'), xyz: entry(5, 'x1') }));
  S.local.abc = { error: 'Request timed out' };
  page.boards.push(answer(board(5)));
  const mark = page.fetches.length;
  page.run('refreshAll({ force: true })'); await page.tick();
  assert.ok(reqs(page, mark).includes('GET /api/local?id=abc'));
  assert.ok(!reqs(page, mark).includes('GET /api/local?id=xyz'), 'only the repo with the error, not the healthy one');
});

test('P4 (S68) the board chain is re-armed when an answer throws while applying it', async () => {
  const page = loadPage(); await page.tick();
  const timers = [];
  page.ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  page.ctx.draw = () => { throw new Error('render'); };
  page.boards.push(answer(board(5, { abc: entry(5, 'a1') })));
  page.run('scheduleBoard()');
  const chain = () => timers.filter((t) => t.ms === 3000);
  assert.equal(chain().length, 1);
  await chain()[0].fn().catch(() => {}); await page.tick();
  assert.equal(chain().length, 2, 'the next beat is armed even though this one threw');
});

test('P5 (S68) while the board leads, a repo with a command sent polls only its session state', async () => {
  const page = loadPage(); const { S } = page;
  await working(page, board(5, { abc: entry(5, 'a1'), xyz: entry(5, 'x1') }));
  S.sent.abc = { at: BASE, busySeen: true, cmd: 'flow-pr' };
  page.clock.t += 61000;
  const mark = page.fetches.length;
  page.run(`refreshTick(${page.clock.t})`); await page.tick();
  const r = perRepo(page, mark);
  assert.deepEqual(r.filter((x) => !x.includes('pi-status')), []);
  assert.ok(r.some((x) => x.includes('/api/pi-status?id=abc')));
});

test('W4 (S68) a fact that keeps failing replaces its old value with the error once the value is 2 minutes old (a folder that went away)', async () => {
  const page = loadPage(); const { S } = page;
  const old = BASE;
  const answerAt = (now, e) => { page.clock.t = now; page.boards.push(answer(board(e.rev, { abc: e }))); return page.run('loadBoard()'); };
  await answerAt(old + 100000, entry(2, 'kept', old, { errors: { local: 'Folder not found' }, stale: ['local'] }));
  assert.equal(plain(S.local.abc).branch, 'kept', '100 s old: the old value still stands');
  await answerAt(old + 120000, entry(3, 'kept', old, { errors: { local: 'Folder not found' }, stale: ['local'] }));
  assert.deepEqual(plain(S.local.abc), { error: 'Folder not found' }, '120 s old: the card shows the error, as the old route did');
  await answerAt(old + 130000, entry(4, 'back', old + 130000));
  assert.equal(plain(S.local.abc).branch, 'back', 'and it recovers when a read succeeds again');
});

test('S6 (S68) a hidden tab does not ask the board on its beat, and the chain keeps going', async () => {
  const page = loadPage(); await page.tick();
  const timers = [];
  page.ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  page.ctx.document.hidden = true;
  page.run('scheduleBoard()');
  const mark = page.fetches.length;
  await timers.find((t) => t.ms === 3000).fn(); await page.tick();
  assert.deepEqual(reqs(page, mark).filter((r) => r.includes('/api/board')), []);
  assert.equal(timers.filter((t) => t.ms === 3000).length, 2, 'hidden or not, the next beat is armed');
});
