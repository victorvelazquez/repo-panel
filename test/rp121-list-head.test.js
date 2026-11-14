'use strict';
// RP121 (S16): the filters of the Summary (search, group, scope and Needs attention) leave the bar under the tabs and live in the header of the repos column, as a thin bar of
// icons (artboards D and E of design/panel-filtros). RP189 (S4) trimmed it: in reposo the title with the count, the + menu, Working now and a ⋮ button. Search is an item of the ⋮ menu
// (or the key `/`; Escape closes it), the menu holds the scope and the group too, and while a filter is set the ⋮ button has a dot. The legend, Needs attention and the strip of chips are gone.
// Work keeps its own bar (option A). The state stays the shared one (S.q, S.group, S.scope, S.sfilter). How it LOOKS and the real clicks are for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('style.css');

const row = (o) => ({ id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null, ...o });
const payload = { rows: [row({ id: 'a', name: 'alpha', needs: true, room: 'R1' }), row({ id: 'b', name: 'beta', group: 'H' }), row({ id: 'c', name: 'gamma', needs: true, group: 'H', room: 'R1' })], generatedAt: 'x' };
const ROOMS = [{ name: 'R1', repos: ['a', 'c'] }];

// ---------- static page ----------
test('h1: the repos column is a wrapper with the header above the list, before the separator, and the header has every control', () => {
  const m = /<div id="sumLayout" class="chatlayout">\s*<div id="listCol">([\s\S]*?)<\/section>\s*<\/div>\s*<div id="split"/.exec(html);
  assert.ok(m, 'listCol wraps the header and the list, and comes right before the first separator');
  assert.ok(m[1].indexOf('id="listHead"') >= 0 && m[1].indexOf('id="listHead"') < m[1].indexOf('id="summary"'), 'the header is above the list');
  for (const id of ['lhTitle', 'lhCount', 'lhSearchBox', 'lhSearch', 'lhIcons', 'lhFilterBtn', 'lhDot', 'lhLive', 'lhMenu', 'lhScope', 'lhGroup']) assert.ok(m[1].includes(`id="${id}"`), id);
  assert.match(m[1], /id="lhFilterBtn"[^>]*aria-expanded="false"[^>]*aria-controls="lhMenu"|id="lhFilterBtn"[^>]*aria-controls="lhMenu"[^>]*aria-expanded="false"/);
  assert.match(m[1], /id="lhSearchBox"[^>]*hidden/);
  assert.match(m[1], /id="lhMenu"[^>]*hidden/);
});

test('h2: the bar under the tabs keeps the shared controls for Work and no longer holds the Summary tools', () => {
  const bar = /<div class="viewbar" id="viewbar">([\s\S]*?)<\/div>\s*<div id="sumLayout"/.exec(html);
  assert.ok(bar, 'the view bar');
  for (const id of ['search', 'groupFilter', 'scope', 'workTools']) assert.ok(bar[1].includes(`id="${id}"`), id);
  assert.ok(!bar[1].includes('id="summaryTools"'), 'the attention toggle moved into the header');
});

