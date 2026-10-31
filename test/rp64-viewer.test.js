'use strict';
// RP64 (S62, S55, S78): the single code viewer, pure part. R.parseDiff turns the text of GET /api/diff into files with numbered lines;
// R.changesView draws the file list and the code with line numbers; R.chatHead gains the third tab, Changes. The old diff drawer
// (renderDiff / openDiff) is gone: the Conformity drawer stays. No network, no timers, no real clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../public/resumen.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const FORBIDDEN = /\b[Pp]i (?:sessions?|prompt|screens?|terminals?|orders?)\b|\b(?:to|in|of|with) pi\b|\bpi\b|Gentle Shell/;

const MOD = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -3,4 +3,5 @@ function x() {',
  ' keep1',
  '-old1',
  '+new1',
  '+new2',
  ' keep2',
  '@@ -20,2 +21,2 @@',
  ' tail',
  '-gone',
  '+here',
  '\\ No newline at end of file',
].join('\n');
const NEW = ['diff --git a/docs/n.md b/docs/n.md', 'new file mode 100644', '--- /dev/null', '+++ b/docs/n.md', '@@ -0,0 +1,2 @@', '+line one', '+line two'].join('\n');
const DEL = ['diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-bye', '-bye2'].join('\n');
const BIN = ['diff --git a/big.bin b/big.bin', 'new file', 'Binary or large file not shown'].join('\n');
const ALL = [MOD, NEW, DEL, BIN].join('\n');
const parse = (t = ALL) => R.parseDiff(t);
const byPath = (files, p) => files.find((f) => f.path === p);
const lineOf = (f, i) => f.lines.filter((l) => l.kind !== 'h')[i];

// ---------- parseDiff ----------
test('parseDiff: one entry per file with path, status and the +/- counts', () => {
  const files = parse();
  assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.deleted, f.binary]), [
    ['src/a.js', 'M', 3, 2, false], ['docs/n.md', 'A', 2, 0, false], ['old.txt', 'D', 0, 2, false], ['big.bin', 'A', 0, 0, true],
  ]);
});

test('parseDiff: lines carry old and new numbers from the hunk headers (context both, add new only, delete old only)', () => {
  const f = byPath(parse(), 'src/a.js');
  const rows = f.lines.filter((l) => l.kind !== 'h' && l.kind !== 'm').map((l) => [l.kind, l.old, l.new, l.text]);
  assert.deepEqual(rows, [
    ['c', 3, 3, 'keep1'], ['d', 4, null, 'old1'], ['a', null, 4, 'new1'], ['a', null, 5, 'new2'], ['c', 5, 6, 'keep2'],
    ['c', 20, 21, 'tail'], ['d', 21, null, 'gone'], ['a', null, 22, 'here'],
  ]);
});

test('parseDiff: a hunk header is a "h" row without numbers; the "No newline" marker is an "m" row that does not advance the numbers', () => {
  const f = byPath(parse(), 'src/a.js');
  const heads = f.lines.filter((l) => l.kind === 'h');
  assert.equal(heads.length, 2);
  assert.deepEqual([heads[0].old, heads[0].new, heads[0].text], [null, null, '@@ -3,4 +3,5 @@ function x() {']);
  const m = f.lines.find((l) => l.kind === 'm');
  assert.deepEqual([m.old, m.new, m.text], [null, null, '\\ No newline at end of file']);
});

test('parseDiff: a new file numbers its lines from 1 and a deleted file keeps the old numbers', () => {
  const n = byPath(parse(), 'docs/n.md');
  assert.deepEqual(n.lines.filter((l) => l.kind === 'a').map((l) => [l.old, l.new]), [[null, 1], [null, 2]]);
  const d = byPath(parse(), 'old.txt');
  assert.deepEqual(d.lines.filter((l) => l.kind === 'd').map((l) => [l.old, l.new]), [[1, null], [2, null]]);
});

test('parseDiff: the binary or large placeholder is a note, with no code lines', () => {
  const b = byPath(parse(), 'big.bin');
  assert.equal(b.binary, true);
  assert.match(b.note, /Binary or large file not shown/);
  assert.equal(b.lines.length, 0);
});

test('parseDiff: the path is the b side and may have spaces', () => {
  const t = ['diff --git a/my dir/a b.js b/my dir/a b.js', '--- a/my dir/a b.js', '+++ b/my dir/a b.js', '@@ -1 +1 @@', '-x', '+y'].join('\n');
  assert.equal(parse(t)[0].path, 'my dir/a b.js');
});

