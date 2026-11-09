'use strict';
// RP130 (S20, S21): the explorer of files lives in the right column (a Files tab between Changes and the rest) and NEVER in the centre; the centre is the place of action (the chat, Notes
// and ONE viewer tab, with its own close button, that holds the file or the diff the person opened). A changed file picked in Changes shows its diff, as before; a file picked in Files shows
// its content, the same viewer the Files tab of the chat always had; opening one replaces the other. Notes stay in the centre as a tab, untouched. Under 1100 px there is no column, so the chat
// keeps its Files tab as before. It reads what exists (GET /api/files, GET /api/file): no new route, nothing is written. How it LOOKS is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const FILES = [
  { path: 'docs/ROADMAP.md', status: 'M', added: 3, deleted: 3 },
  { path: 'odd/tasks/chat-alcance.md', status: 'M', added: 1, deleted: 0 },
  { path: 'public/resumen.js', status: 'M', added: 43, deleted: 1 },
  { path: 'public/style.css', status: 'M', added: 7, deleted: 1 },
  { path: 'test/rp128.test.js', status: '?', untracked: true, added: 109, deleted: 0 },
  { path: 'README.md', status: 'M', added: 1, deleted: 1 },
];
const ROW = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...over });
const RP = (rows, extra = {}) => ({ available: true, rows, derived: {}, next: null, ...extra });
const MANY = RP([ROW('A1', 'Completada'), ROW('A2', 'Completada'), ROW('A3', 'Completada'), ROW('B1', 'En curso'), ROW('C1', 'Pendiente'), ROW('C2', 'Pendiente'), ROW('D1', 'Bloqueada', { notas: 'Waiting for the person' }), ROW('E1', 'Pendiente', { dependsOn: ['B1'] })],
  { next: ROW('C1', 'Pendiente'), derived: { A1: { state: 'En revisión', pr: 7 }, A2: { state: 'Lista', branch: 'feat/a2' } } });

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
  const fetches = [];
  const routes = {};
  const docL = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener(t, fn) { (docL[t] ||= []).push(fn); }, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET' }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  const key = (k, target) => { const e = { type: 'keydown', key: k, target, prevented: false, preventDefault() { e.prevented = true; } }; for (const fn of docL.keydown || []) fn(e); return e; };
  return { get, flush, tick, fetches, routes, doc, key, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
function boot(width = 1400) {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  S.local.abc = { files: FILES };
  S.local.xyz = { files: [{ path: 'only.txt', status: 'M', added: 1, deleted: 0 }] };
  const layout = page.get('#sumLayout');
  layout.clientWidth = width;
  layout.getBoundingClientRect = () => ({ left: 0, right: width, width });
  page.get('#split').offsetWidth = 10;
  page.get('#split2').offsetWidth = 10;
  page.routes['/api/roadmap?id=abc'] = () => Promise.resolve(ok(MANY));
  page.routes['/api/roadmap?id=xyz'] = () => Promise.resolve(ok(RP([ROW('X1', 'En curso')])));
  return page;
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const act = (page, name, dataset) => page.run(`ACTIONS['${name}']({ dataset: ${JSON.stringify(dataset)} })`);
const col = (page) => page.get('#colBody').html;
const selected = (h) => (/id="coltab-(\w+)"[^>]*aria-selected="true"/.exec(h) || [])[1];

// ---------- the page ----------
const TREE = { files: [{ path: 'README.md' }, { path: 'docs/a.md' }, { path: 'public/app.js' }, { path: 'public/<b>x.js' }] };
const FILE = (p, text = 'one\ntwo\nthree\n') => ({ path: p, text, size: text.length, changed: [[2, 1]] });
function boot130(width = 1400) {
  const page = boot(width);
  page.run("S.local.abc = { files: [{ path: 'public/app.js', status: 'M', added: 1, deleted: 0 }] }");
  page.routes['/api/files?id=abc'] = () => Promise.resolve(ok(TREE));
  page.routes['/api/file?id=abc&path=public%2Fapp.js'] = () => Promise.resolve(ok(FILE('public/app.js')));
  page.routes['/api/file?id=abc&path=README.md'] = () => Promise.resolve(ok(FILE('README.md', 'readme body\n')));
  page.routes['/api/file?id=abc&path=public%2F%3Cb%3Ex.js'] = () => Promise.resolve(ok(FILE('public/<b>x.js', '<img src=x onerror=alert(1)>\n')));
  return page;
}
const head = (page) => page.get('#chatHead').html;
const body = (page) => page.get('#chatBody').html;
const chatTab = (page) => page.run('S.chat.tab');
const reads = (page, prefix) => page.fetches.filter((f) => f.url.startsWith(prefix));

test('f1: the column has a Files tab between Changes and the rest, with its own icon, and the order is Changes, Files, Status, Tasks', () => {
  const g = { id: 'abc', branch: 'feat/x', ahead: 0, pr: null, merge: { enabled: false, title: 'x' } };
  const tabs = (h) => [...h.matchAll(/id="coltab-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs(R.columnView({ name: 'demo', files: FILES })), ['changes', 'files', 'tasks']);
  assert.deepEqual(tabs(R.columnView({ name: 'demo', files: FILES, git: g })), ['changes', 'files', 'status', 'tasks']);
  assert.deepEqual(R.COLUMN_TABS, ['changes', 'files', 'status', 'tasks']);
  const h = R.columnView({ name: 'demo', files: FILES, tab: 'files', tree: TREE });
  assert.match(h, /id="coltab-files"[^>]*aria-selected="true"[^>]*aria-label="Files" title="Files"><svg/);
  assert.match(h, /id="coltab-changes"[^>]*aria-selected="false"/);
  assert.match(h, /aria-labelledby="coltab-files"/);
});

test('f2: the Files pane is the tree of the repo: changed files marked, the selected one on, folders fold, nothing of the file itself, and names are escaped', () => {
  const h = R.columnView({ name: 'demo', files: FILES, tab: 'files', tree: TREE, changed: { 'public/app.js': 'M' }, fselected: 'public/app.js', fopen: {} });
  assert.match(h, /<div class="ft-tree" role="group" aria-label="Repository files">/);
  assert.match(h, /data-act="files-open" data-path="public\/app\.js" aria-pressed="true"/);
  assert.match(h, /class="ft-row ft-file ft-chg ft-on"[^>]*data-path="public\/app\.js"/, 'a changed and selected file');
  assert.match(h, /data-act="files-dir" data-path="public" data-open="true"/, 'a folder with a changed file is open by default');
  assert.match(h, /data-act="files-dir" data-path="docs" data-open="false"/);
  assert.doesNotMatch(h, /<b>x/, 'a name is never taken as markup');
  assert.match(h, /&lt;b&gt;x\.js/);
  assert.doesNotMatch(h, /cv-file|cv-code|Pick a file/, 'the file is read in the centre, never inside the column');
  const folded = R.columnView({ name: 'demo', tab: 'files', tree: TREE, fopen: { public: false } });
  assert.doesNotMatch(folded, /data-path="public\/app\.js"/, 'a folded folder hides its files');
});

test('f3: the Files pane says what is happening and never reads a failed or missing read as an empty repo', () => {
  assert.match(R.columnView({ name: 'x', tab: 'files' }), /Loading files…/);
  assert.match(R.columnView({ name: 'x', tab: 'files', filesFailed: true }), /Files unavailable/);
  assert.match(R.columnView({ name: 'x', tab: 'files', tree: { files: [] } }), /No files/);
  for (const bad of [null, 5, 'x', [], { files: 'no' }, { files: [null, 3, {}] }]) assert.doesNotThrow(() => R.columnView({ name: 'x', tab: 'files', tree: bad, changed: bad, fopen: bad }), JSON.stringify(bad));
});

test('f4: the file viewer of the centre is the one the Files tab always had: numbered lines, the changed ones marked, and every state spoken', () => {
  assert.equal(typeof R.fileView, 'function');
  const h = R.fileView(FILE('public/app.js'), { selected: 'public/app.js' });
  assert.match(h, /<section class="cv-file"><h3 class="cv-title" title="public\/app\.js">public\/app\.js<\/h3>/);
  assert.equal((h.match(/class="cv-l/g) || []).length, 3);
  assert.match(h, /<div class="cv-l e"><span class="cv-n">2<\/span>/, 'line 2 is a changed line');
  assert.match(R.fileView(null, { selected: 'a', fileLoading: true }), /Loading file…/);
  assert.match(R.fileView(null, { selected: 'a', fileFailed: 'Gone' }), /Gone/);
  assert.match(R.fileView({ path: 'a', binary: true }, { selected: 'a' }), /Binary file/);
  assert.doesNotMatch(R.fileView(FILE('a', '<script>1</script>\n'), { selected: 'a' }), /<script>/);
  assert.doesNotThrow(() => R.fileView(5, 5));
});

test('f5: the narrow chat keeps its Files tab exactly as before (tree and file together)', () => {
  const h = R.filesView(TREE, { selected: 'public/app.js', open: {}, changed: {} }, FILE('public/app.js'));
  assert.match(h, /ft-tree/);
  assert.match(h, /cv-file/);
});

test('f6: the header: with the column in the chat has no Files tab; without it, it keeps it; ONE viewer tab names the open file with its own close button, and is a diff or a file', () => {
  const tabsOf = (h) => [...h.matchAll(/role="tab" class="ch-tab" data-act="chat-tab" data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabsOf(R.chatHead({ tab: 'chat' }, { name: 'd', column: true })), ['chat', 'notes']);
  assert.deepEqual(tabsOf(R.chatHead({ tab: 'chat' }, { name: 'd', column: false })), ['chat', 'tasks', 'changes', 'files', 'notes']);
  const f = R.chatHead({ tab: 'file', ffile: 'public/app.js' }, { name: 'd', column: true });
  assert.deepEqual(tabsOf(f), ['chat', 'notes', 'file']);
  assert.match(f, /data-tab="file" title="public\/app\.js" aria-selected="true">app\.js<\/button><button type="button" class="ch-dclose" data-act="diff-close" aria-label="Close the file public\/app\.js"/);
  const d = R.chatHead({ tab: 'diff', dfile: 'public/app.js' }, { name: 'd', column: true });
  assert.match(d, /data-tab="diff"[^>]*aria-selected="true">app\.js/);
  assert.match(d, /aria-label="Close the diff of public\/app\.js"/, 'the diff tab is as it was');
  const both = R.chatHead({ tab: 'file', dfile: 'a.js', ffile: 'b.js' }, { name: 'd', column: true });
  assert.equal((both.match(/class="ch-dtab"/g) || []).length, 1, 'never two viewer tabs');
  assert.match(both, /data-tab="file"/);
  assert.match(R.chatHead({ tab: 'file', ffile: 'a.js' }, { name: 'd', column: true }), /aria-selected="true">a\.js/);
  assert.doesNotMatch(R.chatHead({ tab: 'file', ffile: '<img src=x>' }, { name: 'd', column: true }), /<img/);
});

test('g1: the Files tab of the column reads the tree when it is opened (once per switch), and paints it', async () => {
  const page = boot130();
  open(page, 'abc');
  await page.tick();
  assert.equal(reads(page, '/api/files').length, 0, 'a repo opens on Changes and reads no tree');
  act(page, 'col-tab', { tab: 'files' });
  await page.tick();
  assert.equal(selected(col(page)), 'files');
  assert.equal(reads(page, '/api/files').length, 1);
  assert.match(col(page), /data-act="files-open" data-path="public\/app\.js"/);
  assert.match(col(page), /ft-chg/, 'the changed file is marked from the board facts');
});

test('g2: a file of the column opens in the centre as the viewer tab with the file; the tree stays in the column with the file selected; the composer goes away', async () => {
  const page = boot130();
  open(page, 'abc');
  act(page, 'col-tab', { tab: 'files' });
  await page.tick();
  act(page, 'files-open', { path: 'public/app.js' });
  await page.tick();
  assert.equal(chatTab(page), 'file');
  assert.match(head(page), /data-tab="file" title="public\/app\.js" aria-selected="true">app\.js/);
  assert.match(body(page), /<section class="cv-file">/);
  assert.match(body(page), /<span class="cv-t">two<\/span>/);
  assert.equal(selected(col(page)), 'files', 'the column does not move');
  assert.match(col(page), /ft-on"[^>]*data-path="public\/app\.js"/);
  assert.doesNotMatch(col(page), /cv-file/);
  assert.equal(page.get('#composer').hidden, true);
  assert.equal(reads(page, '/api/file?').length, 1);
});

test('g3: the viewer tab is ONE: a file replaces the one before, a diff replaces a file and the other way round; the close button closes it and goes back to the chat', async () => {
  const page = boot130();
  open(page, 'abc');
  act(page, 'col-tab', { tab: 'files' });
  await page.tick();
  act(page, 'files-open', { path: 'public/app.js' });
  await page.tick();
  act(page, 'files-open', { path: 'README.md' });
  await page.tick();
  assert.equal((head(page).match(/class="ch-dtab"/g) || []).length, 1);
  assert.match(head(page), /title="README\.md"/);
  assert.match(body(page), /readme body/);
  act(page, 'changes-file', { path: 'public/app.js' });
  await page.tick();
  assert.equal(chatTab(page), 'diff');
  assert.equal(page.run('S.chat.ffile'), '', 'the diff took the place of the file');
  assert.match(head(page), /Close the diff of public\/app\.js/);
  act(page, 'files-open', { path: 'README.md' });
  await page.tick();
  assert.equal(chatTab(page), 'file');
  assert.equal(page.run('S.chat.dfile'), '', 'the file took the place of the diff');
  act(page, 'diff-close', {});
  await page.tick();
  assert.equal(chatTab(page), 'chat');
  assert.equal(page.run('S.chat.ffile'), '');
  assert.doesNotMatch(head(page), /ch-dtab/);
});

test('g4: with the column in a Files tab asked of the chat reads as the chat (the explorer is never in the centre); a viewer tab survives a switch to the chat and back', async () => {
  const page = boot130();
  open(page, 'abc');
  await page.tick();
  page.run("setChatTab('files')");
  page.flush();
  assert.equal(chatTab(page), 'chat');
  act(page, 'files-open', { path: 'README.md' });
  await page.tick();
  page.run("setChatTab('chat')");
  page.flush();
  assert.equal(chatTab(page), 'chat');
  page.run("setChatTab('file')");
  page.flush();
  assert.equal(chatTab(page), 'file');
  act(page, 'diff-close', {});
  page.run("setChatTab('file')");
  page.flush();
  assert.equal(chatTab(page), 'chat', 'a file tab with no file open reads as the chat');
});

test('g5: under 1100 px nothing changes: the Files tab stays in the chat and opening a file there reads it in the same tab, with no viewer tab', async () => {
  const page = boot130(900);
  open(page, 'abc');
  await page.tick();
  assert.doesNotMatch(col(page), /col-tabs/);
  assert.match(head(page), /data-tab="files"/);
  page.run("setChatTab('files')");
  await page.tick();
  assert.equal(chatTab(page), 'files');
  assert.match(body(page), /data-act="files-open" data-path="README\.md"/);
  act(page, 'files-open', { path: 'README.md' });
  await page.tick();
  assert.equal(chatTab(page), 'files');
  assert.doesNotMatch(head(page), /ch-dtab/);
  assert.match(body(page), /readme body/);
});

test('g6: abuse: an empty or missing path opens nothing and reads nothing; a path is sent encoded, and a file or a name with markup is never painted as markup', async () => {
  const page = boot130();
  open(page, 'abc');
  act(page, 'col-tab', { tab: 'files' });
  await page.tick();
  const writes = () => page.fetches.filter((f) => f.method !== 'GET').map((f) => f.url);
  const before = writes();
  for (const p of ['', undefined]) { act(page, 'files-open', p === undefined ? {} : { path: p }); page.flush(); }
  assert.equal(reads(page, '/api/file?').length, 0);
  assert.ok(!chatTab(page) || chatTab(page) === 'chat', 'no viewer tab was opened');
  assert.equal(page.run("S.chat.ffile || ''"), '');
  act(page, 'files-open', { path: 'public/<b>x.js' });
  await page.tick();
  assert.deepEqual(reads(page, '/api/file?').map((f) => f.url), ['/api/file?id=abc&path=public%2F%3Cb%3Ex.js']);
  assert.doesNotMatch(body(page), /<img/);
  assert.match(body(page), /&lt;img/, 'the text is there, escaped (the highlighter may split it into spans)');
  assert.doesNotMatch(body(page), /<img/);
  assert.doesNotMatch(head(page), /<b>x/);
  assert.deepEqual(writes(), before, 'opening files writes nothing');
});

test('g7: a file that cannot be read keeps its tab and says why; another repo opens clean (no file, Changes tab)', async () => {
  const page = boot130();
  page.routes['/api/file?id=abc&path=README.md'] = () => Promise.reject(new Error('File unavailable'));
  open(page, 'abc');
  act(page, 'col-tab', { tab: 'files' });
  await page.tick();
  act(page, 'files-open', { path: 'README.md' });
  await page.tick();
  assert.equal(chatTab(page), 'file');
  assert.match(body(page), /File unavailable/);
  open(page, 'xyz');
  await page.tick();
  assert.equal(page.run('S.chat.ffile || ""'), '');
  assert.equal(selected(col(page)), 'changes');
  assert.doesNotMatch(head(page), /ch-dtab/);
});
