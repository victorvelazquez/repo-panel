'use strict';
// RP145 (S34): in the tree of the Changes tab a folder and a file must tell apart at a glance and the depth must read clearly. A folder has a FILLED icon in blue (not yellow: yellow is the status
// Modified), a file an OUTLINE icon in a soft grey; the indent is 16 px per level; a file row reserves the width of the chevron column, so its icon sits ONE level to the right of the icon of the folder
// that holds it. (A thin vertical guide per level was tried and removed at the request of the person: the blue folder and the step say the depth.) In a narrow column the step shrinks so the name keeps room at depth 8. Plain CSS cannot be
// run here: how it LOOKS and the measured positions were checked in the real panel; these tests pin the markup, the rules and the numbers.
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
// The rules of the stylesheet (top level) whose selector list has an item that contains `part`.
const rulesWith = (part) => [...css.matchAll(/(?:^|\n)([^\n{}@][^{}\n]*) \{([^}]*)\}/g)].filter((m) => m[1].includes(part)).map((m) => ({ sel: m[1], body: m[2] }));

const FILES = [{ path: 'docs/a.md', status: 'M', added: 1, deleted: 0 }, { path: 'a/b/c/d/e/f/g/h/x.js', status: 'M', added: 1, deleted: 0 }, { path: 'root.md', status: 'M', added: 1, deleted: 0 }];
const html = R.columnView({ name: 'demo', files: FILES });
const row = (p) => new RegExp(`<button [^>]*data-path="${p.replace(/[./]/g, '\\$&')}"[^>]*>.*?</button>`).exec(html)[0];

test('m1: a folder row has the FILLED icon and a file row the OUTLINE one, both aria-hidden and the same size', () => {
  const d = row('docs'), f = row('docs/a.md');
  assert.match(d, /<span class="cf-ic" aria-hidden="true"><svg [^>]*width="14" height="14"[^>]*aria-hidden="true"><path fill="currentColor"/);
  assert.doesNotMatch(f, /fill="currentColor"/);
  assert.match(f, /<span class="cf-ic" aria-hidden="true"><svg [^>]*width="14" height="14"[^>]*fill="none"/);
  assert.notEqual(d.match(/<svg.*<\/svg>/)[0], f.match(/<svg.*<\/svg>/)[0]);
});

test('m2: a file row reserves the chevron column (an empty, aria-hidden cf-ch before its icon); a folder row keeps its chevron', () => {
  assert.match(row('docs/a.md'), /^<button [^>]*><span class="cf-ch" aria-hidden="true"><\/span><span class="cf-ic"/);
  assert.match(row('docs'), /^<button [^>]*><span class="cf-ch" aria-hidden="true">▾<\/span><span class="cf-ic"/);
  assert.match(row('root.md'), /^<button [^>]*><span class="cf-ch" aria-hidden="true"><\/span>/, 'also at the root');
});

test('m3: the hooks, roles and attributes are as they were and the depth classes reach cf-d8', () => {
  assert.match(row('docs'), /^<button type="button" class="cf-dir cf-d0" data-act="col-folder" data-path="docs" aria-expanded="true">/);
  assert.match(row('docs/a.md'), /^<button type="button" class="cf-item cf-d1" data-act="changes-file" data-path="docs\/a\.md" aria-pressed="false" title="docs\/a\.md">/);
  assert.match(row('docs/a.md'), /<span class="cf-n"><i class="a">\+1<\/i> <i class="d">−0<\/i><\/span><span class="cf-st st-M">M<\/span><\/button>$/);
  assert.match(row('a/b/c/d/e/f/g/h/x.js'), /class="cf-item cf-d1"/, 'the single-folder chain is one row');
  const deep = R.columnView({ name: 'x', files: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((_, i, a) => ({ path: `${a.slice(0, i + 1).join('/')}/f.js`, status: 'M' })) });
  assert.match(deep, /cf-item cf-d8/);
  assert.doesNotMatch(deep, /cf-d9/);
  for (let i = 0; i <= 8; i++) assert.equal(decls(`.cf-d${i}`).length + (css.includes(`.cf-d${i} { --cf-d: ${i}; }`) ? 1 : 0) > 0, true);
});