test('parseDiff: no input, garbage or a non-string gives an empty list and never throws', () => {
  for (const t of ['', '   \n', 'hello', 'not a diff at all\n+++ nothing', undefined, null, 42, {}]) assert.deepEqual(R.parseDiff(t), [], String(t));
});

test('parseDiff: a "+++" or "---" line inside a hunk is code, not a header', () => {
  const t = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '--- inside', '+++ inside'].join('\n');
  const f = parse(t)[0];
  assert.deepEqual(f.lines.filter((l) => l.kind !== 'h').map((l) => [l.kind, l.text]), [['d', '-- inside'], ['a', '++ inside']]);
  assert.deepEqual([f.added, f.deleted], [1, 1]);
});

// ---------- changesView ----------
const view = (data = { diff: ALL, truncated: false }, ctx = {}) => R.changesView(data, { selected: '', loading: false, failed: false, ...ctx });
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('changesView: no answer yet and loading says "Loading changes…"; failed says "Changes unavailable"; an empty diff says there is nothing', () => {
  assert.match(view(null, { loading: true }), /Loading changes…/);
  assert.match(view(null, { failed: true }), /Changes unavailable/);
  assert.match(R.changesView(undefined, { failed: true }), /Changes unavailable/);
  assert.match(view({ diff: '', truncated: false }), /No uncommitted changes/);
  assert.match(view({ diff: '   \n' }), /No uncommitted changes/);
});

