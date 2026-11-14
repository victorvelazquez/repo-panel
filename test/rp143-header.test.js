'use strict';
// RP143 (S30, S31, S37): the global header of the page is ONE row (about 48 px, it was two rows of 95 px): the logo and the tabs Summary and Work on the left; on the right the usage meters, the Add menu (Repo and Room), and Conformity (an icon with its count) and Settings (a gear). The buttons Refresh and Fetch all and the Merge
// menu are gone from the page (the person hardly uses them; the merge method lives in Settings, Delivery). The actions are the same: Conformity and Settings are still tabs (data-act="tab") and Repo and Room
// still open their dialogs. The functions that were behind the removed buttons stay (refreshAll runs by itself, fetchRepo and its route are kept on purpose). Plain CSS cannot be run here: how it LOOKS was
// measured in the real panel and is for the person to try; these tests pin the markup, the rules, the page code and the behaviour that does not depend on the eye.
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
const tagOf = (src, re) => { const m = re.exec(src); assert.ok(m, `not found: ${re}`); return m[0]; };
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

// ---------- the markup ----------
test('m1: the header holds, in this order, the logo, the tablist of Summary and Work, the usage, the Add menu and the tablist of Conformity and Settings; one row, no second nav', () => {
  const order = ['<h1>', 'aria-label="Views"', 'id="usage"', 'id="addMenu"', 'aria-label="More views"'].map((k) => header.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every piece is in the header: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the order of the design');
  assert.equal((html.match(/<nav\b/g) || []).length, 1, 'one nav inside the header (the second group of tabs is a tablist div)');
  assert.equal((html.slice(html.indexOf('</header>')).match(/class="rs-tabs"/g) || []).length, 0, 'no row of tabs after the header');
  assert.ok(html.indexOf('</header>') < html.indexOf('id="viewbar"'), 'the view bar follows the header');
});

test('m2: Summary and Work are the tabs of the first tablist, Summary selected, wired to their panels', () => {
  const nav = tagOf(header, /<nav[^>]*aria-label="Views"[^>]*>[\s\S]*?<\/nav>/);
  assert.match(nav, /role="tablist"/);
  const tabs = [...nav.matchAll(/<button[^>]*>/g)].map((m) => attrs(m[0]));
  assert.deepEqual(tabs.map((t) => t['data-tab']), ['summary', 'work']);
  assert.deepEqual(tabs.map((t) => t.id), ['tab-summary', 'tab-work']);
  assert.deepEqual(tabs.map((t) => t['aria-selected']), ['true', 'false']);
  assert.deepEqual(tabs.map((t) => t['aria-controls']), ['summary', 'work']);
  for (const t of tabs) assert.equal(t.role, 'tab'), assert.equal(t['data-act'], 'tab');
});

test('m3: Conformity and Settings are still tabs (same ids, same action, same panels), but icons with an accessible name; the count sits on Conformity and starts hidden', () => {
  const group = tagOf(header, /<div[^>]*aria-label="More views"[^>]*>[\s\S]*?<\/div>/);
  assert.match(group, /role="tablist"/);
  const tabs = [...group.matchAll(/<button[^>]*>/g)].map((m) => attrs(m[0]));
  assert.deepEqual(tabs.map((t) => t.id), ['tab-conformity', 'tab-settings'], 'document order is kept: Conformity before Settings');
  assert.deepEqual(tabs.map((t) => t['data-tab']), ['conformity', 'settings']);
  assert.deepEqual(tabs.map((t) => t['aria-controls']), ['conformityView', 'settingsView']);
  assert.deepEqual(tabs.map((t) => t['aria-label']), ['Conformity', 'Settings']);
  for (const t of tabs) { assert.equal(t.role, 'tab'); assert.equal(t['data-act'], 'tab'); assert.equal(t['aria-selected'], 'false'); assert.equal(t.type, 'button'); assert.ok(t.title); }
  assert.equal((group.match(/<svg\b[^>]*aria-hidden="true"/g) || []).length, 2, 'both icons are hidden from assistive tools: the label carries the name');
  assert.match(group, /<span id="confBadge" class="badge" hidden><\/span>/);
  assert.ok(group.indexOf('confBadge') < group.indexOf('tab-settings'), 'the badge is inside the Conformity tab');
});

test('m4: nothing of the removed controls is left in the header: no Refresh, no Fetch all, no Merge menu, no method select, no delete-branch box', () => {
  for (const gone of ['refresh-all', 'fetch-all', 'mergeMenu', 'id="method"', 'id="delBranch"', 'Merge settings', '↻ Refresh', 'Fetch all']) assert.ok(!header.includes(gone), `the header does not have ${gone}`);
  assert.ok(!html.includes('id="method"') && !html.includes('id="delBranch"'), 'the controls are not elsewhere in the page either');
});

test('m5: the Add menu is a details with a named summary and two buttons that are the SAME actions as before: add-dialog and room-dialog', () => {
  const menu = tagOf(header, /<details[^>]*id="addMenu"[^>]*>[\s\S]*?<\/details>/);
  assert.match(menu, /class="pop/);
  const summary = attrs(tagOf(menu, /<summary[^>]*>/));
  assert.ok(summary['aria-label'] && /add/i.test(summary['aria-label']));
  const items = [...menu.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ ...attrs(/<button[^>]*>/.exec(m[0])[0]), text: m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(items.map((i) => i['data-act']), ['add-dialog', 'room-dialog']);
  for (const i of items) assert.equal(i.type, 'button');
  assert.match(items[0].text, /^Repo…/);
  assert.match(items[1].text, /^Room…/);
});

test('m7: every button of the header says type="button" and the usage element is unchanged', () => {
  for (const m of header.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /type="button"/, m[0]);
  assert.match(header, /<span id="usage" class="usage" role="status" tabindex="0" hidden><\/span>/);
});

// ---------- the page code ----------
test('p1: the page code no longer reaches for what was removed, and reaches for what replaces it', () => {
  const src = appSource();
  for (const gone of ['#mergeMenu', '#method', '#delBranch', '[data-act="refresh-all"]']) assert.ok(!src.includes(gone), `the page code does not use ${gone}`);
  for (const here of ['#addMenu']) assert.ok(src.includes(here), `the page code uses ${here}`);
  assert.match(src, /querySelectorAll\('header \[role=tab\]\[data-tab\]'\)/, 'the selected tab is kept in step in BOTH tablists of the header');
});

test('p2: what stays behind the removed buttons stays: the actions refresh-all and fetch-all, fetchRepo and its route', () => {
  const actions = read('actions.js');
  assert.match(actions, /'refresh-all':\s*\(\)\s*=>\s*refreshAll\(\{ force: true \}\)/);
  assert.match(actions, /'fetch-all':/);
  assert.match(read('feed.js'), /async function fetchRepo\b/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'http.js'), 'utf8'), /'POST \/api\/fetch'/);
});

test('p3: the merge method and the delete-branch switch are still in Settings, Delivery, where they now live alone', () => {
  const src = read('resumen.js');
  assert.match(src, /<label id="st-l-method">Merge method<\/label>/);
  assert.match(src, /stSeg\('st-l-method', 'method', p\.method, \[\['squash', 'squash'\], \['merge', 'merge'\], \['rebase', 'rebase'\]\]\)/, 'the three methods');
  assert.match(src, /Delete the branch after merging/);
  assert.match(src, /data-act="pref-set" data-pref="del"/);
});

test('p4: the label of the Conformity tab carries the count (the badge text is not read when the tab has an aria-label)', () => {
  assert.equal(typeof V.conformityTabLabel, 'function');
  assert.equal(V.conformityTabLabel(0), 'Conformity');
  assert.equal(V.conformityTabLabel(1), 'Conformity: 1 to review');
  assert.equal(V.conformityTabLabel(7), 'Conformity: 7 to review');
  for (const bad of [-1, NaN, undefined, null, 'x', {}, Infinity]) assert.equal(V.conformityTabLabel(bad), 'Conformity', String(bad));
  assert.match(read('tabs.js'), /conformityTabLabel/, 'drawConformity uses it');
});

// ---------- the stylesheet ----------
test('c1: the header is one row of 48 px and still wraps on a narrow screen instead of breaking; the tabs inside it have no row of their own', () => {
  const h = rule('header');
  assert.match(h, /min-height:\s*48px/);
  assert.match(h, /padding:\s*0 16px/);
  assert.match(h, /flex-wrap:\s*wrap/);
  assert.match(h, /position:\s*sticky/);
  const tabs = rule('header .rs-tabs');
  assert.match(tabs, /border-bottom:\s*0|border-bottom:\s*none/);
  assert.match(tabs, /background:\s*transparent/);
  assert.match(rule('header .rs-tabs button'), /min-height:\s*48px|height:\s*48px/);
});

test('c3: the Add menu summary is the blue primary action of the header, and its items are real, readable rows', () => {
  assert.match(rule('#addMenu > summary'), /color:\s*var\(--blue\)/);
  assert.match(rule('.pop-item'), /display:\s*grid|display:\s*flex/);
  assert.match(rule('.pop-item'), /min-height:\s*44px|padding:/);
  assert.match(rule('.pop-item:hover'), /background:\s*var\(--panel2\)/);
});

test('c4: the icon tabs are touch sized (44 px with a coarse pointer), keep the visible focus ring and the selected mark, and the badge sits on the icon', () => {
  assert.match(rule('.hd-icon'), /min-width:\s*36px/);
  assert.match(css, /@media \(pointer:\s*coarse\)\s*\{[^@]*\.hd-icon[^}]*(?:min-width|min-height):\s*44px/);
  assert.match(rule('.hd-icon[aria-selected="true"]'), /color:\s*var\(--text\)/);
  assert.match(css, /\.hd-end button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)|\.hd-icon:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(rule('.hd-icon .badge'), /position:\s*absolute/);
});

test('c5: the old rules of the removed controls are gone (no dead CSS for the Merge menu popover of the header)', () => {
  assert.ok(!/#mergeMenu/.test(css));
  assert.ok(!/\[data-act="refresh-all"\]/.test(css));
});

// ---------- the behaviour ----------
function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, open: false, value: '', checked: false, style: {}, attrs: {}, focused: 0, toggles: [],
    classList: { add() {}, remove() {}, toggle(...a) { el.toggles.push(a); }, contains: () => false },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, matches: () => false,
    showModal() {}, close() {}, reset() {}, focus() { el.focused++; }, append() {}, contains: () => false,
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, get textContent() { return el.html; }, set textContent(v) { el.html = String(v); },
    ...extra,
  };
  return el;
}
function loadPage(tabs = []) {
  const els = {};
  const frames = [];
  const docL = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, activeElement: null, querySelector: get, querySelectorAll: (s) => (s === 'header [role=tab][data-tab]' ? tabs : []), createElement: () => element(), body: element(), addEventListener(t, fn) { (docL[t] ||= []).push(fn); } };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const fire = (type, e) => { const ev = { type, preventDefault() {}, stopPropagation() {}, ...e }; for (const fn of docL[type] || []) fn(ev); return ev; };
  return { get, doc, run: (code) => vm.runInContext(code, ctx), fire };
}

