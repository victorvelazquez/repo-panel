'use strict';
// RP90 (S6): ONE diff tab in the tab bar of the centre block, named after the file. Touching a file in the list of the Changes tab opens it there (RP92 will open it from the files card of
// the column); the tab is reused for every file, it stays in the bar when the person goes back to the chat (and shows the diff again when touched), it has a close button and it is
// gone when the person changes repo. It draws the SAME diff viewer of RP64 (R.changesView) for one file, from the /api/diff answer the page already reads: the server does not change. The
// read is not dropped when the chat polls meanwhile (it was identified by S.chat.seq, which loadChat bumps). No network, no timers, no real clock.
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
const DIFF = (name) => ['diff --git a/' + name + ' b/' + name, '--- a/' + name, '+++ b/' + name, '@@ -1,2 +1,2 @@', ' keep ' + name, '-old ' + name, '+new ' + name].join('\n');
const TWO = `${DIFF('src/one.txt')}\n${DIFF('src/two.txt')}`;
const tabsOf = (h) => [...h.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);

// ---------- pure: the tab bar ----------
test('t1: with a file open the bar gets ONE more tab, the last one, named after the file; it is selected only for the diff tab', () => {
  const h = R.chatHead({ id: 'abc', dfile: 'src/one.txt', tab: 'diff' }, { name: 'demo' });
  assert.deepEqual(tabsOf(h), ['chat', 'tasks', 'changes', 'files', 'notes', 'diff']);
  assert.match(h, /<button type="button" role="tab" class="ch-tab" data-act="chat-tab" data-tab="diff" title="src\/one\.txt" aria-selected="true">one.txt<\/button>/);
  assert.match(h, /data-tab="chat"[^>]*aria-selected="false"/);
  const back = R.chatHead({ id: 'abc', dfile: 'src/one.txt', tab: 'chat' }, { name: 'demo' });
  assert.match(back, /data-tab="diff"[^>]*aria-selected="false"/);
  assert.match(back, /data-tab="chat"[^>]*aria-selected="true"/);
});

test('t2: the diff tab has its own close button, labelled with the path, next to it (not inside the tab button)', () => {
  const h = R.chatHead({ id: 'abc', dfile: 'src/one.txt', tab: 'diff' }, { name: 'demo' });
  assert.match(h, /<span class="ch-dtab">[^]*data-tab="diff"[^]*<button type="button" class="ch-dclose" data-act="diff-close" aria-label="Close the diff of src\/one\.txt" title="Close the diff">✕<\/button><\/span>/);
  assert.equal((h.match(/<button/g) || []).length, 5 + 1 + 1 + 1 + 1, 'five standard tabs, the diff tab, its close button, the close of the chat and (RP134) the back arrow');
});

test('t3: without a file there is no diff tab, and a "diff" tab without a file reads as the chat', () => {
  const none = R.chatHead({ id: 'abc' }, { name: 'demo' });
  assert.doesNotMatch(none, /data-tab="diff"|ch-dtab|diff-close/);
  for (const c of [{ tab: 'diff' }, { tab: 'diff', dfile: '' }, { tab: 'diff', dfile: 5 }, { tab: 'diff', dfile: null }]) {
    const h = R.chatHead({ id: 'abc', ...c }, { name: 'demo' });
    assert.match(h, /data-tab="chat"[^>]*aria-selected="true"/, JSON.stringify(c));
    assert.doesNotMatch(h, /data-tab="diff"/, JSON.stringify(c));
  }
});

test('t4: the name is the last part of the path (either slash), the whole path is the tooltip, and both are escaped', () => {
  const h = R.chatHead({ id: 'abc', dfile: 'a\\b/c<d>"e.js', tab: 'diff' }, { name: 'demo' });
  assert.match(h, /title="a\\b\/c&lt;d&gt;&quot;e\.js"[^>]*>c&lt;d&gt;&quot;e\.js<\/button>/);
  assert.match(R.chatHead({ id: 'abc', dfile: 'README.md', tab: 'diff' }, { name: 'demo' }), /title="README\.md"[^>]*>README\.md<\/button>/);
});

