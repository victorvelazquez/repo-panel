'use strict';
// RP94 part b2 (S9): two more things the cards showed without need. With ONE room defined, the room tag is only its status dot (the name, the state and the last commit
// stay in the tooltip and the aria-label); with several rooms it keeps its name, because there the name tells them apart. The status line (the "what to do now" an
// agent declared in .panel/state.json) is hidden only when it would repeat the roadmap block: the declared state is `working` (or it is outdated) AND the card shows
// a roadmap block. needs-input, blocked, ready-to-commit and ready-to-pr always stay: they say something the roadmap does not and ask something of the person.
// How it LOOKS is for the person to approve by looking; these tests pin the rules. No network, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const css = read('style.css');
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const AT = new Date(NOW - 60000).toISOString();
const st = (state, o = {}) => ({ available: true, state, next: 'do the next thing', at: AT, ...o });

// ---------- pure: when the status line is hidden ----------
test('h1: with a roadmap block, a `working` state is hidden (the roadmap already says it is in progress)', () => {
  const data = st('working');
  assert.equal(V.stateLineHidden(data, V.stateLine(data, { now: NOW }), true), true);
});

test('h2: with a roadmap block, an outdated state (an expired `working`, or a stale one) is hidden too: it was only a gray marker', () => {
  const old = st('working', { at: new Date(NOW - 31 * 60000).toISOString() });
  const line = V.stateLine(old, { now: NOW });
  assert.equal(line.kind, 'outdated');
  assert.equal(V.stateLineHidden(old, line, true), true);
  const stale = st('ready-to-pr', { stale: true });
  assert.equal(V.stateLine(stale, { now: NOW }).kind, 'outdated');
  assert.equal(V.stateLineHidden(stale, V.stateLine(stale, { now: NOW }), true), true);
});

test('h3: needs-input, blocked, ready-to-commit and ready-to-pr are NEVER hidden, with or without a roadmap block', () => {
  for (const state of ['needs-input', 'blocked', 'ready-to-commit', 'ready-to-pr']) {
    const data = st(state);
    const line = V.stateLine(data, { now: NOW });
    assert.equal(line.kind, 'current', state);
    for (const withRoadmap of [true, false]) assert.equal(V.stateLineHidden(data, line, withRoadmap), false, `${state} ${withRoadmap}`);
  }
});

test('h4: without a roadmap block nothing is hidden (the line is then the only thing that says what is going on), and with no line there is nothing to hide', () => {
  const data = st('working');
  assert.equal(V.stateLineHidden(data, V.stateLine(data, { now: NOW }), false), false);
  assert.equal(V.stateLineHidden(data, V.stateLine(data, { now: NOW }), undefined), false);
  assert.equal(V.stateLineHidden(null, null, true), false);
  assert.equal(V.stateLineHidden(undefined, undefined, true), false);
});

test('h5: it is total: any input gives true or false and never fails', () => {
  for (const args of [[], [5, 'x', 1], [[], {}, true], [{ state: 'working' }, { kind: 'current' }, true], [{ state: 'working' }, 'x', true]]) assert.equal(typeof V.stateLineHidden(...args), 'boolean');
  assert.equal(V.stateLineHidden({ state: 'working' }, { kind: 'current' }, true), true, 'a working state with a line is hidden');
});

// ---------- the pages ----------
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
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(read('app.js'), ctx);
  return { run: (c) => vm.runInContext(c, ctx) };
}
const REPO = '{ id: "abc", path: "p", name: "demo", group: "Personal" }';
const DIRTY = { branch: 'feat/x', files: [{ path: 'a.js', status: 'M' }], added: 1, deleted: 0, ahead: 0, behind: 0 };
const seed = (page, local = { branch: 'main', files: [], ahead: 0, behind: 0 }) => page.run(`S.groups = [{ name: 'Personal', repos: [${REPO}] }]; S.group = ''; S.rooms = []; S.roomData = { state: 'loading' }; S.req = {}; S.state = {}; S.roadmap = {}; S.local.abc = ${JSON.stringify(local)}; S.prs.abc = { prs: [] }; S.menu = null;`);
const ROADMAP = "S.roadmap.abc = { available: true, summary: { kind: 'next', id: 'X1', entrega: 'y', waiting: [], extra: 0, problems: { total: 0 }, done: 3, total: 12, pct: 25, header: {} } };";
const stateJs = (state) => `S.state.abc = { available: true, state: '${state}', next: 'do the next thing', at: new Date().toISOString() };`;

