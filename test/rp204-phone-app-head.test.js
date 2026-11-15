'use strict';
// RP204 (S8, S15): under 760 px the app header (logo, tabs, usage) is out while the chat or Repo screen is open; the list, the duo and the desktop keep it.
// The page marks <body> with `data-app-head="off"` (applyScreen) and the stylesheet hides the header under that mark. --sum-top then accepts 0 while the layout is visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function element(extra = {}) {
  const el = {
    html: '', hidden: false, dataset: {}, disabled: false, value: '', textContent: '', attrs: {}, listeners: {}, children: [], open: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty(k, v) { el.style[k] = v; } },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    showModal() {}, close() {}, focus() {}, append() {},
    get innerHTML() { return el.html; }, set innerHTML(v) { el.html = String(v); }, ...extra,
  };
  return el;
}
function loadPage({ body = true } = {}) {
  const els = {};
  const frames = [];
  const get = (sel) => (els[sel] ||= element());
  const doc = { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: body ? element() : undefined, activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: () => new Promise(() => {}),
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  return { get, doc, run: (c) => vm.runInContext(c, ctx) };
}
const mark = (page) => page.doc.body.dataset.appHead;
function at(page, width, id, zone = 'chat') {
  const S = page.run('S');
  S.chat.id = id;
  S.chat.zone = zone;
  page.get('#sumLayout').clientWidth = width;
  page.run('applyScreen()');
}

test('p1: only the chat and Repo screens hide the app header', () => {
  assert.equal(V.hidesAppHead('chat'), true);
  assert.equal(V.hidesAppHead('repo'), true);
  for (const s of ['list', 'duo', null, undefined, '', 'x']) assert.equal(V.hidesAppHead(s), false, String(s));
});

test('p2: the page sets the mark on chat and Repo, and not on list, duo, wide or a hidden layout', () => {
  const page = loadPage();
  at(page, 390, 'a', 'chat');
  assert.equal(mark(page), 'off', 'chat');
  at(page, 390, 'a', 'repo');
  assert.equal(mark(page), 'off', 'repo');
  at(page, 390, null);
  assert.equal(mark(page), undefined, 'list');
  at(page, 390, 'a', 'chat');
  at(page, 900, 'a', 'chat');
  assert.equal(mark(page), undefined, 'duo');
  at(page, 390, 'a', 'chat');
  at(page, 1400, 'a', 'chat');
  assert.equal(mark(page), undefined, 'wide');
  at(page, 390, 'a', 'chat');
  at(page, 0, 'a', 'chat');
  assert.equal(mark(page), undefined, 'hidden in another tab');
});

test('p3: closing the chat (back to the list) restores the header', () => {
  const page = loadPage();
  at(page, 390, 'a', 'chat');
  assert.equal(mark(page), 'off');
  page.run('S.chat.id = null');
  page.run('applyLayout()');
  assert.equal(mark(page), undefined);
});

test('p4: a page without body does not throw', () => {
  const page = loadPage({ body: false });
  assert.doesNotThrow(() => at(page, 390, 'a', 'chat'));
});

test('p5: the stylesheet hides the header itself only under the mark, outside the wide container block', () => {
  const hides = [...css.matchAll(/(?:^|\n)([^{}\n@/ ][^{}\n]*)\{([^}]*)\}/g)].filter((m) => /(^|[\s,>])header\s*$/.test(m[1].trim()) && /display:\s*none/.test(m[2]));
  assert.equal(hides.length, 1, 'one rule hides the header');
  assert.equal(hides[0][1].trim(), 'body[data-app-head="off"] > header');
  const before = css.slice(0, hides[0].index);
  assert.equal(before.split('{').length - before.split('}').length, 0, 'top level of the stylesheet (no media or container block)');
  assert.match(css, /\nheader \{ position: sticky; top: 0;/);
  assert.match(html, /<body>[\s\S]*?\n {2}<header>/);
});

test('p6: --sum-top accepts 0 while the header is out and the layout is visible, and keeps the old guard otherwise', () => {
  const page = loadPage();
  const layout = page.get('#sumLayout');
  layout.offsetTop = 98;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '98px', 'list: header in');
  layout.offsetTop = 0;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '98px', 'no screen: 0 is ignored');
  at(page, 390, 'a', 'chat');
  layout.offsetTop = 0;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '0px', 'chat: header out, 0 is the measure');
  layout.offsetTop = 30;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '30px', 'a notice above still counts');
  layout.clientWidth = 0;
  layout.offsetTop = 0;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '30px', 'hidden layout: 0 is ignored');
  at(page, 390, null);
  layout.offsetTop = 0;
  page.run('applyLayout()');
  assert.equal(layout.style['--sum-top'], '30px', 'list again: the guard is back');
});
