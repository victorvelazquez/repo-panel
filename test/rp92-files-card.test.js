'use strict';
// RP92 (S6): the FILES card of the right column (RP89, RP91): the files with uncommitted changes of the open repo, from the facts the board already keeps fresh (`S.local[id].files`: status,
// path, added and deleted lines), so it reads nothing new and is never stale. Touching a file opens it in the ONE diff tab of the centre (RP90). With the column in, the Changes tab of the chat
// is gone (the card replaces it); where there is no column (under 1100 px) the tab stays, as the Tasks tab does. The Files tab (RP65) is untouched. No network, no timers, no real clock.
const test = require('node:test');
const { appSource } = require('./pagesrc.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../public/resumen.js');
const V = require('../public/view.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const FILES = [
  { path: 'src/app.js', status: 'M', untracked: false, conflict: false, added: 12, deleted: 3, binary: false },
  { path: 'docs\\notes.md', status: 'A', untracked: false, conflict: false, added: 4, deleted: 0, binary: false },
  { path: 'new.txt', status: '?', untracked: true, conflict: false, added: 2, deleted: 0, binary: false },
  { path: 'img/logo.png', status: 'M', untracked: false, conflict: false, added: 0, deleted: 0, binary: true },
];
const items = (h) => [...h.matchAll(/<button type="button" class="cf-item[^"]*"[^>]*>/g)].map((m) => m[0]);

// ---------- pure ----------
test('f1 (RP128: tree): the Changes tab counts the files and the panel has the total on top and one button per file (name, +added -deleted, status letter); the whole path is its tooltip and the file to open', () => {
  const h = R.columnView({ name: 'demo', files: FILES });
  assert.match(h, /<span class="lb">Changes<\/span><span class="n">4<\/span>/);
  assert.match(h, /<div class="col-sum"><b>4 files<\/b> <span class="a">\+18<\/span> <span class="d">−3<\/span><\/div>/);
  assert.equal(items(h).length, 4);
  assert.match(h, /<button type="button" class="cf-item cf-d1" data-act="changes-file" data-path="src\/app\.js" aria-pressed="false" title="src\/app\.js">.*<span class="cf-name">app\.js<\/span><span class="cf-n"><i class="a">\+12<\/i> <i class="d">−3<\/i><\/span><span class="cf-st st-M">M<\/span><\/button>/);
  assert.match(h, /data-path="docs\\notes\.md"[^>]*>.*<span class="cf-name">notes\.md<\/span>.*<span class="cf-st st-A">A<\/span>/, 'either slash: only the last part is the name');
  assert.match(h, /data-path="new\.txt"[^>]*>.*<span class="cf-st st-\?">\?<\/span>/);
  assert.match(h, /data-path="img\/logo\.png"[^>]*>.*<span class="cf-n">bin<\/span>/, 'a binary file has no line counts');
  assert.doesNotMatch(h, /col-soon|will appear here/);
});

test('f2 (RP128: tree): the file open in the diff tab is marked in the tree (aria-pressed and cf-on); the others are not', () => {
  const h = R.columnView({ name: 'demo', files: FILES, selected: 'new.txt' });
  assert.equal((h.match(/cf-on/g) || []).length, 1);
  assert.match(h, /class="cf-item cf-on cf-d0" data-act="changes-file" data-path="new\.txt" aria-pressed="true"/);
  assert.equal((h.match(/aria-pressed="false"/g) || []).length, 3);
  assert.equal(items(R.columnView({ name: 'demo', files: FILES, selected: 'nope' })).filter((x) => /cf-on/.test(x)).length, 0);
});

test('f3 (RP128: tree): without a list the panel says why: loading, unavailable, or no changes; it never shows the old notice and it is total for odd input', () => {
  assert.match(R.columnView({ name: 'x' }), /<p class="rs-sub" role="status">Loading files…<\/p><\/div>$/);
  assert.match(R.columnView({ name: 'x', failed: true }), /Files unavailable/);
  assert.match(R.columnView({ name: 'x', files: [] }), /<span class="n">0<\/span>[\s\S]*<p class="rs-sub" role="status">No uncommitted changes<\/p>/);
  for (const arg of [undefined, null, {}, { files: 'x' }, { files: [null, 3, {}] }, { files: [{ path: 5 }] }]) {
    const h = R.columnView(arg);
    assert.match(h, /^<div class="col-tabs"/, JSON.stringify(arg));
    assert.doesNotMatch(h, /undefined|null|col-soon/, JSON.stringify(arg));
  }
  assert.equal(items(R.columnView({ files: [null, 3, {}, { path: '' }] })).length, 0, 'entries without a path are skipped');
});

test('f4 (RP128: tree): names, paths and status are escaped; a long list is cut at 200 with the rest counted', () => {
  const h = R.columnView({ name: 'a<b>"c', files: [{ path: 'x/<i>.js', status: '<', added: 1, deleted: 1 }] });
  assert.doesNotMatch(h, /<i>\.js|a<b>/);
  assert.match(h, /aria-label="Files with changes of a&lt;b&gt;&quot;c"/);
  assert.match(h, /data-path="x\/&lt;i&gt;\.js"/);
  const many = Array.from({ length: 205 }, (_, i) => ({ path: `f${i}.js`, status: 'M', added: 1, deleted: 0 }));
  const m = R.columnView({ name: 'x', files: many });
  assert.equal(items(m).length, 200);
  assert.match(m, /<span class="n">205<\/span>/);
  assert.match(m, /<p class="rs-sub" role="status">and 5 more<\/p>/);
});

test('f5: with the column in the head has no Changes tab either (Chat, Notes; Tasks is its own card) and a Changes tab left over reads as the chat; without the column nothing changes', () => {
  const tabs = (c, x) => [...R.chatHead(c, x).matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs({ id: 'abc' }, { name: 'd', column: true }), ['chat', 'notes']);
  const h = R.chatHead({ id: 'abc', tab: 'changes' }, { name: 'd', column: true });
  assert.match(h, /data-tab="chat"[^>]*aria-selected="true"/);
  assert.doesNotMatch(h, /aria-selected="true"[^>]*>(Changes|Files)/);
  assert.deepEqual(tabs({ id: 'abc' }, { name: 'd' }), ['chat', 'tasks', 'changes', 'files', 'notes'], 'no column: the four tabs as before');
  assert.match(R.chatHead({ id: 'abc', tab: 'changes' }, { name: 'd' }), /data-tab="changes"[^>]*aria-selected="true"/);
  assert.deepEqual(tabs({ id: 'abc', tab: 'diff', dfile: 'a/b.js' }, { name: 'd', column: true }), ['chat', 'notes', 'diff']);
});

test('f6 (RP128: tree): the styles: the panel fits a narrow column, a long name is clipped and the counts keep their place', () => {
  assert.match(css, /\.col-pane\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.cf-item, \.cf-dir\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.cf-name\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.cf-n\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.cf-item:focus-visible/);
  assert.match(css, /\.cf-item\.cf-on[^{]*\{/);
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
function loadPage() {
  const els = {};
  const frames = [];
  const fetches = [];
  const routes = {};
  const winL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET' }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (winL[t] ||= []).push(fn); };
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  // Two rounds: the first draw runs at the first flush and starts the read of the tasks; the second lets the answer land and be painted.
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, fetches, routes, winL, doc, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const bad = () => ({ ok: false, status: 500, statusText: 'Failed', json: async () => ({ error: 'nope' }) });
const ROW = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...over });
const ROADMAP = { available: true, rows: [ROW('A1', 'Completada'), ROW('B1', 'En curso'), ROW('C1', 'Pendiente')], derived: {}, next: ROW('C1', 'Pendiente') };
const RM = (id) => `/api/roadmap?id=${id}`;
const reads = (page, id) => page.fetches.filter((f) => f.url === RM(id)).length;
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
function boot(width = 1400) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  return page;
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const tasksOpen = (page, id) => page.run(`ACTIONS['tasks-open']({ dataset: { id: '${id}' } })`);
const col = (page) => page.get('#colBody').html;
const head = (page) => page.get('#chatHead').html;

const L = (files, extra = {}) => ({ files, ...extra });
const diffReads = (page) => page.fetches.filter((f) => f.url.startsWith('/api/diff')).length;
const posts = (page) => page.fetches.filter((f) => f.method !== 'GET').map((f) => f.url);
const tabsOf = (page) => [...head(page).matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
const DIFF = `diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,1 +1,1 @@\n-old\n+new app\n`;

test('g1: with the column in, opening a repo draws the card from the board facts: no read of the diff, no Changes tab', async () => {
  const page = boot();
  page.run('S').local.abc = L(FILES);
  open(page, 'abc');
  await page.tick();
  assert.match(col(page), /class="cf-tree"/);
  assert.equal(items(col(page)).length, 4);
  assert.equal(diffReads(page), 0, 'the card reads nothing');
  assert.deepEqual(tabsOf(page), ['chat', 'notes']);
});

test('g2: touching a file of the card opens it in the diff tab (the diff is read) and marks it in the card; touching another reuses the tab', async () => {
  const page = boot();
  page.run('S').local.abc = L(FILES);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: DIFF, truncated: false }));
  open(page, 'abc');
  await page.tick();
  page.run("ACTIONS['changes-file']({ dataset: { path: 'src/app.js' } })");
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'diff');
  assert.equal(page.run('S.chat.dfile'), 'src/app.js');
  assert.equal(diffReads(page), 1);
  assert.match(page.get('#chatBody').html.replace(/<[^>]+>/g, ''), /new app/); // RP66b: the .js rows are colored, the text is the same
  assert.match(col(page), /cf-on cf-d1" data-act="changes-file" data-path="src\/app\.js" aria-pressed="true"/);
  assert.deepEqual(tabsOf(page), ['chat', 'notes', 'diff']);
  page.run("ACTIONS['changes-file']({ dataset: { path: 'new.txt' } })");
  await page.tick();
  assert.deepEqual(tabsOf(page), ['chat', 'notes', 'diff'], 'one diff tab');
  assert.match(col(page), /cf-on cf-d0" data-act="changes-file" data-path="new\.txt"/);
  assert.equal((col(page).match(/cf-on/g) || []).length, 1);
});

test('g3: when the board brings other facts the card follows them, with no read; closing the diff tab unmarks the file', async () => {
  const page = boot();
  const S = page.run('S');
  S.local.abc = L(FILES);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: DIFF, truncated: false }));
  open(page, 'abc');
  await page.tick();
  S.local.abc = L([{ path: 'only.js', status: 'M', added: 1, deleted: 1 }]);
  page.run('draw()');
  page.flush();
  assert.equal(items(col(page)).length, 1);
  assert.match(col(page), /only\.js/);
  assert.equal(diffReads(page), 0);
  page.run("ACTIONS['changes-file']({ dataset: { path: 'only.js' } })");
  await page.tick();
  page.run("ACTIONS['diff-close']({})");
  page.flush();
  assert.doesNotMatch(col(page), /cf-on/);
});

