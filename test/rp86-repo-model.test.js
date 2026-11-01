'use strict';
// RP86 (S9): ONE read model per repo. V.repoModel (pure, public/view.js) joins what the page knows of a repo (its local state, its PRs, the roadmap, the
// declared state, the requirements and the Summary row with the session lifted to "working" while a command runs) so that the board cards, the Summary
// cards, the "go work on" strip and the Files tab all read the same object instead of each reading S.* its own way. It also closes the gap between the two
// channels that feed a Summary card: when a fact of a repo CHANGES (board or direct read) the page asks for /api/summary soon, grouped, instead of
// waiting for the 20 s tick. No network, no real clock: timers and fetch are the test's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const local = (o = {}) => ({ branch: 'feat/x', files: [], added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false, ...o });
const FILES = [{ path: 'a.js', status: 'M' }, { path: 'b.js', status: 'A' }];
const ROW = { id: 'abc', name: 'demo', session: { state: 'free' }, action: { kind: 'deliver' } };

// ---------- pure ----------
test('m1: with nothing known the model is empty but whole: no errors, nothing loaded, no chips, no row', () => {
  for (const m of [V.repoModel(), V.repoModel({}), V.repoModel(null)]) {
    assert.deepEqual([m.l, m.p, m.prs, m.dirty, m.unpushed, m.ready, m.loaded, m.changes, m.row], [{}, {}, [], false, false, 0, false, null, null]);
    assert.deepEqual([m.roadmap, m.state, m.req], [null, null, null]);
  }
});

test('m2: dirty, unpushed and ready are what info() computed: files, commits ahead and the PRs that can merge', () => {
  const m = V.repoModel({ local: local({ files: FILES, ahead: 2 }), prs: { prs: [{ number: 1, ready: true }, { number: 2, ready: false }, { number: 3, ready: true }] } });
  assert.deepEqual([m.dirty, m.unpushed, m.ready, m.prs.length], [true, true, 2, 3]);
  const clean = V.repoModel({ local: local(), prs: { prs: [] } });
  assert.deepEqual([clean.dirty, clean.unpushed, clean.ready], [false, false, 0]);
  assert.equal(V.repoModel({ local: { error: 'x' }, prs: {} }).dirty, false, 'an errored local state is not dirty');
});

test('m3: loaded needs a good local state with its file list AND a good PR answer, as the Summary button required', () => {
  const ok = { local: local(), prs: { prs: [] } };
  assert.equal(V.repoModel(ok).loaded, true);
  for (const bad of [{ prs: ok.prs }, { local: ok.local }, { ...ok, local: { error: 'boom' } }, { ...ok, prs: { error: 'gh down' } }, { ...ok, local: { branch: 'x' } }, { ...ok, local: { files: 'no' } }]) {
    assert.equal(V.repoModel(bad).loaded, false, JSON.stringify(bad));
  }
});

test('m4: the change chips are the local numbers with 0 defaults, and null until the local state is loaded', () => {
  assert.deepEqual(V.repoModel({ local: local({ files: FILES, added: 5, deleted: 2, ahead: 1, behind: 3, noUpstream: true }) }).changes, { files: 2, added: 5, deleted: 2, ahead: 1, behind: 3, noUpstream: true });
  assert.deepEqual(V.repoModel({ local: { files: [] } }).changes, { files: 0, added: 0, deleted: 0, ahead: 0, behind: 0, noUpstream: false });
  for (const bad of [undefined, null, { error: 'x' }, { files: 'no' }, {}]) assert.equal(V.repoModel({ local: bad }).changes, null);
});

test('m5: a free session of a repo whose command is running reads as working at once; nothing else changes and the input is never mutated', () => {
  const row = { ...ROW, session: { state: 'free' } };
  const frozen = JSON.stringify(row);
  assert.equal(V.repoModel({ row, running: true }).row.session.state, 'working');
  assert.equal(V.repoModel({ row, running: true }).row.action.kind, 'deliver', 'the rest of the row is untouched');
  assert.equal(JSON.stringify(row), frozen);
  assert.equal(V.repoModel({ row, running: false }).row, row, 'not running: the very same row');
  for (const state of ['working', 'waiting', 'none', 'unknown']) assert.equal(V.repoModel({ row: { ...ROW, session: { state } }, running: true }).row.session.state, state);
  assert.equal(V.repoModel({ row: null, running: true }).row, null);
  assert.equal(V.repoModel({ row: { id: 'x' }, running: true }).row.id, 'x', 'a row with no session');
});

