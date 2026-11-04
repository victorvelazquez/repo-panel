'use strict';
// RP86b (S9, L35): after the person's own action (refreshRepo with catchUp) the page used to read FIVE routes of the repo directly (local, prs, roadmap, requirements, state) although the
// board already brings them every 3 s. Now, while the board answers (boardLeads) and the page already holds that repo's roadmap and requirements, only local, prs and state are read
// directly (state is the freshest signal after an action, and the board would be up to 3 s late); roadmap (240 KB) and requirements arrive by the board. A fact the page does not hold yet
// is still read directly, and a board that is down or never answered, or refreshAll, keep the five reads. No network, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const BASE = 1700000000000;
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); el.writes++; }, ...extra,
  };
  return el;
}
const ok = (body) => ({ ok: true, json: async () => body });
const facts = (tag) => ({
  local: { branch: tag, detached: false, upstream: `origin/${tag}`, noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [] },
  prs: { prs: [], stale: null, repo: { url: `https://github.com/o/${tag}` } },
  roadmap: { available: false, reason: tag },
  state: { available: false, tag },
  req: { available: true, base: 'main', results: [], summary: { ok: 1, total: 1 }, tag },
});
const KINDS = ['local', 'prs', 'roadmap', 'state', 'req'];
const AUTO = { local: '/api/local', prs: '/api/prs', roadmap: '/api/roadmap', state: '/api/state', req: '/api/requirements' };
const entry = (rev, tag, at = BASE) => ({ rev, at: Object.fromEntries(KINDS.map((k) => [k, at])), ...facts(tag), errors: {}, stale: [] });
const boardOf = (rev, repos = {}) => ({ rev, repos, refreshing: [] });

function loadPage() {
  const clock = { t: BASE + 60000 };
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const boards = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } }
  const respond = (url, opts) => {
    if (routes[url]) return routes[url](url, opts);
    if (url.startsWith('/api/board?')) { const next = boards.shift(); return next ? next() : new Promise(() => {}); }
    if (url === '/api/board/refresh') return Promise.resolve(ok({ started: true }));
    if (url === '/api/fetch') return Promise.resolve(ok({ ok: true }));
    const kind = KINDS.find((k) => url.startsWith(`${AUTO[k]}?`));
    return kind ? Promise.resolve(ok(facts('direct')[kind])) : new Promise(() => {});
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 1, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.RepoPanelView = V; ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); flush(); };
  const run = (code) => vm.runInContext(code, ctx);
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'alpha', path: 'p' }] }];
  return { ctx, S, tick, run, fetches, routes, boards, clock };
}
const RELEVANT = /^\/api\/(board|local|prs|roadmap|requirements|state|pi-status)\b/;
const reqs = (page, from = 0) => page.fetches.slice(from).filter((f) => RELEVANT.test(f.url)).map((f) => `${f.method} ${f.url}`);
const perRepo = (page, from = 0) => reqs(page, from).filter((r) => !r.includes('/api/board')).sort();
const reads = (id, kinds) => kinds.map((k) => `GET /api/${k}?id=${id}`).sort();
const FIVE = ['local', 'prs', 'roadmap', 'requirements', 'state'];
// A page whose board works: one answer applied, so the page holds every fact of the repo.
async function working(page, b = boardOf(5, { abc: entry(5, 'a1') })) {
  page.boards.push(() => Promise.resolve(ok(b)));
  await page.run('loadBoard()');
  await page.tick();
  return page.fetches.length;
}
const act = async (page, opts) => { const mark = page.fetches.length; await page.run(`refreshRepo('abc', ${JSON.stringify(opts)})`); await page.tick(); return mark; };

test('the board answers and the page holds the roadmap and the requirements: after an action only local, prs and state are read directly, and the board is asked to catch up', async () => {
  const page = loadPage();
  await working(page);
  assert.equal(page.run('boardLeads()'), true);
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state']));
  assert.ok(reqs(page, mark).includes('POST /api/board/refresh'), 'the server is still asked to re-read the repo');
});

