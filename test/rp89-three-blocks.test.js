'use strict';
// RP89 (S4, S10): the Summary with a repo open is THREE blocks, list | chat | column, 25 | 50 | 25 by default, with two separators that resize them. R.blockWidths (pure) computes
// the three widths from the saved ratios of the LIST and the COLUMN (the chat is what is left), with a minimum for each block. The widths are saved under one new key; a double
// click (or Enter) on either separator resets all three; the arrows move 24 px. Under 1100 px the column goes away (two blocks, as before) and under 720 px everything stacks.
// Until RP91 the column holds a small notice card. The old `chatRatio` is ignored (it measured another thing). How it LOOKS and the real drag are for the person to try.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const css = read('style.css');

// ---------- pure: the three widths ----------
const sum = (w) => w.list + w.chat + w.col;

test('b1: by default the three blocks are 25 | 50 | 25 of the width left between the separators', () => {
  assert.deepEqual(R.blockWidths(1380, null), { list: 345, chat: 690, col: 345 });
  assert.deepEqual(R.blockWidths(1380, {}), { list: 345, chat: 690, col: 345 });
  assert.deepEqual(R.blockWidths(1100, undefined), { list: 275, chat: 550, col: 275 });
});

test('b2: the chat is what is left: the three always add up to the total and are whole numbers', () => {
  for (const total of [1100, 1234, 1381, 1700, 2559]) for (const r of [null, { list: 0.3, col: 0.2 }, { list: 0.17, col: 0.31 }, { list: 0.4, col: 0.4 }]) {
    const w = R.blockWidths(total, r);
    assert.equal(sum(w), total, `${total} ${JSON.stringify(r)}`);
    for (const k of ['list', 'chat', 'col']) assert.ok(Number.isInteger(w[k]) && w[k] >= 0, `${k} ${total}`);
  }
});

test('b3: the minimums hold: list 260, chat 340, column 220; when they cannot all fit the list goes first and the column takes what the chat leaves', () => {
  const small = R.blockWidths(1380, { list: 0.05, col: 0.05 });
  assert.deepEqual([small.list, small.col], [260, 220]);
  assert.equal(small.chat, 1380 - 260 - 220);
  const big = R.blockWidths(1380, { list: 0.6, col: 0.6 });
  assert.equal(big.chat, 340);
  assert.equal(big.list, 1380 - 340 - 220, 'the list takes all it can, the column keeps its minimum');
  assert.equal(big.col, 220);
  const mid = R.blockWidths(1380, { list: 0.3, col: 0.6 });
  assert.equal(mid.list, 414);
  assert.equal(mid.chat, 340);
  assert.equal(mid.col, 1380 - 340 - 414);
});

test('b4: a ratio that is not usable (missing, zero, negative, one or more, NaN, text) is the default one, each on its own', () => {
  for (const bad of [null, undefined, 0, -0.2, 1, 1.5, NaN, Infinity, 'x', {}, []]) {
    assert.deepEqual(R.blockWidths(1380, { list: bad, col: bad }), { list: 345, chat: 690, col: 345 }, String(bad));
  }
  assert.deepEqual(R.blockWidths(1380, { list: 0.3, col: 'x' }), { list: 414, chat: 621, col: 345 });
  assert.deepEqual(R.blockWidths(1380, 'nope'), { list: 345, chat: 690, col: 345 });
});

test('b5: without the column (under 1100 px) there are two blocks: the list is half by default as before, the stored list ratio is used, the minimums hold', () => {
  assert.deepEqual(R.blockWidths(990, null, { column: false }), { list: 495, chat: 495, col: 0 });
  assert.deepEqual(R.blockWidths(990, { list: 0.3, col: 0.3 }, { column: false }), { list: 297, chat: 693, col: 0 });
  assert.equal(R.blockWidths(990, { list: 0.05 }, { column: false }).list, 260);
  assert.equal(R.blockWidths(990, { list: 0.9 }, { column: false }).chat, 340);
});

