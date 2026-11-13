'use strict';
// RP66b (S1, S2, S3, S5): the viewer uses the highlighter of RP66a. The Files tab (fileSection) and the Changes tab (changesView) paint the text of a line with
// public/highlight.js when the file has a language and at most MAX_LINES lines; in every other case the row is the one of before. The rule that matters is S5: the text of a
// file is data, so a row with the spans of the highlighter removed is exactly the escaped line, in the file view and in the diff, in every language. No network, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LIB_FILES } = require('./pagesrc.js');

const R = require('../public/resumen.js');
const H = require('../public/highlight.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The text cell of every code row (not the hunk headers), as HTML. A row ends with its cell, so the first `</span></div>` closes it (hostile text is escaped and cannot contain a tag).
const cells = (html) => [...String(html).matchAll(/<div class="cv-l(?! h")[^"]*"><span class="cv-n">[^<]*<\/span>(?:<span class="cv-n">[^<]*<\/span>)?<span class="cv-t">(.*?)<\/span><\/div>/gs)].map((m) => m[1]);
const bare = (cell) => cell.replace(/<span class="hl-[a-z]">/g, '').replace(/<\/span>/g, '');
const fileHtml = (p, text) => R.filesView({ files: [{ path: p }] }, { selected: p }, { path: p, text });
const diffOf = (p, body) => `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n${body}`;
const diffHtml = (p, body) => R.changesView({ diff: diffOf(p, body) }, { selected: p, only: true });

test('the Files tab paints a JavaScript file with the spans of the highlighter and keeps the line numbers', () => {
  const html = fileHtml('src/a.js', 'const a = 1; // note\nreturn "x";');
  const rows = cells(html);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /<span class="hl-k">const<\/span>/);
  assert.match(rows[0], /<span class="hl-c">\/\/ note<\/span>/);
  assert.match(rows[1], /<span class="hl-s">&quot;x&quot;<\/span>/);
  assert.match(html, /<span class="cv-n">1<\/span><span class="cv-t">/);
  assert.match(html, /<span class="cv-n">2<\/span><span class="cv-t">/);
});