test('c1: the folder icon is blue, the file icon is not, and the grey of the file icon is a readable graphic (3:1 on the background)', () => {
  const dir = rulesWith('.cf-dir .cf-ic').filter((r) => !r.sel.includes('.ft-'));
  const file = rulesWith('.cf-item .cf-ic').filter((r) => !r.sel.includes('.ft-'));
  assert.ok(dir.length && file.length, 'a rule each');
  assert.match(dir.map((r) => r.body).join(';'), /color:\s*var\(--blue\)/);
  assert.doesNotMatch(file.map((r) => r.body).join(';'), /var\(--blue\)|var\(--yellow\)/);
  const m = /color:\s*var\(--(muted|gray)\)/.exec(file.map((r) => r.body).join(';'));
  assert.ok(m, 'the file icon is --muted or --gray');
  assert.ok(contrast(token(m[1]), token('bg')) >= 3, `contrast ${contrast(token(m[1]), token('bg')).toFixed(2)}`);
  assert.ok(contrast(token('blue'), token('bg')) >= 3);
  assert.match(decls('.cf-dir .cf-name').join(';'), /color:\s*var\(--muted\)/, 'the folder name keeps its muted style');
});

test('c2: the indent is 16 px per level and the row padding uses it', () => {
  assert.match(decls('.cf-tree').join(';'), /--cf-step:\s*16px/);
  assert.match(decls('.cf-item, .cf-dir').join(';'), /padding:[^;]*calc\(6px \+ var\(--cf-d, 0\) \* var\(--cf-step, 16px\)\)/);
  assert.doesNotMatch(css, /var\(--cf-d, 0\) \* 14px/);
});

// The person looked at the guide lines (a thin vertical line per level) and decided they were too much: the blue folder and the 16 px step already say the depth. They are gone, and this pins it so they do not come back by accident.
test('c3: there are no indent guides: no pseudo-element on a row of the tree, and the rows do not need to be positioned for them', () => {
  assert.deepEqual(rulesWith('::before').filter((r) => r.sel.includes('.cf-')).map((r) => r.sel), [], 'no ::before rule for .cf-item or .cf-dir');
  assert.deepEqual(rulesWith('::after').filter((r) => r.sel.includes('.cf-')).map((r) => r.sel), [], 'and no ::after one either');
  assert.doesNotMatch(decls('.cf-item, .cf-dir').join(';'), /position:\s*relative/, 'the row was made relative only for the guides');
  assert.doesNotMatch(css, /repeating-linear-gradient[^;}]*--cf-step/, 'no gradient is drawn from the step');
});

test('c5: in a narrow column the step shrinks, so the name keeps at least 60 px at depth 8 in a column of 220 px', () => {
  const m = /@container col \(max-width: 300px\) \{\n\s*\.cf-tree \{ --cf-step: (\d+)px; \}/.exec(css);
  assert.ok(m, 'a narrow-column rule for the step');
  const step = Number(m[1]);
  assert.ok(step >= 6 && step < 16);
  const num = (re, body) => Number(re.exec(body)[1]);
  const pane = 220 - 16; // #col min-width less the 8 px of padding of .col-pane on each side
  const chev = num(/width:\s*(\d+)px/, decls('.cf-ch').join(';'));
  const gap = num(/gap:\s*(\d+)px/, decls('.cf-item, .cf-dir').join(';'));
  const pad = decls('.cf-item, .cf-dir').join(';').match(/padding:\s*3px (\d+)px 3px calc\((\d+)px/);
  const icon = 14, border = 2;
  const need = border + Number(pad[2]) + 8 * step + chev + gap + icon + gap + Number(pad[1]);
  assert.ok(pane - need >= 60, `${pane - need} px left for the name (needs ${need} of ${pane})`);
  // and at 16 px it would not (this is why the step shrinks)
  assert.ok(pane - (need - 8 * step + 8 * 16) < 60);
});

test('p1: the Files tree (ft-*) and the focus ring, the counts and the status letters are untouched', () => {
  assert.match(decls('.cf-item:focus-visible, .cf-dir:focus-visible').join(';'), /outline:\s*2px solid var\(--blue\)/);
  assert.match(decls('.cf-st').join(';'), /width:\s*14px/);
  assert.doesNotMatch(rulesWith('.ft-').map((r) => r.body).join(';'), /--cf-/);
  assert.equal(rulesWith('.cf-').filter((r) => /animation|transition/.test(r.body)).length, 0, 'no animation is added');
});