test('changesView: the file list has one button per file with its status, path and counts (bin for a binary file)', () => {
  const h = view();
  assert.equal((h.match(/class="cv-item/g) || []).length, 4);
  assert.match(h, /<button[^>]*data-act="changes-file"[^>]*data-path="src\/a\.js"[^>]*>.*?cv-st">M<.*?cv-path">src\/a\.js<.*?<span class="add">\+3<\/span>.*?<span class="del">−2<\/span>/);
  assert.match(h, /data-path="docs\/n\.md"[^>]*>.*?cv-st">A</);
  assert.match(h, /data-path="old\.txt"[^>]*>.*?cv-st">D</);
  assert.match(h, /data-path="big\.bin"[^>]*>.*?<span class="add">bin<\/span>/);
});

test('changesView: every line has two gutters (old, new) and the code with its +/- sign, escaped', () => {
  const h = view({ diff: ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -7,2 +7,2 @@', ' same', '-<b>gone</b>', '+<i>here</i>'].join('\n') });
  assert.match(h, /<div class="cv-l c"><span class="cv-n">7<\/span><span class="cv-n">7<\/span><span class="cv-t"> same<\/span><\/div>/);
  assert.match(h, /<div class="cv-l d"><span class="cv-n">8<\/span><span class="cv-n"><\/span><span class="cv-t">-&lt;b&gt;gone&lt;\/b&gt;<\/span><\/div>/);
  assert.match(h, /<div class="cv-l a"><span class="cv-n"><\/span><span class="cv-n">8<\/span><span class="cv-t">\+&lt;i&gt;here&lt;\/i&gt;<\/span><\/div>/);
  assert.ok(!h.includes('<b>gone') && !h.includes('<i>here'));
});

test('changesView: hunk headers are their own row kind and the note of a binary file is shown', () => {
  const h = view();
  assert.match(h, /<div class="cv-l h">.*?@@ -3,4 \+3,5 @@ function x\(\) \{/);
  assert.match(h, /Binary or large file not shown/);
});

test('changesView: a selected file shows only that file and an "All files" button; an unknown selection shows all', () => {
  const one = view(undefined, { selected: 'docs/n.md' });
  assert.equal((one.match(/<section class="cv-file/g) || []).length, 1);
  assert.match(one, /line one/);
  assert.ok(!/keep1/.test(one));
  assert.match(one, /<button[^>]*data-act="changes-file"[^>]*data-path=""[^>]*>All files/);
  assert.match(one, /class="cv-item cv-on"[^>]*data-path="docs\/n\.md"|data-path="docs\/n\.md"[^>]*class="cv-item cv-on"|class="cv-item cv-on"[^>]*aria-pressed="true"[^>]*data-path="docs\/n\.md"/);
  const all = view(undefined, { selected: 'no/such/file' });
  assert.equal((all.match(/<section class="cv-file/g) || []).length, 4);
  assert.ok(!/All files/.test(view()), 'with no selection there is nothing to go back from');
});

test('changesView: a hostile path is escaped everywhere (list, attribute, title)', () => {
  const evil = 'a"><img src=x onerror=alert(1)>.js';
  const t = [`diff --git a/${evil} b/${evil}`, `--- a/${evil}`, `+++ b/${evil}`, '@@ -1 +1 @@', '-x', '+y'].join('\n');
  const h = view({ diff: t });
  assert.ok(!h.includes('<img'), h);
  assert.match(h, /&lt;img/);
});

test('changesView: the truncated notice shows when the answer says so', () => {
  assert.match(view({ diff: MOD, truncated: true }), /Diff truncated \(too large\)/);
  assert.ok(!/truncated/.test(view({ diff: MOD, truncated: false })));
});

test('changesView: bounded to 2000 code rows with a "+N more lines" note', () => {
  const rows = Array.from({ length: 2300 }, (_, i) => `+line ${i}`);
  const t = ['diff --git a/big.js b/big.js', '--- /dev/null', '+++ b/big.js', '@@ -0,0 +1,2300 @@', ...rows].join('\n');
  const h = view({ diff: t });
  assert.equal((h.match(/class="cv-l /g) || []).length, 2001, '2000 rows plus the hunk header');
  assert.match(h, /\+300 more lines/);
});

test('changesView: same output twice, input not mutated, no undefined or NaN, no forbidden word', () => {
  const data = Object.freeze({ diff: ALL, truncated: false });
  assert.equal(view(data), view(data));
  const h = view(data);
  assert.ok(!/undefined|NaN|null/.test(h), h);
  assert.ok(!FORBIDDEN.test(text(h)));
});

// ---------- chatHead: the third tab ----------
test('chatHead: Chat, Tasks and Changes tabs in that order; Changes selected for tab "changes"', () => {
  const h = R.chatHead({ id: 'abc', tab: 'changes' }, { name: 'demo' });
  assert.deepEqual(Array.from(h.matchAll(/data-tab="(\w+)"/g)).map((m) => m[1]), ['chat', 'tasks', 'changes']);
  assert.match(h, /data-tab="changes"[^>]*aria-selected="true"[^>]*>Changes</);
  assert.match(h, /data-tab="chat"[^>]*aria-selected="false"/);
  assert.match(h, /data-tab="tasks"[^>]*aria-selected="false"/);
  assert.match(R.chatHead({ id: 'abc' }, { name: 'demo' }), /data-tab="chat"[^>]*aria-selected="true"/);
});

// ---------- the old drawer diff is gone ----------
test('app.js no longer has the diff drawer (renderDiff, openDiff) and the Conformity drawer is still there', () => {
  const app = read('app.js');
  assert.ok(!/function renderDiff|async function openDiff/.test(app));
  assert.match(app, /function openConformity|openConformity\s*=/);
  assert.match(read('index.html'), /id="drawer"/);
});

test('style.css has the viewer classes and no longer the drawer diff ones', () => {
  const css = read('style.css');
  for (const c of ['.cv-list', '.cv-item', '.cv-file', '.cv-l', '.cv-n', '.cv-t']) assert.ok(new RegExp('(^|, )' + c.replace('.', '\.') + '[ ,{.:]', 'm').test(css), c);
  assert.ok(!/^\.filelist\b/m.test(css) && !/^\.diff\b/m.test(css));
});

test('parseDiff: a path that contains " b/" is not cut at it (the two sides are the same path)', () => {
  const t = ['diff --git a/dir b/x.js b/dir b/x.js', '--- a/dir b/x.js', '+++ b/dir b/x.js', '@@ -1 +1 @@', '-x', '+y'].join('\n');
  assert.equal(parse(t)[0].path, 'dir b/x.js');
});

// Found in a real browser: #chatBody is a column flexbox, so a section with overflow hidden shrank to its title and clipped its code.
test('style.css: the file list and the file sections do not shrink inside the column flexbox of the panel body', () => {
  const css = read('style.css');
  for (const sel of ['.cv-file', '.cv-list']) {
    const rule = new RegExp('^' + sel.replace('.', '\\.') + ' \\{([^}]*)\\}', 'm').exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /flex:\s*none/, sel);
  }
});

// Found in a real browser: with the global border-box the 4ch gutter lost its padding and four-digit line numbers touched each other.
test('style.css: the line-number gutter keeps room for four digits besides its padding', () => {
  const rule = /^\.cv-n \{([^}]*)\}/m.exec(read('style.css'));
  assert.ok(rule);
  assert.match(rule[1], /box-sizing:\s*content-box/);
  assert.match(rule[1], /min-width:\s*4ch/);
});
