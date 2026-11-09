'use strict';
// RP128 (S20, S21): the right column of the Summary is TABS (design D of RP127): Changes and Tasks for now (Status comes with RP129, Files and Notes with RP130; a tab with nothing to show
// is never drawn). Only the open tab shows its name; the others are icons. Changes is a TREE by folders (a chain of single folders is one row, folders first, a count per folder, the status letter
// and +added -deleted per file, the total on top); Tasks is COMPACT (a segmented bar with counters, the rows that ask for an action, and Pending, Blocked and Completed folded) and keeps its
// filter box. Both read what the page already has: no new read, no new route, nothing is written. How it LOOKS (and the real clicks and keys) is for the person to try.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appSource } = require('./pagesrc.js');
const V = require('../public/view.js');
const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\r\n/g, '\n');

const FILES = [
  { path: 'docs/ROADMAP.md', status: 'M', added: 3, deleted: 3 },
  { path: 'odd/tasks/chat-alcance.md', status: 'M', added: 1, deleted: 0 },
  { path: 'public/resumen.js', status: 'M', added: 43, deleted: 1 },
  { path: 'public/style.css', status: 'M', added: 7, deleted: 1 },
  { path: 'test/rp128.test.js', status: '?', untracked: true, added: 109, deleted: 0 },
  { path: 'README.md', status: 'M', added: 1, deleted: 1 },
];
const dirs = (h) => [...h.matchAll(/<button type="button" class="cf-dir cf-d(\d)" data-act="col-folder" data-path="([^"]*)" aria-expanded="(true|false)">/g)].map((m) => ({ depth: Number(m[1]), path: m[2], open: m[3] === 'true' }));
const fileRows = (h) => [...h.matchAll(/<button type="button" class="cf-item( cf-on)? cf-d(\d)" data-act="changes-file" data-path="([^"]*)" aria-pressed="(true|false)"/g)].map((m) => ({ on: !!m[1], depth: Number(m[2]), path: m[3], pressed: m[4] === 'true' }));
const order = (h) => [...h.matchAll(/data-act="(?:col-folder|changes-file)" data-path="([^"]*)"/g)].map((m) => m[1]);

// ---------- the tabs ----------
test('t1: the column has a tab bar with Changes and Tasks, in that order, each with a name for assistive tools; Changes shows the count of files and Tasks no count', () => {
  const h = R.columnView({ name: 'demo', files: FILES });
  assert.match(h, /^<div class="col-tabs" role="tablist" aria-label="Column views">/);
  const tabs = [...h.matchAll(/<button type="button" role="tab" class="col-tab" id="coltab-(\w+)" data-act="col-tab" data-tab="(\w+)" aria-selected="(true|false)" aria-controls="colpane" aria-label="([^"]+)" title="([^"]+)">/g)];
  assert.deepEqual(tabs.map((m) => [m[1], m[2], m[3], m[4], m[5]]), [['changes', 'changes', 'true', 'Changes', 'Changes'], ['tasks', 'tasks', 'false', 'Tasks', 'Tasks']]);
  assert.match(h, /<span class="lb">Changes<\/span><span class="n">6<\/span><\/button>/);
  assert.match(h, /<span class="lb">Tasks<\/span><\/button>/, 'Tasks has no count');
  assert.equal((h.match(/role="tab"/g) || []).length, 2, 'no tab without content: Status, Files and Notes are not drawn yet');
});

test('t2: the tab asked for is the one open; an unknown one, or one that does not exist yet, reads as Changes; the panel is labelled by its tab', () => {
  for (const tab of [undefined, null, '', 'changes', 'files', 'notes', 'status', 'nope', 5, {}]) {
    const h = R.columnView({ name: 'demo', files: FILES, tab });
    assert.match(h, /id="coltab-changes"[^>]*aria-selected="true"/, String(tab));
    assert.match(h, /<div class="col-pane" id="colpane" role="tabpanel" aria-labelledby="coltab-changes">/);
  }
  const t = R.columnView({ name: 'demo', files: FILES, tab: 'tasks', tasksHtml: '<p class="mark">TASKS</p>' });
  assert.match(t, /id="coltab-tasks"[^>]*aria-selected="true"/);
  assert.match(t, /id="coltab-changes"[^>]*aria-selected="false"/);
  assert.match(t, /aria-labelledby="coltab-tasks"><p class="mark">TASKS<\/p><\/div>$/);
  assert.doesNotMatch(t, /cf-tree|col-sum/, 'the tree is not drawn on the Tasks tab');
});

