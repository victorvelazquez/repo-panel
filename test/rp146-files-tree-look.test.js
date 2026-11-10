'use strict';
// RP146 (S36): the tree of the Files tab (the right column and the chat's own Files tab under 1100 px share treeHtml) gets the design of the Changes tree of RP145: a folder row is chevron, FILLED blue
// folder icon, name; a file row is an empty chevron cell (it reserves the width), OUTLINE grey icon, name, mark, so a file icon sits ONE level right of its folder's; 16 px per level (8 px in a narrow column) through
// the step variable the two trees SHARE; no guide lines. Plain CSS cannot be run here: how it LOOKS was checked in the real panel; these tests pin the markup, the rules and the numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/resumen.js');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const decls = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\#:]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
};
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(m, `--${name} is a hex colour of :root`);
  return m[1];
};
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rulesWith = (part) => [...css.matchAll(/(?:^|\n)([^\n{}@][^{}\n]*) \{([^}]*)\}/g)].filter((m) => m[1].includes(part)).map((m) => ({ sel: m[1], body: m[2] }));

const tree = (...paths) => ({ files: paths.map((p) => ({ path: p, untracked: false })) });
const T = tree('README.md', 'src/a.js', 'src/lib/b.js', 'docs/x.md');
const html = R.filesView(T, { changed: { 'src/lib/b.js': 'M' } });
const row = (h, p) => new RegExp(`<button [^>]*data-path="${p.replace(/[./]/g, '\\$&')}"[^>]*>.*?</button>`).exec(h)[0];

test('m1: a folder row is chevron, filled folder icon, name, in that order, and its icon is aria-hidden', () => {
  assert.match(row(html, 'src'), /^<button [^>]*><span class="cf-ch" aria-hidden="true">▾<\/span><span class="cf-ic" aria-hidden="true"><svg [^>]*width="14" height="14"[^>]*aria-hidden="true"><path fill="currentColor"[\s\S]*<\/svg><\/span><span class="ft-name">src<\/span><\/button>$/);
  assert.match(row(html, 'docs'), /<span class="cf-ch" aria-hidden="true">▸<\/span>/, 'a folded folder shows the closed chevron');
});

test('m2: a file row is an empty chevron cell, the OUTLINE icon, the name and then the mark; the two icons differ', () => {
  const f = row(html, 'src/lib/b.js'), d = row(html, 'src');
  assert.match(f, /^<button [^>]*><span class="cf-ch" aria-hidden="true"><\/span><span class="cf-ic" aria-hidden="true"><svg [^>]*fill="none"[\s\S]*<\/svg><\/span><span class="ft-name">b\.js<\/span><span class="ft-mark">M<\/span><\/button>$/);
  assert.doesNotMatch(f, /fill="currentColor"/);
  assert.match(row(html, 'README.md'), /^<button [^>]*><span class="cf-ch" aria-hidden="true"><\/span><span class="cf-ic"/, 'also at the root');
  assert.notEqual(d.match(/<svg.*<\/svg>/)[0], f.match(/<svg.*<\/svg>/)[0]);
});

