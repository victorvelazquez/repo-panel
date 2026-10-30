'use strict';
// RP26: one refresh signal. The per-card spinning arrow is gone; the icon of the top "Refresh" button spins while ANY
// repo is refreshing. Repos keep refreshing exactly as before (S.loading is still counted per repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const view = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
// Windows runners check the repo out with CRLF line endings: read everything as LF so the regexes below do not depend on it.
const lf = (text) => text.replace(/\r\n/g, '\n');
const read = (f) => lf(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
const renderBody = (src) => /function render\(\) \{[\s\S]*?\n\}\n/.exec(lf(src));

const stub = () => new Proxy(function stubElement() {}, {
  get: (t, k) => (k === 'content' ? 'token' : k === 'dataset' ? {} : k === 'classList' ? { add() {}, remove() {}, toggle() {} } : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub(),
});

const BUTTON = '[data-act="refresh-all"]';

async function loadPage() {
  const toggles = [];
  const button = { classList: { toggle: (...a) => toggles.push(a), add() {}, remove() {} } };
  const ctx = vm.createContext({
    console,
    document: new Proxy({}, { get: (t, k) => (k === 'hidden' ? false : k === 'querySelector' ? (sel) => (sel === BUTTON ? button : stub()) : stub) }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    confirm: () => true,
    fetch: async () => { throw new Error('offline'); },
  });
  ctx.window = ctx;
  ctx.RepoPanelView = view;
  vm.runInContext(read('app.js'), ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { get: (name) => vm.runInContext(name, ctx), toggles };
}

const R = { id: 'abc', name: 'demo', path: 'x' };
const file = { path: 'a.txt', status: 'M', untracked: false };
const local = () => ({ branch: 'task', detached: false, upstream: 'origin/task', noUpstream: false, ahead: 0, behind: 0, files: [file], added: 0, deleted: 0, head: 'h1', inProgress: null, base: 'main' });

function setup(page) {
  const S = page.get('S');
  S.groups = [{ name: 'g', repos: [R] }];
  S.local[R.id] = local();
  S.prs[R.id] = { prs: [], stale: null, repo: { url: 'https://github.com/o/demo' } };
  return S;
}

test('isRefreshing: true only while some repo has a request in flight', () => {
  assert.equal(view.isRefreshing({}), false);
  assert.equal(view.isRefreshing({ a: 0, b: 0 }), false);
  assert.equal(view.isRefreshing({ a: 0, b: 1 }), true);
  assert.equal(view.isRefreshing({ a: 3 }), true);
  assert.equal(view.isRefreshing(undefined), false);
  assert.equal(view.isRefreshing(null), false);
});

test('page: a repo that is refreshing no longer shows a spinning arrow on its card, and the card is otherwise unchanged', async () => {
  const page = await loadPage();
  const S = setup(page);
  const idle = page.get('repoCard')(R, false, null);
  S.loading[R.id] = 2;
  const busy = page.get('repoCard')(R, false, null);
  assert.ok(!/class="spin"/.test(busy), 'no spinner on the card');
  assert.ok(!/Refreshing/.test(busy), 'and no Refreshing marker either');
  assert.equal(busy, idle, 'the card looks the same refreshing or not');
});

test('page: the top Refresh icon is switched on while any repo is refreshing and off when all are done', async () => {
  const page = await loadPage();
  const S = setup(page);
  const sync = page.get('syncRefreshIcon');
  S.loading = {};
  sync();
  S.loading = { abc: 1 };
  sync();
  S.loading = { abc: 0 };
  sync();
  assert.deepEqual(page.toggles.slice(-3), [['loading', false], ['loading', true], ['loading', false]]);
});

test('page: render keeps the top icon in step with the loading count', () => {
  const src = read('app.js');
  const render = renderBody(src);
  assert.ok(render && /syncRefreshIcon\(\)/.test(render[0]), 'render() calls syncRefreshIcon()');
  assert.ok(!/class="spin"/.test(src), 'no spinner markup is left in app.js');
});

test('the Refresh button has an icon element, and only that icon spins while loading', () => {
  assert.match(read('index.html'), /data-act="refresh-all"[^>]*><span class="ico">↻<\/span> Refresh<\/button>/);
  const css = read('style.css');
  assert.match(css, /button\.loading \.ico\s*\{[^}]*animation:\s*spin/);
  assert.ok(!/(^|\n)\.spin\b/.test(css), 'the old per-card .spin rule is gone');
});

test('the spin respects prefers-reduced-motion', () => {
  const css = read('style.css');
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(block, 'there is a reduced-motion block');
  assert.match(block[1], /\.ico/);
  assert.match(block[1], /animation:\s*none/);
});

test('the checks that read the page source also work on a CRLF checkout (Windows runners)', () => {
  const crlf = read('app.js').replace(/\n/g, '\r\n');
  const body = renderBody(crlf);
  assert.ok(body && /syncRefreshIcon\(\)/.test(body[0]), 'render() is found and calls syncRefreshIcon() with CRLF line endings');
  assert.ok(!/class="spin"/.test(lf(crlf)));
});