test('a file without a language is painted exactly as before: the escaped line and nothing else', () => {
  for (const p of ['notes.xyz', 'LICENSE', 'a.bin.dat']) {
    const html = fileHtml(p, 'if (a < b && "c") { return 1 }\nsecond');
    assert.deepEqual(cells(html), ['if (a &lt; b &amp;&amp; &quot;c&quot;) { return 1 }', 'second'], p);
    assert.doesNotMatch(html, /class="hl-/, p);
  }
});

test('a file over 2,000 lines is shown without color, and one of exactly 2,000 lines is painted', () => {
  const big = (n) => Array.from({ length: n }, () => 'const x = 1;').join('\n');
  const over = fileHtml('big.js', big(2001));
  assert.doesNotMatch(over, /class="hl-/);
  assert.equal(cells(over).length, 2000);
  assert.match(over, /\+1 more lines/);
  const edge = fileHtml('big.js', big(2000));
  assert.match(edge, /class="hl-k"/);
  assert.equal(cells(edge).length, 2000);
});

test('the lines of a block comment keep the state from one line to the next in the file view', () => {
  const rows = cells(fileHtml('a.js', '/* one\ntwo\nthree */ const a = 1;'));
  assert.equal(rows[1], '<span class="hl-c">two</span>');
  assert.match(rows[2], /^<span class="hl-c">three \*\/<\/span> <span class="hl-k">const<\/span>/);
});

test('the Changes tab paints the context, added and deleted lines, and the sign stays outside the spans', () => {
  const html = diffHtml('src/a.js', '@@ -1,3 +1,3 @@\n keep(1);\n-var old = 1;\n+const fresh = 2;\n tail();');
  const rows = cells(html);
  assert.equal(rows.length, 4);
  assert.match(rows[1], /^-<span class="hl-k">var<\/span> old = <span class="hl-n">1<\/span>;$/);
  assert.match(rows[2], /^\+<span class="hl-k">const<\/span> fresh = <span class="hl-n">2<\/span>;$/);
  assert.match(rows[0], /^ keep\(<span class="hl-n">1<\/span>\);$/);
});

test('the diff keeps two states, the new side and the old side: a deleted comment opener does not turn the added lines into a comment', () => {
  const rows = cells(diffHtml('a.js', '@@ -1,3 +1,3 @@\n-/* start\n-still old\n+const a = 1;\n+const b = 2;\n tail();'));
  assert.match(rows[0], /^-<span class="hl-c">\/\* start<\/span>$/);
  assert.match(rows[1], /^-<span class="hl-c">still old<\/span>$/);
  assert.match(rows[2], /^\+<span class="hl-k">const<\/span> a/);
  assert.match(rows[3], /^\+<span class="hl-k">const<\/span> b/);
  assert.match(rows[4], /^ tail\(\);$/);
});

test('the state of the diff does not leak from one hunk to the next', () => {
  const rows = cells(diffHtml('a.js', '@@ -1,2 +1,2 @@\n+/* open\n keep\n@@ -30,2 +30,2 @@\n+const z = 1;\n keep2'));
  assert.match(rows[1], /^ <span class="hl-c">keep<\/span>$/);
  assert.match(rows[2], /^\+<span class="hl-k">const<\/span> z/);
});

test('a changed file without a language is painted exactly as before', () => {
  const rows = cells(diffHtml('notes.xyz', '@@ -1,2 +1,2 @@\n ctx <b>\n-old "q"\n+new & x'));
  assert.deepEqual(rows, [' ctx &lt;b&gt;', '-old &quot;q&quot;', '+new &amp; x']);
});

const HOSTILE = [
  '</span><script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '<!-- </style><script>alert(1)</script>',
  '/* </span><b onmouseover=alert(1)> */',
  '`${</span><i>}` <a href="javascript:alert(1)">x</a>',
  '# <script>x</script> **<u>a</u>** `<s>`',
  '```<script>',
  '{"k":"</span><x>","</script>":1}',
  'a { background: url("</style><script>x</script>") } /*',
  'echo "$(</span><x>)" # </span>',
  '<div class="hl-k" onclick=1><span class="hl-s">',
  '&lt;b&gt; &amp;amp; &#60;',
  '\\"</span>\\\'<script>',
];
const PATHS = ['a.js', 'a.ts', 'a.json', 'a.css', 'a.html', 'a.md', 'a.sh'];

test('S5: in every language a row with the spans removed is the escaped line, in the file view and in the diff', () => {
  for (const p of PATHS) {
    const lines = [...HOSTILE, HOSTILE.join(' ')];
    const file = cells(fileHtml(p, lines.join('\n')));
    assert.equal(file.length, lines.length, p);
    file.forEach((c, i) => assert.equal(bare(c), esc(lines[i]), `${p} file line ${i}`));
    const body = `@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((l, i) => `${[' ', '+', '-'][i % 3]}${l}`).join('\n')}`;
    const diff = cells(diffHtml(p, body));
    assert.equal(diff.length, lines.length, p);
    diff.forEach((c, i) => assert.equal(bare(c).slice(1), esc(lines[i]), `${p} diff line ${i}`));
  }
});

// RP146: the file tree draws two icons of its OWN (a folder and a file, inline svg, aria-hidden), like the Changes tree. They are taken from a harmless render and removed from the output EXACTLY, so a tag that
// comes from a hostile file (any other svg included) is still found and still fails this test.
const OWN_ICONS = [...new Set([...R.filesView({ files: [{ path: 'd/f.txt' }] }, { selected: '', open: { d: true } }).matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0]))];
const withoutOwnIcons = (html) => OWN_ICONS.reduce((h, icon) => h.split(icon).join(''), html);
test('S5: the file tree icons are exactly two own svg, hidden from assistive tools, and nothing else is let through', () => {
  assert.equal(OWN_ICONS.length, 2, 'a folder icon and a file icon');
  for (const icon of OWN_ICONS) assert.match(icon, /^<svg [^>]*aria-hidden="true"/);
  assert.doesNotMatch(withoutOwnIcons(OWN_ICONS.join('')), /<svg/i, 'removing them leaves no svg');
  assert.match(withoutOwnIcons(`${OWN_ICONS[0]}<svg onload="x"></svg>`), /<svg onload/, 'a different svg is NOT removed');
});

test('S5: the whole viewer output of hostile files has no tag of the file, only the spans of the highlighter', () => {
  const allowed = /<\/?(?:span|div|section|h3|button)\b/;
  for (const p of PATHS) {
    const html = withoutOwnIcons(fileHtml(p, HOSTILE.join('\n'))) + diffHtml(p, `@@ -1,1 +1,1 @@\n+${HOSTILE.join(' ')}`);
    const tags = [...html.matchAll(/<[^>]*>/g)].map((m) => m[0]);
    for (const t of tags) assert.match(t, allowed, `${p}: unexpected tag ${t}`);
    assert.doesNotMatch(html, /<(?:script|img|svg|style|a|b|i|u|s|x)\b/i, p);
    assert.doesNotMatch(html, /<[^>]*\son[a-z]+=/i, p);
  }
});

test('S5: a hostile file path does not reach the language lookup as markup, and the path is still escaped in the title', () => {
  const p = '<img src=x onerror=alert(1)>.js';
  const html = fileHtml(p, 'const a = 1;');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.js/);
  assert.match(cells(html)[0], /hl-k/);
});