test('m6: roadmap, declared state and requirements are passed through untouched', () => {
  const roadmap = { available: true, rows: [{ id: 'RP1' }] };
  const state = { state: 'working' };
  const req = { state: 'loaded', data: {} };
  const m = V.repoModel({ roadmap, state, req });
  assert.deepEqual([m.roadmap, m.state, m.req], [roadmap, state, req]);
});

test('m7: any input gives an object and never throws', () => {
  for (const x of [undefined, null, 5, 'x', [], { local: 5, prs: 'x', row: 7, running: 'yes' }, { local: { files: [null] }, prs: { prs: [null, 3, {}] } }]) {
    const m = V.repoModel(x);
    assert.equal(typeof m, 'object');
    assert.ok(Array.isArray(m.prs));
  }
});

// ---------- the page ----------
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
  const timers = [];
  const calls = [];
  const routes = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url) => { calls.push(url); const r = routes[url.split('?')[0]]; return r ? Promise.resolve().then(() => r(url)) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  const summaryCalls = () => calls.filter((u) => u === '/api/summary').length;
  return { run, tick, timers, routes, summaryCalls, get };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const summaryOf = (row, n = 1) => ({ generatedAt: `t${n}`, counts: {}, attention: [], rows: [{ id: 'abc', name: 'demo', group: 'g', room: null, branch: 'feat/x', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, ...row }] });
const seed = (page, { tab = 'summary', summary = summaryOf({ action: { kind: 'deliver' }, session: { state: 'free' } }) } = {}) => page.run(`
  S.groups = [{ name: 'g', repos: [{ id: 'abc', path: 'p', name: 'demo', group: 'g' }] }];
  S.tab = ${JSON.stringify(tab)};
  S.summary = ${JSON.stringify(summary)}; S.summaryKey = JSON.stringify({ ...S.summary, generatedAt: null });
  S.local.abc = ${JSON.stringify(local({ files: FILES }))}; S.prs.abc = { prs: [] };`);
const summaryTimers = (page) => page.timers.filter((t) => t.ms > 0 && t.ms <= 1500);

test('p1: modelOf(id) is what info(), the Summary chips and the Summary button read: same object for the same repo', async () => {
  const page = loadPage();
  seed(page);
  // The page runs in its own vm context: compare by value, not by prototype.
  const json = (code) => JSON.parse(page.run(`JSON.stringify(${code})`));
  const m = json('modelOf("abc")');
  assert.deepEqual(json('info({ id: "abc" })'), { l: m.l, p: m.p, prs: m.prs, dirty: m.dirty, unpushed: m.unpushed, ready: m.ready });
  assert.deepEqual(json('summaryChanges("abc")'), m.changes);
  assert.equal(page.run('summaryChanges("abc").files'), 2);
  assert.equal(page.run('summaryChanges("zzz")'), null, 'an unknown repo has no chips');
  assert.equal(page.run('summaryFlow("zzz")'), null);
  assert.equal(page.run('modelOf("zzz").loaded'), false);
});

test('p2: the Summary rows the page shows come from the model: a running command lifts a free session to working, S.summary is never changed', async () => {
  const page = loadPage();
  seed(page);
  page.run("S.sending.abc = 'flow-commit'");
  assert.equal(page.run('summaryShown().rows[0].session.state'), 'working');
  assert.equal(page.run('S.summary.rows[0].session.state'), 'free', 'the server answer is untouched');
  page.run('delete S.sending.abc');
  assert.equal(page.run('summaryShown().rows[0].session.state'), 'free');
});

test('p3: the gap between the two channels: a CHANGED fact of a repo asks for /api/summary within 1.5 s, once for any number of changes', async () => {
  const page = loadPage();
  page.routes['/api/summary'] = () => ok(summaryOf({ action: { kind: 'branch' }, session: { state: 'free' } }, 2));
  seed(page);
  page.run('S.roadmap.abc = { available: false }; S.state.abc = { state: "working" };');
  assert.equal(summaryTimers(page).length, 0);
  page.run('setFact("local", "abc", ' + JSON.stringify(local({ files: [], ahead: 1 })) + ')');
  page.run('setFact("prs", "abc", { prs: [{ number: 7, ready: true }] })');
  page.run('setFact("roadmap", "abc", { available: true })');
  page.run('setFact("state", "abc", { state: "ready-to-pr" })');
  assert.equal(summaryTimers(page).length, 1, 'grouped into one request');
  assert.equal(page.summaryCalls(), 0, 'not before the timer');
  summaryTimers(page)[0].fn();
  await page.tick();
  assert.equal(page.summaryCalls(), 1);
  assert.equal(page.run('S.summary.rows[0].action.kind'), 'branch', 'the row caught up with the facts');
});

test('p4: the gap closes for the card too: after the facts change and the answer arrives, the Summary card and the board agree', async () => {
  const page = loadPage();
  page.routes['/api/summary'] = () => ok(summaryOf({ action: { kind: 'branch' }, session: { state: 'free' } }, 2));
  seed(page);
  page.run('draw()');
  await page.tick();
  assert.match(page.get('#summary').html, /data-cmd="flow-commit"/, 'before: the dirty repo offers /flow-commit');
  page.run('setFact("local", "abc", ' + JSON.stringify(local({ files: [], ahead: 0 })) + ')');
  summaryTimers(page)[0].fn();
  await page.tick();
  assert.doesNotMatch(page.get('#summary').html, /data-cmd="flow-commit"/, 'after: the clean repo no longer offers it');
  assert.match(page.get('#summary').html, /data-cmd="flow-base"/);
});

test('p5: an unchanged fact, another tab, a page that has not loaded the Summary yet, or a repeated write never asks for it', async () => {
  const page = loadPage();
  seed(page);
  page.run('setFact("local", "abc", JSON.parse(JSON.stringify(S.local.abc)))');
  page.run('setFact("prs", "abc", JSON.parse(JSON.stringify(S.prs.abc)))');
  assert.equal(summaryTimers(page).length, 0, 'same content: nothing to refresh');
  page.run('S.tab = "work"; setFact("local", "abc", { ...S.local.abc, ahead: 5 })');
  assert.equal(summaryTimers(page).length, 0, 'the Work tab does not read the Summary');
  page.run('S.tab = "summary"; S.summary = null; setFact("local", "abc", { ...S.local.abc, ahead: 6 })');
  assert.equal(summaryTimers(page).length, 0, 'the first load is the own one of refreshAll');
  const fresh = loadPage();
  seed(fresh);
  fresh.run('setFact("roadmap", "abc", { available: true }); setFact("state", "abc", { state: "working" }); delete S.local.abc; setFact("local", "abc", { branch: "x", files: [] })');
  assert.equal(summaryTimers(fresh).length, 0, 'the FIRST value of a fact (start-up, the Summary answered before the board) is not a change');
});

test('p6: every writer of a fact that feeds the row goes through setFact: the loaders, the roadmap read and the board', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /S\.(local|prs|roadmap|state)\[id\] = (d|f\.\w+);/, 'no raw write of a fact from an answer');
  for (const kind of ['local', 'prs', 'roadmap', 'state']) assert.match(app, new RegExp(`setFact\\('${kind}', id,`));
});