test('b6: it is total: a width that is not a positive number gives zeros, and tiny widths never give a negative or fractional block', () => {
  for (const bad of [0, -5, NaN, Infinity, 'x', null, undefined]) assert.deepEqual(R.blockWidths(bad, null), { list: 0, chat: 0, col: 0 }, String(bad));
  for (const total of [1, 100, 500, 800]) {
    const w = R.blockWidths(total, null);
    for (const k of ['list', 'chat', 'col']) assert.ok(Number.isInteger(w[k]) && w[k] >= 0, `${k} ${total}`);
    assert.ok(sum(w) <= total || total < 820, `${total}`);
  }
});

test('b7 (RP128 replaced the two cards by tabs): the column is a tab bar and a panel; without facts the Changes panel says it is loading, and the notice of RP89 stays gone', () => {
  const none = R.columnView({ name: 'demo' });
  assert.match(none, /^<div class="col-tabs" role="tablist"/);
  assert.match(none, /<p class="rs-sub" role="status">Loading files…<\/p><\/div>$/);
  assert.match(R.columnView({ name: 'a<b>"c', files: [{ path: 'x.js', status: 'M' }] }), /aria-label="Files with changes of a&lt;b&gt;&quot;c"/);
  assert.equal(R.columnNotice, undefined, 'the notice of RP89 is gone');
});