test('h3: the bar under the tabs is out in Summary and still in Work, and the column wrapper takes the width the list had', () => {
  assert.match(css, /body\.tab-summary #viewbar\s*\{\s*display:\s*none;\s*\}/);
  assert.doesNotMatch(css, /body\.tab-work #viewbar/);
  assert.match(css, /\.chatlayout\.chat-open #listCol\s*\{[^}]*width:\s*var\(--list-w/);
  assert.match(css, /#listHead\s*\{[^}]*position:\s*sticky|#listHead\s*\{[^}]*flex:\s*none/, 'the header stays while the list scrolls');
});

// ---------- pure ----------
test('s1: summaryTools keeps its Needs attention button for a bar, and the compact form (the repos header) is only the Working now icon: its count in the label, never Needs attention', () => {
  const ctx = { rooms: ROOMS, scope: { kind: 'all' }, q: '', group: '', filter: 'all' };
  assert.equal(R.summaryTools(payload, ctx), '<button type="button" data-act="sfilter" data-filter="attention" aria-pressed="false">Needs attention · 2</button>');
  const c = R.summaryTools(payload, { ...ctx, compact: true });
  assert.match(c, /data-act="slive" data-live="on"/);
  assert.match(c, /aria-pressed="false"/);
  assert.match(c, /aria-label="Working now · 3"/);
  assert.match(c, /<small>3<\/small>/);
  assert.doesNotMatch(c, /Needs attention|sfilter/, 'no Needs attention button in the header');
  const on = R.summaryTools(payload, { ...ctx, live: true, compact: true });
  assert.match(on, /data-live="off"/);
  assert.match(on, /aria-pressed="true"/);
  assert.equal(R.summaryTools(null, { compact: true }), '');
});

test('s4: listCount is the number of repos the list shows after the filters, and null with no data', () => {
  assert.equal(R.listCount(payload, { rooms: ROOMS, scope: { kind: 'all' }, q: '', group: '', filter: 'all' }), 3);
  assert.equal(R.listCount(payload, { rooms: ROOMS, scope: { kind: 'room', name: 'R1' }, q: '', group: '', filter: 'all' }), 2);
  assert.equal(R.listCount(payload, { rooms: ROOMS, scope: { kind: 'all' }, q: 'bet', group: 'H', filter: 'all' }), 1);
  assert.equal(R.listCount(null, {}), null);
  assert.equal(R.listCount({ rows: 'x' }, {}), null);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused = (el.focused || 0) + 1; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const docL = {};
  const store = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const key = (k, extra = {}) => { const e = { type: 'keydown', key: k, target: doc.activeElement || element(), prevented: false, preventDefault() { e.prevented = true; }, ...extra }; for (const fn of docL.keydown || []) fn(e); return e; };
  const click = (target) => { const e = { type: 'click', target, preventDefault() {} }; for (const fn of docL.click || []) fn(e); return e; };
  return { get, flush, doc, key, click, run: (c) => vm.runInContext(c, ctx) };
}
function seed(page) {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'a', name: 'alpha', path: 'p' }] }, { name: 'H', repos: [] }];
  S.rooms = ROOMS;
  S.summary = payload;
  S.tab = 'summary';
  page.run('drawSummary()');
  return S;
}
const fire = (el, type, e = {}) => { for (const fn of el.listeners[type] || []) fn({ type, target: el, preventDefault() {}, ...e }); };

test('g1: with no filter the bar shows the count and Working now, no dot', () => {
  const page = loadPage();
  seed(page);
  assert.equal(page.get('#lhCount').textContent, '3');
  assert.match(page.get('#lhLive').html, /aria-label="Working now · 3"/);
  assert.equal(page.get('#lhDot').hidden, true);
});

test('g2: with a filter set the ⋮ button has the dot; the count follows the filter', () => {
  const page = loadPage();
  const S = seed(page);
  S.scope = { kind: 'room', name: 'R1' };
  page.run('drawSummary()');
  assert.equal(page.get('#lhDot').hidden, false);
  assert.equal(page.get('#lhCount').textContent, '2');
});

test('g3: the menu holds the scope buttons and the group select, painted from the same state as the shared bar', () => {
  const page = loadPage();
  const S = seed(page);
  assert.equal(page.get('#lhScope').html, R.scopeBar(ROOMS, page.run('allRepos().length'), { kind: 'all' }));
  assert.match(page.get('#lhGroup').html, /<option value="">All groups<\/option><option selected>G<\/option>|<option value="">All groups<\/option><option >G<\/option><option >H<\/option>/);
  S.group = 'H';
  page.run('drawSummary()');
  assert.match(page.get('#lhGroup').html, /<option selected>H<\/option>/);
});

test('g4: typing in the header search sets the shared text and the shared bar follows; the other way too', () => {
  const page = loadPage();
  const S = seed(page);
  page.get('#lhSearch').value = 'alp';
  fire(page.get('#lhSearch'), 'input');
  assert.equal(S.q, 'alp');
  page.flush();
  assert.equal(page.get('#search').value, 'alp', 'Work shows the same text');
  assert.equal(page.get('#lhCount').textContent, '1');
  S.q = 'bet';
  page.run('drawSummary()');
  assert.equal(page.get('#lhSearch').value, 'bet', 'a text typed in the other bar shows here');
});

test('g5: the group select of the header sets the shared group', () => {
  const page = loadPage();
  const S = seed(page);
  page.get('#lhGroup').value = 'H';
  fire(page.get('#lhGroup'), 'change');
  assert.equal(S.group, 'H');
});

test('g6: the search icon turns the bar into the search box and the close button gives the bar back; the box takes the focus', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-search-open']()");
  page.flush();
  assert.equal(S.lh.search, true);
  assert.equal(page.get('#lhSearchBox').hidden, false);
  assert.equal(page.get('#lhTitle').hidden, true);
  assert.equal(page.get('#lhIcons').hidden, true);
  assert.ok(page.get('#lhSearch').focused >= 1, 'focus goes to the box');
  page.run("ACTIONS['lh-search-close']()");
  page.flush();
  assert.equal(page.get('#lhSearchBox').hidden, true);
  assert.equal(page.get('#lhTitle').hidden, false);
  assert.equal(page.get('#lhIcons').hidden, false);
});

