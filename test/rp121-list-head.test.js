'use strict';
// RP121 (S16): the filters of the Summary (search, group, scope and Needs attention) leave the bar under the tabs and live in the header of the repos column, as a thin bar of
// icons (artboards D and E of design/panel-filtros). In reposo: the title with the count and three icons (search, funnel, attention). The search turns the bar into the search box
// (button or key `/`; Escape closes it), the funnel opens a menu with the scope and the group, and while a filter is set the funnel has a dot and a strip of removable chips shows.
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
  for (const id of ['lhTitle', 'lhCount', 'lhSearchBox', 'lhSearch', 'lhIcons', 'lhFilterBtn', 'lhDot', 'lhAttention', 'lhActive', 'lhMenu', 'lhScope', 'lhGroup']) assert.ok(m[1].includes(`id="${id}"`), id);
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
test('s1: summaryTools keeps its button for the bar and has a compact form: an icon button that says the count and Needs attention in its label', () => {
  const ctx = { rooms: ROOMS, scope: { kind: 'all' }, q: '', group: '', filter: 'all' };
  assert.equal(R.summaryTools(payload, ctx), '<button type="button" data-act="sfilter" data-filter="attention" aria-pressed="false">Needs attention · 2</button>');
  const c = R.summaryTools(payload, { ...ctx, compact: true });
  assert.match(c, /data-act="sfilter" data-filter="attention"/);
  assert.match(c, /aria-pressed="false"/);
  assert.match(c, /aria-label="Needs attention · 2"/);
  assert.match(c, /<small>2<\/small>/);
  assert.doesNotMatch(c, />Needs attention/, 'the words are not on screen, only in the label and the tooltip');
  const on = R.summaryTools(payload, { ...ctx, filter: 'attention', compact: true });
  assert.match(on, /data-filter="all"/);
  assert.match(on, /aria-pressed="true"/);
  assert.equal(R.summaryTools(null, { compact: true }), '');
});

test('s2: listHeadChips draws one removable chip per filter that is set, in order, and Clear; nothing when no filter is set', () => {
  assert.equal(R.listHeadChips({ rooms: ROOMS, scope: { kind: 'all' }, q: '', group: '', filter: 'all' }), '');
  assert.equal(R.listHeadChips({ rooms: ROOMS, scope: { kind: 'room', name: 'NOPE' }, q: '  ', group: 'all', filter: 'all' }), '', 'an unknown room, blank text and the group all are no filter');
  const h = R.listHeadChips({ rooms: ROOMS, scope: { kind: 'room', name: 'R1' }, q: 'alp', group: 'G', filter: 'attention' });
  const at = (s) => h.indexOf(s);
  const order = ['data-act="scope" data-kind="all"', 'data-act="lh-clear-group"', 'data-act="lh-clear-q"', 'data-act="sfilter" data-filter="all"', 'data-act="lh-clear"'].map(at);
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'scope, group, text, attention, Clear');
  assert.match(h, />R1 ✕</);
  assert.match(h, />alp ✕</);
  assert.match(h, />Needs attention ✕</);
  const none = R.listHeadChips({ rooms: ROOMS, scope: { kind: 'none' }, q: '', group: '', filter: 'all' });
  assert.match(none, />No room ✕</);
});