test('every real file of the repository gives, in the viewer, rows that are the escaped line once the spans are removed', () => {
  const { execFileSync } = require('node:child_process');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => H.languageOf(f));
  assert.ok(files.length > 50, `found ${files.length} files with a language`);
  let n = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (!lines.length || lines.length > 2000) continue;
    const rows = cells(fileHtml(f, text));
    assert.equal(rows.length, lines.length, f);
    for (let i = 0; i < lines.length; i++) if (bare(rows[i]) !== esc(lines[i])) assert.fail(`${f}:${i + 1} was changed by the highlighter`);
    n += rows.length;
  }
  assert.ok(n > 10000, `checked ${n} rows`);
});

test('without highlight.js in the page the viewer paints as before (it never throws)', () => {
  const ctx = vm.createContext({ console });
  ctx.self = ctx;
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'resumen.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.RepoPanelHighlight, 'undefined');
  const html = ctx.RepoPanelResumen.filesView({ files: [{ path: 'a.js' }] }, { selected: 'a.js' }, { path: 'a.js', text: 'const a = "<b>";' });
  assert.deepEqual(cells(html), ['const a = &quot;&lt;b&gt;&quot;;']);
  assert.doesNotMatch(html, /class="hl-/);
});

test('in the page, resumen.js finds the highlighter that highlight.js published', () => {
  const ctx = vm.createContext({ console });
  ctx.self = ctx;
  for (const f of ['highlight.js', 'resumen.js']) vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx);
  const html = ctx.RepoPanelResumen.filesView({ files: [{ path: 'a.js' }] }, { selected: 'a.js' }, { path: 'a.js', text: 'const a = 1;' });
  assert.match(cells(html)[0], /^<span class="hl-k">const<\/span> a = <span class="hl-n">1<\/span>;$/);
});

test('the page loads highlight.js after view.js and before resumen.js, and the server serves it', () => {
  const scripts = [...read('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts.slice(0, 3), ['/view.js', '/highlight.js', '/resumen.js']);
  assert.deepEqual(LIB_FILES, ['view.js', 'highlight.js', 'resumen.js', 'notify.js']); // RP178: notify.js follows resumen.js
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'http.js'), 'utf8'), /'\/highlight\.js': \['highlight\.js', 'text\/javascript; charset=utf-8'\]/);
});

test('every class the highlighter can emit has a color in style.css, and the code rows keep their own background', () => {
  const css = read('style.css');
  // The classes the highlighter really emits: those found in its output over every file of the repository that has a language.
  const used = new Set();
  const { execFileSync } = require('node:child_process');
  for (const f of execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((x) => H.languageOf(x))) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    for (const l of H.highlightLines(lines.length > 2000 ? [] : lines, H.languageOf(f)) || []) for (const m of l.matchAll(/class="hl-([a-z])"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 8, `the classes the highlighter emits: ${[...used]}`);
  for (const k of [...used, 'k', 's', 'c', 'n', 'p', 't', 'a', 'v', 'h']) assert.match(css, new RegExp(`\\.hl-${k}\\b[^{]*\\{[^}]*color:`), `style.css colors .hl-${k}`);
  assert.doesNotMatch(css, /\.hl-[a-z]\b[^{]*\{[^}]*background/, 'a token never paints a background over the added/deleted/changed row');
});

test('the README names public/highlight.js among the page files', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /`public\/highlight\.js`/);
});