test('g4: without facts the card says loading; with a failed read of the repo it says unavailable; a repo with no changes says so', async () => {
  const page = boot();
  const S = page.run('S');
  open(page, 'abc');
  await page.tick();
  assert.match(col(page), /Loading files…/);
  S.local.abc = { error: 'git failed' };
  page.run('draw()');
  page.flush();
  assert.match(col(page), /Files unavailable/);
  S.local.abc = L(FILES, { error: 'git failed' });
  page.run('draw()');
  page.flush();
  assert.match(col(page), /Files unavailable/, 'a failed answer wins over any files it carries');
  assert.equal(items(col(page)).length, 0);
  S.local.abc = L([]);
  page.run('draw()');
  page.flush();
  assert.match(col(page), /No uncommitted changes/);
});

test('g5: the card and the diff tab follow the repo: another repo shows its own files and no diff tab', async () => {
  const page = boot();
  const S = page.run('S');
  S.local.abc = L(FILES);
  S.local.xyz = L([{ path: 'z.js', status: 'M', added: 1, deleted: 0 }]);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: DIFF, truncated: false }));
  open(page, 'abc');
  await page.tick();
  page.run("ACTIONS['changes-file']({ dataset: { path: 'src/app.js' } })");
  await page.tick();
  page.run("ACTIONS['chat-close']({})");
  open(page, 'xyz');
  await page.tick();
  assert.match(col(page), /z\.js/);
  assert.doesNotMatch(col(page), /app\.js/);
  assert.deepEqual(tabsOf(page), ['chat', 'notes']);
});