test('t3: the Changes count is only there when the list is known; Tasks with nothing to show says so', () => {
  assert.doesNotMatch(R.columnView({ name: 'x' }), /<span class="n">/);
  assert.doesNotMatch(R.columnView({ name: 'x', failed: true }), /<span class="n">/);
  assert.match(R.columnView({ name: 'x', files: [] }), /<span class="n">0<\/span>/);
  assert.match(R.columnView({ name: 'x', tab: 'tasks' }), /<p class="rs-sub" role="status">No tasks to show<\/p>/);
});

// ---------- Changes: the tree ----------
test('c1: the panel has the total on top (files, +added, -deleted) and a tree: folders first, a chain of single folders is one row, then the files', () => {
  const h = R.columnView({ name: 'demo', files: FILES });
  assert.match(h, /<div class="col-sum"><b>6 files<\/b> <span class="a">\+164<\/span> <span class="d">−6<\/span><\/div>/);
  assert.match(h, /<div class="cf-tree" role="group" aria-label="Files with changes of demo">/);
  assert.deepEqual(dirs(h).map((d) => [d.depth, d.path, d.open]), [[0, 'docs', true], [0, 'odd/tasks', true], [0, 'public', true], [0, 'test', true]]);
  assert.deepEqual(order(h), ['docs', 'docs/ROADMAP.md', 'odd/tasks', 'odd/tasks/chat-alcance.md', 'public', 'public/resumen.js', 'public/style.css', 'test', 'test/rp128.test.js', 'README.md']);
  assert.deepEqual(fileRows(h).map((f) => [f.depth, f.path]), [[1, 'docs/ROADMAP.md'], [1, 'odd/tasks/chat-alcance.md'], [1, 'public/resumen.js'], [1, 'public/style.css'], [1, 'test/rp128.test.js'], [0, 'README.md']]);
  assert.match(h, /<span class="cf-name">odd\/tasks<\/span><span class="cf-n">1<\/span><\/button>/, 'the folder row says how many files are under it');
  assert.match(h, /<span class="cf-name">public<\/span><span class="cf-n">2<\/span>/);
  assert.equal(R.columnView({ name: 'x', files: [FILES[5]] }).match(/<b>([^<]*)<\/b>/)[1], '1 file', 'singular');
});

test('c2: a folder with a file of its own is not merged into its child, and a deeper chain below it is one row', () => {
  const h = R.columnView({ name: 'x', files: [{ path: 'a/b/c/x.js', status: 'M' }, { path: 'a/y.js', status: 'M' }, { path: 'a/b/z.js', status: 'M' }] });
  assert.deepEqual(dirs(h).map((d) => [d.depth, d.path]), [[0, 'a'], [1, 'a/b'], [2, 'a/b/c']]);
  const h2 = R.columnView({ name: 'x', files: [{ path: 'a/b/c/x.js', status: 'M' }, { path: 'a/y.js', status: 'M' }] });
  assert.deepEqual(dirs(h2).map((d) => [d.depth, d.path]), [[0, 'a'], [1, 'a/b/c']]);
  assert.match(h2, /data-path="a\/b\/c" aria-expanded="true"><span class="cf-ch" aria-hidden="true">▾<\/span>(?:<span class="cf-ic"[^>]*>.*?<\/span>)?<span class="cf-name">b\/c<\/span>/, 'the row shows the chain, the path is the whole one');
});

test('c3: a folded folder keeps its row and its count and hides what is under it; the others stay open', () => {
  const h = R.columnView({ name: 'demo', files: FILES, fold: { public: true } });
  assert.deepEqual(dirs(h).filter((d) => d.path === 'public').map((d) => d.open), [false]);
  assert.match(h, /data-path="public" aria-expanded="false"><span class="cf-ch" aria-hidden="true">▸<\/span>/);
  assert.match(h, /data-path="docs" aria-expanded="true"><span class="cf-ch" aria-hidden="true">▾<\/span>/);
  assert.deepEqual(fileRows(h).filter((f) => f.path.startsWith('public/')), []);
  assert.match(h, /<span class="cf-name">public<\/span><span class="cf-n">2<\/span>/);
  assert.equal(fileRows(h).length, 4);
});