test('s3: listHeadChips escapes everything it prints (a room, a group or a text with markup is text)', () => {
  const bad = '<img src=x onerror=alert(1)>"\'';
  const h = R.listHeadChips({ rooms: [{ name: bad, repos: [] }], scope: { kind: 'room', name: bad }, q: bad, group: bad, filter: 'all' });
  assert.ok(!h.includes('<img'), h);
  assert.ok(!h.includes('onerror=alert(1)>'), h);
  assert.match(h, /&lt;img/);
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

test('g1: with no filter the bar shows the count and the attention icon, no dot and no chips', () => {
  const page = loadPage();
  seed(page);
  assert.equal(page.get('#lhCount').textContent, '3');
  assert.match(page.get('#lhAttention').html, /aria-label="Needs attention · 2"/);
  assert.equal(page.get('#lhDot').hidden, true);
  assert.equal(page.get('#lhActive').hidden, true);
  assert.equal(page.get('#lhActive').html, '');
});

test('g2: with a filter set the funnel has the dot and the strip shows the chips; the count follows the filter', () => {
  const page = loadPage();
  const S = seed(page);
  S.scope = { kind: 'room', name: 'R1' };
  S.sfilter = 'attention';
  page.run('drawSummary()');
  assert.equal(page.get('#lhDot').hidden, false);
  assert.equal(page.get('#lhActive').hidden, false);
  assert.match(page.get('#lhActive').html, /R1 ✕/);
  assert.match(page.get('#lhActive').html, /Needs attention ✕/);
  assert.equal(page.get('#lhCount').textContent, '2');
  assert.match(page.get('#lhAttention').html, /aria-pressed="true"/);
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
  page.run("ACTIONS['lh-search-open']()");
  page.key('Escape');
  page.flush();
  assert.equal(S.lh.menu, false);
  assert.equal(S.lh.search, false);
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

test('g11: the chips and Clear undo their filter: text, group, or everything', () => {
  const page = loadPage();
  const S = seed(page);
  Object.assign(S, { q: 'alp', group: 'G', scope: { kind: 'room', name: 'R1' }, sfilter: 'attention' });
  page.run("ACTIONS['lh-clear-q']()");
  assert.equal(S.q, '');
  page.run("ACTIONS['lh-clear-group']()");
  assert.equal(S.group, '');
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'room', name: 'R1' });
  Object.assign(S, { q: 'x', group: 'H' });
  page.run("ACTIONS['lh-clear']()");
  assert.equal(S.q, '');
  assert.equal(S.group, '');
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'all' });
  assert.equal(S.sfilter, 'all');
});