// ---------- the room tag ----------
test('t1: with ONE room the tag is only its dot: no name text, and the name and the last commit are in the tooltip and the aria-label', () => {
  const page = loadPage();
  seed(page);
  page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }]; S.roomData = { state: 'loaded', data: { rooms: [{ name: 'UPEN', repos: ['abc'], lastCommit: '2026-04-30T10:00:00Z' }] } };");
  const h = page.run(`roomTag(${REPO})`);
  assert.match(h, /^<span class="tag room-tag room-dot" role="img" title="Room UPEN · last commit 2026-04-30" aria-label="Room UPEN · last commit 2026-04-30"><span class="dot dot-gray"><\/span><\/span>$/);
  assert.doesNotMatch(h, />UPEN</);
});

test('t2: with SEVERAL rooms the tag keeps its name next to the dot, as before', () => {
  const page = loadPage();
  seed(page);
  page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }, { name: 'Other', repos: [] }];");
  const h = page.run(`roomTag(${REPO})`);
  assert.match(h, /^<span class="tag room-tag" title="[^"]*"><span class="dot dot-gray"><\/span>UPEN<\/span>$/);
});

test('t3: a repo outside any room has no tag, with one room or several; a room that is not loaded still says "checking"', () => {
  const page = loadPage();
  seed(page);
  page.run("S.rooms = [{ name: 'UPEN', repos: [] }];");
  assert.equal(page.run(`roomTag(${REPO})`), '');
  page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }];");
  assert.match(page.run(`roomTag(${REPO})`), /title="Room UPEN · checking the room…" aria-label="Room UPEN · checking the room…"><span class="dot dot-gray">/);
});

test('t4: the board card and the clean row carry the dot-only tag with one room, and the name with several; the repo name is untouched', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run("S.rooms = [{ name: 'UPEN', repos: ['abc'] }];");
  for (const fn of ['repoCard', 'cleanRow']) {
    const h = page.run(`${fn}(${REPO})`);
    assert.match(h, /room-tag room-dot/, fn);
    assert.match(h, /class="repo-name"/, fn);
  }
  page.run("S.rooms.push({ name: 'Other', repos: [] });");
  assert.doesNotMatch(page.run('repoCard(' + REPO + ')'), /room-dot/);
});

test('t5: the dot-only tag has a style: it is a small round tag, and a visible keyboard focus is not needed (it is not interactive)', () => {
  assert.match(css, /\.room-dot\s*\{[^}]*padding/);
});

// ---------- the status line ----------
test('s1: a card with a roadmap block and a `working` state has no status line; a card with a different state keeps it', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run(`${ROADMAP} ${stateJs('working')}`);
  const hidden = page.run(`repoCard(${REPO})`);
  assert.doesNotMatch(hidden, /state-line/);
  assert.match(hidden, /class="roadmap"/);
  for (const state of ['needs-input', 'blocked', 'ready-to-commit', 'ready-to-pr']) {
    page.run(stateJs(state));
    assert.match(page.run(`repoCard(${REPO})`), new RegExp(`class="state-line"[^>]*><span class="dot dot-${{ 'needs-input': 'blue', blocked: 'red', 'ready-to-commit': 'green', 'ready-to-pr': 'green' }[state]}"></span><span class="state-text">do the next thing</span>`), state);
  }
});

test('s2: without a roadmap block the `working` line stays (it is then the only thing that says what is going on)', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run(stateJs('working'));
  const h = page.run(`repoCard(${REPO})`);
  assert.match(h, /class="state-line"/);
  assert.doesNotMatch(h, /class="roadmap"/);
});

test('s3: an outdated state (the gray marker) is hidden too when there is a roadmap block, and shown when there is none', () => {
  const page = loadPage();
  seed(page, DIRTY);
  page.run("S.state.abc = { available: true, state: 'working', next: 'x', at: new Date(Date.now() - 40 * 60000).toISOString() };");
  assert.match(page.run(`repoCard(${REPO})`), /class="state-line"/);
  page.run(ROADMAP);
  assert.doesNotMatch(page.run(`repoCard(${REPO})`), /state-line/);
});

test('s4: the clean row never had a status line and still has none', () => {
  const page = loadPage();
  seed(page);
  page.run(`${ROADMAP} ${stateJs('needs-input')}`);
  assert.doesNotMatch(page.run(`cleanRow(${REPO})`), /state-line/);
});

test('s5: the page decides with the model it already has: stateRow asks V.stateLineHidden and the roadmap block', () => {
  const src = read('app.js');
  assert.match(src, /V\.stateLineHidden\(/);
  assert.equal((src.match(/class="state-line"/g) || []).length, 2, 'the state line is built in one function (two shapes)');
});