test('c4: the file row keeps the button that opens the diff; the one open there is marked; status letter, +added -deleted and binary files', () => {
  const h = R.columnView({ name: 'demo', files: [...FILES, { path: 'img/logo.png', status: 'M', binary: true }], selected: 'public/style.css' });
  const rows = fileRows(h);
  assert.deepEqual(rows.filter((r) => r.on).map((r) => r.path), ['public/style.css']);
  assert.deepEqual(rows.filter((r) => r.pressed).map((r) => r.path), ['public/style.css']);
  assert.match(h, /data-path="public\/resumen\.js" aria-pressed="false" title="public\/resumen\.js">/);
  assert.match(h, /<span class="cf-name">resumen\.js<\/span><span class="cf-n"><i class="a">\+43<\/i> <i class="d">−1<\/i><\/span><span class="cf-st st-M">M<\/span><\/button>/);
  assert.match(h, /data-path="test\/rp128\.test\.js"[^>]*>.*<span class="cf-st st-\?">\?<\/span>/);
  assert.match(h, /data-path="img\/logo\.png"[^>]*>.*<span class="cf-n">bin<\/span>/);
  assert.equal(fileRows(R.columnView({ name: 'x', files: FILES, selected: 'nope' })).filter((r) => r.on).length, 0);
});

test('c5: without a list the panel says why (loading, unavailable, or no changes); it is total for odd input and skips entries without a path', () => {
  assert.match(R.columnView({ name: 'x' }), /<p class="rs-sub" role="status">Loading files…<\/p>/);
  assert.match(R.columnView({ name: 'x', failed: true }), /<p class="rs-sub" role="status">Files unavailable<\/p>/);
  assert.match(R.columnView({ name: 'x', files: [] }), /<p class="rs-sub" role="status">No uncommitted changes<\/p>/);
  for (const arg of [undefined, null, {}, { files: 'x' }, { files: [null, 3, {}] }, { files: [{ path: 5 }] }, { name: 7, files: [{ path: 'a.js' }] }]) {
    const h = R.columnView(arg);
    assert.match(h, /^<div class="col-tabs"/, JSON.stringify(arg));
    assert.doesNotMatch(h, /undefined|null|NaN/, JSON.stringify(arg));
  }
  assert.equal(fileRows(R.columnView({ files: [null, 3, {}, { path: '' }, { path: 'ok.js' }] })).length, 1);
});

test('c6: a backslash path is grouped like a slash path and keeps its own text to open the diff; names and paths are escaped', () => {
  const h = R.columnView({ name: 'a<b>"c', files: [{ path: 'docs\\notes.md', status: 'A' }, { path: 'x/<i>.js', status: '<', added: 1, deleted: 1 }] });
  assert.deepEqual(dirs(h).map((d) => d.path), ['docs', 'x']);
  assert.ok(fileRows(h).some((f) => f.path === 'docs\\notes.md' && f.depth === 1));
  assert.doesNotMatch(h, /<i>\.js|a<b>"c/, 'what the person or git wrote never becomes markup');
  assert.match(h, /aria-label="Files with changes of a&lt;b&gt;&quot;c"/);
  assert.match(h, /class="cf-st st-&lt;">&lt;<\/span>/);
});

test('c7: a long list is cut at 200 files with the rest counted, and the total on top counts all of them', () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ path: `d/f${String(i).padStart(3, '0')}.js`, status: 'M', added: 1, deleted: 0 }));
  const h = R.columnView({ name: 'x', files: many });
  assert.equal(fileRows(h).length, 200);
  assert.match(h, /<p class="rs-sub" role="status">and 30 more<\/p>/);
  assert.match(h, /<b>230 files<\/b> <span class="a">\+230<\/span>/);
  assert.match(h, /<span class="n">230<\/span>/);
});