test('g7: the funnel opens and closes the menu and says so to assistive tools', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-filters']()");
  page.flush();
  assert.equal(S.lh.menu, true);
  assert.equal(page.get('#lhMenu').hidden, false);
  assert.equal(page.get('#lhFilterBtn').attrs['aria-expanded'], 'true');
  page.run("ACTIONS['lh-filters']()");
  page.flush();
  assert.equal(page.get('#lhMenu').hidden, true);
  assert.equal(page.get('#lhFilterBtn').attrs['aria-expanded'], 'false');
});

test('g8: Escape closes the menu and the search before it closes the chat; with neither open it still closes the chat', () => {
  const page = loadPage();
  const S = seed(page);
  S.chat.id = 'a';
  page.run("ACTIONS['lh-filters']()");
  assert.equal(S.lh.menu, true);
  page.key('Escape');
  page.flush();
  assert.equal(S.lh.menu, false, 'Escape closes the menu on its own');
  assert.equal(S.chat.id, 'a', 'the chat stays open: the Escape was for the menu');
  page.run("ACTIONS['lh-search-open']()");
  assert.equal(S.lh.search, true);
  page.key('Escape');
  page.flush();
  assert.equal(S.lh.search, false, 'and the search box');
  assert.equal(S.chat.id, 'a', 'the chat stays open: the Escape was for the bar');
  page.key('Escape');
  assert.equal(S.chat.id, null, 'with the bar quiet the Escape closes the chat as before');
});

test('g9: the key / opens the search unless a field has the focus; with a modifier it is left alone', () => {
  const page = loadPage();
  const S = seed(page);
  const e = page.key('/');
  assert.equal(S.lh.search, true);
  assert.equal(e.prevented, true);
  page.run("ACTIONS['lh-search-close']()");
  page.doc.activeElement = { tagName: 'TEXTAREA', id: 'msgBox' };
  const typed = page.key('/');
  assert.equal(S.lh.search, false, 'typing a slash in the message box does not open the search');
  assert.equal(typed.prevented, false);
  page.doc.activeElement = null;
  page.key('/', { ctrlKey: true });
  assert.equal(S.lh.search, false);
  S.tab = 'work';
  page.key('/');
  assert.equal(S.lh.search, false, 'only in Summary');
});

test('g10: a click outside the header closes the menu; a click inside leaves it', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-filters']()");
  page.click({ closest: (sel) => (sel === '#listHead' ? {} : null), dataset: {} });
  assert.equal(S.lh.menu, true);
  page.click(element());
  assert.equal(S.lh.menu, false);
});

test('g12: the existing actions still work from the header: a scope button (and the attention filter action, which no button of the header reaches any more)', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS.scope({ dataset: { kind: 'room', name: 'R1' } })");
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'room', name: 'R1' });
  page.run("ACTIONS.sfilter({ dataset: { filter: 'attention' } })");
  assert.equal(S.sfilter, 'attention');
});

// ---------- the close button of the filter menu (RP121, S17) ----------
test('x1: the filter menu has a close button in its top right corner, with a name for assistive tools', () => {
  const m = /<div id="lhMenu"[^>]*>([\s\S]*?)<\/div>\s*<div id="lhLegend"|<div id="lhMenu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<section id="summary"/.exec(html);
  assert.ok(m, 'the menu block');
  const body = m[1] || m[2];
  assert.match(body, /<button type="button" class="lh-x lh-menu-x" data-act="lh-menu-close" aria-label="Close filters" title="Close">/);
  assert.ok(body.indexOf('lh-menu-x') < body.indexOf('<h4>Scope</h4>'), 'first in the block, so the keyboard reaches it first');
  const rule = css.slice(css.indexOf('\n.lh-menu-x {'), css.indexOf('}', css.indexOf('\n.lh-menu-x {')));
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /top:\s*\d+px/);
  assert.match(rule, /right:\s*\d+px/);
});

