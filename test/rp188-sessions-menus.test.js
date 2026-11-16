'use strict';
// RP188 (S1, S2, S3): the tab Summary is called Sessions (the keys stay: S.tab 'summary', #summary, #tab-summary), the header holds ONE tablist (Sessions, Conformity, Settings), Work
// leaves the menu (its panel and key stay, Settings links to it), the Add menu moves into the header of the list column, and the page always opens on Sessions.
// Plain CSS cannot be run here: these tests pin the markup, the rules and the page behaviour; how it LOOKS is for the person to try.
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
const header = /<header>[\s\S]*?<\/header>/.exec(html)[0];
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? true]));
const nav = /<nav[^>]*aria-label="Views"[^>]*>[\s\S]*?<\/nav>/.exec(header)[0];
const tabButtons = [...nav.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ ...attrs(/<button[^>]*>/.exec(m[0])[0]), src: m[0] }));
const mediaBlocks = [...css.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => ({ cond: m[1].trim(), body: m[2] }));
const mobile = mediaBlocks.filter((b) => b.cond === '(max-width: 759.98px)').map((b) => b.body).join('\n');

// ---------- the markup ----------
test('t1: the header has ONE tablist Views with three tabs in order: Sessions, Conformity, Settings, with the old keys and ids', () => {
  assert.match(nav, /role="tablist"/);
  assert.deepEqual(tabButtons.map((t) => t.id), ['tab-summary', 'tab-conformity', 'tab-settings']);
  assert.deepEqual(tabButtons.map((t) => t['data-tab']), ['summary', 'conformity', 'settings']);
  assert.deepEqual(tabButtons.map((t) => t['aria-controls']), ['summary', 'conformityView', 'settingsView']);
  assert.deepEqual(tabButtons.map((t) => t['aria-selected']), ['true', 'false', 'false']);
  for (const t of tabButtons) { assert.equal(t.role, 'tab'); assert.equal(t['data-act'], 'tab'); assert.equal(t.type, 'button'); }
  assert.match(tabButtons[0].src, /<span class="tab-tx">Sessions<\/span><\/button>$/, 'RP193: the word of Sessions is in .tab-tx like the other two');
  assert.ok(!/Summary/.test(tabButtons[0].src));
});

test('t2: Conformity and Settings keep their icon (hidden from assistive tools), a text span, an accessible name, a title and the dual class; the badge is inside Conformity', () => {
  const [, conf, set] = tabButtons;
  for (const [t, name] of [[conf, 'Conformity'], [set, 'Settings']]) {
    assert.equal(t['aria-label'], name);
    assert.equal(t.title, name);
    assert.match(t.class, /\btab-dual\b/);
    assert.match(t.src, /<svg[^>]*class="tab-ic"[^>]*aria-hidden="true"|<svg[^>]*aria-hidden="true"[^>]*class="tab-ic"/);
    assert.match(t.src, new RegExp(`<span class="tab-tx">${name}</span>`));
  }
  assert.match(conf.src, /<span id="confBadge" class="badge" hidden><\/span>/);
});

test('t3: no Work tab in the header, no .hd-end group, no Add menu in the header; the Work panel is still in the page', () => {
  assert.ok(!header.includes('tab-work') && !header.includes('data-tab="work"'));
  assert.ok(!html.includes('hd-end') && !css.includes('.hd-end') && !css.includes('.hd-icon'));
  assert.ok(!header.includes('addMenu'));
  assert.match(html, /<div id="work"[^>]*role="tabpanel"/);
});