test('c8: the order is stable and does not care for the case of the names; very deep paths stop getting deeper', () => {
  const h = R.columnView({ name: 'x', files: [{ path: 'b.js', status: 'M' }, { path: 'A.js', status: 'M' }, { path: 'Zed/x.js', status: 'M' }, { path: 'alpha/x.js', status: 'M' }] });
  assert.deepEqual(order(h), ['alpha', 'alpha/x.js', 'Zed', 'Zed/x.js', 'A.js', 'b.js']);
  const deep = R.columnView({ name: 'x', files: [{ path: 'a/b/c/d/e/f/g/h/i/j/k/l/m.js', status: 'M' }, { path: 'a/z.js', status: 'M' }, { path: 'a/b/y.js', status: 'M' }, { path: 'a/b/c/y.js', status: 'M' }, { path: 'a/b/c/d/y.js', status: 'M' }, { path: 'a/b/c/d/e/y.js', status: 'M' }, { path: 'a/b/c/d/e/f/y.js', status: 'M' }, { path: 'a/b/c/d/e/f/g/y.js', status: 'M' }, { path: 'a/b/c/d/e/f/g/h/y.js', status: 'M' }, { path: 'a/b/c/d/e/f/g/h/i/y.js', status: 'M' }] });
  assert.ok(Math.max(...fileRows(deep).map((f) => f.depth), ...dirs(deep).map((d) => d.depth)) <= 8);
});

// ---------- Tasks: compact ----------
const ROW = (id, estado, over = {}) => ({ id, entrega: `Delivery of ${id}`, resultadoVisible: '', dependsOn: [], estado, notas: '', line: 1, ...over });
const RP = (rows, extra = {}) => ({ available: true, rows, derived: {}, next: null, ...extra });
const MANY = RP([ROW('A1', 'Completada'), ROW('A2', 'Completada'), ROW('A3', 'Completada'), ROW('B1', 'En curso'), ROW('C1', 'Pendiente'), ROW('C2', 'Pendiente'), ROW('D1', 'Bloqueada', { notas: 'Waiting for the person' }), ROW('E1', 'Pendiente', { dependsOn: ['B1'] })],
  { next: ROW('C1', 'Pendiente'), derived: { A1: { state: 'En revisión', pr: 7 }, A2: { state: 'Lista', branch: 'feat/a2' } } });
