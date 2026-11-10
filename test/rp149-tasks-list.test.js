'use strict';
// RP149 (S38, S39): the compact Tasks list of the right column, design A2 of design/panel-tareas (approved by the person). Flat rows (no border, no fill, nothing that looks like a button), ONE icon per
// GROUP in its header, the id and the title on the row, the extra data (PR, branch, what it waits for, the reason of a block) at the right of the SAME line and below only when it does not fit; a summary on top; the
// groups In review, Ready, In progress, Next, Pending, Blocked and Completed, each only when it has tasks; Pending shows 10 and «+N more» expands in place; the ones that wait for another task go last, dimmed;
// Completed is folded and shows NOTHING until it is opened; the freshness text («Read N min ago») and the refresh button sit in the summary row, which stays under the tabs when the list scrolls. The list is read again when the Tasks tab is entered and by the button (fetch, then read).
// What does NOT change: the full list of the chat tab (under 1100 px), the roadmap endpoint, and that a read for a repo the person left never paints another.
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
const css = read('style.css');

const row = (id, entrega, estado, extra = {}) => ({ id, entrega, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...extra });
const LONG = `${'The person decided to stop this one. '.repeat(6)}END`;
const ROWS = [
  ...[1, 2, 3, 4, 5].map((n) => row(`D${n}`, `Done thing ${n}`, 'Completada')),
  row('R1', 'Header polish', 'Pendiente'), row('Y1', 'Example task ready', 'Pendiente'), row('P0', 'Phone layout check', 'En curso'), row('N1', 'Mobile addresses', 'Pendiente'),
  row('T1', 'One zone', 'Pendiente'), row('W1', 'Merge confirmation', 'Pendiente', { dependsOn: ['T1'] }), row('T2', 'Chat header', 'Pendiente'), row('T3', 'Two zones', 'Pendiente'),
  row('T4', 'Column tab', 'Pendiente'), row('T5', 'Fifth pending', 'Pendiente'), row('T6', 'Sixth pending', 'Pendiente'),
  row('T7', 'Seventh pending', 'Pendiente'), row('T8', 'Eighth pending', 'Pendiente'), row('T9', 'Ninth pending', 'Pendiente'), row('T10', 'Tenth pending', 'Pendiente'), row('T11', 'Eleventh pending', 'Pendiente'),
  row('B1', 'Discarded idea', 'Bloqueada', { notas: 'Decided by the person' }), row('B2', 'Long block', 'Bloqueada', { notas: LONG }),
];
const RP = { available: true, rows: ROWS, derived: { R1: { state: 'En revisión', pr: 199 }, Y1: { state: 'Lista', branch: 'feat/rp151-example' } }, next: { id: 'N1' } };
const view = (ctx = {}, rp = RP) => R.tasksView(rp, { compact: true, now: 1000000000000, ...ctx });
const heads = (h) => [...h.matchAll(/<(?:h3|button)[^>]*class="tk-gh tk-g-(\w+)[^"]*"/g)].map((m) => m[1]);
const rows = (h) => [...h.matchAll(/<div class="tk-row([^"]*)"([^>]*)>([\s\S]*?)<\/div>/g)].map((m) => ({ cls: m[1].trim(), attrs: m[2], html: m[3], id: (/class="tk-id mono">([^<]*)</.exec(m[3]) || [])[1], extra: (/class="tk-x">([^<]*)</.exec(m[3]) || [])[1] }));
const section = (h, key) => { const i = h.search(new RegExp(`<(?:h3|button)[^>]*class="tk-gh tk-g-${key}`)); const rest = h.slice(i + 1); const j = rest.search(/<(?:h3|button)[^>]*class="tk-gh tk-g-/); return j < 0 ? h.slice(i) : h.slice(i, i + 1 + j); };

// ---------- summary ----------
test('s1: the summary says how many are done and how many are in progress, with a thin bar that keeps its counts for assistive tools; no legend any more', () => {
  const h = view();
  assert.match(h, /<div class="tk-sum"><div class="tk-top"><span class="tk-sl"><b>5 of 23 done<\/b> · 1 in progress<\/span>/);
  assert.match(h, /<div class="tk-bar" role="img" aria-label="5 completed, 1 in review, 1 ready, 1 in progress, 13 pending, 2 blocked">/);
  assert.ok(!h.includes('tk-leg') && !h.includes('tk-k '), 'the legend is gone: the headers carry the counts');
});

test('s2: with nothing in progress the summary does not say «0 in progress»; with everything done it says so', () => {
  const some = { ...RP, rows: ROWS.filter((r) => r.id !== 'P0') };
  assert.match(view({}, some), /<b>5 of 22 done<\/b><\/span>/);
  const all = { available: true, rows: [row('A', 'a', 'Completada'), row('B', 'b', 'Completada')], derived: {}, next: null };
  assert.match(view({}, all), /<b>2 of 2 done<\/b><\/span>/);
});

// ---------- groups and icons ----------
test('g1: the groups come in the order In review, Ready, In progress, Next, Pending, Blocked, Completed, each only when it has tasks', () => {
  assert.deepEqual(heads(view()), ['review', 'ready', 'progress', 'next', 'pending', 'blocked', 'done']);
  const few = { available: true, rows: [row('A', 'a', 'Pendiente'), row('B', 'b', 'Completada')], derived: {}, next: null };
  assert.deepEqual(heads(view({}, few)), ['pending', 'done']);
  assert.ok(!view().includes('In flight'), 'the jargon is gone');
});

test('g2: every header has exactly ONE icon (hidden from assistive tools), its name and its count (Next has no count); the rows have no icon at all', () => {
  const h = view();
  for (const key of ['review', 'ready', 'progress', 'next', 'pending', 'blocked', 'done']) {
    const s = section(h, key).split('<div class="tk-row')[0];
    assert.equal((s.match(/<svg\b/g) || []).length, 1, `${key}: one icon`);
    assert.match(s, /<svg[^>]*aria-hidden="true"/, key);
    assert.match(s, /<span class="tk-gn">[^<]+<\/span>/, key);
    if (key === 'next') assert.ok(!s.includes('tk-gc'), 'Next has no count'); else assert.match(s, /<span class="tk-gc">\d+<\/span>/, key);
  }
  assert.equal(((view().match(/<div class="tk-row[\s\S]*?<\/div>/g) || []).join('').match(/<svg/g) || []).length, 0, 'no icon on a row');
  assert.match(section(h, 'pending'), /<span class="tk-gc">12<\/span>/);
  assert.match(section(h, 'blocked'), /<span class="tk-gc">2<\/span>/);
  assert.match(section(h, 'done'), /<span class="tk-gc">5<\/span>/);
});

test('g3: the six icons are different shapes, so the group is not told by colour alone', () => {
  const h = view();
  const svgs = ['review', 'ready', 'progress', 'next', 'pending', 'blocked', 'done'].map((k) => /<svg[\s\S]*?<\/svg>/.exec(section(h, k))[0]);
  assert.equal(new Set(svgs).size, 7);
});

// ---------- rows ----------
test('r1: a row is the id and the title in ONE element and its extra data in another: PR in In review, the branch in Ready, nothing for In progress and Next', () => {
  const h = view();
  const rv = rows(section(h, 'review'));
  assert.deepEqual(rv.map((r) => [r.id, r.extra]), [['R1', 'PR #199']]);
  assert.match(rv[0].html, /^<span class="tk-t"><span class="tk-id mono">R1<\/span>Header polish<\/span><span class="tk-x">PR #199<\/span>$/);
  assert.deepEqual(rows(section(h, 'ready')).map((r) => [r.id, r.extra]), [['Y1', 'feat/rp151-example']]);
  assert.deepEqual(rows(section(h, 'progress')).map((r) => [r.id, r.extra]), [['P0', undefined]]);
  assert.deepEqual(rows(section(h, 'next')).map((r) => [r.id, r.extra]), [['N1', undefined]]);
});

test('r2: the next task is ONE row marked as the current one; no other row is', () => {
  const h = view();
  const n = rows(h).filter((r) => r.cls.includes('tk-next'));
  assert.equal(n.length, 1);
  assert.match(n[0].attrs, /aria-current="true"/);
  assert.equal(rows(h).filter((r) => /aria-current/.test(r.attrs)).length, 1);
});

test('r3: the rows are flat: nothing in them is a button, a link or focusable; the only buttons of the list are the fold, «+N more» and the refresh', () => {
  const h = view();
  for (const r of rows(h)) assert.ok(!/<button|<a |tabindex|data-act/.test(r.html + r.attrs), r.id);
  const buttons = [...h.matchAll(/<button[^>]*data-act="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['tasks-refresh', 'tasks-more', 'tasks-fold']);
});

test('r4: Pending lists the ones that can be taken first and the ones that wait for another task last, dimmed, with «waits for X» at the right and no icon', () => {
  const all = rows(section(view({ more: true }), 'pending'));
  assert.deepEqual(all.map((r) => r.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'W1']);
  const w = all[all.length - 1];
  assert.ok(w.cls.includes('tk-wait'));
  assert.equal(w.extra, 'waits for T1');
  assert.ok(all.slice(0, -1).every((r) => !r.cls.includes('tk-wait') && r.extra === undefined));
});

test('r5: a task that waits for several says them all; a dependency that is done or is not a row of the table is not waited for', () => {
  const rp = { available: true, rows: [row('A', 'a', 'Pendiente'), row('B', 'b', 'Pendiente'), row('C', 'c', 'Completada'), row('W', 'w', 'Pendiente', { dependsOn: ['A', 'B', 'C', 'OTHER-1'] })], derived: {}, next: null };
  assert.equal(rows(view({}, rp)).find((r) => r.id === 'W').extra, 'waits for A, B');
});

test('r6: Blocked shows its reason at the right of the row, always open; a long reason is cut with «…» in the row and complete in the tooltip', () => {
  const b = rows(section(view(), 'blocked'));
  assert.deepEqual(b.map((r) => r.id), ['B1', 'B2']);
  assert.equal(b[0].extra, 'Decided by the person');
  assert.equal(b[1].extra, `${LONG.slice(0, 140)}…`);
  assert.ok(b[1].attrs.includes(`title="B2 · Long block · ${LONG}"`) || b[1].attrs.includes(LONG), 'the tooltip has the whole reason');
});

test('r7: nothing from the roadmap reaches the page as markup: id, title, branch and reason are escaped, and so is the tooltip', () => {
  const evil = '<img src=x onerror=1>';
  const rp = { available: true, rows: [row('"><b>x', evil, 'Pendiente'), row('E2', evil, 'Bloqueada', { notas: evil }), row('E3', 'ok', 'Pendiente')], derived: { E3: { state: 'Lista', branch: evil } }, next: null };
  const h = view({}, rp);
  assert.ok(!h.includes('<img') && !h.includes('<b>x'), h);
  assert.match(h, /&lt;img src=x onerror=1&gt;/);
});

// ---------- Pending cap and «+N more» ----------
test('m1: Pending shows 10 rows and a «+N more» button that says how many are left and whether it is open', () => {
  const h = view();
  assert.deepEqual(rows(section(h, 'pending')).map((r) => r.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']);
  assert.match(section(h, 'pending'), /<button type="button" class="tk-fold tk-more" data-act="tasks-more" data-k="more" aria-expanded="false"><span class="chev" aria-hidden="true">▸<\/span>\+2 more<\/button>/);
});

test('m2: with «+N more» open every pending row is shown and the button says «Show fewer»; with 10 or fewer there is no button', () => {
  const h = view({ more: true });
  assert.equal(rows(section(h, 'pending')).length, 12);
  assert.match(section(h, 'pending'), /data-act="tasks-more" data-k="more" aria-expanded="true"><span class="chev" aria-hidden="true">▾<\/span>Show fewer<\/button>/);
  const few = { available: true, rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => row(`P${n}`, `p${n}`, 'Pendiente')), derived: {}, next: null };
  assert.ok(!view({}, few).includes('tasks-more'));
});

// ---------- Completed ----------
test('c1: Completed is a folded button with its count and shows NO task under it until it is opened', () => {
  const s = section(view(), 'done');
  assert.match(s, /^<button type="button" class="tk-gh tk-g-done" data-act="tasks-fold" data-fold="done" aria-expanded="false">/);
  assert.match(s, /<span class="tk-ch" aria-hidden="true">▸<\/span>/);
  assert.deepEqual(rows(s).map((r) => r.id), []);
  assert.ok(!s.includes('tk-row'));
});

test('c2: open, Completed lists them all, dimmed; the fold says it is open', () => {
  const s = section(view({ open: { done: true } }), 'done');
  assert.match(s, /aria-expanded="true"/);
  assert.match(s, /<span class="tk-ch" aria-hidden="true">▾<\/span>/);
  assert.deepEqual(rows(s).map((r) => r.id), ['D1', 'D2', 'D3', 'D4', 'D5']);
  assert.ok(rows(s).every((r) => r.cls.includes('tk-done')));
});

// ---------- freshness ----------
const NOW = 1000000000000;
const fresh = (ctx) => /<div class="tk-top([^"]*)">([\s\S]*?)<\/div><div class="tk-bar"/.exec(view({ now: NOW, ...ctx }));
const text = (m) => (/<span class="tk-ft">([^<]*)<\/span>/.exec(m[2]) || [])[1];

test('f1: the freshness line says when the list was read: just now, minutes, hours; from 15 minutes it turns yellow', () => {
  const cases = [[30000, 'Read just now', ''], [120000, 'Read 2 min ago', ''], [14 * 60000, 'Read 14 min ago', ''], [15 * 60000, 'Read 15 min ago', ' stale'], [59 * 60000, 'Read 59 min ago', ' stale'], [3 * 3600000 + 5000, 'Read 3 h ago', ' stale']];
  for (const [age, said, cls] of cases) { const m = fresh({ readAt: NOW - age }); assert.equal(text(m), said, said); assert.equal(m[1], cls, said); }
});

test('f2: a read time that makes no sense (the future, NaN, text) is read as «just now»; no read time says nothing about age but keeps the button', () => {
  for (const readAt of [NOW + 99999, NaN, 'x', null, -5]) assert.equal(text(fresh({ readAt })), 'Read just now', String(readAt));
  const m = fresh({});
  assert.equal(text(m), undefined);
  assert.match(m[2], /data-act="tasks-refresh"/);
});

test('f3: the refresh button is a real button with a name and a tooltip; while it works the line says «Updating…» and the button is off and busy', () => {
  const m = fresh({ readAt: NOW });
  assert.match(m[2], /<button type="button" class="tk-rf" data-act="tasks-refresh" aria-label="Refresh the task list" title="Fetch from GitHub, then read the list again">/);
  const b = fresh({ readAt: NOW, refreshing: true });
  assert.equal(text(b), 'Updating…');
  assert.match(b[2], /<button type="button" class="tk-rf busy" data-act="tasks-refresh"[^>]* disabled aria-busy="true"/);
});

test('f4: when the update failed the line says so in red and the list is still there; the state of the update wins over the age', () => {
  const m = fresh({ readAt: NOW - 20 * 60000, refreshFailed: true });
  assert.equal(text(m), 'Could not update. Try again.');
  assert.equal(m[1], ' bad');
  assert.ok(view({ refreshFailed: true }).includes('Mobile addresses'));
  assert.equal(text(fresh({ readAt: NOW, refreshing: true, refreshFailed: true })), 'Updating…');
});

test('f5: the freshness text and the button belong to the column list only (the full list of the chat tab and the notes have none) and sit in the summary row, not at the end of the list', () => {
  assert.ok(!R.tasksView(RP, { now: NOW, readAt: NOW }).includes('tk-top'));
  for (const rp of [null, { available: false, reason: 'missing' }, { available: true, rows: [], derived: {}, next: null }]) assert.ok(!R.tasksView(rp, { compact: true }).includes('tk-top'));
  const h = view({ readAt: NOW });
  assert.ok(h.indexOf('data-act="tasks-refresh"') < h.indexOf('class="tk-gh'), 'the refresh button comes before the first group, not after the list');
  assert.ok(!h.includes('tk-foot'), 'nothing is left at the end of the list');
});

// ---------- the stylesheet ----------
const rules = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => ({ sel: s.trim().replace(/\s+/g, ' '), body: m[2] })));
const rule = (sel) => { const r = rules.filter((x) => x.sel === sel); assert.ok(r.length, `a rule for ${sel}`); return r.map((x) => x.body).join(';'); };

test('k1: the rows are flat in the stylesheet: no border, no fill, default cursor; the extra data wraps below only when it does not fit and nothing is clipped', () => {
  const r = rule('.tk-row');
  assert.doesNotMatch(r, /border:\s*1px/);
  assert.doesNotMatch(r, /background:\s*var\(--panel2\)/);
  assert.match(r, /flex-wrap:\s*wrap/);
  assert.match(r, /justify-content:\s*space-between/);
  for (const sel of ['.tk-t', '.tk-x']) { assert.match(rule(sel), /overflow-wrap:\s*anywhere/, sel); assert.doesNotMatch(rule(sel), /text-overflow:\s*ellipsis|white-space:\s*nowrap/, sel); }
  assert.doesNotMatch(rule('.tk-x'), /line-clamp/, 'the extra data is never cut: it is short and it is what the row is about');
});

test('k1b: a title takes at most 2 lines and ends in «…» (the real titles are sentences: the median is 191 characters); the whole title stays in the tooltip', () => {
  const t = rule('.tk-t');
  assert.match(t, /display:\s*-webkit-box/);
  assert.match(t, /-webkit-box-orient:\s*vertical/);
  assert.match(t, /-webkit-line-clamp:\s*2/);
  assert.match(t, /overflow:\s*hidden/);
});

test('r8: whatever the length of a title, the tooltip of the row carries it whole, so the clamp of 2 lines loses nothing', () => {
  const title = `A very long title that goes on and on. ${'More and more words. '.repeat(20)}The very end`;
  const rp = { available: true, rows: [row('L1', title, 'Pendiente'), row('L2', title, 'Bloqueada', { notas: 'why' })], derived: {}, next: null };
  const h = view({}, rp);
  for (const r of rows(h)) assert.ok(r.attrs.includes(`${title}`), `${r.id}: the tooltip has the whole title`);
  assert.ok(!rows(h).some((r) => r.html.includes('…') && r.id === 'L1'), 'the text is whole in the markup: the cut is the stylesheet\'s');
});

test('k2: the next row has a 2 px blue rule and a bold title; the waiting and the done rows are dimmed', () => {
  assert.match(rule('.tk-next::before'), /width:\s*2px/);
  assert.match(rule('.tk-next::before'), /background:\s*var\(--blue\)/);
  assert.match(rule('.tk-next .tk-t'), /font-weight:\s*600/);
  for (const sel of ['.tk-wait .tk-t', '.tk-done .tk-t']) assert.match(rule(sel), /color:\s*var\(--muted\)/, sel);
});

test('k3: every group has its own colour for its icon, the wheel of In progress spins and stops with reduced motion', () => {
  const tone = { review: '--blue', ready: '--purple', progress: '--yellow', next: '--blue', pending: '--gray', blocked: '--red', done: '--green' };
  for (const [k, v] of Object.entries(tone)) assert.match(rule(`.tk-g-${k} .tk-gi`), new RegExp(`color:\\s*var\\(${v}\\)`), k);
  assert.match(rule('.tk-g-progress .tk-gi svg'), /animation:\s*spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.tk-g-progress \.tk-gi svg[^}]*animation:\s*none/);
});

test('k5: the summary row stays under the tabs when the list scrolls, so the refresh button is always at hand; the height of the tabs is measured by the page, not written by hand', () => {
  const s = rule('.tk-sum');
  assert.match(s, /position:\s*sticky/);
  assert.match(s, /top:\s*var\(--col-tabs-h,\s*\d+px\)/);
  assert.match(s, /background:\s*var\(--bg\)/);
  assert.match(s, /z-index:\s*1/);
  assert.match(read('chat.js'), /--col-tabs-h/, 'the page sets the variable from the real tab bar');
});

test('k6: in a narrow column (300 px or less) the freshness text goes to its own line under the label instead of breaking into pieces', () => {
  const q = /@container col \(max-width:\s*300px\)\s*\{([\s\S]*?)\n\}/g;
  const blocks = [...css.matchAll(q)].map((m) => m[1]).join('\n');
  assert.match(blocks, /\.tk-top\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(blocks, /\.tk-ft\s*\{[^}]*flex-basis:\s*100%/);
  assert.match(blocks, /\.tk-ft\s*\{[^}]*order:\s*3/);
  assert.match(blocks, /\.tk-ft\s*\{[^}]*text-align:\s*left/);
});

test('k4: the freshness line is yellow when old and red when it failed; the refresh button is touch sized with a coarse pointer and keeps a visible focus ring; the old card and legend rules are gone', () => {
  assert.match(rule('.tk-top.stale .tk-ft'), /color:\s*var\(--yellow\)/);
  assert.match(rule('.tk-top.bad .tk-ft'), /color:\s*var\(--red\)/);
  assert.match(css, /@media \(pointer:\s*coarse\)\s*\{[^@]*\.tk-rf[^}]*(?:width|height):\s*44px/);
  assert.match(css, /\.tk-rf:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(rule('.tk-rf.busy svg'), /animation:\s*spin/);
  assert.ok(!/\.tk-leg\b|\.tk-k\b|\.tk-foot\b/.test(css));
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false, focused: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() { el.focused++; }, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const routes = {};
  const fetches = [];
  const docL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, routes, fetches, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, attention: null });
function boot() {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card('abc', 'demo')], generatedAt: 'x' };
  S.local.abc = { branch: 'main', ahead: 0, files: [] };
  S.prs.abc = { prs: [] };
  const layout = page.get('#sumLayout');
  layout.clientWidth = 1400;
  layout.getBoundingClientRect = () => ({ left: 0, right: 1400, width: 1400 });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.routes['/api/roadmap?id=abc'] = () => Promise.resolve(ok(RP));
  page.routes['/api/fetch'] = () => Promise.resolve(ok({ ok: true }));
  return page;
}
const open = async (page) => { page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })"); await page.tick(); };
const col = (page) => page.get('#colBody').html;
const reads = (page) => page.fetches.filter((f) => f.url === '/api/roadmap?id=abc').length;
const tab = async (page, t) => { page.run(`ACTIONS['col-tab']({ dataset: { tab: '${t}' } })`); await page.tick(); };

test('p1: the list is read when the repo opens on Tasks, and AGAIN each time the Tasks tab is entered; the other tabs read no roadmap', async () => {
  const page = boot();
  await open(page);
  assert.equal(reads(page), 1);
  assert.match(col(page), /Mobile addresses/);
  await tab(page, 'changes');
  await tab(page, 'files');
  assert.equal(reads(page), 1, 'the other tabs ask for no roadmap');
  await tab(page, 'tasks');
  assert.equal(reads(page), 2, 'entering Tasks reads again');
  await tab(page, 'tasks');
  assert.equal(reads(page), 3, 'a click on the open tab reads again too: it is the cheap way to look');
});

test('p2: the freshness line follows the real read: it says «Read just now» after the read', async () => {
  const page = boot();
  await open(page);
  assert.match(col(page), /<span class="tk-ft">Read just now<\/span>/);
});

test('p3: the refresh button runs the fetch of THAT repo and then reads the list again, in that order, and ends on «Read just now»', async () => {
  const page = boot();
  await open(page);
  const before = page.fetches.length;
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  const seen = page.fetches.slice(before).map((f) => `${f.method} ${f.url}`);
  assert.deepEqual(seen, ['POST /api/fetch', 'GET /api/roadmap?id=abc']);
  assert.deepEqual(page.fetches[before].body, { id: 'abc' });
  assert.match(col(page), /<span class="tk-ft">Read just now<\/span>/);
  assert.ok(!/disabled aria-busy/.test(col(page)), 'the button is free again');
});

test('p4: while the update is on its way the line says «Updating…» and a second press sends nothing more', async () => {
  const page = boot();
  await open(page);
  let release;
  page.routes['/api/fetch'] = () => new Promise((r) => { release = () => r(ok({ ok: true })); });
  const before = page.fetches.length;
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  assert.match(col(page), /<span class="tk-ft">Updating…<\/span>/);
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  assert.equal(page.fetches.slice(before).filter((f) => f.url === '/api/fetch').length, 1);
  release();
  await page.tick();
  assert.match(col(page), /<span class="tk-ft">Read just now<\/span>/);
});

test('p5: when the fetch fails the line says so, the list is still shown and the roadmap is read once anyway (what is on this machine)', async () => {
  const page = boot();
  await open(page);
  page.routes['/api/fetch'] = () => Promise.reject(new Error('offline'));
  const before = reads(page);
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  assert.match(col(page), /<span class="tk-ft">Could not update\. Try again\.<\/span>/);
  assert.match(col(page), /Mobile addresses/);
  assert.equal(reads(page), before + 1);
  page.routes['/api/fetch'] = () => Promise.resolve(ok({ ok: true }));
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  assert.doesNotMatch(col(page), /Could not update/, 'the next try clears the failure when it works');
});

test('p6: a failed re-read keeps the last good list (the person never loses what was on screen)', async () => {
  const page = boot();
  await open(page);
  page.routes['/api/roadmap?id=abc'] = () => Promise.reject(new Error('boom'));
  await tab(page, 'changes');
  await tab(page, 'tasks');
  assert.match(col(page), /Mobile addresses/);
});

test('p7: closing the repo while the update is on its way breaks nothing and paints nothing', async () => {
  const page = boot();
  await open(page);
  let release;
  page.routes['/api/fetch'] = () => new Promise((r) => { release = () => r(ok({ ok: true })); });
  page.run("ACTIONS['tasks-refresh']()");
  await page.tick();
  page.run('closeChat()');
  release();
  await page.tick();
  assert.equal(page.run('S.chat.id'), null);
  assert.doesNotMatch(col(page), /Mobile addresses|tk-foot|Updating/, 'the column of the repo that was left paints nothing');
});

test('p8: «+N more» opens and closes in place and keeps the focus on its own button; the fold accepts only Completed now', async () => {
  const page = boot();
  await open(page);
  assert.match(col(page), /\+2 more/);
  page.run("ACTIONS['tasks-more']()");
  page.flush();
  assert.match(col(page), /Show fewer/);
  assert.match(col(page), /Eleventh pending/);
  assert.match(read('actions.js'), /'tasks-more':[^\n]*colFocus = \{ act: 'tasks-more', key: 'k', val: 'more' \}/, 'the focus goes back to its own button (data-k="more")');
  page.run("ACTIONS['tasks-more']()");
  page.flush();
  assert.match(col(page), /\+2 more/);
  for (const k of ['pending', 'blocked', '__proto__', '', undefined]) { page.run(`ACTIONS['tasks-fold']({ dataset: { fold: ${JSON.stringify(k)} } })`); assert.equal(page.run('Object.keys(S.tasksFold).length'), 0, String(k)); }
  page.run("ACTIONS['tasks-fold']({ dataset: { fold: 'done' } })");
  page.flush();
  assert.match(col(page), /Done thing 1/);
});
