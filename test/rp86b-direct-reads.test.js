'use strict';
// RP86b (S9): after an action of the person (a session finished, a fetch, a merge, a re-run) the page asked the server to catch the repo up
// (POST /api/board/refresh: the server re-reads ALL its facts now and again 5 s later) AND read five routes by hand: the same repo twice. With the board
// leading, those actions now read directly only what gates a button at once (local, prs and the declared state) and leave the two slowest facts (roadmap and
// requirements) to the board, which brings them within seconds. Without a leading board (down, 404, never answered) every read stays, and so does a full
// refresh of a repo with no data. No network, no real clock: fetch and timers are the test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const LOCAL = { branch: 'feat/x', files: [], ahead: 0, behind: 0, added: 0, deleted: 0 };

function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const calls = [];
  const routes = {
    '/api/local': () => ok(LOCAL), '/api/prs': () => ok({ prs: [] }), '/api/roadmap': () => ok({ available: true }),
    '/api/requirements': () => ok({ results: [] }), '/api/state': () => ok(null), '/api/board/refresh': () => ok({ started: true }),
  };
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET' }); const r = routes[url.split('?')[0]]; return r ? Promise.resolve().then(() => r(url)) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  const routesRead = () => calls.filter((c) => c.method === 'GET' && /^\/api\/(local|prs|roadmap|requirements|state)\?id=abc$/.test(c.url)).map((c) => c.url.split('?')[0]).sort();
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/board/refresh').length;
  run("S.groups = [{ name: 'g', repos: [{ id: 'abc', path: 'p', name: 'demo', group: 'g' }] }];");
  return { run, tick, routes, calls, routesRead, posts };
}
const ALL = ['/api/local', '/api/prs', '/api/requirements', '/api/roadmap', '/api/state'];
const GATING = ['/api/local', '/api/prs', '/api/state'];
// What the board leading means to the page: it answered at least once and is not down.
const leading = (page) => page.run('board.applied = 1; board.failures = 0;');
// A repo that already holds its roadmap and its requirements (the usual case after the first load).
const known = (page) => page.run("S.roadmap.abc = { available: true }; S.req.abc = { state: 'loaded', data: {} };");

test('d1: with the board leading, an action reads directly local, prs and state, asks the server to catch up, and leaves roadmap and requirements to the board', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(page.routesRead(), GATING);
  assert.equal(page.posts(), 1);
});

test('d2: the same with poll: false (a session that finished): the declared state is still read, because it gates the commit button right then', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  await page.run("refreshRepo('abc', { poll: false, catchUp: true })");
  assert.deepEqual(page.routesRead(), GATING);
});

test('d3: a board that never answered still gets every direct read (and the catch-up request while it is not down)', async () => {
  const page = loadPage();
  known(page);
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(page.routesRead(), ALL);
  assert.equal(page.posts(), 1);
});

test('d4: a board that is down (three failures) gets every direct read and no catch-up request', async () => {
  const page = loadPage();
  page.run('board.applied = 1; board.failures = 3;');
  known(page);
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(page.routesRead(), ALL);
  assert.equal(page.posts(), 0);
});

test('d5: a refresh that is not an action of the person (refreshAll for a repo with no data) reads everything, even with the board leading', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  await page.run("refreshRepo('abc')");
  assert.deepEqual(page.routesRead(), ALL);
});

test('d6: each fact is judged on its own: a repo that has no roadmap yet, or whose requirements failed, still reads that one directly', async () => {
  const noRoadmap = loadPage();
  leading(noRoadmap);
  noRoadmap.run("S.req.abc = { state: 'loaded', data: {} };");
  await noRoadmap.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(noRoadmap.routesRead(), ['/api/local', '/api/prs', '/api/roadmap', '/api/state']);
  const badReq = loadPage();
  leading(badReq);
  badReq.run("S.roadmap.abc = { available: true }; S.req.abc = { state: 'failed' };");
  await badReq.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(badReq.routesRead(), ['/api/local', '/api/prs', '/api/requirements', '/api/state']);
});

test('d7: the board goes down after leading: the very next action goes back to reading everything', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(page.routesRead(), GATING);
  page.calls.length = 0;
  page.run('board.failures = 3;');
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.deepEqual(page.routesRead(), ALL);
});

test('d8: roadmap and requirements do arrive through the board and are applied (so skipping the direct read loses nothing)', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  page.routes['/api/board'] = () => ok({ rev: 5, refreshing: [], repos: { abc: { local: LOCAL, prs: { prs: [] }, roadmap: { available: true, marker: 'from-board' }, state: null, req: { results: [{ id: 'x' }] }, at: { local: 5, prs: 5, roadmap: 5, state: 5, req: 5 } } } });
  await page.run("refreshRepo('abc', { catchUp: true })");
  await page.run('loadBoard()');
  assert.equal(page.run('S.roadmap.abc.marker'), 'from-board');
  assert.equal(page.run('S.req.abc.data.results[0].id'), 'x');
});

test('d9: skipping a read leaves no loading counter behind', async () => {
  const page = loadPage();
  leading(page);
  known(page);
  await page.run("refreshRepo('abc', { catchUp: true })");
  assert.ok(!page.run('S.loading.abc'), 'the repo is not left "loading"');
});

test('d10: the four actions of the person still ask for the catch-up (the rule only applies to them)', () => {
  const app = read('app.js');
  assert.equal((app.match(/refreshRepo\(id, \{ catchUp: true \}\)/g) || []).length, 3, 'fetch, merge and re-run');
  assert.match(app, /refreshRepo\(id, \{ poll: false, catchUp: true \}\)/, 'a session that finished');
  assert.match(app, /const ask = missing \? /, 'refreshAll still reads the repos with no data');
});

test('d11: only a GOOD roadmap is left to the board: one held as a failed read (null) or as "no roadmap" is read directly again', async () => {
  for (const held of ['null', '{ available: false }', '{ error: "x" }']) {
    const page = loadPage();
    leading(page);
    page.run("S.req.abc = { state: 'loaded', data: {} }; S.roadmap.abc = " + held + ';');
    await page.run("refreshRepo('abc', { catchUp: true })");
    assert.deepEqual(page.routesRead(), ['/api/local', '/api/prs', '/api/roadmap', '/api/state'], held);
  }
  const good = loadPage();
  leading(good);
  known(good);
  await good.run("refreshRepo('abc', { catchUp: true })");
  assert.ok(!good.routesRead().includes('/api/roadmap'), "a good roadmap is left to the board");
});