test('t5: with the column in the diff tab is still there, after Chat and Notes (RP92: the Changes tab is the files card)', () => {
  const h = R.chatHead({ id: 'abc', dfile: 'x.js', tab: 'chat' }, { name: 'demo', column: true });
  assert.deepEqual(tabsOf(h), ['chat', 'notes', 'diff']);
});

// ---------- pure: the viewer for ONE file ----------
test('v1: in single-file mode only that file is drawn: no list of files and no "All files" button', () => {
  const h = R.changesView({ diff: TWO, truncated: false }, { selected: 'src/two.txt', only: true });
  assert.match(h, /new src\/two\.txt/);
  assert.doesNotMatch(h, /new src\/one\.txt/);
  assert.doesNotMatch(h, /cv-list|cv-item|cv-all|data-act="changes-file"/);
  assert.match(h, /<section class="cv-file"><h3 class="cv-title" title="src\/two\.txt">src\/two\.txt<\/h3>/);
});

test('v2: in single-file mode a file that is not in the diff (any more) says so instead of showing the others; the other states say what they said', () => {
  const gone = R.changesView({ diff: TWO, truncated: false }, { selected: 'src/gone.txt', only: true });
  assert.match(gone, /<div class="empty" role="status">src\/gone\.txt has no uncommitted changes<\/div>/);
  assert.doesNotMatch(gone, /new src/);
  assert.match(R.changesView(null, { selected: 'x', only: true }), /Loading changes…/);
  assert.match(R.changesView(null, { selected: 'x', only: true, failed: true }), /Changes unavailable/);
  assert.match(R.changesView({ diff: '', truncated: false }, { selected: 'x', only: true }), /No uncommitted changes/);
  assert.match(R.changesView({ diff: TWO, truncated: true }, { selected: 'src/one.txt', only: true }), /Diff truncated/);
  assert.match(R.changesView({ diff: TWO, truncated: false }, { selected: 'a<b>', only: true }), /a&lt;b&gt; has no uncommitted changes/);
});

