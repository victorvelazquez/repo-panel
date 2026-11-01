'use strict';
// RP65 (S62), the page side: R.filesView draws the tree of files (folders folded, the changed ones marked and their folders open) and the
// file read in the same numbered-lines look as the Changes viewer, with the changed lines highlighted. R.chatHead gains the Files tab.
// Everything that comes from the repo (names, text, errors) is escaped. Pure and total; the page tests drive the tab with a stubbed fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const tree = (...paths) => ({ files: paths.map((p) => ({ path: p, untracked: false })), truncated: false });
const file = (o = {}) => ({ path: 'src/a.js', size: 9, text: 'one\nTWO\nthree\n', changed: [[2, 1]], binary: false, tooLarge: false, ...o });
const count = (html, re) => (html.match(re) || []).length;

// ---------- the tree ----------
test('v1: folders and files are buttons with their acts and paths; root files are always visible', () => {
  const html = R.filesView(tree('README.md', 'src/a.js', 'src/lib/b.js', 'docs/x.md'), {});
  assert.match(html, /data-act="files-open" data-path="README\.md"/);
  assert.match(html, /data-act="files-dir" data-path="src"[^>]*aria-expanded="false"/);
  assert.match(html, /data-act="files-dir" data-path="docs"/);
  assert.doesNotMatch(html, /data-path="src\/a\.js"/, 'a folded folder hides its files');
});

test('v2: a folder with a changed file is open by default and the changed file is marked; the person can still fold it', () => {
  const t = tree('README.md', 'src/a.js', 'src/lib/b.js', 'docs/x.md');
  const html = R.filesView(t, { changed: { 'src/lib/b.js': 'M' } });
  assert.match(html, /data-act="files-dir" data-path="src"[^>]*aria-expanded="true"/);
  assert.match(html, /data-act="files-dir" data-path="src\/lib"[^>]*aria-expanded="true"/);
  assert.match(html, /class="ft-row ft-file ft-chg"[^>]*data-path="src\/lib\/b\.js"[\s\S]*?<span class="ft-mark">M<\/span>/);
  assert.match(html, /data-act="files-dir" data-path="docs"[^>]*aria-expanded="false"/, 'no change inside: folded');
  assert.match(R.filesView(t, { changed: { 'src/lib/b.js': 'M' }, open: { src: false } }), /data-path="src"[^>]*aria-expanded="false"/);
  assert.match(R.filesView(t, { open: { docs: true } }), /data-path="docs\/x\.md"/);
});

test('v3: the selected file is pressed; an untracked one says so', () => {
  const html = R.filesView({ files: [{ path: 'a.txt', untracked: true }, { path: 'b.txt', untracked: false }] }, { selected: 'a.txt', changed: { 'a.txt': '?' } });
  assert.match(html, /ft-on[^>]*data-path="a\.txt"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-path="a\.txt"/);
  assert.match(html, /data-path="b\.txt"[^>]*aria-pressed="false"/);
});

test('v4: names from the repo are escaped everywhere', () => {
  const evil = '<img src=x onerror=alert(1)>/a"b\'.js';
  const html = R.filesView(tree(evil), { open: { '<img src=x onerror=alert(1)>': true }, selected: evil }, file({ path: evil, text: '<script>alert(1)</script>\n', changed: [] }));
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img/);
});

test('v5: loading, failed and empty states for the tree', () => {
  assert.match(R.filesView(null, { loading: true }), /Loading files…/);
  assert.match(R.filesView(null, { failed: true }), /Files unavailable/);
  assert.match(R.filesView(tree(), {}), /No files/);
});