test('x2: the close button closes the menu, says so to assistive tools and gives the focus back to the funnel', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-filters']()");
  page.flush();
  assert.equal(S.lh.menu, true);
  const before = page.get('#lhFilterBtn').focused || 0;
  page.run("ACTIONS['lh-menu-close']()");
  page.flush();
  assert.equal(S.lh.menu, false);
  assert.equal(page.get('#lhMenu').hidden, true);
  assert.equal(page.get('#lhFilterBtn').attrs['aria-expanded'], 'false');
  assert.equal(page.get('#lhFilterBtn').focused, before + 1, 'the focus goes back to the funnel that opened the menu');
});

test('x3: the close button only closes the menu: the filters that were set stay, and a closed menu stays closed', () => {
  const page = loadPage();
  const S = seed(page);
  Object.assign(S, { q: 'alp', group: 'G', scope: { kind: 'room', name: 'R1' }, sfilter: 'attention' });
  page.run("ACTIONS['lh-filters']()");
  page.run("ACTIONS['lh-menu-close']()");
  page.run("ACTIONS['lh-menu-close']()");
  assert.equal(S.lh.menu, false);
  assert.equal(S.q, 'alp');
  assert.equal(S.group, 'G');
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'room', name: 'R1' });
  assert.equal(S.sfilter, 'attention');
});

// ---------- the close button of the legend (RP125, S18): the same button the filter menu has ----------
// ---------- RP126 (S19): the three zones fill the height of the window ----------
test('z1: the height of the layout is the window minus what is above it, measured by the page, and not a fixed number', () => {
  assert.match(css, /\.chatlayout\.chat-open\s*\{[^}]*height:\s*calc\(100vh - var\(--sum-top,\s*\d+px\)\)/);
  assert.doesNotMatch(css, /calc\(100vh - 140px\)/, 'the 140 included the bar under the tabs, which Summary no longer shows');
});

test('z2: the page leaves in --sum-top how much sits above the layout, so the zones end at the bottom edge of the window', () => {
  const page = loadPage();
  seed(page);
  const layout = page.get('#sumLayout');
  layout.offsetTop = 98;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '98px');
});

test('z3: it follows the real position (a header that wraps, a window that changes) and a hidden layout keeps the last good value', () => {
  const page = loadPage();
  seed(page);
  const layout = page.get('#sumLayout');
  layout.offsetTop = 98;
  page.run('applyLayout()');
  layout.offsetTop = 131;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '131px');
  layout.offsetTop = 0;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '131px', 'hidden (another tab): the position reads 0 and the value stays');
});

test('z4: it is set with no repo open and with one, and a page without the measure never throws or sets a wrong value', () => {
  const page = loadPage();
  const S = seed(page);
  const layout = page.get('#sumLayout');
  layout.offsetTop = 98;
  page.run('drawChat()');
  assert.equal(layout.style['--sum-top'], '98px', 'no repo open');
  S.chat.id = 'a';
  layout.offsetTop = 120;
  page.run('drawChat()');
  assert.equal(layout.style['--sum-top'], '120px', 'with a repo open');
  const bare = loadPage();
  seed(bare);
  bare.get('#sumLayout').offsetTop = undefined;
  assert.doesNotThrow(() => bare.run('applyLayout()'));
  assert.equal(bare.get('#sumLayout').style['--sum-top'], undefined);
  bare.get('#sumLayout').offsetTop = -5;
  bare.run('applyLayout()');
  assert.equal(bare.get('#sumLayout').style['--sum-top'], undefined, 'a negative or missing measure is ignored');
});

// ---------- the legend of the bars: the info icon of the header (it used to sit under the cards) ----------
// ---------- RP189 (S4): the header keeps Working now and a ⋮ menu; the search icon, the legend, Needs attention and the strip of chips are gone ----------
const lhBar = () => /<div class="lh-bar">[\s\S]*?<div id="lhMenu"/.exec(html)[0];