test('the same when the session just finished (poll: false) and when the action is a fetch: no roadmap and no requirements', async () => {
  const page = loadPage();
  await working(page);
  const mark = await act(page, { poll: false, catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state']));
  const mark2 = page.fetches.length;
  await page.run("fetchRepo('abc')");
  await page.tick();
  assert.deepEqual(perRepo(page, mark2), reads('abc', ['local', 'prs', 'state']));
  assert.ok(page.fetches.slice(mark2).some((f) => f.url === '/api/fetch'));
});

test('the cards keep what they had: the roadmap and the requirements of the page are not touched by an action refresh, and the direct reads still land', async () => {
  const page = loadPage();
  await working(page);
  const roadmap = JSON.stringify(page.S.roadmap.abc);
  const req = JSON.stringify(page.S.req.abc);
  assert.match(roadmap, /a1/);
  await act(page, { catchUp: true });
  assert.equal(JSON.stringify(page.S.roadmap.abc), roadmap);
  assert.equal(JSON.stringify(page.S.req.abc), req);
  assert.equal(page.S.local.abc.branch, 'direct', 'local was read directly');
  assert.equal(page.S.state.abc.tag, 'direct', 'state was read directly');
});

test('a later board answer still updates the roadmap and the requirements after such an action (a skipped direct read leaves no newer stamp that blocks it)', async () => {
  const page = loadPage();
  await working(page);
  await act(page, { catchUp: true });
  const later = entry(9, 'a2', BASE + 90000);
  page.boards.push(() => Promise.resolve(ok(boardOf(9, { abc: later }))));
  await page.run('loadBoard()');
  await page.tick();
  assert.match(JSON.stringify(page.S.roadmap.abc), /a2/);
  assert.match(JSON.stringify(page.S.req.abc), /a2/);
});

test('the page does not hold a fact of the repo yet: that one is still read directly (the fallback), the other still comes by the board', async () => {
  for (const [missing, route] of [['roadmap', 'roadmap'], ['req', 'requirements']]) {
    const page = loadPage();
    await working(page);
    delete page.S[missing][ 'abc' ];
    const mark = await act(page, { catchUp: true });
    assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state', route]), `without ${missing}`);
  }
  const page = loadPage();
  await working(page);
  page.S.req.abc = { state: 'failed' };
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state', 'requirements']), 'a failed requirements read is read again');
  const page2 = loadPage();
  await working(page2);
  page2.S.roadmap.abc = { available: false, reason: 'missing', base: 'main' }; // what the server answers for a repo with no roadmap: an answer, so it is held
  const mark2 = await act(page2, { catchUp: true });
  assert.deepEqual(perRepo(page2, mark2), reads('abc', ['local', 'prs', 'state']), 'a repo with no roadmap does not read the roadmap on every action');
});

test('a null in the roadmap is a failure, not an answer (the server says {available:false} for no roadmap): the next action reads it again', async () => {
  const page = loadPage();
  await working(page);
  page.S.roadmap.abc = null;
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state', 'roadmap']));
});

test('a failed direct roadmap read does not stop the next action from reading it again, once the board answers (the null it left is not "held")', async () => {
  const page = loadPage();
  page.routes['/api/roadmap?id=abc'] = () => Promise.reject(new Error('timeout'));
  await act(page, {}); // the five direct reads: the roadmap fails and leaves null
  assert.equal(page.S.roadmap.abc, null);
  await working(page, boardOf(5, { abc: Object.assign(entry(5, 'a1'), { roadmap: null }) }));
  delete page.routes['/api/roadmap?id=abc'];
  const mark = await act(page, { catchUp: true });
  assert.ok(perRepo(page, mark).includes('GET /api/roadmap?id=abc'), 'a failed read is read again');
  assert.match(JSON.stringify(page.S.roadmap.abc), /direct/, 'and the card now has the roadmap');
});

test('the board never answered (the page already holds the roadmap and the requirements, read directly): an action reads the five routes, as before', async () => {
  const page = loadPage();
  page.S.roadmap.abc = facts('x').roadmap;
  page.S.req.abc = { state: 'loaded', data: facts('x').req };
  assert.equal(page.run('boardLeads()'), false);
  assert.equal(page.run('boardWorks()'), true, 'a board that has not failed is not a board that answered');
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', FIVE));
});

test('the board is down (three failures in a row): an action reads the five routes, as before', async () => {
  const page = loadPage();
  await working(page);
  page.run('board.failures = 3');
  assert.equal(page.run('boardLeads()'), false);
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', FIVE));
  assert.equal(reqs(page, mark).includes('POST /api/board/refresh'), false, 'a board that is down is not asked either');
});

test('a refresh that is not the person\'s action (no catchUp: refreshAll for a repo the board did not bring) reads the five routes, as before', async () => {
  const page = loadPage();
  await working(page);
  const mark = await act(page, {});
  assert.deepEqual(perRepo(page, mark), reads('abc', FIVE));
});

test('a session that was sent from this page still polls its state after an action', async () => {
  const page = loadPage();
  await working(page);
  page.S.sent.abc = { cmd: '/flow-commit', at: BASE };
  page.routes['/api/pi-status?id=abc'] = () => Promise.resolve(ok({ state: 'idle' }));
  const mark = await act(page, { catchUp: true });
  assert.deepEqual(perRepo(page, mark), reads('abc', ['local', 'prs', 'state', 'pi-status']));
});