test('v3: without the flag the viewer is exactly as RP64 left it (the list, the selection, "All files")', () => {
  const sel = R.changesView({ diff: TWO, truncated: false }, { selected: 'src/two.txt' });
  assert.match(sel, /cv-list/);
  assert.match(sel, /data-act="changes-file" data-path=""[^>]*>All files/);
  assert.doesNotMatch(sel, /new src\/one\.txt/);
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
  const intervals = [];
  const fetches = [];
  const routes = {};
  const tabEls = ['summary', 'work', 'conformity'].map((t) => element({ dataset: { tab: t } }));
  const get = (sel) => (els[sel] ||= (sel === 'meta[name=token]' ? element({ content: 'token' }) : element()));
  const doc = { hidden: false, querySelector: get, querySelectorAll: (s) => (String(s).includes('data-tab') ? tabEls : []), addEventListener() {}, createElement: () => element(), body: element(), activeElement: null };
  const ctx = vm.createContext({
    console, document: doc, location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, setTimeout: () => 0, clearTimeout: () => {}, AbortController, confirm: () => true,
    fetch: (url, opts = {}) => { fetches.push({ url, method: opts.method || 'GET' }); return routes[url] ? routes[url](url, opts) : new Promise(() => {}); },
  });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.RepoPanelView = V;
  ctx.RepoPanelResumen = R;
  vm.runInContext(appSource(), ctx);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tick = async (n = 8) => { for (let r = 0; r < 2; r++) { for (let i = 0; i < n; i++) await new Promise((x) => setImmediate(x)); flush(); } };
  return { get, flush, tick, fetches, routes, intervals, run: (c) => vm.runInContext(c, ctx) };
}
const ok = (body) => ({ ok: true, json: async () => body });
const card = (id, name) => ({ id, name, group: 'G', room: null, branch: 'main', progress: { total: 4, completada: 1, enRevision: 0, bloqueada: 0, pendiente: 3, enCurso: 0 }, session: { state: 'free' }, next: null, blocking: [], lastMovement: {}, action: null, needs: false, rank: 9 });
const DF = (id) => `/api/diff?id=${id}`;
const reads = (page, id) => page.fetches.filter((f) => f.url === DF(id)).length;
function boot() {
  const page = loadPage();
  const S = page.run('S');
  S.groups = [{ name: 'G', repos: [{ id: 'abc', name: 'demo', path: 'p' }, { id: 'xyz', name: 'other', path: 'q' }] }];
  S.summary = { rows: [card('abc', 'demo'), card('xyz', 'other')], generatedAt: 'x' };
  page.routes[DF('abc')] = () => Promise.resolve(ok({ diff: TWO, truncated: false }));
  return page;
}
const open = (page, id) => page.run(`ACTIONS['chat-open']({ dataset: { id: '${id}' } })`);
const tab = (page, t) => page.run(`ACTIONS['chat-tab']({ dataset: { tab: '${t}' } })`);
const pick = (page, p) => page.run(`ACTIONS['changes-file']({ dataset: { path: '${p}' } })`);
const body = (page) => page.get('#chatBody').html;
const head = (page) => page.get('#chatHead').html;
const cur = (page) => page.run('S.chat.tab || "chat"');
async function withChanges(page) {
  open(page, 'abc');
  tab(page, 'changes');
  await page.tick();
}

test('p1: touching a file in the Changes list opens it in the diff tab: only that file is drawn, the tab has its name and is selected', async () => {
  const page = boot();
  await withChanges(page);
  assert.match(body(page), /cv-list/, 'the Changes tab lists the files');
  pick(page, 'src/two.txt');
  await page.tick();
  assert.equal(cur(page), 'diff');
  assert.equal(page.run('S.chat.dfile'), 'src/two.txt');
  assert.match(body(page), /new src\/two\.txt/);
  assert.doesNotMatch(body(page), /new src\/one\.txt|cv-list/);
  assert.match(head(page), /data-tab="diff"[^>]*aria-selected="true"[^>]*>two.txt</);
});

test('p2: the tab is REUSED: another file replaces the first one in the same tab (one diff tab in the bar)', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/one.txt');
  await page.tick();
  pick(page, 'src/two.txt');
  await page.tick();
  assert.equal((head(page).match(/data-tab="diff"/g) || []).length, 1);
  assert.match(head(page), />two.txt</);
  assert.doesNotMatch(head(page), />one.txt</);
  assert.match(body(page), /new src\/two\.txt/);
});

test('p3: back to the chat the diff tab stays in the bar; touching it shows the diff again and reads /api/diff again (the files change)', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/one.txt');
  await page.tick();
  const before = reads(page, 'abc');
  tab(page, 'chat');
  page.flush();
  assert.equal(cur(page), 'chat');
  assert.match(head(page), /data-tab="diff"[^>]*aria-selected="false"[^>]*>one.txt</);
  assert.equal(page.get('#composer').hidden, false, 'the composer is back with the chat');
  tab(page, 'diff');
  await page.tick();
  assert.equal(cur(page), 'diff');
  assert.match(body(page), /new src\/one\.txt/);
  assert.equal(reads(page, 'abc'), before + 1, 'one read per switch to the tab');
  page.run('draw()');
  page.flush();
  assert.equal(reads(page, 'abc'), before + 1, 'a redraw never reads');
});

test('p4: the close button removes the tab; if it was the current one the chat comes back, and closing from the chat keeps the chat', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/one.txt');
  await page.tick();
  page.run("ACTIONS['diff-close']({})");
  page.flush();
  assert.equal(cur(page), 'chat');
  assert.equal(page.run('S.chat.dfile || ""'), '');
  assert.doesNotMatch(head(page), /data-tab="diff"|ch-dtab/);
  pick(page, 'src/two.txt');
  await page.tick();
  tab(page, 'files');
  page.flush();
  page.run("ACTIONS['diff-close']({})");
  page.flush();
  assert.equal(cur(page), 'files', 'closing the diff from another tab keeps that tab');
  assert.doesNotMatch(head(page), /data-tab="diff"/);
});