test('p7: an older /api/summary answer that arrives after a newer one never replaces it', async () => {
  const page = loadPage();
  const late = {};
  let n = 0;
  page.routes['/api/summary'] = () => (++n === 1 ? new Promise((r) => { late.first = r; }) : ok(summaryOf({ action: { kind: 'branch' }, session: { state: 'free' } }, 2)));
  seed(page);
  const first = page.run('loadSummary()');
  await page.tick();
  page.run('loadSummary()');
  await page.tick();
  assert.equal(page.run('S.summary.rows[0].action.kind'), 'branch');
  late.first(ok(summaryOf({ action: { kind: 'deliver' }, session: { state: 'free' } }, 1)));
  await first;
  await page.tick();
  assert.equal(page.run('S.summary.rows[0].action.kind'), 'branch', 'the late old answer was dropped');
});

test('p8: a board answer older than a direct read still never overwrites it (the stamp guard stays)', async () => {
  const page = loadPage();
  seed(page);
  page.run("S.factAt.abc = { local: Date.now() + 10000 }");
  const out = page.run(`V.boardApply({ rev: 1, repos: { abc: { local: ${JSON.stringify(local({ files: [] }))}, at: { local: 1 } } }, refreshing: [] }, { lastAt: S.factAt })`);
  assert.deepEqual(out.set.abc, {}, 'the older board fact is dropped');
});