test('g6: the chip "N files" of a card (action diff) with the column in opens the repo on the chat, where the card is; it reads no diff', async () => {
  const page = boot();
  page.run('S').local.abc = L(FILES);
  page.run("ACTIONS['diff']({ dataset: { id: 'abc' } })");
  await page.tick();
  assert.equal(page.run('S.chat.id'), 'abc');
  assert.equal(page.run('S.chat.tab || "chat"'), 'chat');
  assert.match(col(page), /class="cf-tree"/);
  assert.equal(diffReads(page), 0);
});

test('g7: a chat left on the Changes tab when the layout grows to have the column shows the chat again (the card replaces the tab, as with Tasks) and the composer comes back; shrinking brings the tab back', async () => {
  const page = boot(900);
  page.run('S').local.abc = L(FILES);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: DIFF, truncated: false }));
  open(page, 'abc');
  await page.tick();
  tab(page, 'changes');
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'changes');
  assert.equal(page.get('#composer').hidden, true);
  page.get('#sumLayout').clientWidth = 1400;
  page.run('draw()');
  page.flush();
  assert.equal(page.get('#composer').hidden, false);
  assert.doesNotMatch(head(page), /data-tab="changes"/);
  assert.doesNotMatch(page.get('#chatBody').html, /cv-item/, 'the Changes viewer is not drawn');
  page.get('#sumLayout').clientWidth = 900;
  page.run('draw()');
  page.flush();
  assert.match(head(page), /data-tab="changes"[^>]*aria-selected="true"/, 'without the column the tab is back');
});