test('p5: on the diff tab the composer is hidden and the chat is not polled; a "diff" tab without a file is the chat', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/one.txt');
  await page.tick();
  assert.equal(page.get('#composer').hidden, true);
  const poll = page.intervals.find((i) => i.ms === 5000).fn;
  const chatReads = () => page.fetches.filter((f) => /^\/api\/chat\?/.test(f.url)).length;
  const was = chatReads();
  poll();
  assert.equal(chatReads(), was, 'no chat read while the diff tab is shown');
  page.run("ACTIONS['diff-close']({})");
  tab(page, 'diff');
  page.flush();
  assert.equal(cur(page), 'chat', 'no file: the Chat tab');
});

test('p6: changing repo drops the diff tab and the chat of the new repo starts clean', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/one.txt');
  await page.tick();
  open(page, 'xyz');
  page.flush();
  assert.equal(page.run('S.chat.id'), 'xyz');
  assert.equal(page.run('S.chat.dfile || ""'), '');
  assert.equal(cur(page), 'chat');
  assert.doesNotMatch(head(page), /data-tab="diff"/);
});

test('p7: the answer of the diff is applied even if the chat polled meanwhile (it bumps S.chat.seq); a late answer of the repo left never paints the one shown', async () => {
  const page = boot();
  let answer;
  page.routes[DF('abc')] = () => new Promise((resolve) => { answer = resolve; });
  open(page, 'abc');
  tab(page, 'changes');
  page.flush();
  page.run('S.chat.seq += 3');
  answer(ok({ diff: TWO, truncated: false }));
  await page.tick();
  assert.match(body(page), /cv-list/, 'the answer of THIS opening was applied');
  const late = boot();
  let lateAnswer;
  late.routes[DF('abc')] = () => new Promise((resolve) => { lateAnswer = resolve; });
  open(late, 'abc');
  tab(late, 'changes');
  late.flush();
  open(late, 'xyz');
  late.flush();
  lateAnswer(ok({ diff: TWO, truncated: false }));
  await late.tick();
  assert.doesNotMatch(body(late), /src\/one\.txt/, 'the repo shown is not painted with the diff of the one left');
});

test('p8: a file that is not changed any more says so in the tab (it does not show the other files)', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/gone.txt');
  await page.tick();
  assert.match(body(page), /src\/gone\.txt has no uncommitted changes/);
  assert.doesNotMatch(body(page), /new src/);
});

test('p9: the Changes tab keeps listing ALL the files after a file was opened in the diff tab (it no longer filters in place)', async () => {
  const page = boot();
  await withChanges(page);
  pick(page, 'src/two.txt');
  await page.tick();
  tab(page, 'changes');
  await page.tick();
  assert.match(body(page), /cv-list/);
  assert.match(body(page), /new src\/one\.txt/);
  assert.match(body(page), /new src\/two\.txt/);
});

test('p10: nothing is written by opening or closing the diff tab (no POST)', async () => {
  const page = boot();
  await withChanges(page);
  const posts = () => page.fetches.filter((f) => f.method !== 'GET').map((f) => f.url);
  const before = posts(); // the page makes some POSTs of its own at start (the queue); only what opening and closing the tab adds counts
  pick(page, 'src/one.txt');
  await page.tick();
  page.run("ACTIONS['diff-close']({})");
  page.flush();
  assert.deepEqual(posts(), before);
  for (const act of ['changes-file', 'diff-close', 'chat-tab']) assert.equal(page.run(`typeof ACTIONS['${act}']`), 'function', act);
});

// ---------- the styles ----------
test('s1: the diff tab clips a long name with an ellipsis, and its close button is a small control next to it', () => {
  assert.match(css, /\.ch-dtab\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.ch-dtab \.ch-tab\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.ch-dtab\s*\{[^}]*max-width:/);
  assert.match(css, /\.ch-dclose\s*\{/);
  assert.match(css, /\.ch-dclose:focus-visible/);
});