test('p9: the touch re-arms after it fired: a second change later asks again', async () => {
  const page = loadPage();
  page.routes['/api/summary'] = () => ok(summaryOf({ action: { kind: 'deliver' }, session: { state: 'free' } }, 2));
  seed(page);
  page.run('setFact("local", "abc", { ...S.local.abc, ahead: 1 })');
  summaryTimers(page)[0].fn();
  await page.tick();
  page.run('setFact("local", "abc", { ...S.local.abc, ahead: 2 })');
  assert.equal(summaryTimers(page).length, 2, 'a new timer for the new change');
});

test('p10: each of the four kinds arms the timer on its own once it had a value', () => {
  const next = { local: local({ files: FILES, ahead: 9 }), prs: { prs: [{ number: 1 }] }, roadmap: { available: true }, state: { state: 'blocked' } };
  for (const kind of Object.keys(next)) {
    const page = loadPage();
    seed(page);
    page.run('S.roadmap.abc = { available: false }; S.state.abc = { state: "working" };');
    page.run('setFact(' + JSON.stringify(kind) + ', "abc", ' + JSON.stringify(next[kind]) + ')');
    assert.equal(summaryTimers(page).length, 1, kind);
  }
});

test('p11: modelOf gives the Summary row of the repo it is handed, lifted while a command runs; without a row it gives none', () => {
  const page = loadPage();
  seed(page);
  page.run("S.sending.abc = 'flow-commit'");
  assert.equal(page.run('modelOf("abc", S.summary.rows[0]).row.session.state'), 'working');
  assert.equal(page.run('modelOf("abc").row'), null, 'info() and the others ask for no row');
  assert.equal(page.run('S.summary.rows[0].session.state'), 'free');
  assert.equal(page.run('typeof summaryRowOf'), 'undefined', 'no lookup helper is left over');
});

test('p12: an answer older than one already applied is dropped, but an older one that arrives FIRST still applies (no starvation)', async () => {
  const page = loadPage();
  const late = [];
  page.routes['/api/summary'] = () => new Promise((r) => late.push(r));
  seed(page);
  const first = page.run('loadSummary()');
  const second = page.run('loadSummary()');
  await page.tick();
  late[0](ok(summaryOf({ action: { kind: 'start' }, session: { state: 'free' } }, 7))); // not the same payload as the seed: an identical one is (by design) not redrawn
  await first;
  await page.tick();
  assert.equal(page.run('S.summary.generatedAt'), 't7', 'the older answer came first and was applied: a slow build never starves the Summary');
  late[1](ok(summaryOf({ action: { kind: 'branch' }, session: { state: 'free' } }, 8)));
  await second;
  await page.tick();
  assert.equal(page.run('S.summary.generatedAt'), 't8');
});

test('p13: an older read that fails after a newer one was applied does not flag the Summary as failed', async () => {
  const page = loadPage();
  const late = [];
  page.routes['/api/summary'] = () => new Promise((r, j) => late.push({ r, j }));
  seed(page);
  const first = page.run('loadSummary()');
  const second = page.run('loadSummary()');
  await page.tick();
  late[1].r(ok(summaryOf({ action: { kind: 'branch' }, session: { state: 'free' } }, 2)));
  await second;
  await page.tick();
  late[0].j(new Error('timeout'));
  await first;
  await page.tick();
  assert.equal(page.run('S.summaryFailed'), false);
  assert.equal(page.run('S.summary.generatedAt'), 't2');
});