test('b2: Escape closes the open Add menu, puts the focus back on its summary, and does not close the open chat with the same key', () => {
  const page = loadPage();
  const summary = element();
  const menu = page.get('#addMenu');
  menu.open = true;
  menu.querySelector = () => summary;
  page.run("S.chat.id = 'abc'");
  page.fire('keydown', { key: 'Escape', target: element() });
  assert.equal(menu.open, false, 'the menu closed');
  assert.equal(summary.focused, 1, 'the focus went back to the summary');
  assert.equal(page.run('S.chat.id'), 'abc', 'the chat is still open: the first Escape is for the menu');
});

test('b3: a click outside closes the Add menu, a click on one of its items closes it too (the dialog opens), a click on its summary leaves it to the browser', () => {
  const page = loadPage();
  const menu = page.get('#addMenu');
  const inside = element({ dataset: { act: 'room-dialog' }, closest() { return this; } });
  const summary = element();
  menu.contains = (t) => t === inside || t === summary || t === menu;
  menu.open = true;
  page.fire('click', { target: element() });
  assert.equal(menu.open, false, 'outside');
  menu.open = true;
  page.fire('click', { target: summary });
  assert.equal(menu.open, true, 'the summary toggles by itself, the page does not interfere');
  page.fire('click', { target: inside });
  assert.equal(menu.open, false, 'an item closes the menu');
});

test('b4: the selected tab is marked in BOTH tablists of the header, and only one is selected', () => {
  const mk = (tab) => element({ dataset: { tab } });
  const tabs = ['summary', 'work', 'conformity', 'settings'].map(mk);
  const page = loadPage(tabs);
  page.run("S.tab = 'settings'");
  page.run('applyTab()');
  assert.deepEqual(tabs.map((t) => t.attrs['aria-selected']), ['false', 'false', 'false', 'true']);
  page.run("S.tab = 'summary'");
  page.run('applyTab()');
  assert.deepEqual(tabs.map((t) => t.attrs['aria-selected']), ['true', 'false', 'false', 'false']);
});