// ---------- index.html and the styles ----------
test('h1: the static layout is list, separator, chat, second separator, column, in that order; the new ones start hidden and are accessible separators', () => {
  const m = /<div id="sumLayout" class="chatlayout">([\s\S]*?)<\/aside>\s*<\/div>\s*<div id="work"/.exec(html);
  assert.ok(m, 'the wrapper and what follows it');
  const order = ['id="summary"', 'id="split"', 'id="chat"', 'id="split2"', 'id="col"'].map((s) => m[1].indexOf(s));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(html, /<div id="split2" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Adjust the column width \(left and right arrows; double click to reset\)" hidden><\/div>/);
  assert.match(html, /<aside id="col" hidden aria-label="Repo column">\s*<div id="colBody"><\/div>\s*<\/aside>/);
  assert.match(html, /<div id="split" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Adjust the list width \(left and right arrows; double click to reset\)" hidden>/);
});

test('h2: the layout is a named container, the column shows only from 1100 px, the chat takes what is left and the list and the column have their own width', () => {
  assert.match(css, /\.chatlayout\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /\.chatlayout\s*\{[^}]*container-name:\s*sum/);
  assert.match(css, /#col,\s*#split2\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /@container sum \(min-width: 1100px\)\s*\{[^}]*#col[^}]*display:\s*flex/);
  assert.match(css, /\.chatlayout\.chat-open #listCol\s*\{[^}]*width:\s*var\(--list-w/);
  assert.match(css, /#col\s*\{[^}]*width:\s*var\(--col-w/);
  assert.match(css, /#chat\s*\{[^}]*flex:\s*1 1 0/);
  assert.doesNotMatch(css, /#chat\s*\{[^}]*width:\s*var\(--chat-w/);
});

test('h3: the new blocks hide with the attribute (an author display rule must not beat it) and stack under 720 px like before', () => {
  assert.match(css, /#split2\[hidden\],\s*#col\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  const media = /@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(media, 'the 720 px rule');
  assert.match(media[1], /#split,\s*#split2\s*\{\s*display:\s*none;/);
});

// ---------- the page ----------
function element(extra = {}) {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); }, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append(c) { el.children.push(c); },
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
    ...extra,
  };
  return el;
}
function loadPage({ stored = {} } = {}) {
  const els = {};
  const frames = [];
  const winL = {};
  const store = { ...stored };
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  return { get, flush, store, winL, run: (c) => vm.runInContext(c, ctx) };
}
const card = (o) => ({ id: 'abc', name: 'demo', group: 'G', room: null, branch: 'main', needs: false, rank: 9, progress: { total: null }, next: null, blocking: [], lastMovement: {}, session: { state: 'free' }, action: null, ...o });
function open(page, width = 1400) {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card()], generatedAt: 'x' };
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.flush();
}
const listW = (page) => page.get('#listCol').style['--list-w']; // RP121: the width is the repos column's
const colW = (page) => page.get('#col').style['--col-w'];
const saved = (page) => page.store['repo-panel.layout'];
const fireOn = (el, type, e = {}) => { for (const fn of el.listeners[type] || []) fn({ type, preventDefault() {}, ...e }); };

test('p1: opening a repo shows the three blocks with the default widths and the two separators; closing it keeps them (RP120) and only empties them', () => {
  const page = loadPage();
  open(page);
  assert.equal(listW(page), '345px');
  assert.equal(colW(page), '345px');
  for (const id of ['#chat', '#split', '#split2', '#col']) assert.equal(page.get(id).hidden, false, id);
  assert.match(page.get('#colBody').html, /class="col-tabs"/, 'with a repo open the column has its tabs');
  page.run("ACTIONS['chat-close']()");
  page.flush();
  for (const id of ['#chat', '#split', '#split2', '#col']) assert.equal(page.get(id).hidden, false, id + ' (RP120: the three blocks stay in with no repo open)');
  assert.doesNotMatch(page.get('#colBody').html, /col-tabs/, 'the column no longer holds the closed repo');
  assert.equal(listW(page), '345px');
});

test('p2: the list separator: the arrows move the list 24 px, the ratio is saved under the new key, and the chat keeps what is left', () => {
  const page = loadPage();
  open(page);
  const split = page.get('#split');
  fireOn(split, 'keydown', { key: 'ArrowRight' });
  assert.equal(listW(page), '369px');
  assert.deepEqual(JSON.parse(saved(page)), { list: 369 / 1380, col: 345 / 1380 });
  fireOn(split, 'keydown', { key: 'ArrowLeft' });
  fireOn(split, 'keydown', { key: 'ArrowLeft' });
  assert.equal(listW(page), '321px');
  assert.equal(colW(page), '345px', 'the column does not move');
});

test('p3: the column separator works the other way: left grows the column, right shrinks it', () => {
  const page = loadPage();
  open(page);
  const split2 = page.get('#split2');
  fireOn(split2, 'keydown', { key: 'ArrowLeft' });
  assert.equal(colW(page), '369px');
  fireOn(split2, 'keydown', { key: 'ArrowRight' });
  fireOn(split2, 'keydown', { key: 'ArrowRight' });
  assert.equal(colW(page), '321px');
  assert.equal(listW(page), '345px', 'the list does not move');
  assert.ok(JSON.parse(saved(page)).col > 0);
});

test('p4: Enter or a double click on EITHER separator resets all three blocks and forgets the saved widths', () => {
  const page = loadPage();
  open(page);
  for (const [sel, type, e] of [['#split', 'keydown', { key: 'Enter' }], ['#split', 'dblclick', {}], ['#split2', 'keydown', { key: 'Enter' }], ['#split2', 'dblclick', {}]]) {
    fireOn(page.get('#split'), 'keydown', { key: 'ArrowRight' });
    fireOn(page.get('#split2'), 'keydown', { key: 'ArrowLeft' });
    assert.ok(saved(page), 'something is saved first');
    fireOn(page.get(sel), type, e);
    assert.equal(listW(page), '345px', `${sel} ${type}`);
    assert.equal(colW(page), '345px', `${sel} ${type}`);
    assert.equal(saved(page), undefined);
  }
});

test('p5: the minimums hold with the keyboard: the list 260, the column 220, the chat 340', () => {
  const page = loadPage();
  open(page);
  for (let i = 0; i < 80; i++) fireOn(page.get('#split'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(listW(page), '260px');
  for (let i = 0; i < 80; i++) fireOn(page.get('#split2'), 'keydown', { key: 'ArrowRight' });
  assert.equal(colW(page), '220px');
  for (let i = 0; i < 80; i++) fireOn(page.get('#split'), 'keydown', { key: 'ArrowRight' });
  const l = Number.parseInt(listW(page), 10);
  assert.equal(1380 - l - 220, 340, 'the chat stops at its minimum');
});

test('p6: the saved widths are used when the page loads; a broken value or the OLD chat ratio is ignored', () => {
  const a = loadPage({ stored: { 'repo-panel.layout': JSON.stringify({ list: 0.3, col: 0.2 }) } });
  open(a);
  assert.equal(listW(a), '414px');
  assert.equal(colW(a), '276px');
  for (const bad of ['not json', '{"list":"x"}', '[]', 'null', '5']) {
    const b = loadPage({ stored: { 'repo-panel.layout': bad } });
    open(b);
    assert.equal(listW(b), '345px', bad);
    assert.equal(colW(b), '345px', bad);
  }
  const old = loadPage({ stored: { 'repo-panel.chatRatio': '0.7' } });
  open(old);
  assert.equal(listW(old), '345px', 'the old chat ratio is ignored');
  assert.equal(colW(old), '345px');
});

test('p7: dragging with the pointer: the list follows the pointer from the left edge, the column from the right edge; a move without a press does nothing', () => {
  const page = loadPage();
  open(page);
  const split = page.get('#split');
  const split2 = page.get('#split2');
  const captured = [];
  for (const el of [split, split2]) { el.setPointerCapture = (id) => captured.push(id); el.releasePointerCapture = () => captured.push('released'); }
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 500 });
  assert.equal(listW(page), '345px');
  fireOn(split, 'pointerdown', { pointerId: 1 });
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 505 });
  assert.equal(listW(page), '500px', 'the pointer minus half a separator');
  fireOn(split, 'pointerup', { pointerId: 1 });
  fireOn(split, 'pointermove', { pointerId: 1, clientX: 300 });
  assert.equal(listW(page), '500px', 'released');
  fireOn(split2, 'pointerdown', { pointerId: 2 });
  fireOn(split2, 'pointermove', { pointerId: 2, clientX: 1000 });
  assert.equal(colW(page), '395px', 'the right edge minus the pointer minus half a separator');
  fireOn(split2, 'pointerup', { pointerId: 2 });
  assert.deepEqual(captured, [1, 'released', 2, 'released']);
  assert.ok(saved(page));
});

test('p8: without the pointer-capture APIs nothing throws', () => {
  const page = loadPage();
  open(page);
  for (const id of ['#split', '#split2']) assert.doesNotThrow(() => { fireOn(page.get(id), 'pointerdown', { pointerId: 1 }); fireOn(page.get(id), 'pointerup', { pointerId: 1 }); });
});

test('p9: under 1100 px the column is out: two blocks, the list is half by default and the column has no width; a resize recomputes', () => {
  const page = loadPage();
  open(page, 1000);
  assert.equal(listW(page), '495px');
  assert.equal(colW(page), '0px');
  page.get('#sumLayout').clientWidth = 1400;
  for (const fn of page.winL.resize || []) fn({ type: 'resize' });
  assert.equal(listW(page), '345px');
  assert.equal(colW(page), '345px');
  assert.ok((page.winL.resize || []).length >= 1);
});

test('p10: the separators say their position for assistive technology (percent of the list, percent of the column)', () => {
  const page = loadPage();
  open(page);
  assert.equal(page.get('#split').attrs['aria-valuenow'], '25');
  assert.equal(page.get('#split2').attrs['aria-valuenow'], '25');
  fireOn(page.get('#split'), 'keydown', { key: 'ArrowRight' });
  assert.equal(page.get('#split').attrs['aria-valuenow'], '27');
});

test('p11: the old single-divider code is gone: no --chat-w, no chatRatio key', () => {
  const src = appSource();
  assert.doesNotMatch(src, /--chat-w|chatRatio|repo-panel\.chatRatio/);
  assert.match(src, /repo-panel\.layout/);
});

// ---------- RP120 (S14): the three blocks are in from the first start, with no repo open ----------
function noRepo(page, width = 1400) {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.summary = { rows: [card()], generatedAt: 'x' };
  const layout = page.get('#sumLayout');
  const names = new Set();
  layout.classList = { add: (c) => names.add(c), remove: (c) => names.delete(c), toggle: (c, on) => { if (on === undefined ? !names.has(c) : on) names.add(c); else names.delete(c); }, contains: (c) => names.has(c) };
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.run('drawChat()');
  page.flush();
  return names;
}

test('r1: with no repo open the list, the chat and the column are in, the list takes a quarter and not the whole window, and the layout class is on', () => {
  const page = loadPage();
  const names = noRepo(page);
  for (const id of ['#chat', '#split', '#split2', '#col']) assert.equal(page.get(id).hidden, false, id);
  assert.ok(names.has('chat-open'), 'the class that gives the list its width var(--list-w)');
  assert.equal(listW(page), '345px');
  assert.equal(colW(page), '345px');
});

test('r2: with no repo open the chat and the column say what to do, and there is no composer to write in', () => {
  const page = loadPage();
  noRepo(page);
  assert.match(page.get('#chatBody').html, /role="status"[^>]*>[^<]*Pick a repo/);
  assert.match(page.get('#colBody').html, /role="status"[^>]*>[^<]*Pick a repo/);
  assert.equal(page.get('#composer').hidden, true, 'nothing to send to');
  assert.equal(page.get('#chatHead').html, '', 'no repo, no head');
});

test('r3: the separators work with no repo open: the arrows move the list and the column and the shares are saved', () => {
  const page = loadPage();
  noRepo(page);
  fireOn(page.get('#split'), 'keydown', { key: 'ArrowRight' });
  assert.equal(listW(page), '369px');
  fireOn(page.get('#split2'), 'keydown', { key: 'ArrowLeft' });
  assert.equal(colW(page), '369px');
  assert.deepEqual(JSON.parse(saved(page)), { list: 369 / 1380, col: 369 / 1380 });
});

test('r4: the widths do not jump when a repo is chosen after, or closed again', () => {
  const page = loadPage();
  noRepo(page);
  fireOn(page.get('#split'), 'keydown', { key: 'ArrowRight' });
  page.run("ACTIONS['chat-open']({ dataset: { id: 'abc' } })");
  page.flush();
  assert.equal(listW(page), '369px');
  page.run("ACTIONS['chat-close']()");
  page.flush();
  assert.equal(listW(page), '369px');
});

test('r5: in a narrow window the chat is in with no repo open too, and the column stays out as RP89 decided', () => {
  const page = loadPage();
  noRepo(page, 900);
  assert.equal(page.get('#chat').hidden, false);
  assert.equal(listW(page), '445px');
  assert.match(page.get('#chatBody').html, /Pick a repo/);
});

test('r6: the right column looks like the list: no panel color and no line of its own, and its separator mirrors the left one; only the chat has the panel color', () => {
  // The body of the rule that starts a line with `sel {` (the first one: the later ones are inside media or container queries).
  const rule = (sel) => { const at = css.indexOf(`\n${sel} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
  const col = rule('#col');
  assert.ok(col, 'the #col rule');
  assert.doesNotMatch(col, /background/, 'the column takes the page background, like the list');
  assert.doesNotMatch(col, /border-left/, 'no line of its own: the separator draws it');
  assert.match(rule('#chat'), /background:\s*var\(--panel\)/, 'the chat keeps the panel color');
  const split2 = rule('#split2');
  assert.match(split2, /border-left:\s*0/, 'the line goes on the column side, not on the chat side');
  assert.match(split2, /border-right:\s*1px solid var\(--line\)/, 'mirror of the left separator, whose line is on the list side');
  assert.match(rule('#split, #split2'), /border-left:\s*1px solid var\(--line\)/, 'the left separator is untouched');
});