test('m3: hooks, roles and attributes are as they were; the cap, the fold default and the escaping hold', () => {
  assert.match(html, /<div class="ft-tree" role="group" aria-label="Repository files">/);
  assert.match(row(html, 'src'), /^<button type="button" class="ft-row ft-dir ft-chg" style="--d:0" data-act="files-dir" data-path="src" data-open="true" aria-expanded="true">/);
  assert.match(row(html, 'docs'), /class="ft-row ft-dir" style="--d:0" data-act="files-dir" data-path="docs" data-open="false" aria-expanded="false"/);
  assert.match(row(html, 'src/lib/b.js'), /^<button type="button" class="ft-row ft-file ft-chg" style="--d:2" data-act="files-open" data-path="src\/lib\/b\.js" aria-pressed="false" title="src\/lib\/b\.js">/);
  assert.match(R.filesView(T, { selected: 'README.md' }), /class="ft-row ft-file ft-on" style="--d:0" data-act="files-open" data-path="README\.md" aria-pressed="true"/);
  assert.doesNotMatch(html, /data-path="docs\/x\.md"/, 'a folder without changes is folded by default');
  const many = R.filesView({ files: Array.from({ length: 1600 }, (_, i) => ({ path: `f${String(i).padStart(4, '0')}.js` })) }, {});
  assert.equal((many.match(/class="ft-row ft-file/g) || []).length, 1500);
  assert.match(many, /\+100 more/);
  const evil = R.filesView({ files: [{ path: '<img src=x onerror=alert(1)>/a"b.js' }] }, { open: { '<img src=x onerror=alert(1)>': true } });
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('c1: the folder icon of the Files tree is blue (also in a dirty folder), the file icon is grey and readable (3:1 on the background)', () => {
  const dir = rulesWith('.ft-dir .cf-ic'), file = rulesWith('.ft-file .cf-ic');
  assert.ok(dir.length && file.length, 'a rule each');
  assert.match(dir.map((r) => r.body).join(';'), /color:\s*var\(--blue\)/);
  assert.doesNotMatch(file.map((r) => r.body).join(';'), /var\(--blue\)|var\(--yellow\)/);
  const m = /color:\s*var\(--(muted|gray)\)/.exec(file.map((r) => r.body).join(';'));
  assert.ok(m, 'the file icon is --muted or --gray');
  assert.ok(contrast(token(m[1]), token('bg')) >= 3, `contrast ${contrast(token(m[1]), token('bg')).toFixed(2)}`);
});

test('c2: the two trees share the step: one rule sets it for both, the row padding uses it, and the narrow-column rule covers both', () => {
  assert.match(decls('.cf-tree, .ft-tree').join(';'), /--cf-step:\s*16px/);
  assert.match(decls('.ft-row').join(';'), /padding:[^;]*calc\(6px \+ var\(--d, 0\) \* var\(--cf-step, 16px\)\)/);
  assert.doesNotMatch(css, /var\(--d, 0\) \* 14px/);
  assert.match(css, /@container col \(max-width: 300px\) \{\n\s*\.cf-tree, \.ft-tree \{ --cf-step: 8px; \}/);
  assert.equal((css.match(/--cf-step:\s*\d+px/g) || []).length, 2, 'the numbers appear once for the wide step and once for the narrow one');
});

test('c3: no indent guides: no pseudo-element rule and no gradient for the rows of the Files tree', () => {
  assert.deepEqual(rulesWith('::before').filter((r) => r.sel.includes('.ft-')).map((r) => r.sel), []);
  assert.deepEqual(rulesWith('::after').filter((r) => r.sel.includes('.ft-')).map((r) => r.sel), []);
  assert.doesNotMatch(decls('.ft-row').join(';'), /position:\s*relative|gradient/);
});

test('c4: the name in the tree rows is the normal proportional 13 px; the footer branch name keeps its monospace look', () => {
  const n = decls('.ft-row .ft-name').join(';');
  assert.match(n, /font-family:\s*inherit/);
  assert.match(n, /font-size:\s*13px/);
  assert.match(decls('.ft-name').join(';'), /font-family:\s*ui-monospace/, 'the base .ft-name (footer branch) stays monospace');
  assert.doesNotMatch(css, /\.ft-br \.ft-name \{[^}]*font-family:\s*inherit/);
});

test('c5: Modified stays yellow with its letter, the selected row keeps its blue border and background and the focus ring stays; nothing animated', () => {
  assert.match(decls('.ft-chg').join(';'), /color:\s*var\(--yellow\)/);
  assert.match(decls('.ft-mark').join(';'), /color:\s*var\(--yellow\)/);
  assert.match(decls('.ft-on').join(';'), /border-color:\s*var\(--blue\)/);
  assert.match(decls('.ft-row:focus-visible').join(';'), /outline:\s*2px solid var\(--blue\)/);
  assert.equal(rulesWith('.ft-').filter((r) => /.ft-(row|tree|dir|file|on|chg|mark|name)/.test(r.sel) && !r.sel.includes('.ft-br') && /animation|transition/.test(r.body)).length, 0);
});

test('c6: in a narrow column the name keeps at least 60 px at depth 8 in a column of 220 px (a file with a mark)', () => {
  const m = /@container col \(max-width: 300px\) \{\n\s*\.cf-tree, \.ft-tree \{ --cf-step: (\d+)px; \}/.exec(css);
  assert.ok(m, 'a narrow-column rule for the step');
  const step = Number(m[1]);
  const num = (re, body) => Number(re.exec(body)[1]);
  const pane = 220 - 16;
  const chev = num(/width:\s*(\d+)px/, decls('.cf-ch').join(';'));
  const rowCss = decls('.ft-row').join(';');
  const gap = num(/gap:\s*(\d+)px/, rowCss);
  const pad = rowCss.match(/padding:\s*2px (\d+)px 2px calc\((\d+)px/);
  const icon = 14, border = 2, mark = 8;
  const need = border + Number(pad[2]) + 8 * step + chev + gap + icon + gap + gap + mark + Number(pad[1]);
  assert.ok(pane - need >= 60, `${pane - need} px left for the name (needs ${need} of ${pane})`);
});
