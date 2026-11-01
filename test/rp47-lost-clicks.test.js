'use strict';
// RP47: a click that never arrives. The page used to replace the whole board (and the "Go work on" strip and the drawer) on
// every redraw, and it redrew twice per read of every repo every 10 s even when nothing had changed (about 150 times a minute
// measured in a real browser at rest). A press that spans a redraw lost its target, so the `click` never fired: 1 click in 4
// failed, more with a slower press. Two rules, pinned here in the real public/app.js (vm with a recording DOM):
//  1. A region whose HTML did not change is not written again, so nothing under the pointer is replaced for no reason.
//  2. While a press is held, a redraw waits for the release (never longer than PRESS_MAX_MS, so a lost release cannot freeze
//     the page) and then runs once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, disabled: false, value: '', checked: false, textContent: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, showModal() {}, close() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
  };
  return el;
}

function loadPage() {
  const els = {};
  const listeners = [];
  const frames = [];
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const on = (type, fn) => listeners.push({ type, fn });
  const ctx = vm.createContext({
    console,
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener: on, createElement: () => element(), body: element() },
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: () => new Promise(() => {}), // never answers: the page's own start-up reads stay pending and cannot fire after the test
  });
  ctx.window = ctx;
  ctx.addEventListener = on;
  ctx.RepoPanelView = require('../public/view.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx);
  const fire = (type) => { for (const l of listeners.filter((x) => x.type === type)) l.fn({ type, target: element() }); };
  const flush = () => { while (frames.length) frames.shift()(); };
  return { ctx, els, listeners, get, fire, flush, run: (code) => vm.runInContext(code, ctx), app: () => get('#app'), queue: () => get('#queue'), conformityView: () => get('#conformityView') };
}

const local = (o = {}) => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main', stagedCount: 0, stagedPaths: [], ...o });

function withRepo(page, l = local({ files: [{ path: 'a.txt', status: 'M', untracked: false }] })) {
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }] }];
  S.local.abc = l;
  S.prs.abc = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
}

// ---------- rule 1: an unchanged region is not written again ----------
test('the first redraw paints the board, and a second redraw with nothing changed writes nothing', () => {
  const page = loadPage();
  withRepo(page);
  page.run('render()');
  assert.equal(page.app().writes, 1, 'the first redraw paints the board');
  assert.match(page.app().html, /demo/);
  const board = page.app().html;
  for (let i = 0; i < 5; i++) page.run('render()');
  assert.equal(page.app().writes, 1, 'five more redraws with the same state write nothing');
  assert.equal(page.app().html, board);
});

test('a redraw after a real change paints again, and only then', () => {
  const page = loadPage();
  const S = withRepo(page);
  page.run('render()');
  S.local.abc = local({ files: [{ path: 'a.txt', status: 'M', untracked: false }, { path: 'b.txt', status: 'M', untracked: false }] });
  page.run('render()');
  assert.equal(page.app().writes, 2);
  page.run('render()');
  assert.equal(page.app().writes, 2);
});

test('the Go work on strip and the Conformity view are not rewritten when their HTML did not change', () => {
  const page = loadPage();
  const S = withRepo(page);
  S.queue = [{ id: 'abc', name: 'demo', kind: 'branch' }];
  page.run('render()');
  S.tab = 'conformity';
  page.run('render()');
  const q = page.queue().writes;
  assert.ok(page.conformityView().writes >= 1, 'the Conformity view was painted');
  assert.ok(q >= 1, 'the strip was painted');
  assert.match(page.queue().html, /queue-pick/);
  const d = page.conformityView().writes;
  page.run('render()');
  page.run('render()');
  assert.equal(page.queue().writes, q, 'the strip keeps its buttons');
  assert.equal(page.conformityView().writes, d, 'the Conformity view keeps its buttons');
});

test('the reads that finish without changing anything (loading counter up and down) do not replace the board', () => {
  const page = loadPage();
  const S = withRepo(page);
  page.run('render()');
  const before = page.app().writes;
  for (let i = 0; i < 20; i++) {
    S.loading.abc = (S.loading.abc || 0) + 1;
    page.run('draw()');
    page.flush();
    S.loading.abc--;
    page.run('draw()');
    page.flush();
  }
  assert.equal(page.app().writes, before, '40 redraws caused by reads that changed nothing');
});

// ---------- rule 2: a redraw waits for the release ----------
test('while a press is held a redraw does not touch the page, and after the release it runs once', () => {
  const page = loadPage();
  const S = withRepo(page);
  page.run('render()');
  const before = page.app().writes;
  page.fire('pointerdown');
  S.local.abc = local({ files: [{ path: 'a.txt', status: 'M', untracked: false }, { path: 'b.txt', status: 'M', untracked: false }] });
  page.run('draw()');
  page.flush();
  assert.equal(page.app().writes, before, 'nothing under the pointer is replaced during the press');
  page.fire('pointerup');
  page.flush();
  assert.equal(page.app().writes, before + 1, 'the postponed redraw runs once after the release');
  page.flush();
  assert.equal(page.app().writes, before + 1);
});

test('a press that ends as a cancel also releases the redraw', () => {
  for (const end of ['pointercancel']) {
    const page = loadPage();
    const S = withRepo(page);
    page.run('render()');
    const before = page.app().writes;
    page.fire('pointerdown');
    S.local.abc = local({ files: [] });
    page.run('draw()');
    page.flush();
    assert.equal(page.app().writes, before, end);
    page.fire(end);
    page.flush();
    assert.equal(page.app().writes, before + 1, `${end} releases it`);
  }
});

test('a release that never arrives cannot freeze the page: after PRESS_MAX_MS the redraw runs anyway', () => {
  const page = loadPage();
  const S = withRepo(page);
  page.run('render()');
  const before = page.app().writes;
  page.fire('pointerdown');
  page.run('pressedAt = Date.now() - 60000');
  S.local.abc = local({ files: [] });
  page.run('draw()');
  page.flush();
  assert.equal(page.app().writes, before + 1);
  assert.ok(page.run('PRESS_MAX_MS') <= 2000, 'the guard is short');
});

// ---------- what must not change ----------
test('the click handler still runs the action of the pressed button and closes an open menu', () => {
  const page = loadPage();
  withRepo(page);
  page.run('S.menu = "abc"; globalThis.probed = []; ACTIONS.probe = (el) => globalThis.probed.push(el.dataset.act);');
  const target = { closest: (s) => (s === '[data-act]' ? { dataset: { act: 'probe' }, tagName: 'BUTTON', disabled: false } : null) };
  for (const l of page.listeners.filter((x) => x.type === 'click')) l.fn({ type: 'click', target });
  assert.deepEqual(Array.from(page.run('probed')), ['probe'], 'the action of the pressed button ran');
  assert.equal(page.run('S.menu'), null, 'a click outside the menu closes it');
});

test('first paint of an empty install is unchanged: the add-your-first-repo button', () => {
  const page = loadPage();
  page.run('S.groups = []');
  page.run('render()');
  assert.match(page.app().html, /No repositories yet./);
  assert.match(page.app().html, /data-act="add-dialog"/);
  assert.ok(page.app().writes >= 1);
});

test('and the empty install is not rewritten when nothing changed either', () => {
  const page = loadPage();
  page.run('S.groups = []');
  page.run('render()');
  const writes = page.app().writes;
  page.run('render()');
  assert.equal(page.app().writes, writes);
});
