'use strict';
// RP80 (S68, S75), extra cases of the page: a restarted server (lower rev), the catch-up POST after a command sent from the page, and the stale guard
// judged per fact. Same harness as rp80-page.test.js (real public/app.js in a vm; stubbed DOM, fake clock, fake fetch): no timers, no network, no real Orca, git or gh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../public/resumen.js');
const V = require('../public/view.js');

const BASE = 1000000;
const BUTTON = '[data-act="refresh-all"]';
const KINDS = ['local', 'prs', 'roadmap', 'state', 'req'];
const AUTO = { local: '/api/local', prs: '/api/prs', roadmap: '/api/roadmap', state: '/api/state', req: '/api/requirements' };

function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}
const ok = (body) => ({ ok: true, json: async () => body });
const plain = (x) => JSON.parse(JSON.stringify(x));
const facts = (tag) => ({
  local: { branch: tag, detached: false, upstream: `origin/${tag}`, noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [] },
  prs: { prs: [], stale: null, repo: { url: `https://github.com/o/${tag}` } },
  roadmap: { available: false, reason: tag },
  state: { available: false, tag },
  req: { available: true, base: 'main', results: [], summary: { ok: 1, total: 1 }, tag },
});
const entry = (rev, tag, at = BASE, over = {}) => ({ rev, at: Object.fromEntries(KINDS.map((k) => [k, at])), ...facts(tag), errors: {}, stale: [], ...over });
const board = (rev, repos = {}, refreshing = []) => ({ rev, repos, refreshing });
const answer = (b) => () => Promise.resolve(ok(b));
const cardOf = (S, id) => plain([S.local[id], S.prs[id], S.roadmap[id], S.state[id], S.req[id]]);
const directOf = (tag) => { const f = facts(tag); return [f.local, f.prs, f.roadmap, f.state, { state: 'loaded', data: f.req }]; };

function loadPage() {
  const clock = { t: BASE };
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const boards = [];
  const counter = { draws: 0 };
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } }
  const respond = (url, opts) => {
    if (routes[url]) return routes[url](url, opts);
    if (url.startsWith('/api/board?')) { const next = boards.shift(); return next ? next() : new Promise(() => {}); }
    if (url === '/api/board/refresh') return Promise.resolve(ok({ started: true }));
    const kind = KINDS.find((k) => url.startsWith(`${AUTO[k]}?`));
    return kind ? Promise.resolve(ok(facts('direct')[kind])) : new Promise(() => {});
  };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, Date: FakeDate,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body }); return respond(url, opts); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  const realDraw = ctx.draw;
  ctx.draw = (...a) => { counter.draws++; return realDraw(...a); };
  const run = (code) => vm.runInContext(code, ctx);
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  const S = run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'alpha', path: 'p' }, { id: 'xyz', name: 'beta', path: 'q' }] }];
  return { ctx, S, run, tick, fetches, routes, boards, clock, counter, get };
}
const board0 = (page) => page.fetches.filter((f) => f.url.startsWith('/api/board?')).map((f) => f.url);
const refreshPosts = (page) => page.fetches.filter((f) => f.url === '/api/board/refresh');
const perRepo = (page) => page.fetches.filter((f) => /^\/api\/(local|prs|roadmap|requirements|state)\?/.test(f.url)).map((f) => f.url);

// ---------- (1) a restarted server ----------
test('restart: an answer whose rev is LOWER than S.boardRev applies every repo of it, takes the new rev and asks since=<new rev> next', async () => {
  const page = loadPage();
  const { S } = page;
  page.boards.push(answer(board(5, { abc: entry(5, 'a1'), xyz: entry(5, 'x1') })));
  await page.run('loadBoard()');
  assert.equal(page.run('S.boardRev'), 5);
  page.boards.push(answer(board(2, { abc: entry(2, 'a2', BASE + 10), xyz: entry(1, 'x2', BASE + 10) })));
  await page.run('loadBoard()');
  assert.deepEqual(cardOf(S, 'abc'), directOf('a2'), 'applied, not dropped as unchanged');
  assert.deepEqual(cardOf(S, 'xyz'), directOf('x2'));
  assert.equal(page.run('S.boardRev'), 2, 'not stuck on the old rev');
  page.boards.push(answer(board(2)), answer(board(3, { abc: entry(3, 'a3', BASE + 20) })));
  page.counter.draws = 0;
  await page.run('loadBoard()');
  assert.equal(page.counter.draws, 0, 'equal rev and no repos: nothing is drawn');
  await page.run('loadBoard()');
  assert.deepEqual(board0(page), ['/api/board?since=0', '/api/board?since=5', '/api/board?since=2', '/api/board?since=2']);
  assert.deepEqual([page.run('S.boardRev'), cardOf(S, 'abc')], [3, directOf('a3')]);
});

// ---------- (2) the send action ----------
test('send: when a command sent from the page finishes (loadPiStatus -> applyPiState -> refreshRepo) the page POSTs /api/board/refresh with that repo, once, and its direct reads win', async () => {
  const page = loadPage();
  const { S } = page;
  S.sent.abc = { at: BASE, busySeen: true };
  S.pistatus.abc = 'busy';
  page.routes['/api/pi-status?id=abc'] = () => Promise.resolve(ok({ state: 'idle' }));
  page.routes['/api/pi-status?id=abc&tail=1'] = () => Promise.resolve(ok({ tail: '' })); // a verdict that needs attention asks for the screen tail
  await page.run("loadPiStatus('abc')");
  await page.tick();
  assert.deepEqual(perRepo(page), ['local', 'prs', 'roadmap', 'requirements', 'state'].map((k) => `/api/${k}?id=abc`), 'the finishing refresh read the repo directly');
  const posts = refreshPosts(page);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { id: 'abc' });
  assert.equal(posts[0].headers['x-priority'], 'user');
  assert.deepEqual(cardOf(S, 'abc'), directOf('direct'));
  for (const at of [BASE - 1, BASE]) {
    page.boards.push(answer(board(7, { abc: entry(7, 'board', at) })));
    await page.run('loadBoard()');
    assert.deepEqual(cardOf(S, 'abc'), directOf('direct'), `a board fact at ${at - BASE} does not overwrite the direct read`);
  }
  await page.run("loadPiStatus('abc')");
  await page.tick();
  assert.equal(refreshPosts(page).length, 1, 'a poll that finds nothing new asks for nothing more');
});

// ---------- (3) per-fact page times ----------
test('stale guard: the page time is kept PER FACT, so one answer can drop an older local and apply a newer prs', async () => {
  const page = loadPage();
  const { S } = page;
  page.clock.t = BASE + 10;
  await page.run("loadPrs('abc')");
  page.clock.t = BASE + 100;
  await page.run("loadLocal('abc')");
  const at = { local: BASE + 50, prs: BASE + 200, roadmap: BASE + 50, state: BASE + 50, req: BASE + 50 };
  page.boards.push(answer(board(7, { abc: entry(7, 'board', BASE, { at }) })));
  await page.run('loadBoard()');
  const [local, prs, roadmap, state, req] = cardOf(S, 'abc');
  const [dLocal] = directOf('direct');
  const [, bPrs, bRoadmap, bState, bReq] = directOf('board');
  assert.deepEqual(local, dLocal, 'board local (BASE+50) is older than the direct read at BASE+100: ignored');
  assert.deepEqual([prs, roadmap, state, req], [bPrs, bRoadmap, bState, bReq], 'board prs (BASE+200) is newer than the prs read at BASE+10, and the never-read facts come from the board');
});