test('n1: under 1100 px (no column) nothing changes: the Changes tab is there and lists every file, and touching one opens the diff tab', async () => {
  const page = boot(900);
  page.run('S').local.abc = L(FILES);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: `${DIFF}diff --git a/two.js b/two.js\n--- a/two.js\n+++ b/two.js\n@@ -1,1 +1,1 @@\n-a\n+b two\n`, truncated: false }));
  open(page, 'abc');
  await page.tick();
  assert.deepEqual(tabsOf(page), ['chat', 'tasks', 'changes', 'files', 'notes']);
  tab(page, 'changes');
  await page.tick();
  assert.match(page.get('#chatBody').html, /class="cv-item/);
  assert.equal(diffReads(page), 1);
  page.run("ACTIONS['changes-file']({ dataset: { path: 'two.js' } })");
  await page.tick();
  assert.equal(page.run('S.chat.tab'), 'diff');
});

test('n2: nothing is written by drawing the card or touching its files (no POST)', async () => {
  const page = boot();
  page.run('S').local.abc = L(FILES);
  page.routes['/api/diff?id=abc'] = () => Promise.resolve(ok({ diff: DIFF, truncated: false }));
  open(page, 'abc');
  await page.tick();
  const before = posts(page);
  page.run("ACTIONS['changes-file']({ dataset: { path: 'src/app.js' } })");
  await page.tick();
  page.run("ACTIONS['diff-close']({})");
  page.flush();
  assert.deepEqual(posts(page), before);
});