test('t4: the Add menu is in the header of the list column, after the title, with the same two actions and a compact + summary', () => {
  const head = /<div id="listHead"[\s\S]*?<section id="summary"/.exec(html)[0];
  const bar = /<div class="lh-bar">[\s\S]*?<div id="lhMenu"/.exec(head)[0];
  const menu = /<details[^>]*id="addMenu"[^>]*>[\s\S]*?<\/details>/.exec(bar)[0];
  assert.ok(bar.indexOf('id="lhTitle"') < bar.indexOf('id="addMenu"'));
  assert.match(menu, /class="pop/);
  const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(menu);
  assert.equal(attrs(/<summary[^>]*>/.exec(menu)[0])['aria-label'], 'Add a repo or a room');
  assert.equal(attrs(/<summary[^>]*>/.exec(menu)[0]).title, 'Add a repo or a room');
  assert.match(summary[1], /^\s*<svg[^>]*aria-hidden="true"[\s\S]*<\/svg>\s*$/, 'the plus is a drawing (centered by the box), not a text glyph');
  assert.doesNotMatch(summary[1].replace(/<[^>]*>/g, ''), /\S/, 'no text inside: the name is the aria-label');
  const items = [...menu.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ ...attrs(/<button[^>]*>/.exec(m[0])[0]), text: m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(items.map((i) => i['data-act']), ['add-dialog', 'room-dialog']);
  assert.match(items[0].text, /^Repo…/);
  assert.match(items[1].text, /^Room…/);
});

// ---------- the stylesheet ----------
const ruleBody = (src, sel) => [...src.matchAll(/(?:^|\n|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]).join(';');

test('c1: on desktop the tabs show text only (the icon is hidden); under 760 px (RP193) they show the icon AND the word, touch sized, the badge on the icon', () => {
  assert.match(ruleBody(css, 'header .rs-tabs .tab-ic'), /display:\s*none/);
  assert.doesNotMatch(ruleBody(mobile, 'header .rs-tabs .tab-tx'), /display:\s*none/, 'RP193: the word stays under the icon');
  assert.match(ruleBody(mobile, 'header .rs-tabs .tab-ic'), /display:\s*(inline-)?block|display:\s*inline-flex|display:\s*block/);
  assert.match(ruleBody(mobile, 'header .rs-tabs .tab-dual'), /min-width:\s*44px/);
  assert.match(ruleBody(mobile, 'header .rs-tabs .tab-dual .badge'), /position:\s*absolute/);
});

test('c2: the dual tabs reuse the old icon look (muted, hover, selected, focus ring); the badge is the inline yellow pill on desktop', () => {
  assert.match(ruleBody(css, 'header .rs-tabs .tab-dual'), /color:\s*var\(--muted\)/);
  assert.match(ruleBody(css, 'header .rs-tabs .tab-dual:hover:not(:disabled)'), /background:\s*var\(--panel2\)/);
  assert.match(ruleBody(css, 'header .rs-tabs .tab-dual:focus-visible'), /outline:\s*2px solid var\(--blue\)/);
  assert.match(ruleBody(css, '.rs-tabs .badge'), /background:\s*var\(--yellow\)/);
  assert.ok(!/header \.rs-tabs \.tab-dual \.badge/.test(mediaBlocks.filter((b) => b.cond === '(max-width: 759.98px)').reduce((acc, b) => acc.replace(b.body, ''), css)), 'the absolute badge is only in the phone rules');
});

test('c3: the Add menu popover hangs from the list header, not from its small + button (a phone is 390 px wide and the + sits to the right); the summary stays blue', () => {
  assert.match(ruleBody(css, '#addMenu'), /position:\s*static/, 'the details is not the anchor');
  assert.match(css, /(?:^|\n)#listHead\s*\{[^}]*position:\s*relative/, 'the list header is');
  const body = ruleBody(css, '#addMenu .pop-body');
  assert.match(body, /left:\s*12px/);
  assert.match(body, /right:\s*auto/);
  assert.match(body, /width:\s*min\(270px,\s*calc\(100% - 24px\)\)/, 'never wider than the header');
  assert.match(ruleBody(css, '#addMenu > summary'), /color:\s*var\(--blue\)/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, open: false, value: '', checked: false, style: {}, attrs: {}, focused: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false,
    showModal() {}, close() {}, reset() {}, focus() { el.focused++; }, append() {}, contains: () => false,
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, get textContent() { return el.html; }, set textContent(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}
function loadPage({ tabs = [], prefs = null } = {}) {
  const els = {};
  const docL = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, activeElement: null, querySelector: get, querySelectorAll: (s) => (s === 'header [role=tab][data-tab]' ? tabs : []), createElement: () => element(), body: element(), addEventListener(t, fn) { (docL[t] ||= []).push(fn); } };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: (k) => (k === 'prefs' && prefs ? JSON.stringify(prefs) : null), setItem() {} },
    requestAnimationFrame: () => 1, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const fire = (type, e) => { const ev = { type, preventDefault() {}, stopPropagation() {}, ...e }; for (const fn of docL[type] || []) fn(ev); return ev; };
  return { get, run: (code) => vm.runInContext(code, ctx), fire };
}

test('b1: the page opens on Sessions even when the saved preference is Work', () => {
  assert.equal(loadPage({ prefs: { tab: 'work' } }).run('S.tab'), 'summary');
  assert.equal(loadPage().run('S.tab'), 'summary');
});

test('b2: ACTIONS.tab still shows the Work panel, and the Settings view ends with a "Work view" row that opens it through that action', () => {
  const page = loadPage();
  page.run("ACTIONS.tab({ dataset: { tab: 'work' } })");
  assert.equal(page.get('#work').hidden, false);
  assert.equal(page.get('#sumLayout').hidden, true);
  const h = R.settingsView({ state: 'ready', options: {}, prefs: {} });
  const i = h.indexOf('Work view');
  assert.ok(i > h.indexOf('Director'), 'at the end of the view');
  const tail = h.slice(i);
  assert.match(tail, /An older view of the repos as a board\. It is not in the menu any more\./);
  assert.match(tail, /<button type="button"[^>]*data-act="tab"[^>]*data-tab="work"[^>]*>Open Work<\/button>/);
});

test('b3 (kept): Escape closes the open Add menu and the focus goes back to its summary; a click outside closes it', () => {
  const page = loadPage();
  const summary = element();
  const menu = page.get('#addMenu');
  menu.open = true;
  menu.querySelector = () => summary;
  page.fire('keydown', { key: 'Escape', target: element() });
  assert.equal(menu.open, false);
  assert.equal(summary.focused, 1);
  menu.open = true;
  page.fire('click', { target: element() });
  assert.equal(menu.open, false);
});

test('b4 (kept): the selected mark follows S.tab in the single header tablist, and the Conformity tab label carries the count', () => {
  const tabs = ['summary', 'conformity', 'settings'].map((tab) => element({ dataset: { tab } }));
  const page = loadPage({ tabs });
  page.run("S.tab = 'conformity'; applyTab()");
  assert.deepEqual(tabs.map((t) => t.attrs['aria-selected']), ['false', 'true', 'false']);
  assert.equal(V.conformityTabLabel(3), 'Conformity: 3 to review');
  assert.match(read('tabs.js'), /\$\('#tab-conformity'\)\.setAttribute\('aria-label', V \? V\.conformityTabLabel\(n\)/);
});

test('c6: the + button is as tall and as wide as the other buttons of the bar and its plus is centered by a flex box', () => {
  const sum = ruleBody(css, '#addMenu > summary');
  const ic = ruleBody(css, '.lh-ic');
  const px = (b, k) => new RegExp(`(?:^|[;\\s])${k}:\\s*(\\d+)px`).exec(b)[1];
  assert.equal(px(sum, 'height'), px(ic, 'height'), 'same height as .lh-ic');
  assert.equal(px(sum, 'min-width'), px(ic, 'min-width'), 'same width as .lh-ic');
  for (const p of [/display:\s*inline-flex/, /align-items:\s*center/, /justify-content:\s*center/]) assert.match(sum, p);
});

test('p6: the Work panel has no tab any more, so it is named by itself and nothing points at the removed tab-work', () => {
  assert.doesNotMatch(html, /id="tab-work"/);
  assert.doesNotMatch(html, /aria-labelledby="tab-work"/, 'a label that points at nothing names nothing');
  assert.match(html, /<div id="work" role="tabpanel" aria-label="Work" hidden>/);
});