const compact = (rp, ctx = {}) => R.tasksView(rp, { compact: true, ...ctx });
const trows = (h) => [...h.matchAll(/<div class="tk-row( tk-next)?"( aria-current="true")? title="([^"]*)"><span class="tk-id mono">([^<]*)<\/span><span class="tk-tx">([^<]*)<\/span>(?:<span class="chip ([a-z]*)">([^<]*)<\/span>)?<\/div>/g)].map((m) => ({ next: !!m[1], cur: !!m[2], title: m[3], id: m[4], tx: m[5], tone: m[6] || '', chip: m[7] || '' }));
const folds = (h) => [...h.matchAll(/<button type="button" class="tk-fold" data-act="tasks-fold" data-fold="(\w+)" aria-expanded="(true|false)"><span class="chev" aria-hidden="true">[▸▾]<\/span>([^<]*)<span class="sp"><\/span><span class="chip[^"]*">(\d+)<\/span><\/button>/g)].map((m) => ({ fold: m[1], open: m[2] === 'true', label: m[3], n: Number(m[4]) }));

test('k1: the empty and failing states are the same words as the full list, and the full list does not change', () => {
  assert.match(compact(null), /Loading tasks…/);
  assert.match(compact(null, { failed: true }), /Roadmap unavailable/);
  assert.match(compact({ available: false, reason: 'missing' }), /No docs\/ROADMAP\.md in this repo/);
  assert.match(compact(RP([])), /No tasks in the roadmap/);
  assert.doesNotMatch(R.tasksView(MANY, {}), /tk-bar|tk-fold|tk-row/, 'without the flag the output is the full list of before');
});

test('k2: a segmented bar says it all in a label and the legend lists only the groups that have something', () => {
  const h = compact(MANY);
  assert.match(h, /<div class="tk-bar" role="img" aria-label="1 completed, 1 in review, 1 ready, 1 in progress, 3 pending, 1 blocked">/);
  const widths = [...h.match(/<div class="tk-bar"[\s\S]*?<\/div>/)[0].matchAll(/<i class="(tk-[a-z]+|rs-[a-z]+)" style="width:([\d.]+)%"><\/i>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(widths.map((w) => w[0]), ['rs-done', 'rs-pr', 'tk-ready', 'tk-prog', 'rs-pend', 'rs-blk']);
  assert.ok(widths.reduce((a, w) => a + w[1], 0) <= 100.0001, 'the segments never add up to more than the bar');
  assert.match(h, /<div class="tk-leg"><span><i class="tk-k rs-done"><\/i><b>1<\/b> completed<\/span>/);
  assert.doesNotMatch(compact(RP([ROW('A', 'Completada')])), /in progress|blocked|pending/);
});

test('k3: only the rows that ask for an action are shown (in review, ready, in progress, the next one); Pending, Blocked and Completed are folded with their count', () => {
  const h = compact(MANY);
  assert.deepEqual(trows(h).map((r) => [r.id, r.chip]), [['A1', 'PR #7'], ['A2', 'ready'], ['B1', 'in progress'], ['C1', 'next']]);
  assert.deepEqual(trows(h).map((r) => r.tone), ['blue', 'green', 'yellow', 'blue']);
  assert.deepEqual(folds(h), [{ fold: 'pending', open: false, label: 'Pending', n: 2 }, { fold: 'blocked', open: false, label: 'Blocked', n: 1 }, { fold: 'done', open: false, label: 'Completed', n: 1 }]);
  assert.doesNotMatch(h, /Delivery of C2|Delivery of D1|Delivery of E1|Delivery of A3/, 'what is folded is not in the markup');
  const next = trows(h).find((r) => r.id === 'C1');
  assert.deepEqual([next.next, next.cur], [true, true]);
  assert.equal(trows(h).filter((r) => r.cur).length, 1);
});

test('k4: a folded group opens with the state of the page and shows its rows under its button; the filter opens what matches and hides the rest', () => {
  const h = compact(MANY, { open: { blocked: true, done: true } });
  assert.deepEqual(folds(h).map((f) => [f.fold, f.open]), [['pending', false], ['blocked', true], ['done', true]]);
  assert.match(h, /data-fold="blocked" aria-expanded="true">[\s\S]*?<div class="tk-sub">[\s\S]*?Delivery of D1/);
  assert.ok(trows(h).some((r) => r.id === 'D1') && trows(h).some((r) => r.id === 'A3'));
  const f = compact(MANY, { filter: 'd1' });
  assert.deepEqual(trows(f).map((r) => r.id), ['D1']);
  assert.deepEqual(folds(f).map((x) => [x.fold, x.open, x.n]), [['blocked', true, 1]]);
  assert.match(compact(MANY, { filter: 'zzz' }), /No task matches/);
});

test('k5: the filter box stays with its value (escaped); a row is one line whose tooltip carries the detail (PR, branch, what it waits for, why it is blocked)', () => {
  assert.match(compact(MANY, { filter: 'a"<b>' }), /<input id="tasksFilter" type="search" class="task-filter" aria-label="Filter tasks" placeholder="Filter tasks…" value="a&quot;&lt;b&gt;">/);
  const h = compact(MANY, { open: { pending: true, blocked: true } });
  const by = Object.fromEntries(trows(h).map((r) => [r.id, r]));
  assert.match(by.A1.title, /PR #7/);
  assert.match(by.A2.title, /feat\/a2/);
  assert.match(by.E1.title, /waiting: B1/);
  assert.match(by.D1.title, /Waiting for the person/);
  assert.match(by.B1.title, /^B1 · Delivery of B1/);
});

test('k6: it is total for odd input, escapes ids and texts, and cuts at 200 rows with the rest counted', () => {
  const evil = RP([ROW('<i>', 'En curso', { entrega: '<img src=x onerror=1>"' })]);
  const h = compact(evil);
  assert.doesNotMatch(h, /<img|<i>/);
  assert.match(h, /&lt;img/);
  for (const rp of [undefined, {}, { available: true }, { available: true, rows: 'x' }, RP([null, 3, { id: '' }, ROW('ok', 'Pendiente')])]) assert.doesNotMatch(compact(rp), /undefined|NaN/);
  const many = RP(Array.from({ length: 230 }, (_, i) => ROW(`T${i}`, 'En curso')));
  const m = compact(many);
  assert.equal(trows(m).length, 200);
  assert.match(m, /<div class="task-more rs-sub">\+30 more<\/div>/);
});

// ---------- the styles ----------
test('s1: the tabs are in a bar that stays on top while the panel scrolls; only the open one shows its name; in a narrow column no tab shows it', () => {
  assert.match(css, /\.col-tabs\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(css, /\.col-tab \.lb\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.col-tab\[aria-selected="true"\] \.lb\s*\{[^}]*display:\s*inline/);
  assert.match(css, /#col\s*\{[^}]*container-type:\s*inline-size[^}]*container-name:\s*col/);
  const q = /@container col \(max-width:\s*300px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(q, 'a rule for a narrow column');
  assert.match(q[1], /\.col-tab\[aria-selected="true"\] \.lb\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.col-tab\[aria-selected="true"\]\s*\{[^}]*border-bottom-color:\s*var\(--blue\)|\.col-tab\[aria-selected="true"\]\s*\{[^}]*border-color:\s*var\(--blue\)/);
  assert.match(css, /\.col-tab:focus-visible\s*\{[^}]*outline/);
});

test('s2: the tree has an indent for each depth up to 8, a clipped name, a status colour per letter and a visible focus; the compact tasks clip a row to one line', () => {
  for (let d = 0; d <= 8; d++) assert.match(css, new RegExp(`\\.cf-d${d}\\b`), `depth ${d}`);
  assert.match(css, /\.cf-dir\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.cf-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.st-M\s*\{[^}]*color:\s*var\(--yellow\)/);
  assert.match(css, /\.cf-dir:focus-visible/);
  assert.match(css, /\.tk-row\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.tk-tx\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap|\.tk-tx\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.tk-fold:focus-visible/);
  assert.match(css, /\.tk-ready\s*\{[^}]*background/);
  assert.match(css, /\.tk-prog\s*\{[^}]*background/);
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

test('p1: with the column in, a repo opens on Changes with the tree from the board facts; the roadmap is still read once and nothing else is read', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  assert.equal(selected(col(page)), 'changes');
  assert.equal(fileRows(col(page)).length, 6);
  assert.doesNotMatch(col(page), /tk-bar/);
  assert.equal(page.fetches.filter((f) => f.url === '/api/roadmap?id=abc').length, 1);
  assert.equal(page.fetches.filter((f) => f.url.startsWith('/api/diff')).length, 0, 'the tree reads no diff');
});

test('p2: the Tasks tab shows the compact tasks and the Changes tab brings the tree back; a tab that does not exist reads as Changes', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  const writes = () => page.fetches.filter((f) => f.method !== 'GET').map((f) => f.url);
  const before = writes();
  act(page, 'col-tab', { tab: 'tasks' });
  page.flush();
  assert.equal(selected(col(page)), 'tasks');
  assert.match(col(page), /<div class="tk-bar" role="img"/);
  assert.deepEqual(trows(col(page)).map((r) => r.id), ['A1', 'A2', 'B1', 'C1']);
  assert.equal(fileRows(col(page)).length, 0);
  assert.equal(page.fetches.filter((f) => f.url === '/api/roadmap?id=abc').length, 1, 'switching tabs reads nothing');
  act(page, 'col-tab', { tab: 'changes' });
  page.flush();
  assert.equal(selected(col(page)), 'changes');
  assert.equal(fileRows(col(page)).length, 6);
  act(page, 'col-tab', { tab: 'status' }); // RP129: Status is a real tab of the column now
  page.flush();
  assert.equal(selected(col(page)), 'status');
  for (const t of ['files', 'notes', '', undefined, '<x>']) { act(page, 'col-tab', { tab: t }); page.flush(); assert.equal(selected(col(page)), 'changes', String(t)); }
  act(page, 'col-folder', { path: 'public' });
  act(page, 'tasks-fold', { fold: 'done' });
  page.flush();
  assert.deepEqual(writes(), before, 'touching the column writes nothing');
});

test('p3: the open tab belongs to the opening: another repo, or the same one opened again, starts on Changes; the folded folders too', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  act(page, 'col-tab', { tab: 'tasks' });
  act(page, 'col-folder', { path: 'public' });
  page.flush();
  open(page, 'xyz');
  await page.tick();
  assert.equal(selected(col(page)), 'changes');
  open(page, 'abc');
  await page.tick();
  assert.equal(selected(col(page)), 'changes');
  assert.deepEqual(dirs(col(page)).filter((d) => d.path === 'public').map((d) => d.open), [true]);
});

test('p4: a folder button folds and unfolds its folder, and a path that is not a folder of the list is ignored', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  act(page, 'col-folder', { path: 'public' });
  page.flush();
  assert.deepEqual(dirs(col(page)).filter((d) => d.path === 'public').map((d) => d.open), [false]);
  assert.equal(fileRows(col(page)).length, 4);
  act(page, 'col-folder', { path: 'public' });
  page.flush();
  assert.equal(fileRows(col(page)).length, 6);
  const before = col(page);
  act(page, 'col-folder', { path: '' });
  act(page, 'col-folder', { path: undefined });
  act(page, 'col-folder', { path: '__proto__' });
  page.flush();
  assert.equal(col(page), before);
});

test('p5: the folds of the tasks open and close, only the three that exist, and the filter keeps working in the compact list', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  act(page, 'col-tab', { tab: 'tasks' });
  act(page, 'tasks-fold', { fold: 'blocked' });
  page.flush();
  assert.deepEqual(folds(col(page)).map((f) => [f.fold, f.open]), [['pending', false], ['blocked', true], ['done', false]]);
  assert.ok(trows(col(page)).some((r) => r.id === 'D1'));
  act(page, 'tasks-fold', { fold: 'blocked' });
  page.flush();
  assert.equal(folds(col(page)).find((f) => f.fold === 'blocked').open, false);
  const before = col(page);
  for (const f of ['', 'review', '__proto__', undefined]) act(page, 'tasks-fold', { fold: f });
  page.flush();
  assert.equal(col(page), before);
  page.run("ACTIONS['tasks-filter']({ value: 'a1' })");
  page.flush();
  assert.deepEqual(trows(col(page)).map((r) => r.id), ['A1']);
});

test('p6: the arrows, Home and End move between the tabs and the new one takes the focus; other keys and other targets are left alone', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  const tabEl = (t) => ({ dataset: { act: 'col-tab', tab: t }, tagName: 'BUTTON' });
  const e = page.key('ArrowRight', tabEl('changes'));
  page.flush();
  assert.equal(selected(col(page)), 'status', 'RP129: Changes, Status, Tasks');
  assert.equal(e.prevented, true);
  assert.ok(page.get('#coltab-status').focused >= 1, 'the focus goes to the tab that opened');
  page.key('ArrowRight', tabEl('status'));
  page.flush();
  assert.equal(selected(col(page)), 'tasks');
  page.key('ArrowLeft', tabEl('tasks'));
  page.flush();
  assert.equal(selected(col(page)), 'status');
  page.key('ArrowLeft', tabEl('status'));
  page.flush();
  assert.equal(selected(col(page)), 'changes');
  page.key('End', tabEl('changes'));
  page.flush();
  assert.equal(selected(col(page)), 'tasks');
  page.key('Home', tabEl('tasks'));
  page.flush();
  assert.equal(selected(col(page)), 'changes');
  const quiet = page.key('ArrowRight', { dataset: { act: 'chat-open' }, tagName: 'ARTICLE' });
  const other = page.key('a', tabEl('changes'));
  assert.deepEqual([quiet.prevented, other.prevented, selected(col(page))], [false, false, 'changes']);
});

test('p7: a folder keeps the focus after it folds (the page repaints), a click on a tab gives the focus to that tab', async () => {
  const page = boot();
  open(page, 'abc');
  await page.tick();
  const btn = element({ dataset: { act: 'col-folder', path: 'public' } });
  const real = page.doc.querySelectorAll;
  page.doc.querySelectorAll = (s) => (String(s).includes('col-folder') ? [element({ dataset: { act: 'col-folder', path: 'docs' } }), btn] : real(s));
  act(page, 'col-folder', { path: 'public' });
  page.flush();
  assert.equal(btn.focused, 1);
  act(page, 'col-tab', { tab: 'tasks' });
  page.flush();
  assert.ok(page.get('#coltab-tasks').focused >= 1);
});

test('p8: under 1100 px there is no column: it holds no tabs and the chat keeps its own Tasks and Changes tabs as before', async () => {
  const page = boot(900);
  open(page, 'abc');
  await page.tick();
  assert.doesNotMatch(col(page), /col-tabs|tk-bar/);
  assert.match(page.get('#chatHead').html, /data-tab="tasks"/);
  assert.match(page.get('#chatHead').html, /data-tab="changes"/);
});