test('v6: a huge tree is cut with the count of what is not shown', () => {
  const html = R.filesView(tree(...Array.from({ length: 2500 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`)), {});
  assert.ok(count(html, /data-act="files-open"/g) <= 1500);
  assert.match(html, /\+\d+ more/);
});

// ---------- the file ----------
test('w1: the text shows with one gutter of numbers and only the changed lines highlighted', () => {
  const html = R.filesView(tree('src/a.js'), { selected: 'src/a.js', open: { src: true } }, file());
  assert.equal(count(html, /class="cv-l[ a-z]*"/g), 3);
  assert.match(html, /<div class="cv-l"><span class="cv-n">1<\/span><span class="cv-t">one<\/span><\/div>/);
  assert.match(html, /<div class="cv-l e"><span class="cv-n">2<\/span><span class="cv-t">TWO<\/span><\/div>/);
  assert.match(html, /<div class="cv-l"><span class="cv-n">3<\/span><span class="cv-t">three<\/span><\/div>/);
  assert.match(html, /class="cv-title"[^>]*>src\/a\.js</);
});

test('w2: several ranges, and a range that runs past the text, highlight exactly their lines', () => {
  const html = R.filesView(tree('a'), { selected: 'a' }, file({ path: 'a', text: 'a\nb\nc\nd\ne\n', changed: [[1, 2], [5, 9]] }));
  assert.deepEqual([...html.matchAll(/class="cv-l( e)?"><span class="cv-n">(\d)/g)].map((m) => `${m[2]}${m[1] ? 'e' : ''}`), ['1e', '2e', '3', '4', '5e']);
});

test('w3: binary, too large, loading, failed and "pick a file" are notes, never code', () => {
  const pick = (f, ctx = {}) => R.filesView(tree('a'), { selected: 'a', ...ctx }, f);
  assert.match(pick(file({ path: 'a', binary: true, text: undefined })), /Binary file/);
  assert.match(pick(file({ path: 'a', tooLarge: true, size: 2 * 1024 * 1024, text: undefined })), /too large[^<]*2(\.0)? MB|too large/i);
  assert.match(pick(null, { fileLoading: true }), /Loading file…/);
  assert.match(pick(null, { fileFailed: 'File not found' }), /File not found/);
  assert.match(R.filesView(tree('a'), {}), /Pick a file/);
  for (const html of [pick(file({ path: 'a', binary: true, text: undefined })), pick(null, { fileLoading: true })]) assert.doesNotMatch(html, /cv-code/);
});

test('w4: a long file is cut with the number of lines not shown', () => {
  const html = R.filesView(tree('a'), { selected: 'a' }, file({ path: 'a', text: `${'x\n'.repeat(2600)}`, changed: [] }));
  assert.equal(count(html, /class="cv-l[ a-z]*"/g), 2000);
  assert.match(html, /\+600 more lines/);
});

test('w5: any input gives a string and never throws', () => {
  for (const [t, c, f] of [[undefined, undefined, undefined], [{}, {}, {}], [{ files: 'x' }, null, 5], [{ files: [null, 3, {}, { path: 5 }] }, { changed: 'x', open: 7 }, { text: 5, changed: 'x' }],
    [tree('a'), { selected: 'a' }, { text: 'a', changed: [[1], 'x', [NaN, 2], [-3, 1], [1e12, 1e12]] }]]) assert.equal(typeof R.filesView(t, c, f), 'string');
});

// ---------- the tab ----------
test('x1: chatHead has the Files tab after Changes, selected only when it is the current one', () => {
  const h = R.chatHead({ id: 'abc', tab: 'files' }, { name: 'demo' });
  assert.deepEqual([...h.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]), ['chat', 'tasks', 'changes', 'files']);
  assert.match(h, /data-tab="files"[^>]*aria-selected="true"[^>]*>Files</);
  assert.match(R.chatHead({ id: 'abc' }, { name: 'demo' }), /data-tab="files"[^>]*aria-selected="false"/);
});

// ---------- the page ----------
function element() {
  const el = {
    writes: 0, html: '', hidden: false, dataset: {}, value: '', textContent: '', attrs: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: { setProperty() {} },
    addEventListener() {}, setAttribute(k, v) { el.attrs[k] = v; }, querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {},
    get innerHTML() { return el.html; },
    set innerHTML(v) { el.html = String(v); el.writes++; },
  };
  return el;
}
function loadPage() {
  const els = {};
  const frames = [];
  const fetches = [];
  const methods = [];
  const routes = {};
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? { ...element(), content: 'token' } : element()));
  const ctx = vm.createContext({
    console, document: { hidden: false, querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => element(), body: element(), activeElement: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '' },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts) => { fetches.push(url); methods.push((opts && opts.method) || 'GET'); const r = routes[url.split('&path=')[0]] || routes[url]; return r ? r(url) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = require('../public/view.js');
  ctx.RepoPanelResumen = R;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), ctx);
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); while (frames.length) frames.shift()(); };
  return { get, fetches, methods, routes, tick, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const bad = (status, error) => Promise.resolve({ ok: false, status, statusText: 'x', json: async () => ({ error }) });
const open = (page) => page.run("S.groups = [{ name: 'g', repos: [{ id: 'abc', path: 'p', name: 'demo', group: 'g' }] }]; S.chat = { id: 'abc', seq: 1 }; S.local.abc = { files: [{ path: 'src/a.js', status: 'M' }] };");

test('y1: switching to Files reads the tree once, paints it in the chat body and hides the composer', async () => {
  const page = loadPage();
  page.routes['/api/files?id=abc'] = () => ok(tree('README.md', 'src/a.js'));
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  assert.equal(page.fetches.filter((u) => u === '/api/files?id=abc').length, 1);
  assert.match(page.get('#chatBody').html, /data-act="files-open" data-path="src\/a\.js"/, 'the folder of the changed file is open');
  assert.equal(page.get('#composer').hidden, true);
});

test('y2: opening a file reads it with its path encoded and shows its lines with the changed ones marked', async () => {
  const page = loadPage();
  page.routes['/api/files?id=abc'] = () => ok(tree('src/a.js'));
  page.routes['/api/file?id=abc'] = () => ok(file());
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  page.run("ACTIONS['files-open']({ dataset: { path: 'src/a.js' } })");
  await page.tick();
  assert.ok(page.fetches.includes('/api/file?id=abc&path=src%2Fa.js'));
  assert.match(page.get('#chatBody').html, /<div class="cv-l e"><span class="cv-n">2<\/span>/);
});

test('y3: a late answer of an earlier click never replaces the file of the latest click', async () => {
  const page = loadPage();
  const late = {};
  page.routes['/api/files?id=abc'] = () => ok(tree('a.txt', 'b.txt'));
  page.routes['/api/file?id=abc'] = (url) => (url.endsWith('a.txt') ? new Promise((r) => { late.a = r; }) : ok(file({ path: 'b.txt', text: 'B-TEXT\n', changed: [] })));
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  page.run("ACTIONS['files-open']({ dataset: { path: 'a.txt' } })");
  page.run("ACTIONS['files-open']({ dataset: { path: 'b.txt' } })");
  await page.tick();
  late.a({ ok: true, status: 200, json: async () => file({ path: 'a.txt', text: 'A-TEXT\n', changed: [] }) });
  await page.tick();
  assert.match(page.get('#chatBody').html, /B-TEXT/);
  assert.doesNotMatch(page.get('#chatBody').html, /A-TEXT/);
});

test('y4: a refused or failed read is a note with the server message, and the tree stays', async () => {
  const page = loadPage();
  page.routes['/api/files?id=abc'] = () => ok(tree('a.txt'));
  page.routes['/api/file?id=abc'] = () => bad(404, 'File not found');
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  page.run("ACTIONS['files-open']({ dataset: { path: 'a.txt' } })");
  await page.tick();
  assert.match(page.get('#chatBody').html, /File not found/);
  assert.match(page.get('#chatBody').html, /data-act="files-open" data-path="a\.txt"/);
});

test('y5: a failed tree read says so; folding a folder redraws without a new request', async () => {
  const page = loadPage();
  page.routes['/api/files?id=abc'] = () => bad(500, 'boom');
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  assert.match(page.get('#chatBody').html, /Files unavailable/);
  page.routes['/api/files?id=abc'] = () => ok(tree('src/a.js', 'src/b.js'));
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'chat' } })");
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } })");
  await page.tick();
  const reads = page.fetches.length;
  page.run("ACTIONS['files-dir']({ dataset: { path: 'src', open: 'true' } })");
  await page.tick();
  assert.equal(page.fetches.length, reads, 'no request to fold');
  assert.match(page.get('#chatBody').html, /data-path="src"[^>]*aria-expanded="false"/);
});

test('y6: the page only reads: the new tab never sends a POST, and index.html needs no new element', async () => {
  const page = loadPage();
  page.routes['/api/files?id=abc'] = () => ok(tree('a.txt'));
  page.routes['/api/file?id=abc'] = () => ok(file({ path: 'a.txt' }));
  open(page);
  page.run("ACTIONS['chat-tab']({ dataset: { tab: 'files' } }); ACTIONS['files-open']({ dataset: { path: 'a.txt' } })");
  await page.tick();
  const mine = page.fetches.map((u, i) => [u, page.methods[i]]).filter(([u]) => u.startsWith('/api/file'));
  assert.ok(mine.length >= 2 && mine.every(([, m]) => m === 'GET'), 'the Files tab only reads');
  assert.match(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8'), /api\(`\/api\/files\?id=/);
});
