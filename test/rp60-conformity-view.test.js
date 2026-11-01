'use strict';
// RP60: Conformity is a full-width view (a tab), not a drawer over the current tab. The tab carries the count of repos that do not
// conform, the duplicate header button is gone, the shared filters (which never apply to the audit) are hidden while it is shown, and
// a repo name in it filters the board and takes the person back to the tab they came from. No network, no timers, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');

function element() {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
  };
  return el;
}

function loadPage() {
  const els = {};
  const saved = [];
  const tabEls = ['summary', 'work', 'conformity'].map((t) => ({ ...element(), dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element() },
    localStorage: { getItem: () => null, setItem: (k, v) => saved.push([k, v]) },
    location: { hash: '' },
    requestAnimationFrame: () => 1,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  ctx.RepoPanelResumen = require('../public/resumen.js');
  vm.runInContext(read('app.js'), ctx);
  return { get, saved, run: (code) => vm.runInContext(code, ctx) };
}

test('a1: opening Conformity does not save the tab, so a reload comes back to Summary or Work', () => {
  const page = loadPage();
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  page.saved.length = 0;
  page.run("ACTIONS.tab({ dataset: { tab: 'conformity' } })");
  assert.equal(page.run('S.tab'), 'conformity');
  assert.ok(!page.saved.some(([, v]) => /conformity/.test(v)), 'no preference holds the Conformity tab');
  assert.equal(page.run('S.prefs.tab'), 'work');
});

test('a2: a repo name in the view filters the board and returns to the tab the person came from', () => {
  const page = loadPage();
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  page.run("ACTIONS.tab({ dataset: { tab: 'conformity' } })");
  page.run("ACTIONS['queue-pick']({ dataset: { name: 'demo', close: '1' } })");
  assert.equal(page.run('S.tab'), 'work');
  assert.equal(page.run('S.q'), 'demo');
  assert.equal(page.get('#search').value, 'demo');
});

test('a3: a repo name of the Go work on strip (no close) only filters and stays on its tab', () => {
  const page = loadPage();
  page.run("ACTIONS['queue-pick']({ dataset: { name: 'demo' } })");
  assert.equal(page.run('S.tab'), 'summary');
  assert.equal(page.run('S.q'), 'demo');
});

test('a4: the first Conformity visit from Summary returns to Summary even when Work was used before', () => {
  const page = loadPage();
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  page.run("ACTIONS.tab({ dataset: { tab: 'summary' } })");
  page.run("ACTIONS.tab({ dataset: { tab: 'conformity' } })");
  page.run("ACTIONS['queue-pick']({ dataset: { name: 'x', close: '1' } })");
  assert.equal(page.run('S.tab'), 'summary');
});

test('a5: the deep link #conformity opens the tab', () => {
  assert.match(read('app.js'), /location\.hash === '#conformity'\) openConformity\(\)/);
  assert.match(read('app.js'), /function openConformity\(\) \{\s*setTab\('conformity'\)/);
});

test('b1: index.html has the Conformity tab with its badge, the full-width panel and no drawer or duplicate button', () => {
  const html = read('index.html');
  assert.match(html, /<button[^>]*id="tab-conformity"[^>]*aria-controls="conformityView"[^>]*>Conformity <span id="confBadge" class="badge" hidden><\/span><\/button>/);
  assert.match(html, /<section id="conformityView"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-conformity"[^>]*hidden>/);
  assert.doesNotMatch(html, /id="drawer"|drawerBody|drawerTitle|close-drawer/);
  assert.doesNotMatch(html, /<button id="conformity"|data-act="conformity"/);
});

test('b2: style.css hides the shared filters on this tab, keeps hidden working and has no drawer rules', () => {
  const css = read('style.css');
  assert.match(css, /body\.tab-conformity #viewbar\s*\{\s*display:\s*none/);
  assert.match(css, /#conformityView\[hidden\]/);
  assert.match(css, /\.rs-tabs \.badge/);
  assert.doesNotMatch(css, /#drawer|\.drawer-head|#conformity \.badge/);
});

test('b3: nothing in app.js still talks about the drawer', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /#drawer|confOpen|close-drawer|drawerBody|drawerTitle/);
});