test('g12: the existing actions still work from the header: a scope button and the attention button', () => {
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
test('y1: the legend panel has a close button in its top right corner, first in the block, with a name for assistive tools; the text lives in its own body', () => {
  const m = /<div id="lhLegend"[^>]*>([\s\S]*?)<div id="lhMenu"/.exec(html);
  assert.ok(m, 'the legend block');
  const body = m[1];
  assert.match(body, /<button type="button" class="lh-x lh-menu-x" data-act="lh-legend-close" aria-label="Close legend" title="Close">/);
  assert.ok(body.indexOf('lh-menu-x') < body.indexOf('id="lhLegendBody"'), 'the button comes first, so the keyboard reaches it first');
  assert.match(body, /<div id="lhLegendBody"><\/div>/);
});

test('y2: the close button closes the legend, says so to assistive tools and gives the focus back to the info icon', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-legend']()");
  page.flush();
  assert.equal(S.lh.legend, true);
  const before = page.get('#lhInfoBtn').focused || 0;
  page.run("ACTIONS['lh-legend-close']()");
  page.flush();
  assert.equal(S.lh.legend, false);
  assert.equal(page.get('#lhLegend').hidden, true);
  assert.equal(page.get('#lhInfoBtn').attrs['aria-expanded'], 'false');
  assert.equal(page.get('#lhInfoBtn').focused, before + 1, 'the focus goes back to the icon that opened the legend');
});

test('y3: the close button only closes the legend: the filters stay, the filter menu does not open, and a closed legend stays closed', () => {
  const page = loadPage();
  const S = seed(page);
  Object.assign(S, { q: 'alp', group: 'G', scope: { kind: 'room', name: 'R1' }, sfilter: 'attention' });
  page.run("ACTIONS['lh-legend']()");
  page.run("ACTIONS['lh-legend-close']()");
  page.run("ACTIONS['lh-legend-close']()");
  assert.equal(S.lh.legend, false);
  assert.equal(S.lh.menu, false);
  assert.equal(S.q, 'alp');
  assert.equal(S.group, 'G');
  assert.deepEqual(JSON.parse(JSON.stringify(S.scope)), { kind: 'room', name: 'R1' });
  assert.equal(S.sfilter, 'attention');
});

test('y4: the legend text is painted only in its body, so a redraw never erases the close button', () => {
  const page = loadPage();
  const S = seed(page);
  assert.equal(page.get('#lhLegend').writes, 0, 'the block itself is never repainted');
  S.q = 'x';
  page.run('drawSummary()');
  page.run("ACTIONS['lh-legend']()");
  page.flush();
  assert.equal(page.get('#lhLegend').writes, 0);
  assert.equal(page.get('#lhLegendBody').html, R.legendHtml());
});

// ---------- the legend of the bars: the info icon of the header (it used to sit under the cards) ----------
test('i1: the header has an info icon that opens the legend panel, closed by default and wired for assistive tools', () => {
  const m = /<div id="listHead"[\s\S]*?<section id="summary"/.exec(html);
  assert.ok(m, 'the header');
  assert.match(m[0], /<button[^>]*id="lhInfoBtn"[^>]*data-act="lh-legend"[^>]*aria-expanded="false"[^>]*aria-controls="lhLegend"|<button[^>]*id="lhInfoBtn"[^>]*aria-controls="lhLegend"[^>]*aria-expanded="false"[^>]*data-act="lh-legend"|<button[^>]*data-act="lh-legend"[^>]*id="lhInfoBtn"/);
  assert.match(m[0], /id="lhInfoBtn"[^>]*aria-label="Bar legend"|aria-label="Bar legend"[^>]*id="lhInfoBtn"/);
  assert.match(m[0], /<div id="lhLegend"[^>]*hidden/);
  assert.ok(m[0].indexOf('id="lhInfoBtn"') > m[0].indexOf('data-act="lh-filters"') && m[0].indexOf('id="lhInfoBtn"') < m[0].indexOf('id="lhAttention"'), 'after the funnel, before the attention flag');
  assert.match(css, /\.lh-legend\[hidden\]/, 'a [hidden] rule: the menu starts hidden');
});

test('i2: the panel is painted once with the legend text and the info button opens and closes it', () => {
  const page = loadPage();
  const S = seed(page);
  assert.equal(page.get('#lhLegendBody').html, R.legendHtml());
  assert.equal(page.get('#lhLegend').hidden, true);
  page.run("ACTIONS['lh-legend']()");
  page.flush();
  assert.equal(S.lh.legend, true);
  assert.equal(page.get('#lhLegend').hidden, false);
  assert.equal(page.get('#lhInfoBtn').attrs['aria-expanded'], 'true');
  page.run("ACTIONS['lh-legend']()");
  page.flush();
  assert.equal(page.get('#lhLegend').hidden, true);
  assert.equal(page.get('#lhInfoBtn').attrs['aria-expanded'], 'false');
});

test('i3: the filter menu and the legend never show together: opening one closes the other', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-filters']()");
  page.run("ACTIONS['lh-legend']()");
  assert.deepEqual([S.lh.menu, S.lh.legend], [false, true]);
  page.run("ACTIONS['lh-filters']()");
  assert.deepEqual([S.lh.menu, S.lh.legend], [true, false]);
});

test('i4: Escape and a click outside close the legend like the filter menu, and a click inside the header leaves it', () => {
  const page = loadPage();
  const S = seed(page);
  S.chat.id = 'a';
  page.run("ACTIONS['lh-legend']()");
  page.click({ closest: (sel) => (sel === '#listHead' ? {} : null), dataset: {} });
  assert.equal(S.lh.legend, true);
  page.click(element());
  assert.equal(S.lh.legend, false);
  page.run("ACTIONS['lh-legend']()");
  page.key('Escape');
  assert.equal(S.lh.legend, false);
  assert.equal(S.chat.id, 'a', 'the Escape was for the legend, the chat stays');
});

test('i5: opening the search box closes the legend, so the icons that hide cannot leave it open', () => {
  const page = loadPage();
  const S = seed(page);
  page.run("ACTIONS['lh-legend']()");
  page.run("ACTIONS['lh-search-open']()");
  assert.equal(S.lh.legend, false);
});