test('n1: the bar has the title, the + menu, Working now and a ⋮ button, in that order; no search icon, legend, Needs attention or strip of chips', () => {
  const bar = lhBar();
  const order = ['id="lhTitle"', 'id="addMenu"', 'id="lhLive"', 'id="lhFilterBtn"'].map((k) => bar.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every piece is in the bar: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  assert.ok(!bar.includes('lh-search-open'), 'the search is not an icon of the bar');
  for (const gone of ['lhInfoBtn', 'lhLegend', 'lhActive', 'lhAttention', 'lh-legend', 'lh-active']) assert.ok(!html.includes(gone), `${gone} is gone from the page`);
  assert.match(html, /id="lhFilterBtn"[^>]*aria-label="More filters"/);
});

test('n2: the ⋮ menu holds, after its close button, Scope, Group, a Search button and a Clear filters button', () => {
  const m = /<div id="lhMenu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<section id="summary"/.exec(html);
  assert.ok(m, 'the menu block');
  const at = ['lh-menu-close', '<h4>Scope</h4>', '<h4>Group</h4>', 'data-act="lh-search-open"', 'data-act="lh-clear"'].map((k) => m[1].indexOf(k));
  assert.ok(at.every((i) => i >= 0), `every piece is in the menu: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.match(m[1], /<button type="button" class="lh-mi" data-act="lh-search-open">Search…<\/button>/);
  assert.match(m[1], /<button type="button" class="lh-mi" data-act="lh-clear">Clear filters<\/button>/);
});

test('n3: the bar paints only Working now (never Needs attention), with its count, and the pressed state follows the filter', () => {
  const page = loadPage();
  const S = seed(page);
  const h = page.get('#lhLive').html;
  assert.match(h, /data-act="slive" data-live="on"/);
  assert.match(h, /aria-label="Working now · 3"/);
  assert.match(h, /aria-pressed="false"/);
  assert.doesNotMatch(h, /Needs attention|sfilter/);
  S.slive = true;
  page.run('drawSummary()');
  assert.match(page.get('#lhLive').html, /aria-pressed="true"/);
  assert.match(page.get('#lhLive').html, /data-live="off"/);
});

test('n4: the dot of the ⋮ button says a filter of its menu is set (scope, group or text); Working now alone does not light it', () => {
  const page = loadPage();
  const S = seed(page);
  const dot = () => { page.run('drawSummary()'); return page.get('#lhDot').hidden; };
  assert.equal(dot(), true, 'no filter');
  S.slive = true;
  assert.equal(dot(), true, 'Working now has its own pressed button');
  S.slive = false;
  S.scope = { kind: 'room', name: 'R1' };
  assert.equal(dot(), false, 'a room');
  S.scope = { kind: 'all' };
  S.group = 'H';
  assert.equal(dot(), false, 'a group');
  S.group = '';
  S.q = 'alp';
  assert.equal(dot(), false, 'a text');
  S.q = '';
  assert.equal(dot(), true, 'cleared');
});

test('n5: Search in the menu closes the menu and opens the search box, which hides the title, the + and the icons; closing the box gives them back', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-filters']()");
  assert.equal(S.lh.menu, true);
  page.run("ACTIONS['lh-search-open']()");
  page.flush();
  assert.equal(S.lh.menu, false, 'the menu is out of the way');
  assert.equal(S.lh.search, true);
  assert.equal(page.get('#lhMenu').hidden, true);
  assert.equal(page.get('#addMenu').hidden, true, 'the + does not sit next to the search box');
  assert.equal(page.get('#lhTitle').hidden, true);
  page.run("ACTIONS['lh-search-close']()");
  page.flush();
  assert.equal(page.get('#addMenu').hidden, false);
  assert.equal(page.get('#lhTitle').hidden, false);
});

test('n6: the legend is gone from the page state and the actions, and Clear filters in the menu undoes every filter, Working now included', () => {
  const page = loadPage();
  const S = seed(page);
  assert.equal('legend' in S.lh, false);
  assert.equal(page.run("typeof ACTIONS['lh-legend']"), 'undefined');
  assert.equal(page.run("typeof ACTIONS['lh-legend-close']"), 'undefined');
  Object.assign(S, { q: 'alp', group: 'H', scope: { kind: 'room', name: 'R1' }, slive: true });
  page.run("ACTIONS['lh-clear']()");
  assert.equal(S.q, '');
  assert.equal(S.group, '');
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'all' });
  assert.equal(S.slive, false);
});

test('n7: the stylesheet has no rule for the legend or the strip of chips any more, and has one for the menu buttons', () => {
  assert.ok(!/\.lh-legend\b/.test(css), 'no legend rule');
  assert.ok(!/\.lh-active\b/.test(css), 'no strip rule');
  assert.ok(!/\.lh-att\b/.test(css), 'no Needs attention rule');
  assert.match(css, /(?:^|\n)\.lh-mi\s*\{[^}]*text-align:\s*left/, 'the base rule');
  assert.match(css, /\.lh-mi:hover:not\(:disabled\)\s*\{[^}]*background/, 'the hover');
  assert.match(css, /@media \(pointer:\s*coarse\)\s*\{\s*\.lh-mi\s*\{[^}]*min-height:\s*44px/, 'touch size');
});
